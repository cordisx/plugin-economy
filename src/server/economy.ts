import type {
  AgreementInput,
  CancelInput,
  GrantInput,
  LedgerEntry,
  Principal,
  ReserveInput,
  SettleInput,
  Wallet,
} from '../client/contracts.js'
import { Agreements } from './agreements.js'
import { Auth } from './auth.js'
import { Commerce } from './commerce.js'
import { Store } from './database.js'
import { EconomyError, requireCondition } from './errors.js'
export class Economy {
  readonly store: Store
  readonly auth: Auth
  readonly agreements: Agreements
  readonly commerce: Commerce
  constructor(path: string, now = Date.now) {
    this.store = new Store(path)
    this.auth = new Auth(this.store, now)
    this.agreements = new Agreements(this.store, now)
    this.commerce = new Commerce(this.store, now)
  }
  wallet(actor: Principal): Wallet {
    this.commerce.user(actor)
    const row = this.store.one<{ available: number; reserved: number }>(
      'SELECT available,reserved FROM accounts WHERE instance=? AND id=? AND kind=?',
      actor.instanceId,
      actor.subject,
      'user',
    )
    requireCondition(row, 'NOT_FOUND', 'Account not found', 404)
    return { instanceId: actor.instanceId, accountId: actor.subject, ...row }
  }
  request(method: string, path: string, token: string | undefined, body: unknown, key?: string): unknown {
    if (method === 'POST' && path === '/v1/session') return this.auth.login((body as { code: string })?.code)
    const actor = this.auth.authenticate(token)
    // Expiration is committed independently so a failed settle cannot roll back refunds.
    this.agreements.sweep()
    if (method === 'POST' && path === '/v1/session/rotate') return this.auth.rotate(token!)
    if (method === 'DELETE' && path === '/v1/session') {
      this.auth.revoke(token!)
      return { revoked: true }
    }
    if (method === 'GET') {
      if (path === '/v1/me') return this.wallet(actor)
      if (path === '/v1/ledger') {
        this.commerce.user(actor)
        return this.store.all<LedgerEntry>(
          'SELECT sequence,transactionId,account AS accountId,availableDelta,reservedDelta,reason,reference,createdAt FROM ledger WHERE instance=? AND account=? ORDER BY sequence DESC LIMIT 200',
          actor.instanceId,
          actor.subject,
        )
      }
      if (path === '/v1/items') {
        this.commerce.user(actor)
        return this.commerce.catalog(actor)
      }
      if (path === '/v1/orders') return this.commerce.orders(actor)
      if (path.startsWith('/v1/orders/')) return this.commerce.order(actor, path.slice('/v1/orders/'.length))
      if (path === '/v1/inventory') return this.commerce.inventory(actor)
      if (path.startsWith('/v1/agreements/')) return this.agreements.get(actor, path.slice('/v1/agreements/'.length))
    }
    requireCondition(method === 'POST', 'NOT_FOUND', 'Route not found', 404)
    requireCondition(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_INPUT', 'JSON object required')
    const operations: Record<string, () => unknown> = {
      '/v1/link-proofs': () => this.auth.linkProof(actor, body as { gameServiceId: string; gameAccountId: string }),
      '/v1/link-proofs/redeem': () => this.auth.redeemLinkProof(actor, body as { code: string; gameAccountId: string }),
      '/v1/agreements': () => this.agreements.create(actor, body as AgreementInput),
      '/v1/reserve': () => this.agreements.reserve(actor, body as ReserveInput),
      '/v1/settle': () => this.agreements.settle(actor, body as SettleInput),
      '/v1/cancel': () => this.agreements.cancel(actor, body as CancelInput),
      '/v1/orders': () => this.commerce.purchase(actor, body as { itemId: string; quantity: number }),
      '/v1/rewards/grant': () => this.commerce.grant(actor, body as GrantInput),
      '/v1/migrations/claim': () => this.commerce.claim(actor, body as { sourceId: string; entitlementId: string }),
    }
    const execute = operations[path]
    if (!execute) throw new EconomyError('NOT_FOUND', 'Route not found', 404)
    return this.store.idempotent(actor.instanceId, `${actor.kind}:${actor.subject}`, key!, path, body, execute)
  }
  close() {
    this.store.close()
  }
}
