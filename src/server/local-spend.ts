import { type KeyObject, randomBytes, randomUUID } from 'node:crypto'
import { canonical, parseTerms } from '../spend/codec.js'
import type {
  Signed,
  SpendDecision,
  SpendParticipant,
  SpendReservation,
  SpendSettlement,
  SpendStatus,
  SpendTerms,
  WalletBinding,
  WalletChallenge,
} from '../spend/contracts.js'
import { Store } from './database.js'
import { requireCondition } from './errors.js'
import {
  checkedDecision,
  checkedReservation,
  checkedTerms,
  checkedWalletChallenge,
  decisionId,
  matchBinding,
  receiptKey,
  signed,
  spendHash,
} from './spend-signatures.js'
export type SpendQuote = {
  readonly terms: SpendTerms
  readonly termsHash: string
  readonly walletId: string
  readonly amount: number
}
export type BindingQuote = {
  readonly challenge: WalletChallenge
  readonly walletId: string
  readonly walletPublicKey: string
}
type Row = { id: string; terms: string; receipt: string; state: SpendStatus['state']; settlement: string | null }
type Grant = {
  requestId?: string
  terms: SpendTerms
  participant: SpendParticipant
  expires: number
  used?: SpendStatus
}
/** This class exists only in the trusted Node authority. It must never be exposed through renderer ctx.provide or unauthenticated HTTP. */
export class LocalSpendEngine {
  readonly #key: KeyObject
  readonly walletId: string
  readonly walletPublicKey: string
  constructor(
    readonly store: Store,
    readonly instanceId: string,
    readonly accountId: string,
    privateKey: string | KeyObject,
    readonly now = Date.now,
  ) {
    const k = receiptKey(privateKey)
    this.#key = k.key
    this.walletPublicKey = k.publicKey
    this.walletId = 'wallet:' + spendHash({ instanceId, accountId, walletPublicKey: k.publicKey })
    requireCondition(
      store.one('SELECT id FROM accounts WHERE instance=? AND id=? AND kind=?', instanceId, accountId, 'user'),
      'ORIGINAL_WALLET_REQUIRED',
      'Existing canonical user wallet required',
      403,
    )
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS spendWallets(instance TEXT NOT NULL,account TEXT NOT NULL,walletId TEXT NOT NULL,publicKey TEXT NOT NULL,PRIMARY KEY(instance,account),UNIQUE(walletId));
      CREATE TABLE IF NOT EXISTS spendReservations(instance TEXT NOT NULL,account TEXT NOT NULL,id TEXT NOT NULL,service TEXT NOT NULL,matchId TEXT NOT NULL,terms TEXT NOT NULL,receipt TEXT NOT NULL,state TEXT NOT NULL,settlement TEXT,PRIMARY KEY(instance,account,id),UNIQUE(instance,account,service,matchId));
      CREATE TABLE IF NOT EXISTS spendRequests(instance TEXT NOT NULL,account TEXT NOT NULL,service TEXT NOT NULL,requestId TEXT NOT NULL,termsHash TEXT NOT NULL,reservationId TEXT NOT NULL,PRIMARY KEY(instance,account,service,requestId));
      CREATE TABLE IF NOT EXISTS spendBindings(instance TEXT NOT NULL,account TEXT NOT NULL,origin TEXT NOT NULL,serverId TEXT NOT NULL,gameAccount TEXT NOT NULL,publicKey TEXT NOT NULL,PRIMARY KEY(instance,account,origin,serverId,gameAccount));
      CREATE TABLE IF NOT EXISTS spendBindingProofs(instance TEXT NOT NULL,account TEXT NOT NULL,id TEXT NOT NULL,challenge TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(instance,account,id));
      CREATE TABLE IF NOT EXISTS spendDecisions(instance TEXT NOT NULL,account TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(instance,account,id));`,
    )
    store.transaction(() => {
      const prior = store.one<{ walletId: string; publicKey: string }>(
        'SELECT walletId,publicKey FROM spendWallets WHERE instance=? AND account=?',
        instanceId,
        accountId,
      )
      if (prior) {
        requireCondition(
          prior.walletId === this.walletId && prior.publicKey === this.walletPublicKey,
          'WALLET_KEY_CHANGED',
          'Preserve the original receipt key and pending reservations',
          409,
        )
      } else {store.run(
          'INSERT INTO spendWallets VALUES(?,?,?,?)',
          instanceId,
          accountId,
          this.walletId,
          this.walletPublicKey,
        )}
    })
  }
  /** Trusted adapter creates this session privately, renders quote.terms in fixed confirmation UI, then passes the original quote object directly. */
  openSession(
    commitFence: () => void,
  ): {
    quote: (terms: unknown, requestId?: string) => SpendQuote
    reserve: (quote: SpendQuote) => SpendStatus
    quoteBinding: (challenge: unknown) => BindingQuote
    bindGameAccount: (quote: BindingQuote) => Signed<WalletBinding>
    close: () => void
  } {
    let active = true
    const grants = new WeakMap<SpendQuote, Grant>()
    const bindings = new WeakMap<BindingQuote, { challenge: WalletChallenge; expires: number }>()
    const fence = () => {
      requireCondition(active, 'AUTHORIZATION_RETIRED', 'Spend authorization retired', 403)
      commitFence()
    }
    return Object.freeze({
      close: () => {
        active = false
      },
      quoteBinding: (input: unknown) => {
        fence()
        const challenge = checkedWalletChallenge(input).payload
        const old = this.bindingProof(challenge)
        requireCondition(
          old || challenge.expiresAt > this.now(),
          'CHALLENGE_EXPIRED',
          'New wallet binding challenge expired',
          409,
        )
        this.checkPinnedService(challenge)
        const quote = Object.freeze({
          challenge: deepFreeze(structuredClone(challenge)),
          walletId: this.walletId,
          walletPublicKey: this.walletPublicKey,
        })
        bindings.set(quote, {
          challenge: structuredClone(challenge),
          expires: Math.min(challenge.expiresAt, this.now() + 90_000),
        })
        return quote
      },
      bindGameAccount: (quote: BindingQuote) => {
        fence()
        const grant = bindings.get(quote)
        requireCondition(grant, 'AUTHORIZATION_REQUIRED', 'Original private binding quote required', 403)
        requireCondition(
          this.bindingProof(grant.challenge) || grant.expires > this.now(),
          'AUTHORIZATION_EXPIRED',
          'Local binding quote expired',
          403,
        )
        return this.bind(grant.challenge, fence)
      },
      quote: (input: unknown, requestId?: string) => {
        fence()
        const envelope = checkedTerms(input), terms = envelope.payload
        const participant = terms.participants.find(p =>
          p.walletId === this.walletId && p.walletPublicKey === this.walletPublicKey
        )
        requireCondition(participant, 'WALLET_MISMATCH', 'Terms must bind this original wallet', 403)
        const binding = this.checkPinnedService({ ...terms, gameAccountId: participant.gameAccountId })
        requireCondition(
          binding,
          'BINDING_REQUIRED',
          'Signed game-account wallet binding required before spending',
          403,
        )
        requireCondition(
          terms.acceptBefore > this.now(),
          'ADMISSION_CLOSED',
          'Terms no longer admit new reservations',
          409,
        )
        requireCondition(
          requestId === undefined || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId),
          'INVALID_REQUEST_ID',
          'Stable request identifier required',
        )
        const grant: Grant = {
          requestId,
          terms: parseTerms(terms),
          participant: { ...participant },
          expires: Math.min(terms.acceptBefore, this.now() + 90_000),
        }
        const quote = Object.freeze({
          terms: deepFreeze(parseTerms(terms)),
          termsHash: spendHash(terms),
          walletId: this.walletId,
          amount: participant.amount,
        })
        grants.set(quote, grant)
        return quote
      },
      reserve: (quote: SpendQuote) => {
        fence()
        const grant = grants.get(quote)
        requireCondition(grant, 'AUTHORIZATION_REQUIRED', 'Only this session original quoted approval may reserve', 403)
        if (grant.used) return structuredClone(grant.used)
        const result = this.reserve(grant, fence)
        grant.used = result
        return structuredClone(result)
      },
    })
  }
  private checkPinnedService(
    challenge: { serviceOrigin: string; serverId: string; gameAccountId: string; servicePublicKey: string },
  ): boolean {
    const old = this.store.one<{ publicKey: string }>(
      'SELECT publicKey FROM spendBindings WHERE instance=? AND account=? AND origin=? AND serverId=? AND gameAccount=?',
      this.instanceId,
      this.accountId,
      challenge.serviceOrigin,
      challenge.serverId,
      challenge.gameAccountId,
    )
    requireCondition(
      !old || old.publicKey === challenge.servicePublicKey,
      'SERVICE_KEY_CHANGED',
      'Original service key cannot be rebound automatically',
      409,
    )
    return !!old
  }
  private bindingProof(challenge: WalletChallenge): Signed<WalletBinding> | undefined {
    const row = this.store.one<{ challenge: string; proof: string }>(
      'SELECT challenge,proof FROM spendBindingProofs WHERE instance=? AND account=? AND id=?',
      this.instanceId,
      this.accountId,
      spendHash(challenge),
    )
    if (!row) return
    requireCondition(
      row.challenge === canonical(challenge),
      'CHALLENGE_CONFLICT',
      'Original binding challenge changed',
      409,
    )
    return JSON.parse(row.proof)
  }
  private bind(challenge: WalletChallenge, fence: () => void): Signed<WalletBinding> {
    return this.store.transaction(() => {
      fence()
      const old = this.bindingProof(challenge)
      if (old) return old
      requireCondition(challenge.expiresAt > this.now(), 'CHALLENGE_EXPIRED', 'Wallet binding challenge expired', 409)
      const pinned = this.checkPinnedService(challenge)
      const proof = signed({
        ...challenge,
        contract: 'economy.spend-wallet-binding/v1' as const,
        walletId: this.walletId,
        walletPublicKey: this.walletPublicKey,
      }, this.#key)
      if (!pinned) {
        this.store.run(
          'INSERT INTO spendBindings VALUES(?,?,?,?,?,?)',
          this.instanceId,
          this.accountId,
          challenge.serviceOrigin,
          challenge.serverId,
          challenge.gameAccountId,
          challenge.servicePublicKey,
        )
      }
      this.store.run(
        'INSERT INTO spendBindingProofs VALUES(?,?,?,?,?)',
        this.instanceId,
        this.accountId,
        spendHash(challenge),
        canonical(challenge),
        canonical(proof),
      )
      fence()
      return proof
    })
  }
  private reserve(grant: Grant, fence: () => void): SpendStatus {
    const { terms, participant } = grant,
      service = spendHash({ origin: terms.serviceOrigin, key: terms.servicePublicKey, serverId: terms.serverId })
    return this.store.transaction(() => {
      fence()
      requireCondition(
        this.checkPinnedService({ ...terms, gameAccountId: participant.gameAccountId }),
        'BINDING_REQUIRED',
        'Original signed game-account binding required',
        403,
      )
      const old = this.store.one<Row>(
        'SELECT id,terms,receipt,state,settlement FROM spendReservations WHERE instance=? AND account=? AND service=? AND matchId=?',
        this.instanceId,
        this.accountId,
        service,
        terms.matchId,
      )
      if (old) {
        requireCondition(
          old.terms === canonical(terms),
          'TERMS_CONFLICT',
          'Match already has immutable wallet terms',
          409,
        )
        this.saveRequest(grant, service, old.id)
        fence()
        return this.status(old)
      }
      requireCondition(
        grant.expires > this.now() && terms.acceptBefore > this.now(),
        'AUTHORIZATION_EXPIRED',
        'Fresh confirmation or admission expired',
        403,
      )
      const id = 'reservation:'
        + spendHash({ walletId: this.walletId, service, matchId: terms.matchId, termsHash: spendHash(terms) })
      const payload: SpendReservation = {
        contract: 'economy.spend-reservation/v1',
        serviceOrigin: terms.serviceOrigin,
        servicePublicKey: terms.servicePublicKey,
        serverId: terms.serverId,
        matchId: terms.matchId,
        termsHash: spendHash(terms),
        ...participant,
        reservationId: id,
        nonce: randomBytes(32).toString('hex'),
      }
      const receipt = signed(payload, this.#key)
      fence()
      this.store.move(
        this.instanceId,
        this.accountId,
        -participant.amount,
        participant.amount,
        'spend-reserve',
        id,
        this.now(),
        randomUUID(),
      )
      this.store.run(
        'INSERT INTO spendReservations VALUES(?,?,?,?,?,?,?,?,NULL)',
        this.instanceId,
        this.accountId,
        id,
        service,
        terms.matchId,
        canonical(terms),
        canonical(receipt),
        'pending',
      )
      this.saveRequest(grant, service, id)
      this.store.assertConservation(this.instanceId)
      fence()
      return { reservation: receipt, state: 'pending' }
    })
  }
  private saveRequest(grant: Grant, service: string, id: string) {
    if (!grant.requestId) return
    const old = this.store.one<{ termsHash: string; reservationId: string }>(
      'SELECT termsHash,reservationId FROM spendRequests WHERE instance=? AND account=? AND service=? AND requestId=?',
      this.instanceId,
      this.accountId,
      service,
      grant.requestId,
    )
    requireCondition(
      !old || (old.termsHash === spendHash(grant.terms) && old.reservationId === id),
      'REQUEST_CONFLICT',
      'Request ID is already bound to other immutable terms',
      409,
    )
    if (!old) {
      this.store.run(
        'INSERT INTO spendRequests VALUES(?,?,?,?,?,?)',
        this.instanceId,
        this.accountId,
        service,
        grant.requestId,
        spendHash(grant.terms),
        id,
      )
    }
  }
  lookupRequest(
    source: { serviceOrigin: string; servicePublicKey: string; serverId: string },
    requestId: string,
  ): SpendStatus | null {
    const service = spendHash({ origin: source.serviceOrigin, key: source.servicePublicKey, serverId: source.serverId })
    const row = this.store.one<{ reservationId: string }>(
      'SELECT reservationId FROM spendRequests WHERE instance=? AND account=? AND service=? AND requestId=?',
      this.instanceId,
      this.accountId,
      service,
      requestId,
    )
    return row ? this.lookup(row.reservationId) : null
  }
  lookup(id: string): SpendStatus {
    const row = this.store.one<Row>(
      'SELECT id,terms,receipt,state,settlement FROM spendReservations WHERE instance=? AND account=? AND id=?',
      this.instanceId,
      this.accountId,
      id,
    )
    requireCondition(row, 'NOT_FOUND', 'Reservation not found', 404)
    return this.status(row)
  }
  pending(): SpendStatus[] {
    return this.store.all<Row>(
      'SELECT id,terms,receipt,state,settlement FROM spendReservations WHERE instance=? AND account=? AND state=? ORDER BY id',
      this.instanceId,
      this.accountId,
      'pending',
    ).map(row => this.status(row))
  }
  applyDecision(input: unknown, commitFence: () => void): SpendStatus[] {
    const envelope = checkedDecision(input), decision = envelope.payload, body = canonical(envelope)
    return this.store.transaction(() => {
      commitFence()
      const existing = this.store.one<{ body: string }>(
        'SELECT body FROM spendDecisions WHERE instance=? AND account=? AND id=?',
        this.instanceId,
        this.accountId,
        decision.decisionId,
      )
      requireCondition(!existing || existing.body === body, 'DECISION_CONFLICT', 'Service decision is immutable', 409)
      const rows = this.store.all<Row>(
        'SELECT id,terms,receipt,state,settlement FROM spendReservations WHERE instance=? AND account=?',
        this.instanceId,
        this.accountId,
      )
        .filter(row => matchBinding(parseTerms(JSON.parse(row.terms)), decision))
      requireCondition(rows.length > 0, 'NOT_FOUND', 'Decision has no original local reservation', 404)
      const terms = parseTerms(JSON.parse(rows[0].terms))
      requireCondition(
        decision.decisionId === decisionId(terms),
        'DECISION_MISMATCH',
        'Decision must identify the exact immutable match terms',
        409,
      )
      this.checkEntries(terms, decision)
      for (const row of rows) {
        const receipt = JSON.parse(row.receipt) as Signed<SpendReservation>
        const entry = decision.entries.find(x => x.reservation.payload.reservationId === row.id)
        if (entry) {
          requireCondition(
            canonical(entry.reservation) === row.receipt,
            'RECEIPT_MISMATCH',
            'Decision must use the exact persisted reservation nonce and signature',
            409,
          )
        }
        requireCondition(
          decision.action === 'refund' || entry,
          'INCOMPLETE_CAPTURE',
          'Capture requires the exact original wallet reservation',
          409,
        )
        if (row.state !== 'pending') {
          requireCondition(
            existing,
            'DECISION_CONFLICT',
            'Reservation already terminal under a different decision',
            409,
          )
          continue
        }
        const captured = entry?.captureAmount ?? 0, released = receipt.payload.amount - captured
        const settlement: SpendSettlement = {
          contract: 'economy.spend-settlement/v1',
          reservationId: row.id,
          decisionId: decision.decisionId,
          decisionHash: spendHash(decision),
          walletId: this.walletId,
          amount: receipt.payload.amount,
          captured,
          released,
        }
        const signedSettlement = signed(settlement, this.#key)
        commitFence()
        this.store.move(
          this.instanceId,
          this.accountId,
          released,
          -receipt.payload.amount,
          captured ? 'spend-capture' : 'spend-refund',
          row.id,
          this.now(),
          randomUUID(),
        )
        if (captured) {
          this.store.run(
            'UPDATE instances SET supply=supply-? WHERE id=? AND supply>=?',
            captured,
            this.instanceId,
            captured,
          )
        }
        this.store.run(
          'UPDATE spendReservations SET state=?,settlement=? WHERE instance=? AND account=? AND id=?',
          captured ? 'captured' : 'refunded',
          canonical(signedSettlement),
          this.instanceId,
          this.accountId,
          row.id,
        )
      }
      if (!existing) {
        this.store.run(
          'INSERT INTO spendDecisions VALUES(?,?,?,?)',
          this.instanceId,
          this.accountId,
          decision.decisionId,
          body,
        )
      }
      this.store.assertConservation(this.instanceId)
      commitFence()
      return rows.map(row => this.lookup(row.id))
    })
  }
  private checkEntries(terms: SpendTerms, decision: SpendDecision) {
    const seen = new Set()
    for (const entry of decision.entries) {
      const receipt = checkedReservation(entry.reservation), r = receipt.payload
      requireCondition(matchBinding(terms, r), 'RECEIPT_MISMATCH', 'Receipt belongs to different service or terms', 409)
      const p = terms.participants.find(p =>
        p.gameAccountId === r.gameAccountId && p.walletId === r.walletId && p.walletPublicKey === r.walletPublicKey
        && p.amount === r.amount
      )
      requireCondition(
        p && !seen.has(p.gameAccountId),
        'PARTICIPANT_MISMATCH',
        'Receipt must cover one unique disclosed participant',
        409,
      )
      seen.add(p.gameAccountId)
    }
    requireCondition(
      decision.action === 'refund' || seen.size === terms.participants.length,
      'INCOMPLETE_CAPTURE',
      'Capture must cover every disclosed participant',
      409,
    )
  }
  private status(row: Row): SpendStatus {
    return {
      reservation: JSON.parse(row.receipt),
      state: row.state,
      ...(row.settlement ? { settlement: JSON.parse(row.settlement) } : {}),
    }
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
