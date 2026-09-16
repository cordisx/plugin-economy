import assert from 'node:assert/strict'
import test from 'node:test'
import { drain, origin, workIncomeFixture as fixture } from './work-income-fixture.mjs'
test('canonical owner automatic zero identity, CAS pending, trusted future income and no finite sponsor', async t => {
  const f = fixture(t), s = f.owner()
  f.change(1000000)
  await s.connect(origin)
  await drain()
  assert.equal((await s.service.summary()).available, 0)
  assert.equal(f.submitted[0].baseline, true)
  f.change(1009999)
  await drain()
  assert.equal((await s.service.summary()).available, 0)
  f.change(1010000)
  await drain()
  assert.equal((await s.service.summary()).available, 1)
  f.change(1001010000)
  await drain()
  assert.equal((await s.service.summary()).available, 100001)
  assert.equal(f.records.get('economy-work-issuance-v1').value.pending, undefined)
  assert.equal((await s.service.ledger()).entries[0].reason, 'work-income')
  assert.equal(f.manual(), 0)
  assert.equal(s.service.incomeStatus().status, 'ready')
})
test('unresolved original Pet prevents issuer calls; resumption baselines and idle provider loss is immediate', async t => {
  const f = fixture(t), s = f.owner()
  f.pending(true)
  await s.connect(origin)
  await drain()
  assert.equal(f.submitted.length, 0)
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  f.change(1000000)
  await drain()
  f.pending(false)
  f.change(2000000)
  await drain()
  assert.equal(f.submitted[0].baseline, true)
  assert.equal((await s.service.summary()).available, 0)
  f.retire()
  assert.equal(s.service.incomeStatus().stage, 'retirement')
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  f.change(2010000)
  await drain()
  assert.equal(f.submitted.length, 1)
})
test('uncertain issuer reply preserves pending and next signed baseline cannot duplicate prior issuance', async t => {
  const f = fixture(t), s = f.owner()
  await s.connect(origin)
  await drain()
  const actual = f.http.submitWorkUsage
  f.http.submitWorkUsage = async input => {
    await actual(input)
    return { status: 'unavailable', code: 'deadline-exceeded' }
  }
  f.change(10000)
  await drain()
  assert(f.records.get('economy-work-issuance-v1').value.pending)
  assert.equal((await s.service.summary()).available, 1)
  f.http.submitWorkUsage = actual
  f.change(20000)
  await drain()
  assert.equal(f.submitted.at(-1).baseline, true)
  assert.equal((await s.service.summary()).available, 1)
  f.change(30000)
  await drain()
  assert.equal((await s.service.summary()).available, 2)
})
test('owner closure publishes terminal unavailable and releases only its own connection', async t => {
  const f = fixture(t), s = f.owner()
  await s.connect(origin)
  await drain()
  let terminal
  s.service.subscribeIncome(() => {
    terminal = s.service.incomeStatus()
  })
  s.dispose()
  assert.equal(terminal.status, 'unavailable')
  assert.equal(terminal.reason, 'Wallet owner retired')
  assert.equal(f.revoked(), 1)
  f.change(10000)
  await drain()
  assert.equal(f.submitted.length, 1)
  assert.equal((await s.service.summary()).status, 'unavailable')
})
test('HTTP v1/v2 cannot downgrade managed login to manual bearer consent', async t => {
  const f = fixture(t), s = f.owner()
  f.http.contract = 'cordisx.http-client/v2'
  await assert.rejects(s.connect(origin), /requires Host HTTP v3/)
  assert.equal(f.manual(), 0)
  assert.equal(f.submitted.length, 0)
})

