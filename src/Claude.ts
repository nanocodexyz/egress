/**
 * Sign-in with a Claude plan through claude.com's OAuth authorization with PKCE, and the headers that Claude requests carry.
 * A port of the nanocode SDK's `ClaudeSubscription`: the same endpoints, client, scopes, stored JSON and refresh rules.
 *
 * @module
 */
import * as Http from './internal/Http.ts'
import type * as Store from './Store.ts'

/** Beta that Messages requests with a plan's OAuth token carry. */
export const oauthBeta = 'oauth-2025-04-20'

/** OAuth configuration of Claude sign-ins. */
export type Config = {
  authorize_url: string
  token_url: string
  profile_url: string
  manual_redirect_uri: string
  client_id: string
  scopes: string[]
  refresh_margin_millis: number
  login_ttl_millis: number
  allow_loopback_http: boolean
}

const defaultClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const loginTtlMs = 15 * 60_000

const retries = 8

const maxBytes = 64 * 1024

/** Configuration of the Claude Code client, which the SDK's sign-ins use. */
export const config: Config = {
  authorize_url: 'https://claude.com/cai/oauth/authorize',
  token_url: 'https://platform.claude.com/v1/oauth/token',
  profile_url: 'https://api.anthropic.com/api/oauth/profile',
  manual_redirect_uri: 'https://platform.claude.com/oauth/code/callback',
  client_id: defaultClientId,
  scopes: [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
    'user:plugins',
  ],
  refresh_margin_millis: 5 * 60_000,
  login_ttl_millis: loginTtlMs,
  allow_loopback_http: false,
}

/** Sign-in state of one Claude plan. */
export type Status =
  | { state: 'signed_out' | 'account_on_hold' | 'expired' | 'exchange_uncertain' | 'validating' }
  | { state: 'pending'; expires_at: number }
  | { state: 'authenticated'; account_id: string; organization_id: string; expires_at: number }

/** Authorization page of a started sign-in. */
export type Login = { authorization_url: string; expires_at: number }

/** Request headers of a signed-in plan, and the token they carry so a rejection can name it. */
export type Authorization = { headers: { authorization: string; 'anthropic-beta': string } }

/** Claude plan of one store key. */
export type Subscription = {
  /** Starts a sign-in and returns the claude.com page to open. Without `redirect`, the page shows a code to paste into `complete`. */
  start(options?: start.Options): Promise<Login>
  /** Finishes a sign-in with the pasted `code#state`, or the full callback URL, and returns the status. */
  complete(input: string): Promise<Status>
  /** Returns the status. */
  status(): Promise<Status>
  /** Returns the request headers, refreshing the token first when it expires within the refresh margin. */
  authorization(): Promise<Authorization>
  /** Marks the token of `authorization` as expired after a provider rejected it, so the next `authorization` refreshes it. */
  reject(authorization: string): Promise<void>
  /** Forgets the sign-in and revokes its refresh token. */
  signOut(): Promise<void>
}

export declare namespace start {
  type Options = {
    /** Callback URL of a host that receives the redirect itself, instead of the manual code page. */
    redirect?: string | undefined
  }
}

/** Error of a plan that needs a new sign-in. */
export class LoginRequiredError extends Error {
  override name = 'Claude.LoginRequiredError'
}

/** Error of an account that Anthropic put on hold. */
export class AccountOnHoldError extends Error {
  override name = 'Claude.AccountOnHoldError'
}

/** Error of a code exchange whose outcome is unknown, because it was interrupted. */
export class ExchangeUncertainError extends Error {
  override name = 'Claude.ExchangeUncertainError'
}

/** Error of a request that Anthropic refused. */
export class ProviderRejectedError extends Error {
  override name = 'Claude.ProviderRejectedError'
}

/** Error of state that another writer changed first. */
export class ConflictError extends Error {
  override name = 'Claude.ConflictError'
}

/** Error of input, stored state or a provider answer that is not valid. */
export class InvalidError extends Error {
  override name = 'Claude.InvalidError'
}

/** Error of a host or network failure. */
export class HostError extends Error {
  override name = 'Claude.HostError'
}

type Identity = { account: string; organization: string }

