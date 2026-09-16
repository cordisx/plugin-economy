import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Economy } from '../dist/server/index.js'
import { WorkIncomeIssuer } from '../dist/server/work-income.js'
function fixture(t) {
  const e = new Economy(':memory:'), issuer = new WorkIncomeIssuer(e.store)
  issuer.provisionIdentity('local', 'alice')
  t.after(() => e.store.db.close())
  const request = {
    contract: 'economy.history-declaration/v1',
    id: `history:${randomUUID()}`,
    statement: 'I explicitly confirm this profile has never enabled Pet work rewards.',
    stage: 'begin',
  }
  return { e, issuer, request, apply: stage => issuer.history.apply('local', 'alice', { ...request, stage }) }
}
test('explicit zero-history declaration is audited, idempotent and suspends issuance until confirmed', t => {
  const f = fixture(t), receipt = f.apply('begin')
  assert.equal(receipt.status, 'pending')
  assert.deepEqual(f.apply('begin'), receipt)
  assert.throws(
    () => f.issuer.provision({ instanceId: 'local', accountId: 'alice', scopeId: 'actual-work' }),
    e => e.code === 'HISTORY_CORRECTION_PENDING',
  )
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeBindings').n, 0)
  assert.equal(f.apply('confirm').status, 'confirmed')
  f.issuer.provision({ instanceId: 'local', accountId: 'alice', scopeId: 'actual-work' })
  assert.equal(f.apply('lookup').status, 'confirmed')
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 0)
})
test('existing cutover including a zero baseline prevents a new manual declaration', t => {
  const f = fixture(t)
  f.issuer.provision({ instanceId: 'local', accountId: 'alice', scopeId: 'actual-work' })
  assert.throws(() => f.apply('begin'), e => e.code === 'HISTORY_STARTED')
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM historyDeclarations').n, 0)
})
test('zero current balance cannot erase old accounting history', t => {
  const f = fixture(t)
  f.e.store.run(
    "INSERT INTO ledger(instance,transactionId,account,availableDelta,reservedDelta,reason,reference,createdAt) VALUES('local','old','alice',0,0,'old-history','original',1)",
  )
  assert.throws(() => f.apply('begin'), e => e.code === 'HISTORY_STARTED')
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 1)
})
test('confirm rechecks new concurrent accounting and explicit cancel retains its audit', t => {
  const f = fixture(t)
  f.apply('begin')
  f.e.store.run(
    "INSERT INTO ledger(instance,transactionId,account,availableDelta,reservedDelta,reason,reference,createdAt) VALUES('local','race','alice',0,0,'old-history','original',1)",
  )
  assert.throws(() => f.apply('confirm'), e => e.code === 'HISTORY_STARTED')
  assert.equal(f.apply('cancel').status, 'cancelled')
  f.issuer.provision({ instanceId: 'local', accountId: 'alice', scopeId: 'actual-work' })
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 1)
})
test('manual statement and operation identity are immutable; confirmed correction cannot be cancelled', t => {
  const f = fixture(t)
  f.apply('begin')
  assert.throws(
    () => f.issuer.history.apply('local', 'alice', { ...f.request, statement: 'different' }),
    e => e.code === 'IDEMPOTENCY_CONFLICT',
  )
  assert.throws(
    () => f.issuer.history.apply('local', 'alice', { ...f.request, id: `history:${randomUUID()}` }),
    e => e.code === 'HISTORY_CONFLICT',
  )
  f.apply('confirm')
  assert.throws(() => f.apply('cancel'), e => e.code === 'HISTORY_CONFLICT')
})
test('history operation survives reconstruction and rejects malformed or unowned accounts', t => {
  const f = fixture(t)
  f.apply('begin')
  const rebuilt = new WorkIncomeIssuer(f.e.store)
  assert.equal(rebuilt.history.apply('local', 'alice', { ...f.request, stage: 'lookup' }).status, 'pending')
  assert.throws(
    () => f.issuer.history.apply('local', 'alice', { ...f.request, amount: 1 }),
    e => e.code === 'INVALID_INPUT',
  )
  assert.throws(() => f.issuer.history.apply('local', 'missing-user', f.request), e => e.code === 'HISTORY_STARTED')
})

test('public HTTP correction authenticates own user and forbids arbitrary target or foreign instance', async t => {
  const { once } = await import('node:events')
  const { generateKeyPairSync } = await import('node:crypto')
  const { createEconomyServer, ManagedWorkIncome } = await import('../dist/server/index.js')
  const f = fixture(t), options = {}, server = createEconomyServer(f.e, options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`, keys = generateKeyPairSync('ed25519')
  options.workIncome = new ManagedWorkIncome(f.e.store, {
    binding: { origin, sourceId: 'economy-local', instanceId: 'local', audience: 'work-income' },
    hostPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    serverPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  })
  const token = f.e.auth.issue('local', 'alice', 'user', 3600000).token
  const request = async (body, bearer = token) =>
    fetch(origin + '/v1/income/history-declaration', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    })
  const before = f.e.store.all('SELECT * FROM historyDeclarations')
  for (const bearer of [null, token, 'invalid']) assert.equal((await request(f.request, bearer)).status, 410)
  assert.deepEqual(f.e.store.all('SELECT * FROM historyDeclarations'), before)
})
