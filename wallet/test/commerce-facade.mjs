import { digest } from '@cordisx/economy/spend'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWalletCommerceFacade } from '../.cache/test-runtime/commerce-facade.js'
const input = { storeId: 'pet', itemId: 'food', quantity: 2, expectedTotal: 6, requestId: 'intent-1' }
function fixture() {
  const session = {
    readOnly: false,
    client: {},
    service: { summary: async () => ({ status: 'ready', wallet: { instanceId: 'local', accountId: 'original' } }) },
  }
  const port = { contract: 'cordisx.wallet-spend/v1' }
  return { session, port, facade: createWalletCommerceFacade(session, () => port) }
}
async function cancellation() {
  return {
    contract: 'economy.local-purchase-cancelled/v1',
    state: 'cancelled',
    instanceId: 'local',
    accountId: 'original',
    storeId: 'pet',
    requestId: input.requestId,
    input,
    inputHash: await digest(input),
  }
}
test('definite cancellation is validated against exact intent and canonical hash through normal public bridge', async () => {
  const f = fixture(), proof = await cancellation(), signal = new AbortController().signal
  f.port.purchase = async request => {
    assert.equal(request.deadline, 12345)
    assert.equal(request.signal, signal)
    return { status: 'accepted', value: JSON.stringify(proof) }
  }
  assert.equal((await f.facade.purchase(input, { deadline: 12345, signal })).value.state, 'cancelled')
  f.port.cancelPurchase = f.port.purchase
  assert.equal((await f.facade.cancelPurchase(input, { deadline: 12345, signal })).value.state, 'cancelled')
  f.port.purchase = async () => ({ status: 'accepted', value: JSON.stringify({ ...proof, inputHash: '0'.repeat(64) }) })
  assert.equal((await f.facade.purchase(input)).status, 'unavailable')
  const changed = { ...proof, input: { ...input, quantity: 1 } }
  changed.inputHash = await digest(changed.input)
  f.port.purchase = async () => ({ status: 'accepted', value: JSON.stringify(changed) })
  assert.equal((await f.facade.purchase(input)).status, 'unavailable')
})
test('unknown acknowledgment and wallet generation changes remain unavailable; read-only prevents mutations', async () => {
  const f = fixture()
  f.port.order = async () => ({ status: 'accepted', value: null })
  assert.deepEqual(await f.facade.order({ storeId: 'pet', requestId: input.requestId }), {
    status: 'ready',
    value: null,
  })
  f.port.cancelPurchase = async () => ({ status: 'unavailable', code: 'disconnected' })
  assert.equal((await f.facade.cancelPurchase(input)).status, 'unavailable')
  f.port.purchase = async () => {
    f.session.client = {}
    return { status: 'accepted', value: JSON.stringify(await cancellation()) }
  }
  assert.match((await f.facade.purchase(input)).reason, /retain pending/)
  f.session.readOnly = true
  f.port.cancelPurchase = async () => {
    throw new Error('must not dispatch')
  }
  assert.match((await f.facade.cancelPurchase(input)).reason, /read-only/)
})

test('lookup rejects a cancellation for another request and caller mutation cannot change the authorized cancellation intent', async () => {
  const f = fixture(), proof = await cancellation()
  f.port.order = async () => ({ status: 'accepted', value: JSON.stringify(proof) })
  assert.equal((await f.facade.order({ storeId: 'pet', requestId: 'other' })).status, 'unavailable')
  const caller = structuredClone(input)
  f.port.cancelPurchase = async () => {
    caller.quantity = 99
    return { status: 'accepted', value: JSON.stringify(proof) }
  }
  assert.equal((await f.facade.cancelPurchase(caller)).value.state, 'cancelled')
})
