import * as crypto from 'node:crypto'
import { Egress, Redis } from 'nanocode-egress/vercel'

const plans = Egress.plans({ store: Redis.store() })
const subscription = Egress.subscription(plans)

function account(request: Request): string | null {
  const token = process.env.DEMO_TOKEN
  if (!token || token.length < 32) return null
  const presented = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  if (presented.byteLength !== expected.byteLength || !crypto.timingSafeEqual(presented, expected)) return null
  return request.headers.get('x-demo-account') ?? 'demo'
}

const routes = Egress.routes({ plans, account })

async function handle(request: Request): Promise<Response> {
  const routed = await routes(request)
  if (routed) return routed
  const url = new URL(request.url)
  if (url.pathname !== '/probe' && url.pathname !== '/probe-socket') return new Response('not found', { status: 404 })
  const name = account(request)
  if (!name || request.method !== 'POST') return new Response('unauthorized', { status: 401 })

  if (url.pathname === '/probe') {
    const body = (await request.json()) as { provider: 'claude' | 'codex'; endpoint: string; headers: [string, string][]; payload: unknown }
    const plan = await subscription({ account: name, provider: body.provider })
    if (!plan) return Response.json({ error: `${body.provider} is not signed in` }, { status: 401 })
    return plan.dispatch(
      { endpoint: body.endpoint, method: 'POST', headers: body.headers, body: new TextEncoder().encode(JSON.stringify(body.payload)) },
      request.signal,
    )
  }

  const body = (await request.json()) as { headers: [string, string][]; message: unknown }
  const plan = await subscription({ account: name, provider: 'codex' })
  if (!plan?.socket) return Response.json({ error: 'codex is not signed in' }, { status: 401 })
  const opened = await plan.socket.open({ provider: 'codex', headers: body.headers }, request.signal)
  const socket = opened.socket
  if (opened.status !== 101 || !socket) return Response.json({ status: opened.status, body: (await opened.text()).slice(0, 300) })
  const events: string[] = []
  let text = ''
  let error: unknown
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 60_000)
    socket.addEventListener('message', (event: { data: unknown }) => {
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
    socket.send(JSON.stringify(body.message))
  })
  socket.close()
  return Response.json({ status: 101, text, events: [...new Set(events)], error })
}

export const GET = handle
export const POST = handle
export const DELETE = handle
