import { createHash, createPublicKey } from 'node:crypto'
import { Auth } from './auth.js'
import { hash, Store } from './database.js'
import { requireCondition, textId } from './errors.js'

export type LocalWalletIdentity = { realm: string; subject: string; keyFingerprint: string }
/** Host verifier output only. Never construct this from an ordinary user bearer body. */
export type VerifiedLocalWalletEnrollment = LocalWalletIdentity & { accountId: string; publicKey: string }
/** Resolves a verified local authority to the original canonical account without moving assets. */
export class LocalWalletIdentities {
  constructor(readonly store: Store, readonly instanceId: string, readonly realm: string) {
    textId(instanceId, 'instanceId')
    textId(realm, 'realm')
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS localWalletIdentities(
        instance TEXT NOT NULL, realm TEXT NOT NULL, subject TEXT NOT NULL, keyFingerprint TEXT NOT NULL,
        publicKey TEXT NOT NULL, account TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
        PRIMARY KEY(instance,realm,subject),
        FOREIGN KEY(instance,account) REFERENCES accounts(instance,id));
      CREATE TABLE IF NOT EXISTS localWalletSessions(credential TEXT PRIMARY KEY REFERENCES credentials(hash),
        instance TEXT NOT NULL, realm TEXT NOT NULL, subject TEXT NOT NULL,
        FOREIGN KEY(instance,realm,subject) REFERENCES localWalletIdentities(instance,realm,subject));
    `)
  }
  private validate(identity: LocalWalletIdentity): void {
    requireCondition(identity.realm === this.realm, 'BINDING_CONFLICT', 'Local wallet realm differs', 409)
    textId(identity.subject, 'subject')
    requireCondition(
      /^[a-f0-9]{64}$/.test(identity.keyFingerprint),
      'INVALID_INPUT',
      'A verified local authority key fingerprint is required',
    )
  }
  /** Trusted provision only, after original ownership and new local key are jointly verified. */
  enroll(enrollment: VerifiedLocalWalletEnrollment): string {
    this.validate(enrollment)
    textId(enrollment.accountId, 'accountId')
    let canonicalKey = false
    try {
      const bytes = Buffer.from(enrollment.publicKey, 'base64')
      const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' })
      const digest = createHash('sha256').update(bytes)
      canonicalKey = key.asymmetricKeyType === 'ed25519' && bytes.toString('base64') === enrollment.publicKey
        && key.export({ type: 'spki', format: 'der' }).equals(bytes)
        && digest.copy().digest('hex') === enrollment.keyFingerprint
        && 'host-local:' + digest.digest('base64url') === enrollment.subject
    } catch { /* Noncanonical or non-Ed25519 keys cannot become authority aliases. */ }
    requireCondition(canonicalKey, 'INVALID_TRUST', 'Local subject must match its canonical Ed25519 key', 403)
    return this.store.transaction(() => {
      const account = this.store.one<{ kind: string }>(
        'SELECT kind FROM accounts WHERE instance=? AND id=?',
        this.instanceId,
        enrollment.accountId,
      )
      requireCondition(
        account?.kind === 'user',
        'BINDING_CONFLICT',
        'An existing canonical user wallet is required',
        409,
      )
      const existing = this.store.one<{ account: string; keyFingerprint: string; revoked: number }>(
        'SELECT account,keyFingerprint,revoked FROM localWalletIdentities WHERE instance=? AND realm=? AND subject=?',
        this.instanceId,
        this.realm,
        enrollment.subject,
      )
      requireCondition(
        !existing
          || (existing.account === enrollment.accountId && existing.keyFingerprint === enrollment.keyFingerprint
            && existing.revoked === 0),
        'BINDING_CONFLICT',
        'Local wallet authority cannot be rebound or silently restored',
        409,
      )
      if (!existing) {
        this.store.run(
          'INSERT INTO localWalletIdentities(instance,realm,subject,keyFingerprint,publicKey,account) VALUES(?,?,?,?,?,?)',
          this.instanceId,
          this.realm,
          enrollment.subject,
          enrollment.keyFingerprint,
          enrollment.publicKey,
          enrollment.accountId,
        )
      }
      this.store.assertConservation(this.instanceId)
      return enrollment.accountId
    })
  }
  /** Shared session/work resolver. Missing aliases never provision substitutes. */
  resolve(identity: LocalWalletIdentity): string {
    this.validate(identity)
    const alias = this.store.one<{ account: string; keyFingerprint: string; revoked: number }>(
      'SELECT account,keyFingerprint,revoked FROM localWalletIdentities WHERE instance=? AND realm=? AND subject=?',
      this.instanceId,
      this.realm,
      identity.subject,
    )
    requireCondition(
      alias?.revoked === 0 && alias.keyFingerprint === identity.keyFingerprint,
      'UNAUTHORIZED',
      'Local wallet authority is unavailable',
      401,
    )
    return alias!.account
  }
  /** Public key lookup is only verification input; no local session is issued until signature and alias resolve pass. */
  publicKey(subject: string): string {
    textId(subject, 'subject')
    const alias = this.store.one<{ publicKey: string; revoked: number }>(
      'SELECT publicKey,revoked FROM localWalletIdentities WHERE instance=? AND realm=? AND subject=?',
      this.instanceId,
      this.realm,
      subject,
    )
    requireCondition(alias?.revoked === 0, 'UNAUTHORIZED', 'Local wallet authority is unavailable', 401)
    return alias!.publicKey
  }
  /** Called only after local assertion signature/challenge verification; records revocation provenance. */
  session(identity: LocalWalletIdentity, now = Date.now) {
    return this.store.transaction(() => {
      const accountId = this.resolve(identity)
      const session = new Auth(this.store, now).issue(this.instanceId, accountId, 'user', 3_600_000)
      this.store.run(
        'INSERT INTO localWalletSessions VALUES(?,?,?,?)',
        hash(session.token),
        this.instanceId,
        this.realm,
        identity.subject,
      )
      return session
    })
  }
  /** Trusted explicit local delegation revocation. Remote account refresh does not reassign this identity. */
  revoke(identity: LocalWalletIdentity): void {
    this.store.transaction(() => {
      this.resolve(identity)
      this.store.run(
        'UPDATE localWalletIdentities SET revoked=1 WHERE instance=? AND realm=? AND subject=?',
        this.instanceId,
        this.realm,
        identity.subject,
      )
      this.store.run(
        'UPDATE credentials SET revoked=1 WHERE hash IN (SELECT credential FROM localWalletSessions WHERE instance=? AND realm=? AND subject=?)',
        this.instanceId,
        this.realm,
        identity.subject,
      )
    })
  }
}