test('another window cannot replace a live CAS intent or submit a second issuer operation', async t => {
  const f = fixture(t), a = f.owner()
  await a.connect(origin)
  await drain()
  const actual = f.http.submitWorkUsage
  let release, entered
  const reached = new Promise(resolve => {
    entered = resolve
  })
  const held = new Promise(resolve => {
    release = resolve
  })
  let calls = 0
  f.http.submitWorkUsage = async input => {
    calls++
    entered()
    const terminal = await held
    return terminal || actual(input)
  }
  f.change(10000)
  await reached
  const intent = structuredClone(f.records.get('economy-work-issuance-v1').value.pending)
  const b = f.owner()
  await b.connect(origin)
  await drain()
  assert.deepEqual(f.records.get('economy-work-issuance-v1').value.pending, intent)
  assert.equal(calls, 1)
  release()
  await drain()
  assert.equal((await a.service.summary()).available, 1)
  assert.equal((await b.service.summary()).available, 1)
})
test('public income subscriber receives idle Pet retirement invalidation before any heartbeat or usage event', async t => {
  const f = fixture(t), s = f.owner()
  await s.connect(origin)
  await drain()
  const statuses = []
  const unsubscribe = s.service.subscribeIncome(() => statuses.push(s.service.incomeStatus()))
  f.retire()
  await new Promise(resolve => queueMicrotask(resolve))
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].status, 'unavailable')
  assert.equal(statuses[0].stage, 'retirement')
  assert.equal(f.submitted.length, 1)
  unsubscribe()
})
test('held live source read beyond 35 seconds cannot be replaced; only settled failure allows baseline takeover', async t => {
  const f = fixture(t), a = f.owner()
  await a.connect(origin)
  await drain()
  const actual = f.http.submitWorkUsage
  let reject, entered
  const reached = new Promise(resolve => {
    entered = resolve
  })
  const held = new Promise(resolve => {
    reject = resolve
  })
  let calls = 0
  f.http.submitWorkUsage = async input => {
    calls++
    entered()
    const terminal = await held
    return terminal || actual(input)
  }
  f.change(10000)
  await reached
  const intent = structuredClone(f.records.get('economy-work-issuance-v1').value.pending)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(40000)
  const b = f.owner()
  await b.connect(origin)
  await drain()
  assert.deepEqual(f.records.get('economy-work-issuance-v1').value.pending, intent)
  assert.equal(calls, 1)
  reject({ status: 'unavailable', code: 'deadline-exceeded' })
  await drain()
  assert.equal(f.records.get('economy-work-issuance-v1').value.pending.status, 'failed')
  a.dispose()
  f.http.submitWorkUsage = actual
  f.change(20000)
  await drain()
  assert.equal(f.submitted.at(-1).baseline, true)
  assert.equal((await b.service.summary()).available, 0)
})

test('transport unknown and bare thrown errors retain active intent even after elapsed time and another window', async t => {
  for (const outcome of ['host-unavailable', 'throw']) {
    const f = fixture(t), a = f.owner()
    await a.connect(origin)
    await drain()
    let calls = 0
    f.http.submitWorkUsage = async () => {
      calls++
      if (outcome === 'throw') throw Error('unknown bridge error')
      return { status: 'unavailable', code: 'host-unavailable' }
    }
    f.change(10000)
    await drain()
    const intent = structuredClone(f.records.get('economy-work-issuance-v1').value.pending)
    assert.equal(intent.status, 'active')
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(40000)
    const b = f.owner()
    await b.connect(origin)
    await drain()
    assert.deepEqual(f.records.get('economy-work-issuance-v1').value.pending, intent)
    assert.equal(calls, 1)
    a.dispose()
    b.dispose()
    t.mock.timers.reset()
  }
})

test('requires-retirement removal after second proof prevents any issuer send', async t => {
  const f = fixture(t), s = f.owner()
  await s.connect(origin)
  await drain()
  const original = f.proof.retirement
  let calls = 0
  f.proof.retirement = async () => {
    const result = await original()
    if (++calls === 2) f.retire()
    return result
  }
  f.change(10000)
  await drain()
  assert.equal(f.submitted.length, 1)
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  assert.equal((await s.service.summary()).available, 0)
})
test('in-flight provider removal cannot publish ready even after a signed issuer reply', async t => {
  const f = fixture(t), s = f.owner()
  await s.connect(origin)
  await drain()
  const actual = f.http.submitWorkUsage
  let release, entered
  const reached = new Promise(resolve => {
    entered = resolve
  })
  const held = new Promise(resolve => {
    release = resolve
  })
  f.http.submitWorkUsage = async input => {
    const result = await actual(input)
    entered()
    await held
    return result
  }
  f.change(10000)
  await reached
  f.retire()
  release()
  await drain()
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  assert.equal(f.records.get('economy-work-issuance-v1').value.pending.status, 'failed')
})
test('mutating caller options cannot turn an existing retirement-required owner into no-history mode', async t => {
  const f = fixture(t), config = { legacyPetHistory: 'requires-retirement' }, s = f.owner(config)
  await s.connect(origin)
  await drain()
  config.legacyPetHistory = 'never-enabled'
  f.retire()
  f.change(10000)
  await drain()
  assert.equal(f.submitted.length, 1)
  assert.equal(s.service.incomeStatus().status, 'unavailable')
})

