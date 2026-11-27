/**
 * The Antigravity, ChatGPT and Claude plans of one account: their sign-ins, and the credentials the egress injects.
 *
 * @module
 */
import * as Antigravity from './Antigravity.ts'
import * as ChatGpt from './ChatGpt.ts'
import * as Claude from './Claude.ts'
import type * as Http from './internal/Http.ts'
import type * as Store from './Store.ts'

/** Model provider whose plan a request uses: `antigravity`, `claude`, or `codex` for ChatGPT. */
export type Provider = 'antigravity' | 'claude' | 'codex'

/** Sign-in states of the plans. */
export type Status = { antigravity: Antigravity.Status; claude: Claude.Status; codex: ChatGpt.Status }

/** Started sign-in: Antigravity's or Claude's page to open, or ChatGPT's code to enter at its page. */
export type SignIn =
  | { provider: 'antigravity'; authorization_url: string; expires_at: number }
  | { provider: 'claude'; authorization_url: string; expires_at: number }
  | { provider: 'codex'; status: ChatGpt.Status }

/** Credential headers of one request, and the generation that a rejection names. */
export type Injection = {
  headers: Record<string, string>
  generation: string
  expires_at?: number | undefined
  project?: string | undefined
}

/** Plans of one account. A Durable Object stub that forwards these methods serves the same contract. */
export type Account = {
  /** Returns the sign-in states of both plans, polling a pending ChatGPT sign-in. */
  status(): Promise<Status>
  /** Returns whether the plan of `provider` is signed in. */
  signedIn(provider: Provider): Promise<boolean>
  /** Starts a sign-in. */
  signIn(options: signIn.Options): Promise<SignIn>
  /** Finishes a Claude or Antigravity sign-in with the pasted code or callback URL. */
  complete(options: complete.Options): Promise<Antigravity.Status | Claude.Status>
  /** Forgets a plan's sign-in. */
  signOut(options: signOut.Options): Promise<void>
  /** Returns the credential headers of a request to `provider`. */
  inject(provider: Provider): Promise<Injection>
  /** Reports that `provider` rejected the credential of `generation`, so the next `inject` refreshes it. */
  rejected(provider: Provider, options: rejected.Options): Promise<void>
}

export declare namespace signIn {
  type Options = {
    provider: Provider
    /** Claude callback URL of a host that receives the redirect itself. */
    redirect?: string | undefined
  }
}

export declare namespace complete {
  type Options = {
    /** The `code#state` the Claude page shows, or the full callback URL. */
    code: string
    provider?: 'antigravity' | 'claude' | undefined
  }
}

export declare namespace signOut {
  type Options = { provider: Provider }
}

export declare namespace rejected {
  type Options = { generation: string }
}

/** Error of an account name that is empty, too long or holds control characters. */
export class InvalidAccountError extends Error {
  override name = 'Plans.InvalidAccountError'
}

/** Returns the plans of `options.account` in `store`, under the keys `<prefix><account>:antigravity`, `:claude` and `:codex`. */
export function account(store: Store.Store, options: account.Options): Account {
  const name = options.account
  if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name))
    throw new InvalidAccountError('an account name needs 1 to 256 characters without control characters')

  const prefix = (options.prefix ?? 'plans:') + name
  const antigravity = Antigravity.create(store, {
    key: prefix + ':antigravity',
    ...(options.antigravity ? { client: options.antigravity } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const chatgpt = ChatGpt.create(store, {
    key: prefix + ':codex',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.issuer ? { issuer: options.issuer } : {}),
  })
  const claude = Claude.create(store, {
    key: prefix + ':claude',
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.config ? { config: options.config } : {}),
  })

  return {
    async status() {
      const [antigravityStatus, claudeStatus, codexStatus] = await Promise.all([
        antigravity.status(),
        claude.status(),
        chatgpt.status(),
      ])
      return { antigravity: antigravityStatus, claude: claudeStatus, codex: codexStatus }
    },
    async signedIn(provider) {
      const plan = provider === 'antigravity' ? antigravity : provider === 'claude' ? claude : chatgpt
      return (await plan.status()).state === 'authenticated'
    },
    async signIn(signInOptions) {
      if (signInOptions.provider === 'antigravity') return { provider: 'antigravity', ...(await antigravity.start()) }
      if (signInOptions.provider === 'codex') return { provider: 'codex', status: await chatgpt.start() }
      const login = await claude.start({ redirect: signInOptions.redirect })
      return { provider: 'claude', ...login }
    },
    complete(completeOptions) {
      return completeOptions.provider === 'antigravity'
        ? antigravity.complete(completeOptions.code)
        : claude.complete(completeOptions.code)
    },
    signOut(signOutOptions) {
      if (signOutOptions.provider === 'antigravity') return antigravity.signOut()
      return signOutOptions.provider === 'claude' ? claude.signOut() : chatgpt.signOut()
    },
    async inject(provider) {
      if (provider === 'antigravity') {
        const credential = await antigravity.credential()
        return {
          headers: { authorization: `Bearer ${credential.access_token}`, 'user-agent': Antigravity.userAgent },
          generation: String(credential.generation),
          expires_at: credential.expires_at,
          project: credential.project,
        }
      }
      if (provider === 'claude') {
        const authorization = await claude.authorization()
        return { headers: authorization.headers, generation: authorization.headers.authorization }
      }
      const credential = await chatgpt.credential()
      return {
        headers: {
          authorization: `Bearer ${credential.access_token}`,
          'chatgpt-account-id': credential.account_id,
          ...(credential.fedramp ? { 'x-openai-fedramp': 'true' } : {}),
        },
        generation: String(credential.generation),
      }
    },
    async rejected(provider, rejectedOptions) {
      if (provider === 'antigravity') return antigravity.reject(Number(rejectedOptions.generation))
      if (provider === 'claude') return claude.reject(rejectedOptions.generation)
      await chatgpt.recover(Number(rejectedOptions.generation))
    },
  }
}

export declare namespace account {
  type Options = {
    /** Name of the account, such as a signed-in user's ID. */
    account: string
    antigravity?: Antigravity.Client | undefined
    /** Key prefix of the account's records. Defaults to `plans:`. */
    prefix?: string | undefined
    /** `fetch` of the OAuth requests. */
    fetch?: Http.Fetch | undefined
    /** Claude OAuth configuration. Defaults to `Claude.config`. */
    config?: Claude.Config | undefined
    /** ChatGPT OAuth issuer, for tests. */
    issuer?: string | undefined
  }
}
