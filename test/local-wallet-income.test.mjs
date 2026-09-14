import { localWalletBytes } from '@cordisx/protocol/local-wallet/v1'
import { managedSourceBytes } from '@cordisx/protocol/managed-source/v1'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { createEconomyServer } from '../dist/server/http.js'
import { LocalWalletIncome } from '../dist/server/local-wallet-income.js'
import { ManagedWorkIncome } from '../dist/server/managed-work.js'
function fixture(t, origin = 'http://127.0.0.1:8788', existing) {
  const e = existing ?? new Economy(':memory:')
  if (!existing) t.after(() => e.close())
  const root = generateKeyPairSync('ed25519'),
    server = generateKeyPairSync('ed25519'),
    local = generateKeyPairSync('ed25519')
  const der = local.publicKey.export({ type: 'spki', format: 'der' })
  const subject = 'host-local:' + createHash('sha256').update(der).digest('base64url')
  const nativeSubject = 'codex:' + 'a'.repeat(43)
  const trust = audience => ({
    binding: { origin, instanceId: 'canonical', sourceId: 'economy-local', audience },
    hostPublicKey: root.publicKey.export({ type: 'spki', format: 'pem' }),
    serverPrivateKey: server.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  })
  const native = new ManagedWorkIncome(e.store, trust('source-account'))
  const nativeWork = new ManagedWorkIncome(e.store, trust('work-income'))
  const enrollment = new LocalWalletIncome(e.store, trust('source-account'), 'local-wallet-enrollment')
  const account = new LocalWalletIncome(e.store, trust('source-account'), 'local-wallet')
  const work = new LocalWalletIncome(e.store, trust('work-income'), 'local-work-income')
  const query = binding =>
    new URLSearchParams({ sourceId: binding.sourceId, instanceId: binding.instanceId, audience: binding.audience })
  const nativeChallenge = native.challenge(query(native.binding)).payload
  const nativePayload = { ...nativeChallenge, contract: 'cordisx.managed-source-assertion/v1', subject: nativeSubject }
  const old = native.session({
    payload: nativePayload,
    signature: sign(null, managedSourceBytes(nativePayload), root.privateKey).toString('base64url'),
  }).payload.result
  const assertion = (controller, contract, extra = {}, key = local.privateKey) => {
    const c = controller.challenge(query(controller.binding))
    assert(verify(null, localWalletBytes(c.payload), server.publicKey, Buffer.from(c.signature, 'base64url')))
    const payload = { ...c.payload, contract, subject, ...extra }
    return { payload, signature: sign(null, localWalletBytes(payload), key).toString('base64url') }
  }
  const enrollAssertion = extra =>
    assertion(enrollment, 'cordisx.local-wallet-enrollment/v1', {
      nativeSubject,
      publicKey: der.toString('base64'),
      ...extra,
    }, root.privateKey)
  const enroll = () => enrollment.enroll(enrollAssertion(), old.sessionToken)
  const snapshot = (tokens, revision) => ({
    schemaVersion: 2,
    status: 'ready',
    policyId: 'codex-local-work-input-output-v2',
    coverage: 'partial',
    enabledAt: 1,
    inputTokens: tokens - 1,
    outputTokens: 1,
    eligibleTokens: tokens,
    scopeId: 'original-work-scope',
    sourceId: 'codex-local',
    epoch: 'epoch-1',
    revision,
    observedThrough: revision,
    classification: {
      version: 'host-game-cwd-v1',
      hostGameTasks: 'excluded',
      forksAndSubagents: 'excluded',
      unknownSources: 'excluded',
    },
  })
  const submit = (tokens, revision, extra = {}) =>
    work.submit(
      assertion(work, 'cordisx.local-work-observation/v1', {
        snapshot: snapshot(tokens, revision),
        leaseId: 'l'.repeat(43),
        continuity: 'continuous',
        ...extra,
      }),
    ).payload.result
  return {
    e,
    root,
    server,
    local,
    subject,
    nativeSubject,
    native,
    nativeWork,
    enrollment,
    account,
    work,
    old,
    query,
    assertion,
    enrollAssertion,
    enroll,
    snapshot,
    submit,
  }
}
test('fresh enrollment binds the original account; local session and future usage retain the same canonical ledger', t => {
  const f = fixture(t)
  f.nativeWork.issuer.bind({ instanceId: 'canonical', accountId: f.old.account.id, scopeId: 'original-work-scope' })
  const original = { instanceId: 'canonical', accountId: f.old.account.id, scopeId: 'original-work-scope' }
  f.nativeWork.issuer.accept({ binding: original, snapshot: f.snapshot(1, 1), baseline: true, leaseId: 'n'.repeat(43) })
  f.nativeWork.issuer.accept({
    binding: original,
    snapshot: f.snapshot(20001, 2),
    baseline: false,
    leaseId: 'n'.repeat(43),
  })
  const before = f.e.store.all('SELECT * FROM ledger ORDER BY sequence')
  const enrolled = f.enroll()
  assert(
    verify(null, localWalletBytes(enrolled.payload), f.server.publicKey, Buffer.from(enrolled.signature, 'base64url')),
  )
  assert.equal(enrolled.payload.result.account.id, f.old.account.id)
  assert.deepEqual(f.e.store.all('SELECT * FROM ledger ORDER BY sequence'), before)
  const session = f.account.session(f.assertion(f.account, 'cordisx.local-wallet-assertion/v1')).payload.result
  assert.equal(session.account.id, f.old.account.id)
  assert.equal(f.e.request('GET', '/v1/me', session.sessionToken).available, 2)
  assert.equal(f.submit(1000001, 3, { continuity: 'baseline' }).receipt.amount, 0)
  assert.equal(f.submit(1010001, 4).receipt.amount, 1)
  assert.equal(f.submit(1001010001, 5).receipt.amount, 100000)
  assert.equal(f.e.request('GET', '/v1/me', session.sessionToken).available, 100003)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeBindings').n, 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM grants').n, 0)
})
test('enrollment rejects absent/wrong original authority and mixed key proofs without replacing the account', t => {
  const f = fixture(t)
  assert.throws(() => f.enrollment.enroll(f.enrollAssertion(), undefined), /bearer/)
  f.e.auth.createAccount('canonical', 'other')
  const other = f.e.auth.issue('canonical', 'other', 'user', 3_600_000)
  assert.throws(() => f.enrollment.enroll(f.enrollAssertion(), other.token), /must match/)
  assert.throws(
    () =>
      f.enrollment.enroll(
        f.enrollAssertion({ publicKey: f.root.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }),
        f.old.sessionToken,
      ),
    /subject must match/,
  )
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM localWalletIdentities').n, 0)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM accounts WHERE kind=?', 'user').n, 2)
})
test('only the enrolled local key can submit; extra mint fields, replay and revocation reject', t => {
  const f = fixture(t)
  assert.throws(
    () => f.account.session(f.assertion(f.account, 'cordisx.local-wallet-assertion/v1')),
    /signature invalid/,
  )
  f.enroll()
  const a = f.assertion(f.account, 'cordisx.local-wallet-assertion/v1')
  assert.throws(
    () => f.account.session(f.assertion(f.account, 'cordisx.local-wallet-assertion/v1', {}, f.root.privateKey)),
    /signature invalid/,
  )
  f.account.session(a)
  assert.throws(() => f.account.session(a), /consumed/)
  assert.throws(() => f.submit(1, 1, { amount: 1000000 }), /Invalid local assertion/)
  assert.throws(() => f.submit(1, 1, { accountId: 'other' }), /Invalid local assertion/)
  f.account.aliases.revoke({
    realm: f.account.aliases.realm,
    subject: f.subject,
    keyFingerprint: createHash('sha256').update(f.local.publicKey.export({ type: 'spki', format: 'der' })).digest(
      'hex',
    ),
  })
  assert.throws(() => f.submit(1, 1), /signature invalid/)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 0)
})
test('local balance reads remain usable while unresolved historical correction forbids income', t => {
  const f = fixture(t)
  f.enroll()
  f.work.issuer.history.apply('canonical', f.old.account.id, {
    contract: 'economy.history-declaration/v1',
    id: 'history:00000000-0000-0000-0000-000000000000',
    stage: 'begin',
    statement: 'Unresolved fixture historical owner',
  })
  const session = f.account.session(f.assertion(f.account, 'cordisx.local-wallet-assertion/v1')).payload.result
  assert.equal(f.e.request('GET', '/v1/me', session.sessionToken).accountId, f.old.account.id)
  assert.throws(() => f.submit(1, 1), /history correction/i)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 0)
})
test('real HTTP selects explicit local audiences and preserves original account; ordinary bearer cannot mint', async t => {
  const options = { localWallets: [] }, e = new Economy(':memory:')
  const http = createEconomyServer(e, options)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => http.close(resolve))
    e.close()
  })
  const origin = `http://127.0.0.1:${http.address().port}`, f = fixture(t, origin, e)
  // Trusted test setup uses the fixture Store; route validation is covered by production constructor checks.
  options.localWallets.push(f.enrollment, f.account, f.work)
  options.sourceAccount = f.native
  options.workIncome = f.nativeWork
  const post = async (path, body, token) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  const enrollment = await post('/v1/auth/host/local-wallet/enroll', f.enrollAssertion(), f.old.sessionToken)
  assert.equal(enrollment.status, 200)
  const response = await post('/v1/auth/host/session', f.assertion(f.account, 'cordisx.local-wallet-assertion/v1'))
  assert.equal(response.status, 200)
  const session = (await response.json()).payload.result
  assert.equal(session.account.id, f.old.account.id)
  assert.equal((await post('/v1/income/work', { amount: 1000000 }, session.sessionToken)).status, 410)
  assert.equal(
    (await post('/v1/income/work', f.assertion(f.account, 'cordisx.local-wallet-assertion/v1'), session.sessionToken))
      .status,
    410,
  )
  const query = f.query(f.account.binding)
  assert.equal((await fetch(origin + '/v1/auth/host/challenge?' + query)).status, 200)
  const rotatedResponse = await post('/v1/session/rotate', {}, session.sessionToken)
  assert.equal(rotatedResponse.status, 200)
  const rotated = await rotatedResponse.json()
  const secondResponse = await post('/v1/session/rotate', {}, rotated.token)
  assert.equal(secondResponse.status, 200)
  const second = await secondResponse.json()
  assert.equal((await fetch(origin + '/v1/me', { headers: { authorization: `Bearer ${second.token}` } })).status, 200)
  const peer = generateKeyPairSync('ed25519'), peerBytes = peer.publicKey.export({ type: 'spki', format: 'der' })
  const peerSubject = 'host-local:' + createHash('sha256').update(peerBytes).digest('base64url')
  assert.equal(
    (await post(
      '/v1/auth/host/local-wallet/enroll',
      f.enrollAssertion({ subject: peerSubject, publicKey: peerBytes.toString('base64') }),
      f.old.sessionToken,
    )).status,
    200,
  )
  const peerResponse = await post(
    '/v1/auth/host/session',
    f.assertion(f.account, 'cordisx.local-wallet-assertion/v1', { subject: peerSubject }, peer.privateKey),
  )
  assert.equal(peerResponse.status, 200)
  const peerSession = (await peerResponse.json()).payload.result
  const peerRotatedResponse = await post('/v1/session/rotate', {}, peerSession.sessionToken)
  assert.equal(peerRotatedResponse.status, 200)
  const peerRotated = await peerRotatedResponse.json()
  const inherited = f.e.store.all('SELECT * FROM localWalletSessions WHERE subject=?', f.subject)
  assert.equal(inherited.length, 3)
  assert(
    inherited.every(row =>
      row.instance === 'canonical' && row.realm === f.account.aliases.realm && row.subject === f.subject
    ),
  )
  const beforeCredentials = f.e.store.all('SELECT * FROM credentials ORDER BY hash')
  const beforeProvenance = f.e.store.all('SELECT * FROM localWalletSessions ORDER BY credential')
  f.e.store.db.exec(
    "CREATE TEMP TRIGGER reject_local_rotation BEFORE INSERT ON localWalletSessions BEGIN SELECT RAISE(ABORT,'injected provenance write failure'); END",
  )
  try {
    assert.equal((await post('/v1/session/rotate', {}, second.token)).status, 500)
    assert.deepEqual(f.e.store.all('SELECT * FROM credentials ORDER BY hash'), beforeCredentials)
    assert.deepEqual(f.e.store.all('SELECT * FROM localWalletSessions ORDER BY credential'), beforeProvenance)
    assert.equal((await fetch(origin + '/v1/me', { headers: { authorization: `Bearer ${second.token}` } })).status, 200)
  } finally {
    f.e.store.db.exec('DROP TRIGGER reject_local_rotation')
  }
  f.account.aliases.revoke({
    realm: f.account.aliases.realm,
    subject: f.subject,
    keyFingerprint: createHash('sha256').update(f.local.publicKey.export({ type: 'spki', format: 'der' })).digest(
      'hex',
    ),
  })
  for (const token of [session.sessionToken, rotated.token, second.token]) {
    assert.equal((await fetch(origin + '/v1/me', { headers: { authorization: `Bearer ${token}` } })).status, 401)
    assert.equal((await post('/v1/session/rotate', {}, token)).status, 401)
  }
  assert.equal(
    (await fetch(origin + '/v1/me', { headers: { authorization: `Bearer ${f.old.sessionToken}` } })).status,
    200,
  )
  assert.equal(
    (await fetch(origin + '/v1/me', { headers: { authorization: `Bearer ${peerRotated.token}` } })).status,
    200,
  )
})