test('genuine missing history plus explicit never-enabled uses live producer and never invents old retirement proof', async t => {
  const f = fixture(t)
  f.producer.originalRecord = 'missing'
  f.proof.retirement = async () => {
    throw Error('Missing original history must not become a fabricated retirement proof')
  }
  const s = f.owner({ legacyPetHistory: 'never-enabled' })
  await s.connect(origin)
  await drain()
  assert.equal(f.submitted[0].baseline, true)
  assert.equal((await s.service.summary()).available, 0)
  f.change(10000)
  await drain()
  assert.equal((await s.service.summary()).available, 1)
})
test('missing with retirement-required and present/invalid/unavailable with never-enabled remain blocked', async t => {
  for (
    const [history, record] of [['requires-retirement', 'missing'], ['never-enabled', 'present'], [
      'never-enabled',
      'invalid',
    ], ['never-enabled', 'unavailable']]
  ) {
    const f = fixture(t)
    f.producer.originalRecord = record
    const s = f.owner({ legacyPetHistory: history })
    await s.connect(origin)
    await drain()
    assert.equal(f.submitted.length, 0)
    assert.equal(s.service.incomeStatus().status, 'unavailable')
    s.dispose()
  }
})
test('fresh producer active/wrongscope/closed and replacement during projection cannot authorize first issuance', async t => {
  for (const kind of ['active', 'wrongscope', 'closed', 'replaced']) {
    const f = fixture(t)
    f.producer.originalRecord = 'missing'
    if (kind === 'active') f.producer.disabled = false
    if (kind === 'wrongscope') f.producer.scopeId = 'other-work-scope'
    if (kind === 'closed') f.proof.isActive = () => false
    if (kind === 'replaced') {
      f.proof.currentProducer = async () => {
        f.replace({ ...f.proof })
        return { ...f.producer, producerGenerationId: f.proof.generationId }
      }
    }
    const s = f.owner({ legacyPetHistory: 'never-enabled' })
    await s.connect(origin)
    await drain()
    assert.equal(f.submitted.length, 0)
    s.dispose()
  }
})
test('never-enabled cannot fall back to absence after live provider invalidates an in-flight signed reply', async t => {
  const f = fixture(t)
  f.producer.originalRecord = 'missing'
  const s = f.owner({ legacyPetHistory: 'never-enabled' })
  await s.connect(origin)
  await drain()
  const actual = f.http.submitWorkUsage
  let entered, release
  const reached = new Promise(resolve => {
      entered = resolve
    }),
    held = new Promise(resolve => {
      release = resolve
    })
  f.http.submitWorkUsage = async input => {
    const reply = await actual(input)
    entered()
    await held
    return reply
  }
  f.change(10000)
  await reached
  f.retire()
  release()
  await drain()
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  f.change(20000)
  await drain()
  assert.equal(f.submitted.length, 2)
})

test('producer generation changed while projection is pending cannot validate fresh history', async t => {
  const f = fixture(t)
  f.producer.originalRecord = 'missing'
  f.proof.currentProducer = async () => {
    const generation = f.proof.generationId
    f.proof.generationId = 'replacement-generation'
    return { ...f.producer, producerGenerationId: generation }
  }
  const s = f.owner({ legacyPetHistory: 'never-enabled' })
  await s.connect(origin)
  await drain()
  assert.equal(f.submitted.length, 0)
})

