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

const { apply, inject, manifest, Config, icon } = await import('../dist/runtime/module.js')

test('built plugin brand icon preserves the selected 256px PNG without a runtime asset URL', async () => {
  const { readFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const source = await readFile(new URL('../src/assets/economy.png', import.meta.url))
  assert.equal(icon.mediaType, 'image/png')
  assert.match(icon.data, /^[A-Za-z0-9+/]+={0,2}$/)
  const bytes = Buffer.from(icon.data, 'base64')
  assert.deepEqual(bytes, source)
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '8216c4773d155fe2e7ef2a059b83e2a0f4110ca3da10b7abc9a3f651b5bd2990',
  )
  assert.equal(bytes.readUInt32BE(16), 256)
  assert.equal(bytes.readUInt32BE(20), 256)
})

test('exports a minimal CordisX plugin module', () => {
  assert.equal(manifest.schemaVersion, 11)
  assert.equal(manifest.id, 'wallet')
  assert.deepEqual(manifest.capabilities, [
    { name: 'usage.read', required: true, scope: { profile: 'current' } },
    {
      name: 'ui.extension-points.render',
      required: true,
      scope: { extensionPoints: ['manager.settings.navigation-items', 'manager.content'] },
    },
  ])
  assert.deepEqual(inject, ['i18n', 'pages', 'routes', 'slots', 'managerContent', 'documents', 'http', 'usage'])
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
  const reachable = new Set(), pending = [artifact.entry]
  while (pending.length) {
    const path = pending.pop()
    if (reachable.has(path)) continue
    reachable.add(path)
    const file = artifact.files.find(file => file.path === path)
    if (file?.kind === 'module') pending.push(...file.imports)
  }
  assert(artifact.files.some(file => reachable.has(file.path) && file.dynamicImports?.length > 0))
  for (const file of artifact.files) {
    const bytes = await readFile(new URL(`../dist/runtime/${file.path}`, import.meta.url))
    assert.equal(bytes.length, file.byteLength)
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, file.digest)
  }
})

test('wallet package retains the original brand PNG and complete runtime graph', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  }))
  const paths = new Set(packed.files.map(file => file.path))
  assert(paths.has('src/assets/economy.png'))
  assert(paths.has('dist/runtime/artifact.json'))
  const artifact = JSON.parse(await readFile(new URL('../dist/runtime/artifact.json', import.meta.url), 'utf8'))
  for (const file of artifact.files) assert(paths.has('dist/runtime/' + file.path.replace(/^\.\//, '')))
})

test('activation registers valid localized routes and releases owned session', () => {
  const registrations = [], disposers = []
  apply({
    get: name => {
      assert.equal(name, 'http')
      return undefined
    },
    provide: (name, service) => {
      assert.equal(
        service.contract,
        name === 'economyLocalWallet' ? 'economy.local-wallet/v1' : 'economy.local-wallet-commerce/v1',
      )
      assert(['economyLocalWallet', 'economyWalletCommerce'].includes(name))
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
  assert.deepEqual(registrations, [
    'en',
    'zh-CN',
    'overview',
    '/manager/extensions/wallet',
    'activity',
    '/manager/extensions/wallet/activity',
    'diagnostics',
    '/manager/extensions/wallet/diagnostics',
    'manager',
    'navigation',
  ])
  disposers.forEach(dispose => dispose())
})

test('Host and wallet resolve one public Protocol module identity', async () => {
  const { createRequire } = await import('node:module')
  const { realpathSync } = await import('node:fs')
  const walletRequire = createRequire(import.meta.url)
  const hostRequire = createRequire(walletRequire.resolve('cordisx/contracts'))
  for (
    const contract of [
      '@cordisx/protocol/plugin-http/v1',
      '@cordisx/protocol/agent-avatar/v1',
      '@cordisx/protocol/plugin-http/v3',
      '@cordisx/protocol/managed-source/v1',
    ]
  ) {
    assert.equal(realpathSync(hostRequire.resolve(contract)), realpathSync(walletRequire.resolve(contract)))
  }
})

test('ordinary configuration exposes no historical correction or new issuance declaration', () => {
  assert.equal(Config({}).readOnly, false)
  assert.equal(Config({}).legacyPetHistoryCorrection, undefined)
  assert.equal(Config({}).legacyPetHistory, undefined)
})
