import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'economy-'))
  let now = 1_800_000_000_000
  const economy = new Economy(join(dir, 'ledger.sqlite'), () => now)
  t.after(() => {
    economy.close()
    rmSync(dir, { recursive: true, force: true })
  })
  economy.auth.createInstance('one', 10000)
  for (const name of ['alice', 'bob', 'eve']) economy.auth.createAccount('one', name)
  const users = Object.fromEntries(
    ['alice', 'bob', 'eve'].map(name => [name, economy.auth.login(economy.auth.enrollment('one', name)).token]),
  )
  const game = economy.auth.createService('one', 'game-server', '*', 100).token
  const reward = economy.auth.createService('one', 'reward-server', 'usage', 100).token
  economy.commerce.createSource('one', 'welcome', 'reward-server', 'reward', 1000, 500, 100)
  let serial = 0
  const req = (token, path, body, key = `request-${++serial}`) =>
    economy.request(body === undefined ? 'GET' : 'POST', `/v1${path}`, token, body, key)
  for (const accountId of ['alice', 'bob']) {
    req(reward, '/rewards/grant', { sourceId: 'welcome', accountId, eventId: `welcome:${accountId}`, amount: 100 })
  }
  const agreement = (
    settlementPolicy = {
      kind: 'enumerated',
      outcomes: [{ id: 'alice', payouts: [{ accountId: 'alice', amount: 20 }] }, {
        id: 'draw',
        payouts: [{ accountId: 'alice', amount: 10 }, { accountId: 'bob', amount: 10 }],
      }],
    },
  ) =>
    req(game, '/agreements', {
      matchId: `match-${++serial}`,
      game: { id: 'unreviewed-game', version: '1.0.0', digest: 'a'.repeat(64), reviewStatus: 'unreviewed' },
      participants: [{ accountId: 'alice', amount: 10 }, { accountId: 'bob', amount: 10 }],
      settlementPolicy,
      expiresAt: now + 60_000,
    })
  return {
    economy,
    users,
    game,
    reward,
    req,
    agreement,
    advance: ms => {
      now += ms
    },
    dir,
  }
}
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)
test('unreviewed game explicit user reserves and conserved settlement, no service reserve', t => {
  const f = fixture(t), a = f.agreement()
  rejects(() => f.req(f.game, '/reserve', { agreementId: a.id, termsHash: a.termsHash }), 'FORBIDDEN')
  rejects(() => f.req(f.users.alice, '/reserve', { agreementId: a.id, termsHash: 'fake' }), 'TERMS_CHANGED')
  for (const token of [f.users.alice, f.users.bob]) {
    f.req(token, '/reserve', { agreementId: a.id, termsHash: a.termsHash })
  }
  assert.deepEqual(f.req(f.users.alice, '/me'), { instanceId: 'one', accountId: 'alice', available: 90, reserved: 10 })
  const input = { agreementId: a.id, termsHash: a.termsHash, outcomeId: 'alice' }
  assert.equal(f.req(f.game, '/settle', input, 'settle-once').state, 'settled')
  f.req(f.game, '/settle', input, 'settle-once')
  assert.equal(f.req(f.users.alice, '/me').available, 110)
  assert.equal(f.req(f.users.bob, '/me').available, 90)
  f.economy.store.assertConservation('one')
})
test('conflicting retries, different authorities and unknown game terms cannot mutate funds', t => {
  const f = fixture(t), a = f.agreement()
  f.req(f.users.alice, '/reserve', { agreementId: a.id, termsHash: a.termsHash }, 'reserve-key')
  rejects(
    () => f.req(f.users.alice, '/reserve', { agreementId: a.id, termsHash: 'bad' }, 'reserve-key'),
    'IDEMPOTENCY_CONFLICT',
  )
  rejects(() => f.req(f.users.eve, `/agreements/${a.id}`), 'FORBIDDEN')
  rejects(() => f.req('forged', '/cancel', { agreementId: a.id, reason: 'abort' }), 'UNAUTHORIZED')
  rejects(() => f.req(f.reward, '/cancel', { agreementId: a.id, reason: 'abort' }), 'FORBIDDEN')
  rejects(
    () => f.req(f.game, '/settle', { agreementId: a.id, termsHash: a.termsHash, outcomeId: 'alice' }),
    'NOT_FUNDED',
  )
  rejects(() => f.req(f.game, '/agreements', { ...a, instanceId: 'fake' }), 'INVALID_INPUT')
})
test('cancel partially funded agreement refunds once; expiry survives failed settlement and restart', t => {
  const f = fixture(t), a = f.agreement()
  f.req(f.users.alice, '/reserve', { agreementId: a.id, termsHash: a.termsHash })
  f.req(f.game, '/cancel', { agreementId: a.id, reason: 'abort' }, 'cancel-once')
  f.req(f.game, '/cancel', { agreementId: a.id, reason: 'abort' }, 'cancel-once')
  assert.equal(f.req(f.users.alice, '/me').available, 100)
  const b = f.agreement()
  f.req(f.users.alice, '/reserve', { agreementId: b.id, termsHash: b.termsHash })
  f.advance(61_000)
  rejects(
    () => f.req(f.game, '/settle', { agreementId: b.id, termsHash: b.termsHash, outcomeId: 'alice' }),
    'AGREEMENT_EXPIRED',
  )
  assert.equal(f.req(f.users.alice, '/me').available, 100)
  assert.equal(f.req(f.game, `/agreements/${b.id}`).state, 'expired')
  const recovered = new Economy(join(f.dir, 'ledger.sqlite'))
  recovered.store.assertConservation('one')
  recovered.close()
})
test('conserved policy rejects minted/outside/fractional payouts with atomic rollback', t => {
  const f = fixture(t), a = f.agreement({ kind: 'conserved-payouts' })
  for (const token of [f.users.alice, f.users.bob]) {
    f.req(token, '/reserve', { agreementId: a.id, termsHash: a.termsHash })
  }
  for (
    const payouts of [[{ accountId: 'alice', amount: 21 }], [{ accountId: 'eve', amount: 20 }], [{
      accountId: 'alice',
      amount: 20.1,
    }]]
  ) {
    assert.throws(() => f.req(f.game, '/settle', { agreementId: a.id, termsHash: a.termsHash, payouts }))
    assert.equal(f.req(f.users.alice, '/me').reserved, 10)
  }
  f.req(f.game, '/settle', {
    agreementId: a.id,
    termsHash: a.termsHash,
    payouts: [{ accountId: 'alice', amount: 13 }, { accountId: 'bob', amount: 7 }],
  })
  assert.equal(f.req(f.users.alice, '/me').available, 103)
})
test('purchase atomicity, receipt reconciliation, insufficient funds and cross-account isolation', t => {
  const f = fixture(t)
  f.economy.commerce.createItem('one', 'pet.apple', 'Apple', 60, 'pet')
  const order = f.req(f.users.alice, '/orders', { itemId: 'pet.apple', quantity: 1 }, 'buy-apple')
  assert.deepEqual(f.req(f.users.alice, '/orders', { itemId: 'pet.apple', quantity: 1 }, 'buy-apple'), order)
  rejects(() => f.req(f.users.alice, '/orders', { itemId: 'pet.apple', quantity: 1 }), 'INSUFFICIENT_FUNDS')
  rejects(() => f.req(f.users.bob, `/orders/${order.id}`), 'NOT_FOUND')
  assert.deepEqual(f.req(f.users.alice, '/inventory'), [{ itemId: 'pet.apple', quantity: 1 }])
  assert.equal(f.req(f.users.alice, '/me').available, 40)
  assert.equal(f.req(f.users.alice, '/orders').length, 1)
})
test('source budgets and namespaced events cannot be reset by reinstall or game service', t => {
  const f = fixture(t), body = { sourceId: 'welcome', accountId: 'alice', eventId: 'welcome:alice', amount: 100 }
  f.req(f.reward, '/rewards/grant', body)
  rejects(() => f.req(f.reward, '/rewards/grant', { ...body, accountId: 'bob' }), 'EVENT_CONFLICT')
  rejects(() => f.req(f.game, '/rewards/grant', body), 'FORBIDDEN')
  rejects(() => f.req(f.users.alice, '/rewards/grant', body), 'FORBIDDEN')
  rejects(() => f.req(f.reward, '/rewards/grant', { ...body, eventId: 'new-event' }), 'LIMIT_EXCEEDED')
  assert.equal(f.req(f.users.alice, '/me').available, 100)
})
test('operator-approved migration claims are account-bound and permanent', t => {
  const f = fixture(t)
  f.economy.commerce.createSource('one', 'pet-legacy', 'reward-server', 'migration', 500, 500, 500)
  f.economy.commerce.entitlement('one', 'pet-legacy', 'a'.repeat(64), 'alice', 50)
  const body = { sourceId: 'pet-legacy', entitlementId: 'a'.repeat(64) }
  rejects(() => f.req(f.users.bob, '/migrations/claim', body), 'NOT_FOUND')
  f.req(f.users.alice, '/migrations/claim', body, 'migration-key')
  f.req(f.users.alice, '/migrations/claim', body, 'migration-key')
  rejects(() => f.req(f.users.alice, '/migrations/claim', body), 'MIGRATION_CONSUMED')
  assert.equal(f.req(f.users.alice, '/me').available, 150)
})
test('session one-time enrollment, rotation, revocation and instance binding', t => {
  const f = fixture(t), code = f.economy.auth.enrollment('one', 'eve')
  const session = f.economy.auth.login(code)
  rejects(() => f.economy.auth.login(code), 'UNAUTHORIZED')
  const next = f.economy.auth.rotate(session.token)
  rejects(() => f.economy.auth.authenticate(session.token), 'UNAUTHORIZED')
  assert.equal(f.economy.auth.authenticate(next.token).subject, 'eve')
  f.economy.auth.createInstance('two', 10)
  f.economy.auth.createAccount('two', 'alice')
  const other = f.economy.auth.login(f.economy.auth.enrollment('two', 'alice')).token
  assert.equal(f.req(other, '/me').available, 0)
  rejects(() => f.req(other, `/agreements/${f.agreement().id}`), 'NOT_FOUND')
})
