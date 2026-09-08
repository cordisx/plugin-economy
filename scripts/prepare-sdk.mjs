/** Reproduce the exact maintained Host/creator and public Protocol packages in an ignored directory. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, '.cache/sdk')
const hostSha = '5101d6ec25409a65d939fb4214b4144a5eb672df'
const protocolSha = '465c444c65eec1be8e337b94c2cf658ed536f49c'
mkdirSync(output, { recursive: true })
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
function checkout(repo, sha) {
  const target = join(root, '.cache', `${repo}-${sha.slice(0, 12)}`)
  if (!existsSync(target)) {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/cordisx/${repo}.git`, target], root)
  }
  run('git', ['fetch', 'origin', sha], target)
  run('git', ['checkout', '--detach', sha], target)
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim()
  if (actual !== sha) throw new Error('SDK checkout mismatch')
  return target
}
function pack(cwd) {
  const metadata = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const name = `${metadata.name.replace('@', '').replace('/', '-')}-${metadata.version}.tgz`
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', output], cwd)
  return name
}
const protocol = checkout('cordisx-protocol', protocolSha)
// Protocol's package allowlist contains tracked runtime/type/schema files only; no install or build is required to package it.
const protocolPackage = pack(protocol)
copyFileSync(join(output, protocolPackage), join(output, `cordisx-protocol-${protocolSha.slice(0, 12)}.tgz`))
const host = checkout('cordisx', hostSha)
run('npm', ['ci', '--ignore-scripts'], host)
run('npm', ['run', 'build'], host)
const hostPackage = pack(join(host, 'packages/cli'))
copyFileSync(join(output, hostPackage), join(output, `cordisx-${hostSha.slice(0, 12)}.tgz`))
pack(join(host, 'packages/create-cordisx-plugin'))
console.info(
  `SDK ready: Host ${hostSha}, Protocol ${protocolSha}. This experimental Host includes the public HTTP capability.`,
)
