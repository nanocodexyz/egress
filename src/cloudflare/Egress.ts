/**
 * The plan egress of a nanocode-ts Cloudflare deployment: a private binding for `App.create({ egress })`, the
 * `subscription` switch, and the sign-in routes, over a `PlanVault` per account.
 *
 * @module
 */
import * as Core from '../Egress.ts'
import type * as Plans from '../Plans.ts'
import * as Routes from '../Routes.ts'

/** Private binding that nanocode-ts sessions send model requests to, such as `Gateway.create`'s. */
export type PrivateBinding = { fetch(request: Request): Promise<Response> }

/** Model request that nanocode-ts sends to `/model` in the `x-nanocode-model` header. */
type ModelDispatch = {
  provider?: Plans.Provider
  authority: { account_id: string }
  endpoint: string
  headers: [string, string][]
  subscription: boolean
}

/** Socket request that nanocode-ts sends to `/socket` in the `x-nanocode-socket` header. */
type SocketDispatch = {
  provider?: Plans.Provider
  authority: { account_id: string }
  headers: [string, string][]
}

/**
 * Relay that ChatGPT-plan requests leave through: chatgpt.com's edge answers HTTP 403 to every request that carries
 * the `cf-worker` header, which Workers adds to each subrequest, while it serves the same request from Node.
 * Claude plans need none.
 */
export type Relay = { fetch(request: Request): Promise<Response> }

/** Returns the relay at `options.url`, a `nanocode-egress/relay` server, reached with `options.secret` through `options.fetcher`, such as a Container's. */
export function relay(options: relay.Options): Relay {
  const base = new URL(options.url)
  return {
    fetch(request) {
      const source = new URL(request.url)
      const target = new URL(source.pathname + source.search, base)
      const forwarded = new Request(target, request)
      forwarded.headers.set('x-nanocode-relay-secret', options.secret)
      return options.fetcher ? options.fetcher.fetch(forwarded) : fetch(forwarded)
    },
  }
}

export declare namespace relay {
  type Options = {
    /** Base URL of the relay, such as `https://relay.example`, or any URL when `fetcher` routes it, as a Container's does. */
    url: string
    /** Secret the relay was started with. */
    secret: string
    /** Fetcher that reaches the relay, such as a Container stub. Defaults to the global `fetch`. */
    fetcher?: { fetch(request: Request): Promise<Response> } | undefined
  }
}

/** Durable Object namespace of `PlanVault`s, as Workers binds it. */
export type Namespace = { idFromName(name: string): unknown; get(id: never): unknown }

/** Returns the plans of `account`: the `PlanVault` of `namespace(env)` named after it. */
export function durable<E>(namespace: (env: E) => Namespace): (env: E, account: string) => Plans.Account {
  return (env, account) => {
    const vaults = namespace(env)
    return vaults.get(vaults.idFromName(account) as never) as Plans.Account
  }
}

/** Returns the `egress` of `App.create`: plan requests get the account's credential, and the rest go to `options.fallback`. */
export function binding<E>(options: binding.Options<E>): (env: E) => PrivateBinding {
  return (env) => {
    const fallback = options.fallback?.(env)
    const relayed = options.relay?.(env)
    const codexFetch = relayed
      ? (input: string, init: RequestInit) => relayed.fetch(new Request(input, init))
      : undefined
    const forward = (request: Request): Promise<Response> =>
      fallback
        ? fallback.fetch(request)
        : Promise.resolve(failure('claude', 409, 'this deployment serves model requests on plans only'))

    return {
      async fetch(request) {
        const { pathname } = new URL(request.url)
        if (pathname === '/model' && request.method === 'POST') {
          const dispatch = header<ModelDispatch>(request, 'x-nanocode-model')
          if (!dispatch) return failure('claude', 400, 'invalid model dispatch')
          if (!dispatch.subscription) return forward(request)

          const provider = dispatch.provider ?? 'claude'
          if (provider === 'codex' && !relayed) return failure('codex', 503, unrelayed)
          try {
            return await Core.send(
              options.plans(env, dispatch.authority.account_id),
              {
                provider,
                endpoint: dispatch.endpoint,
                headers: dispatch.headers,
                body: new Uint8Array(await request.arrayBuffer()),
              },
              { signal: request.signal, ...(provider === 'codex' && codexFetch ? { fetch: codexFetch } : {}) },
            )
          } catch (error) {
            return planFailure(provider, error)
          }
        }
        if (pathname === '/socket') {
          const dispatch = header<SocketDispatch>(request, 'x-nanocode-socket')
          if (!dispatch) return failure('codex', 400, 'invalid socket dispatch')
          if ((dispatch.provider ?? 'codex') !== 'codex') return forward(request)
          if (!relayed) return failure('codex', 503, unrelayed)
          try {
            return await socket(options.plans(env, dispatch.authority.account_id), dispatch.headers, relayed)
          } catch (error) {
            return planFailure('codex', error)
          }
        }
        if (pathname === '/metrics' && !fallback) return Response.json({ ok: true, egress: 'plans' })
        if (pathname === '/warm' && !fallback) return new Response(null, { status: 204 })
        return forward(request)
      },
    }
  }
}

