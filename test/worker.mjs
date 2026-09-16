import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { Economy } from '../dist/server/economy.js'
import { openLocalCommerceSession } from '../dist/server/local-commerce.js'
import { LocalSpendEngine } from '../dist/server/local-spend.js'
const [path, mode, receiptKey, key] = process.argv.slice(2)
const economy = new Economy(path)
if (mode === 'crash') {
  economy.store.db.exec('BEGIN IMMEDIATE')
  economy.store.move('one', 'alice', -75, 0, 'interrupted', 'test', Date.now(), 'crash')
  process.send?.('dirty')
  setInterval(() => {}, 1000)
} else {
  process.send?.('ready')
  process.on('message', () => {
    try {
      const engine = new LocalSpendEngine(economy.store, 'one', 'alice', createPrivateKey(receiptKey))
      const session = openLocalCommerceSession(engine, () => {})
      const result = JSON.parse(
        session.purchase(
          session.quotePurchase({ storeId: 'pet', itemId: 'pet.apple', quantity: 1, expectedTotal: 60, requestId: key })
            .handle,
        ),
      )
      process.send?.({ ok: true, result })
    } catch (error) {
      process.send?.({ ok: false, code: error.code })
    }
    economy.close()
    process.disconnect()
  })
}