test('signed durable first takeover atomically fences legacy rewards and preserves admitted deltas and remainder', async t => {
  const options = { localWallets: [] }, e = new Economy(':memory:')
  e.auth.createInstance('canonical', 100)
  const http = createEconomyServer(e, options)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => http.close(resolve))
    e.close()
  })
  const origin = `http://127.0.0.1:${http.address().port}`, f = fixture(t, origin, e)
  options.localWallets.push(f.enrollment, f.account, f.work)
  f.enroll()
  const post = (snapshot, extra = {}, contract = 'cordisx.local-work-settlement/v1', path = '/v1/income/work/settle') =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(f.assertion(f.work, contract, { snapshot, ...extra })),
    })
  const firsts = await Promise.all([post(f.snapshot(1000001, 1)), post(f.snapshot(1000001, 1))])
  for (const first of firsts) assert.equal(first.status, 200)
  const initial = (await firsts[0].json()).payload.result
  assert.deepEqual((await firsts[1].json()).payload.result.receipt, initial.receipt)
  const retriedFirst = await post(f.snapshot(1000001, 1))
  assert.equal(retriedFirst.status, 200)
  assert.deepEqual((await retriedFirst.json()).payload.result.receipt, initial.receipt)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 1)
  assert.equal(initial.receipt.amount, 100)
  assert.equal(initial.receipt.remainder, 1)
  assert.equal(e.workIncome.state('canonical', f.old.account.id).takeover.admittedPrefix.amount, 100)
  assert.equal(initial.receipt.policy, 'durable-admitted-v1')
  const state = e.workIncome.state('canonical', f.old.account.id)
  assert.equal(state.takeover.baseline.tokens, 1000001)
  assert.equal(state.takeover.legacyHistory, 'unresolved')
  assert.equal(state.records[0].kind, 'admitted-prefix')
  assert.equal(state.records[0].snapshot.inputTokens, 1000000)
  assert.equal(state.records[0].snapshot.outputTokens, 1)
  assert.equal(state.records[0].creditedTokens, 1000001)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM historyDeclarations').n, 0)
  assert.equal((await post(f.snapshot(1009001, 2))).status, 200)
  assert.equal(e.workIncome.state('canonical', f.old.account.id).remainder, 9001)
  // A replacement issuer object has no in-memory lease. The durable frontier is sufficient.
  options.localWallets[2] = new LocalWalletIncome(e.store, {
    binding: { ...f.nativeWork.binding },
    hostPublicKey: f.root.publicKey.export({ type: 'spki', format: 'pem' }),
    serverPrivateKey: f.server.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }, 'local-work-income')
  const duplicated = await Promise.all([post(f.snapshot(1010001, 3)), post(f.snapshot(1010001, 3))])
  const recovered = await Promise.all(duplicated.map(async r => {
    assert.equal(r.status, 200)
    return r.json()
  }))
  assert.deepEqual(recovered[0].payload.result.receipt, recovered[1].payload.result.receipt)
  assert.equal(recovered[0].payload.result.receipt.amount, 1)
  assert.equal(e.workIncome.state('canonical', f.old.account.id).earned, 101)
  await post(f.snapshot(1019001, 4))
  const newEpoch = { ...f.snapshot(8000001, 5), epoch: 'epoch-2' }
  const epochReply = await post(newEpoch)
  assert.equal(epochReply.status, 200)
  assert.equal((await epochReply.json()).payload.result.receipt.remainder, 9001)
  assert.equal((await post({ ...newEpoch, ...f.snapshot(8001001, 6), epoch: 'epoch-2' })).status, 200)
  assert.equal(e.workIncome.state('canonical', f.old.account.id).earned, 102)
  const old = await post(
    f.snapshot(8002001, 7),
    { continuity: 'baseline', leaseId: 'm'.repeat(43) },
    'cordisx.local-work-observation/v1',
    '/v1/income/work',
  )
  assert.equal(old.status, 410)
  assert.equal((await old.json()).error.code, 'ENTRY_RETIRED')
  e.auth.createInstance('another-realm', 1)
  e.auth.createAccount('another-realm', 'another-account')
  assert.throws(
    () =>
      e.workIncome.provision({
        instanceId: 'another-realm',
        accountId: 'another-account',
        scopeId: 'original-work-scope',
      }),
    /durable canonical issuer/,
  )
  assert.throws(
    () =>
      e.workIncome.bind({ instanceId: 'another-realm', accountId: 'another-account', scopeId: 'original-work-scope' }),
    /durable canonical issuer/,
  )
  // A subsequently provisioned finite sponsor cannot revive the old Pet work channel, even under another source alias.
  const sponsor = e.auth.createService('canonical', 'legacy-service', '*', 100).token
  e.commerce.createSource('canonical', 'renamed-source', 'legacy-service', 'reward', 50, 50, 50)
  assert.throws(() =>
    e.request('POST', '/v1/rewards/grant', sponsor, {
      sourceId: 'renamed-source',
      accountId: f.old.account.id,
      eventId: 'pet-work:' + 'b'.repeat(64),
      amount: 1,
    }, 'old-pet-grant-after-takeover'), /Historical mutation retired/)
  // All unrelated finite reward issuance is also retired.
  assert.throws(
    () =>
      e.request('POST', '/v1/rewards/grant', sponsor, {
        sourceId: 'renamed-source',
        accountId: f.old.account.id,
        eventId: 'unrelated',
        amount: 1,
      }, 'unrelated-finite-grant'),
    /retired/,
  )
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM ledger WHERE reason=?', 'work-income').n, 3)
  assert.equal(
    e.store.one('SELECT available FROM accounts WHERE instance=? AND id=?', 'canonical', f.old.account.id).available,
    102,
  )
  e.store.assertConservation('canonical')
})

