/**
 * HTTP routes of plan sign-in for a signed-in account, which both adapters serve.
 *
 * `GET {prefix}` returns both plans' status, `POST {prefix}/{claude|codex}/sign-in` starts a sign-in,
 * `POST {prefix}/claude/complete` finishes Claude's with `{ code }`, and `DELETE {prefix}/{claude|codex}` signs out.
 *
 * @module
 */
import type * as Plans from './Plans.ts'

/** Returns the response of a plan route, or `undefined` when `request` is not one. */
export async function handle(request: Request, options: handle.Options): Promise<Response | undefined> {
  const prefix = (options.prefix ?? '/plans').replace(/\/+$/, '')
  const path = new URL(request.url).pathname
  if (path !== prefix && !path.startsWith(prefix + '/')) return undefined

  const parts = path.slice(prefix.length).split('/').filter(Boolean)
  const provider = parts[0] === 'claude' || parts[0] === 'codex' ? parts[0] : undefined

  const run = async (operation: (account: Plans.Account) => Promise<unknown>): Promise<Response> => {
    const account = await options.account(request)
    if (!account) return Response.json({ error: 'sign in to the deployment first' }, { status: 401 })
    try {
      return Response.json((await operation(account)) ?? { ok: true }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const name = error instanceof Error ? error.name : ''
      const status = /LoginRequired|NotAuthenticated|AccountOnHold/.test(name) ? 409 : /Invalid/.test(name) ? 400 : 502
      return Response.json({ error: message, kind: name || undefined }, { status })
    }
  }

  if (parts.length === 0 && request.method === 'GET') return run((account) => account.status())
  if (provider && parts.length === 2 && parts[1] === 'sign-in' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { redirect?: unknown }
    const redirect = typeof body.redirect === 'string' ? body.redirect : undefined
    return run((account) => account.signIn({ provider, redirect }))
  }
  if (provider === 'claude' && parts.length === 2 && parts[1] === 'complete' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { code?: unknown }
    if (typeof body.code !== 'string') return Response.json({ error: 'complete takes { code }' }, { status: 400 })
    const code = body.code
    return run((account) => account.complete({ code }))
  }
  if (provider && parts.length === 1 && request.method === 'DELETE')
    return run((account) => account.signOut({ provider }))
  return Response.json({ error: 'plan route not found' }, { status: 404 })
}

export declare namespace handle {
  type Options = {
    /** Returns the plans of the account that signed `request`, or `undefined` to refuse it. */
    account(request: Request): Plans.Account | undefined | Promise<Plans.Account | undefined>
    /** Path prefix of the routes. Defaults to `/plans`. */
    prefix?: string | undefined
  }
}
