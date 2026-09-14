import { managedSourceBytes } from '@cordisx/protocol/managed-source/v1'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { createEconomyServer } from '../dist/server/http.js'
import { ManagedWorkIncome } from '../dist/server/managed-work.js'
function fixture(t, origin = 'http://127.0.0.1:8788') {
  const e = new Economy(':memory:')
  t.after(() => e.close())
  const host = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519')
  let now = 1800000000000
  const binding = { origin, instanceId: 'local', sourceId: 'economy-local', audience: 'work-income' }
  const m = new ManagedWorkIncome(e.store, {
    binding,
    hostPublicKey: host.publicKey.export({ type: 'spki', format: 'pem' }),
    serverPrivateKey: server.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }, () => now)
  const challenge = () =>
    m.challenge(
      new URLSearchParams({ sourceId: binding.sourceId, instanceId: binding.instanceId, audience: binding.audience }),
    )
  const snapshot = (tokens, revision) => ({
    schemaVersion: 2,
    status: 'ready',
    policyId: 'codex-local-work-input-output-v2',
    coverage: 'partial',
    enabledAt: 1,
    inputTokens: tokens,
    outputTokens: 0,
    eligibleTokens: tokens,
    scopeId: 'work-scope',
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
  const assertion = (tokens, revision, extra = {}) => {
    const c = challenge()
    assert(verify(null, managedSourceBytes(c.payload), server.publicKey, Buffer.from(c.signature, 'base64url')))
    const payload = {
      ...c.payload,
      contract: 'cordisx.managed-work-observation/v1',
      subject: `codex:${'a'.repeat(43)}`,
      leaseId: 'l'.repeat(43),
      continuity: 'continuous',
      snapshot: snapshot(tokens, revision),
      ...extra,
    }
    return { payload, signature: sign(null, managedSourceBytes(payload), host.privateKey).toString('base64url') }
  }
  const submit = (tokens, revision, extra) => {
    const a = assertion(tokens, revision, extra), result = m.submit(a)
    assert(
      verify(null, managedSourceBytes(result.payload), server.publicKey, Buffer.from(result.signature, 'base64url')),
    )
    assert.equal(result.payload.nonce, a.payload.nonce)
    assert.equal(result.payload.subject, a.payload.subject)
    return result.payload.result
  }
  return {
    e,
    m,
    host,
    binding,
    assertion,
    submit,
    advance: ms => {
      now += ms
    },
  }
}
test('signed actual Host usage creates zero wallet and returns pinned signed server-derived unlimited income', t => {
  const f = fixture(t)
  const first = f.submit(1000000, 1)
  assert.equal(first.wallet.available, 0)
  assert.equal(first.receipt.amount, 0)
  assert.match(first.wallet.accountId, /^codex:[a-f0-9]{64}$/)
  assert.equal(f.submit(2000000, 2).wallet.available, 100)
  assert.equal(f.submit(3000000, 3).wallet.available, 200)
  assert.equal(f.e.store.one('SELECT supply FROM instances').supply, 200)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM sources').n, 0)
})
test('bad signature, arbitrary amount, wrong audience and reused challenge cannot mint', t => {
  const f = fixture(t), a = f.assertion(1, 1)
  const bad = structuredClone(a)
  bad.payload.snapshot.eligibleTokens = 1000000
  assert.throws(() => f.m.submit(bad), /signature is invalid/)
  assert.throws(() => f.m.submit(f.assertion(1, 1, { amount: 1000 })), /Invalid managed/)
  assert.throws(() => f.m.submit(f.assertion(1, 1, { audience: 'source-account' })), /Invalid managed/)
  assert.equal(f.m.submit(a).payload.result.wallet.available, 0)
  assert.throws(() => f.m.submit(a), /consumed/)
  assert.equal(f.e.store.one('SELECT supply FROM instances').supply, 0)
})
test('new lease, idle heartbeat gap and explicit baseline forfeit historical work without resetting frontier', t => {
  const f = fixture(t)
  f.submit(1, 1)
  assert.equal(f.submit(10001, 2).receipt.amount, 1)
  f.advance(16000)
  assert.equal(f.submit(1000001, 3).receipt.amount, 0)
  assert.equal(f.submit(1010001, 4).receipt.amount, 1)
  assert.equal(f.submit(2000001, 5, { leaseId: 'm'.repeat(43) }).receipt.amount, 0)
  assert.equal(f.submit(2010001, 6, { leaseId: 'm'.repeat(43) }).receipt.amount, 1)
  assert.throws(() => f.submit(1, 7, { continuity: 'baseline' }), /backwards/)
})
test('fresh challenge retry recovers exact receipt; continuous idle heartbeat keeps lease alive', t => {
  const f = fixture(t)
  f.submit(1, 1)
  const receipt = f.submit(10001, 2).receipt
  for (let n = 0; n < 5; n++) {
    f.advance(5000)
    assert.deepEqual(f.submit(10001, 2).receipt, receipt)
  }
  assert.equal(f.submit(20001, 3).receipt.amount, 1)
  assert.equal(f.e.store.one('SELECT supply FROM instances').supply, 2)
})
test('expired observation and different identity in same work scope reject', t => {
  const f = fixture(t), old = f.assertion(1, 1)
  f.advance(31000)
  assert.throws(() => f.m.submit(old), /Invalid managed/)
  f.submit(1, 1)
  assert.throws(() => f.submit(10001, 2, { subject: `codex:${'b'.repeat(43)}` }), /already has a wallet/)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM accounts WHERE kind=?', 'user').n, 1)
})

test('real HTTP routes accept only pinned signed sessions/usage; ordinary bearer does not authorize issuance', async t => {
  const e = new Economy(':memory:'), options = {}, server = createEconomyServer(e, options)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    e.close()
  })
  const origin = `http://127.0.0.1:${server.address().port}`, f = fixture(t, origin)
  const host = generateKeyPairSync('ed25519'), serviceKey = generateKeyPairSync('ed25519')
  const trust = audience => ({
    binding: { ...f.binding, audience },
    hostPublicKey: host.publicKey.export({ type: 'spki', format: 'pem' }),
    serverPrivateKey: serviceKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  })
  options.workIncome = new ManagedWorkIncome(e.store, trust('work-income'))
  options.sourceAccount = new ManagedWorkIncome(e.store, trust('source-account'))
  const submit = async (audience, extra) => {
    const query = new URLSearchParams({ sourceId: f.binding.sourceId, instanceId: 'local', audience })
    const challenge = await (await fetch(`${origin}/v1/auth/host/challenge?${query}`)).json()
    const payload = {
      ...challenge.payload,
      contract: audience === 'work-income'
        ? 'cordisx.managed-work-observation/v1'
        : 'cordisx.managed-source-assertion/v1',
      subject: `codex:${'a'.repeat(43)}`,
      ...extra,
    }
    const response = await fetch(
      `${origin}${audience === 'work-income' ? '/v1/income/work' : '/v1/auth/host/session'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload,
          signature: sign(null, managedSourceBytes(payload), host.privateKey).toString('base64url'),
        }),
      },
    )
    if (audience === 'work-income') {
      assert.equal(response.status, 410)
      return await response.json()
    }
    assert.equal(response.status, 200)
    const result = await response.json()
    assert(
      verify(
        null,
        managedSourceBytes(result.payload),
        serviceKey.publicKey,
        Buffer.from(result.signature, 'base64url'),
      ),
    )
    return result.payload.result
  }
  const session = await submit('source-account', { displayName: 'mutable nickname' })
  const me = await (await fetch(`${origin}/v1/me`, { headers: { authorization: `Bearer ${session.sessionToken}` } }))
    .json()
  assert.equal(me.accountId, session.account.id)
  assert.equal(me.available, 0)
  const first = await submit('work-income', {
    snapshot: f.assertion(1, 1).payload.snapshot,
    leaseId: 'l'.repeat(43),
    continuity: 'continuous',
  })
  assert.equal(first.error.code, 'ENTRY_RETIRED')
  const second = await submit('work-income', {
    snapshot: f.assertion(10001, 2).payload.snapshot,
    leaseId: 'l'.repeat(43),
    continuity: 'continuous',
  })
  assert.equal(second.error.code, 'ENTRY_RETIRED')
  const attack = await fetch(`${origin}/v1/income/work`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 1000000 }),
  })
  assert.equal(attack.status, 410)
  assert.equal(e.store.one('SELECT supply FROM instances').supply, 0)
})
