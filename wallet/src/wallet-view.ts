import type { LedgerEntry, Order, Wallet } from '@cordisx/economy/client'
import type { LocalWalletReadService } from '@cordisx/economy/local'
import type { WalletSession } from './session.js'
export type WalletView = {
  origin: string
  wallet?: Wallet
  ledger: LedgerEntry[]
  orders: Order[]
  error?: string
  reset?: boolean
}
/** Income synchronization can be paused while wallet reads remain healthy. */
export function walletViewFailed(view: WalletView, available: boolean): boolean {
  return !!view.error || !available
}
/** Observe existing connection state; this never authorizes or disposes the owner worker. */
export function observeWalletView(
  session: WalletSession & { service?: LocalWalletReadService },
  publish: (view: WalletView) => void,
): () => void {
  let closed = false, serial = 0, previous = session.client
  const reads = new Map<NonNullable<typeof session.client>, { dirty: boolean }>()
  const update = () => {
    const request = ++serial, client = session.client
    const reset = client !== previous
    previous = client
    const origin = session.origin || session.defaultOrigin
    if (!client) {
      publish({ origin, ledger: [], orders: [], reset: true })
      return
    }
    if (reset) publish({ origin, ledger: [], orders: [], reset: true })
    const active = reads.get(client)
    if (active) {
      active.dirty = true
      return
    }
    const batch = { dirty: false }
    reads.set(client, batch)
    const current = () => !closed && request === serial && session.client === client
    // A rejected leg must not release the batch while its sibling requests are still active.
    void Promise.allSettled([client.me(), client.ledger(), client.orders()]).then(results => {
      if (!current()) return
      const [wallet, ledger, orders] = results
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        const error = failed.reason
        publish({ origin, ledger: [], orders: [], error: error instanceof Error ? error.message : 'Request failed' })
      } else if (wallet.status === 'fulfilled' && ledger.status === 'fulfilled' && orders.status === 'fulfilled') {
        publish({ origin, wallet: wallet.value, ledger: ledger.value, orders: orders.value })
      }
    }).finally(() => {
      reads.delete(client)
      if (!closed && batch.dirty && session.client === client) update()
    })
  }
  const unsubscribe = session.subscribe(update)
  const unsubscribeIncome = session.service?.subscribeIncome?.(update)
  update()
  return () => {
    closed = true
    serial++
    unsubscribe()
    unsubscribeIncome?.()
  }
}
