/** Delegate exact-source SDK packaging to the provider's verified portable builder. */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, '.cache/sdk')
const hostSha = '69b0146c4d4b6acd411758ae4ec3005ea74d0b89'
const protocolSha = '465c444c65eec1be8e337b94c2cf658ed536f49c'
const expected = {
  'cordisx-0.1.0-beta.2.tgz': '42f655ad735fd430e6f455bbb2e8da31f5eb564c247a3c31bbb1e9774df131c4',
  'cordisx-protocol-0.1.0-alpha.0.tgz': '9576e28592b44c589aa847f3e57c02db1731a664c5cfa5a0f1fd5c4b5a3e21c8',
}
mkdirSync(output, { recursive: true })
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const host = join(root, '.cache', `cordisx-${hostSha.slice(0, 12)}`)
if (!existsSync(host)) {
  run('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/cordisx/cordisx.git', host], root)
}
run('git', ['fetch', 'origin', hostSha], host)
run('git', ['checkout', '--detach', hostSha], host)
const git = args => execFileSync('git', args, { cwd: host, encoding: 'utf8' }).trim()
if (git(['rev-parse', 'HEAD']) !== hostSha || git(['status', '--porcelain'])) {
  throw new Error('SDK source is not the clean exact checkpoint')
}
// The provider requires a nonexistent output directory and archives HEAD itself.
// Do not npm-install the Host checkout: recursive Git prepare is not a bootstrap step.
const build = join(root, '.cache', `sdk-build-${hostSha.slice(0, 12)}-${randomUUID()}`)
run(process.execPath, ['scripts/prepare-sdk.mjs', build], host)
const evidencePath = join(build, 'sdk-evidence.json')
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
copyFileSync(evidencePath, join(output, 'sdk-evidence.json'))
for (const pkg of evidence.packages) {
  if (!/^[a-z0-9.-]+\.tgz$/.test(pkg.filename)) throw new Error('Unexpected SDK package name')
  copyFileSync(join(build, 'packages', pkg.filename), join(output, pkg.filename))
}
if (
  evidence.hostCommit !== hostSha
  || !evidence.sources.some(source =>
    source.location === 'node_modules/@cordisx/protocol' && source.spec.endsWith(`#${protocolSha}`)
  )
) throw new Error('SDK input commit mismatch')
for (const pkg of evidence.packages) {
  const bytes = readFileSync(join(output, pkg.filename))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (
    sha256 !== pkg.sha256 || integrity !== pkg.integrity
    || (expected[pkg.filename] && sha256 !== expected[pkg.filename])
  ) {
    throw new Error(`SDK digest mismatch: ${pkg.filename}`)
  }
}
for (const filename of Object.keys(expected)) {
  if (!evidence.packages.some(pkg => pkg.filename === filename)) throw new Error(`Missing SDK package: ${filename}`)
}
copyFileSync(join(output, 'cordisx-0.1.0-beta.2.tgz'), join(output, `cordisx-${hostSha.slice(0, 12)}.tgz`))
copyFileSync(
  join(output, 'cordisx-protocol-0.1.0-alpha.0.tgz'),
  join(output, `cordisx-protocol-${protocolSha.slice(0, 12)}.tgz`),
)
console.info(`SDK ready: Host ${hostSha}, Protocol ${protocolSha}; verified portable provider artifacts.`)