test('never-enabled absence cannot return after getter observes an unverified provider', async t => {
  const f = fixture(t)
  f.retire()
  const s = f.owner({ legacyPetHistory: 'never-enabled' })
  await s.connect(origin)
  await drain()
  f.show()
  s.service.incomeStatus()
  f.retire()
  f.change(10000)
  await drain()
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  assert.equal(f.submitted.length, 1)
})

test('automatic connection failures remain visible through public wallet and income status', async t => {
  const f = fixture(t), s = f.owner({ localEconomyOrigin: origin })
  f.http.connectAccount = async () => ({ status: 'rejected', code: 'connection-unavailable' })
  await assert.rejects(s.connect(origin), /connection-unavailable/)
  const summary = await s.service.summary()
  assert.equal(summary.status, 'unavailable')
  assert.match(summary.reason, /connection-unavailable/)
  assert.equal(s.service.incomeStatus().stage, 'wallet')
  assert.match(s.service.incomeStatus().reason, /connection-unavailable/)
  assert.equal(f.submitted.length, 0)
})

test('same-owner concurrent history CAS startup keeps both zero wallets connected', async t => {
  const f = fixture(t), a = f.owner(), b = f.owner()
  const transaction = f.documents.transaction
  let declarations = 0, release
  const both = new Promise(resolve => {
    release = resolve
  })
  f.documents.transaction = async request => {
    if (request.value.legacyPetHistory && !f.records.get(request.documentId)?.value.legacyPetHistory) {
      declarations++
      if (declarations === 2) release()
      await both
    }
    return transaction(request)
  }
  await Promise.all([a.connect(origin), b.connect(origin)])
  await drain()
  assert.equal(declarations, 2)
  for (const owner of [a, b]) {
    const summary = await owner.service.summary()
    assert.equal(summary.status, 'ready')
    assert.equal(summary.available, 0)
    assert.equal(summary.reserved, 0)
  }
  assert.equal(f.records.get('economy-local-wallet-v1').value.legacyPetHistory, 'requires-retirement')
})

const declaration = {
  action: 'confirm-never-enabled',
  statement: 'I explicitly confirm this profile has never enabled Pet work rewards.',
}
test('historical policy mutation is retired without clearing original documents or issuing income', async t => {
  const f = fixture(t), normal = f.owner()
  await normal.connect(origin)
  await drain()
  normal.dispose()
  const before = structuredClone([...f.records]), count = f.submitted.length
  assert.throws(
    () => f.owner({ legacyPetHistoryCorrection: { action: 'confirm-never-enabled', statement: 'old operation' } }),
    /Historical policy mutation retired/,
  )
  assert.deepEqual([...f.records], before)
  assert.equal(f.submitted.length, count)
})
test('v4 local owner enrolls once, earns actual classified future work in one wallet and reads while Pet history is unavailable', async t => {
  const f = fixture(t, true), owner = f.owner()
  const initial = await owner.connect(origin)
  await drain() // Commit the initial Host observation before producing future usage.
  assert.equal(owner.incomeStatus().status, 'ready')
  assert.equal(initial.available, 0)
  assert.equal(f.nativeOpens(), 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM localWalletIdentities').n, 1)
  f.change(9999)
  await drain()
  assert.equal((await owner.service.summary()).available, 0)
  f.change(10000)
  await drain()
  assert.equal((await owner.service.summary()).available, 1)
  const before = f.submitted.length
  f.retire()
  f.change(20000)
  await drain()
  assert.equal(f.submitted.length, before)
  assert.equal(owner.incomeStatus().status, 'unavailable')
  assert.equal((await owner.service.summary()).available, 1)
  f.http.connectAccount = async () => {
    throw Error('Native unavailable after local enrollment')
  }
  f.show()
  await owner.connect(origin)
  await drain()
  assert.equal(f.nativeOpens(), 1)
  assert.equal((await owner.service.summary()).available, 1)
  f.change(30000)
  await drain()
  assert.equal((await owner.service.summary()).available, 2)
  assert.equal((await owner.service.summary()).wallet.accountId, initial.accountId)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeBindings').n, 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM grants').n, 0)
  owner.dispose()
  assert.equal((await owner.service.summary()).status, 'unavailable')
})

