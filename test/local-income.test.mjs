import assert from 'node:assert/strict'
import test from 'node:test'
import { localWallet, LocalWorkIncome } from '../dist/local/index.js'
const wallet = { origin: 'http://127.0.0.1:9000', instanceId: 'local', accountId: 'earned-only' }
const snap = (tokens, revision = tokens, epoch = 'epoch') => ({
  schemaVersion: 2,
  status: 'ready',
  policyId: 'codex-local-work-input-output-v2',
  coverage: 'partial',
  enabledAt: 0,
  scopeId: 'profile',
  sourceId: 'codex',
  epoch,
  revision,
  eligibleTokens: tokens,
  inputTokens: tokens,
  outputTokens: 0,
  observedThrough: revision,
  classification: {
    version: 'host-game-cwd-v1',
    hostGameTasks: 'excluded',
    forksAndSubagents: 'excluded',
    unknownSources: 'excluded',
  },
})
function setup() {
  let revision = 0, value = null
  const events = new Map(), calls = []
  const storage = {
    load: async () => ({ revision, value: structuredClone(value) }),
    save: async (r, next) => {
      if (r !== revision) return false
      revision++
      value = structuredClone(next)
      return true
    },
  }
  const commit = async i => {
    assert(value.pending?.eventId === i.eventId || events.has(i.eventId))
    calls.push(i)
    if (!events.has(i.eventId)) events.set(i.eventId, { eventId: i.eventId, wallet, amount: i.amount })
    return events.get(i.eventId)
  }
  return { storage, commit, events, calls, state: () => structuredClone(value) }
}
test('loopback canonical identity blocks remote and account replacement', async () => {
  for (
    const origin of ['https://remote.example', 'http://localhost/path', 'http://x@localhost', 'http://127.0.0.1.evil']
  ) assert.throws(() => localWallet({ ...wallet, origin }))
  const s = setup()
  await new LocalWorkIncome(s.storage, wallet, s.commit).observe(snap(0))
  await assert.rejects(
    new LocalWorkIncome(s.storage, { ...wallet, accountId: 'other' }, s.commit).observe(snap(10000)),
    /Restore canonical/,
  )
  assert.equal(s.state().wallet.accountId, wallet.accountId)
})
test('future-only remainder and duplicate revision', async () => {
  const s = setup(), w = new LocalWorkIncome(s.storage, wallet, s.commit)
  for (const n of [40000, 45500, 51200, 51200]) await w.observe(snap(n))
  assert.equal(s.events.size, 1)
  assert.equal(s.state().earned, 1)
  assert.equal(s.state().remainder, 1200)
})
test('v1, game-inclusive and inconsistent counters preserve frontier', async () => {
  const s = setup(), w = new LocalWorkIncome(s.storage, wallet, s.commit)
  await w.observe(snap(0))
  for (
    const v of [{ ...snap(10000), schemaVersion: 1 }, {
      ...snap(10000),
      classification: { ...snap(0).classification, hostGameTasks: 'included' },
    }, { ...snap(10000), eligibleTokens: 10001 }]
  ) await assert.rejects(w.observe(v))
  assert.equal(s.state().cursor.tokens, 0)
  assert.equal(s.events.size, 0)
})
test('restart, gaps and epoch never backfill', async () => {
  const s = setup()
  let w = new LocalWorkIncome(s.storage, wallet, s.commit)
  await w.observe(snap(0))
  await w.observe(snap(5000))
  w.dispose()
  w = new LocalWorkIncome(s.storage, wallet, s.commit)
  await w.observe(snap(55000))
  await w.observe(snap(60000))
  w.pause()
  await w.observe(snap(160000))
  await w.observe(snap(260000, 260000, 'new'))
  assert.equal(s.events.size, 0)
  assert.equal(s.state().remainder, 0)
})
test('lost receipt replays exact pending across restart and drops gap', async () => {
  const s = setup(),
    w = new LocalWorkIncome(s.storage, wallet, async i => {
      await s.commit(i)
      throw new Error('lost')
    })
  await w.observe(snap(0))
  await assert.rejects(w.observe(snap(10000)), /lost/)
  const event = s.state().pending.eventId
  const r = new LocalWorkIncome(s.storage, wallet, s.commit)
  await r.observe(snap(30000))
  assert.equal(s.calls.at(-1).eventId, event)
  assert.equal(s.events.size, 1)
  assert.equal(s.state().earned, 1)
  await r.observe(snap(50000))
  assert.equal(s.events.size, 1)
  await r.observe(snap(60000))
  assert.equal(s.events.size, 2)
})
test('shared CAS prevents overlapping windows creating duplicate events', async () => {
  const s = setup(),
    a = new LocalWorkIncome(s.storage, wallet, s.commit),
    b = new LocalWorkIncome(s.storage, wallet, s.commit)
  await Promise.all([a.observe(snap(0)), b.observe(snap(0))])
  await Promise.all([a.observe(snap(10000)), b.observe(snap(10000))])
  assert.equal(s.events.size, 1)
  assert.equal(s.state().earned, 1)
  assert.equal(s.state().pending, undefined)
})
test('backward and conflicting revisions preserve frontier', async () => {
  const s = setup(), w = new LocalWorkIncome(s.storage, wallet, s.commit)
  await w.observe(snap(10000, 10))
  await assert.rejects(w.observe(snap(9000, 11)), /regressed/)
  await assert.rejects(w.observe(snap(11000, 10)), /Conflicting/)
  assert.equal(s.state().cursor.tokens, 10000)
})
test('exhausted budget drops before pending; bad receipt preserves pending', async () => {
  const s = setup(), w = new LocalWorkIncome(s.storage, wallet, s.commit, async () => false)
  await w.observe(snap(0))
  await w.observe(snap(15000))
  assert.equal(s.state().pending, undefined)
  assert.equal(s.state().remainder, 0)
  const p = setup(),
    bad = new LocalWorkIncome(p.storage, wallet, async i => ({ eventId: i.eventId, wallet, amount: i.amount + 1 }))
  await bad.observe(snap(0))
  await assert.rejects(bad.observe(snap(10000)), /receipt mismatch/)
  assert.equal(p.state().pending.amount, 1)
  assert.equal(p.state().earned, 0)
})
