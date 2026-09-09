import assert from 'node:assert/strict'
import test from 'node:test'

const component = () => null
const noop = () => undefined
const React = new Proxy({ Fragment: Symbol('Fragment'), Suspense: component, lazy: () => component }, {
  get(target, property) {
    return Reflect.get(target, property) ?? noop
  },
})
globalThis.__cordisxSharedReactRuntime = {
  React,
  defineReactPage: page => page,
  jsxRuntime: { Fragment: React.Fragment, jsx: component, jsxs: component },
  jsxDevRuntime: { Fragment: React.Fragment, jsxDEV: component },
  ui: new Proxy({}, { get: () => component }),
}

const { apply, inject, manifest } = await import('../dist/runtime/module.js')

test('exports a minimal CordisX plugin module', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.id, 'wallet')
  assert.deepEqual(manifest.capabilities, [])
  assert.deepEqual(inject, ['notifications', 'i18n', 'pages', 'routes', 'slots', 'managerContent'])
  assert.equal(typeof apply, 'function')
})

test('formal artifact retains lazy modules and stylesheet with matching digests', async () => {
  const { readFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const artifact = JSON.parse(await readFile(new URL('../dist/runtime/artifact.json', import.meta.url), 'utf8'))
  assert.equal(artifact.format, 'browser-esm-graph')
  assert.equal(artifact.entry, './module.js')
  assert.equal(artifact.initialStyles.length, 0)
  assert(artifact.files.some(file => file.kind === 'stylesheet'))
  assert(artifact.files.find(file => file.path === './module.js').dynamicImports.length > 0)
  for (const file of artifact.files) {
    const bytes = await readFile(new URL(`../dist/runtime/${file.path}`, import.meta.url))
    assert.equal(bytes.length, file.byteLength)
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest)
  }
})

test('activation registers valid localized routes and releases owned session', () => {
  const registrations = [], disposers = []
  apply({
    get: name => {
      assert.equal(name, 'http')
      return undefined
    },
    effect: factory => {
      disposers.push(factory())
    },
    i18n: {
      define: locale => {
        for (const key of Object.keys(locale.messages)) assert.match(key, /^[a-z0-9][a-z0-9._-]*$/)
        registrations.push(locale.locale)
      },
    },
    pages: { register: page => registrations.push(page.id) },
    routes: { register: route => registrations.push(route.path) },
    managerContent: { register: () => registrations.push('manager') },
    slots: { register: () => registrations.push('navigation') },
  })
  assert.deepEqual(registrations, ['en', 'zh-CN', 'overview', '/manager/extensions/wallet', 'manager', 'navigation'])
  disposers.forEach(dispose => dispose())
})

test('Host and wallet resolve one public Protocol module identity', async () => {
  const { createRequire } = await import('node:module')
  const { realpathSync } = await import('node:fs')
  const walletRequire = createRequire(import.meta.url)
  const hostRequire = createRequire(walletRequire.resolve('cordisx/contracts'))
  for (const contract of ['@cordisx/protocol/plugin-http/v1', '@cordisx/protocol/agent-avatar/v1']) {
    assert.equal(realpathSync(hostRequire.resolve(contract)), realpathSync(walletRequire.resolve(contract)))
  }
})
