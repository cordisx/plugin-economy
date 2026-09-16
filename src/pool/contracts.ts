import type { Signed, SpendParticipant, SpendReservation, SpendTerms } from '../spend/contracts.js'
/** Separate contract: v1 spending receipts never become transferable collateral. */
export type PoolTerms = Omit<SpendTerms, 'contract' | 'policy'> & {
  contract: 'economy.pool-terms/v1'
  policy: 'winner-weights' | 'remaining-chips'
  rounds: number
}
export type PoolReservation = Omit<SpendReservation, 'contract'> & { contract: 'economy.pool-reservation/v1' }
export type PoolAllocation = { walletId: string; paid: number; exited: boolean }
/** Cumulative payouts are linked by hash. Offline wallets replay the persisted decision chain in order. */
export type PoolDecision = {
  contract: 'economy.pool-decision/v1'
  terms: Signed<PoolTerms>
  sequence: number
  previousHash: string | null
  phase: 'active' | 'finished' | 'refunded'
  reservations: Signed<PoolReservation>[]
  allocations: PoolAllocation[]
  remaining: number
  resultHash: string
}
export type PoolStatus = {
  reservation: Signed<PoolReservation>
  sequence: number
  paid: number
  exited: boolean
  decisionHash: string | null
}
export type PoolQuote = {
  readonly terms: PoolTerms
  readonly termsHash: string
  readonly participant: SpendParticipant
}