test('takeover rollback leaves every fence/frontier/receipt empty and a configured old sponsor forbids pristine inference', t => {
  const e = new Economy(':memory:')
  t.after(() => e.close())
  e.auth.createInstance('canonical', 100)
  const f = fixture(t, 'http://127.0.0.1:8788', e)
  f.enroll()
  const settle = () =>
    f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot: f.snapshot(1, 1) }))
  e.store.db.exec(`CREATE TEMP TRIGGER injected_receipt_failure BEFORE INSERT ON workIncomeReceipts
    BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END`)
  assert.throws(settle, /injected receipt failure/)
  for (
    const table of [
      'workIncomeTakeovers',
      'workIncomeBindings',
      'workIncomeFrontiers',
      'workIncomeReceipts',
      'workIncomeEpochs',
      'workIncomeLeases',
    ]
  ) {
    assert.equal(e.store.one(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table)
  }
  e.store.db.exec('DROP TRIGGER injected_receipt_failure')
  const sponsor = e.auth.createService('canonical', 'original-sponsor', '*', 100).token
  e.commerce.createSource('canonical', 'original-source', 'original-sponsor', 'reward', 50, 50, 50)
  assert.equal(e.workIncome.state('canonical', f.old.account.id).status, 'reconciliation-required')
  assert.throws(settle, /Original-owner income reconciliation/)
  const event = {
    sourceId: 'original-source',
    accountId: f.old.account.id,
    eventId: 'pet-work:' + 'c'.repeat(64),
    amount: 1,
  }
  const original = e.store.idempotent(
    'canonical',
    'service:original-sponsor',
    'original-pending-recovery',
    '/v1/rewards/grant',
    event,
    () => e.commerce.grant(e.auth.authenticate(sponsor), event),
  )
  assert.throws(settle, /Original-owner income reconciliation/)
  assert.deepEqual(e.request('POST', '/v1/rewards/grant', sponsor, event, 'original-pending-recovery'), original)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM workIncomeTakeovers').n, 0)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM grants').n, 1)
  e.store.assertConservation('canonical')
})

