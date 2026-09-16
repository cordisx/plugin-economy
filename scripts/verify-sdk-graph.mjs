import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const inventory = JSON.parse(readFileSync(join(root, '.cache/sdk/normal-sdk-inputs.json'), 'utf8'))
const results = []
for (const directory of [root, join(root, 'wallet')]) {
  const require = createRequire(join(directory, 'package.json')),
    lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'))
  const protocol = realpathSync(require.resolve('@cordisx/protocol/wallet-spend/v1'))
  const hostRequire = createRequire(require.resolve('cordisx/contracts'))
  assert.equal(realpathSync(hostRequire.resolve('@cordisx/protocol/wallet-spend/v1')), protocol)
  if (directory !== root) {
    const economyRequire = createRequire(require.resolve('@cordisx/economy/client'))
    assert.equal(realpathSync(economyRequire.resolve('@cordisx/protocol/wallet-spend/v1')), protocol)
    assert.equal(
      realpathSync(economyRequire.resolve('cordisx/wallet-spend-provider/v1')),
      realpathSync(require.resolve('cordisx/wallet-spend-provider/v1')),
    )
  }
  assert.equal(Object.keys(lock.packages).filter(p => p.endsWith('node_modules/@cordisx/protocol')).length, 1)
  for (const pkg of inventory.packages) {
    const moduleName = pkg.filename.includes('-host-') ? 'cordisx' : '@cordisx/protocol'
    assert.equal(lock.packages['node_modules/' + moduleName].integrity, pkg.integrity)
    assert.ok(lock.packages['node_modules/' + moduleName].resolved.endsWith(pkg.filename))
  }
  results.push({
    directory,
    protocol,
    provider: realpathSync(require.resolve('cordisx/wallet-spend-provider/v1')),
    integrity: 'PASS',
    identity: 'PASS',
  })
}
const walletLock = JSON.parse(readFileSync(join(root, 'wallet/package-lock.json'), 'utf8'))
const economyTar = join(root, '.cache/sdk/cordisx-economy-terminal-r38-final-normal.tgz')
assert.equal(
  walletLock.packages['node_modules/@cordisx/economy'].integrity,
  'sha512-' + createHash('sha512').update(readFileSync(economyTar)).digest('base64'),
)
console.log(JSON.stringify({ results, economyPackageIntegrity: 'PASS' }, null, 2))
