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
  /** Authoritative agreement service provenance; never a wallet namespace. */
  serviceId?: string | null
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
export type FulfillmentTarget = { namespace: string; storeId: string }
export type PurchaseInput = {
  itemId: string
  quantity: number
  expectedTotal?: number
  fulfillmentTarget?: FulfillmentTarget
}
export type Order = {
  fulfillmentTarget?: FulfillmentTarget
  instanceId: string
  accountId: string
  id: string
  itemId: string
  quantity: number
  total: number
}
export type GrantInput = {
  sourceId: string
  accountId: string
  eventId: string
  amount: number
  expectedInstanceId?: string
}
export type GrantReceipt = { instanceId: string; accountId: string; sourceId: string; eventId: string; amount: number }
export type RewardSourceStatus = {
  instanceId: string
  accountId: string
  serviceId: string
  sourceId: string
  available: number
  dailyLimit: number
  accountDailyLimit: number
  dailyGranted: number
  accountDailyGranted: number
  resetsAt: number
}
export type ApiErrorBody = { error: { code: string; message: string; retryable: boolean } }

export type HistoryDeclarationRequest = {
  contract: 'economy.history-declaration/v1'
  id: string
  stage: 'begin' | 'confirm' | 'cancel' | 'lookup'
  statement: string
}
export type HistoryDeclarationReceipt = {
  contract: 'economy.history-declaration/v1'
  instanceId: string
  accountId: string
  id: string
  from: 'requires-retirement'
  to: 'never-enabled'
  statement: string
  createdAt: number
  status: 'pending' | 'confirmed' | 'cancelled'
}

export type WorkTakeoverReceipt = {
  contract: 'economy.current-scope-takeover/v1'
  id: string
  instanceId: string
  accountId: string
  scopeId: string
  baseline: {
    scopeId: string
    sourceId: string
    epoch: string
    revision: number
    tokens: number
    observedThrough: number
  }
  createdAt: number
  policy: 'durable-admitted-v1'
  legacyPetWorkChannel: 'closed'
  admittedPrefix: { tokens: number; amount: number; remainder: number; basis: 'host-admitted-epoch-zero' }
  legacyHistory: 'unresolved'
}
export type WorkIncomeRecord = {
  eventId: string
  kind: 'admitted-prefix-correction' | 'admitted-prefix' | 'admitted-delta' | 'epoch-anchor' | 'legacy-observation'
  amount: number
  remainderBefore: number
  remainderAfter: number
  creditedTokens: number
  snapshot: unknown
  from?: WorkTakeoverReceipt['baseline']
  createdAt: number
}
export type WorkScopeCorrectionPlan = {
  contract: 'economy.empty-work-scope-correction/v1'
  instanceId: string
  accountId: string
  fromScopeId: string
  toScopeId: string
  expectedEventId: string
  evidenceDigest: string
}
export type WorkScopeCorrection = WorkScopeCorrectionPlan & {
  id: string
  status: 'prepared' | 'completed'
  plan: WorkScopeCorrectionPlan
  audit: unknown
  auditDigest: string
  preparedAt: number
  receipt?: unknown
}
export type WorkIncomeState = {
  scopeCorrection?: WorkScopeCorrection
  instanceId: string
  accountId: string
  status: 'pristine' | 'active' | 'reconciliation-required'
  blockers: string[]
  takeover?: WorkTakeoverReceipt
  cursor?: WorkTakeoverReceipt['baseline']
  remainder: number
  earned: number
  legacySponsoredEarned: number
  records: WorkIncomeRecord[]
}