test('concurrent real HTTP old sponsored grant and first takeover never admit both producers', async t => {
  const options = { localWallets: [] }, e = new Economy(':memory:')
  e.auth.createInstance('canonical', 100)
  const http = createEconomyServer(e, options)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => http.close(resolve))
    e.close()
  })
  const origin = `http://127.0.0.1:${http.address().port}`, f = fixture(t, origin, e)
  options.localWallets.push(f.enrollment, f.account, f.work)
  f.enroll()
  const sponsor = e.auth.createService('canonical', 'old-sponsor', '*', 100).token
  e.commerce.createSource('canonical', 'original-old-source', 'old-sponsor', 'reward', 50, 50, 50)
  const request = (path, body, token, key) =>
    fetch(origin + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    })
  const oldBody = {
    sourceId: 'original-old-source',
    accountId: f.old.account.id,
    eventId: 'pet-work:' + 'd'.repeat(64),
    amount: 1,
  }
  const [newReply, oldReply] = await Promise.all([
    request(
      '/v1/income/work/settle',
      f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot: f.snapshot(10001, 1) }),
    ),
    request('/v1/rewards/grant', oldBody, sponsor, 'original-grant-racing-takeover'),
  ])
  assert.equal(newReply.status, 409)
  assert.equal(oldReply.status, 410)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM workIncomeTakeovers').n, 0)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM workIncomeBindings').n, 0)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 0)
  assert.equal(e.store.one('SELECT COUNT(*) AS n FROM grants').n, 0)
  const replay = await request('/v1/rewards/grant', oldBody, sponsor, 'original-grant-racing-takeover')
  assert.equal(replay.status, 410)
  assert.deepEqual(await replay.json(), await oldReply.json())
  e.store.assertConservation('canonical')
})

