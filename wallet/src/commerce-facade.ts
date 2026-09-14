import type { GrantReceipt, Item, Order } from '@cordisx/economy/client'
import type {
  LocalCommerceOperation,
  LocalCommercePurchase,
  LocalCommerceResult,
  LocalLegacyReceipt,
  LocalPurchaseCancelled,
  LocalPurchaseOutcome,
  LocalWalletCommerceService,
} from '@cordisx/economy/local'
import { canonical, digest } from '@cordisx/economy/spend'
import type { WalletSpendResultV1, WalletSpendV1 } from '@cordisx/protocol/wallet-spend/v1'
import type { CanonicalWalletSession } from './local-wallet.js'
/** Uses the installed formal public Protocol methods; absence remains an explicit capability result. */
export type HostCommercePort = Pick<
  WalletSpendV1,
  'contract' | 'catalog' | 'purchase' | 'cancelPurchase' | 'order' | 'orders' | 'legacyReceipt' | 'dispose'
>
type HostResult<T> = WalletSpendResultV1<T>
export function createWalletCommerceFacade(
  session: CanonicalWalletSession,
  getPort: () => HostCommercePort | undefined,
): LocalWalletCommerceService {
  const call = async <T>(
    execute: (port: HostCommercePort) => Promise<HostResult<string | null>>,
    parse: (x: unknown, instanceId: string, accountId: string) => T | Promise<T>,
    mutates = false,
  ): Promise<LocalCommerceResult<T>> => {
    if (mutates && session.readOnly) return { status: 'unavailable', reason: 'Wallet is in read-only maintenance' }
    const port = getPort()
    if (port?.contract !== 'cordisx.wallet-spend/v1') {
      return { status: 'unavailable', reason: 'Fixed local wallet authorization is unavailable' }
    }
    const client = session.client
    if (!client) return { status: 'unavailable', reason: 'Original local wallet unavailable' }
    try {
      const summary = await session.service.summary()
      if (summary.status !== 'ready' || session.client !== client) {
        return { status: 'unavailable', reason: 'Original local wallet unavailable' }
      }
      const result = await execute(port)
      if (session.client !== client) {
        return { status: 'unavailable', reason: 'Wallet connection changed; retain pending request' }
      }
      if (result.status !== 'accepted') return { status: 'unavailable', reason: result.code }
      const value = result.value === null ? null : JSON.parse(result.value)
      const parsed = await parse(value, summary.wallet.instanceId, summary.wallet.accountId)
      if (session.client !== client || getPort() !== port) {
        return { status: 'unavailable', reason: 'Wallet authorization changed; retain pending request' }
      }
      return { status: 'ready', value: parsed }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: error instanceof Error ? error.message : 'Local wallet operation unavailable',
      }
    }
  }
  const order = async (x: unknown, instanceId: string, accountId: string): Promise<LocalPurchaseOutcome | null> => {
    if (x === null) return null
    if (!x || typeof x !== 'object') throw new Error('Invalid purchase outcome')
    const cancellation = x as LocalPurchaseCancelled
    if (cancellation.state === 'cancelled') {
      if (
        cancellation.contract !== 'economy.local-purchase-cancelled/v1' || cancellation.instanceId !== instanceId
        || cancellation.accountId !== accountId || cancellation.storeId !== cancellation.input?.storeId
        || cancellation.requestId !== cancellation.input?.requestId
        || Object.keys(cancellation).sort().join(',')
          !== 'accountId,contract,input,inputHash,instanceId,requestId,state,storeId'
        || !/^[a-f0-9]{64}$/.test(cancellation.inputHash)
        || await digest(cancellation.input) !== cancellation.inputHash
      ) throw new Error('Canonical cancellation receipt mismatch')
      return cancellation
    }
    const receipt = x as Order
    if (
      !receipt || receipt.instanceId !== instanceId || receipt.accountId !== accountId || typeof receipt.id !== 'string'
      || !Number.isSafeInteger(receipt.total) || receipt.total < 0
    ) throw new Error('Canonical purchase receipt mismatch')
    return receipt
  }
  return Object.freeze({
    contract: 'economy.local-wallet-commerce/v1' as const,
    catalog: (storeId: string, operation?: LocalCommerceOperation) =>
      call(
        port =>
          port.catalog({ storeId, deadline: operation?.deadline ?? Date.now() + 15_000, signal: operation?.signal }),
        x => {
          if (
            !Array.isArray(x)
            || x.some(item =>
              item.namespace !== storeId || typeof item.id !== 'string' || typeof item.title !== 'string'
              || !Number.isSafeInteger(item.price) || item.price < 0
            )
          ) throw new Error('Canonical catalog mismatch')
          return x as Item[]
        },
      ),
    purchase: (input: LocalCommercePurchase, operation?: LocalCommerceOperation) => {
      const fixed = JSON.parse(JSON.stringify(input)) as LocalCommercePurchase
      return call(
        port =>
          port.purchase({ ...fixed, deadline: operation?.deadline ?? Date.now() + 120_000, signal: operation?.signal }),
        async (x, i, a) => {
          const receipt = await order(x, i, a)
          if (receipt && 'state' in receipt) {
            if (canonical(receipt.input) !== canonical(fixed)) throw new Error('Original cancellation intent changed')
            return receipt
          }
          if (
            !receipt || receipt.itemId !== fixed.itemId || receipt.quantity !== fixed.quantity
            || receipt.total !== fixed.expectedTotal
            || (receipt.fulfillmentTarget?.namespace !== fixed.fulfillmentTarget?.namespace
              || receipt.fulfillmentTarget?.storeId !== fixed.fulfillmentTarget?.storeId)
          ) throw new Error('Original purchase receipt differs from intent')
          return receipt
        },
        true,
      )
    },
    cancelPurchase: (input: LocalCommercePurchase, operation?: LocalCommerceOperation) => {
      const fixed = JSON.parse(JSON.stringify(input)) as LocalCommercePurchase
      return call(
        port =>
          port.cancelPurchase({
            ...fixed,
            deadline: operation?.deadline ?? Date.now() + 15_000,
            signal: operation?.signal,
          }),
        async (x, i, a) => {
          const receipt = await order(x, i, a)
          if (!receipt) throw new Error('Cancellation outcome missing; retain pending request')
          if ('state' in receipt) {
            if (canonical(receipt.input) !== canonical(fixed)) throw new Error('Original cancellation intent changed')
          } else if (
            receipt.itemId !== fixed.itemId || receipt.quantity !== fixed.quantity
            || receipt.total !== fixed.expectedTotal
            || receipt.fulfillmentTarget?.namespace !== fixed.fulfillmentTarget?.namespace
            || receipt.fulfillmentTarget?.storeId !== fixed.fulfillmentTarget?.storeId
          ) throw new Error('Original purchase receipt differs from intent')
          return receipt
        },
        true,
      )
    },
    order: (input: { storeId: string; requestId: string }, operation?: LocalCommerceOperation) => {
      const fixed = structuredClone(input)
      return call(
        port =>
          port.order({ ...fixed, deadline: operation?.deadline ?? Date.now() + 15_000, signal: operation?.signal }),
        async (x, i, a) => {
          const receipt = await order(x, i, a)
          if (
            receipt && 'state' in receipt
            && (receipt.storeId !== fixed.storeId || receipt.requestId !== fixed.requestId)
          ) throw new Error('Original cancellation lookup changed')
          return receipt
        },
      )
    },
    orders: (storeId: string, operation?: LocalCommerceOperation) =>
      call(
        port =>
          port.orders({ storeId, deadline: operation?.deadline ?? Date.now() + 15_000, signal: operation?.signal }),
        async (x, i, a) => {
          if (!Array.isArray(x)) throw new Error('Canonical orders mismatch')
          return Promise.all(x.map(async value => {
            const receipt = await order(value, i, a)
            if (!receipt || 'state' in receipt) throw new Error('Invalid order')
            return receipt
          }))
        },
      ),
    legacyReceipt: (input: LocalLegacyReceipt, operation?: LocalCommerceOperation) =>
      call(
        port =>
          port.legacyReceipt({
            ...structuredClone(input),
            deadline: operation?.deadline ?? Date.now() + 15_000,
            signal: operation?.signal,
          }),
        (x, i, a) => {
          if (x === null) return null
          const receipt = x as GrantReceipt | Order
          if (receipt.instanceId !== i || receipt.accountId !== a) {
            throw new Error('Original historical receipt mismatch')
          }
          return receipt
        },
      ),
  })
}
