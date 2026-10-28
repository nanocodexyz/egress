/**
 * Record store over Upstash Redis's REST API, such as a Vercel Marketplace Redis database, with compare-and-swap in Lua.
 *
 * @module
 */
import type * as Http from '../internal/Http.ts'
import type * as Store from '../Store.ts'

const swap = `local value = redis.call('GET', KEYS[1])
local revision = 0
if value then revision = tonumber(cjson.decode(value).revision) end
if revision ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], cjson.encode({ revision = revision + 1, payload = ARGV[2] }))
return revision + 1`

/** Returns a store over the Upstash Redis REST API at `options.url`. Defaults to `KV_REST_API_URL` and `KV_REST_API_TOKEN`. */
export function store(options: store.Options = {}): Store.Store {
  const url = options.url ?? process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = options.token ?? process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token)
    throw new Error('set KV_REST_API_URL and KV_REST_API_TOKEN, or pass url and token, for the plan store')
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init))

  const command = async (args: (string | number)[]): Promise<unknown> => {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string }
    if (!response.ok || body.error) throw new Error(`Redis answered ${response.status}: ${body.error ?? 'no result'}`)
    return body.result
  }

  return {
    async load(key) {
      const value = await command(['GET', key])
      if (typeof value !== 'string') return { revision: 0, payload: undefined }
      const record = JSON.parse(value) as { revision: number; payload: string }
      return { revision: record.revision, payload: record.payload }
    },
    async compareAndSwap(key, swapOptions) {
      const next = Number(await command(['EVAL', swap, 1, key, swapOptions.revision, swapOptions.payload]))
      return next > 0 ? next : undefined
    },
  }
}

export declare namespace store {
  type Options = {
    /** REST URL of the database. */
    url?: string | undefined
    /** REST token of the database. */
    token?: string | undefined
    /** `fetch` of the REST calls. */
    fetch?: Http.Fetch | undefined
  }
}
