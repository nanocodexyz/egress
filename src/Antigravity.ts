/**
 * Sign-in with an Antigravity plan through Google's OAuth authorization with PKCE, and the headers that Antigravity requests carry.
 * A port of the nanocode SDK's Antigravity `SubscriptionLogin` and `SubscriptionAuth`: the same endpoints, client, scopes,
 * project discovery and refresh rules.
 *
 * @module
 */
import * as Http from './internal/Http.ts'
import type * as Store from './Store.ts'

export const authorizeUrl = 'https://accounts.google.com/o/oauth2/auth'

export const tokenUrl = 'https://oauth2.googleapis.com/token'

export const revokeUrl = 'https://oauth2.googleapis.com/revoke'

export const baseUrl = 'https://daily-cloudcode-pa.googleapis.com'

export const redirectUri = 'https://antigravity.google/oauth-callback'

export const scopes = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
  'openid',
]

export const userAgent =
  'antigravity/cli/1.5.13 (aidev_client; os_type=linux; arch=amd64; cl=1025641825; auth_method=consumer)'

const tokenUserAgent = 'Go-http-client/1.1'

const loginTtlMs = 15 * 60_000

const refreshMarginMs = 60_000

const requestTimeoutMs = 30_000

const onboardIntervalMs = 1_000

const retries = 8

export type Status =
  | { state: 'signed_out' | 'expired' | 'exchange_uncertain' | 'unavailable' }
  | { state: 'pending'; expires_at: number }
  | { state: 'authenticated'; account_id: string; email: string | null; project: string; expires_at: number }

export type Client = { client_id: string; client_secret: string }

export type Login = { authorization_url: string; expires_at: number }

export type Credential = { access_token: string; expires_at: number; generation: number; project: string }

export type Subscription = {
  start(): Promise<Login>
  complete(input: string): Promise<Status>
  status(): Promise<Status>
  credential(): Promise<Credential>
  reject(generation: number): Promise<void>
  signOut(): Promise<void>
}

export class ConflictError extends Error {
  override name = 'Antigravity.ConflictError'
}

export class ExchangeUncertainError extends Error {
  override name = 'Antigravity.ExchangeUncertainError'
}

export class HostError extends Error {
  override name = 'Antigravity.HostError'
}

export class InvalidError extends Error {
  override name = 'Antigravity.InvalidError'
}

export class LoginRequiredError extends Error {
  override name = 'Antigravity.LoginRequiredError'
}

export class UnavailableError extends Error {
  override name = 'Antigravity.UnavailableError'
}

type Token = { access: string; refresh: string; expires_at: number }

type State =
  | { kind: 'SignedOut' }
  | { kind: 'Pending'; verifier: string; state: string; expires_at: number }
  | { kind: 'Exchanging' }
  | { kind: 'Ready'; token: Token; account: string; email: string | null; project: string; generation: number }

type Tokens = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown; id_token?: unknown }

const refreshing = Http.singleFlight<void>()

