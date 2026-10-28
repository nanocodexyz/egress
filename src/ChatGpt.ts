/**
 * Sign-in with a ChatGPT plan through OpenAI's device authorization, and the credential that Codex requests carry.
 * A port of the nanocode SDK's `ChatGptSubscription`: the same endpoints, client, stored JSON and refresh rules.
 *
 * @module
 */
import * as Http from './internal/Http.ts'
import type * as Store from './Store.ts'

/** OAuth issuer of ChatGPT sign-ins. */
export const issuer = 'https://auth.openai.com'

/** OAuth client of the Codex CLI, which ChatGPT device sign-ins use. */
export const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'

const loginTtlMs = 15 * 60_000

const refreshEarlyMs = 5 * 60_000

const retries = 4

/** Sign-in state of one ChatGPT plan. */
export type Status =
  | { state: 'signed_out' }
  | { state: 'expired' }
  | { state: 'pending'; verification_url: string; user_code: string; expires_at: number; poll_after_ms: number }
  | { state: 'authenticated'; account_id: string; expires_at: number | null }

/** Access credential of a signed-in plan. It never includes the refresh token. */
export type Credential = {
  access_token: string
  account_id: string
  fedramp: boolean
  /** Generation of the credential, which a rejected request names to `recover`. */
  generation: number
}

/** ChatGPT plan of one store key. */
export type Subscription = {
  /** Starts a device sign-in and returns its pending status with the code to enter. */
  start(): Promise<Status>
  /** Returns the status, and polls a pending sign-in when its interval elapsed. */
  status(): Promise<Status>
  /** Returns the current credential, refreshing it first when it expires within five minutes. */
  credential(): Promise<Credential>
  /** Refreshes the credential of `generation` after a provider rejected it, and returns the current one. */
  recover(generation: number): Promise<Credential>
  /** Forgets the sign-in. */
  signOut(): Promise<void>
}

/** Error of a plan that has no credential. */
export class NotAuthenticatedError extends Error {
  override name = 'ChatGpt.NotAuthenticatedError'
}

/** Error of a credential that only a new sign-in can replace. */
export class LoginRequiredError extends Error {
  override name = 'ChatGpt.LoginRequiredError'
}

/** Error of state that other writers kept changing. */
export class ContendedError extends Error {
  override name = 'ChatGpt.ContendedError'
}

/** Error of a provider or host failure. */
export class HostError extends Error {
  override name = 'ChatGpt.HostError'
}

/** Error of stored state or a provider answer that is not valid. */
export class InvalidError extends Error {
  override name = 'ChatGpt.InvalidError'
}

type StoredCredential = {
  access_token: string
  refresh_token: string
  account_id: string
  fedramp: boolean
  generation: number
  expires_at?: number | null
}

type PendingLogin = {
  device_auth_id: string
  user_code: string
  verification_url: string
  interval_ms: number
  next_poll_at: number
  expires_at: number
}

type State = { credential?: StoredCredential; pending?: PendingLogin }

const refreshing = Http.singleFlight<void>()

