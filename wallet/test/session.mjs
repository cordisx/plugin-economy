import assert from 'node:assert/strict'
import test from 'node:test'
import { WalletSession } from '../.cache/test-runtime/session.js'
function host() {
  const calls = [], revoked = []
  const connection = {
    contract: 'cordisx.http-connection/v1',
    id: 'opaque',
    origin: 'https://economy.test',
    credential: 'bearer',
  }
  return {
    calls,
    revoked,
    api: {
      contract: 'cordisx.http-client/v1',
      authorize: async input => {
        calls.push(input)
        return { status: 'accepted', value: connection }
      },
      request: async input => {
        calls.push(input)
        return {
          status: 'accepted',
          value: {
            statusCode: 200,
            contentType: 'application/json',
            body: JSON.stringify({ instanceId: 'one', accountId: 'alice', available: 100, reserved: 0 }),
          },
        }
      },
      revoke: async value => {
        revoked.push(value)
        return { status: 'accepted', value: null }
      },
    },
  }
}
test('wallet uses only opaque Host connections and fixed same-origin paths', async () => {
  const h = host(), session = new WalletSession(h.api)
  assert.equal((await session.connect('https://economy.test')).accountId, 'alice')
  assert.deepEqual(h.calls[0], { origin: 'https://economy.test', credential: 'bearer' })
  assert.equal(h.calls[1].path, '/v1/me')
  assert.equal(h.calls[1].headers.authorization, undefined)
  const signal = h.calls[1].signal
  await session.disconnect()
  assert(signal.aborted)
  assert.equal(h.revoked.length, 1)
  assert.equal(session.client, undefined)
})
test('authorization completing after disposal is immediately revoked', async () => {
  const h = host()
  let release
  h.api.authorize = () =>
    new Promise(resolve => {
      release = resolve
    })
  const session = new WalletSession(h.api), connected = session.connect('https://economy.test')
  await Promise.resolve()
  session.dispose()
  release({
    status: 'accepted',
    value: { contract: 'cordisx.http-connection/v1', id: 'late', origin: 'https://economy.test', credential: 'bearer' },
  })
  await assert.rejects(connected, /closed/)
  assert.equal(h.revoked.length, 1)
  assert.equal(session.client, undefined)
})
test('unavailable Host is explicit and invalid origins never trigger credential capture', async () => {
  assert.equal(new WalletSession(undefined).available, false)
  const h = host(), session = new WalletSession(h.api)
  await assert.rejects(session.connect('http://outside.test'))
  await assert.rejects(session.connect('https://economy.test/path'))
  assert.equal(h.calls.length, 0)
})

