/**
 * Encryption of stored plan credentials with AES-256-GCM, under a key derived from a deployment secret.
 *
 * @module
 */
import * as Http from './internal/Http.ts'
import type * as Store from './Store.ts'

/** Seals and opens payloads bound to a context string. */
export type Vault = {
  /** Encrypts `plaintext` bound to `options.context`. */
  seal(plaintext: string, options: seal.Options): Promise<string>
  /** Decrypts an envelope that `seal` made with the same context. */
  open(envelope: string, options: seal.Options): Promise<string>
}

export declare namespace seal {
  type Options = {
    /** Context the envelope is bound to, such as the store key. */
    context: string
  }
}

/** Error of an envelope that does not open with this vault's key and context. */
export class InvalidEnvelopeError extends Error {
  override name = 'Vault.InvalidEnvelopeError'
}

const version = 'v1'

const encoder = new TextEncoder()

const decoder = new TextDecoder()

/** Returns a vault whose key is derived from `secret` with HKDF-SHA-256. The secret needs at least 32 characters. */
export async function create(secret: string): Promise<Vault> {
  if (secret.length < 32) throw new Error('the vault secret needs at least 32 characters')

  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ])
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('nanocode-egress'),
      info: encoder.encode('plan credentials v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  return {
    async seal(plaintext, options) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(options.context) },
        key,
        encoder.encode(plaintext),
      )
      return [version, Http.base64url(iv), Http.base64url(new Uint8Array(sealed))].join('.')
    },
    async open(envelope, options) {
      const [tag, iv, body] = envelope.split('.')
      if (tag !== version || !iv || !body)
        throw new InvalidEnvelopeError('the envelope is not a v1 vault envelope')

      try {
        const opened = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: Http.unbase64url(iv), additionalData: encoder.encode(options.context) },
          key,
          Http.unbase64url(body),
        )
        return decoder.decode(opened)
      } catch {
        throw new InvalidEnvelopeError('the envelope does not open with this key and context')
      }
    },
  }
}

/** Returns `store` with every payload sealed by `vault`, bound to its key. */
export function sealed(store: Store.Store, vault: Vault): Store.Store {
  return {
    async load(key) {
      const record = await store.load(key)
      if (record.payload === undefined) return record
      return { revision: record.revision, payload: await vault.open(record.payload, { context: key }) }
    },
    async compareAndSwap(key, options) {
      return store.compareAndSwap(key, {
        revision: options.revision,
        payload: await vault.seal(options.payload, { context: key }),
      })
    },
  }
}
