import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalWalletSession } from '../.cache/test-runtime/local-wallet.js'
const drain = async () => {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve))
}
test('real Cordis sibling owners inject late canonical provider and retire it without sharing HTTP handles', async () => {
  const root = new Context(),
    game = root.isolate('http').isolate('documents'),
    owner = root.isolate('http').isolate('documents')
  let observed, retired = false
  const consumer = game.inject(['economyLocalWallet'], child => {
    observed = child.get('economyLocalWallet')
    child.effect(() => () => {
      retired = true
    })
  })
  await drain()
  assert.equal(observed, undefined)
  const values = new Map()
  const documents = {
    load: async id => values.has(id) ? { status: 'loaded', snapshot: values.get(id) } : { status: 'missing' },
    transaction: async r => {
      const old = values.get(r.documentId)
      if ((old?.revision || 0) !== r.expectedRevision) return { status: 'conflict' }
      values.set(r.documentId, { revision: r.expectedRevision + 1, value: r.value })
      return { status: 'accepted' }
    },
  }
  const origin = 'http://127.0.0.1:58974',
    connection = { contract: 'cordisx.http-connection/v1', id: 'wallet-owned-opaque', origin, credential: 'bearer' }
  const http = {
    contract: 'cordisx.http-client/v3',
    connectAccount: async () => ({ status: 'accepted', value: { connection } }),
    request: async r => {
      assert.equal(r.connection, connection)
      return {
        status: 'accepted',
        value: {
          statusCode: 200,
          body: JSON.stringify(
            r.path === '/v1/me' ? { instanceId: 'local', accountId: 'native-user', available: 0, reserved: 0 } : [],
          ),
        },
      }
    },
    revoke: async () => ({ status: 'accepted' }),
  }
  owner.provide('http', http)
  owner.provide('documents', documents)
  const provider = owner.inject(['http', 'documents'], async child => {
    const session = new CanonicalWalletSession(child, { localEconomyOrigin: origin })
    child.provide('economyLocalWallet', session.service)
    child.effect(() => () => session.dispose())
    await session.connect(origin)
  })
  await provider
  await consumer
  await drain()
  assert.equal(observed.contract, 'economy.local-wallet/v1')
  const summary = await observed.summary()
  assert.equal(summary.status, 'ready')
  assert.equal(summary.available, 0)
  assert.equal(summary.reserved, 0)
  assert.equal(game.get('http'), undefined)
  await provider.dispose()
  await drain()
  assert.equal(retired, true)
  assert.equal(game.get('economyLocalWallet'), undefined)
  await consumer.dispose()
})
