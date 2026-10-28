import * as Relay from './Relay.ts'

const secret = process.env.RELAY_SECRET
if (!secret) throw new Error('set RELAY_SECRET to the secret the egress sends')

const port = Number(process.env.PORT ?? 8080)
Relay.create({ secret }).listen(port, () => console.log(`nanocode-egress relay on :${port}`))
