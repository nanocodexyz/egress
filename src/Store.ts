/**
 * Linearizable record store that plan sign-ins live in: one JSON payload per key, replaced by compare-and-swap.
 *
 * @module
 */

/** Stored record of one key. A key that was never written has revision 0 and no payload. */
export type Record = {
  /** Revision of the payload, which every successful swap increments. */
  revision: number
  /** Stored payload, or `undefined` when the key holds none. */
  payload: string | undefined
}

/** Record store with per-key compare-and-swap. */
export type Store = {
  /** Returns the record of `key`. */
  load(key: string): Promise<Record>
  /** Replaces the payload of `key` when its revision is `options.revision`, and returns the new revision, or `undefined` on a conflict. */
  compareAndSwap(key: string, options: compareAndSwap.Options): Promise<number | undefined>
}

export declare namespace compareAndSwap {
  type Options = {
    /** Revision the caller read. */
    revision: number
    /** Payload to store. */
    payload: string
  }
}

/** Returns a store that keeps records in memory, for tests and single-process development. */
export function memory(): Store {
  const records = new Map<string, Record>()

  return {
    async load(key) {
      return records.get(key) ?? { revision: 0, payload: undefined }
    },
    async compareAndSwap(key, options) {
      const current = records.get(key)?.revision ?? 0
      if (current !== options.revision) return undefined

      records.set(key, { revision: current + 1, payload: options.payload })
      return current + 1
    },
  }
}
