import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { LocalWalletIdentities } from '../dist/server/local-wallet-identities.js'
import { createSpendProviderFactory, loadSpendReceiptKey } from '../dist/server/spend-provider-factory.js'
import { spendHash } from '../dist/server/spend-signatures.js'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'economy-spend-key-')), path = join(dir, 'key.pem')
  const receipt = generateKeyPairSync('ed25519')
  writeFileSync(path, receipt.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const e = new Economy(':memory:')
  t.after(() => {
    e.close()
    rmSync(dir, { recursive: true, force: true })
  })
  e.auth.createInstance('local', 0)
  e.auth.createAccount('local', 'original')
  const origin = 'http://127.0.0.1:8900',
    key = generateKeyPairSync('ed25519'),
    der = key.publicKey.export({ type: 'spki', format: 'der' })
  const subject = 'host-local:' + createHash('sha256').update(der).digest('base64url')
  const realm = 'realm:' + spendHash({ origin, instanceId: 'local' })
  const aliases = new LocalWalletIdentities(e.store, 'local', realm)
  const identity = { realm, subject, keyFingerprint: createHash('sha256').update(der).digest('hex') }
  aliases.enroll({ ...identity, accountId: 'original', publicKey: der.toString('base64') })
  return {
    e,
    dir,
    path,
    aliases,
    identity,
    config: { origin, instanceId: 'local', receiptKeyFile: path },
    wallet: { origin, instanceId: 'local', accountId: 'original', subject, publicKey: der.toString('base64') },
  }
}
test('receipt key loader rejects symlink, public permissions and non Ed25519 without replacing files', t => {
  const f = fixture(t)
  assert.equal(loadSpendReceiptKey(f.path).asymmetricKeyType, 'ed25519')
  chmodSync(f.path, 0o644)
  assert.throws(() => loadSpendReceiptKey(f.path), /0600/)
  chmodSync(f.path, 0o600)
  const alias = join(f.dir, 'symlink')
  symlinkSync(f.path, alias)
  assert.throws(() => loadSpendReceiptKey(alias), /symbolic|ELOOP/)
  writeFileSync(
    f.path,
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  )
  assert.throws(() => loadSpendReceiptKey(f.path), /Ed25519/)
})
test('provider factory resolves original aliases only, pins origin and fences live false at final commit', t => {
  const f = fixture(t), factory = createSpendProviderFactory(f.e.store, f.config)
  let active = true
  const provider = factory(f.wallet, () => active)
  const original = provider.identity()
  assert.equal(factory(f.wallet, () => true).identity().walletId, original.walletId)
  assert.throws(() => factory({ ...f.wallet, origin: 'http://127.0.0.1:9999' }, () => true), /pinned original/)
  assert.throws(() => factory({ ...f.wallet, accountId: 'substitute' }, () => true), /delegation/)
  const q = provider.quoteCancellation({
    storeId: 'pet',
    itemId: 'old',
    quantity: 1,
    expectedTotal: 3,
    requestId: 'deny',
  })
  active = false
  assert.throws(() => provider.cancelPurchase(q.handle), /no longer active/)
  assert.equal(f.e.store.one('SELECT COUNT(*) AS n FROM localPurchaseRequests').n, 0)
  active = true
  f.aliases.revoke(f.identity)
  assert.throws(() => provider.cancelPurchase(q.handle), /unavailable/)
  assert.throws(() => factory(f.wallet, () => true), /unavailable/)
  assert.equal(f.e.store.one("SELECT COUNT(*) AS n FROM accounts WHERE kind='user'").n, 1)
})
