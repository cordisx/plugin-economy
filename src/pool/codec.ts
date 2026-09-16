import { parseReservation, parseSigned, parseTerms } from '../spend/codec.js'
import type { PoolDecision, PoolReservation, PoolTerms } from './contracts.js'
function check(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid economy pool contract')
}
function exact(input: unknown, names: string[]): asserts input is Record<string, unknown> {
  check(
    input && typeof input === 'object' && !Array.isArray(input)
      && [Object.prototype, null].includes(Object.getPrototypeOf(input))
      && Reflect.ownKeys(input).length === names.length
      && Object.keys(input).sort().join(',') === names.sort().join(','),
  )
}
const amount = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 8_000_000_000_000
const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
export function parsePoolTerms(input: unknown): PoolTerms {
  exact(input, [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
    'matchId',
    'game',
    'participants',
    'policy',
    'acceptBefore',
    'rounds',
  ])
  check(
    input.contract === 'economy.pool-terms/v1' && ['winner-weights', 'remaining-chips'].includes(String(input.policy))
      && Number.isSafeInteger(input.rounds) && Number(input.rounds) >= 1 && Number(input.rounds) <= 1000,
  )
  const { rounds: _rounds, ...base } = input
  parseTerms({ ...base, contract: 'economy.spend-terms/v1', policy: 'capture-and-release' })
  return structuredClone(input) as PoolTerms
}
export function parsePoolReservation(input: unknown): PoolReservation {
  check(input && typeof input === 'object' && (input as PoolReservation).contract === 'economy.pool-reservation/v1')
  parseReservation({ ...input, contract: 'economy.spend-reservation/v1' })
  return structuredClone(input) as PoolReservation
}
export function parsePoolDecision(input: unknown): PoolDecision {
  exact(input, [
    'contract',
    'terms',
    'sequence',
    'previousHash',
    'phase',
    'reservations',
    'allocations',
    'remaining',
    'resultHash',
  ])
  check(
    input.contract === 'economy.pool-decision/v1' && Number.isSafeInteger(input.sequence) && Number(input.sequence) >= 1
      && (input.previousHash === null || hash(input.previousHash)) && hash(input.resultHash)
      && ['active', 'finished', 'refunded'].includes(String(input.phase)) && amount(input.remaining),
  )
  const terms = parseSigned(input.terms, parsePoolTerms)
  check(Array.isArray(input.reservations) && input.reservations.length <= 8)
  input.reservations.forEach(r => parseSigned(r, parsePoolReservation))
  check(Array.isArray(input.allocations) && input.allocations.length === terms.payload.participants.length)
  input.allocations.forEach((a, i) => {
    exact(a, ['walletId', 'paid', 'exited'])
    check(
      a.walletId === terms.payload.participants[i].walletId && amount(a.paid) && typeof a.exited === 'boolean'
        && (a.exited || a.paid === 0),
    )
  })
  check(input.phase === 'active' || (input.remaining === 0 && input.allocations.every(a => a.exited)))
  const deposits = terms.payload.participants.reduce((s, p) => s + BigInt(p.amount), 0n)
  const paid = input.allocations.reduce((s, a) => s + BigInt(a.paid), 0n)
  check(paid + BigInt(Number(input.remaining)) === deposits)
  if (input.phase === 'refunded') {
    check(input.allocations.every((a, i) => a.paid === terms.payload.participants[i].amount))
  }
  return structuredClone(input) as PoolDecision
}