function localHost(code = 'local-wallet-not-enrolled') {
  const calls = [], revoked = []
  let enrolled = false
  const connection = id => ({
    contract: 'cordisx.http-connection/v1',
    id,
    origin: 'http://127.0.0.1:8788',
    credential: 'bearer',
  })
  const api = {
    contract: 'cordisx.http-client/v4',
    connectLocalAccount: async binding => {
      calls.push(['local', binding])
      return enrolled
        ? { status: 'accepted', value: { connection: connection('local') } }
        : { status: 'rejected', code }
    },
    connectAccount: async binding => {
      calls.push(['native', binding])
      return { status: 'accepted', value: { connection: connection('native') } }
    },
    enrollLocalWallet: async input => {
      calls.push(['enroll', input])
      enrolled = true
      return { status: 'accepted', value: { statusCode: 200 } }
    },
    request: async input => {
      calls.push(['read', input.connection.id])
      return {
        status: 'accepted',
        value: {
          statusCode: 200,
          body: JSON.stringify({ instanceId: 'canonical', accountId: 'original', available: 7, reserved: 0 }),
        },
      }
    },
    revoke: async value => {
      revoked.push(value.id)
      return { status: 'accepted', value: null }
    },
  }
  return { api, calls, revoked }
}
const localBinding = {
  origin: 'http://127.0.0.1:8788',
  instanceId: 'canonical',
  sourceId: 'economy-local',
  audience: 'source-account',
}
test('first local enrollment verifies original immutable account before delegating and revokes temporary Native handle', async () => {
  const h = localHost(), session = new WalletSession(h.api)
  const wallet = await session.connect(localBinding.origin, localBinding, {
    expected: { instanceId: 'canonical', accountId: 'original' },
  })
  assert.equal(wallet.accountId, 'original')
  assert.equal(wallet.available, 7)
  assert.deepEqual(h.calls.map(call => call[0]), ['local', 'native', 'read', 'enroll', 'local', 'read'])
  assert.deepEqual(h.revoked, ['native'])
  await session.disconnect()
  assert.deepEqual(h.revoked, ['native', 'local'])
})
test('another Native account cannot enroll or replace the saved wallet', async () => {
  const h = localHost(), session = new WalletSession(h.api)
  await assert.rejects(
    session.connect(localBinding.origin, localBinding, {
      expected: { instanceId: 'canonical', accountId: 'different-original' },
    }),
    /Restore original/,
  )
  assert.equal(h.calls.filter(call => call[0] === 'enroll').length, 0)
  assert.deepEqual(h.revoked, ['native'])
  assert.equal(session.client, undefined)
})
test('retirement/network refusals never fall back to Native enrollment', async () => {
  for (const code of ['stale-generation', 'network-error', 'deadline-exceeded', 'permission-denied']) {
    const h = localHost(code), session = new WalletSession(h.api)
    await assert.rejects(session.connect(localBinding.origin, localBinding, {}), /authorization/)
    assert.deepEqual(h.calls.map(call => call[0]), ['local'])
    assert.equal(session.client, undefined)
  }
})
test('owner retirement during enrollment revokes temporary authority and never opens local wallet', async () => {
  const h = localHost(), session = new WalletSession(h.api)
  let release
  h.api.enrollLocalWallet = async () =>
    new Promise(resolve => {
      release = resolve
    })
  const pending = session.connect(localBinding.origin, localBinding, {})
  while (!release) await Promise.resolve()
  session.dispose()
  release({ status: 'accepted', value: { statusCode: 200 } })
  await assert.rejects(pending, /retired/)
  assert.deepEqual(h.revoked, ['native'])
  assert.equal(h.calls.filter(call => call[0] === 'local').length, 1)
  assert.equal(session.client, undefined)
})

test('already enrolled account mismatch is rejected before publishing a new wallet client', async () => {
  const h = localHost(), session = new WalletSession(h.api)
  h.api.connectLocalAccount = async () => ({
    status: 'accepted',
    value: {
      connection: {
        contract: 'cordisx.http-connection/v1',
        id: 'local',
        origin: localBinding.origin,
        credential: 'bearer',
      },
    },
  })
  let published = 0
  session.subscribe(() => {
    if (session.client) published++
  })
  await assert.rejects(
    session.connect(localBinding.origin, localBinding, {
      expected: { instanceId: 'canonical', accountId: 'different-original' },
    }),
    /Restore original/,
  )
  assert.equal(published, 0)
  assert.equal(session.client, undefined)
  assert.deepEqual(h.revoked, ['local'])
  assert.equal(h.calls.filter(call => call[0] === 'enroll' || call[0] === 'native').length, 0)
})

test('a failed temporary authority release also retires the newly opened local handle', async () => {
  const h = localHost(), session = new WalletSession(h.api)
  h.api.revoke = async connection => {
    h.revoked.push(connection.id)
    if (connection.id === 'native') throw Error('Native revoke transport failed')
    return { status: 'accepted', value: null }
  }
  await assert.rejects(session.connect(localBinding.origin, localBinding, {}), /revoke transport failed/)
  assert(h.revoked.includes('local'))
  assert.equal(session.client, undefined)
})

