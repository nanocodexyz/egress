/**
 * The plan egress of a nanocode-ts Vercel deployment: the `subscription` of `App.create` and the sign-in routes,
 * over a record store such as `Redis.store()`.
 *
 * @module
 */
import * as Core from '../Egress.ts'
import * as Plans from '../Plans.ts'
import * as Routes from '../Routes.ts'
import type * as Store from '../Store.ts'
import * as Vault from '../Vault.ts'

/** WebSocket of a plan's Codex session, in the shape nanocode-ts sockets take. */
export type MessageSocket = {
  send(message: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: any) => void): void
}

/** Plan of one session: its model dispatch and, for Codex, its WebSocket. nanocode-ts's `Harness.Subscription`. */
export type Subscription = {
  dispatch(
    request: { endpoint: string; method: string; headers: [string, string][]; body: Uint8Array },
    signal: AbortSignal,
  ): Promise<Response>
  socket?:
    | {
        open(
          request: { provider: Plans.Provider; headers: [string, string][] },
          signal: AbortSignal,
        ): Promise<{ status: number; headers: Iterable<[string, string]>; socket?: MessageSocket; text(): Promise<string> }>
        admit(): Promise<void>
      }
    | undefined
}

/** Returns the plans of each account in `options.store`, sealed with `options.secret`. Defaults to `PLAN_SECRET`. */
export function plans(options: plans.Options): (account: string) => Plans.Account {
  const secret = options.secret ?? process.env.PLAN_SECRET
  if (!secret) throw new Error('set PLAN_SECRET, or pass secret, to seal plan credentials')
  let vault: Promise<Vault.Vault> | undefined

  const store: Store.Store = {
    async load(key) {
      vault ??= Vault.create(secret)
      return Vault.sealed(options.store, await vault).load(key)
    },
    async compareAndSwap(key, swap) {
      vault ??= Vault.create(secret)
      return Vault.sealed(options.store, await vault).compareAndSwap(key, swap)
    },
  }
  return (account) => Plans.account(store, { account })
}

export declare namespace plans {
  type Options = {
    /** Store of the plan records, such as `Redis.store()`. */
    store: Store.Store
    /** Secret of at least 32 characters that seals stored credentials. Defaults to `PLAN_SECRET`. */
    secret?: string | undefined
  }
}

/** Returns the `subscription` of `App.create`: a session's plan while its account is signed in, else `undefined`. */
export function subscription(
  accounts: (account: string) => Plans.Account,
): (session: { account: string; provider: Plans.Provider }) => Promise<Subscription | undefined> {
  return async (session) => {
    const account = accounts(session.account)
    if (!(await account.signedIn(session.provider).catch(() => false))) return undefined

    return {
      dispatch: (request, signal) =>
        Core.send(account, { provider: session.provider, ...request }, { signal }).catch((error: unknown) =>
          Response.json({ error: { type: 'api_error', message: error instanceof Error ? error.message : String(error) } }, { status: 502 }),
        ),
      ...(session.provider === 'codex'
        ? { socket: { open: (request, signal) => socket(account, request.headers, signal), admit: async () => {} } }
        : {}),
    }
  }
}

/** Returns a route handler of the plan sign-in routes, or `undefined` for other requests. */
export function routes(options: routes.Options): (request: Request) => Promise<Response | undefined> {
  return (request) =>
    Routes.handle(request, {
      prefix: options.prefix,
      account: async (signed) => {
        const name = await options.account(signed)
        return name ? options.plans(name) : undefined
      },
    })
}

export declare namespace routes {
  type Options = {
    /** Plans of each account, from `plans`. */
    plans(account: string): Plans.Account
    /** Returns the account that signed `request`, the same one `App.create`'s `account` gives its sessions, or `null` to refuse it. */
    account(request: Request): string | null | undefined | Promise<string | null | undefined>
    /** Path prefix of the routes. Defaults to `/plans`. */
    prefix?: string | undefined
  }
}

async function socket(account: Plans.Account, incoming: [string, string][], signal: AbortSignal) {
  const { WebSocket } = await import('undici')
  const open = async () => {
    const target = await Core.socket(account, incoming)
    const socket = new WebSocket(target.url, { headers: Object.fromEntries(target.headers) })
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true), { once: true })
      socket.addEventListener('error', () => resolve(false), { once: true })
      signal.addEventListener('abort', () => resolve(false), { once: true })
    })
    return { socket, opened, generation: target.generation }
  }

  let attempt = await open()
  if (!attempt.opened && !signal.aborted) {
    await account.rejected('codex', { generation: attempt.generation })
    attempt = await open()
  }
  if (!attempt.opened) {
    attempt.socket.close()
    return { status: 502, headers: [], text: async () => 'the ChatGPT plan refused the Codex WebSocket' }
  }
  return { status: 101, headers: [], socket: attempt.socket as unknown as MessageSocket, text: async () => '' }
}
