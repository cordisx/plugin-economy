import { randomUUID } from 'node:crypto'
import type { GrantInput, Item, Order, Principal } from '../client/contracts.js'
import { Store } from './database.js'
import { integer, requireCondition, textId } from './errors.js'
export class Commerce {
  constructor(readonly store: Store, readonly now = Date.now) {}
  user(actor: Principal) {
    requireCondition(actor.kind === 'user', 'FORBIDDEN', 'User session required', 403)
  }
  catalog(actor: Principal) {
    return this.store.all<Item>(
      'SELECT id,title,price,namespace FROM items WHERE instance=? ORDER BY id',
      actor.instanceId,
    )
  }
  purchase(actor: Principal, body: { itemId: string; quantity: number }): Order {
    this.user(actor)
    textId(body.itemId, 'itemId')
    integer(body.quantity, 'quantity', 1, 100)
    const item = this.store.one<Item>(
      'SELECT id,title,price,namespace FROM items WHERE instance=? AND id=?',
      actor.instanceId,
      body.itemId,
    )
    requireCondition(item, 'NOT_FOUND', 'Item not found', 404)
    const total = item.price * body.quantity
    integer(total, 'total', 1)
    const id = randomUUID()
    this.store.transfer(actor.instanceId, actor.subject, '$shop', total, 'purchase', id, this.now())
    this.store.run(
      'INSERT INTO orders VALUES(?,?,?,?,?,?)',
      actor.instanceId,
      id,
      actor.subject,
      item.id,
      body.quantity,
      total,
    )
    this.store.run(
      'INSERT INTO inventory VALUES(?,?,?,?) ON CONFLICT(instance,account,item) DO UPDATE SET quantity=quantity+excluded.quantity',
      actor.instanceId,
      actor.subject,
      item.id,
      body.quantity,
    )
    return { id, itemId: item.id, quantity: body.quantity, total }
  }
  orders(actor: Principal) {
    this.user(actor)
    return this.store.all<Order>(
      'SELECT id,item AS itemId,quantity,total FROM orders WHERE instance=? AND account=? ORDER BY rowid DESC LIMIT 200',
      actor.instanceId,
      actor.subject,
    )
  }
  order(actor: Principal, id: string) {
    this.user(actor)
    textId(id, 'orderId')
    const order = this.store.one<Order>(
      'SELECT id,item AS itemId,quantity,total FROM orders WHERE instance=? AND account=? AND id=?',
      actor.instanceId,
      actor.subject,
      id,
    )
    requireCondition(order, 'NOT_FOUND', 'Order not found', 404)
    return order
  }
  inventory(actor: Principal) {
    this.user(actor)
    return this.store.all<{ itemId: string; quantity: number }>(
      'SELECT item AS itemId,quantity FROM inventory WHERE instance=? AND account=? ORDER BY item',
      actor.instanceId,
      actor.subject,
    )
  }
  grant(actor: Principal, body: GrantInput) {
    requireCondition(actor.kind === 'service', 'FORBIDDEN', 'Authorized reward service required', 403)
    textId(body.sourceId, 'sourceId')
    textId(body.accountId, 'accountId')
    textId(body.eventId, 'eventId')
    integer(body.amount, 'amount', 1)
    const source = this.store.one<{ service: string; kind: string; daily: number; accountDaily: number }>(
      'SELECT * FROM sources WHERE instance=? AND id=?',
      actor.instanceId,
      body.sourceId,
    )
    requireCondition(
      source && source.service === actor.subject && source.kind === 'reward',
      'FORBIDDEN',
      'Service cannot allocate from this source',
      403,
    )
    requireCondition(
      this.store.one(
        'SELECT id FROM accounts WHERE instance=? AND id=? AND kind=?',
        actor.instanceId,
        body.accountId,
        'user',
      ),
      'NOT_FOUND',
      'Account not found',
      404,
    )
    const existing = this.store.one<{ account: string; amount: number }>(
      'SELECT account,amount FROM grants WHERE instance=? AND source=? AND event=?',
      actor.instanceId,
      body.sourceId,
      body.eventId,
    )
    if (existing) {
      requireCondition(
        existing.account === body.accountId && existing.amount === body.amount,
        'EVENT_CONFLICT',
        'Source event was already used for another grant',
        409,
      )
      return { sourceId: body.sourceId, eventId: body.eventId, amount: body.amount }
    }
    const day = Math.floor(this.now() / 86_400_000)
    const daily = this.store.one<{ total: number; accountTotal: number }>(
      'SELECT COALESCE(SUM(amount),0) AS total,COALESCE(SUM(CASE WHEN account=? THEN amount ELSE 0 END),0) AS accountTotal FROM grants WHERE instance=? AND source=? AND day=?',
      body.accountId,
      actor.instanceId,
      body.sourceId,
      day,
    )!
    requireCondition(
      daily.total + body.amount <= source.daily && daily.accountTotal + body.amount <= source.accountDaily,
      'LIMIT_EXCEEDED',
      'Reward daily allowance exceeded',
      409,
    )
    this.store.transfer(
      actor.instanceId,
      `$source:${body.sourceId}`,
      body.accountId,
      body.amount,
      'reward',
      `${body.sourceId}:${body.eventId}`,
      this.now(),
    )
    this.store.run(
      'INSERT INTO grants VALUES(?,?,?,?,?,?)',
      actor.instanceId,
      body.sourceId,
      body.eventId,
      body.accountId,
      body.amount,
      day,
    )
    return { sourceId: body.sourceId, eventId: body.eventId, amount: body.amount }
  }
  claim(actor: Principal, body: { sourceId: string; entitlementId: string }) {
    this.user(actor)
    textId(body.sourceId, 'sourceId')
    textId(body.entitlementId, 'entitlementId')
    const row = this.store.one<{ amount: number; consumed: number }>(
      'SELECT amount,consumed FROM entitlements WHERE instance=? AND source=? AND id=? AND account=?',
      actor.instanceId,
      body.sourceId,
      body.entitlementId,
      actor.subject,
    )
    requireCondition(row, 'NOT_FOUND', 'Operator-approved migration entitlement not found', 404)
    requireCondition(!row.consumed, 'MIGRATION_CONSUMED', 'Migration already applied; consult ledger', 409)
    this.store.transfer(
      actor.instanceId,
      `$source:${body.sourceId}`,
      actor.subject,
      row.amount,
      'migration',
      `${body.sourceId}:${body.entitlementId}`,
      this.now(),
    )
    this.store.run(
      'UPDATE entitlements SET consumed=1 WHERE instance=? AND source=? AND id=?',
      actor.instanceId,
      body.sourceId,
      body.entitlementId,
    )
    return { sourceId: body.sourceId, entitlementId: body.entitlementId, amount: row.amount }
  }
  /** Offline operator provisioning; funding is a conserved transfer out of the finite issuer reserve. */
  createSource(
    instance: string,
    id: string,
    service: string,
    kind: 'reward' | 'migration',
    budget: number,
    daily: number,
    accountDaily: number,
  ) {
    textId(id, 'source')
    textId(service, 'service')
    integer(budget, 'budget', 1)
    integer(daily, 'daily', 1)
    integer(accountDaily, 'accountDaily', 1)
    requireCondition(['reward', 'migration'].includes(kind), 'INVALID_INPUT', 'Invalid source kind')
    this.store.transaction(() => {
      requireCondition(
        this.store.one('SELECT id FROM services WHERE instance=? AND id=?', instance, service),
        'NOT_FOUND',
        'Service not found',
        404,
      )
      this.store.run('INSERT INTO sources VALUES(?,?,?,?,?,?)', instance, id, service, kind, daily, accountDaily)
      this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', instance, `$source:${id}`, 'system')
      this.store.transfer(instance, '$issuer', `$source:${id}`, budget, 'source-allocation', id, this.now())
      this.store.assertConservation(instance)
    })
  }
  entitlement(instance: string, source: string, id: string, account: string, amount: number) {
    textId(id, 'entitlementId')
    textId(account, 'accountId')
    integer(amount, 'amount', 1)
    this.store.transaction(() => {
      requireCondition(
        this.store.one('SELECT id FROM sources WHERE instance=? AND id=? AND kind=?', instance, source, 'migration'),
        'NOT_FOUND',
        'Migration source not found',
        404,
      )
      requireCondition(
        this.store.one('SELECT id FROM accounts WHERE instance=? AND id=? AND kind=?', instance, account, 'user'),
        'NOT_FOUND',
        'Account not found',
        404,
      )
      this.store.run('INSERT INTO entitlements VALUES(?,?,?,?,?,0)', instance, source, id, account, amount)
    })
  }
  createItem(instance: string, id: string, title: string, price: number, namespace: string) {
    textId(id, 'item')
    textId(namespace, 'namespace')
    integer(price, 'price', 1)
    requireCondition(
      typeof title === 'string' && title.length > 0 && title.length <= 100,
      'INVALID_INPUT',
      'Title must contain 1–100 characters',
    )
    this.store.run('INSERT INTO items VALUES(?,?,?,?,?)', instance, id, title, price, namespace)
  }
}