const rejectedCredential = {
  status: 'accepted',
  value: {
    statusCode: 401,
    body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Credential expired, revoked, or unknown' } }),
  },
}
function recoveryHost() {
  const h = localHost(), reads = [], opens = []
  let serial = 0, expired = false
  h.api.connectLocalAccount = async binding => {
    opens.push({ ...binding })
    return {
      status: 'accepted',
      value: {
        connection: {
          contract: 'cordisx.http-connection/v1',
          id: `local-${++serial}`,
          origin: localBinding.origin,
          credential: 'bearer',
        },
      },
    }
  }
  h.api.request = async input => {
    reads.push(input)
    if (expired && input.connection.id === 'local-1') return rejectedCredential
    return {
      status: 'accepted',
      value: {
        statusCode: 200,
        body: JSON.stringify({
          instanceId: 'canonical',
          accountId: 'original',
          available: 7,
          reserved: 0,
        }),
      },
    }
  }
  return {
    ...h,
    reads,
    opens,
    expire: () => {
      expired = true
    },
  }
}
async function connectedRecoveryHost() {
  const h = recoveryHost(), session = new WalletSession(h.api)
  await session.connect(localBinding.origin, localBinding, {
    expected: { instanceId: 'canonical', accountId: 'original' },
  })
  h.expire()
  return { h, session }
}
test('simultaneous expired reads share one existing-local open, pin owner and retry each read once', async () => {
  const { h, session } = await connectedRecoveryHost()
  const originalClient = session.client
  const [one, two, three] = await Promise.all([session.client.me(), session.client.me(), session.client.me()])
  assert.deepEqual([one.accountId, two.accountId, three.accountId], ['original', 'original', 'original'])
  assert.equal(h.opens.length, 2)
  assert(h.opens.every(binding => binding.audience === 'local-wallet'))
  assert.equal(h.reads.filter(read => read.connection.id === 'local-1').length, 4)
  assert.equal(h.reads.filter(read => read.connection.id === 'local-2').length, 4) // validation + three retries
  assert.deepEqual(h.revoked, ['local-1'])
  assert.equal(session.client, originalClient)
  assert.equal(h.calls.length, 0) // no Native login/enrollment
  session.dispose()
})
test('POST expired reply is never reauthorized or replayed; payload and idempotency stay unchanged', async () => {
  const { h, session } = await connectedRecoveryHost()
  await assert.rejects(session.client.request('POST', '/purchase', { amount: 7 }, 'original-request'), {
    status: 401,
    code: 'UNAUTHORIZED',
  })
  assert.equal(h.opens.length, 1)
  const posts = h.reads.filter(read => read.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].body, '{"amount":7}')
  assert.equal(posts[0].headers['idempotency-key'], 'original-request')
  session.dispose()
})
test('renewed read still unauthorized stops after one retry', async () => {
  const { h, session } = await connectedRecoveryHost()
  const actual = h.api.request
  h.api.request = input => input.path === '/v1/items' ? Promise.resolve(rejectedCredential) : actual(input)
  await assert.rejects(session.client.items(), { status: 401, code: 'UNAUTHORIZED' })
  assert.equal(h.opens.length, 2)
  assert.equal(h.reads.filter(read => read.connection.id === 'local-2').length, 1) // validation only
  session.dispose()
})
test('missing or revoked local delegation never enrolls or falls back to Native', async () => {
  for (const code of ['local-wallet-not-enrolled', 'permission-denied', 'UNAUTHORIZED', 'stale-generation']) {
    const { h, session } = await connectedRecoveryHost()
    h.api.connectLocalAccount = async () => ({ status: 'rejected', code })
    await assert.rejects(session.client.me(), new RegExp(code))
    assert.equal(h.calls.length, 0)
    assert.equal(h.reads.length, 2)
    session.dispose()
  }
})
test('different renewed account or instance is revoked before any retry/publication', async () => {
  for (
    const owner of [{ accountId: 'other', instanceId: 'canonical' }, { accountId: 'original', instanceId: 'other' }]
  ) {
    const { h, session } = await connectedRecoveryHost()
    const actual = h.api.request
    h.api.request = input =>
      input.connection.id === 'local-2'
        ? Promise.resolve({ status: 'accepted', value: { statusCode: 200, body: JSON.stringify(owner) } })
        : actual(input)
    await assert.rejects(session.client.me(), /Restore original/)
    assert.deepEqual(h.revoked, ['local-2'])
    assert.equal(h.reads.length, 2)
    session.dispose()
  }
})
test('dispose or explicit disconnect during local open revokes late authority and cannot revive owner', async () => {
  for (const close of ['dispose', 'disconnect']) {
    const { h, session } = await connectedRecoveryHost()
    let release
    h.api.connectLocalAccount = () =>
      new Promise(resolve => {
        release = resolve
      })
    const client = session.client, pending = client.me()
    while (!release) await Promise.resolve()
    await session[close]()
    release({
      status: 'accepted',
      value: {
        connection: {
          contract: 'cordisx.http-connection/v1',
          id: 'late',
          origin: localBinding.origin,
          credential: 'bearer',
        },
      },
    })
    await assert.rejects(pending, /closed/)
    assert.equal(session.client, undefined)
    assert.deepEqual(h.revoked.sort(), ['late', 'local-1'])
    await assert.rejects(client.me(), /closed/)
    assert.equal(h.reads.length, 2)
  }
})
test('new connect generation supersedes old validation and preserves its own connection', async () => {
  const { h, session } = await connectedRecoveryHost()
  const actual = h.api.request
  let validate
  h.api.request = input =>
    input.connection.id === 'local-2'
      ? new Promise(resolve => {
        validate = resolve
      })
      : actual(input)
  const pending = session.client.me()
  while (!validate) await Promise.resolve()
  await session.connect(localBinding.origin, localBinding, {
    expected: { instanceId: 'canonical', accountId: 'original' },
  })
  const nextClient = session.client
  validate({
    status: 'accepted',
    value: { statusCode: 200, body: JSON.stringify({ instanceId: 'canonical', accountId: 'original' }) },
  })
  await assert.rejects(pending, /closed/)
  assert.equal(session.client, nextClient)
  assert.equal((await session.client.me()).accountId, 'original')
  assert(h.revoked.includes('local-2'))
  assert(!h.revoked.includes('local-3'))
  session.dispose()
})
test('Host failures, malformed 401 and unrelated error codes do not trigger local open', async () => {
  for (
    const reply of [
      { status: 'unavailable', code: 'connection-unavailable' },
      { status: 'accepted', value: { statusCode: 401, body: 'invalid-json' } },
      { status: 'accepted', value: { statusCode: 401, body: '{"error":{"code":"PERMISSION_DENIED"}}' } },
    ]
  ) {
    const { h, session } = await connectedRecoveryHost()
    h.api.request = async () => reply
    await assert.rejects(session.client.me())
    assert.equal(h.opens.length, 1)
    session.dispose()
  }
})
test('aborted read cannot request authorization recovery', async () => {
  const { h, session } = await connectedRecoveryHost()
  const controller = new AbortController()
  h.api.request = async () => {
    controller.abort()
    return rejectedCredential
  }
  await assert.rejects(session.client.me(controller.signal), { name: 'AbortError' })
  assert.equal(h.opens.length, 1)
  session.dispose()
})

