import { randomUUID } from 'node:crypto'
import type {
  Agreement,
  AgreementInput,
  Allocation,
  CancelInput,
  Principal,
  ReserveInput,
  SettleInput,
} from '../client/contracts.js'
import { canonical, hash, Store } from './database.js'
import { integer, requireCondition, textId } from './errors.js'
type Row = {
  id: string
  instance: string
  service: string
  body: string
  termsHash: string
  state: Agreement['state']
  outcome: string | null
}
export class Agreements {
  constructor(readonly store: Store, readonly now = Date.now) {}
  allocations(value: Allocation[], participants?: Allocation[], total?: number) {
    requireCondition(
      Array.isArray(value) && value.length > 0 && value.length <= 8,
      'INVALID_INPUT',
      'One to eight allocations required',
    )
    const seen = new Set<string>()
    let sum = 0
    for (const entry of value) {
      requireCondition(entry && typeof entry === 'object', 'INVALID_INPUT', 'Allocation required')
      textId(entry.accountId, 'accountId')
      integer(entry.amount, 'amount')
      requireCondition(!seen.has(entry.accountId), 'INVALID_INPUT', 'Duplicate account')
      requireCondition(
        !participants || participants.some(p => p.accountId === entry.accountId),
        'INVALID_PAYOUT',
        'Payout recipient is not a participant',
      )
      seen.add(entry.accountId)
      sum += entry.amount
    }
    integer(sum, 'total', 1)
    if (total !== undefined) requireCondition(sum === total, 'CONSERVATION', 'Payouts must equal the complete pot')
    return sum
  }
  create(actor: Principal, body: AgreementInput): Agreement {
    requireCondition(actor.kind === 'service', 'FORBIDDEN', 'Game service credential required', 403)
    requireCondition(
      Object.keys(body).every(key =>
        ['matchId', 'game', 'participants', 'settlementPolicy', 'expiresAt'].includes(key)
      ),
      'INVALID_INPUT',
      'Unknown agreement field',
    )
    textId(body.matchId, 'matchId')
    requireCondition(body.game && typeof body.game === 'object', 'INVALID_INPUT', 'Game version disclosure required')
    textId(body.game.id, 'game.id')
    textId(body.game.version, 'game.version')
    requireCondition(
      typeof body.game.digest === 'string' && /^[a-f0-9]{64}$/.test(body.game.digest),
      'INVALID_INPUT',
      'Game digest must be SHA-256 hex',
    )
    requireCondition(
      ['reviewed', 'unreviewed'].includes(body.game.reviewStatus),
      'INVALID_INPUT',
      'Review status required',
    )
    const service = this.store.one<{ game: string; maxStake: number }>(
      'SELECT game,maxStake FROM services WHERE instance=? AND id=?',
      actor.instanceId,
      actor.subject,
    )
    requireCondition(
      service && (service.game === '*' || service.game === body.game.id),
      'FORBIDDEN',
      'Service is not authorized for this game',
      403,
    )
    const total = this.allocations(body.participants)
    const seats = new Set<string>()
    for (const p of body.participants) {
      if (p.participantIds !== undefined) {
        requireCondition(
          Array.isArray(p.participantIds) && p.participantIds.length > 0 && p.participantIds.length <= 8,
          'INVALID_INPUT',
          'One to eight disclosed participant seats required',
        )
        for (const seat of p.participantIds) {
          textId(seat, 'participantId')
          requireCondition(!seats.has(seat), 'INVALID_INPUT', 'Seat may belong to only one account')
          seats.add(seat)
        }
      }
      requireCondition(
        p.amount > 0 && p.amount <= service.maxStake,
        'LIMIT_EXCEEDED',
        'Stake exceeds authorized game service limit',
      )
      requireCondition(
        this.store.one(
          'SELECT id FROM accounts WHERE instance=? AND id=? AND kind=?',
          actor.instanceId,
          p.accountId,
          'user',
        ),
        'NOT_FOUND',
        'Participant account not found',
        404,
      )
    }
    requireCondition(
      body.settlementPolicy && typeof body.settlementPolicy === 'object',
      'INVALID_INPUT',
      'Settlement policy required',
    )
    if (body.settlementPolicy.kind === 'enumerated') {
      const outcomes = body.settlementPolicy.outcomes
      requireCondition(
        Array.isArray(outcomes) && outcomes.length > 0 && outcomes.length <= 256,
        'INVALID_INPUT',
        'One to 256 fixed outcomes required',
      )
      const seen = new Set<string>()
      for (const outcome of outcomes) {
        textId(outcome.id, 'outcome.id')
        requireCondition(!seen.has(outcome.id), 'INVALID_INPUT', 'Duplicate outcome')
        seen.add(outcome.id)
        this.allocations(outcome.payouts, body.participants, total)
      }
    } else {requireCondition(
        body.settlementPolicy.kind === 'conserved-payouts',
        'INVALID_INPUT',
        'Unknown settlement policy',
      )}
    integer(body.expiresAt, 'expiresAt', this.now() + 1000, this.now() + 86_400_000)
    requireCondition(
      !this.store.one(
        'SELECT id FROM agreements WHERE instance=? AND service=? AND match=?',
        actor.instanceId,
        actor.subject,
        body.matchId,
      ),
      'MATCH_EXISTS',
      'Match already has an agreement',
      409,
    )
    const id = randomUUID()
    // Include authority and identity in the consent hash, not merely amounts.
    const termsHash = hash(canonical({ ...body, instanceId: actor.instanceId, serviceId: actor.subject }))
    this.store.run(
      'INSERT INTO agreements VALUES(?,?,?,?,?,?,?,NULL)',
      actor.instanceId,
      id,
      actor.subject,
      body.matchId,
      canonical(body),
      termsHash,
      'open',
    )
    return this.get(actor, id)
  }
  get(actor: Principal, id: string): Agreement {
    textId(id, 'agreementId')
    const row = this.store.one<Row>('SELECT * FROM agreements WHERE instance=? AND id=?', actor.instanceId, id)
    requireCondition(row, 'NOT_FOUND', 'Agreement not found', 404)
    const input = JSON.parse(row.body) as AgreementInput
    requireCondition(
      actor.kind === 'service'
        ? row.service === actor.subject
        : input.participants.some(p => p.accountId === actor.subject),
      'FORBIDDEN',
      'Agreement belongs to another authority or account',
      403,
    )
    return {
      ...input,
      id,
      instanceId: row.instance,
      serviceId: row.service,
      termsHash: row.termsHash,
      state: row.state,
      outcomeId: row.outcome,
      reservations: this.store.all<{ account: string }>(
        'SELECT account FROM reservations WHERE instance=? AND agreement=? ORDER BY account',
        actor.instanceId,
        id,
      ).map(r => r.account),
    }
  }
  reserve(actor: Principal, body: ReserveInput): Agreement {
    requireCondition(actor.kind === 'user', 'FORBIDDEN', 'Only the user may confirm and reserve their own stake', 403)
    const agreement = this.get(actor, body.agreementId)
    requireCondition(
      body.termsHash === agreement.termsHash,
      'TERMS_CHANGED',
      'Confirm the exact disclosed terms hash',
      409,
    )
    requireCondition(
      agreement.expiresAt > this.now(),
      'AGREEMENT_EXPIRED',
      'Agreement has expired; refresh to see the refund',
      409,
    )
    requireCondition(agreement.state === 'open', 'AGREEMENT_CLOSED', 'Agreement no longer accepts reservations', 409)
    if (agreement.reservations.includes(actor.subject)) return agreement
    const stake = agreement.participants.find(p => p.accountId === actor.subject)!
    this.store.move(
      actor.instanceId,
      actor.subject,
      -stake.amount,
      stake.amount,
      'reserve',
      agreement.id,
      this.now(),
      randomUUID(),
    )
    this.store.run('INSERT INTO reservations VALUES(?,?,?)', actor.instanceId, agreement.id, actor.subject)
    return this.get(actor, agreement.id)
  }
  settle(actor: Principal, body: SettleInput): Agreement {
    requireCondition(actor.kind === 'service', 'FORBIDDEN', 'Service credential required', 403)
    const agreement = this.get(actor, body.agreementId)
    requireCondition(
      body.termsHash === agreement.termsHash,
      'TERMS_CHANGED',
      'Settlement must bind the confirmed terms hash',
      409,
    )
    requireCondition(
      agreement.expiresAt > this.now(),
      'AGREEMENT_EXPIRED',
      'Agreement has expired; refresh to see the refund',
      409,
    )
    requireCondition(agreement.state === 'open', 'AGREEMENT_CLOSED', 'Agreement already terminal', 409)
    requireCondition(
      agreement.reservations.length === agreement.participants.length,
      'NOT_FUNDED',
      'Every participant must reserve before settlement',
      409,
    )
    let payouts: Allocation[]
    if (agreement.settlementPolicy.kind === 'enumerated') {
      requireCondition(!body.payouts, 'INVALID_PAYOUT', 'Enumerated policy only accepts outcomeId')
      const outcome = agreement.settlementPolicy.outcomes.find(o => o.id === body.outcomeId)
      requireCondition(outcome, 'INVALID_PAYOUT', 'Outcome was not disclosed in the agreement')
      payouts = outcome.payouts
    } else {
      requireCondition(!body.outcomeId && body.payouts, 'INVALID_PAYOUT', 'Conserved policy requires payouts')
      payouts = body.payouts
    }
    this.allocations(payouts, agreement.participants, agreement.participants.reduce((n, p) => n + p.amount, 0))
    const tx = randomUUID()
    for (const stake of agreement.participants) {
      this.store.move(actor.instanceId, stake.accountId, 0, -stake.amount, 'settle', agreement.id, this.now(), tx)
    }
    for (const payout of payouts) {
      this.store.move(actor.instanceId, payout.accountId, payout.amount, 0, 'settle', agreement.id, this.now(), tx)
    }
    this.store.run(
      'UPDATE agreements SET state=?,outcome=? WHERE instance=? AND id=?',
      'settled',
      body.outcomeId ?? canonical(payouts),
      actor.instanceId,
      agreement.id,
    )
    return this.get(actor, agreement.id)
  }
  cancel(actor: Principal, body: CancelInput): Agreement {
    requireCondition(
      actor.kind === 'service',
      'FORBIDDEN',
      'Only the owning game service may cancel before expiry',
      403,
    )
    textId(body.reason, 'reason')
    const agreement = this.get(actor, body.agreementId)
    requireCondition(
      agreement.expiresAt > this.now(),
      'AGREEMENT_EXPIRED',
      'Agreement has expired; refresh to see the refund',
      409,
    )
    requireCondition(agreement.state === 'open', 'AGREEMENT_CLOSED', 'Agreement already terminal', 409)
    this.refund(agreement, 'cancelled')
    return this.get(actor, agreement.id)
  }
  refund(agreement: Agreement, state: 'cancelled' | 'expired') {
    const tx = randomUUID()
    for (const account of agreement.reservations) {
      const amount = agreement.participants.find(p => p.accountId === account)!.amount
      this.store.move(agreement.instanceId, account, amount, -amount, state, agreement.id, this.now(), tx)
    }
    this.store.run('UPDATE agreements SET state=? WHERE instance=? AND id=?', state, agreement.instanceId, agreement.id)
  }
  sweep() {
    this.store.transaction(() => {
      const rows = this.store.all<Row>('SELECT * FROM agreements WHERE state=?', 'open')
      for (const row of rows) {
        const input = JSON.parse(row.body) as AgreementInput
        if (input.expiresAt <= this.now()) {
          this.refund(this.get({ instanceId: row.instance, subject: row.service, kind: 'service' }, row.id), 'expired')
          this.store.assertConservation(row.instance)
        }
      }
    })
  }
}
