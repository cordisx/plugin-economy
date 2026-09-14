import type { FulfillmentTarget, GrantReceipt, Item, Order } from '../client/contracts.js'
export const LOCAL_WALLET_COMMERCE_SERVICE = 'economyWalletCommerce'
export type LocalCommerceResult<T> = { status: 'ready'; value: T } | { status: 'unavailable'; reason: string }
export type LocalCommerceOperation = { deadline?: number; signal?: AbortSignal }
export type LocalCommercePurchase = {
  storeId: string
  itemId: string
  quantity: number
  expectedTotal: number
  requestId: string
  fulfillmentTarget?: FulfillmentTarget
}
export type LocalPurchaseCancelled = {
  contract: 'economy.local-purchase-cancelled/v1'
  state: 'cancelled'
  instanceId: string
  accountId: string
  storeId: string
  requestId: string
  input: LocalCommercePurchase
  inputHash: string
}
export type LocalPurchaseOutcome = Order | LocalPurchaseCancelled
export type LocalLegacyReceipt = { kind: 'grant' | 'migration' | 'purchase'; requestId: string; input: string }
/** The Economy facade delegates authorization and private dispatch to fixed Host walletSpend semantics. No URL/token/account selectors. */
export interface LocalWalletCommerceService {
  readonly contract: 'economy.local-wallet-commerce/v1'
  catalog(storeId: string, operation?: LocalCommerceOperation): Promise<LocalCommerceResult<Item[]>>
  purchase(
    input: LocalCommercePurchase,
    operation?: LocalCommerceOperation,
  ): Promise<LocalCommerceResult<LocalPurchaseOutcome>>
  cancelPurchase(
    input: LocalCommercePurchase,
    operation?: LocalCommerceOperation,
  ): Promise<LocalCommerceResult<LocalPurchaseOutcome>>
  order(
    input: { storeId: string; requestId: string },
    operation?: LocalCommerceOperation,
  ): Promise<LocalCommerceResult<LocalPurchaseOutcome | null>>
  orders(storeId: string, operation?: LocalCommerceOperation): Promise<LocalCommerceResult<Order[]>>
  legacyReceipt(
    input: LocalLegacyReceipt,
    operation?: LocalCommerceOperation,
  ): Promise<LocalCommerceResult<GrantReceipt | Order | null>>
}
