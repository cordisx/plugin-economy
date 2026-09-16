import { execFileSync } from 'node:child_process'
/** Verify the exact, owner-built SDK artifacts used by clean consumer installs. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url)), directory = join(root, 'sdk/release')
const inventory = JSON.parse(readFileSync(join(directory, 'sdk-evidence.json'), 'utf8'))
if (!/^[a-f0-9]{40}$/.test(inventory.hostCommit) || inventory.packages.length !== 2) {
  throw new Error('Expected exact owner SDK inventory')
}
for (const pkg of inventory.packages) {
  const bytes = readFileSync(join(directory, pkg.filename))
  if (
    createHash('sha256').update(bytes).digest('hex') !== pkg.sha256
    || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== pkg.integrity
  ) throw new Error('SDK digest mismatch: ' + pkg.filename)
}
mkdirSync(join(root, '.cache/sdk'), { recursive: true })
writeFileSync(join(root, '.cache/sdk/sdk-evidence.json'), JSON.stringify(inventory, null, 2) + '\n')
console.info('Owner-built Host/Protocol SDK digests verified.')
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', join(root, '.cache/sdk')], {
  cwd: root,
  stdio: 'inherit',
})
