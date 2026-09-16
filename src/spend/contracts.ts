/** Entertainment coins are issued only by actual Host usage. This protocol cannot transfer or mint coins. */
export type Signed<T> = { payload: T; signature: string }
export type SpendParticipant = { gameAccountId: string; walletId: string; walletPublicKey: string; amount: number }
export type SpendTerms = {
  contract: 'economy.spend-terms/v1'
  serviceOrigin: string
  servicePublicKey: string
  serverId: string
  matchId: string
  game: { id: string; version: string; digest: string; reviewStatus: 'reviewed' | 'unreviewed' }
  participants: SpendParticipant[]
  policy: 'capture-and-release'
  /** Admission deadline only. A reserved receipt has no local expiry or automatic refund. */
  acceptBefore: number
}
export type SpendReservation = SpendParticipant & {
  contract: 'economy.spend-reservation/v1'
  serviceOrigin: string
  servicePublicKey: string
  serverId: string
  matchId: string
  termsHash: string
  reservationId: string
  nonce: string
}
export type SpendDecision = {
  contract: 'economy.spend-decision/v1'
  serviceOrigin: string
  servicePublicKey: string
  serverId: string
  matchId: string
  termsHash: string
  decisionId: string
  action: 'capture' | 'refund'
  entries: { reservation: Signed<SpendReservation>; captureAmount: number }[]
}
export type SpendSettlement = {
  contract: 'economy.spend-settlement/v1'
  reservationId: string
  decisionId: string
  decisionHash: string
  walletId: string
  amount: number
  captured: number
  released: number
}
export type SpendStatus = {
  reservation: Signed<SpendReservation>
  state: 'pending' | 'captured' | 'refunded'
  settlement?: Signed<SpendSettlement>
}
/** Provider is a semantic bridge. No URL, account selector, bearer, approval boolean or signing callback. */
export interface LocalWalletSpendService {
  readonly contract: 'economy.local-wallet-spend/v1'
  identity(): Promise<
    { status: 'ready'; walletId: string; walletPublicKey: string } | { status: 'unavailable'; reason: string }
  >
  bindGameAccount(challenge: Signed<WalletChallenge>): Promise<Signed<WalletBinding>>
  reserve(terms: Signed<SpendTerms>): Promise<SpendStatus>
  applyDecision(decision: Signed<SpendDecision>): Promise<SpendStatus[]>
  pending(): Promise<SpendStatus[]>
}
export const LOCAL_WALLET_SPEND_SERVICE = 'economyWalletSpend'

export type WalletChallenge = {
  contract: 'economy.spend-wallet-challenge/v1'
  serviceOrigin: string
  servicePublicKey: string
  serverId: string
  gameAccountId: string
  nonce: string
  expiresAt: number
}
export type WalletBinding = Omit<WalletChallenge, 'contract'> & {
  contract: 'economy.spend-wallet-binding/v1'
  walletId: string
  walletPublicKey: string
}
