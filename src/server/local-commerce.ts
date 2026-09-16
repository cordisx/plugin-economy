import type { FulfillmentTarget, Item, Order } from '../client/contracts.js'
import type { LocalPurchaseCancelled } from '../local/commerce.js'
import { canonical } from '../spend/codec.js'
import { Commerce } from './commerce.js'
import { integer, requireCondition, textId } from './errors.js'
import type { LocalSpendEngine } from './local-spend.js'
import { spendHash } from './spend-signatures.js'
export type LocalPurchaseInput = {
  storeId: string
  itemId: string
  quantity: number
  expectedTotal: number
  requestId: string
  fulfillmentTarget?: FulfillmentTarget
}
export type LocalPurchaseQuote = {
  contract: 'economy.local-purchase-quote/v1'
  storeId: string
  itemId: string
  title: string
  quantity: number
  unitPrice: number
  total: number
  requestId: string
  walletId: string
  fulfillmentTarget?: FulfillmentTarget
}
/** Canonical local commerce; all methods are trusted Node provider methods, never ordinary renderer bearer mutations. */
export function openLocalCommerceSession(engine: LocalSpendEngine, current: () => void) {
  const commerce = new Commerce(engine.store, engine.now),
    actor = { kind: 'user' as const, instanceId: engine.instanceId, subject: engine.accountId },
    grants = new WeakMap<object, { input: LocalPurchaseInput; item: Item; expires: number }>()
  engine.store.db.exec(
    'CREATE TABLE IF NOT EXISTS localPurchaseRequests(instance TEXT NOT NULL,account TEXT NOT NULL,storeId TEXT NOT NULL,requestId TEXT NOT NULL,input TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(instance,account,storeId,requestId))',
  )
  const cached = (storeId: string, requestId: string) =>
    engine.store.one<{ input: string; receipt: string }>(
      'SELECT input,receipt FROM localPurchaseRequests WHERE instance=? AND account=? AND storeId=? AND requestId=?',
      engine.instanceId,
      engine.accountId,
      storeId,
      requestId,
    )
  const catalog = (storeId: string) => {
    current()
    textId(storeId, 'storeId')
    return commerce.catalog(actor).filter(x => x.namespace === storeId)
  }
  const validateInput = (raw: LocalPurchaseInput) => {
    current()
    requireCondition(
      raw && typeof raw === 'object'
        && Object.keys(raw).every(k =>
          ['storeId', 'itemId', 'quantity', 'expectedTotal', 'requestId', 'fulfillmentTarget'].includes(k)
        ),
      'INVALID_PURCHASE',
      'Fixed local purchase fields required',
    )
    const input = JSON.parse(JSON.stringify(raw)) as LocalPurchaseInput
    textId(input.storeId, 'storeId')
    textId(input.itemId, 'itemId')
    textId(input.requestId, 'requestId')
    integer(input.quantity, 'quantity', 1, 100)
    integer(input.expectedTotal, 'expectedTotal')
    if (input.fulfillmentTarget) {
      requireCondition(
        Object.keys(input.fulfillmentTarget).sort().join(',') === 'namespace,storeId'
          && input.fulfillmentTarget.namespace === input.storeId,
        'INVALID_TARGET',
        'Exact local store fulfillment required',
      )
      textId(input.fulfillmentTarget.storeId, 'fulfillmentTarget.storeId')
    }
    return input
  }
  const cancellationGrants = new WeakMap<object, { input: LocalPurchaseInput; expires: number }>()
  const quoteCancellation = (raw: LocalPurchaseInput) => {
    const input = validateInput(raw)
    const old = cached(input.storeId, input.requestId)
    requireCondition(
      !old || old.input === canonical(input),
      'REQUEST_CONFLICT',
      'Original cancellation request changed',
      409,
    )
    const quote = { contract: 'economy.local-purchase-cancellation-quote/v1', walletId: engine.walletId, input }
    const handle = Object.freeze({ quote })
    cancellationGrants.set(handle, { input: structuredClone(input), expires: engine.now() + 90_000 })
    return { handle, quote: canonical(quote) }
  }
  const quotePurchase = (raw: LocalPurchaseInput) => {
    const input = validateInput(raw)
    const item = catalog(input.storeId).find(x => x.id === input.itemId)
    requireCondition(item, 'NOT_FOUND', 'Item not in this local store', 404)
    integer(item.price * input.quantity, 'total')
    requireCondition(
      item.price * input.quantity === input.expectedTotal,
      'PRICE_CHANGED',
      'Current catalog differs from the expected total',
      409,
    )
    const old = cached(input.storeId, input.requestId)
    requireCondition(
      !old || old.input === canonical(input),
      'REQUEST_CONFLICT',
      'Original purchase request changed',
      409,
    )
    const quote: LocalPurchaseQuote = {
      contract: 'economy.local-purchase-quote/v1',
      storeId: input.storeId,
      itemId: input.itemId,
      title: item.title,
      quantity: input.quantity,
      unitPrice: item.price,
      total: input.expectedTotal,
      requestId: input.requestId,
      walletId: engine.walletId,
      ...(input.fulfillmentTarget ? { fulfillmentTarget: input.fulfillmentTarget } : {}),
    }
    const handle = Object.freeze({ quote })
    grants.set(handle, { input, item: { ...item }, expires: engine.now() + 90_000 })
    return { handle, quote: canonical(quote) }
  }
  const purchase = (handle: object): string => {
    current()
    const grant = grants.get(handle)
    requireCondition(grant, 'AUTHORIZATION_REQUIRED', 'Original private local purchase quote required', 403)
    return engine.store.transaction(() => {
      current()
      const old = cached(grant.input.storeId, grant.input.requestId)
      if (old) {
        requireCondition(old.input === canonical(grant.input), 'REQUEST_CONFLICT', 'Purchase request changed', 409)
        return old.receipt
      }
      requireCondition(grant.expires > engine.now(), 'AUTHORIZATION_EXPIRED', 'Local purchase quote expired', 403)
      const item = catalog(grant.input.storeId).find(x => x.id === grant.input.itemId)
      requireCondition(
        item && canonical(item) === canonical(grant.item),
        'PRICE_CHANGED',
        'Current catalog changed after confirmation',
        409,
      )
      const { storeId, requestId, ...body } = grant.input
      const order = commerce.purchase(actor, body)
      const receipt = canonical(order)
      engine.store.run(
        'INSERT INTO localPurchaseRequests VALUES(?,?,?,?,?,?)',
        engine.instanceId,
        engine.accountId,
        storeId,
        requestId,
        canonical(grant.input),
        receipt,
      )
      engine.store.assertConservation(engine.instanceId)
      current()
      return receipt
    })
  }
  const cancelPurchase = (handle: object): string => {
    current()
    const grant = grants.get(handle) ?? cancellationGrants.get(handle)
    requireCondition(grant, 'AUTHORIZATION_REQUIRED', 'Original private purchase quote required for cancellation', 403)
    return engine.store.transaction(() => {
      current()
      const old = cached(grant.input.storeId, grant.input.requestId)
      if (old) {
        requireCondition(
          old.input === canonical(grant.input),
          'REQUEST_CONFLICT',
          'Original cancellation request changed',
          409,
        )
        return old.receipt
      }
      requireCondition(grant.expires > engine.now(), 'AUTHORIZATION_EXPIRED', 'Local cancellation quote expired', 403)
      const receipt: LocalPurchaseCancelled = {
        contract: 'economy.local-purchase-cancelled/v1',
        state: 'cancelled',
        instanceId: engine.instanceId,
        accountId: engine.accountId,
        storeId: grant.input.storeId,
        requestId: grant.input.requestId,
        input: structuredClone(grant.input),
        inputHash: spendHash(grant.input),
      }
      engine.store.run(
        'INSERT INTO localPurchaseRequests VALUES(?,?,?,?,?,?)',
        engine.instanceId,
        engine.accountId,
        grant.input.storeId,
        grant.input.requestId,
        canonical(grant.input),
        canonical(receipt),
      )
      current()
      return canonical(receipt)
    })
  }
  return Object.freeze({
    catalog: (storeId: string) => canonical(catalog(storeId)),
    quotePurchase,
    quoteCancellation,
    purchase,
    cancelPurchase,
    order: (storeId: string, requestId: string) => {
      current()
      return cached(storeId, requestId)?.receipt ?? null
    },
    orders: (storeId: string) => {
      current()
      textId(storeId, 'storeId')
      const orders = engine.store.all<{ receipt: string }>(
        'SELECT receipt FROM localPurchaseRequests WHERE instance=? AND account=? AND storeId=? ORDER BY rowid DESC LIMIT 200',
        engine.instanceId,
        engine.accountId,
        storeId,
      ).map(x => JSON.parse(x.receipt) as Order).filter(x => !('state' in x))
      return canonical(orders)
    },
  })
}
