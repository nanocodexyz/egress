import type * as Http from '../src/internal/Http.ts'

/** Returns an unsigned JWT with `claims`. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.signature`
}

type Handler = (request: { url: URL; method: string; headers: Headers; body: string }) => Response | Promise<Response>

/** Returns a `fetch` that answers each request with the first matching handler, and the requests it saw. */
export function server(routes: Record<string, Handler>): { fetch: Http.Fetch; requests: { url: string; method: string; headers: Headers; body: string }[] } {
  const requests: { url: string; method: string; headers: Headers; body: string }[] = []

  return {
    requests,
    async fetch(input, init) {
      const url = new URL(input)
      const body =
        init.body === undefined || init.body === null
          ? ''
          : typeof init.body === 'string'
            ? init.body
            : new TextDecoder().decode(init.body as Uint8Array)
      const request = { url: url.toString(), method: init.method ?? 'GET', headers: new Headers(init.headers), body }
      requests.push(request)
      const handler = routes[`${request.method} ${url.origin}${url.pathname}`]
      if (!handler) return new Response(`no route for ${request.method} ${url}`, { status: 599 })
      return handler({ url, method: request.method, headers: request.headers, body })
    },
  }
}
