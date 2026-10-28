/**
 * Node relay of ChatGPT-plan requests, for hosts whose own egress chatgpt.com refuses, such as Cloudflare Workers,
 * whose every subrequest carries a `cf-worker` header that chatgpt.com's edge answers with HTTP 403: it forwards only
 * the Codex Responses endpoints, over HTTPS and WebSocket, for callers that present its secret, without the
 * `cf-*` and `cdn-loop` headers.
 * Run it in a Cloudflare Container or on any Node host, and point the Cloudflare binding's `relay` at it.
 *
 * @module
 */
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import type * as net from 'node:net'
import { Readable } from 'node:stream'
import { fetch as undiciFetch, WebSocket as UpstreamSocket } from 'undici'
import { WebSocketServer } from 'ws'

/** Header that carries the relay's secret. */
export const secretHeader = 'x-nanocode-relay-secret'

/** Origin that the relay forwards to. */
export const upstream = 'https://chatgpt.com'

const paths = new Set(['/backend-api/codex/responses', '/backend-api/codex/responses/compact'])

const dropped = new Set([
  secretHeader,
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
])

/** Returns an HTTP server that relays Codex requests of callers that send `options.secret`. */
export function create(options: create.Options): http.Server {
  if (options.secret.length < 32) throw new Error('the relay secret needs at least 32 characters')
  const expected = crypto.createHash('sha256').update(options.secret).digest()
  const origin = options.upstream ?? upstream
  const sockets = new WebSocketServer({ noServer: true })

  const admitted = (request: http.IncomingMessage): string | undefined => {
    const url = new URL(request.url ?? '/', 'http://relay')
    const presented = crypto.createHash('sha256').update(String(request.headers[secretHeader] ?? '')).digest()
    if (!crypto.timingSafeEqual(presented, expected)) return 'the relay secret is missing or wrong'
    if (!paths.has(url.pathname) || url.search) return `the relay does not forward ${url.pathname}`
    return undefined
  }

  const forwarded = (request: http.IncomingMessage): Record<string, string> => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined && !dropped.has(name) && !name.startsWith('cf-') && name !== 'cdn-loop')
        headers[name] = Array.isArray(value) ? value.join(', ') : value
    return headers
  }

  const server = http.createServer(async (request, response) => {
    const refused = admitted(request)
    if (refused || request.method !== 'POST') {
      response.writeHead(refused?.includes('secret') ? 401 : 403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: refused ?? 'the relay forwards POST requests only' }))
      return
    }
    try {
      const upstreamResponse = await undiciFetch(origin + new URL(request.url ?? '/', 'http://relay').pathname, {
        method: 'POST',
        headers: forwarded(request),
        body: Readable.toWeb(request) as ReadableStream,
        duplex: 'half',
        redirect: 'manual',
      })
      const headers: Record<string, string> = {}
      upstreamResponse.headers.forEach((value, name) => {
        if (name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding') headers[name] = value
      })
      response.writeHead(upstreamResponse.status, headers)
      if (upstreamResponse.body) Readable.fromWeb(upstreamResponse.body as never).pipe(response)
      else response.end()
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `the relay could not reach ${origin}: ${String(error)}` }))
    }
  })

  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const refused = admitted(request)
    if (refused) {
      socket.end(`HTTP/1.1 ${refused.includes('secret') ? 401 : 403} Forbidden\r\nconnection: close\r\n\r\n`)
      return
    }
    const target = origin.replace(/^http/, 'ws') + new URL(request.url ?? '/', 'http://relay').pathname
    const outbound = new UpstreamSocket(target, { headers: forwarded(request) })
    const pending: (string | Buffer)[] = []
    let client: import('ws').WebSocket | undefined

    outbound.addEventListener('error', () => {
      if (client) client.close(1011, 'chatgpt.com closed the relay')
      else socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
    })
    outbound.addEventListener('open', () => {
      sockets.handleUpgrade(request, socket, head, (accepted) => {
        client = accepted
        accepted.on('message', (data, binary) => {
          const message = binary ? (data as Buffer) : data.toString()
          if (outbound.readyState === UpstreamSocket.OPEN) outbound.send(message)
          else pending.push(message)
        })
        accepted.on('close', (code, reason) => outbound.close(code >= 3000 && code < 5000 ? code : 1000, reason.toString()))
        for (const message of pending.splice(0)) outbound.send(message)
      })
    })
    outbound.addEventListener('message', (event) => {
      client?.send(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer))
    })
    outbound.addEventListener('close', (event) => {
      client?.close(event.code >= 3000 && event.code < 5000 ? event.code : 1000, event.reason)
    })
  })

  return server
}

export declare namespace create {
  type Options = {
    /** Secret of at least 32 characters that callers send in `x-nanocode-relay-secret`. */
    secret: string
    /** Origin to forward to. Defaults to `https://chatgpt.com`; tests replace it. */
    upstream?: string | undefined
  }
}
