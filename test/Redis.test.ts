import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Redis from '../src/vercel/Redis.ts'

test('the Redis store swaps through EVAL only from the revision the caller read', async () => {
  const data = new Map<string, string>()
  const store = Redis.store({
    url: 'https://redis.example',
    token: 't',
    fetch: async (_input, init) => {
      const [command, ...args] = JSON.parse(String(init.body)) as (string | number)[]
      if (command === 'GET') return Response.json({ result: data.get(String(args[0])) ?? null })
      const [, , key, expected, payload] = args
      const current = data.has(String(key)) ? (JSON.parse(data.get(String(key))!) as { revision: number }).revision : 0
      if (current !== Number(expected)) return Response.json({ result: -1 })
      data.set(String(key), JSON.stringify({ revision: current + 1, payload }))
      return Response.json({ result: current + 1 })
    },
  })

  assert.deepEqual(await store.load('k'), { revision: 0, payload: undefined })
  assert.equal(await store.compareAndSwap('k', { revision: 0, payload: 'a' }), 1)
  assert.equal(await store.compareAndSwap('k', { revision: 0, payload: 'b' }), undefined)
  assert.deepEqual(await store.load('k'), { revision: 1, payload: 'a' })
})
