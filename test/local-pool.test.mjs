import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { LocalPoolEngine } from '../dist/server/local-pool.js'
import { LocalSpendEngine } from '../dist/server/local-spend.js'
import { signed, spendHash } from '../dist/server/spend-signatures.js'
const pk = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
function fixture(t, size = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'token-pool-')), now = 1_800_000_000_000
  const service = generateKeyPairSync('ed25519')
  const source = { serviceOrigin: 'https://games.example', servicePublicKey: pk(service), serverId: 'games' }
  const wallets = Array.from({ length: size }, (_, i) => {
    const e = new Economy(join(dir, `wallet-${i}.sqlite`), () => now)
    e.auth.createInstance('local', 1000)
    e.auth.createAccount('local', 'original')
    e.store.transaction(() => e.store.transfer('local', '$issuer', 'original', 500, 'fixture', 'funding', now))
    const key = generateKeyPairSync('ed25519')
    const wallet = new LocalSpendEngine(e.store, 'local', 'original', key.privateKey, () => now)
    const session = wallet.openSession(() => {})
    session.bindGameAccount(
      session.quoteBinding(
        signed({
          contract: 'economy.spend-wallet-challenge/v1',
          ...source,
          gameAccountId: `player-${i}`,
          nonce: String(i + 1).repeat(64),
          expiresAt: now + 60000,
        }, service.privateKey),
      ),
    )
    const pool = new LocalPoolEngine(wallet, key.privateKey)
    return {
      e,
      wallet,
      key,
      pool,
      session: pool.openSession(() => {}),
      balance: () => e.store.one('SELECT available,reserved FROM accounts WHERE id=?', 'original'),
    }
  })
  const terms = signed({
    contract: 'economy.pool-terms/v1',
    ...source,
    matchId: 'session-1',
    game: { id: 'holdem', version: '2', digest: 'a'.repeat(64), reviewStatus: 'reviewed' },
    participants: wallets.map((w, i) => ({
      gameAccountId: `player-${i}`,
      walletId: w.wallet.walletId,
      walletPublicKey: w.wallet.walletPublicKey,
      amount: 100,
    })),
    policy: 'remaining-chips',
    rounds: 10,
    acceptBefore: now + 60000,
  }, service.privateKey)
  const receipts = wallets.map(w => w.session.reserve(w.session.quote(terms, 'reserve-1')).reservation)
  const decision = (paid, { phase = 'finished', prior, exited = paid.map(() => true), reservations = receipts } = {}) =>
    signed({
      contract: 'economy.pool-decision/v1',
      terms,
      sequence: prior ? prior.payload.sequence + 1 : 1,
      previousHash: prior ? spendHash(prior.payload) : null,
      phase,
      reservations,
      allocations: wallets.map((w, i) => ({ walletId: w.wallet.walletId, paid: paid[i], exited: exited[i] })),
      remaining: size * 100 - paid.reduce((a, b) => a + b, 0),
      resultHash: 'b'.repeat(64),
    }, service.privateKey)
  t.after(() => {
    wallets.forEach(w => w.e.close())
    rmSync(dir, { force: true, recursive: true })
  })
  return { wallets, terms, receipts, decision, service, source }
}
test('two independent wallets settle winner gain and loser loss, preserving supply and idempotency', t => {
  const f = fixture(t), d = f.decision([0, 200])
  const results = f.wallets.map(w => w.pool.applyDecision(d, () => {}))
  assert.deepEqual(f.wallets.map(w => w.balance()), [{ available: 400, reserved: 0 }, { available: 600, reserved: 0 }])
  f.wallets.forEach((w, i) => {
    assert.deepEqual(w.pool.applyDecision(d, () => {}), results[i])
    assert.equal(w.e.store.one('SELECT supply FROM instances').supply, 1000)
    assert.equal(w.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 0)
    w.e.store.assertConservation('local')
  })
  assert.equal(f.wallets.reduce((s, w) => s + w.e.store.one('SELECT SUM(net) AS n FROM poolClearing').n, 0), 0)
})
test('partial exit keeps other deposits frozen; offline wallet replays chain after authority recreation', t => {
  const f = fixture(t, 3), a = f.decision([75, 0, 0], { phase: 'active', exited: [true, false, false] })
  f.wallets[0].pool.applyDecision(a, () => {})
  f.wallets[1].pool.applyDecision(a, () => {})
  assert.deepEqual(f.wallets[0].balance(), { available: 475, reserved: 0 })
  assert.deepEqual(f.wallets[1].balance(), { available: 400, reserved: 100 })
  const b = f.decision([75, 0, 225], { prior: a })
  const w = f.wallets[2], recovered = new LocalPoolEngine(w.wallet, w.key.privateKey)
  assert.throws(() => recovered.applyDecision(b, () => {}), /ordered/)
  recovered.applyDecision(a, () => {})
  recovered.applyDecision(b, () => {})
  f.wallets[0].pool.applyDecision(b, () => {})
  f.wallets[1].pool.applyDecision(b, () => {})
  assert.deepEqual(f.wallets.map(w => w.balance().available), [475, 400, 625])
  assert.equal(f.wallets.reduce((s, w) => s + w.balance().available + w.balance().reserved, 0), 1500)
})
test('refund may recover unacknowledged hold but cannot mint or change a committed decision', t => {
  const f = fixture(t), d = f.decision([100, 100], { phase: 'refunded', reservations: [] })
  f.wallets.forEach(w => w.pool.applyDecision(d, () => {}))
  assert.deepEqual(f.wallets.map(w => w.balance()), [{ available: 500, reserved: 0 }, { available: 500, reserved: 0 }])
  assert.throws(() => f.wallets[0].pool.applyDecision(f.decision([0, 200]), () => {}), /immutable/)
})
test('missing funds, changed receipts, invalid signatures, changed exit payout and conservation violations fail atomically', t => {
  const f = fixture(t, 3), w = f.wallets[0]
  assert.throws(
    () => w.pool.applyDecision(f.decision([300, 0, 0], { reservations: f.receipts.slice(1) }), () => {}),
    /deposits/,
  )
  const bad = f.decision([301, 0, 0])
  assert.throws(() => w.pool.applyDecision(bad, () => {}), /Invalid/)
  const d = f.decision([75, 0, 0], { phase: 'active', exited: [true, false, false] })
  assert.throws(() => w.pool.applyDecision({ ...d, signature: 'A'.repeat(86) }, () => {}))
  assert.deepEqual(w.balance(), { available: 400, reserved: 100 })
  w.pool.applyDecision(d, () => {})
  assert.throws(() => w.pool.applyDecision(f.decision([76, 124, 100], { prior: d }), () => {}), /Exited/)
  const foreign = structuredClone(f.receipts)
  foreign[1] = signed({ ...foreign[1].payload, nonce: 'c'.repeat(64) }, f.wallets[1].key.privateKey)
  assert.throws(
    () => w.pool.applyDecision(f.decision([75, 125, 100], { prior: d, reservations: foreign }), () => {}),
    /receipt set/,
  )
  assert.deepEqual(w.balance(), { available: 475, reserved: 0 })
})
test('private authorization, stable request and final commit fence protect deposits and settlements', t => {
  const f = fixture(t), w = f.wallets[0]
  const quote = w.session.quote(f.terms, 'reserve-1')
  assert.throws(() => w.session.reserve({ ...quote }), /private/)
  assert.equal(w.session.reserve(quote).reservation.payload.nonce, f.receipts[0].payload.nonce)
  const other = signed({ ...f.terms.payload, matchId: 'session-2' }, f.service.privateKey)
  assert.throws(() => w.session.reserve(w.session.quote(other, 'reserve-1')), /another pool/)
  w.e.store.db.exec(
    "CREATE TRIGGER reject_pool BEFORE INSERT ON poolDecisions BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  )
  const d = f.decision([200, 0])
  assert.throws(() => w.pool.applyDecision(d, () => {}), /injected/)
  assert.deepEqual(w.balance(), { available: 400, reserved: 100 })
  assert.equal(w.e.store.one('SELECT COUNT(*) AS n FROM poolClearing').n, 0)
  w.e.store.db.exec('DROP TRIGGER reject_pool')
  let calls = 0
  assert.throws(() =>
    w.pool.applyDecision(d, () => {
      if (++calls === 3) throw Error('retired')
    }), /retired/)
  assert.deepEqual(w.balance(), { available: 400, reserved: 100 })
  w.session.close()
  assert.throws(() => w.session.reserve(quote), /retired/)
})
