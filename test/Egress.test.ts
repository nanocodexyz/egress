import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Cloudflare from '../src/cloudflare/Egress.ts'
import * as Egress from '../src/Egress.ts'
import type * as Plans from '../src/Plans.ts'
import * as Routes from '../src/Routes.ts'
import { server } from './fixtures.ts'

function account(): Plans.Account & { rejections: string[]; generation: number } {
  const state = { generation: 1, rejections: [] as string[] }
  return {
    ...state,
    get generation() {
      return state.generation
    },
    get rejections() {
      return state.rejections
    },
    async status() {
      return { claude: { state: 'signed_out' }, codex: { state: 'authenticated', account_id: 'acct', expires_at: null } }
    },
    async signedIn(provider) {
      return provider === 'codex'
    },
    async signIn(options) {
      return options.provider === 'codex'
        ? { provider: 'codex', status: { state: 'signed_out' } }
        : { provider: 'claude', authorization_url: 'https://claude.com/x', expires_at: 1 }
    },
    async complete() {
      return { state: 'signed_out' }
    },
    async signOut() {},
    async inject(provider) {
      return provider === 'claude'
        ? { headers: { authorization: `Bearer claude-${state.generation}`, 'anthropic-beta': 'oauth-2025-04-20' }, generation: `Bearer claude-${state.generation}` }
        : { headers: { authorization: `Bearer codex-${state.generation}`, 'chatgpt-account-id': 'acct' }, generation: String(state.generation) }
    },
    async rejected(_provider, options) {
      state.rejections.push(options.generation)
      state.generation++
    },
  }
}

test('only the plan endpoints are destinations', () => {
  assert.equal(Egress.destination('claude', 'https://api.anthropic.com/v1/messages?beta=true').hostname, 'api.anthropic.com')
  assert.equal(Egress.destination('codex', 'https://chatgpt.com/backend-api/codex/responses').hostname, 'chatgpt.com')
  for (const [provider, endpoint] of [
    ['claude', 'https://api.anthropic.com/v1/messages'],
    ['claude', 'https://api.anthropic.com/v1/files?beta=true'],
    ['claude', 'https://evil.example/v1/messages?beta=true'],
    ['codex', 'https://chatgpt.com/backend-api/conversation'],
    ['codex', 'https://api.anthropic.com/v1/messages?beta=true'],
  ] as const)
    assert.throws(() => Egress.destination(provider, endpoint), Egress.DestinationError)
})

test('credentials, cookies and hop-by-hop headers are replaced, and betas merge', () => {
  const headers = Egress.headers(
    [
      ['authorization', 'Bearer agent-chose-this'],
      ['x-api-key', 'sk-agent'],
      ['cookie', 'a=b'],
      ['anthropic-beta', 'interleaved-thinking-2025-05-14'],
      ['anthropic-version', '2023-06-01'],
    ],
    { headers: { authorization: 'Bearer plan', 'anthropic-beta': 'oauth-2025-04-20' }, generation: 'g' },
  )
  assert.equal(headers.get('authorization'), 'Bearer plan')
  assert.equal(headers.get('x-api-key'), null)
  assert.equal(headers.get('cookie'), null)
  assert.equal(headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14,oauth-2025-04-20')
  assert.equal(headers.get('anthropic-version'), '2023-06-01')
})

test('a 401 refreshes the credential and retries the request once', async () => {
  const plans = account()
  let calls = 0
  const fake = server({
    'POST https://api.anthropic.com/v1/messages': ({ headers }) =>
      ++calls === 1 ? new Response('expired', { status: 401 }) : Response.json({ ok: headers.get('authorization') }),
  })

  const response = await Egress.send(
    plans,
    { provider: 'claude', endpoint: 'https://api.anthropic.com/v1/messages?beta=true', headers: [], body: new Uint8Array([1]) },
    { fetch: fake.fetch },
  )
  assert.deepEqual(await response.json(), { ok: 'Bearer claude-2' })
  assert.deepEqual(plans.rejections, ['Bearer claude-1'])
  assert.equal(calls, 2)
})

test('the Cloudflare binding sends plan dispatches with the account credential and the rest to the fallback', async () => {
  const plans = account()
  const seen: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`)
    return Response.json({ upstream: true })
  }) as typeof fetch
  try {
    const egress = Cloudflare.binding<object>({
      plans: (_env, name) => {
        assert.equal(name, 'visitor-1')
        return plans
      },
      fallback: () => ({ fetch: async () => Response.json({ fallback: true }) }),
    })({})
    const dispatch = (subscription: boolean) =>
      new Request('https://egress.internal/model', {
        method: 'POST',
        headers: {
          'x-nanocode-model': JSON.stringify({
            provider: 'codex',
            authority: { account_id: 'visitor-1' },
            endpoint: 'https://chatgpt.com/backend-api/codex/responses',
            headers: [['authorization', 'Bearer ']],
            subscription,
          }),
        },
        body: '{}',
      })

    assert.deepEqual(await (await egress.fetch(dispatch(true))).json(), { upstream: true })
    assert.deepEqual(seen, ['https://chatgpt.com/backend-api/codex/responses Bearer codex-1'])
    assert.deepEqual(await (await egress.fetch(dispatch(false))).json(), { fallback: true })
    assert.equal(await Cloudflare.subscription({ plans: () => plans })('visitor-1', {}, 'codex'), true)
    assert.equal(await Cloudflare.subscription({ plans: () => plans })('visitor-1', {}, 'claude'), false)
  } finally {
    globalThis.fetch = original
  }
})

test('the sign-in routes serve the signed-in account and refuse anonymous requests', async () => {
  const plans = account()
  const handle = (request: Request) =>
    Routes.handle(request, { account: (signed) => (signed.headers.get('x-user') ? plans : undefined) })

  assert.equal(await handle(new Request('https://app.example/other')), undefined)
  assert.equal((await handle(new Request('https://app.example/plans')))!.status, 401)
  const status = await handle(new Request('https://app.example/plans', { headers: { 'x-user': 'a' } }))
  assert.equal(((await status!.json()) as { codex: { state: string } }).codex.state, 'authenticated')
  const started = await handle(new Request('https://app.example/plans/claude/sign-in', { method: 'POST', headers: { 'x-user': 'a' } }))
  assert.equal(((await started!.json()) as { authorization_url: string }).authorization_url, 'https://claude.com/x')
  assert.equal((await handle(new Request('https://app.example/plans/codex', { method: 'DELETE', headers: { 'x-user': 'a' } })))!.status, 200)
  assert.equal((await handle(new Request('https://app.example/plans/claude/complete', { method: 'POST', headers: { 'x-user': 'a' } })))!.status, 400)
})
