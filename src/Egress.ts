/**
 * Model requests on a plan: exact destinations, the credential injected at this boundary, and one retry after a rejection.
 *
 * @module
 */
import type * as Http from './internal/Http.ts'
import type * as Plans from './Plans.ts'

/** URL of the Codex Responses API of ChatGPT plans, which Codex WebSockets open. */
export const codexResponses = 'https://chatgpt.com/backend-api/codex/responses'

const destinations: Record<Plans.Provider, { origin: string; paths: readonly string[]; query?: string }> = {
  claude: { origin: 'https://api.anthropic.com', paths: ['/v1/messages', '/v1/messages/count_tokens'], query: '?beta=true' },
  codex: { origin: 'https://chatgpt.com', paths: ['/backend-api/codex/responses', '/backend-api/codex/responses/compact'] },
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
  if (
    url.origin !== allowed.origin ||
    !allowed.paths.includes(url.pathname) ||
    url.search !== (allowed.query ?? '') ||
    url.username ||
    url.password
  )
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

  const attempt = async () => {
    const injection = await account.inject(request.provider)
    const response = await fetcher(url.toString(), {
      method: request.method ?? 'POST',
      headers: headers(incoming, injection),
      ...(request.body ? { body: request.body as Uint8Array<ArrayBuffer> } : {}),
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { response, injection }
  }

  const first = await attempt()
  if (first.response.status !== 401) return guard(first.response)

  await first.response.body?.cancel().catch(() => undefined)
  await account.rejected(request.provider, { generation: first.injection.generation })
  return guard((await attempt()).response)
}

export declare namespace send {
  type Options = {
    /** `fetch` of the model request. Defaults to the global `fetch`. */
    fetch?: Http.Fetch | undefined
    /** Signal that cancels the request. */
    signal?: AbortSignal | undefined
  }
}

/** Returns the URL and headers that open a Codex WebSocket on `account`'s ChatGPT plan, and the generation they carry. */
export async function socket(
  account: Plans.Account,
  incoming: Iterable<[string, string]>,
): Promise<{ url: string; headers: Headers; generation: string }> {
  const injection = await account.inject('codex')
  return { url: codexResponses, headers: headers(incoming, injection), generation: injection.generation }
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
