import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as ChatGpt from '../src/ChatGpt.ts'
import * as Store from '../src/Store.ts'
import { jwt, server } from './fixtures.ts'

const issuer = 'http://127.0.0.1:9'

function openai(options: { approveAfter?: number; expiresIn?: number } = {}) {
  let polls = 0
  let refreshes = 0
  const access = (generation: number) =>
    jwt({ exp: Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600), generation })
  const idToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_account_is_fedramp: false } })
  const fake = server({
    [`POST ${issuer}/api/accounts/deviceauth/usercode`]: () =>
      Response.json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: '1' }),
    [`POST ${issuer}/api/accounts/deviceauth/token`]: () =>
      ++polls < (options.approveAfter ?? 1)
        ? new Response('pending', { status: 403 })
        : Response.json({ authorization_code: 'code-1', code_verifier: 'verifier-1' }),
    [`POST ${issuer}/oauth/token`]: async ({ body }) => {
      if (body.includes('refresh_token')) {
        refreshes++
        return Response.json({ access_token: access(refreshes), refresh_token: `refresh-${refreshes + 1}` })
      }
      return Response.json({ access_token: access(0), refresh_token: 'refresh-1', id_token: idToken })
    },
  })
  return { ...fake, polls: () => polls, refreshes: () => refreshes }
}

async function signedIn(store: Store.Store, fake: ReturnType<typeof openai>) {
  const plan = ChatGpt.create(store, { key: 'plan', fetch: fake.fetch, issuer })
  const started = await plan.start()
  assert.equal(started.state, 'pending')
  const now = Date.now
  Date.now = () => now() + 2_000
  try {
    let status = await plan.status()
    for (let attempt = 0; status.state === 'pending' && attempt < 5; attempt++) {
      const at = Date.now
      Date.now = () => at() + 2_000
      status = await plan.status()
    }
    return { plan, status }
  } finally {
    Date.now = now
  }
}

test('a device sign-in shows the code, polls after its interval and stores the credential', async () => {
  const fake = openai({ approveAfter: 2 })
  const store = Store.memory()
  const plan = ChatGpt.create(store, { key: 'plan', fetch: fake.fetch, issuer })

  const started = await plan.start()
  assert.equal(started.state, 'pending')
  if (started.state !== 'pending') return
  assert.equal(started.user_code, 'ABCD-EFGH')
  assert.equal(started.verification_url, `${issuer}/codex/device`)
  assert.equal((await plan.status()).state, 'pending')
  assert.equal(fake.polls(), 0)

  const { status } = await signedIn(store, fake)
  assert.equal(status.state, 'authenticated')
  if (status.state === 'authenticated') assert.equal(status.account_id, 'acct-1')

  const credential = await ChatGpt.create(store, { key: 'plan', fetch: fake.fetch, issuer }).credential()
  assert.equal(credential.account_id, 'acct-1')
  assert.equal(credential.generation, 0)
  assert.ok(!('refresh_token' in credential))
  const exchange = fake.requests.find((request) => request.body.includes('authorization_code'))!
  assert.match(exchange.body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/)
  assert.match(exchange.body, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A9%2Fdeviceauth%2Fcallback/)
})

test('a rejected credential refreshes once for concurrent callers, and a stale rejection does not refresh again', async () => {
  const fake = openai()
  const store = Store.memory()
  const { plan } = await signedIn(store, fake)

  const recovered = await Promise.all([plan.recover(0), plan.recover(0), plan.recover(0)])
  assert.equal(fake.refreshes(), 1)
  assert.deepEqual(new Set(recovered.map((credential) => credential.generation)), new Set([1]))

  await plan.recover(0)
  assert.equal(fake.refreshes(), 1)
})

test('a credential that expires within five minutes refreshes before use', async () => {
  const fake = openai({ expiresIn: 60 })
  const store = Store.memory()
  const { plan } = await signedIn(store, fake)

  assert.equal((await plan.credential()).generation, 1)
  assert.equal(fake.refreshes(), 1)
})

test('sign-out forgets the credential', async () => {
  const fake = openai()
  const store = Store.memory()
  const { plan } = await signedIn(store, fake)

  await plan.signOut()
  assert.equal((await plan.status()).state, 'signed_out')
  await assert.rejects(plan.credential(), ChatGpt.NotAuthenticatedError)
})

test('only auth.openai.com or a loopback issuer may sign in', () => {
  assert.throws(() => ChatGpt.create(Store.memory(), { key: 'k', issuer: 'https://evil.example' }), ChatGpt.InvalidError)
})
