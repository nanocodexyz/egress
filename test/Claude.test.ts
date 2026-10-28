import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Claude from '../src/Claude.ts'
import * as Store from '../src/Store.ts'
import { server } from './fixtures.ts'

function anthropic(options: { account?: string; expiresIn?: number } = {}) {
  let issued = 0
  const fake = server({
    'POST https://platform.claude.com/v1/oauth/token': ({ body }) => {
      issued++
      const parsed = JSON.parse(body) as { grant_type: string }
      return Response.json({
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        expires_in: options.expiresIn ?? 3600,
        scope: 'user:profile user:inference user:sessions:claude_code',
        token_type: 'Bearer',
        account: { uuid: parsed.grant_type === 'refresh_token' ? (options.account ?? 'account-1') : 'account-1' },
        organization: { uuid: 'org-1' },
      })
    },
    'GET https://api.anthropic.com/api/oauth/profile': ({ headers }) =>
      headers.get('authorization')?.startsWith('Bearer access-')
        ? Response.json({ account: { uuid: 'account-1' }, organization: { uuid: 'org-1' } })
        : new Response('no', { status: 401 }),
    'POST https://platform.claude.com/v1/oauth/token/revoke': () => new Response(null, { status: 200 }),
  })
  return { ...fake, issued: () => issued }
}

async function signIn(store: Store.Store, fake: ReturnType<typeof anthropic>) {
  const plan = Claude.create(store, { key: 'plan', fetch: fake.fetch })
  const login = await plan.start()
  const url = new URL(login.authorization_url)
  const state = url.searchParams.get('state')!
  return { plan, url, status: await plan.complete(` code-1#${state} `) }
}

test('a sign-in opens claude.com with PKCE and finishes with the pasted code', async () => {
  const fake = anthropic()
  const { plan, url, status } = await signIn(Store.memory(), fake)

  assert.equal(url.origin + url.pathname, 'https://claude.com/cai/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.match(url.searchParams.get('scope')!, /user:inference/)
  assert.equal(status.state, 'authenticated')
  if (status.state === 'authenticated') assert.deepEqual([status.account_id, status.organization_id], ['account-1', 'org-1'])

  const exchange = JSON.parse(fake.requests.find((request) => request.url.endsWith('/oauth/token'))!.body)
  assert.equal(exchange.grant_type, 'authorization_code')
  assert.equal(exchange.code, 'code-1')
  assert.equal(exchange.state, url.searchParams.get('state'))
  assert.equal(
    url.searchParams.get('code_challenge'),
    Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.code_verifier))).toString('base64url'),
  )
  assert.deepEqual((await plan.authorization()).headers, {
    authorization: 'Bearer access-1',
    'anthropic-beta': Claude.oauthBeta,
  })
})

test('a code for another sign-in is refused', async () => {
  const plan = Claude.create(Store.memory(), { key: 'plan', fetch: anthropic().fetch })
  await plan.start()
  await assert.rejects(plan.complete('code-1#wrong-state'), Claude.InvalidError)
  await assert.rejects(plan.complete('code-without-state'), /including the part after #/)
})

test('a rejected token refreshes on the next request, keeping the account', async () => {
  const fake = anthropic()
  const { plan } = await signIn(Store.memory(), fake)

  await plan.reject('Bearer access-1')
  assert.equal((await plan.authorization()).headers.authorization, 'Bearer access-2')
  const refresh = JSON.parse(fake.requests.filter((request) => request.url.endsWith('/oauth/token'))[1]!.body)
  assert.equal(refresh.grant_type, 'refresh_token')
  assert.equal(refresh.refresh_token, 'refresh-1')
  assert.doesNotMatch(refresh.scope, /org:create_api_key/)

  await plan.reject('Bearer access-1')
  assert.equal((await plan.authorization()).headers.authorization, 'Bearer access-2')
})

test('a refresh that returns another account is refused', async () => {
  const fake = anthropic({ account: 'account-2' })
  const { plan } = await signIn(Store.memory(), fake)

  await plan.reject('Bearer access-1')
  await assert.rejects(plan.authorization(), Claude.InvalidError)
})

test('sign-out revokes the refresh token', async () => {
  const fake = anthropic()
  const { plan } = await signIn(Store.memory(), fake)

  await plan.signOut()
  assert.equal((await plan.status()).state, 'signed_out')
  const revoke = fake.requests.find((request) => request.url.endsWith('/revoke'))!
  assert.equal(JSON.parse(revoke.body).token, 'refresh-1')
})
