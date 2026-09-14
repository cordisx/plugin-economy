import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { WorkIncomeIssuer } from '../dist/server/work-income.js'
function fixture(t) {
  const e = new Economy(':memory:')
  t.after(() => e.close())
  e.auth.createInstance('local', 1)
  e.auth.createAccount('local', 'opaque-codex-subject')
  e.auth.createAccount('local', 'other')
  const issuer = new WorkIncomeIssuer(e.store)
  const binding = { instanceId: 'local', accountId: 'opaque-codex-subject', scopeId: 'opaque-profile-scope' }
  issuer.bind(binding)
  const snapshot = (tokens, revision, epoch = 'epoch-1') => ({
    schemaVersion: 2,
    status: 'ready',
    policyId: 'codex-local-work-input-output-v2',
    coverage: 'partial',
    enabledAt: 1,
    inputTokens: tokens - 1,
    outputTokens: 1,
    eligibleTokens: tokens,
    scopeId: binding.scopeId,
    sourceId: 'codex-local',
    epoch,
    revision,
    observedThrough: revision,
    classification: {
      version: 'host-game-cwd-v1',
      hostGameTasks: 'excluded',
      forksAndSubagents: 'excluded',
      unknownSources: 'excluded',
    },
  })
  const submit = (tokens, revision, baseline = false, epoch) =>
    issuer.accept({ binding, snapshot: snapshot(tokens, revision, epoch), baseline })
  return { e, issuer, binding, snapshot, submit }
}
test('actual future input+output income has no total, day, or person-day cap; server derives amount', t => {
  const f = fixture(t)
  assert.equal(f.submit(1000000, 1).amount, 0)
  assert.equal(f.submit(1009999, 2).remainder, 9999)
  assert.equal(f.submit(1010000, 3).amount, 1)
  assert.equal(f.submit(1001010000, 4).amount, 100000)
  assert.equal(f.submit(2001010000, 5).amount, 100000)
  assert.equal(f.e.store.one('SELECT available FROM accounts WHERE id=?', f.binding.accountId).available, 200001)
  assert.equal(f.e.store.one('SELECT supply FROM instances').supply, 200002)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM grants').n, 0)
  f.e.store.assertConservation('local')
})
test('two issuer objects, lost receipts and partitioned frontier never duplicate coins', t => {
  const f = fixture(t), second = new WorkIncomeIssuer(f.e.store)
  f.submit(1, 1)
  const receipt = f.submit(20001, 2)
  assert.deepEqual(f.submit(20001, 2), receipt)
  assert.deepEqual(second.accept({ binding: f.binding, snapshot: f.snapshot(20001, 2), baseline: false }), receipt)
  assert.equal(f.submit(30001, 3).amount, 1)
  assert.throws(() => f.submit(25001, 2), /backwards/)
  assert.equal(f.e.store.one('SELECT available FROM accounts WHERE id=?', f.binding.accountId).available, 3)
})
test('gap and new epochs establish future baseline; retired epochs and counter conflicts fail', t => {
  const f = fixture(t)
  f.submit(1, 1)
  f.submit(9001, 2)
  assert.equal(f.submit(1000001, 3, true).amount, 0)
  assert.equal(f.submit(1010001, 4).amount, 1)
  assert.equal(f.submit(5000001, 5, false, 'epoch-2').amount, 0)
  assert.throws(() => f.submit(1020001, 6, false, 'epoch-1'), /earlier/)
  assert.throws(() => f.submit(5000002, 5, false, 'epoch-2'), /conflicting/)
  assert.equal(f.submit(5010001, 6, false, 'epoch-2').amount, 1)
})
test('immutable scope binding and strict root-work classification exclude alternative recipients and v1', t => {
  const f = fixture(t)
  assert.throws(() => f.issuer.bind({ ...f.binding, accountId: 'other' }), /already has a wallet/)
  assert.throws(() => f.issuer.bind({ ...f.binding, scopeId: 'another' }), /cannot be rebound/)
  assert.throws(
    () =>
      f.issuer.accept({ binding: { ...f.binding, accountId: 'other' }, snapshot: f.snapshot(1, 1), baseline: true }),
    /binding required/,
  )
  for (
    const snapshot of [{ schemaVersion: 1 }, { ...f.snapshot(1, 1), classification: {} }, {
      ...f.snapshot(1, 1),
      eligibleTokens: 5,
    }]
  ) {
    assert.throws(() => f.issuer.accept({ binding: f.binding, snapshot, baseline: true }), /unavailable/)
  }
})
test('ordinary user/game bearer routes cannot submit arbitrary usage or mint', t => {
  const f = fixture(t)
  const user = f.e.auth.login(f.e.auth.enrollment('local', f.binding.accountId)).token
  const game = f.e.auth.createService('local', 'game', '*', 100).token
  for (const token of [user, game]) {
    assert.throws(
      () =>
        f.e.request('POST', '/v1/income/work', token, { snapshot: f.snapshot(1000000, 1), amount: 100 }, 'attack-once'),
      /Route not found/,
    )
  }
  assert.equal(f.e.store.one('SELECT supply FROM instances').supply, 1)
})

