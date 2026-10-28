/**
 * Durable Object that owns one account's plan sign-ins in its SQLite storage, sealed with `PLAN_SECRET`.
 *
 * @module
 */
import { DurableObject } from 'cloudflare:workers'
import * as Plans from '../Plans.ts'
import type * as Store from '../Store.ts'
import * as Vault from '../Vault.ts'

/** Bindings that a plan vault reads. */
export type Env = {
  /** Secret of at least 32 characters that seals stored credentials. */
  PLAN_SECRET: string
}

/** Plans of the account this object is named after; its methods are the `Plans.Account` contract over RPC. */
export class PlanVault<E extends Env = Env> extends DurableObject<E> implements Plans.Account {
  private opened: Promise<Plans.Account> | undefined

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS plan_records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)',
    )
  }

  private plans(): Promise<Plans.Account> {
    this.opened ??= (async () => {
      const sql = this.ctx.storage.sql
      const store: Store.Store = {
        async load(key) {
          const row = sql.exec<{ revision: number; payload: string }>(
            'SELECT revision, payload FROM plan_records WHERE key = ?',
            key,
          ).toArray()[0]
          return row ? { revision: row.revision, payload: row.payload } : { revision: 0, payload: undefined }
        },
        async compareAndSwap(key, options) {
          const row = sql.exec<{ revision: number }>('SELECT revision FROM plan_records WHERE key = ?', key).toArray()[0]
          if ((row?.revision ?? 0) !== options.revision) return undefined
          sql.exec(
            'INSERT INTO plan_records (key, revision, payload) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET revision = excluded.revision, payload = excluded.payload',
            key,
            options.revision + 1,
            options.payload,
          )
          return options.revision + 1
        },
      }
      return Plans.account(Vault.sealed(store, await Vault.create(this.env.PLAN_SECRET)), { account: 'owner' })
    })()
    return this.opened
  }

  async status(): Promise<Plans.Status> {
    return (await this.plans()).status()
  }

  async signedIn(provider: Plans.Provider): Promise<boolean> {
    return (await this.plans()).signedIn(provider)
  }

  async signIn(options: Plans.signIn.Options): Promise<Plans.SignIn> {
    return (await this.plans()).signIn(options)
  }

  async complete(options: Plans.complete.Options) {
    return (await this.plans()).complete(options)
  }

  async signOut(options: Plans.signOut.Options): Promise<void> {
    return (await this.plans()).signOut(options)
  }

  async inject(provider: Plans.Provider): Promise<Plans.Injection> {
    return (await this.plans()).inject(provider)
  }

  async rejected(provider: Plans.Provider, options: Plans.rejected.Options): Promise<void> {
    return (await this.plans()).rejected(provider, options)
  }
}