type Token = {
  access: string
  refresh: string
  expires_at: number
  scopes: string[]
  refresh_expires_at: number | null
  expected_account: string | null
  expected_organization: string | null
}

type State =
  | { kind: 'SignedOut' }
  | { kind: 'AccountOnHold' }
  | { kind: 'Pending'; verifier: string; state: string; redirect: string; expires_at: number }
  | { kind: 'Exchanging' }
  | { kind: 'Validating'; token: Token; prior: Identity | null }
  | { kind: 'Ready'; token: Token; identity: Identity }

type Envelope = { version: 1; binding: string; state: State }

const resolving = Http.singleFlight<Authorization>()

/** Returns the Claude plan stored under `options.key`. */
export function create(store: Store.Store, options: create.Options): Subscription {
  const key = options.key
  const settings = options.config ?? config
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  if (!key) throw new InvalidError('subscription key is empty')
  for (const endpoint of [settings.authorize_url, settings.token_url, settings.profile_url, settings.manual_redirect_uri])
    checkUrl(endpoint, settings.allow_loopback_http)

  let bound: Promise<string> | undefined
  const binding = () => (bound ??= Http.sha256(JSON.stringify(ordered(settings))))

  const load = async (): Promise<{ revision: number; state: State }> => {
    const record = await store.load(key)
    if (record.payload === undefined) return { revision: record.revision, state: { kind: 'SignedOut' } }
    if (record.payload.length > maxBytes) throw new InvalidError('stored state is too large')

    let envelope: Envelope
    try {
      envelope = JSON.parse(record.payload) as Envelope
    } catch {
      throw new InvalidError('stored state is not JSON')
    }
    if (envelope.version !== 1 || envelope.binding !== (await binding()))
      throw new InvalidError('stored state belongs to another configuration')
    return { revision: record.revision, state: envelope.state }
  }

  const save = async (revision: number, state: State): Promise<number> => {
    const payload = JSON.stringify({ version: 1, binding: await binding(), state } satisfies Envelope)
    if (payload.length > maxBytes) throw new InvalidError('state is too large')
    const next = await store.compareAndSwap(key, { revision, payload }).catch((error: unknown) => {
      throw new HostError(String(error instanceof Error ? error.message : error))
    })
    if (next === undefined) throw new ConflictError('the stored state changed')
    if (next <= revision) throw new InvalidError('the store returned an earlier revision')
    return next
  }

  const request = async (method: string, url: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number) =>
    Http.send(fetcher, { url, method, headers, body, timeoutMs }, maxBytes).catch((error: unknown) => {
      throw new HostError(String(error instanceof Error ? error.message : error))
    })

  const validateProfile = async (revision: number, token: Token, prior: Identity | null): Promise<void> => {
    const response = await request(
      'GET',
      settings.profile_url,
      { authorization: bearer(token.access), 'content-type': 'application/json', 'cache-control': 'no-cache' },
      undefined,
      10_000,
    )
    if (response.status !== 200) {
      if (response.status === 401) await save(revision, { kind: 'Validating', token: { ...token, expires_at: 0 }, prior })
      throw new ProviderRejectedError(`the profile endpoint answered HTTP ${response.status}`)
    }

    let profile: { account?: { uuid?: unknown }; organization?: { uuid?: unknown } }
    try {
      profile = JSON.parse(response.body) as typeof profile
    } catch {
      throw new InvalidError('the profile endpoint returned invalid JSON')
    }
    const identity = { account: String(profile.account?.uuid ?? ''), organization: String(profile.organization?.uuid ?? '') }
    if (
      !validIdentity(identity.account) ||
      !validIdentity(identity.organization) ||
      (prior && (prior.account !== identity.account || prior.organization !== identity.organization)) ||
      (token.expected_account !== null && token.expected_account !== identity.account) ||
      (token.expected_organization !== null && token.expected_organization !== identity.organization)
    ) {
      await save(revision, { kind: 'SignedOut' })
      throw new InvalidError('the signed-in account changed')
    }
    await save(revision, { kind: 'Ready', token, identity })
  }

  const exchange = async (
    claimed: number,
    body: Record<string, string>,
    old: Token | undefined,
    prior: Identity | null,
  ): Promise<void> => {
    let claim = claimed
    const headers = { 'content-type': 'application/json' }
    let response = await request('POST', settings.token_url, headers, JSON.stringify(body), 30_000)
    if (response.status === 400 && old && providerError(response.body) === 'invalid_scope') {
      claim = await save(claim, { kind: 'Exchanging' })
      response = await request('POST', settings.token_url, headers, JSON.stringify({ ...body, scope: old.scopes.join(' ') }), 30_000)
    }
    if (response.status !== 200) {
      const error = providerError(response.body)
      if ([400, 401, 403].includes(response.status) && onHold(response.body)) {
        await save(claim, { kind: 'AccountOnHold' })
        throw new AccountOnHoldError('the Claude account is on hold')
      }
      if ((response.status === 400 || response.status === 401) && error === 'invalid_grant') {
        await save(claim, { kind: 'SignedOut' })
        throw new LoginRequiredError('the sign-in was refused; sign in again')
      }
      throw new ProviderRejectedError(`the token endpoint answered HTTP ${response.status}${error ? ` (${error})` : ''}`)
    }

    let tokens: {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      refresh_token_expires_in?: unknown
      scope?: unknown
      token_type?: unknown
      account?: { uuid?: unknown }
      organization?: { uuid?: unknown }
    }
    try {
      tokens = JSON.parse(response.body) as typeof tokens
    } catch {
      throw new InvalidError('the token endpoint returned invalid JSON')
    }
    if (typeof tokens.access_token !== 'string' || typeof tokens.expires_in !== 'number' || typeof tokens.scope !== 'string')
      throw new InvalidError('the token response is incomplete')
    const scopes = tokens.scope.split(/\s+/).filter(Boolean)
    if (
      (typeof tokens.token_type === 'string' && tokens.token_type.toLowerCase() !== 'bearer') ||
      !['user:profile', 'user:inference'].every((scope) => scopes.includes(scope))
    )
      throw new InvalidError('the token lacks the profile and inference scopes')

    const refresh = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : old?.refresh
    if (!refresh || !validSecret(refresh)) throw new InvalidError('the token response has no refresh token')
    bearer(tokens.access_token)
    const lifetime = tokens.expires_in * 1000
    if (lifetime <= settings.refresh_margin_millis) throw new InvalidError('the token expires within the refresh margin')

    const now = Http.now()
    const token: Token = {
      access: tokens.access_token,
      refresh,
      expires_at: now + lifetime,
      scopes,
      refresh_expires_at:
        typeof tokens.refresh_token_expires_in === 'number'
          ? now + tokens.refresh_token_expires_in * 1000
          : old
            ? old.refresh_expires_at
            : now + 30 * 24 * 60 * 60_000,
      expected_account: continuity(uuid(tokens.account), old?.expected_account ?? null),
      expected_organization: continuity(uuid(tokens.organization), old?.expected_organization ?? null),
    }

    const next = await save(claim, { kind: 'Validating', token, prior })
    const loaded = await load()
    if (loaded.revision !== next || loaded.state.kind !== 'Validating') throw new ConflictError('the stored state changed')
    await validateProfile(loaded.revision, loaded.state.token, loaded.state.prior)
  }

  const refreshToken = async (revision: number, token: Token, prior: Identity | null): Promise<void> => {
    if (token.refresh_expires_at !== null && Http.now() >= token.refresh_expires_at) {
      await save(revision, { kind: 'SignedOut' })
      throw new LoginRequiredError('the refresh token expired; sign in again')
    }
    const scopes =
      settings.client_id === defaultClientId
        ? settings.scopes.filter((scope) => scope !== 'org:create_api_key')
        : [...token.scopes]
    for (const scope of token.scopes)
      if ((scope === 'user:projects:read' || scope === 'user:projects:write') && !scopes.includes(scope)) scopes.push(scope)
    const claim = await save(revision, { kind: 'Exchanging' })
    await exchange(
      claim,
      { grant_type: 'refresh_token', refresh_token: token.refresh, client_id: settings.client_id, scope: scopes.join(' ') },
      token,
      prior,
    )
  }

  const resumeValidation = (revision: number, token: Token, prior: Identity | null) =>
    token.expires_at - Http.now() <= settings.refresh_margin_millis
      ? refreshToken(revision, token, prior)
      : validateProfile(revision, token, prior)

  const resolve = async (): Promise<Authorization> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      const { revision, state } = await load()
      try {
        switch (state.kind) {
          case 'Ready':
            if (state.token.expires_at - Http.now() > settings.refresh_margin_millis) return headersOf(state.token)
            await refreshToken(revision, state.token, state.identity)
            continue
          case 'Validating':
            await resumeValidation(revision, state.token, state.prior)
            continue
          case 'Exchanging':
            throw new ExchangeUncertainError('a token exchange was interrupted; sign in again')
          case 'AccountOnHold':
            throw new AccountOnHoldError('the Claude account is on hold')
          default:
            throw new LoginRequiredError('Claude is not signed in')
        }
      } catch (error) {
        if (error instanceof ConflictError) continue
        throw error
      }
    }
    throw new ConflictError('the stored state kept changing')
  }

  return {
    async start(startOptions = {}) {
      const redirect = startOptions.redirect ?? settings.manual_redirect_uri
      if (startOptions.redirect !== undefined) checkUrl(redirect, true)
      const verifier = Http.secret()
      const state = Http.secret()
      const expires_at = Http.now() + settings.login_ttl_millis
      const url = new URL(settings.authorize_url)
      for (const [name, value] of [
        ['code', 'true'],
        ['client_id', settings.client_id],
        ['response_type', 'code'],
        ['redirect_uri', redirect],
        ['scope', settings.scopes.join(' ')],
        ['code_challenge', await Http.sha256(verifier)],
        ['code_challenge_method', 'S256'],
        ['state', state],
      ] as const)
        url.searchParams.append(name, value)
      for (let attempt = 0; attempt < retries; attempt++) {
        const { revision } = await load()
        try {
          await save(revision, { kind: 'Pending', verifier, state, redirect, expires_at })
          return { authorization_url: url.toString(), expires_at }
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
        }
      }
      throw new ConflictError('the stored state kept changing')
    },
    async complete(input) {
      const { revision, state } = await load()
      if (state.kind === 'Validating') await resumeValidation(revision, state.token, state.prior)
      else if (state.kind === 'Pending') {
        if (Http.now() >= state.expires_at) throw new LoginRequiredError('the sign-in expired; start again')
        const code = parseCallback(input, state.redirect, state.state)
        const claim = await save(revision, { kind: 'Exchanging' })
        await exchange(
          claim,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: state.redirect,
            client_id: settings.client_id,
            code_verifier: state.verifier,
            state: state.state,
          },
          undefined,
          null,
        )
      } else if (state.kind === 'Exchanging') throw new ExchangeUncertainError('a token exchange was interrupted; sign in again')
      else throw new LoginRequiredError('no sign-in is pending; start one first')
      return this.status()
    },
    async status() {
      const { state } = await load()
      switch (state.kind) {
        case 'SignedOut':
          return { state: 'signed_out' }
        case 'AccountOnHold':
          return { state: 'account_on_hold' }
        case 'Pending':
          return Http.now() < state.expires_at ? { state: 'pending', expires_at: state.expires_at } : { state: 'expired' }
        case 'Exchanging':
          return { state: 'exchange_uncertain' }
        case 'Validating':
          return { state: 'validating' }
        case 'Ready':
          return {
            state: 'authenticated',
            account_id: state.identity.account,
            organization_id: state.identity.organization,
            expires_at: state.token.expires_at,
          }
      }
    },
    authorization() {
      return resolving(key, resolve)
    },
    async reject(authorization) {
      for (let attempt = 0; attempt < retries; attempt++) {
        const { revision, state } = await load()
        if (state.kind !== 'Ready' || authorization !== bearer(state.token.access) || state.token.expires_at === 0) return
        try {
          await save(revision, { kind: 'Ready', token: { ...state.token, expires_at: 0 }, identity: state.identity })
          return
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error
        }
      }
      throw new ConflictError('the stored state kept changing')
    },
    async signOut() {
      for (let attempt = 0; attempt < retries; attempt++) {
        const record = await store.load(key)
        let refresh: string | undefined
        try {
          const envelope = record.payload === undefined ? undefined : (JSON.parse(record.payload) as Envelope)
          if (envelope && envelope.version === 1 && envelope.binding === (await binding()))
            if (envelope.state.kind === 'Ready' || envelope.state.kind === 'Validating') refresh = envelope.state.token.refresh
        } catch {}
        try {
          await save(record.revision, { kind: 'SignedOut' })
        } catch (error) {
          if (error instanceof ConflictError) continue
          throw error
        }
        if (refresh)
          await request(
            'POST',
            `${settings.token_url.replace(/\/+$/, '')}/revoke`,
            { 'content-type': 'application/json' },
            JSON.stringify({ token: refresh, token_type_hint: 'refresh_token', client_id: settings.client_id }),
            5_000,
          ).catch(() => undefined)
        return
      }
      throw new ConflictError('the stored state kept changing')
    },
  }
}

