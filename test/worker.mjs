import { Economy } from '../dist/server/economy.js'
const [path, mode, token, key] = process.argv.slice(2)
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
      const result = economy.request('POST', '/v1/orders', token, { itemId: 'pet.apple', quantity: 1 }, key)
      process.send?.({ ok: true, result })
    } catch (error) {
      process.send?.({ ok: false, code: error.code })
    }
    economy.close()
    process.disconnect()
  })
}
