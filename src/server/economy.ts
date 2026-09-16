import type { LedgerEntry, Principal, Wallet } from '../client/contracts.js'
import { Agreements } from './agreements.js'
import { Auth } from './auth.js'
import { Commerce } from './commerce.js'
import { Store } from './database.js'
import { EconomyError, requireCondition } from './errors.js'
import { recoverRetired, RETIRED_MUTATIONS } from './retired-entries.js'
import { WorkIncomeIssuer } from './work-income.js'
export class Economy {
  readonly store: Store
  readonly auth: Auth
  readonly agreements: Agreements
  readonly workIncome: WorkIncomeIssuer
  readonly commerce: Commerce
  constructor(path: string, now = Date.now) {
    this.store = new Store(path)
    this.auth = new Auth(this.store, now)
    this.agreements = new Agreements(this.store, now)
    this.workIncome = new WorkIncomeIssuer(this.store, now)
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
    if (method === 'POST' && RETIRED_MUTATIONS.has(path)) return recoverRetired(this.store, actor, path, body, key)
    if (method === 'POST' && path === '/v1/session/rotate') return this.auth.rotate(token!)
    if (method === 'DELETE' && path === '/v1/session') {
      this.auth.revoke(token!)
      return { revoked: true }
    }
    if (method === 'GET') {
      const rewardSource = /^\/v1\/rewards\/sources\/([^/]+)\/accounts\/([^/]+)$/.exec(path)
      if (rewardSource) return this.commerce.rewardSource(actor, rewardSource[1]!, rewardSource[2]!)
      if (path === '/v1/income/work/state') {
        this.commerce.user(actor)
        return this.workIncome.state(actor.instanceId, actor.subject)
      }
      if (path === '/v1/me') return this.wallet(actor)
      if (path === '/v1/ledger') {
        this.commerce.user(actor)
        return this.store.all<LedgerEntry>(
          "SELECT l.sequence,l.transactionId,l.account AS accountId,l.availableDelta,l.reservedDelta,l.reason,l.reference,l.createdAt,a.service AS serviceId FROM ledger l LEFT JOIN agreements a ON a.instance=l.instance AND a.id=l.reference AND l.reason IN ('reserve','settle','cancelled','expired') WHERE l.instance=? AND l.account=? ORDER BY l.sequence DESC LIMIT 200",
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
    throw new EconomyError('NOT_FOUND', 'Route not found', 404)
  }
  close() {
    this.store.close()
  }
}
