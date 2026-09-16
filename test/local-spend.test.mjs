import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { LocalSpendEngine } from '../dist/server/local-spend.js'
import { decisionId, signed, spendHash } from '../dist/server/spend-signatures.js'
import { parseDecision, parseTerms, parseWalletBinding, signingBytes, verifySigned } from '../dist/spend/index.js'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'economy-spend-'))
  let now = 1_800_000_000_000
  const e = new Economy(join(dir, 'wallet.sqlite'), () => now)
  e.auth.createInstance('local', 1000)
  e.auth.createAccount('local', 'original')
  // Source fixture reserves canonical test funds; no production grant or external financial operation.
  e.store.transaction(() => {
    e.store.transfer('local', '$issuer', 'original', 100, 'test-funding', 'fixture', now)
    e.store.assertConservation('local')
  })
  const wallet = generateKeyPairSync('ed25519'), service = generateKeyPairSync('ed25519')
  const pk = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const engine = new LocalSpendEngine(e.store, 'local', 'original', wallet.privateKey, () => now)
  const session = engine.openSession(() => {})
  const source = { serviceOrigin: 'https://games.example', servicePublicKey: pk(service), serverId: 'source-one' }
  let serial = 0
  const challenge = (over = {}) =>
    signed({
      contract: 'economy.spend-wallet-challenge/v1',
      ...source,
      gameAccountId: 'remote-alice',
      nonce: (++serial).toString(16).padStart(64, '0'),
      expiresAt: now + 60_000,
      ...over,
    }, service.privateKey)
  const bind = c => session.bindGameAccount(session.quoteBinding(c))
  bind(challenge())
  const terms = (over = {}) =>
    signed({
      contract: 'economy.spend-terms/v1',
      ...source,
      matchId: 'match-' + (++serial),
      game: { id: 'gomoku', version: '1', digest: 'a'.repeat(64), reviewStatus: 'unreviewed' },
      participants: [{
        gameAccountId: 'remote-alice',
        walletId: engine.walletId,
        walletPublicKey: engine.walletPublicKey,
        amount: 20,
      }],
      policy: 'capture-and-release',
      acceptBefore: now + 60_000,
      ...over,
    }, service.privateKey)
  const reserve = (term = terms(), request = 'request-' + (++serial)) => session.reserve(session.quote(term, request))
  const decision = (term, receipts, capture = 12, action = 'capture') =>
    signed({
      contract: 'economy.spend-decision/v1',
      ...source,
      matchId: term.payload.matchId,
      termsHash: spendHash(term.payload),
      decisionId: decisionId(term.payload),
      action,
      entries: receipts.map(reservation => ({ reservation, captureAmount: capture })),
    }, service.privateKey)
  const balance = () =>
    e.store.one('SELECT available,reserved FROM accounts WHERE instance=? AND id=?', 'local', 'original')
  const money = () => e.store.all('SELECT * FROM ledger WHERE reason LIKE ?', 'spend-%')
  t.after(() => {
    e.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    e,
    engine,
    session,
    service,
    wallet,
    source,
    challenge,
    bind,
    terms,
    reserve,
    decision,
    balance,
    money,
    advance: n => now += n,
    now: () => now,
  }
}
test('wallet binding proof is fixed, signed, durable and cannot rotate pinned service/wallet keys', async t => {
  const f = fixture(t), c = f.challenge(), proof = f.bind(c)
  assert(parseWalletBinding(proof.payload))
  assert(await verifySigned(proof, f.engine.walletPublicKey))
  assert.deepEqual(f.bind(c), proof)
  f.advance(100_000)
  assert.deepEqual(f.bind(c), proof)
  assert.throws(() => f.bind(f.challenge({ expiresAt: f.now() - 1 })), /expired/)
  const other = generateKeyPairSync('ed25519'),
    newpk = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const rotated = signed({ ...f.challenge().payload, servicePublicKey: newpk }, other.privateKey)
  assert.throws(() => f.bind(rotated), /cannot be rebound/)
  assert.throws(() => new LocalSpendEngine(f.e.store, 'local', 'original', other.privateKey), /original receipt key/)
  assert.throws(() => new LocalSpendEngine(f.e.store, 'local', 'missing', other.privateKey), /Existing canonical/)
  assert.deepEqual(f.balance(), { available: 100, reserved: 0 })
})
test('atomic hold uses exact immutable private quote, persists nonce and recovers lost acknowledgement/restart', async t => {
  const f = fixture(t), terms = f.terms(), q = f.session.quote(terms, 'durable-request')
  const record = f.session.reserve(q)
  assert(await verifySigned(record.reservation, f.engine.walletPublicKey))
  assert.equal(spendHash(q.terms), record.reservation.payload.termsHash)
  assert.deepEqual(f.session.reserve(q), record)
  assert.deepEqual(f.engine.lookupRequest(f.source, 'durable-request'), record)
  assert.throws(() => f.session.reserve({ ...q }), /original quoted/)
  assert.throws(() => {
    q.terms.participants[0].amount = 99
  }, TypeError)
  const sibling = new LocalSpendEngine(f.e.store, 'local', 'original', f.wallet.privateKey, () => f.now()),
    s = sibling.openSession(() => {})
  assert.deepEqual(s.reserve(s.quote(terms, 'durable-request')), record)
  assert.deepEqual(f.balance(), { available: 80, reserved: 20 })
  assert.equal(f.money().length, 1)
  f.session.close()
  assert.throws(() => f.session.reserve(q), /retired/)
  assert.deepEqual(sibling.lookup(record.reservation.payload.reservationId), record)
})
test('signed capture consumes only the original principal, releases remainder and cannot issue coin', async t => {
  const f = fixture(t), terms = f.terms(), hold = f.reserve(terms), d = f.decision(terms, [hold.reservation])
  const result = f.engine.applyDecision(d, () => {})
  assert.equal(result[0].settlement.payload.captured, 12)
  assert.equal(result[0].settlement.payload.released, 8)
  assert(await verifySigned(result[0].settlement, f.engine.walletPublicKey))
  assert.deepEqual(f.balance(), { available: 88, reserved: 0 })
  assert.equal(f.e.store.one('SELECT supply FROM instances').supply, 988)
  assert.deepEqual(f.engine.applyDecision(d, () => {}), result)
  assert.equal(f.money().length, 2)
  const before = f.money()
  assert.throws(() => f.engine.applyDecision(f.decision(terms, [hold.reservation], 21), () => {}), /Invalid economy/)
  assert.throws(() => f.engine.applyDecision(f.decision(terms, [hold.reservation], 0, 'refund'), () => {}), /immutable/)
  assert.deepEqual(f.money(), before)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 0)
})
test('deadline/disconnection never refund independently; durable service refund closes late receipts', t => {
  const f = fixture(t), terms = f.terms(), hold = f.reserve(terms)
  f.advance(100_000)
  assert.deepEqual(f.balance(), { available: 80, reserved: 20 })
  assert.equal(f.engine.pending().length, 1)
  assert.throws(() => f.session.quote(f.terms({ acceptBefore: f.now() - 1 })), /no longer admit/)
  const refund = f.decision(terms, [], 0, 'refund')
  const result = f.engine.applyDecision(refund, () => {})
  assert.deepEqual(f.balance(), { available: 100, reserved: 0 })
  assert.equal(result[0].state, 'refunded')
  assert.throws(() => f.engine.applyDecision(f.decision(terms, [hold.reservation], 20), () => {}), /immutable/)
})
test('foreign service/account/key/terms/nonce, missing funding, extra credit fields and replay to another order reject', t => {
  const f = fixture(t), terms = f.terms(), hold = f.reserve(terms, 'request-1'), before = f.money()
  const mutated = { ...terms.payload, participants: [{ ...terms.payload.participants[0], amount: 21 }] }
  assert.throws(() => f.session.quote({ payload: mutated, signature: terms.signature }), /signature/)
  assert.throws(() => parseTerms({ ...terms.payload, payouts: [] }), /Invalid economy/)
  const d = f.decision(terms, [hold.reservation])
  assert.throws(() => parseDecision({ ...d.payload, credit: 20 }), /Invalid economy/)
  const missing = f.decision(terms, [])
  assert.throws(() => f.engine.applyDecision(missing, () => {}), /every disclosed/)
  for (const field of ['serviceOrigin', 'serverId', 'matchId', 'termsHash', 'gameAccountId', 'walletId', 'nonce']) {
    const bad = {
      ...hold.reservation.payload,
      [field]: field === 'nonce'
        ? 'b'.repeat(64)
        : field === 'termsHash'
        ? 'b'.repeat(64)
        : field === 'serviceOrigin'
        ? 'https://other.example'
        : 'other',
    }
    const receipt = signed(bad, f.wallet.privateKey), decision = f.decision(terms, [receipt])
    assert.throws(() => f.engine.applyDecision(decision, () => {}))
  }
  assert.throws(() => f.engine.applyDecision({ ...d, signature: 'A'.repeat(86) }, () => {}))
  assert.deepEqual(f.money(), before)
  assert.deepEqual(f.balance(), { available: 80, reserved: 20 })
  const newTerms = f.terms()
  assert.throws(() => f.reserve(newTerms, 'request-1'), /Request ID|request/i)
})
test('same wallet/source/request cannot silently switch terms; same wallet can reserve across distinct remote sources', t => {
  const f = fixture(t), a = f.terms()
  f.reserve(a, 'pinned-request')
  assert.throws(() => f.reserve(f.terms(), 'pinned-request'), /already bound/)
  const source = { ...f.source, serviceOrigin: 'https://second.example', serverId: 'source-two' }
  f.bind(f.challenge(source))
  const b = f.terms(source)
  f.reserve(b, 'pinned-request')
  assert.deepEqual(f.balance(), { available: 60, reserved: 40 })
})
test('final authorization and storage failures roll back hold, signature persistence, capture and decision together', t => {
  const f = fixture(t), terms = f.terms()
  let checks = 0
  const s = f.engine.openSession(() => {
    if (++checks === 4) throw new Error('owner retired at commit')
  })
  const q = s.quote(terms)
  const before = f.money()
  assert.throws(() => s.reserve(q), /owner retired/)
  assert.deepEqual(f.money(), before)
  assert.deepEqual(f.balance(), { available: 100, reserved: 0 })
  const hold = f.reserve(terms), d = f.decision(terms, [hold.reservation])
  f.e.store.db.exec(
    "CREATE TRIGGER fail_spend BEFORE INSERT ON spendDecisions BEGIN SELECT RAISE(ABORT,'injected decision failure'); END",
  )
  assert.throws(() => f.engine.applyDecision(d, () => {}), /injected decision failure/)
  assert.deepEqual(f.balance(), { available: 80, reserved: 20 })
  assert.equal(f.engine.pending().length, 1)
  assert.equal(f.money().length, 1)
  f.e.store.db.exec('DROP TRIGGER fail_spend')
  const old = f.money()
  assert.throws(() =>
    f.engine.applyDecision(d, () => {
      throw new Error('retired')
    }), /retired/)
  assert.deepEqual(f.money(), old)
})
