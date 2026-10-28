/**
 * Cloudflare Container that runs the `nanocode-egress/relay` server, so a Worker's ChatGPT-plan requests leave from a
 * container instead of the Workers runtime, whose `cf-worker` header chatgpt.com answers with HTTP 403.
 *
 * @module
 */
import { Container, getContainer } from '@cloudflare/containers'
import * as Egress from './Egress.ts'

/** Environment a `RelayContainer` reads: the secret its relay requires of the Worker. */
export type Env = { RELAY_SECRET: string }

/**
 * Container of the relay image (`relay.Dockerfile` at this package's root), which listens on 8080 and admits
 * requests that carry the Worker's `RELAY_SECRET`. It sleeps 10 minutes after its last request; a subclass can
 * change `sleepAfter`.
 */
export class RelayContainer<E extends Env = Env> extends Container<E> {
  override defaultPort = 8080
  override sleepAfter: string | number = '10m'

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx as never, env)
    this.envVars = { RELAY_SECRET: env.RELAY_SECRET, PORT: '8080' }
  }
}

/**
 * Returns the relay of `Egress.binding`'s `relay` option: the `RelayContainer` of `namespace` named `options.name`,
 * reached with `options.secret`, the same `RELAY_SECRET` the container reads.
 */
export function relay(namespace: DurableObjectNamespace<RelayContainer<any>>, options: relay.Options): Egress.Relay {
  return Egress.relay({ url: 'http://relay.internal', secret: options.secret, fetcher: getContainer(namespace, options.name) })
}

export declare namespace relay {
  type Options = {
    /** Secret the container's relay requires, its `RELAY_SECRET`. */
    secret: string
    /** Name of the container instance. Defaults to one instance for the whole deployment. */
    name?: string | undefined
  }
}
