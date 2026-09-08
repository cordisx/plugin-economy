/** Reproduce the exact maintained Host/creator and public Protocol packages in an ignored directory. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, '.cache/sdk')
const hostSha = 'b75fa2c6f9563924feca271242e2709c136033a3'
const protocolSha = '8adc1aab908263e692bd56ca6165b9aeadabe4b9'
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
pack(protocol)
const host = checkout('cordisx', hostSha)
run('npm', ['ci', '--ignore-scripts'], host)
run('npm', ['run', 'build'], host)
pack(join(host, 'packages/cli'))
pack(join(host, 'packages/create-cordisx-plugin'))
console.info(
  `SDK ready: Host ${hostSha}, Protocol ${protocolSha}. The baseline Host has no HTTP implementation; wallet shows unavailable until the capability Host is installed.`,
)
