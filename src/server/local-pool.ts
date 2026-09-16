import { type KeyObject, randomBytes, randomUUID } from 'node:crypto'
import { parsePoolDecision, parsePoolReservation, parsePoolTerms } from '../pool/codec.js'
import type { PoolDecision, PoolQuote, PoolReservation, PoolStatus, PoolTerms } from '../pool/contracts.js'
import { canonical, parseSigned } from '../spend/codec.js'
import type { Signed } from '../spend/contracts.js'
import { requireCondition as ensure } from './errors.js'
import type { LocalSpendEngine } from './local-spend.js'
import { checked, receiptKey, signed, spendHash } from './spend-signatures.js'

type Row = {
  terms: string
  receipt: string
  sequence: number
  paid: number
  exited: number
  decisionHash: string | null
}
const sourceId = (t: PoolTerms) => spendHash({ origin: t.serviceOrigin, key: t.servicePublicKey, serverId: t.serverId })
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
/** Trusted Economy authority only. Host may hold private quote objects, never expose this engine to a renderer. */
export class LocalPoolEngine {
  readonly #key: KeyObject
  constructor(readonly wallet: LocalSpendEngine, privateKey: string | KeyObject) {
    const key = receiptKey(privateKey)
    ensure(key.publicKey === wallet.walletPublicKey, 'WALLET_KEY_CHANGED', 'Original wallet receipt key required', 403)
    this.#key = key.key
    wallet.store.db.exec(`
      CREATE TABLE IF NOT EXISTS poolReservations(instance TEXT NOT NULL,account TEXT NOT NULL,source TEXT NOT NULL,matchId TEXT NOT NULL,
        terms TEXT NOT NULL,receipt TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,paid INTEGER NOT NULL DEFAULT 0,
        exited INTEGER NOT NULL DEFAULT 0,decisionHash TEXT,PRIMARY KEY(instance,account,source,matchId));
      CREATE TABLE IF NOT EXISTS poolRequests(instance TEXT NOT NULL,account TEXT NOT NULL,source TEXT NOT NULL,requestId TEXT NOT NULL,
        matchId TEXT NOT NULL,termsHash TEXT NOT NULL,PRIMARY KEY(instance,account,source,requestId));
      CREATE TABLE IF NOT EXISTS poolDecisions(instance TEXT NOT NULL,account TEXT NOT NULL,source TEXT NOT NULL,matchId TEXT NOT NULL,
        sequence INTEGER NOT NULL,body TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(instance,account,source,matchId,sequence));
    `)
  }
  private identity(t: PoolTerms) {
    return [this.wallet.instanceId, this.wallet.accountId, sourceId(t), t.matchId]
  }
  private own(t: PoolTerms) {
    const p = t.participants.find(p =>
      p.walletId === this.wallet.walletId && p.walletPublicKey === this.wallet.walletPublicKey
    )
    ensure(p, 'WALLET_MISMATCH', 'Pool must bind the original wallet', 403)
    const binding = this.wallet.store.one<{ publicKey: string }>(
      'SELECT publicKey FROM spendBindings WHERE instance=? AND account=? AND origin=? AND serverId=? AND gameAccount=?',
      this.wallet.instanceId,
      this.wallet.accountId,
      t.serviceOrigin,
      t.serverId,
      p.gameAccountId,
    )
    ensure(
      binding?.publicKey === t.servicePublicKey,
      'BINDING_REQUIRED',
      'Original approved service binding required',
      403,
    )
    return p
  }
  private row(t: PoolTerms) {
    return this.wallet.store.one<Row>(
      'SELECT * FROM poolReservations WHERE instance=? AND account=? AND source=? AND matchId=?',
      ...this.identity(t),
    )
  }
  private status(row: Row): PoolStatus {
    return {
      reservation: JSON.parse(row.receipt),
      sequence: row.sequence,
      paid: row.paid,
      exited: !!row.exited,
      decisionHash: row.decisionHash,
    }
  }
  openSession(commitFence: () => void) {
    let active = true
    const fence = () => {
      ensure(active, 'AUTHORIZATION_RETIRED', 'Pool authorization retired', 403)
      commitFence()
    }
    const grants = new WeakMap<PoolQuote, { terms: PoolTerms; requestId: string; expires: number }>()
    return Object.freeze({
      close: () => {
        active = false
      },
      quote: (input: unknown, requestId: string): PoolQuote => {
        fence()
        const e = parseSigned(input, parsePoolTerms)
        const t = checked(e, parsePoolTerms, e.payload.servicePublicKey).payload
        const participant = this.own(t)
        ensure(
          /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId),
          'INVALID_REQUEST_ID',
          'Stable request ID required',
        )
        const old = this.row(t)
        ensure(old || t.acceptBefore > this.wallet.now(), 'ADMISSION_CLOSED', 'Pool admission closed', 409)
        const q = freeze({
          terms: structuredClone(t),
          termsHash: spendHash(t),
          participant: structuredClone(participant),
        })
        grants.set(q, {
          terms: structuredClone(t),
          requestId,
          expires: Math.min(t.acceptBefore, this.wallet.now() + 90_000),
        })
        return q
      },
      reserve: (quote: PoolQuote): PoolStatus => {
        fence()
        const g = grants.get(quote)
        ensure(g, 'AUTHORIZATION_REQUIRED', 'Original private pool quote required', 403)
        const t = g.terms, p = this.own(t), w = this.wallet, ids = this.identity(t)
        return w.store.transaction(() => {
          fence()
          const old = this.row(t)
          ensure(!old || old.terms === canonical(t), 'TERMS_CONFLICT', 'Pool terms are immutable', 409)
          const req = w.store.one<{ matchId: string; termsHash: string }>(
            'SELECT matchId,termsHash FROM poolRequests WHERE instance=? AND account=? AND source=? AND requestId=?',
            ...ids.slice(0, 3),
            g.requestId,
          )
          ensure(
            !req || (req.matchId === t.matchId && req.termsHash === spendHash(t)),
            'REQUEST_CONFLICT',
            'Request already bound to another pool',
            409,
          )
          if (!old) {
            ensure(g.expires > w.now(), 'AUTHORIZATION_EXPIRED', 'Pool quote expired', 403)
            const receipt = signed<PoolReservation>({
              contract: 'economy.pool-reservation/v1',
              serviceOrigin: t.serviceOrigin,
              servicePublicKey: t.servicePublicKey,
              serverId: t.serverId,
              matchId: t.matchId,
              termsHash: spendHash(t),
              ...p,
              reservationId: 'pool:' + spendHash({ wallet: w.walletId, source: sourceId(t), match: t.matchId }),
              nonce: randomBytes(32).toString('hex'),
            }, this.#key)
            w.store.move(
              w.instanceId,
              w.accountId,
              -p.amount,
              p.amount,
              'pool-reserve',
              receipt.payload.reservationId,
              w.now(),
              randomUUID(),
            )
            w.store.run(
              'INSERT INTO poolReservations(instance,account,source,matchId,terms,receipt) VALUES(?,?,?,?,?,?)',
              ...ids,
              canonical(t),
              canonical(receipt),
            )
          }
          if (!req) {
            w.store.run(
              'INSERT INTO poolRequests VALUES(?,?,?,?,?,?)',
              ...ids.slice(0, 3),
              g.requestId,
              t.matchId,
              spendHash(t),
            )
          }
          w.store.assertConservation(w.instanceId)
          fence()
          return this.status(this.row(t)!)
        })
      },
    })
  }
  lookup(
    source: { serviceOrigin: string; servicePublicKey: string; serverId: string },
    requestId: string,
  ): PoolStatus | null {
    const src = spendHash({ origin: source.serviceOrigin, key: source.servicePublicKey, serverId: source.serverId })
    const w = this.wallet
    const row = w.store.one<Row>(
      `SELECT r.* FROM poolRequests q JOIN poolReservations r
      ON r.instance=q.instance AND r.account=q.account AND r.source=q.source AND r.matchId=q.matchId
      WHERE q.instance=? AND q.account=? AND q.source=? AND q.requestId=?`,
      w.instanceId,
      w.accountId,
      src,
      requestId,
    )
    return row ? this.status(row) : null
  }
  applyDecision(input: unknown, fence: () => void): PoolStatus {
    fence()
    const e = parseSigned(input, parsePoolDecision)
    const d = checked(e, parsePoolDecision, e.payload.terms.payload.servicePublicKey).payload
    const t = checked(d.terms, parsePoolTerms, d.terms.payload.servicePublicKey).payload
    const w = this.wallet, participant = this.own(t), ids = this.identity(t), digest = spendHash(d)
    return w.store.transaction(() => {
      fence()
      const row = this.row(t)
      ensure(row && row.terms === canonical(t), 'POOL_NOT_RESERVED', 'Original pool reservation required', 409)
      const old = w.store.one<{ body: string; response: string }>(
        'SELECT body,response FROM poolDecisions WHERE instance=? AND account=? AND source=? AND matchId=? AND sequence=?',
        ...ids,
        d.sequence,
      )
      if (old) {
        ensure(old.body === canonical(e), 'DECISION_CONFLICT', 'Pool decision is immutable', 409)
        return JSON.parse(old.response)
      }
      ensure(
        d.sequence === row.sequence + 1 && d.previousHash === row.decisionHash,
        'DECISION_GAP',
        'Replay the original ordered settlement chain',
        409,
      )
      // Each participant is funded once. Refund may omit an unacknowledged receipt, but can only return its own principal.
      this.verifyFunding(t, d, row)
      if (row.sequence) {
        const previous = w.store.one<{ body: string }>(
          'SELECT body FROM poolDecisions WHERE instance=? AND account=? AND source=? AND matchId=? AND sequence=?',
          ...ids,
          row.sequence,
        )!
        const prior = (JSON.parse(previous.body) as Signed<PoolDecision>).payload
        ensure(
          canonical(prior.reservations) === canonical(d.reservations),
          'FUNDING_CHANGED',
          'Original funded receipt set is immutable',
          409,
        )
        ensure(prior.phase === 'active', 'POOL_FINISHED', 'Pool already finalized', 409)
        ensure(d.phase !== 'refunded', 'REFUND_AFTER_PLAY', 'Cannot refund a pool after payouts', 409)
        ensure(
          d.allocations.every((a, i) =>
            !prior.allocations[i].exited || canonical(a) === canonical(prior.allocations[i])
          ),
          'EXIT_CONFLICT',
          'Exited allocations are final',
          409,
        )
        ensure(d.remaining <= prior.remaining, 'POOL_GROWTH', 'Remaining collateral cannot increase', 409)
      }
      const allocation = d.allocations.find(a => a.walletId === w.walletId)!
      ensure(
        allocation.paid >= row.paid && (!row.exited || (allocation.exited && allocation.paid === row.paid)),
        'PAYOUT_REVERSED',
        'Committed payouts cannot change',
        409,
      )
      const debit = !row.exited && allocation.exited ? participant.amount : 0
      const credit = allocation.paid - row.paid
      const tx = 'pool:'
        + spendHash({ wallet: w.walletId, source: sourceId(t), match: t.matchId, sequence: d.sequence })
      // Imports/exports are backed by this immutable decision; they are not usage issuance or a reward grant.
      w.store.run(
        'INSERT INTO poolClearing VALUES(?,?,?,?,?)',
        w.instanceId,
        tx,
        w.accountId,
        credit - debit,
        canonical(e),
      )
      w.store.move(
        w.instanceId,
        w.accountId,
        credit,
        -debit,
        d.phase === 'refunded' ? 'pool-refund' : 'pool-settlement',
        t.matchId,
        w.now(),
        tx,
      )
      w.store.run(
        'UPDATE poolReservations SET sequence=?,paid=?,exited=?,decisionHash=? WHERE instance=? AND account=? AND source=? AND matchId=?',
        d.sequence,
        allocation.paid,
        allocation.exited ? 1 : 0,
        digest,
        ...ids,
      )
      const response = this.status(this.row(t)!)
      w.store.run(
        'INSERT INTO poolDecisions VALUES(?,?,?,?,?,?,?)',
        ...ids,
        d.sequence,
        canonical(e),
        canonical(response),
      )
      w.store.assertConservation(w.instanceId)
      fence()
      return response
    })
  }
  private verifyFunding(t: PoolTerms, d: PoolDecision, row: Row) {
    const seen = new Set<string>()
    for (const raw of d.reservations) {
      const r = checked(raw, parsePoolReservation, raw.payload.walletPublicKey).payload
      const p = t.participants.find(p => p.walletId === r.walletId)
      ensure(
        p && !seen.has(r.walletId) && p.gameAccountId === r.gameAccountId && p.walletPublicKey === r.walletPublicKey
          && p.amount === r.amount
          && r.termsHash === spendHash(t) && r.serviceOrigin === t.serviceOrigin
          && r.servicePublicKey === t.servicePublicKey
          && r.serverId === t.serverId && r.matchId === t.matchId,
        'FUNDING_MISMATCH',
        'Every receipt must match the pool terms',
        409,
      )
      if (r.walletId === this.wallet.walletId) {
        ensure(canonical(raw) === row.receipt, 'RECEIPT_CONFLICT', 'Original local receipt required', 409)
      }
      seen.add(r.walletId)
    }
    ensure(
      d.phase === 'refunded' || seen.size === t.participants.length,
      'INCOMPLETE_FUNDING',
      'All participant deposits are required',
      409,
    )
  }
}