export declare namespace create {
  type Options = {
    /** Store key of this plan. */
    key: string
    /** OAuth configuration. Defaults to `config`. */
    config?: Config | undefined
    /** `fetch` of the OAuth requests. Defaults to the global `fetch`. */
    fetch?: Http.Fetch | undefined
  }
}

function ordered(settings: Config): Config {
  return {
    authorize_url: settings.authorize_url,
    token_url: settings.token_url,
    profile_url: settings.profile_url,
    manual_redirect_uri: settings.manual_redirect_uri,
    client_id: settings.client_id,
    scopes: settings.scopes,
    refresh_margin_millis: settings.refresh_margin_millis,
    login_ttl_millis: settings.login_ttl_millis,
    allow_loopback_http: settings.allow_loopback_http,
  }
}

function headersOf(token: Token): Authorization {
  return { headers: { authorization: bearer(token.access), 'anthropic-beta': oauthBeta } }
}

function bearer(value: string): string {
  if (!validSecret(value)) throw new InvalidError('the token is not a valid bearer token')
  return `Bearer ${value}`
}

function validSecret(value: string): boolean {
  return value.length > 0 && value.length <= 16 * 1024 && /^[A-Za-z0-9\-._~+/=]+$/.test(value)
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

function uuid(field: { uuid?: unknown } | undefined): string | null {
  return typeof field?.uuid === 'string' ? field.uuid : null
}

function continuity(next: string | null, old: string | null): string | null {
  if (next !== null && old !== null && next !== old) throw new InvalidError('the refreshed token changed accounts')
  return next ?? old
}

function checkUrl(value: string, loopback: boolean): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new InvalidError(`${value} is not a URL`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (loopback && local && url.protocol === 'http:'))
  )
    throw new InvalidError(`${value} is not an allowed OAuth URL`)
}

