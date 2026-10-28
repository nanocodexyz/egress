import { Egress, PlanVault } from 'nanocode-egress/cloudflare'
import { RelayContainer, relay } from 'nanocode-egress/cloudflare/container'
import { App } from 'nanocode-ts/cloudflare'

type Env = App.Env & {
  PLANS: DurableObjectNamespace<PlanVault>
  RELAY: DurableObjectNamespace<RelayContainer>
  PLAN_SECRET: string
  RELAY_SECRET: string
  RELAY_URL?: string
  DEMO_TOKEN?: string
}

const plans = Egress.durable<Env>((env) => env.PLANS)

const egress = Egress.binding<Env>({
  plans,
  relay: (env) =>
    env.RELAY_URL
      ? Egress.relay({ url: env.RELAY_URL, secret: env.RELAY_SECRET })
      : relay(env.RELAY, { secret: env.RELAY_SECRET }),
})

function account(request: Request, env: Env): string | null {
  if (!env.DEMO_TOKEN || env.DEMO_TOKEN.length < 32) return null
  const presented = new TextEncoder().encode(request.headers.get('authorization') ?? '')
  const expected = new TextEncoder().encode(`Bearer ${env.DEMO_TOKEN}`)
  if (presented.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(presented, expected)) return null
  return request.headers.get('x-demo-account') ?? 'demo'
}

const routes = Egress.routes<Env>({ plans, account })

const nanocode = App.create<Env>({ authenticate: account, egress, subscription: Egress.subscription({ plans }) })

export const { AgentSession } = nanocode
export { PlanVault, RelayContainer }

export default {
  async fetch(request, env) {
    const routed = await routes(request, env)
    if (routed) return routed
    const url = new URL(request.url)
    if (url.pathname.startsWith('/sessions/')) return nanocode.fetch(request, env)
    if (url.pathname !== '/probe' && url.pathname !== '/probe-socket') return new Response('not found', { status: 404 })
    const name = account(request, env)
    if (!name || request.method !== 'POST') return new Response('unauthorized', { status: 401 })
    if (url.pathname === '/probe') {
      const body = (await request.json()) as {
        provider: 'claude' | 'codex'
        endpoint: string
        headers?: [string, string][]
        payload: unknown
      }
      return egress(env).fetch(
        new Request('https://egress.internal/model', {
          method: 'POST',
          headers: {
            'x-nanocode-model': JSON.stringify({
              provider: body.provider,
              authority: { account_id: name },
              endpoint: body.endpoint,
              headers:
                body.headers ??
                (body.provider === 'claude'
                  ? [['anthropic-version', '2023-06-01'], ['content-type', 'application/json']]
                  : [['content-type', 'application/json']]),
              subscription: true,
            }),
          },
          body: JSON.stringify(body.payload),
        }),
      )
    }
    const body = (await request.json()) as { headers: [string, string][]; message: unknown }
    const opened = await egress(env).fetch(
      new Request('https://egress.internal/socket', {
        headers: {
          upgrade: 'websocket',
          'x-nanocode-socket': JSON.stringify({ provider: 'codex', authority: { account_id: name }, headers: body.headers }),
        },
      }),
    )
    const socket = opened.webSocket
    if (opened.status !== 101 || !socket) return Response.json({ status: opened.status, body: (await opened.text()).slice(0, 300) })
    socket.accept()
    const events: string[] = []
    let text = ''
    let error: unknown
    const finished = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 60_000)
      socket.addEventListener('message', (event) => {
        const parsed = JSON.parse(String(event.data)) as { type: string; delta?: string; error?: unknown }
        events.push(parsed.type)
        if (parsed.type === 'error') error = parsed.error ?? parsed
        if (parsed.type === 'response.output_text.delta') text += parsed.delta ?? ''
        if (parsed.type === 'response.completed' || parsed.type === 'response.failed' || parsed.type === 'error') {
          clearTimeout(timer)
          resolve()
        }
      })
      socket.addEventListener('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    socket.send(JSON.stringify(body.message))
    await finished
    socket.close()
    return Response.json({ status: 101, text, events: [...new Set(events)], error })
  },
} satisfies ExportedHandler<Env>
