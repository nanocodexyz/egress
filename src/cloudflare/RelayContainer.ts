/**
 * Cloudflare Container that runs the `nanocode-egress/relay` server, so a Worker's ChatGPT-plan requests leave from a
 * container instead of the Workers runtime, whose `cf-worker` header chatgpt.com answers with HTTP 403.
 *
 * @module
 */
import { Container, getContainer } from '@cloudflare/containers'
import * as Egress from './Egress.ts'

/** Environment a `RelayContainer` reads: the `PLAN_SECRET` its relay's secret is derived from. */
export type Env = { PLAN_SECRET: string }

/**
 * Container of the relay image, `relay.Dockerfile` in this package, which a Worker builds with
 * `"image": "./node_modules/nanocode-egress/relay.Dockerfile"`. It listens on 8080 and admits requests that carry
 * the secret derived from `PLAN_SECRET`, so a deployment configures no secret of its own for it. It sleeps 10 minutes
 * after its last request; a subclass can change `sleepAfter`.
 */
export class RelayContainer<E extends Env = Env> extends Container<E> {
  override defaultPort = 8080
  override sleepAfter: string | number = '10m'
  #secret: Promise<string> | undefined

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.PLAN_SECRET) return Response.json({ error: 'set PLAN_SECRET for the relay container' }, { status: 500 })
    this.#secret ??= secret(this.env.PLAN_SECRET)
    this.envVars = { RELAY_SECRET: await this.#secret, PORT: '8080' }
    return super.fetch(request)
  }
}

/**
 * Returns the relay of `Egress.binding`'s `relay` option: the `RelayContainer` of `namespace` named `options.name`,
 * reached with the secret derived from `options.secret`, the Worker's `PLAN_SECRET`.
 */
export function relay(namespace: DurableObjectNamespace<RelayContainer<any>>, options: relay.Options): Egress.Relay {
  let derived: Promise<string> | undefined
  return {
    async fetch(request) {
      derived ??= secret(options.secret)
      const source = new URL(request.url)
      const forwarded = new Request(new URL(source.pathname + source.search, 'http://relay.internal'), request)
      forwarded.headers.set('x-nanocode-relay-secret', await derived)
      try {
        return await getContainer(namespace, options.name).fetch(forwarded)
      } catch (error) {
        throw new Error(
          `the relay container did not answer (${error instanceof Error ? error.message : String(error)}); check that wrangler.jsonc lists RelayContainer under containers and durable_objects and that wrangler deploy built its image`,
        )
      }
    },
  }
}

export declare namespace relay {
  type Options = {
    /** The Worker's `PLAN_SECRET`, which the container reads too. */
    secret: string
    /** Name of the container instance. Defaults to one instance for the whole deployment. */
    name?: string | undefined
  }
}

/** Returns the relay secret derived from `planSecret` with HKDF-SHA-256, apart from the vault's key. */
export async function secret(planSecret: string): Promise<string> {
  if (planSecret.length < 32) throw new Error('PLAN_SECRET needs at least 32 characters')
  const encoder = new TextEncoder()
  const material = await crypto.subtle.importKey('raw', encoder.encode(planSecret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('nanocode-egress'), info: encoder.encode('relay secret v1') },
    material,
    256,
  )
  return btoa(String.fromCharCode(...new Uint8Array(bits))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
