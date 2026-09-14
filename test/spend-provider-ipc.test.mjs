import { listenWalletSpendProvider } from 'cordisx/wallet-spend-provider/v1'
import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { LocalWalletIdentities } from '../dist/server/local-wallet-identities.js'
import { createSpendProviderFactory } from '../dist/server/spend-provider-factory.js'
import { spendHash } from '../dist/server/spend-signatures.js'
import { canonical } from '../dist/spend/index.js'
// Test-only transport fixture for Host's authenticated wire. Production consumes only the public listener.
function peer(path, secret) {
  const socket = createConnection(path)
  let session = randomBytes(32).toString('hex'), sequence = 0
  const request = (operation, payload, tamper = false) =>
    new Promise((resolve, reject) => {
      const frame = { session, sequence: sequence++, operation, payload }
      const mac = createHmac('sha256', secret).update('cordisx.wallet-spend-ipc/v1\0' + canonical(frame)).digest('hex')
      let buffer = ''
      const cleanup = () => {
        socket.off('data', data)
        socket.off('close', close)
        socket.off('error', fail)
      }
      const fail = error => {
        cleanup()
        reject(error)
      }
      const close = () => fail(new Error('IPC closed'))
      const data = chunk => {
        buffer += chunk
        if (!buffer.endsWith('\n')) return
        try {
          const { mac: signature, ...reply } = JSON.parse(buffer)
          const expected = createHmac('sha256', secret).update('cordisx.wallet-spend-ipc/v1\0' + canonical(reply))
            .digest('hex')
          assert.equal(signature, expected)
          cleanup()
          if (operation === 'open') session = reply.payload.value.serverNonce
          resolve(reply.payload.value)
        } catch (error) {
          fail(error)
        }
      }
      socket.on('data', data)
      socket.once('close', close)
      socket.once('error', fail)
      socket.write(JSON.stringify({ ...frame, mac: tamper ? '0'.repeat(64) : mac }) + '\n')
    })
  return { request, close: () => socket.destroy() }
}
async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spend-ipc-'))),
    socketPath = join(dir, 'socket'),
    secretFile = join(dir, 'secret'),
    keyFile = join(dir, 'key')
  const secret = randomBytes(32), key = generateKeyPairSync('ed25519')
  writeFileSync(secretFile, secret, { mode: 0o600 })
  writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const e = new Economy(':memory:')
  e.auth.createInstance('local', 100)
  e.auth.createAccount('local', 'original')
  e.store.transaction(() => e.store.transfer('local', '$issuer', 'original', 50, 'fixture', 'fixture', Date.now()))
  e.commerce.createItem('local', 'food', 'Food', 3, 'pet')
  const origin = 'http://127.0.0.1:8900',
    host = generateKeyPairSync('ed25519'),
    der = host.publicKey.export({ type: 'spki', format: 'der' }),
    subject = 'host-local:' + createHash('sha256').update(der).digest('base64url'),
    realm = 'realm:' + spendHash({ origin, instanceId: 'local' })
  new LocalWalletIdentities(e.store, 'local', realm).enroll({
    realm,
    subject,
    keyFingerprint: createHash('sha256').update(der).digest('hex'),
    publicKey: der.toString('base64'),
    accountId: 'original',
  })
  const wallet = { origin, instanceId: 'local', accountId: 'original', subject, publicKey: der.toString('base64') }
  const listener = await listenWalletSpendProvider({
    socketPath,
    secretFile,
    openSession: createSpendProviderFactory(e.store, { origin, instanceId: 'local', receiptKeyFile: keyFile }),
  })
  t.after(async () => {
    await listener.close()
    e.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const connect = async (deadline = Date.now() + 10_000) => {
    const p = peer(socketPath, secret)
    await p.request('open', { wallet, deadline })
    return p
  }
  const input = { storeId: 'pet', itemId: 'food', quantity: 2, expectedTotal: 6, requestId: 'purchase-ipc' }
  return { e, socketPath, secret, connect, input }
}
test('normal public Host listener integrates private original-wallet quote/purchase/cancellation and durable recovery', async t => {
  const f = await fixture(t), p = await f.connect()
  const q = await p.request('quote-purchase', f.input)
  const proof = JSON.parse(await p.request('cancel-purchase', { token: q.token }))
  assert.equal(proof.state, 'cancelled')
  p.close()
  const next = await f.connect()
  assert.deepEqual(JSON.parse(await next.request('order', { storeId: 'pet', requestId: f.input.requestId })), proof)
  const q2 = await next.request('quote-purchase', f.input)
  assert.deepEqual(JSON.parse(await next.request('purchase', { token: q2.token })), proof)
  const paid = { ...f.input, requestId: 'paid-ipc' }, q3 = await next.request('quote-purchase', paid)
  const order = JSON.parse(await next.request('purchase', { token: q3.token }))
  const cancel = await next.request('quote-cancellation', paid)
  assert.deepEqual(JSON.parse(await next.request('cancel-purchase', { token: cancel.token })), order)
  assert.equal(f.e.store.one('SELECT available FROM accounts WHERE id=?', 'original').available, 44)
  assert.equal(f.e.store.one('SELECT quantity FROM inventory').quantity, 2)
  next.close()
})
test('authenticated connection scope rejects foreign quote and bad MAC; expired connection never commits a hold or cancellation', async t => {
  const f = await fixture(t),
    p = await f.connect(),
    q = await p.request('quote-purchase', f.input),
    other = await f.connect()
  await assert.rejects(other.request('purchase', { token: q.token }), /closed/)
  p.close()
  const corrupt = await f.connect()
  await assert.rejects(corrupt.request('identity', {}, true), /closed/)
  const expired = await f.connect(Date.now() + 30)
  await expired.request('quote-cancellation', f.input)
  await new Promise(resolve => setTimeout(resolve, 45))
  expired.close()
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM localPurchaseRequests').n, 0)
  assert.equal(f.e.store.one('SELECT available FROM accounts WHERE id=?', 'original').available, 50)
})
