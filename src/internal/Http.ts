/** `fetch` that the sign-in flows and the egress send requests with. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Largest response body in bytes that an OAuth endpoint may return. */
export const maxOAuthBytes = 64 * 1024

/** Sends one request and returns its status and text body, refusing bodies over `maxBytes`. */
export async function send(
  fetcher: Fetch,
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string | undefined
    timeoutMs: number
  },
  maxBytes = maxOAuthBytes,
): Promise<{ status: number; body: string }> {
  const response = await fetcher(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: 'manual',
    signal: AbortSignal.timeout(request.timeoutMs),
  })
  const body = await response.text()
  if (new TextEncoder().encode(body).length > maxBytes)
    throw new Error(`${new URL(request.url).host} returned more than ${maxBytes} bytes`)
  return { status: response.status, body }
}

/** Returns a runner that runs `run` once per key at a time: concurrent callers with the same key share its result. */
export function singleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const flights = new Map<string, Promise<T>>()

  return (key, run) => {
    const current = flights.get(key)
    if (current) return current

    const flight = run().finally(() => flights.delete(key))
    flights.set(key, flight)
    return flight
  }
}

/** Decodes the claims of a JSON Web Token without verifying it. */
export function claims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]
  if (!payload) throw new Error('invalid JWT format')
  return JSON.parse(new TextDecoder().decode(unbase64url(payload))) as Record<string, unknown>
}

/** Returns 32 random bytes as base64url. */
export function secret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** Encodes bytes as base64url without padding. */
export function base64url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Decodes base64url, with or without padding. */
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

/** Returns the SHA-256 digest of `value` as base64url. */
export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

/** Returns the current time in milliseconds since the epoch. */
export function now(): number {
  return Date.now()
}