function parseCallback(input: string, redirect: string, expected: string): string {
  if (input.length > 16 * 1024) throw new InvalidError('the code is too long')

  let code: string
  let state: string
  if (input.includes('://')) {
    const callback = new URL(input)
    const target = new URL(redirect)
    const codes = callback.searchParams.getAll('code')
    const states = callback.searchParams.getAll('state')
    if (
      callback.origin !== target.origin ||
      callback.pathname !== target.pathname ||
      callback.hash ||
      callback.username ||
      callback.password ||
      callback.searchParams.has('error') ||
      codes.length !== 1 ||
      states.length !== 1
    )
      throw new InvalidError('the callback URL does not match the sign-in')
    code = codes[0]!
    state = states[0]!
  } else {
    const trimmed = input.trim()
    const split = trimmed.indexOf('#')
    if (split < 0) throw new InvalidError('paste the whole code the Claude page shows, including the part after #')
    code = trimmed.slice(0, split)
    state = trimmed.slice(split + 1)
  }
  if (state !== expected || !code || code.length > 8192 || /[\u0000-\u001f\u007f]/.test(code))
    throw new InvalidError('the code does not belong to this sign-in')
  return code
}

function providerError(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { error?: unknown }
    if (typeof value.error === 'string') return value.error
    const nested = value.error as { type?: unknown } | undefined
    return typeof nested?.type === 'string' ? nested.type : undefined
  } catch {
    return undefined
  }
}

function onHold(body: string): boolean {
  try {
    const value = JSON.parse(body) as { error?: unknown; error_description?: unknown }
    return (value.error === 'invalid_grant' || value.error === 'access_denied') && value.error_description === 'account_on_hold'
  } catch {
    return false
  }
}