export function create(store: Store.Store, options: create.Options): Subscription {
  const key = options.key
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  if (!key.trim()) throw new InvalidError('subscription key is empty')
  const configured = options.client
  if (configured && (!configured.client_id.trim() || !configured.client_secret.trim()))
    throw new InvalidError('the Antigravity OAuth client needs a client ID and a client secret')
  const client = (): Client => {
    if (!configured)
      throw new UnavailableError('Antigravity plans are unavailable: set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET')
    return configured
  }

  const load = async (): Promise<{ revision: number; state: State }> => {
    const record = await store.load(key)
    if (record.payload === undefined) return { revision: record.revision, state: { kind: 'SignedOut' } }
    try {
      return { revision: record.revision, state: JSON.parse(record.payload) as State }
    } catch (error) {
      throw new InvalidError(`the store returned malformed state: ${String(error)}`)
    }
  }

  const save = async (revision: number, state: State): Promise<number> => {
    const next = await store.compareAndSwap(key, { revision, payload: JSON.stringify(state) }).catch((error: unknown) => {
      throw new HostError(String(error instanceof Error ? error.message : error))
    })
    if (next === undefined) throw new ConflictError('the stored state changed')
    return next
  }

  const request = (method: string, url: string, headers: Record<string, string>, body: string | undefined) =>
    Http.send(fetcher, { url, method, headers, body, timeoutMs: requestTimeoutMs }).catch((error: unknown) => {
      throw new HostError(
        `Antigravity authentication request failed; its outcome may be unknown: ${String(error instanceof Error ? error.message : error)}`,
      )
    })

  const token = async (
    grant: Record<string, string>,
  ): Promise<{ status: number; tokens: Tokens; error: string | undefined; started: number }> => {
    const credentials = client()
    const pairs = { ...grant, client_id: credentials.client_id, client_secret: credentials.client_secret }
    const started = Http.now()
    const body = new URLSearchParams(Object.entries(pairs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString()
    const response = await request(
      'POST',
      tokenUrl,
      { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': tokenUserAgent },
      body,
    )
    if (response.status === 200) return { status: 200, tokens: decode(response.body), error: undefined, started }
    return { status: response.status, tokens: {}, error: oauthError(response.body), started }
  }

  const api = async (access: string, method: string, path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await request(
      method,
      `${baseUrl}/${path}`,
      {
        authorization: `Bearer ${access}`,
        'user-agent': userAgent,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body === undefined ? undefined : JSON.stringify(body),
    )
    if (response.status < 200 || response.status >= 300)
      throw new HostError(`Antigravity ${path} returned HTTP ${response.status}; verify account eligibility and sign in again`)
    return decode(response.body)
  }

  const loadCodeAssist = (access: string) =>
    api(access, 'POST', 'v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } })

  const onboard = async (access: string): Promise<void> => {
    const deadline = Http.now() + requestTimeoutMs
    let response = await api(access, 'POST', 'v1internal:onboardUser', {
      tierId: 'free-tier',
      metadata: { ideType: 'ANTIGRAVITY' },
    })
    while (Http.now() < deadline) {
      if (response.error !== undefined && response.error !== null)
        throw new LoginRequiredError('Antigravity onboarding failed; finish account setup in Antigravity and sign in again')
      if (response.done === true) {
        const kind = (response.response as { '@type'?: unknown } | undefined)?.['@type']
        if (typeof kind === 'string' && kind.split('/').pop() === 'google.internal.cloud.code.v1internal.OnboardUserResponse')
          return
        throw new InvalidError('Antigravity returned an invalid onboarding response; sign in again')
      }
      const name = response.name
      if (
        typeof name !== 'string' ||
        !name ||
        !name.split('/').every((part) => part && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part))
      )
        throw new InvalidError('Antigravity returned an invalid onboarding operation')
      await new Promise((resolve) => setTimeout(resolve, onboardIntervalMs))
      response = await api(access, 'GET', `v1internal/${name}`, undefined)
    }
    throw new HostError('Antigravity onboarding timed out; its outcome is unknown, finish account setup in Antigravity and sign in again')
  }

  const discover = async (access: string): Promise<string> => {
    let loaded = await loadCodeAssist(access)
    const tiers = (value: unknown, field: 'id' | 'tierId') =>
      Array.isArray(value) && value.some((tier: Record<string, unknown> | null) => tier?.[field] === 'free-tier')
    if (!tiers(loaded.allowedTiers, 'id') && tiers(loaded.ineligibleTiers, 'tierId'))
      throw new LoginRequiredError(
        'This Google account is not eligible for Antigravity; finish account validation in Antigravity and sign in again',
      )
    if (loaded.currentTier === undefined || loaded.currentTier === null) {
      await onboard(access)
      loaded = await loadCodeAssist(access)
    }
    const project = loaded.cloudaicompanionProject
    if (project === undefined || project === null) return ''
    if (typeof project !== 'string') throw new InvalidError('Antigravity returned an invalid managed project')
    return project
  }

  const refresh = async (generation: number): Promise<void> => {
    const loaded = await load()
    if (loaded.state.kind !== 'Ready') throw new LoginRequiredError('Antigravity is not signed in')
    const ready = loaded.state
    if (ready.generation !== generation) return

    const response = await token({
      grant_type: 'refresh_token',
      refresh_token: ready.token.refresh,
    })
    if (response.status !== 200) {
      const reloaded = await load()
      if (reloaded.state.kind === 'Ready' && reloaded.state.generation !== generation) return
      if (response.error === 'invalid_grant') {
        await save(reloaded.revision, { kind: 'SignedOut' })
        throw new LoginRequiredError('Google revoked the Antigravity refresh token (invalid_grant); sign in again')
      }
      throw new HostError(`Antigravity token refresh returned HTTP ${response.status}${response.error ? ` (${response.error})` : ''}`)
    }

    const issued = fromTokens(response.tokens, response.started, ready.token.refresh)
    const account = identity(response.tokens)
    if (account && account.account !== ready.account) throw new InvalidError('the refreshed credential changed accounts')
    try {
      await save(loaded.revision, { ...ready, token: issued, generation: generation + 1 })
      return
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error
    }
    const reloaded = (await load()).state
    if (reloaded.kind === 'Ready' && reloaded.account === ready.account && reloaded.generation !== generation) return
    throw new ConflictError('the stored state kept changing')
  }

  const status = async (): Promise<Status> => {
    if (!configured) return { state: 'unavailable' }
    const { state } = await load()
    switch (state.kind) {
      case 'SignedOut':
        return { state: 'signed_out' }
      case 'Pending':
        return Http.now() < state.expires_at ? { state: 'pending', expires_at: state.expires_at } : { state: 'expired' }
      case 'Exchanging':
        return { state: 'exchange_uncertain' }
      case 'Ready':
        return {
          state: 'authenticated',
          account_id: state.account,
          email: state.email,
          project: state.project,
          expires_at: state.token.expires_at,
        }
    }
  }

  return {
    async start() {
      const credentials = client()
      const verifier = Http.secret()
      const state = Http.secret()
      const expires_at = Http.now() + loginTtlMs
      const url = new URL(authorizeUrl)
      for (const [name, value] of [
        ['access_type', 'offline'],
        ['client_id', credentials.client_id],
        ['code_challenge', await Http.sha256(verifier)],
        ['code_challenge_method', 'S256'],
        ['prompt', 'consent'],
        ['redirect_uri', redirectUri],
        ['response_type', 'code'],
        ['scope', scopes.join(' ')],
        ['state', state],
      ] as const)
        url.searchParams.append(name, value)
      for (let attempt = 0; attempt < retries; attempt++) {
        const { revision } = await load()
        try {
          await save(revision, { kind: 'Pending', verifier, state, expires_at })
          return { authorization_url: url.toString(), expires_at }
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
        }
      }
      throw new ConflictError('the stored state kept changing')
    },
    async complete(input) {
      client()
      const { revision, state } = await load()
      if (state.kind === 'Exchanging') throw new ExchangeUncertainError('a token exchange was interrupted; sign in again')
      if (state.kind !== 'Pending') throw new LoginRequiredError('no sign-in is pending; start one first')
      if (Http.now() >= state.expires_at) throw new LoginRequiredError('the sign-in expired; start again')

      const code = callbackCode(input, state.state)
      const claim = await save(revision, { kind: 'Exchanging' })
      const response = await token({
        code,
        code_verifier: state.verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      })
      try {
        if (response.status !== 200)
          throw new LoginRequiredError(
            `Google refused the Antigravity sign-in with HTTP ${response.status}${response.error ? ` (${response.error})` : ''}; sign in again`,
          )
        const refresh = response.tokens.refresh_token
        if (typeof refresh !== 'string' || !refresh.trim())
          throw new LoginRequiredError('Google returned no refresh token; start a new login with consent')
        const issued = fromTokens(response.tokens, response.started, refresh)
        const account = identity(response.tokens)
        if (!account) throw new InvalidError('Google returned no ID token for the Antigravity sign-in')
        const project = await discover(issued.access)
        await save(claim, { kind: 'Ready', token: issued, account: account.account, email: account.email, project, generation: 0 })
      } catch (error) {
        await save(claim, { kind: 'SignedOut' }).catch(() => undefined)
        throw error
      }
      return status()
    },
    status,
    async credential() {
      client()
      for (let attempt = 0; attempt < retries; attempt++) {
        const { state } = await load()
        if (state.kind === 'Exchanging') throw new ExchangeUncertainError('a token exchange was interrupted; sign in again')
        if (state.kind !== 'Ready') throw new LoginRequiredError('Antigravity is not signed in')
        if (state.token.expires_at - Http.now() > refreshMarginMs)
          return {
            access_token: state.token.access,
            expires_at: state.token.expires_at,
            generation: state.generation,
            project: state.project,
          }
        try {
          await refreshing(`${key}:${state.generation}`, () => refresh(state.generation))
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
        }
      }
      throw new ConflictError('the stored state kept changing')
    },
    async reject(generation) {
      for (let attempt = 0; attempt < retries; attempt++) {
        const { revision, state } = await load()
        if (state.kind !== 'Ready' || state.generation !== generation || state.token.expires_at === 0) return
        try {
          await save(revision, { ...state, token: { ...state.token, expires_at: 0 } })
          return
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
        }
      }
      throw new ConflictError('the stored state kept changing')
    },
    async signOut() {
      for (let attempt = 0; attempt < retries; attempt++) {
        const { revision, state } = await load()
        try {
          await save(revision, { kind: 'SignedOut' })
        } catch (error) {
          if (error instanceof ConflictError) continue
          throw error
        }
        if (state.kind === 'Ready')
          await request(
            'POST',
            revokeUrl,
            { 'content-type': 'application/x-www-form-urlencoded' },
            new URLSearchParams({ token: state.token.refresh }).toString(),
          ).catch(() => undefined)
        return
      }
      throw new ConflictError('the stored state kept changing')
    },
  }
}

export declare namespace create {
  type Options = {
    key: string
    client?: Client | undefined
    fetch?: Http.Fetch | undefined
  }
}

function fromTokens(tokens: Tokens, started: number, refresh: string): Token {
  const access = tokens.access_token
  const lifetime = tokens.expires_in
  if (
    typeof access !== 'string' ||
    !access.trim() ||
    typeof lifetime !== 'number' ||
    !Number.isFinite(lifetime) ||
    lifetime <= 0 ||
    (typeof tokens.token_type === 'string' && tokens.token_type.toLowerCase() !== 'bearer')
  )
    throw new InvalidError('Google returned an invalid Antigravity access token')
  const expires_at = started + lifetime * 1000
  if (expires_at <= Http.now()) throw new InvalidError('Google returned an invalid Antigravity token expiry')
  const next = typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim() ? tokens.refresh_token : refresh
  return { access, refresh: next, expires_at }
}

function identity(tokens: Tokens): { account: string; email: string | null } | undefined {
  if (typeof tokens.id_token !== 'string') return undefined
  let claims: Record<string, unknown>
  try {
    claims = Http.claims(tokens.id_token)
  } catch (error) {
    throw new InvalidError(`Google returned an invalid ID token: ${String(error)}`)
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new InvalidError('the Google ID token has no subject')
  return { account: claims.sub, email: typeof claims.email === 'string' ? claims.email : null }
}

function callbackCode(input: string, expected: string): string {
  const callback = input.trim()
  if (!callback || callback.length > 16 * 1024 || /[\s\u0000-\u001f\u007f]/.test(callback))
    throw new InvalidError('paste the Antigravity authorization code or full callback URL')
  if (!/[:?#&=]/.test(callback)) return callback

  let url: URL
  try {
    url = new URL(callback)
  } catch {
    throw new InvalidError('paste the Antigravity authorization code or full callback URL')
  }
  const target = new URL(redirectUri)
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password || url.hash)
    throw new InvalidError('the Antigravity callback URL does not match this login')
  for (const name of ['state', 'code', 'error'])
    if (url.searchParams.getAll(name).length > 1)
      throw new InvalidError('the Antigravity callback contains duplicate OAuth parameters')
  if (url.searchParams.get('state') !== expected) throw new InvalidError('Antigravity OAuth state mismatch; start a new login')
  if (url.searchParams.has('error')) throw new LoginRequiredError('Google declined or cancelled the Antigravity OAuth login')
  const code = url.searchParams.get('code')
  if (!code?.trim()) throw new InvalidError('the Antigravity callback has no authorization code')
  return code
}

function oauthError(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { error?: unknown }
    return typeof value.error === 'string' ? value.error : undefined
  } catch {
    return undefined
  }
}

function decode(body: string): Record<string, never> {
  try {
    return JSON.parse(body) as Record<string, never>
  } catch (error) {
    throw new InvalidError(`Antigravity authentication returned invalid JSON: ${String(error)}`)
  }
}
