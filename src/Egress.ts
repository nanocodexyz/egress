/**
 * Model requests on a plan: exact destinations, the credential injected at this boundary, and one retry after a rejection.
 *
 * @module
 */
import * as Http from './internal/Http.ts'
import type * as Plans from './Plans.ts'

/** URL of the Codex Responses API of ChatGPT plans, which Codex WebSockets open. */
export const codexResponses = 'https://chatgpt.com/backend-api/codex/responses'

const destinations: Record<Plans.Provider, { origin: string; targets: readonly string[] }> = {
  antigravity: {
    origin: 'https://daily-cloudcode-pa.googleapis.com',
    targets: ['/v1internal:generateContent', '/v1internal:streamGenerateContent?alt=sse'],
  },
  claude: { origin: 'https://api.anthropic.com', targets: ['/v1/messages?beta=true', '/v1/messages/count_tokens?beta=true'] },
  codex: { origin: 'https://chatgpt.com', targets: ['/backend-api/codex/responses', '/backend-api/codex/responses/compact'] },
}

const decodable = new Set(['gzip', 'x-gzip', 'deflate', 'br'])

const dropped = new Set([
  'accept-encoding',
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
  'chatgpt-account-id',
  'x-openai-fedramp',
  'x-goog-api-key',
  'x-goog-user-project',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
])

/** Error of a request whose destination the plan egress does not serve. */
export class DestinationError extends Error {
  override name = 'Egress.DestinationError'
}

/** Model request of a nanocode session, as its host dispatches it. */
export type Request = {
  provider: Plans.Provider
  endpoint: string
  method?: string | undefined
  headers: Iterable<[string, string]>
  body: Uint8Array | null
}

/** Returns the request's URL when it is one the plan of `provider` serves, and throws `DestinationError` otherwise. */
export function destination(provider: Plans.Provider, endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new DestinationError(`${endpoint} is not a URL`)
  }
  const allowed = destinations[provider]
  if (url.origin !== allowed.origin || !allowed.targets.includes(url.pathname + url.search) || url.username || url.password)
    throw new DestinationError(`a ${provider} plan does not serve ${url.origin}${url.pathname}`)
  return url
}

/**
 * Returns the request headers without credentials, cookies, hop-by-hop headers or `accept-encoding`, merged with
 * `injection`. The runtime's `fetch` then asks only for the encodings it decodes.
 */
export function headers(incoming: Iterable<[string, string]>, injection: Plans.Injection): Headers {
  const merged = new Headers()
  for (const [name, value] of incoming) if (!dropped.has(name.toLowerCase())) merged.append(name, value)
  for (const [name, value] of Object.entries(injection.headers)) {
    if (name === 'anthropic-beta') {
      const betas = new Set([...(merged.get(name)?.split(',') ?? []), value].map((beta) => beta.trim()).filter(Boolean))
      merged.set(name, [...betas].join(','))
    } else merged.set(name, value)
  }
  return merged
}

/** Sends a model request on `account`'s plan, and retries it once with a refreshed credential after a 401. */
export async function send(account: Plans.Account, request: Request, options: send.Options = {}): Promise<Response> {
  const url = destination(request.provider, request.endpoint)
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
  const incoming = [...request.headers]

  const dispatch = (injection: Plans.Injection, signal: AbortSignal | undefined) => {
    const payload = body(request, injection)
    return fetcher(url.toString(), {
      method: request.method ?? 'POST',
      headers: headers(incoming, injection),
      ...(payload ? { body: payload as Uint8Array<ArrayBuffer> } : {}),
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    })
  }

  const inject = async () => {
    try {
      const injection = await account.inject(request.provider)
      if (options.remembered) options.remembered.injection = injection
      return injection
    } catch (error) {
      if (options.remembered) options.remembered.injection = undefined
      throw error
    }
  }

  const attempt = async (known: Plans.Injection | undefined) => {
    if (!known) {
      const injection = await inject()
      return { response: await dispatch(injection, options.signal), injection }
    }
    const checked = new AbortController()
    const responding = dispatch(known, options.signal ? AbortSignal.any([checked.signal, options.signal]) : checked.signal)
    void responding.catch(() => undefined)
    await inject().catch((error: unknown) => {
      checked.abort(error)
      throw error
    })
    return { response: await responding, injection: known }
  }

  const known = options.remembered?.injection
  const first = await attempt(known && (known.expires_at === undefined || known.expires_at > Http.now()) ? known : undefined)
  if (first.response.status !== 401) return guard(first.response)

  await first.response.body?.cancel().catch(() => undefined)
  await account.rejected(request.provider, { generation: first.injection.generation })
  return guard((await attempt(undefined)).response)
}

export declare namespace send {
  type Options = {
    /** `fetch` of the model request. Defaults to the global `fetch`. */
    fetch?: Http.Fetch | undefined
    remembered?: Remembered | undefined
    /** Signal that cancels the request. */
    signal?: AbortSignal | undefined
  }
}

export type Remembered = { injection: Plans.Injection | undefined }

/** Returns the URL and headers that open a Codex WebSocket on `account`'s ChatGPT plan, and the generation they carry. */
export async function socket(
  account: Plans.Account,
  incoming: Iterable<[string, string]>,
): Promise<{ url: string; headers: Headers; generation: string }> {
  const injection = await account.inject('codex')
  return { url: codexResponses, headers: headers(incoming, injection), generation: injection.generation }
}

function body(request: Request, injection: Plans.Injection): Uint8Array | null {
  if (request.provider !== 'antigravity' || !request.body) return request.body

  let wrapped: unknown
  try {
    wrapped = JSON.parse(new TextDecoder().decode(request.body))
  } catch {
    throw new DestinationError('an antigravity plan request needs a JSON object body')
  }
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped))
    throw new DestinationError('an antigravity plan request needs a JSON object body')

  const fields = wrapped as Record<string, unknown>
  const project = injection.project ?? ''
  if (fields.project !== undefined && fields.project !== project)
    throw new DestinationError('an antigravity plan serves only the project of its sign-in')
  if (fields.project === project || (fields.project === undefined && !project)) return request.body
  return new TextEncoder().encode(JSON.stringify({ ...fields, project }))
}

function guard(response: Response): Response {
  if (response.status < 300 || response.status >= 400) return decoded(response)
  void response.body?.cancel().catch(() => undefined)
  return Response.json(
    { error: { type: 'api_error', message: `the provider redirected a plan request (HTTP ${response.status})` } },
    { status: 502 },
  )
}

function decoded(response: Response): Response {
  const codings = (response.headers.get('content-encoding') ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter(Boolean)
  if (codings.length === 0 || !codings.every((coding) => decodable.has(coding))) return response
  const headers = new Headers(response.headers)
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) headers.delete(name)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
