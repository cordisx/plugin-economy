import {
  type ManagedSourceAssertionV1,
  managedSourceBinding,
  type ManagedSourceBindingV1,
  managedSourceBytes,
  type ManagedSourceEnvelopeV1,
  type ManagedSourceResultV1,
  type ManagedWorkObservationV1,
} from '@cordisx/protocol/managed-source/v1'
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { workCursor } from '../local/index.js'
import { Auth } from './auth.js'
import { hash, Store } from './database.js'
import { requireCondition } from './errors.js'
import { WorkIncomeIssuer } from './work-income.js'
export type ManagedWorkTrust = { binding: ManagedSourceBindingV1; hostPublicKey: string; serverPrivateKey: string }
/** Only explicitly provisioned local Host trust can reach issuance. Ordinary bearer sessions cannot. */
export class ManagedWorkIncome {
  readonly binding: ManagedSourceBindingV1
  readonly issuer: WorkIncomeIssuer
  readonly #hostKey
  readonly #serverKey
  constructor(readonly store: Store, trust: ManagedWorkTrust, readonly now = Date.now) {
    this.binding = managedSourceBinding(trust.binding)
    this.#hostKey = createPublicKey(trust.hostPublicKey)
    this.#serverKey = createPrivateKey(trust.serverPrivateKey)
    requireCondition(
      this.#hostKey.asymmetricKeyType === 'ed25519' && this.#serverKey.asymmetricKeyType === 'ed25519',
      'INVALID_TRUST',
      'Ed25519 managed trust is required',
    )
    this.issuer = new WorkIncomeIssuer(store, now)
    store.db.exec(`CREATE TABLE IF NOT EXISTS managedWorkChallenges(binding TEXT NOT NULL, nonce TEXT NOT NULL,
      expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(binding,nonce));`)
  }
  private signed<T>(payload: T): ManagedSourceEnvelopeV1<T> {
    return { payload, signature: sign(null, managedSourceBytes(payload), this.#serverKey).toString('base64url') }
  }
  private sameBinding(value: unknown): boolean {
    try {
      const binding = managedSourceBinding(value)
      return Object.keys(this.binding).every(key =>
        binding[key as keyof ManagedSourceBindingV1] === this.binding[key as keyof ManagedSourceBindingV1]
      )
    } catch {
      return false
    }
  }
  challenge(query: URLSearchParams) {
    requireCondition(
      [...query.keys()].length === 3 && query.getAll('sourceId').length === 1
        && query.getAll('instanceId').length === 1 && query.getAll('audience').length === 1
        && query.get('sourceId') === this.binding.sourceId && query.get('instanceId') === this.binding.instanceId
        && query.get('audience') === this.binding.audience,
      'BINDING_CONFLICT',
      'Challenge must match pinned work source',
      403,
    )
    const nonce = randomBytes(32).toString('base64url'), expiresAt = this.now() + 30000
    this.store.transaction(() => {
      // These short-lived challenges are not financial history.
      this.store.run('DELETE FROM managedWorkChallenges WHERE expires<=?', this.now())
      const pending = this.store.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM managedWorkChallenges WHERE binding=?',
        hash(JSON.stringify(this.binding)),
      )!
      requireCondition(pending.count < 128, 'CHALLENGE_BUSY', 'Too many outstanding managed challenges', 429)
      this.store.run(
        'INSERT INTO managedWorkChallenges VALUES(?,?,?,0)',
        hash(JSON.stringify(this.binding)),
        nonce,
        expiresAt,
      )
    })
    return this.signed({ contract: 'cordisx.managed-source-challenge/v1', ...this.binding, nonce, expiresAt })
  }
  submit(value: unknown): ManagedSourceEnvelopeV1<ManagedSourceResultV1> {
    requireCondition(this.binding.audience === 'work-income', 'FORBIDDEN', 'Work-income trust required', 403)
    const envelope = value as ManagedSourceEnvelopeV1<ManagedWorkObservationV1>, payload = envelope?.payload
    requireCondition(
      envelope && Object.keys(envelope).length === 2 && typeof envelope.signature === 'string'
        && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature),
      'INVALID_ASSERTION',
      'Signed Host observation required',
      403,
    )
    requireCondition(
      payload && this.sameBinding(payload) && payload.contract === 'cordisx.managed-work-observation/v1'
        && Object.keys(payload).every(key =>
          [
            'contract',
            'origin',
            'sourceId',
            'instanceId',
            'audience',
            'nonce',
            'expiresAt',
            'subject',
            'leaseId',
            'continuity',
            'snapshot',
          ].includes(key)
        )
        && /^codex:[A-Za-z0-9_-]{43}$/.test(payload.subject)
        && /^[A-Za-z0-9_-]{43}$/.test(payload.nonce) && /^[A-Za-z0-9_-]{43}$/.test(payload.leaseId)
        && ['baseline', 'continuous'].includes(payload.continuity) && Number.isSafeInteger(payload.expiresAt)
        && payload.expiresAt > this.now() && payload.expiresAt <= this.now() + 30000,
      'INVALID_ASSERTION',
      'Invalid managed work observation',
      403,
    )
    let valid = false
    try {
      valid = verify(null, managedSourceBytes(payload), this.#hostKey, Buffer.from(envelope.signature, 'base64url'))
    } catch { /* Invalid canonical bytes fail closed. */ }
    requireCondition(
      valid && Buffer.from(envelope.signature, 'base64url').toString('base64url') === envelope.signature,
      'INVALID_SIGNATURE',
      'Host signature is invalid',
      403,
    )
    this.consume(payload.nonce, payload.expiresAt)
    const accountId = `codex:${hash(JSON.stringify([payload.instanceId, payload.subject]))}`
    const snapshot = payload.snapshot
    const binding = { instanceId: payload.instanceId, accountId, scopeId: workCursor(snapshot).scopeId }
    this.issuer.provision(binding)
    const receipt = this.issuer.accept({
      binding,
      snapshot,
      baseline: payload.continuity === 'baseline',
      leaseId: payload.leaseId,
    })
    const wallet = this.store.one<{ available: number; reserved: number }>(
      'SELECT available,reserved FROM accounts WHERE instance=? AND id=?',
      binding.instanceId,
      accountId,
    )!
    return this.signed({
      contract: 'cordisx.managed-source-result/v1',
      ...this.binding,
      nonce: payload.nonce,
      subject: payload.subject,
      result: {
        wallet: { origin: this.binding.origin, instanceId: binding.instanceId, accountId, ...wallet },
        receipt,
      },
    })
  }
  private consume(nonceValue: string, expiresAt: number): void {
    this.store.transaction(() => {
      const nonce = this.store.one<{ expires: number; consumed: number }>(
        'SELECT expires,consumed FROM managedWorkChallenges WHERE binding=? AND nonce=?',
        hash(JSON.stringify(this.binding)),
        nonceValue,
      )
      requireCondition(
        nonce && !nonce.consumed && nonce.expires === expiresAt && nonce.expires > this.now(),
        'INVALID_CHALLENGE',
        'Unknown, expired or consumed Host challenge',
        403,
      )
      this.store.run(
        'UPDATE managedWorkChallenges SET consumed=1 WHERE binding=? AND nonce=?',
        hash(JSON.stringify(this.binding)),
        nonceValue,
      )
    })
  }
  session(value: unknown): ManagedSourceEnvelopeV1<ManagedSourceResultV1> {
    requireCondition(this.binding.audience === 'source-account', 'FORBIDDEN', 'Source-account trust required', 403)
    const envelope = value as ManagedSourceEnvelopeV1<ManagedSourceAssertionV1>, payload = envelope?.payload
    requireCondition(
      envelope && Object.keys(envelope).length === 2 && typeof envelope.signature === 'string'
        && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature),
      'INVALID_ASSERTION',
      'Signed Host identity required',
      403,
    )
    requireCondition(
      payload && this.sameBinding(payload) && payload.contract === 'cordisx.managed-source-assertion/v1'
        && Object.keys(payload).every(key =>
          ['contract', 'origin', 'sourceId', 'instanceId', 'audience', 'nonce', 'expiresAt', 'subject', 'displayName']
            .includes(key)
        )
        && /^codex:[A-Za-z0-9_-]{43}$/.test(payload.subject) && /^[A-Za-z0-9_-]{43}$/.test(payload.nonce)
        && (payload.displayName === undefined
          || (typeof payload.displayName === 'string' && payload.displayName.length <= 120))
        && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > this.now()
        && payload.expiresAt <= this.now() + 30000,
      'INVALID_ASSERTION',
      'Invalid managed source identity',
      403,
    )
    let valid = false
    try {
      valid = verify(null, managedSourceBytes(payload), this.#hostKey, Buffer.from(envelope.signature, 'base64url'))
    } catch { /* Reject invalid canonical values. */ }
    requireCondition(
      valid && Buffer.from(envelope.signature, 'base64url').toString('base64url') === envelope.signature,
      'INVALID_SIGNATURE',
      'Host identity signature is invalid',
      403,
    )
    this.consume(payload.nonce, payload.expiresAt)
    const accountId = `codex:${hash(JSON.stringify([payload.instanceId, payload.subject]))}`
    this.issuer.provisionIdentity(payload.instanceId, accountId)
    const session = new Auth(this.store, this.now).issue(payload.instanceId, accountId, 'user', 3600000)
    return this.signed({
      contract: 'cordisx.managed-source-result/v1',
      ...this.binding,
      nonce: payload.nonce,
      subject: payload.subject,
      result: { instanceId: payload.instanceId, account: { id: accountId }, sessionToken: session.token },
    })
  }
}
