import assert from 'node:assert/strict'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
test('zero-price catalog order is durable without monetary entries', t => {
  const economy = new Economy(':memory:')
  t.after(() => economy.close())
  economy.auth.createInstance('one', 100)
  economy.auth.createAccount('one', 'alice')
  economy.commerce.createItem('one', 'pet.free', 'Free appearance', 0, 'pet')
  const token = economy.auth.login(economy.auth.enrollment('one', 'alice')).token
  const body = { itemId: 'pet.free', quantity: 1, expectedTotal: 0 }
  const order = economy.request('POST', '/v1/orders', token, body, 'free-order')
  assert.equal(order.total, 0)
  assert.deepEqual(economy.request('POST', '/v1/orders', token, body, 'free-order'), order)
  assert.equal(economy.request('GET', '/v1/inventory', token)[0].quantity, 1)
  assert.equal(economy.request('GET', '/v1/ledger', token).length, 0)
  economy.store.assertConservation('one')
})