export declare namespace binding {
  type Options<E> = {
    /** Returns the plans of an account, such as `durable(env => env.PLANS)`. */
    plans(env: E, account: string): Plans.Account
    /** Returns the binding of requests that use no plan, such as the AI Gateway's. */
    fallback?(env: E): PrivateBinding
    /**
     * Returns the relay of ChatGPT-plan requests and sockets: the `RelayContainer`'s (`relay` from
     * `nanocode-egress/cloudflare/container`) or a relay elsewhere (`relay({ url, secret })`). Without one, ChatGPT-plan
     * requests fail with a message that names this setup. Claude plans go direct.
     */
    relay?(env: E): Relay | undefined
  }
}

/** Returns the `subscription` of `App.create`: an account's requests to `provider` use its plan while it is signed in. */
export function subscription<E>(
  options: Pick<binding.Options<E>, 'plans'>,
): (account: string, env: E, provider: Plans.Provider) => Promise<boolean> {
  return async (account, env, provider) => {
    try {
      return await options.plans(env, account).signedIn(provider)
    } catch {
      return false
    }
  }
}

/** Returns a handler of the plan sign-in routes, or `undefined` for other requests. */
export function routes<E>(options: routes.Options<E>): (request: Request, env: E) => Promise<Response | undefined> {
  return (request, env) =>
    Routes.handle(request, {
      prefix: options.prefix,
      account: async (signed) => {
        const name = await options.account(signed, env)
        return name ? options.plans(env, name) : undefined
      },
    })
}

export declare namespace routes {
  type Options<E> = Pick<binding.Options<E>, 'plans'> & {
    /** Returns the account that signed `request`, the same one sessions run as, or `null` to refuse it. */
    account(request: Request, env: E): string | null | undefined | Promise<string | null | undefined>
    /** Path prefix of the routes. Defaults to `/plans`. */
    prefix?: string | undefined
  }
}

const unrelayed =
  'ChatGPT plans on Cloudflare need the relay container, because chatgpt.com refuses requests from Workers: export RelayContainer from nanocode-egress/cloudflare/container, list it under containers and durable_objects in wrangler.jsonc, and pass relay to Egress.binding'

async function socket(account: Plans.Account, incoming: [string, string][], relayed: Relay): Promise<Response> {
  const open = async () => {
    const target = await Core.socket(account, incoming)
    target.headers.set('upgrade', 'websocket')
    return { response: await relayed.fetch(new Request(target.url, { headers: target.headers })), generation: target.generation }
  }
  const first = await open()
  if (first.response.status !== 401) return first.response

  await account.rejected('codex', { generation: first.generation })
  return (await open()).response
}

function header<T>(request: Request, name: string): T | undefined {
  try {
    return JSON.parse(request.headers.get(name) ?? '') as T
  } catch {
    return undefined
  }
}

function planFailure(provider: Plans.Provider, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Core.DestinationError) return failure(provider, 403, message)
  const signedOut = /not signed in|not authenticated|sign in again|login|on hold|no sign-in/i.test(message)
  return failure(provider, signedOut ? 401 : 502, signedOut ? `sign in to your ${provider === 'codex' ? 'ChatGPT' : 'Claude'} plan: ${message}` : message)
}

function failure(provider: Plans.Provider, status: number, message: string): Response {
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'api_error'
  return Response.json(
    provider === 'claude' ? { type: 'error', error: { type, message } } : { error: { type, message } },
    { status },
  )
}
