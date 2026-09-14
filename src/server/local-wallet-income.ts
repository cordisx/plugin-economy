import {
  localWalletBinding,
  type LocalWalletBindingV1,
  localWalletBytes,
  type LocalWalletEnvelopeV1,
} from '@cordisx/protocol/local-wallet/v1'
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { workCursor } from '../local/index.js'
import { Auth } from './auth.js'
import { canonical, hash, Store } from './database.js'
import { requireCondition } from './errors.js'
import { LocalWalletIdentities } from './local-wallet-identities.js'
import type { ManagedWorkTrust } from './managed-work.js'
import { WorkIncomeIssuer } from './work-income.js'
type Payload = Record<string, unknown> & { subject: string; nonce: string; expiresAt: number }
/** Explicit local identity transport. Original Native managed source routes remain independent. */
export class LocalWalletIncome {
  readonly binding: LocalWalletBindingV1
  readonly aliases: LocalWalletIdentities
  readonly issuer: WorkIncomeIssuer
  readonly #rootKey
  readonly #serverKey
  constructor(
    readonly store: Store,
    trust: ManagedWorkTrust,
    audience: LocalWalletBindingV1['audience'],
    readonly now = Date.now,
  ) {
    requireCondition(
      trust.binding.audience === (audience === 'local-work-income' ? 'work-income' : 'source-account'),
      'INVALID_TRUST',
      'Local audience requires its original provisioned trust',
    )
    this.binding = localWalletBinding({ ...trust.binding, audience })
    this.#rootKey = createPublicKey(trust.hostPublicKey)
    this.#serverKey = createPrivateKey(trust.serverPrivateKey)
    requireCondition(
      this.#rootKey.asymmetricKeyType === 'ed25519' && this.#serverKey.asymmetricKeyType === 'ed25519',
      'INVALID_TRUST',
      'Ed25519 trust required',
    )
    const realm = 'realm:' + hash(canonical({ origin: this.binding.origin, instanceId: this.binding.instanceId }))
    this.aliases = new LocalWalletIdentities(store, this.binding.instanceId, realm)
    this.issuer = new WorkIncomeIssuer(store, now)
    store.db.exec(`CREATE TABLE IF NOT EXISTS localWalletChallenges(binding TEXT NOT NULL, nonce TEXT NOT NULL,
      expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(binding,nonce));`)
  }
  private signed(payload: Record<string, unknown>) {
    return { payload, signature: sign(null, localWalletBytes(payload), this.#serverKey).toString('base64url') }
  }
  challenge(query: URLSearchParams) {
    requireCondition(
      [...query.keys()].length === 3
        && ['sourceId', 'instanceId', 'audience'].every(key =>
          query.getAll(key).length === 1 && query.get(key) === this.binding[key as keyof LocalWalletBindingV1]
        ),
      'BINDING_CONFLICT',
      'Challenge must match pinned local source',
      403,
    )
    const nonce = randomBytes(32).toString('base64url'), expiresAt = this.now() + 30_000
    this.store.transaction(() => {
      this.store.run('DELETE FROM localWalletChallenges WHERE expires<=?', this.now())
      const pending = this.store.one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM localWalletChallenges WHERE binding=?',
        hash(canonical(this.binding)),
      )!
      requireCondition(pending.n < 128, 'CHALLENGE_BUSY', 'Too many local challenges', 429)
      this.store.run(
        'INSERT INTO localWalletChallenges VALUES(?,?,?,0)',
        hash(canonical(this.binding)),
        nonce,
        expiresAt,
      )
    })
    return this.signed({ contract: 'cordisx.local-wallet-challenge/v1', ...this.binding, nonce, expiresAt })
  }
  private assertion(value: unknown, contract: string, extra: string[]): Payload {
    const envelope = value as LocalWalletEnvelopeV1<Payload>, payload = envelope?.payload
    requireCondition(
      envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        && Object.keys(envelope).sort().join(',') === 'payload,signature' && typeof envelope.signature === 'string'
        && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature),
      'INVALID_ASSERTION',
      'Signed local authority required',
      403,
    )
    let binding: LocalWalletBindingV1 | undefined
    try {
      binding = localWalletBinding(payload)
    } catch { /* Invalid binding fails closed. */ }
    const fields = [
      'contract',
      'origin',
      'sourceId',
      'instanceId',
      'audience',
      'nonce',
      'expiresAt',
      'subject',
      ...extra,
    ]
    requireCondition(
      payload && typeof payload === 'object' && !Array.isArray(payload) && binding
        && Object.keys(this.binding).every(key =>
          binding![key as keyof LocalWalletBindingV1] === this.binding[key as keyof LocalWalletBindingV1]
        ) && Object.keys(payload).every(key => fields.includes(key)) && payload.contract === contract
        && /^host-local:[A-Za-z0-9_-]{43}$/.test(payload.subject) && /^[A-Za-z0-9_-]{43}$/.test(payload.nonce)
        && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > this.now()
        && payload.expiresAt <= this.now() + 30_000,
      'INVALID_ASSERTION',
      'Invalid local assertion',
      403,
    )
    let valid = false
    try {
      const key = this.binding.audience === 'local-wallet-enrollment'
        ? this.#rootKey
        : createPublicKey({
          key: Buffer.from(this.aliases.publicKey(payload.subject), 'base64'),
          type: 'spki',
          format: 'der',
        })
      valid = verify(null, localWalletBytes(payload), key, Buffer.from(envelope.signature, 'base64url'))
    } catch { /* Unknown, revoked or invalid key/signature fails closed. */ }
    requireCondition(
      valid && Buffer.from(envelope.signature, 'base64url').toString('base64url') === envelope.signature,
      'INVALID_SIGNATURE',
      'Local authority signature invalid',
      403,
    )
    return payload
  }
  private consume(payload: Payload) {
    this.store.transaction(() => {
      const challenge = this.store.one<{ expires: number; consumed: number }>(
        'SELECT expires,consumed FROM localWalletChallenges WHERE binding=? AND nonce=?',
        hash(canonical(this.binding)),
        payload.nonce,
      )
      requireCondition(
        challenge && !challenge.consumed && challenge.expires === payload.expiresAt && challenge.expires > this.now(),
        'INVALID_CHALLENGE',
        'Unknown, expired or consumed local challenge',
        403,
      )
      this.store.run(
        'UPDATE localWalletChallenges SET consumed=1 WHERE binding=? AND nonce=?',
        hash(canonical(this.binding)),
        payload.nonce,
      )
    })
  }
  private identity(subject: string) {
    const publicKey = this.aliases.publicKey(subject)
    return {
      realm: this.aliases.realm,
      subject,
      keyFingerprint: createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex'),
    }
  }
  enroll(value: unknown, token: string | undefined) {
    requireCondition(this.binding.audience === 'local-wallet-enrollment', 'FORBIDDEN', 'Enrollment trust required', 403)
    const payload = this.assertion(value, 'cordisx.local-wallet-enrollment/v1', ['nativeSubject', 'publicKey'])
    requireCondition(
      typeof payload.nativeSubject === 'string' && /^codex:[A-Za-z0-9_-]{43}$/.test(payload.nativeSubject)
        && typeof payload.publicKey === 'string' && payload.publicKey.length <= 256,
      'INVALID_ASSERTION',
      'Original identity and local key required',
      403,
    )
    const actor = new Auth(this.store, this.now).authenticate(token)
    const accountId = 'codex:' + hash(JSON.stringify([this.binding.instanceId, payload.nativeSubject]))
    requireCondition(
      actor.kind === 'user' && actor.instanceId === this.binding.instanceId && actor.subject === accountId,
      'BINDING_CONFLICT',
      'Fresh original credential must match signed original account',
      403,
    )
    this.consume(payload)
    this.aliases.enroll({
      realm: this.aliases.realm,
      subject: payload.subject,
      publicKey: payload.publicKey,
      keyFingerprint: createHash('sha256').update(Buffer.from(payload.publicKey, 'base64')).digest('hex'),
      accountId,
    })
    return this.signed({
      contract: 'cordisx.local-wallet-result/v1',
      ...this.binding,
      nonce: payload.nonce,
      subject: payload.subject,
      nativeSubject: payload.nativeSubject,
      result: { instanceId: this.binding.instanceId, account: { id: accountId }, enrolled: true },
    })
  }
  session(value: unknown) {
    requireCondition(this.binding.audience === 'local-wallet', 'FORBIDDEN', 'Local account trust required', 403)
    const payload = this.assertion(value, 'cordisx.local-wallet-assertion/v1', [])
    this.consume(payload)
    const session = this.aliases.session(this.identity(payload.subject), this.now)
    return this.signed({
      contract: 'cordisx.local-wallet-result/v1',
      ...this.binding,
      nonce: payload.nonce,
      subject: payload.subject,
      result: { instanceId: this.binding.instanceId, account: { id: session.accountId }, sessionToken: session.token },
    })
  }
  submit(value: unknown) {
    requireCondition(this.binding.audience === 'local-work-income', 'FORBIDDEN', 'Local income trust required', 403)
    const payload = this.assertion(value, 'cordisx.local-work-observation/v1', ['leaseId', 'continuity', 'snapshot'])
    requireCondition(
      typeof payload.leaseId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(payload.leaseId)
        && ['baseline', 'continuous'].includes(String(payload.continuity)),
      'INVALID_ASSERTION',
      'Local work lease required',
      403,
    )
    this.consume(payload)
    return this.acceptWork(payload, false)
  }
  settle(value: unknown) {
    requireCondition(this.binding.audience === 'local-work-income', 'FORBIDDEN', 'Local income trust required', 403)
    const payload = this.assertion(value, 'cordisx.local-work-settlement/v1', ['snapshot'])
    this.consume(payload)
    return this.acceptWork(payload, true)
  }
  private acceptWork(payload: Payload, durable: boolean) {
    const identity = this.identity(payload.subject)
    const accountId = this.aliases.resolve(identity)
    const binding = { instanceId: this.binding.instanceId, accountId, scopeId: workCursor(payload.snapshot).scopeId }
    const state = this.issuer.state(binding.instanceId, binding.accountId)
    const firstTakeover = durable && state.status === 'pristine'
    requireCondition(
      !durable || firstTakeover || !!state.takeover,
      'TAKEOVER_RECONCILIATION_REQUIRED',
      'Original-owner income reconciliation required before policy transition',
      409,
    )
    if (!durable) this.issuer.provision(binding)
    const receipt = this.issuer.accept({
      binding,
      snapshot: payload.snapshot,
      baseline: durable ? !state.cursor : payload.continuity === 'baseline',
      ...(!durable ? { leaseId: payload.leaseId as string } : { policy: 'durable-admitted-v1' as const }),
      ...(firstTakeover ? { firstTakeover: true as const } : {}),
      authorization: () => {
        requireCondition(
          this.aliases.resolve(identity) === accountId,
          'BINDING_CONFLICT',
          'Original local delegation changed before accounting commit',
          403,
        )
      },
    })
    const wallet = this.store.one<{ available: number; reserved: number }>(
      'SELECT available,reserved FROM accounts WHERE instance=? AND id=?',
      this.binding.instanceId,
      accountId,
    )!
    return this.signed({
      contract: 'cordisx.local-wallet-result/v1',
      ...this.binding,
      nonce: payload.nonce,
      subject: payload.subject,
      result: {
        wallet: { origin: this.binding.origin, instanceId: binding.instanceId, accountId, ...wallet },
        receipt,
      },
    })
  }
}