test('frontier and receipt survive service reconstruction; numeric overflow rolls back issuance and cursor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'work-income-')), path = join(dir, 'wallet.sqlite')
  let e = new Economy(path)
  t.after(() => {
    e.close()
    rmSync(dir, { recursive: true, force: true })
  })
  e.auth.createInstance('local', 1)
  e.auth.createAccount('local', 'opaque-codex-subject')
  const binding = { instanceId: 'local', accountId: 'opaque-codex-subject', scopeId: 'opaque-profile-scope' }
  const sample = fixture(t)
  let issuer = new WorkIncomeIssuer(e.store)
  issuer.bind(binding)
  issuer.accept({ binding, snapshot: sample.snapshot(1, 1), baseline: true })
  const receipt = issuer.accept({ binding, snapshot: sample.snapshot(10001, 2), baseline: false })
  e.close()
  e = new Economy(path)
  issuer = new WorkIncomeIssuer(e.store)
  assert.deepEqual(issuer.accept({ binding, snapshot: sample.snapshot(10001, 2), baseline: false }), receipt)
  assert.equal(issuer.accept({ binding, snapshot: sample.snapshot(20001, 3), baseline: false }).amount, 1)
  e.store.run('UPDATE instances SET supply=?', Number.MAX_SAFE_INTEGER)
  e.store.run('UPDATE accounts SET available=? WHERE id=?', Number.MAX_SAFE_INTEGER - 1, binding.accountId)
  e.store.assertConservation('local')
  const prior = e.store.one('SELECT cursor FROM workIncomeFrontiers')
  assert.throws(
    () => issuer.accept({ binding, snapshot: sample.snapshot(30001, 4), baseline: false }),
    /exact integer storage/,
  )
  assert.deepEqual(e.store.one('SELECT cursor FROM workIncomeFrontiers'), prior)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM ledger WHERE reason=?', 'work-income').n, 2)
})

test('trusted new local identity starts at zero without sponsor/genesis funds and retains account on reprovision', t => {
  const e = new Economy(':memory:')
  t.after(() => e.close())
  const issuer = new WorkIncomeIssuer(e.store)
  const sample = fixture(t)
  issuer.provision(sample.binding)
  assert.equal(e.store.one('SELECT supply FROM instances').supply, 0)
  assert.equal(e.store.one('SELECT available FROM accounts WHERE id=?', sample.binding.accountId).available, 0)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 0)
  issuer.accept({ binding: sample.binding, snapshot: sample.snapshot(1, 1), baseline: true })
  issuer.accept({ binding: sample.binding, snapshot: sample.snapshot(10001, 2), baseline: false })
  issuer.provision(sample.binding)
  assert.equal(e.store.one('SELECT available FROM accounts WHERE id=?', sample.binding.accountId).available, 1)
  e.store.assertConservation('local')
})
