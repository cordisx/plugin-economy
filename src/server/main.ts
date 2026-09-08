import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Economy } from './economy.js'
import { createEconomyServer } from './http.js'
process.umask(0o077)
const path = resolve(process.env.ECONOMY_DB ?? './data/economy.sqlite')
mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
const economy = new Economy(path)
chmodSync(path, 0o600)
economy.agreements.sweep()
const server = createEconomyServer(economy, {
  allowedOrigins: (process.env.ECONOMY_ORIGINS ?? '').split(',').filter(Boolean),
})
const sweep = setInterval(() => {
  try {
    economy.agreements.sweep()
  } catch {
    console.error('Expiration sweep failed; retrying next interval')
  }
}, 1000)
sweep.unref()
server.listen(
  Number(process.env.PORT ?? 8788),
  process.env.HOST ?? '127.0.0.1',
  () => console.info('Economy API ready at /v1'),
)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(sweep)
    server.close(() => {
      economy.close()
    })
  })
}