test('local delegation revoked after signature verification cannot enter the final financial transaction', t => {
  const f = fixture(t)
  f.enroll()
  const accept = f.work.issuer.accept.bind(f.work.issuer)
  let finalAcceptReached = false
  const identity = {
    realm: f.work.aliases.realm,
    subject: f.subject,
    keyFingerprint: createHash('sha256').update(f.local.publicKey.export({ type: 'spki', format: 'der' })).digest(
      'hex',
    ),
  }
  f.work.issuer.accept = observation => {
    f.work.aliases.revoke(identity)
    assert.equal(f.e.store.one('SELECT revoked FROM localWalletIdentities WHERE subject=?', f.subject).revoked, 1)
    assert.equal(typeof observation.authorization, 'function')
    finalAcceptReached = true
    return accept(observation)
  }
  assert.throws(
    () => f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot: f.snapshot(4079096, 1) })),
    error =>
      error.code === 'UNAUTHORIZED' && error.status === 401
      && error.message === 'Local wallet authority is unavailable',
  )
  assert.equal(finalAcceptReached, true)
  for (
    const table of [
      'workIncomeTakeovers',
      'workIncomeBindings',
      'workIncomeFrontiers',
      'workIncomeReceipts',
      'workIncomeObservations',
      'ledger',
    ]
  ) {
    assert.equal(f.e.store.one(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table)
  }
})

