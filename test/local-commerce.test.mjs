import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { canonical, hash } from '../dist/server/database.js'
import { Economy } from '../dist/server/economy.js'
import { legacyReceipt } from '../dist/server/legacy-receipts.js'
import { openLocalCommerceSession } from '../dist/server/local-commerce.js'
import { LocalSpendEngine } from '../dist/server/local-spend.js'
import { LocalWalletIdentities } from '../dist/server/local-wallet-identities.js'
import { openSpendProviderSession } from '../dist/server/spend-provider.js'
function fixture(t) {
  const e = new Economy(':memory:')
  t.after(() => e.close())
  e.auth.createInstance('local', 100)
  e.auth.createAccount('local', 'original')
  e.store.transaction(() =>
    e.store.transfer('local', '$issuer', 'original', 50, 'test-only-funding', 'fixture', Date.now())
  )
  e.commerce.createItem('local', 'food', 'Food', 3, 'pet')
  const k = generateKeyPairSync('ed25519')
  const engine = new LocalSpendEngine(e.store, 'local', 'original', k.privateKey)
  let active = true
  const current = () => {
    if (!active) throw new Error('owner retired')
  }
  const session = openLocalCommerceSession(engine, current)
  const input = {
    storeId: 'pet',
    itemId: 'food',
    quantity: 2,
    expectedTotal: 6,
    requestId: 'purchase-one',
    fulfillmentTarget: { namespace: 'pet', storeId: 'pet-own-store' },
  }
  return {
    e,
    engine,
    key: k.privateKey,
    session,
    input,
    retire: () => active = false,
    balance: () => e.store.one('SELECT available,reserved FROM accounts WHERE id=?', 'original'),
  }
}
test('local purchase has fixed catalog quote, atomic debit/order/inventory and stable request recovery', t => {
  const f = fixture(t)
  assert.equal(JSON.parse(f.session.catalog('pet'))[0].price, 3)
  const q = f.session.quotePurchase(f.input)
  assert.equal(JSON.parse(q.quote).total, 6)
  const receipt = f.session.purchase(q.handle)
  assert.equal(JSON.parse(receipt).total, 6)
  assert.equal(JSON.parse(receipt).fulfillmentTarget.storeId, 'pet-own-store')
  assert.deepEqual(f.balance(), { available: 44, reserved: 0 })
  assert.equal(f.e.store.one('SELECT quantity FROM inventory').quantity, 2)
  assert.equal(f.session.purchase(q.handle), receipt)
  assert.equal(f.session.order('pet', 'purchase-one'), receipt)
  assert.equal(JSON.parse(f.session.orders('pet')).length, 1)
  const sibling = openLocalCommerceSession(f.engine, () => {})
  assert.equal(sibling.order('pet', 'purchase-one'), receipt)
  assert.equal(sibling.purchase(sibling.quotePurchase(f.input).handle), receipt)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM orders').n, 1)
  f.e.store.assertConservation('local')
})
test('purchase price/target/key changes and fabricated or retired approval reject without financial side effects', t => {
  const f = fixture(t)
  assert.throws(() => f.session.quotePurchase({ ...f.input, expectedTotal: 5 }), /catalog differs/)
  assert.throws(
    () => f.session.quotePurchase({ ...f.input, fulfillmentTarget: { namespace: 'remote', storeId: 'x' } }),
    /fulfillment/,
  )
  const q = f.session.quotePurchase(f.input)
  assert.throws(() => f.session.purchase({ ...q.handle }), /Original private/)
  f.e.store.run('UPDATE items SET price=? WHERE instance=? AND id=?', 4, 'local', 'food')
  assert.throws(() => f.session.purchase(q.handle), /catalog changed/)
  assert.deepEqual(f.balance(), { available: 50, reserved: 0 })
  const q2 = f.session.quotePurchase({ ...f.input, expectedTotal: 8 })
  f.retire()
  assert.throws(() => f.session.purchase(q2.handle), /owner retired/)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM orders').n, 0)
})
test('purchase persistence failure rolls back money and fulfillment; original local request cannot change target', t => {
  const f = fixture(t), q = f.session.quotePurchase(f.input)
  f.e.store.db.exec(
    "CREATE TRIGGER fail_purchase BEFORE INSERT ON localPurchaseRequests BEGIN SELECT RAISE(ABORT,'purchase persistence failed'); END",
  )
  assert.throws(() => f.session.purchase(q.handle), /persistence failed/)
  assert.deepEqual(f.balance(), { available: 50, reserved: 0 })
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM inventory').n, 0)
  f.e.store.db.exec('DROP TRIGGER fail_purchase')
  f.session.purchase(q.handle)
  assert.throws(
    () => f.session.quotePurchase({ ...f.input, fulfillmentTarget: { namespace: 'pet', storeId: 'other-pet' } }),
    /request changed/,
  )
})
test('historical recovery reads exact committed responses only and never revives grant/migration/purchase mutations', t => {
  const f = fixture(t), user = f.e.auth.login(f.e.auth.enrollment('local', 'original')).token
  const sponsor = f.e.auth.createService('local', 'old-sponsor', '*', 100).token
  f.e.commerce.createSource('local', 'old-source', 'old-sponsor', 'reward', 10, 10, 10)
  const body = { sourceId: 'old-source', accountId: 'original', eventId: 'old-event', amount: 1 },
    actor = f.e.auth.authenticate(sponsor)
  const receipt = f.e.store.idempotent(
    'local',
    'service:old-sponsor',
    'saved-old-key',
    '/v1/rewards/grant',
    body,
    () => f.e.commerce.grant(actor, body),
  )
  const before = f.e.store.all('SELECT * FROM ledger')
  assert.deepEqual(
    JSON.parse(legacyReceipt(f.engine, { kind: 'grant', requestId: 'saved-old-key', input: JSON.stringify(body) })),
    receipt,
  )
  assert.deepEqual(f.e.request('POST', '/v1/rewards/grant', sponsor, body, 'saved-old-key'), receipt)
  assert.throws(
    () => f.e.request('POST', '/v1/rewards/grant', sponsor, { ...body, eventId: 'new' }, 'new-old-key'),
    /Historical mutation retired/,
  )
  assert.throws(
    () =>
      legacyReceipt(f.engine, {
        kind: 'grant',
        requestId: 'saved-old-key',
        input: JSON.stringify({ ...body, amount: 2 }),
      }),
    /differs/,
  )
  assert.equal(legacyReceipt(f.engine, { kind: 'purchase', requestId: 'missing', input: '{}' }), null)
  assert.throws(
    () =>
      legacyReceipt(f.engine, {
        kind: 'grant',
        requestId: 'saved-old-key',
        input: JSON.stringify({ ...body, accountId: 'other' }),
      }),
    /original wallet/,
  )
  for (
    const path of ['/v1/agreements', '/v1/reserve', '/v1/settle', '/v1/cancel', '/v1/orders', '/v1/migrations/claim']
  ) assert.throws(() => f.e.request('POST', path, user, {}, 'new-retired-key'), /retired/)
  assert.deepEqual(f.e.store.all('SELECT * FROM ledger'), before)
})
test('trusted provider uses exact original delegation and synchronous close fences every operation', t => {
  const f = fixture(t),
    origin = 'http://127.0.0.1:8900',
    k = generateKeyPairSync('ed25519'),
    der = k.publicKey.export({ type: 'spki', format: 'der' }),
    fingerprint = createHash('sha256').update(der).digest('hex')
  const subject = 'host-local:' + createHash('sha256').update(der).digest('base64url'),
    realm = 'realm:' + hash(canonical({ origin, instanceId: 'local' }))
  const aliases = new LocalWalletIdentities(f.e.store, 'local', realm)
  aliases.enroll({
    realm,
    subject,
    keyFingerprint: fingerprint,
    accountId: 'original',
    publicKey: der.toString('base64'),
  })
  const wallet = { origin, instanceId: 'local', accountId: 'original', subject, publicKey: der.toString('base64') },
    provider = openSpendProviderSession(f.engine, wallet, () => true)
  assert.equal(provider.identity().walletId, f.engine.walletId)
  provider.close()
  assert.throws(() => provider.identity(), /retired/)
  assert.throws(() => provider.catalog('pet'), /retired/)
  assert.throws(
    () => openSpendProviderSession(f.engine, { ...wallet, accountId: 'other' }, () => true),
    /canonical wallet/,
  )
  aliases.revoke({ realm, subject, keyFingerprint: fingerprint })
  assert.throws(() => openSpendProviderSession(f.engine, wallet, () => true), /revoked|unavailable/)
})
test('definite cancellation persists exact intent, survives new session and defeats late purchase without debit', t => {
  const f = fixture(t), q = f.session.quotePurchase(f.input)
  const cancelled = f.session.cancelPurchase(q.handle), proof = JSON.parse(cancelled)
  assert.equal(proof.state, 'cancelled')
  assert.equal(proof.inputHash, hash(canonical(f.input)))
  assert.deepEqual(proof.input, f.input)
  assert.equal(f.session.purchase(q.handle), cancelled)
  assert.deepEqual(f.balance(), { available: 50, reserved: 0 })
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM orders').n, 0)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM inventory').n, 0)
  assert.deepEqual(JSON.parse(f.session.orders('pet')), [])
  const next = openLocalCommerceSession(f.engine, () => {})
  assert.equal(next.order('pet', f.input.requestId), cancelled)
  assert.equal(next.cancelPurchase(next.quoteCancellation(f.input).handle), cancelled)
  assert.throws(() => next.quoteCancellation({ ...f.input, quantity: 1 }), /request changed/)
})
test('cancellation-only quotes recover old intent after price change and cannot authorize purchase', t => {
  const f = fixture(t)
  f.e.store.run('UPDATE items SET price=? WHERE instance=? AND id=?', 10, 'local', 'food')
  const q = f.session.quoteCancellation(f.input)
  assert.equal(JSON.parse(q.quote).contract, 'economy.local-purchase-cancellation-quote/v1')
  assert.throws(() => f.session.purchase(q.handle), /Original private/)
  assert.throws(() => f.session.cancelPurchase({ ...q.handle }), /Original private/)
  assert.equal(JSON.parse(f.session.cancelPurchase(q.handle)).state, 'cancelled')
  assert.deepEqual(f.balance(), { available: 50, reserved: 0 })
})
test('purchase and cancellation share one terminal decision; cancellation storage or final fence failure rolls back', t => {
  const f = fixture(t), q = f.session.quotePurchase(f.input)
  const bought = f.session.purchase(q.handle)
  assert.equal(f.session.cancelPurchase(q.handle), bought)
  assert.equal(f.session.cancelPurchase(f.session.quoteCancellation(f.input).handle), bought)
  const second = { ...f.input, requestId: 'cancel-failure' }
  const c = f.session.quoteCancellation(second)
  f.e.store.db.exec(
    "CREATE TRIGGER fail_cancel BEFORE INSERT ON localPurchaseRequests BEGIN SELECT RAISE(ABORT,'cancel persistence failed'); END",
  )
  assert.throws(() => f.session.cancelPurchase(c.handle), /persistence failed/)
  assert.equal(f.session.order('pet', second.requestId), null)
  f.e.store.db.exec('DROP TRIGGER fail_cancel')
  let checks = 0, retireOn = Infinity
  const fenced = openLocalCommerceSession(f.engine, () => {
    if (++checks === retireOn) throw new Error('retired at commit')
  })
  const quote = fenced.quoteCancellation(second)
  retireOn = checks + 3
  assert.throws(() => fenced.cancelPurchase(quote.handle), /retired at commit/)
  assert.equal(f.session.order('pet', second.requestId), null)
  assert.deepEqual(f.balance(), { available: 44, reserved: 0 })
})
test('private cancellation quote expires without producing a definite cancellation or touching funds', t => {
  const f = fixture(t)
  let now = Date.now()
  const engine = new LocalSpendEngine(f.e.store, 'local', 'original', f.key, () => now)
  const session = openLocalCommerceSession(engine, () => {})
  const q = session.quoteCancellation(f.input)
  now += 90_001
  assert.throws(() => session.cancelPurchase(q.handle), /quote expired/)
  assert.equal(session.order('pet', f.input.requestId), null)
  assert.deepEqual(f.balance(), { available: 50, reserved: 0 })
  assert.equal(JSON.parse(session.cancelPurchase(session.quoteCancellation(f.input).handle)).state, 'cancelled')
})
