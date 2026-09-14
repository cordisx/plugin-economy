import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
test('normal main boots optional public private provider on existing DB and shuts down without refund or income', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'spend-main-'))),
    db = join(directory, 'db.sqlite'),
    socketPath = join(directory, 'socket')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const portProbe = createServer()
  portProbe.listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const e = new Economy(db)
  e.auth.createInstance('local', 100)
  e.auth.createAccount('local', 'original')
  e.store.transaction(() => {
    e.store.transfer('local', '$issuer', 'original', 50, 'fixture', 'original', Date.now())
    e.store.move('local', 'original', -17, 17, 'historical-pending-fixture', 'original-hold', Date.now(), 'fixture')
    e.store.assertConservation('local')
  })
  const ledger = e.store.all('SELECT * FROM ledger')
  e.close()
  const host = generateKeyPairSync('ed25519'),
    server = generateKeyPairSync('ed25519'),
    receipt = generateKeyPairSync('ed25519'),
    origin = 'http://127.0.0.1:' + port
  const trust = join(directory, 'trust.json'), secret = join(directory, 'secret'), key = join(directory, 'receipt-key')
  writeFileSync(
    trust,
    JSON.stringify({
      binding: { origin, instanceId: 'local', sourceId: 'economy-local', audience: 'source-account' },
      hostPublicKey: host.publicKey.export({ type: 'spki', format: 'pem' }),
      serverPrivateKey: server.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
    { mode: 0o600 },
  )
  writeFileSync(secret, Buffer.alloc(32, 8), { mode: 0o600 })
  writeFileSync(key, receipt.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const child = spawn(process.execPath, ['dist/server/main.js'], {
    env: {
      ...process.env,
      ECONOMY_DB: db,
      HOST: '127.0.0.1',
      PORT: String(port),
      ECONOMY_LOCAL_WALLET: '1',
      ECONOMY_MANAGED_TRUST_FILES: trust,
      ECONOMY_SPEND_SOCKET: socketPath,
      ECONOMY_SPEND_SECRET_FILE: secret,
      ECONOMY_SPEND_RECEIPT_KEY_FILE: key,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  let stderr = ''
  child.stderr.on('data', chunk => stderr += chunk)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('main readiness timeout: ' + stderr)), 5000)
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Economy API ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error('main exited: ' + code + ' ' + stderr))
    })
  })
  assert.equal((await fetch(origin + '/healthz')).status, 200)
  assert.equal(lstatSync(socketPath).isSocket(), true)
  assert.equal(lstatSync(socketPath).mode & 0o777, 0o600)
  const exit = once(child, 'exit')
  child.kill('SIGTERM')
  assert.equal((await exit)[0], 0, stderr)
  const recovered = new Economy(db)
  try {
    assert.deepEqual(recovered.store.one('SELECT available,reserved FROM accounts WHERE id=?', 'original'), {
      available: 33,
      reserved: 17,
    })
    assert.deepEqual(recovered.store.all('SELECT * FROM ledger'), ledger)
    recovered.store.assertConservation('local')
  } finally {
    recovered.close()
  }
})
