import assert from 'node:assert/strict'
import test from 'node:test'
import { observeWalletView, walletViewFailed } from '../.cache/test-runtime/wallet-view.js'
const drain = async () => {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
}
function fixture() {
  const listeners = new Set(), incomeListeners = new Set(), views = []
  const session = {
    defaultOrigin: 'http://127.0.0.1:58974',
    subscribe: f => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    service: {
      subscribeIncome: f => {
        incomeListeners.add(f)
        return () => incomeListeners.delete(f)
      },
    },
  }
  const wallet = { instanceId: 'local', accountId: 'codex:actual', available: 0, reserved: 0 }
  const client = { me: async () => wallet, ledger: async () => [], orders: async () => [] }
  return {
    session,
    client,
    wallet,
    views,
    listeners,
    incomeListeners,
    emit: () => listeners.forEach(f => f()),
    income: () => incomeListeners.forEach(f => f()),
  }
}
test('overview reads a previously auto-connected zero wallet and configured origin without authorizing', async () => {
  const f = fixture()
  f.session.client = f.client
  f.session.origin = f.session.defaultOrigin
  const close = observeWalletView(f.session, v => f.views.push(v))
  await drain()
  assert.deepEqual(f.views.at(-1).wallet, f.wallet)
  assert.equal(f.views.at(-1).origin, f.session.defaultOrigin)
  close()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.incomeListeners.size, 0)
  assert.equal(f.session.client, f.client)
})
test('later auto-connect and income notifications refresh the existing owner wallet', async () => {
  const f = fixture()
  const close = observeWalletView(f.session, v => f.views.push(v))
  assert.equal(f.views.at(-1).wallet, undefined)
  f.session.client = f.client
  f.emit()
  await drain()
  assert.equal(f.views.at(-1).wallet.available, 0)
  f.wallet.available = 1
  f.income()
  await drain()
  assert.equal(f.views.at(-1).wallet.available, 1)
  f.session.client = undefined
  f.emit()
  assert.equal(f.views.at(-1).wallet, undefined)
  close()
})
test('stale reads and errors cannot republish a disconnected or closed page', async () => {
  const f = fixture()
  let resolve
  f.client.me = () =>
    new Promise(r => {
      resolve = r
    })
  f.session.client = f.client
  const close = observeWalletView(f.session, v => f.views.push(v))
  f.session.client = undefined
  f.emit()
  resolve(f.wallet)
  await drain()
  assert.equal(f.views.at(-1).wallet, undefined)
  f.session.client = {
    ...f.client,
    me: async () => {
      throw Error('Host request: connection-unavailable')
    },
  }
  f.emit()
  await drain()
  assert.equal(f.views.at(-1).error, 'Host request: connection-unavailable')
  close()
  const count = f.views.length
  f.emit()
  f.income()
  await drain()
  assert.equal(f.views.length, count)
})

test('held automatic reads coalesce stage bursts with a sibling Game summary below the Host grant cap', async () => {
  const f = fixture(), held = []
  let active = 0, peak = 0, started = 0, holding = true, rejected = 0
  const request = value => {
    started++
    if (active >= 8) {
      rejected++
      return Promise.reject(Error('Host request: invalid-request'))
    }
    active++
    peak = Math.max(peak, active)
    const result = holding ? new Promise(resolve => held.push(() => resolve(value))) : Promise.resolve(value)
    return result.finally(() => active--)
  }
  f.client.me = () => request({ ...f.wallet })
  f.client.ledger = () => request([])
  f.client.orders = () => request([])
  f.session.client = f.client
  const close = observeWalletView(f.session, v => f.views.push(v))
  const siblingSummary = f.client.me()
  for (let i = 0; i < 20; i++) {
    f.income()
    f.emit()
  }
  assert.equal(started, 4)
  assert.equal(active, 4)
  assert.equal(f.views.length, 0)
  holding = false
  f.wallet.available = 1
  held.forEach(release => release())
  await siblingSummary
  await drain()
  assert.equal(started, 7)
  assert.equal(rejected, 0)
  assert.equal(peak, 4)
  assert.equal(f.views.at(-1).wallet.available, 1)
  close()
})
test('one rejected read does not release held siblings or multiply notification retries', async () => {
  const f = fixture(), held = []
  let started = 0, holding = true
  f.client.me = async () => {
    started++
    return f.wallet
  }
  f.client.ledger = () => {
    started++
    return holding ? new Promise(r => held.push(() => r([]))) : Promise.resolve([])
  }
  f.client.orders = () => {
    started++
    return holding ? new Promise(r => held.push(() => r([]))) : Promise.resolve([])
  }
  const initial = f.client.me
  f.client.me = () => {
    started++
    return Promise.reject(Error('Read failed'))
  }
  f.session.client = f.client
  const close = observeWalletView(f.session, v => f.views.push(v))
  await drain()
  f.client.me = initial
  for (let i = 0; i < 20; i++) f.income()
  await drain()
  assert.equal(started, 3)
  holding = false
  held.forEach(release => release())
  await drain()
  assert.equal(started, 6)
  assert.deepEqual(f.views.at(-1).wallet, f.wallet)
  close()
})

test('held old-client batches cannot republish after replacement or launch queued work after page closure', async () => {
  const f = fixture(), releases = []
  let oldCalls = 0
  const held = value => {
    oldCalls++
    return new Promise(r => releases.push(() => r(value)))
  }
  f.client.me = () => held({ ...f.wallet, available: 9 })
  f.client.ledger = () => held([])
  f.client.orders = () => held([])
  f.session.client = f.client
  const close = observeWalletView(f.session, v => f.views.push(v))
  f.income()
  const replacement = { ...f.wallet, accountId: 'codex:replacement', available: 0 }
  f.session.client = { me: async () => replacement, ledger: async () => [], orders: async () => [] }
  f.emit()
  await drain()
  assert.deepEqual(f.views.at(-1).wallet, replacement)
  close()
  const count = f.views.length
  releases.forEach(release => release())
  await drain()
  assert.equal(oldCalls, 3)
  assert.equal(f.views.length, count)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.incomeListeners.size, 0)
  assert.deepEqual(await f.session.client.me(), replacement)
})

test('healthy maintenance wallet remains visible when income is unavailable; failed reads offer retry', async () => {
  const f = fixture()
  f.session.readOnly = true
  f.session.available = true
  f.session.service.incomeStatus = () => ({ status: 'unavailable', reason: 'maintenance' })
  f.session.client = f.client
  const close = observeWalletView(f.session, view => f.views.push(view))
  await drain()
  assert.deepEqual(f.views.at(-1).wallet, f.wallet)
  assert.equal(walletViewFailed(f.views.at(-1), f.session.available), false)
  f.income()
  assert.deepEqual(f.views.at(-1).wallet, f.wallet)
  await drain()
  assert.equal(walletViewFailed(f.views.at(-1), true), false)
  f.client.me = async () => {
    throw new Error('real read failure')
  }
  f.emit()
  await drain()
  assert.equal(walletViewFailed(f.views.at(-1), true), true)
  f.client.me = async () => f.wallet
  f.emit()
  await drain()
  assert.equal(walletViewFailed(f.views.at(-1), true), false)
  assert.deepEqual(f.views.at(-1).wallet, f.wallet)
  close()
})
