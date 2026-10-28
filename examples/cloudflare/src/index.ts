import { Egress, PlanVault } from 'nanocode-egress/cloudflare'

type Env = { PLANS: DurableObjectNamespace<PlanVault>; PLAN_SECRET: string }

const plans = Egress.durable<Env>((env) => env.PLANS)

const egress = Egress.binding<Env>({ plans })

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
      const body = (await request.json()) as { account: string; provider: 'claude' | 'codex'; endpoint: string; payload: unknown }
      return egress(env).fetch(
        new Request('https://egress.internal/model', {
          method: 'POST',
          headers: {
            'x-nanocode-model': JSON.stringify({
              provider: body.provider,
              authority: { account_id: body.account },
              endpoint: body.endpoint,
              headers: body.provider === 'claude' ? [['anthropic-version', '2023-06-01'], ['content-type', 'application/json']] : [['content-type', 'application/json']],
              subscription: true,
            }),
          },
          body: JSON.stringify(body.payload),
        }),
      )
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