test('durable owner takes only the pristine current scope, credits admitted prefix, persists remainder after restart without inventing Pet history', async t => {
  const f = fixture(t, true, true), owner = f.owner()
  f.retire()
  f.change(4079096)
  const original = await owner.connect(origin)
  await drain()
  assert.equal(owner.incomeStatus().status, 'ready')
  assert.equal((await owner.service.summary()).available, 407)
  const first = await owner.service.workIncome()
  assert.equal(first.remainder, 9096)
  assert.equal(first.takeover.admittedPrefix.tokens, 4079096)
  const canonical = f.records.get('economy-local-wallet-v1').value
  assert.equal(canonical.legacyPetHistory, 'requires-retirement')
  assert.equal(canonical.historyCorrection, undefined)
  assert.equal(f.records.has('pet-work-rewards-v2'), false)
  f.change(4080000)
  await drain()
  assert.equal((await owner.service.workIncome()).earned, 408)
  assert.equal((await owner.service.workIncome()).remainder, 0)
  owner.dispose()
  f.http.connectAccount = async () => {
    throw Error('No Native reauthorization')
  }
  f.change(4091001)
  const replacement = f.owner()
  await replacement.connect(origin)
  await drain()
  assert.equal((await replacement.service.summary()).wallet.accountId, original.accountId)
  assert.equal((await replacement.service.summary()).available, 409)
  assert.equal((await replacement.service.workIncome()).remainder, 1001)
  assert.equal(f.nativeOpens(), 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeTakeovers').n, 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM grants').n, 0)
})
test('durable unknown first reply reconciles an active owner intent through one persisted income receipt', async t => {
  const f = fixture(t, true, true), owner = f.owner()
  f.retire()
  f.change(4079096)
  f.loseSettlementResponse()
  await owner.connect(origin)
  await drain()
  const pending = f.records.get('economy-work-issuance-v1').value.pending
  assert.equal(pending.status, 'active')
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 1)
  f.change(4079096)
  await drain()
  assert.equal(owner.incomeStatus().status, 'ready')
  assert.equal(f.records.get('economy-work-issuance-v1').value.pending, undefined)
  assert.equal((await owner.service.summary()).available, 407)
  assert.equal((await owner.service.workIncome()).remainder, 9096)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger WHERE reason=?', 'work-income').n, 1)
})

