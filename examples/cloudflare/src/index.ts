import { Egress, PlanVault } from 'nanocode-egress/cloudflare'

type Env = { PLANS: DurableObjectNamespace<PlanVault>; PLAN_SECRET: string; RELAY_URL?: string; RELAY_SECRET?: string }

const plans = Egress.durable<Env>((env) => env.PLANS)

const egress = Egress.binding<Env>({
  plans,
  relay: (env) => (env.RELAY_URL && env.RELAY_SECRET ? Egress.relay({ url: env.RELAY_URL, secret: env.RELAY_SECRET }) : undefined),
})

const routes = Egress.routes<Env>({
  plans,
  account: (request) => request.headers.get('x-demo-account'),
})

export { PlanVault }

export default {
  async fetch(request, env) {
    const routed = await routes(request, env)
    if (routed) return routed
    const url = new URL(request.url)
    if (url.pathname === '/probe' && request.method === 'POST') {
      const body = (await request.json()) as {
        account: string
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
              authority: { account_id: body.account },
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
    if (url.pathname === '/probe-socket' && request.method === 'POST') {
      const body = (await request.json()) as { account: string; headers: [string, string][]; message: unknown }
      const opened = await egress(env).fetch(
        new Request('https://egress.internal/socket', {
          headers: {
            upgrade: 'websocket',
            'x-nanocode-socket': JSON.stringify({ provider: 'codex', authority: { account_id: body.account }, headers: body.headers }),
          },
        }),
      )
      const socket = opened.webSocket
      if (opened.status !== 101 || !socket)
        return Response.json({ status: opened.status, body: (await opened.text()).slice(0, 300) })
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
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