/** Returns the ChatGPT plan stored under `options.key`. */
export function create(store: Store.Store, options: create.Options): Subscription {
  const key = options.key
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  const origin = options.issuer ?? issuer
  if (!key.trim()) throw new InvalidError('subscription key is empty')
  if (origin !== issuer && !origin.startsWith('http://127.0.0.1:'))
    throw new InvalidError('issuer must be auth.openai.com')

  const load = async (): Promise<{ revision: number; state: State }> => {
    const record = await store.load(key)
    if (record.payload === undefined) return { revision: record.revision, state: {} }
    try {
      return { revision: record.revision, state: JSON.parse(record.payload) as State }
    } catch (error) {
      throw new InvalidError(`the store returned malformed state: ${String(error)}`)
    }
  }

  const commit = (revision: number, state: State) =>
    store.compareAndSwap(key, { revision, payload: JSON.stringify(state) })

  const post = async (url: string, contentType: string, body: string) =>
    Http.send(fetcher, {
      url,
      method: 'POST',
      headers: { 'content-type': contentType, accept: 'application/json' },
      body,
      timeoutMs: 30_000,
    }).catch((error: unknown) => {
      throw new HostError(String(error instanceof Error ? error.message : error))
    })

  const statusWithoutPoll = async (): Promise<Status> => {
    const loaded = await load()
    if (loaded.state.credential) return authenticated(loaded.state.credential)
    const pending = loaded.state.pending
    if (!pending) return { state: 'signed_out' }
    return pending.expires_at <= Http.now() ? { state: 'expired' } : pendingStatus(pending, Http.now())
  }

  const exchange = async (code: string, verifier: string): Promise<StoredCredential> => {
    const response = await post(
      `${origin}/oauth/token`,
      'application/x-www-form-urlencoded',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${origin}/deviceauth/callback`,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    )
    ensure(response, 'token exchange')
    return fromTokens(decode(response.body), undefined, 0)
  }

  const refreshGeneration = async (rejected: number): Promise<void> => {
    const loaded = await load()
    const current = loaded.state.credential
    if (!current) throw new NotAuthenticatedError('ChatGPT subscription is not authenticated')
    if (current.generation !== rejected) return
    if (!current.refresh_token.trim())
      throw new LoginRequiredError('the stored credential has no refresh token')

    const response = await post(
      `${origin}/oauth/token`,
      'application/json',
      JSON.stringify({ client_id: clientId, grant_type: 'refresh_token', refresh_token: current.refresh_token }),
    )
    if (response.status < 200 || response.status >= 300) {
      const reloaded = await load()
      if (reloaded.state.credential && reloaded.state.credential.generation !== rejected) return
      const code = refreshError(response.body) ?? `token endpoint returned HTTP ${response.status}`
      if (
        response.status === 401 ||
        ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code)
      )
        throw new LoginRequiredError(code)
      throw new HostError(code)
    }

    const next = fromTokens(decode(response.body), current, current.generation + 1)
    if (next.account_id !== current.account_id)
      throw new InvalidError('the refreshed credential changed accounts')
    if ((await commit(loaded.revision, { credential: next })) !== undefined) return

    const reloaded = (await load()).state.credential
    if (reloaded && reloaded.account_id === current.account_id && reloaded.generation !== rejected) return
    throw new ContendedError('ChatGPT subscription state remained contended')
  }

  const refreshIfCurrent = (generation: number) =>
    refreshing(`${key}:${generation}`, () => refreshGeneration(generation))

  const credential = async (): Promise<Credential> => {
    const stored = (await load()).state.credential
    if (!stored) throw new NotAuthenticatedError('ChatGPT subscription is not authenticated')
    validate(stored)
    if (typeof stored.expires_at === 'number' && stored.expires_at <= Http.now() + refreshEarlyMs) {
      await refreshIfCurrent(stored.generation).catch(() => undefined)
      const refreshed = (await load()).state.credential
      if (!refreshed) throw new NotAuthenticatedError('ChatGPT subscription is not authenticated')
      return snapshot(refreshed)
    }
    return snapshot(stored)
  }

  return {
    async start() {
      const response = await post(
        `${origin}/api/accounts/deviceauth/usercode`,
        'application/json',
        JSON.stringify({ client_id: clientId }),
      )
      ensure(response, 'login start')
      const body = decode(response.body) as {
        device_auth_id?: string
        user_code?: string
        usercode?: string
        interval?: unknown
      }
      const deviceAuthId = required(body.device_auth_id, 'device authorization ID')
      const userCode = required(body.user_code ?? body.usercode, 'device user code')
      const intervalMs = interval(body.interval) * 1000
      const now = Http.now()
      const pending: PendingLogin = {
        device_auth_id: deviceAuthId,
        user_code: userCode,
        verification_url: `${origin}/codex/device`,
        interval_ms: intervalMs,
        next_poll_at: now + intervalMs,
        expires_at: now + loginTtlMs,
      }
      for (let attempt = 0; attempt < retries; attempt++) {
        const loaded = await load()
        if ((await commit(loaded.revision, { pending })) !== undefined) return pendingStatus(pending, now)
      }
      throw new ContendedError('ChatGPT subscription state remained contended')
    },
    async status() {
      const loaded = await load()
      if (loaded.state.credential) return authenticated(loaded.state.credential)
      const pending = loaded.state.pending
      if (!pending) return { state: 'signed_out' }

      const now = Http.now()
      if (pending.expires_at <= now) {
        await commit(loaded.revision, {})
        return { state: 'expired' }
      }
      if (pending.next_poll_at > now) return pendingStatus(pending, now)

      const claimed = { ...pending, next_poll_at: now + pending.interval_ms }
      const claimedRevision = await commit(loaded.revision, { pending: claimed })
      if (claimedRevision === undefined) return statusWithoutPoll()

      const response = await post(
        `${origin}/api/accounts/deviceauth/token`,
        'application/json',
        JSON.stringify({ device_auth_id: pending.device_auth_id, user_code: pending.user_code }),
      )
      if (response.status === 403 || response.status === 404) return pendingStatus(claimed, now)
      ensure(response, 'device authorization')
      const body = decode(response.body) as { authorization_code?: string; code_verifier?: string }
      const stored = await exchange(
        required(body.authorization_code, 'authorization code'),
        required(body.code_verifier, 'PKCE verifier'),
      )
      if ((await commit(claimedRevision, { credential: stored })) !== undefined) return authenticated(stored)
      return statusWithoutPoll()
    },
    credential,
    async recover(generation) {
      await refreshIfCurrent(generation)
      return credential()
    },
    async signOut() {
      for (let attempt = 0; attempt < retries; attempt++) {
        const loaded = await load()
        if ((await commit(loaded.revision, {})) !== undefined) return
      }
      throw new ContendedError('ChatGPT subscription state remained contended')
    },
  }
}

export declare namespace create {
  type Options = {
    /** Store key of this plan. */
    key: string
    /** `fetch` of the OAuth requests. Defaults to the global `fetch`. */
    fetch?: Http.Fetch | undefined
    /** OAuth issuer. Defaults to `issuer`; only a loopback issuer may replace it, for tests. */
    issuer?: string | undefined
  }
}

function fromTokens(
  tokens: { access_token?: string; refresh_token?: string; id_token?: string },
  previous: StoredCredential | undefined,
  generation: number,
): StoredCredential {
  const accessToken = required(tokens.access_token, 'access token')
  const refreshToken = tokens.refresh_token?.trim() ? tokens.refresh_token : (previous?.refresh_token ?? '')
  const auth = tokens.id_token
    ? ((claimsOf(tokens.id_token)['https://api.openai.com/auth'] ?? {}) as {
        chatgpt_account_id?: string
        chatgpt_account_is_fedramp?: boolean
      })
    : undefined
  const accountId = auth?.chatgpt_account_id ?? previous?.account_id
  if (!accountId) throw new InvalidError('token response omitted the ChatGPT account ID')

  const credential: StoredCredential = {
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    fedramp: auth?.chatgpt_account_is_fedramp ?? previous?.fedramp ?? false,
    generation,
    expires_at: expiration(accessToken),
  }
  validate(credential)
  return credential
}

function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return Http.claims(jwt)
  } catch (error) {
    throw new InvalidError(`invalid JWT: ${String(error)}`)
  }
}

function expiration(jwt: string): number | null {
  try {
    const exp = Http.claims(jwt).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

function validate(credential: StoredCredential): void {
  if (!credential.access_token.trim() || !credential.account_id.trim())
    throw new InvalidError('required credential field is empty')
}

function snapshot(credential: StoredCredential): Credential {
  return {
    access_token: credential.access_token,
    account_id: credential.account_id,
    fedramp: credential.fedramp,
    generation: credential.generation,
  }
}

function pendingStatus(pending: PendingLogin, now: number): Status {
  return {
    state: 'pending',
    verification_url: pending.verification_url,
    user_code: pending.user_code,
    expires_at: pending.expires_at,
    poll_after_ms: Math.max(250, pending.next_poll_at - now),
  }
}

function authenticated(credential: StoredCredential): Status {
  return { state: 'authenticated', account_id: credential.account_id, expires_at: credential.expires_at ?? null }
}

function interval(value: unknown): number {
  const seconds = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 30) : 5
}

function ensure(response: { status: number }, operation: string): void {
  if (response.status < 200 || response.status >= 300)
    throw new HostError(`ChatGPT ${operation} failed with HTTP ${response.status}`)
}

function decode(body: string): Record<string, never> {
  try {
    return JSON.parse(body) as Record<string, never>
  } catch (error) {
    throw new InvalidError(`the OAuth endpoint returned invalid JSON: ${String(error)}`)
  }
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new InvalidError(`the OAuth response omitted the ${field}`)
  return value
}

function refreshError(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { error?: unknown }
    if (typeof value.error === 'string') return value.error
    const nested = value.error as { code?: unknown } | undefined
    return typeof nested?.code === 'string' ? nested.code : undefined
  } catch {
    return undefined
  }
}