test('durable source conflicts reject before any income state changes in the same or a different epoch', t => {
  const f = fixture(t)
  f.enroll()
  const settle = snapshot => f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot }))
  settle(f.snapshot(4079096, 1))
  const tables = [
    'accounts',
    'workIncomeTakeovers',
    'workIncomeBindings',
    'workIncomeFrontiers',
    'workIncomeEpochs',
    'workIncomeReceipts',
    'workIncomeObservations',
    'ledger',
  ]
  const rows = () => tables.map(table => f.e.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  const before = rows()
  for (const epoch of ['epoch-1', 'epoch-2']) {
    assert.throws(
      () => settle({ ...f.snapshot(9999999, 2), sourceId: 'different-work-source', epoch }),
      error =>
        error.code === 'FRONTIER_CONFLICT' && error.status === 409
        && error.message === 'Durable work source cannot change',
    )
    assert.deepEqual(rows(), before)
    assert.equal(f.e.workIncome.state('canonical', f.old.account.id).remainder, 9096)
  }
  const anchored = settle({ ...f.snapshot(9999999, 2), epoch: 'epoch-2' })
  assert.equal(anchored.payload.result.receipt.amount, 0)
  assert.equal(anchored.payload.result.receipt.remainder, 9096)
})

const correctionPlan = (f, zero) => ({
  contract: 'economy.empty-work-scope-correction/v1',
  instanceId: 'canonical',
  accountId: f.old.account.id,
  fromScopeId: 'original-work-scope',
  toScopeId: 'canonical-preserved-work-scope',
  expectedEventId: zero.payload.result.receipt.eventId,
  evidenceDigest: 'a'.repeat(64),
})
const correctionSettle = (f, tokens = 0, revision = 0, scopeId = 'original-work-scope') =>
  f.work.settle(
    f.assertion(f.work, 'cordisx.local-work-settlement/v1', {
      snapshot: {
        ...f.snapshot(tokens, revision),
        scopeId,
        ...(scopeId === 'canonical-preserved-work-scope' ? { epoch: 'canonical-preserved-epoch' } : {}),
      },
    }),
  )

