/** Integers are bounded below Number.MAX_SAFE_INTEGER; an instance never exchanges assets. */
export const MAX_TOKENS = 1_000_000_000_000
export type Principal = { instanceId: string; kind: 'user' | 'service'; subject: string }
export type Game = { id: string; version: string; digest: string; reviewStatus: 'unreviewed' | 'reviewed' }
export type Allocation = { accountId: string; amount: number; participantIds?: string[] }
export type Outcome = { id: string; payouts: Allocation[] }
export type AgreementInput = {
  matchId: string
  game: Game
  participants: Allocation[]
  settlementPolicy: { kind: 'enumerated'; outcomes: Outcome[] } | { kind: 'conserved-payouts' }
  expiresAt: number
}
export type Agreement = AgreementInput & {
  id: string
  instanceId: string
  serviceId: string
  termsHash: string
  state: 'open' | 'settled' | 'cancelled' | 'expired'
  outcomeId: string | null
  reservations: string[]
}
export type ReserveInput = { agreementId: string; termsHash: string }
export type SettleInput =
  & { agreementId: string; termsHash: string }
  & ({ outcomeId: string; payouts?: never } | { payouts: Allocation[]; outcomeId?: never })
export type CancelInput = { agreementId: string; reason: string }
export type Wallet = { instanceId: string; accountId: string; available: number; reserved: number }
export type LedgerEntry = {
  sequence: number
  transactionId: string
  accountId: string
  availableDelta: number
  reservedDelta: number
  reason: string
  reference: string
  createdAt: number
}
export type Item = { id: string; title: string; price: number; namespace: string }
export type Order = {
  instanceId: string
  accountId: string
  id: string
  itemId: string
  quantity: number
  total: number
}
export type GrantInput = { sourceId: string; accountId: string; eventId: string; amount: number }
export type ApiErrorBody = { error: { code: string; message: string; retryable: boolean } }