test('late 401 from the replaced connection retries on current authority without a second reopen', async () => {
  const { h, session } = await connectedRecoveryHost()
  const actual = h.api.request
  let release
  h.api.request = input =>
    input.path === '/v1/ledger' && input.connection.id === 'local-1'
      ? new Promise(resolve => {
        release = resolve
      })
      : actual(input)
  const delayed = session.client.ledger()
  while (!release) await Promise.resolve()
  await session.client.me()
  release(rejectedCredential)
  await delayed
  assert.equal(h.opens.length, 2)
  session.dispose()
})
test('mutated connection options cannot change reopened source or original wallet owner', async () => {
  const h = recoveryHost(), session = new WalletSession(h.api)
  const binding = { ...localBinding }, expected = { instanceId: 'canonical', accountId: 'original' }
  await session.connect(binding.origin, binding, { expected })
  binding.sourceId = 'other-source'
  binding.origin = 'http://127.0.0.1:9999'
  expected.accountId = 'other'
  h.expire()
  assert.equal((await session.client.me()).accountId, 'original')
  assert.equal(h.opens.at(-1).sourceId, 'economy-local')
  assert.equal(h.opens.at(-1).origin, localBinding.origin)
  session.dispose()
})
test('local connection without a saved expected owner pins its first verified wallet for later reads', async () => {
  const h = recoveryHost(), session = new WalletSession(h.api)
  await session.connect(localBinding.origin, localBinding, {})
  h.expire()
  assert.equal((await session.client.me()).accountId, 'original')
  assert.equal(h.opens.length, 2)
  session.dispose()
})
