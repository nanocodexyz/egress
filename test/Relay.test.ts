import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket as Client, WebSocketServer } from 'ws'
import * as Relay from '../src/relay/Relay.ts'

const secret = 'relay-secret-relay-secret-relay-secret'

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function setup() {
  const seen: Seen[] = []
  const upstream = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    seen.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"type":"response.created"}\n\n')
    response.end('data: {"type":"response.completed"}\n\n')
  })
  const sockets = new WebSocketServer({ server: upstream })
  sockets.on('connection', (socket, request) => {
    seen.push({ method: 'GET', path: request.url ?? '', headers: request.headers, body: '' })
    socket.on('message', (data) => socket.send(`echo ${data.toString()}`))
  })
  const origin = await listen(upstream)
  const relay = Relay.create({ secret, upstream: origin })
  const url = await listen(relay)
  return {
    seen,
    url,
    async close() {
      relay.closeAllConnections()
      for (const client of sockets.clients) client.terminate()
      await new Promise((resolve) => relay.close(resolve))
      await new Promise((resolve) => sockets.close(resolve))
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
    },
  }
}

test('relays Codex requests without the secret and Cloudflare headers', async () => {
  const relay = await setup()
  try {
    const response = await fetch(`${relay.url}/backend-api/codex/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer plan',
        'chatgpt-account-id': 'acct',
        'cf-worker': 'example.workers.dev',
        'cf-connecting-ip': '203.0.113.1',
        'cdn-loop': 'cloudflare',
        [Relay.secretHeader]: secret,
      },
      body: '{"model":"gpt-6-luna"}',
    })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /response\.completed/)
    const [request] = relay.seen
    assert.equal(request?.path, '/backend-api/codex/responses')
    assert.equal(request?.body, '{"model":"gpt-6-luna"}')
    assert.equal(request?.headers.authorization, 'Bearer plan')
    assert.equal(request?.headers['chatgpt-account-id'], 'acct')
    for (const name of [Relay.secretHeader, 'cf-worker', 'cf-connecting-ip', 'cdn-loop'])
      assert.equal(request?.headers[name], undefined, name)
  } finally {
    await relay.close()
  }
})

test('refuses callers without the secret and other paths', async () => {
  const relay = await setup()
  try {
    const missing = await fetch(`${relay.url}/backend-api/codex/responses`, { method: 'POST', body: '{}' })
    assert.equal(missing.status, 401)
    const wrong = await fetch(`${relay.url}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { [Relay.secretHeader]: `${secret}x` },
      body: '{}',
    })
    assert.equal(wrong.status, 401)
    for (const path of ['/backend-api/me', '/backend-api/codex/responses?x=1']) {
      const other = await fetch(`${relay.url}${path}`, { method: 'POST', headers: { [Relay.secretHeader]: secret }, body: '{}' })
      assert.equal(other.status, 403, path)
    }
    const get = await fetch(`${relay.url}/backend-api/codex/responses`, { headers: { [Relay.secretHeader]: secret } })
    assert.equal(get.status, 403)
    assert.equal(relay.seen.length, 0)
    assert.throws(() => Relay.create({ secret: 'short' }), /32 characters/)
  } finally {
    await relay.close()
  }
})

test('relays Codex sockets', async () => {
  const relay = await setup()
  try {
    const socket = new Client(`${relay.url.replace('http', 'ws')}/backend-api/codex/responses`, {
      headers: { authorization: 'Bearer plan', 'cf-worker': 'example.workers.dev', [Relay.secretHeader]: secret },
    })
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('open', () => socket.send('response.create'))
      socket.on('message', (data) => resolve(data.toString()))
      socket.on('error', reject)
    })
    socket.close()
    assert.equal(reply, 'echo response.create')
    const [request] = relay.seen
    assert.equal(request?.path, '/backend-api/codex/responses')
    assert.equal(request?.headers.authorization, 'Bearer plan')
    assert.equal(request?.headers['cf-worker'], undefined)
    assert.equal(request?.headers[Relay.secretHeader], undefined)

    const refused = new Client(`${relay.url.replace('http', 'ws')}/backend-api/codex/responses`)
    const status = await new Promise<number>((resolve) => refused.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)))
    assert.equal(status, 401)
  } finally {
    await relay.close()
  }
})
