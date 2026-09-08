import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'economy-process-')), path = join(dir, 'db.sqlite')
  const economy = new Economy(path)
  t.after(() => {
    economy.close()
    rmSync(dir, { recursive: true, force: true })
  })
  economy.auth.createInstance('one', 1000)
  economy.auth.createAccount('one', 'alice')
  economy.store.transaction(() =>
    economy.store.transfer('one', '$issuer', 'alice', 100, 'operator-test', 'fixture', Date.now())
  )
  economy.commerce.createItem('one', 'pet.apple', 'Apple', 60, 'pet')
  return { path, economy, token: economy.auth.login(economy.auth.enrollment('one', 'alice')).token }
}
async function worker(path, mode, token = '', key = '') {
  const child = fork(new URL('./worker.mjs', import.meta.url), [path, mode, token, key], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  await once(child, 'message')
  return child
}
test('two OS processes racing purchases cannot double-spend', async t => {
  const f = setup(t)
  const children = await Promise.all([
    worker(f.path, 'buy', f.token, 'parallel-1'),
    worker(f.path, 'buy', f.token, 'parallel-2'),
  ])
  const responses = children.map(child => once(child, 'message'))
  children.forEach(child => child.send('go'))
  const results = (await Promise.all(responses)).map(([r]) => r)
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(results.find(r => !r.ok).code, 'INSUFFICIENT_FUNDS')
  assert.equal(f.economy.request('GET', '/v1/me', f.token).available, 40)
  f.economy.store.assertConservation('one')
})
test('same-key purchases racing across processes return one durable order', async t => {
  const f = setup(t)
  const children = await Promise.all([
    worker(f.path, 'buy', f.token, 'shared-key'),
    worker(f.path, 'buy', f.token, 'shared-key'),
  ])
  const responses = children.map(child => once(child, 'message'))
  children.forEach(child => child.send('go'))
  const results = (await Promise.all(responses)).map(([r]) => r)
  assert(results.every(r => r.ok))
  assert.deepEqual(results[0].result, results[1].result)
  assert.equal(f.economy.request('GET', '/v1/orders', f.token).length, 1)
})
test('SIGKILL in a money transaction rolls back debit and audit entry', async t => {
  const f = setup(t), child = await worker(f.path, 'crash')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.equal(f.economy.request('GET', '/v1/me', f.token).available, 100)
  assert.equal(f.economy.store.one('SELECT COUNT(*) AS count FROM ledger WHERE reason=?', 'interrupted').count, 0)
  f.economy.store.assertConservation('one')
})