test('explicit operator zero-scope correction preserves old facts and atomically credits only the verified correct admitted prefix once', async t => {
  const f = fixture(t)
  f.enroll()
  // Zero snapshot must have zero input as well as output; fixture ordinarily has one output token.
  const zeroSnapshot = { ...f.snapshot(0, 0), inputTokens: 0, outputTokens: 0 }
  const zero = f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot: zeroSnapshot }))
  const plan = correctionPlan(f, zero)
  const beforeReceipt = f.e.store.one('SELECT receipt FROM workIncomeReceipts').receipt
  const beforeObservation = f.e.store.one('SELECT record FROM workIncomeObservations').record
  const prepared = f.e.workIncome.corrections.prepare(plan)
  assert.equal(prepared.status, 'prepared')
  assert.deepEqual(f.e.workIncome.corrections.prepare(plan), prepared)
  assert.equal(f.e.store.one('SELECT scope FROM workIncomeBindings').scope, plan.fromScopeId)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 0)
  assert.throws(() => correctionSettle(f, 10001, 1), error => error.code === 'WORK_SCOPE_RETIRED')
  assert.throws(
    () =>
      f.work.settle(
        f.assertion(f.work, 'cordisx.local-work-settlement/v1', {
          snapshot: { ...zeroSnapshot, revision: 1, observedThrough: 1 },
        }),
      ),
    error => error.code === 'WORK_SCOPE_RETIRED',
  )
  assert.throws(
    () =>
      f.work.submit(
        f.assertion(f.work, 'cordisx.local-work-observation/v1', {
          snapshot: { ...zeroSnapshot, revision: 1, observedThrough: 1 },
          continuity: 'baseline',
          leaseId: 'l'.repeat(43),
        }),
      ),
    error => error.code === 'WORK_SCOPE_RETIRED',
  )
  for (
    const binding of [{ instanceId: 'other-realm', accountId: 'other-user', scopeId: plan.toScopeId }, {
      instanceId: 'canonical',
      accountId: 'other-user',
      scopeId: plan.toScopeId,
    }]
  ) {
    f.e.workIncome.provisionIdentity(binding.instanceId, binding.accountId)
    assert.throws(() => f.e.workIncome.bind(binding), error => error.code === 'SCOPE_CORRECTION_CONFLICT')
    assert.throws(
      () =>
        f.e.workIncome.accept({
          binding,
          snapshot: { ...f.snapshot(4079096, 9), scopeId: plan.toScopeId, epoch: 'canonical-preserved-epoch' },
          baseline: true,
          policy: 'durable-admitted-v1',
        }),
      error => error.code === 'SCOPE_CORRECTION_CONFLICT',
    )
  }
  assert.throws(
    () => f.e.workIncome.provision({ instanceId: 'other-realm', accountId: 'other-user', scopeId: plan.toScopeId }),
    error => error.code === 'SCOPE_CORRECTION_CONFLICT',
  )
  const replies = await Promise.all([
    Promise.resolve().then(() => correctionSettle(f, 4079096, 9, plan.toScopeId)),
    Promise.resolve().then(() => correctionSettle(f, 4079096, 9, plan.toScopeId)),
  ])
  const receipt = replies[0].payload.result.receipt
  assert.deepEqual(receipt, replies[1].payload.result.receipt)
  assert.equal(receipt.amount, 407)
  assert.equal(receipt.remainder, 9096)
  assert.equal(receipt.binding.accountId, f.old.account.id)
  const state = f.e.workIncome.state('canonical', f.old.account.id)
  assert.equal(state.earned, 407)
  assert.equal(state.scopeCorrection.status, 'completed')
  assert.deepEqual(state.scopeCorrection.receipt, receipt)
  assert.equal(state.scopeCorrection.audit.workIncomeReceipts[0].receipt, beforeReceipt)
  assert.equal(state.scopeCorrection.audit.workIncomeObservations[0].record, beforeObservation)
  assert.equal(
    f.e.store.one('SELECT receipt FROM workIncomeReceipts WHERE event=?', plan.expectedEventId).receipt,
    beforeReceipt,
  )
  assert.equal(
    f.e.store.one('SELECT record FROM workIncomeObservations WHERE event=?', plan.expectedEventId).record,
    beforeObservation,
  )
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 1)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 2)
  assert.equal(state.records[0].kind, 'admitted-prefix-correction')
  assert.equal(state.takeover.scopeId, plan.toScopeId)
  assert.throws(() => correctionSettle(f, 4079999, 10, plan.fromScopeId), error => error.code === 'WORK_SCOPE_RETIRED')
  // Exact committed old zero receipt is readonly recoverable even though this scope cannot produce again.
  const replayZero = f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot: zeroSnapshot }))
  assert.deepEqual(replayZero.payload.result.receipt, zero.payload.result.receipt)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 1)
  f.e.store.assertConservation('canonical')
})

