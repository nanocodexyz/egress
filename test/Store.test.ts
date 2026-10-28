import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Store from '../src/Store.ts'
import * as Vault from '../src/Vault.ts'

test('memory store swaps only from the revision the caller read', async () => {
  const store = Store.memory()
  assert.deepEqual(await store.load('a'), { revision: 0, payload: undefined })

  assert.equal(await store.compareAndSwap('a', { revision: 0, payload: 'one' }), 1)
  assert.equal(await store.compareAndSwap('a', { revision: 0, payload: 'stale' }), undefined)
  assert.equal(await store.compareAndSwap('a', { revision: 1, payload: 'two' }), 2)
  assert.deepEqual(await store.load('a'), { revision: 2, payload: 'two' })
})

test('vault seals payloads bound to their key', async () => {
  const vault = await Vault.create('x'.repeat(32))
  const envelope = await vault.seal('secret token', { context: 'plans:alice:codex' })

  assert.match(envelope, /^v1\.[\w-]+\.[\w-]+$/)
  assert.ok(!envelope.includes('secret'))
  assert.equal(await vault.open(envelope, { context: 'plans:alice:codex' }), 'secret token')
  await assert.rejects(vault.open(envelope, { context: 'plans:bob:codex' }), Vault.InvalidEnvelopeError)
  await assert.rejects((await Vault.create('y'.repeat(32))).open(envelope, { context: 'plans:alice:codex' }), Vault.InvalidEnvelopeError)
  await assert.rejects(Vault.create('short'), /32 characters/)
})

test('sealed store keeps only envelopes in the underlying store', async () => {
  const raw = Store.memory()
  const sealed = Vault.sealed(raw, await Vault.create('k'.repeat(40)))

  assert.equal(await sealed.compareAndSwap('key', { revision: 0, payload: '{"token":"abc"}' }), 1)
  assert.match((await raw.load('key')).payload ?? '', /^v1\./)
  assert.deepEqual(await sealed.load('key'), { revision: 1, payload: '{"token":"abc"}' })
})
