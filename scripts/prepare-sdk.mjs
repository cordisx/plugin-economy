/** Validate the owner-frozen normal SDK inputs. Never rebuild a stale Host checkpoint or patch compiled SDK files. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url)), directory = join(root, '.cache/sdk')
const inventory = JSON.parse(readFileSync(join(directory, 'normal-sdk-inputs.json'), 'utf8'))
if (inventory.stage !== 'terminal-r37' || inventory.packages.length !== 2) {
  throw new Error('Expected terminal owner SDK inventory')
}
for (const pkg of inventory.packages) {
  if (!/^cordisx-(host|protocol)-wallet-spend-r3[67]-normal\.tgz$/.test(pkg.filename)) {
    throw new Error('Unexpected SDK package')
  }
  const bytes = readFileSync(join(directory, pkg.filename))
  if (
    createHash('sha256').update(bytes).digest('hex') !== pkg.sha256
    || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== pkg.integrity
  ) throw new Error('SDK digest mismatch: ' + pkg.filename)
}
console.info('Normal Host/Protocol SDK inputs verified; experimental source packages, no runtime installation implied.')
