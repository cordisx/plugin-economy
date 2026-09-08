import assert from 'node:assert/strict'
import test from 'node:test'
import { WalletSession } from '../src/session.ts'
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
