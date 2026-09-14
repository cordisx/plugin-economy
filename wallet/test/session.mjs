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
