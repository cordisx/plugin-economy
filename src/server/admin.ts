import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
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
      if (Number(args[0]) !== 0) {
        throw new Error('Genesis coin issuance retired; only actual Host usage can issue coins')
      }
      economy.auth.createInstance(instance, 0)
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
    case 'entitlement':
      throw new Error('Historical reward/migration issuance retired; existing records are preserved')
    case 'item':
      economy.commerce.createItem(instance, args[0], args[1], Number(args[2]), args[3])
      break
    case 'catalog-import': {
      const items = JSON.parse(readFileSync(args[0], 'utf8'))
      if (!Array.isArray(items) || items.length > 10000) {
        throw new Error('Catalog must be an array with at most 10000 items')
      }
      economy.store.transaction(() => {
        for (const item of items) economy.commerce.createItem(instance, item.id, item.title, item.price, item.namespace)
      })
      console.log(`Imported ${items.length} items`)
      break
    }
    case 'prepare-empty-scope-correction': {
      const plan = JSON.parse(readFileSync(args[0], 'utf8'))
      if (plan.instanceId !== instance) throw new Error('Correction instance must match the explicit admin command')
      console.log(JSON.stringify(economy.workIncome.corrections.prepare(plan)))
      break
    }
    case 'audit':
      economy.store.assertConservation(instance)
      console.log('Supply conserved')
      break
    default:
      throw new Error(
        'Commands: prepare-empty-scope-correction INSTANCE PLAN_JSON | instance ID 0 | account INSTANCE ACCOUNT | login-code INSTANCE ACCOUNT | service INSTANCE SERVICE GAME_OR_* MAX_STAKE | item INSTANCE ITEM TITLE PRICE NAMESPACE | audit INSTANCE',
      )
  }
} finally {
  economy.close()
}
