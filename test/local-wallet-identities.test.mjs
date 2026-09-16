import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Economy } from '../dist/server/economy.js'
import { LocalWalletIdentities } from '../dist/server/local-wallet-identities.js'
import { WorkIncomeIssuer } from '../dist/server/work-income.js'
const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })
const identity = {
  realm: 'canonical-realm',
  subject: 'host-local:' + createHash('sha256').update(key).digest('base64url'),
  keyFingerprint: createHash('sha256').update(key).digest('hex'),
  publicKey: key.toString('base64'),
}

function fixture(t, path = ':memory:') {
  const economy = new Economy(path)
  t.after(() => economy.close())
  economy.auth.createInstance('canonical', 1)
  economy.auth.createAccount('canonical', 'original')
  economy.auth.createAccount('canonical', 'other')
  return { economy, aliases: new LocalWalletIdentities(economy.store, 'canonical', identity.realm) }
}
test('one alias resolves every consumer to the existing account without changing financial state or history', t => {
  const { economy, aliases } = fixture(t)
  const issuer = new WorkIncomeIssuer(economy.store)
  issuer.history.apply('canonical', 'original', {
    contract: 'economy.history-declaration/v1',
    id: 'history:00000000-0000-0000-0000-000000000000',
    stage: 'begin',
    statement: 'Fixture unresolved history',
  })
  const before = economy.store.db.prepare('SELECT * FROM accounts ORDER BY id').all()
  assert.equal(aliases.enroll({ ...identity, accountId: 'original' }), 'original')
  assert.equal(aliases.enroll({ ...identity, accountId: 'original' }), 'original')
  assert.equal(aliases.resolve(identity), 'original')
  assert.equal(new LocalWalletIdentities(economy.store, 'canonical', identity.realm).resolve(identity), 'original')
  assert.deepEqual(economy.store.db.prepare('SELECT * FROM accounts ORDER BY id').all(), before)
  assert.equal(economy.store.one('SELECT COUNT(*) AS n FROM ledger WHERE account=?', 'original').n, 0)
  assert.throws(
    () => issuer.provision({ instanceId: 'canonical', accountId: aliases.resolve(identity), scopeId: 'work-scope' }),
    /retire|history/i,
  )
})
test('missing, conflicting, different realm and key authorities cannot create or rebind wallets', t => {
  const { economy, aliases } = fixture(t)
  assert.throws(() => aliases.resolve(identity), /unavailable/)
  assert.throws(() => aliases.enroll({ ...identity, accountId: 'missing' }), /existing canonical/)
  assert.throws(() => aliases.enroll({ ...identity, accountId: '$issuer' }), /bounded identifier|existing canonical/)
  aliases.enroll({ ...identity, accountId: 'original' })
  assert.throws(() => aliases.enroll({ ...identity, accountId: 'other' }), /cannot be rebound/)
  assert.throws(
    () => aliases.enroll({ ...identity, subject: 'another-key', accountId: 'original' }),
    /already has|subject must match/,
  )
  assert.throws(() => aliases.resolve({ ...identity, keyFingerprint: 'b'.repeat(64) }), /unavailable/)
  assert.throws(() => aliases.resolve({ ...identity, realm: 'other-profile' }), /realm differs/)
  assert.equal(economy.store.one('SELECT COUNT(*) AS n FROM localWalletIdentities').n, 1)
  assert.equal(economy.store.one('SELECT COUNT(*) AS n FROM accounts').n, 4)
})
test('alias persists across restart; explicit revocation cannot silently restore or reassign it', t => {
  const directory = mkdtempSync(join(tmpdir(), 'local-wallet-alias-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'wallet.sqlite')
  const first = new Economy(path)
  first.auth.createInstance('canonical', 1)
  first.auth.createAccount('canonical', 'original')
  new LocalWalletIdentities(first.store, 'canonical', identity.realm).enroll({ ...identity, accountId: 'original' })
  first.close()
  const second = new Economy(path)
  t.after(() => second.close())
  const aliases = new LocalWalletIdentities(second.store, 'canonical', identity.realm)
  assert.equal(aliases.resolve(identity), 'original')
  aliases.revoke(identity)
  assert.throws(() => aliases.resolve(identity), /unavailable/)
  assert.throws(() => aliases.enroll({ ...identity, accountId: 'original' }), /silently restored/)
  assert.equal(second.store.one('SELECT account FROM localWalletIdentities').account, 'original')
})

test('enrollment pins the actual canonical local Ed25519 key and rejects mixed subject/key proofs', t => {
  const { aliases } = fixture(t)
  assert.throws(
    () => aliases.enroll({ ...identity, subject: 'host-local:wrong', accountId: 'original' }),
    /subject must match/,
  )
  assert.throws(
    () => aliases.enroll({ ...identity, keyFingerprint: 'b'.repeat(64), accountId: 'original' }),
    /subject must match/,
  )
  assert.throws(
    () => aliases.enroll({ ...identity, publicKey: identity.publicKey + '\n', accountId: 'original' }),
    /subject must match/,
  )
  aliases.enroll({ ...identity, accountId: 'original' })
  assert.equal(aliases.publicKey(identity.subject), identity.publicKey)
  aliases.revoke(identity)
  assert.throws(() => aliases.publicKey(identity.subject), /unavailable/)
})

test('explicit local revocation retires all local sessions while preserving original remote credentials', t => {
  const { economy, aliases } = fixture(t)
  aliases.enroll({ ...identity, accountId: 'original' })
  const remote = economy.auth.issue('canonical', 'original', 'user', 3_600_000)
  const first = aliases.session(identity), second = aliases.session(identity)
  assert.equal(economy.auth.authenticate(first.token).subject, 'original')
  assert.equal(economy.auth.authenticate(second.token).subject, 'original')
  aliases.revoke(identity)
  assert.throws(() => economy.auth.authenticate(first.token), /revoked/)
  assert.throws(() => economy.auth.authenticate(second.token), /revoked/)
  assert.equal(economy.auth.authenticate(remote.token).subject, 'original')
  assert.throws(() => aliases.session(identity), /unavailable/)
})

test('fresh trusted second profile alias can read the same wallet without rebinding work scope', t => {
  const { economy, aliases } = fixture(t)
  aliases.enroll({ ...identity, accountId: 'original' })
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })
  const second = {
    realm: identity.realm,
    subject: 'host-local:' + createHash('sha256').update(key).digest('base64url'),
    keyFingerprint: createHash('sha256').update(key).digest('hex'),
    publicKey: key.toString('base64'),
  }
  aliases.enroll({ ...second, accountId: 'original' })
  assert.equal(aliases.resolve(second), 'original')
  const issuer = new WorkIncomeIssuer(economy.store)
  issuer.bind({ instanceId: 'canonical', accountId: 'original', scopeId: 'first-profile-work' })
  assert.throws(
    () => issuer.bind({ instanceId: 'canonical', accountId: aliases.resolve(second), scopeId: 'second-profile-work' }),
    /cannot be rebound/,
  )
  assert.equal(economy.store.one('SELECT COUNT(*) AS n FROM accounts WHERE kind=?', 'user').n, 2)
})