for (const loseReply of [false, true]) {
  test(`formal empty-scope correction preserves the original issuance document audit and ${loseReply ? 'recovers an unknown' : 'accepts one'} canonical receipt`, async t => {
    const f = fixture(t, true, true), owner = f.owner()
    f.retire()
    await owner.connect(origin)
    await drain()
    const wallet = (await owner.service.summary()).wallet
    const oldDocument = structuredClone(f.records.get('economy-work-issuance-v1'))
    const canonical = structuredClone(f.records.get('economy-local-wallet-v1'))
    assert.equal(oldDocument.value.scopeId, 'work-scope')
    assert.equal(oldDocument.value.pending, undefined)
    assert.equal((await owner.service.workIncome()).earned, 0)
    owner.dispose()
    const beforeSettlementCalls = f.submitted.length
    f.moveScope('canonical-preserved-work-scope', 'canonical-preserved-epoch')
    f.change(4079096)
    // Scope mismatch cannot authorize itself; only a formally prepared original-account correction can proceed.
    const unprepared = f.owner()
    await unprepared.connect(origin)
    await drain()
    assert.equal(unprepared.incomeStatus().status, 'unavailable')
    assert.deepEqual(f.records.get('economy-work-issuance-v1'), oldDocument)
    assert.deepEqual(f.records.get('economy-local-wallet-v1'), canonical)
    assert.equal(f.submitted.length, beforeSettlementCalls)
    assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 0)
    unprepared.dispose()
    const correction = f.e.workIncome.corrections.prepare({
      contract: 'economy.empty-work-scope-correction/v1',
      instanceId: wallet.instanceId,
      accountId: wallet.accountId,
      fromScopeId: 'work-scope',
      toScopeId: 'canonical-preserved-work-scope',
      expectedEventId: oldDocument.value.lastEventId,
      evidenceDigest: 'a'.repeat(64),
    })
    f.records.set('economy-work-issuance-v1', { ...oldDocument, value: null })
    const invalidDocumentOwner = f.owner()
    await invalidDocumentOwner.connect(origin)
    await drain()
    assert.equal(invalidDocumentOwner.incomeStatus().status, 'unavailable')
    assert.equal(f.records.get('economy-work-issuance-v1').value, null)
    assert.equal(f.submitted.length, beforeSettlementCalls)
    invalidDocumentOwner.dispose()
    // Only the in-memory test fixture restores its baseline to exercise the valid-document path next.
    f.records.set('economy-work-issuance-v1', structuredClone(oldDocument))
    if (loseReply) f.loseSettlementResponse()
    const recovered = f.owner()
    await recovered.connect(origin)
    await drain()
    if (loseReply) {
      assert.equal(f.records.get('economy-work-issuance-v1').value.pending.status, 'active')
      const sibling = f.owner()
      await sibling.connect(origin)
      await drain()
      f.change(4079096)
      await drain()
    }
    assert.equal(recovered.incomeStatus().status, 'ready')
    const current = f.records.get('economy-work-issuance-v1').value
    assert.equal(current.scopeId, 'canonical-preserved-work-scope')
    assert.equal(current.pending, undefined)
    assert.deepEqual(current.scopeHistory, [{ correctionId: correction.id, previous: oldDocument.value }])
    assert.deepEqual(f.records.get('economy-local-wallet-v1'), canonical)
    assert.equal((await recovered.service.summary()).available, 407)
    assert.equal((await recovered.service.workIncome()).remainder, 9096)
    assert.equal((await recovered.service.workIncome()).scopeCorrection.status, 'completed')
    assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 2)
    assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger WHERE reason=?', 'work-income').n, 1)
    assert.equal(f.nativeOpens(), 1)
  })
}

test('read-only maintenance retains the canonical provider without usage, settlement, history correction or owner writes', async t => {
  const f = fixture(t, true, true), normal = f.owner()
  f.retire()
  await normal.connect(origin)
  await drain()
  const original = (await normal.service.summary()).wallet
  normal.dispose()
  const records = structuredClone(f.records), submitted = f.submitted.length
  let usageReads = 0, writes = 0
  f.ctx.get('usage').readWork = async () => {
    usageReads++
    throw Error('Read-only must not read usage')
  }
  const transaction = f.documents.transaction
  f.documents.transaction = async value => {
    writes++
    return transaction(value)
  }
  f.http.connectAccount = async () => {
    throw Error('Read-only must not enroll through Native')
  }
  const config = {
    readOnly: true,
    legacyPetHistoryCorrection: { action: 'confirm-never-enabled', statement: 'Must not execute in maintenance' },
  }
  const readonly = f.owner(config)
  config.readOnly = false // The generation snapshots its explicitly adopted mode.
  await readonly.connect(origin)
  f.change(9000000)
  await drain()
  assert.equal(readonly.readOnly, true)
  assert.deepEqual((await readonly.service.summary()).wallet, original)
  assert.equal((await readonly.service.summary()).available, 0)
  assert.equal((await readonly.service.ledger()).status, 'ready')
  await assert.rejects(readonly.readWorkUsage(), /read-only/)
  assert.equal(usageReads, 0)
  assert.equal(writes, 0)
  assert.equal(f.submitted.length, submitted)
  assert.deepEqual(f.records, records)
  readonly.dispose()
  assert.equal((await readonly.service.summary()).status, 'unavailable')
  assert.equal(writes, 0)
})
test('read-only startup refuses wallet initialization and missing local enrollment without Native fallback', async t => {
  const empty = fixture(t, true, true), readonlyEmpty = empty.owner({ readOnly: true })
  await assert.rejects(readonlyEmpty.connect(origin), /existing original wallet record/)
  assert.equal(empty.records.size, 0)
  assert.equal(empty.nativeOpens(), 0)
  const f = fixture(t, true, true), normal = f.owner()
  f.retire()
  await normal.connect(origin)
  await drain()
  normal.dispose()
  const records = structuredClone(f.records), native = f.nativeOpens()
  f.http.connectLocalAccount = async () => ({ status: 'unavailable', code: 'local-wallet-not-enrolled' })
  const readonly = f.owner({ readOnly: true })
  await assert.rejects(readonly.connect(origin), /local-wallet-not-enrolled/)
  assert.equal(f.nativeOpens(), native)
  assert.deepEqual(f.records, records)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 1)
})

