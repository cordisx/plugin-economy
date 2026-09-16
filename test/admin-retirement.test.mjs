import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
test('offline CLI provisions only zero supply and rejects historical issuance without clearing existing audit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'economy-zero-cli-')), path = join(dir, 'db.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = (...args) =>
    spawnSync(process.execPath, ['dist/server/admin.js', ...args], {
      env: { ...process.env, ECONOMY_DB: path },
      encoding: 'utf8',
    })
  assert.equal(run('instance', 'local', '0').status, 0)
  assert.notEqual(run('instance', 'positive', '1').status, 0)
  assert.notEqual(run('source', 'local', 'x', 'old', 'reward', '100', '10', '10').status, 0)
  assert.notEqual(run('entitlement', 'local', 'x', 'old', 'user', '10').status, 0)
  const db = new DatabaseSync(path)
  t.after(() => db.close())
  assert.deepEqual({ ...db.prepare('SELECT supply FROM instances WHERE id=?').get('local') }, { supply: 0 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instances').get().n, 1)
})