test('scope correction rejects mismatched zero evidence, additional history and already bound correct scopes', async t => {
  for (const scenario of ['nonzero', 'extra-record', 'wrong-event', 'already-bound', 'arbitrary-amount']) {
    await t.test(scenario, child => {
      const f = fixture(child)
      f.enroll()
      const snapshot = {
        ...f.snapshot(scenario === 'nonzero' ? 1 : 0, 0),
        inputTokens: 0,
        outputTokens: scenario === 'nonzero' ? 1 : 0,
      }
      const zero = f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot }))
      const plan = correctionPlan(f, zero)
      if (scenario === 'extra-record') correctionSettle(f, 1, 1)
      if (scenario === 'wrong-event') plan.expectedEventId = 'work:' + 'b'.repeat(64)
      if (scenario === 'already-bound') {
        f.e.workIncome.provision({ instanceId: 'other-realm', accountId: 'other-user', scopeId: plan.toScopeId })
      }
      if (scenario === 'arbitrary-amount') plan.amount = 407
      assert.throws(
        () => f.e.workIncome.corrections.prepare(plan),
        error => ['SCOPE_CORRECTION_CONFLICT', 'INVALID_INPUT'].includes(error.code),
      )
      assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeScopeCorrections').n, 0)
    })
  }
})

test('scope correction rechecks state and trusted source inside the final money transaction and rolls back every activation on failure', async t => {
  for (
    const scenario of [
      'changed-history',
      'mutated-receipt',
      'changed-frontier',
      'wrong-source',
      'receipt-write-failure',
    ]
  ) {
    await t.test(scenario, child => {
      const f = fixture(child)
      f.enroll()
      const zero = f.work.settle(
        f.assertion(f.work, 'cordisx.local-work-settlement/v1', {
          snapshot: { ...f.snapshot(0, 0), inputTokens: 0, outputTokens: 0 },
        }),
      )
      const plan = correctionPlan(f, zero)
      f.e.workIncome.corrections.prepare(plan)
      if (scenario === 'changed-history') {
        f.e.commerce.createItem('canonical', 'late-free-item', 'Original free item', 0, 'original-free-item')
        f.e.commerce.purchase({ kind: 'user', instanceId: 'canonical', subject: f.old.account.id }, {
          itemId: 'late-free-item',
          quantity: 1,
        })
      }
      if (scenario === 'mutated-receipt') {
        const original = f.e.store.one('SELECT receipt FROM workIncomeReceipts').receipt
        f.e.store.run(
          'UPDATE workIncomeReceipts SET receipt=?',
          JSON.stringify({ ...JSON.parse(original), coverage: 'tampered-coverage' }),
        )
      }
      if (scenario === 'changed-frontier') {
        const original = JSON.parse(f.e.store.one('SELECT cursor FROM workIncomeFrontiers').cursor)
        f.e.store.run(
          'UPDATE workIncomeFrontiers SET cursor=?',
          JSON.stringify({ ...original, observedThrough: original.observedThrough + 1 }),
        )
      }
      if (scenario === 'receipt-write-failure') {
        f.e.store.db.exec(
          "CREATE TEMP TRIGGER fail_corrected_receipt BEFORE INSERT ON workIncomeReceipts BEGIN SELECT RAISE(ABORT,'ordered corrected receipt failure'); END",
        )
      }
      const snapshot = {
        ...f.snapshot(4079096, 9),
        scopeId: plan.toScopeId,
        epoch: 'canonical-preserved-epoch',
        ...(scenario === 'wrong-source' ? { sourceId: 'different-source' } : {}),
      }
      assert.throws(
        () => f.work.settle(f.assertion(f.work, 'cordisx.local-work-settlement/v1', { snapshot })),
        scenario === 'receipt-write-failure'
          ? /ordered corrected receipt failure/
          : error => error.code === 'SCOPE_CORRECTION_CONFLICT',
      )
      const state = f.e.workIncome.state('canonical', f.old.account.id)
      assert.equal(state.scopeCorrection.status, 'prepared')
      assert.equal(state.cursor.scopeId, plan.fromScopeId)
      assert.equal(state.cursor.tokens, 0)
      assert.equal(state.remainder, 0)
      assert.equal(state.earned, 0)
      assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM ledger').n, 0)
      assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeReceipts').n, 1)
      assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM workIncomeObservations').n, 1)
      assert.equal(f.e.store.one('SELECT scope FROM workIncomeBindings').scope, plan.fromScopeId)
      assert.equal(f.e.store.one('SELECT scope FROM workIncomeTakeovers').scope, plan.fromScopeId)
      f.e.store.assertConservation('canonical')
    })
  }
})