test('expired canonical read can recover existing local authority and income retirement readiness without restarting owner', async t => {
  const f = fixture(t, true, true), s = f.owner()
  await s.connect(origin)
  await drain()
  const originalWallet = (await s.service.summary()).wallet
  const originalRecord = structuredClone(f.records.get('economy-local-wallet-v1').value)
  const originalClient = s.client, nativeOpens = f.nativeOpens(), baselineSubmits = f.submitted.length
  const actualRead = f.http.request, actualOpen = f.http.connectLocalAccount
  let expiredConnection, refuse = true, localOpens = 0, rejectedReads = 0, posts = 0
  f.http.request = async input => {
    if (input.method === 'POST') posts++
    if (!expiredConnection) expiredConnection = input.connection.id
    if (input.connection.id === expiredConnection) {
      rejectedReads++
      return {
        status: 'accepted',
        value: {
          statusCode: 401,
          body: JSON.stringify({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Credential expired, revoked, or unknown',
            },
          }),
        },
      }
    }
    return actualRead(input)
  }
  f.http.connectLocalAccount = async input => {
    localOpens++
    return refuse ? { status: 'unavailable', code: 'permission-denied' } : actualOpen(input)
  }
  f.change(10000)
  await drain()
  assert.equal(s.service.incomeStatus().status, 'unavailable')
  assert.equal(s.service.incomeStatus().stage, 'retirement')
  assert.equal(f.submitted.length, baselineSubmits)
  assert.equal(s.client, originalClient) // error stage is recoverable, not owner disposal
  refuse = false
  assert.equal((await s.service.summary()).status, 'ready')
  f.change(20000)
  await drain()
  assert.equal(s.service.incomeStatus().status, 'ready')
  assert.equal(s.service.incomeStatus().stage, 'settlement')
  assert.deepEqual((await s.service.summary()).wallet, originalWallet)
  assert.deepEqual(f.records.get('economy-local-wallet-v1').value, originalRecord)
  assert.equal(f.nativeOpens(), nativeOpens)
  assert.equal(posts, 0) // read recovery does not replay a money or income POST
  assert.equal(localOpens, 2) // refused attempt, then single successful existing-local reopen
  assert.equal(rejectedReads, 2)
})

test('real backend local delegation revocation cannot be silently restored by expired-read recovery', async t => {
  const { LocalWalletIdentities } = await import('../../dist/server/local-wallet-identities.js')
  const f = fixture(t, true, true), s = f.owner()
  await s.connect(origin)
  await drain()
  const originalRead = f.http.request, originalOpen = f.http.connectLocalAccount
  let opens = 0, nativeOpens = f.nativeOpens(), posts = 0
  f.http.connectLocalAccount = async input => {
    opens++
    return originalOpen(input)
  }
  f.http.request = async input => {
    if (input.method === 'POST') posts++
    try {
      return await originalRead(input)
    } catch (error) {
      return {
        status: 'accepted',
        value: {
          statusCode: error.status ?? 500,
          body: JSON.stringify({
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        },
      }
    }
  }
  // Isolated in-memory fixture only: invoke the actual trusted revocation operation, never actual runtime storage.
  const identity = f.e.store.one(
    'SELECT realm,subject,keyFingerprint FROM localWalletIdentities WHERE instance=?',
    'local',
  )
  new LocalWalletIdentities(f.e.store, 'local', identity.realm).revoke(identity)
  await assert.rejects(s.service.summary(), { status: 403, code: 'INVALID_SIGNATURE' })
  assert.equal(opens, 1)
  assert.equal(f.nativeOpens(), nativeOpens)
  assert.equal(posts, 0)
})
