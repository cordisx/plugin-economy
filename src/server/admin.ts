import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Economy } from './economy.js'
process.umask(0o077)
const path = resolve(process.env.ECONOMY_DB ?? './data/economy.sqlite')
mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
const economy = new Economy(path)
chmodSync(path, 0o600)
const [command, instance, ...args] = process.argv.slice(2)
try {
  switch (command) {
    case 'instance':
      economy.auth.createInstance(instance, Number(args[0]))
      break
    case 'account':
      economy.auth.createAccount(instance, args[0])
      break
    case 'login-code':
      console.log(economy.auth.enrollment(instance, args[0]))
      break
    case 'service':
      console.log(JSON.stringify(economy.auth.createService(instance, args[0], args[1], Number(args[2]))))
      break
    case 'source':
      economy.commerce.createSource(
        instance,
        args[0],
        args[1],
        args[2] as 'reward' | 'migration',
        Number(args[3]),
        Number(args[4]),
        Number(args[5]),
      )
      break
    case 'entitlement':
      economy.commerce.entitlement(instance, args[0], args[1], args[2], Number(args[3]))
      break
    case 'item':
      economy.commerce.createItem(instance, args[0], args[1], Number(args[2]), args[3])
      break
    case 'audit':
      economy.store.assertConservation(instance)
      console.log('Supply conserved')
      break
    default:
      throw new Error(
        'Commands: instance ID SUPPLY | account INSTANCE ACCOUNT | login-code INSTANCE ACCOUNT | service INSTANCE SERVICE GAME_OR_* MAX_STAKE | source INSTANCE SOURCE SERVICE reward|migration BUDGET DAILY ACCOUNT_DAILY | entitlement INSTANCE SOURCE ID ACCOUNT AMOUNT | item INSTANCE ITEM TITLE PRICE NAMESPACE | audit INSTANCE',
      )
  }
} finally {
  economy.close()
}
