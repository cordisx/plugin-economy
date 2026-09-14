import { type WorkTakeoverReceipt } from '../client/contracts.js'
import { type Cursor, TOKENS_PER_COIN } from '../local/index.js'
import { canonical, hash, Store } from './database.js'
import { requireCondition } from './errors.js'
/** A current-scope first issuer rule; it makes no never-enabled claim about other owners or profiles. */
export class WorkTakeover {
  constructor(readonly store: Store, readonly now = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workIncomeTakeovers(instance TEXT NOT NULL, account TEXT NOT NULL,
      scope TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(instance,account), UNIQUE(scope));`)
  }
  receipt(instance: string, account: string): WorkTakeoverReceipt | undefined {
    const r = this.store.one<{ receipt: string }>(
      'SELECT receipt FROM workIncomeTakeovers WHERE instance=? AND account=?',
      instance,
      account,
    )
    return r ? JSON.parse(r.receipt) as WorkTakeoverReceipt : undefined
  }
  blockers(instance: string, account: string): string[] {
    const blockers: string[] = []
    const wallet = this.store.one<{ kind: string; available: number; reserved: number }>(
      'SELECT kind,available,reserved FROM accounts WHERE instance=? AND id=?',
      instance,
      account,
    )
    if (wallet?.kind !== 'user' || wallet.available !== 0 || wallet.reserved !== 0) blockers.push('wallet-not-pristine')
    for (
      const table of [
        'ledger',
        'grants',
        'entitlements',
        'orders',
        'reservations',
        'workIncomeBindings',
        'workIncomeFrontiers',
        'workIncomeEpochs',
        'workIncomeReceipts',
        'workIncomeLeases',
        'workIncomeObservations',
        'historyDeclarations',
      ]
    ) {
      if (this.store.one(`SELECT 1 FROM ${table} WHERE instance=? AND account=? LIMIT 1`, instance, account)) {
        blockers.push(table)
      }
    }
    // A configured sponsor can hold a legitimate unsubmitted owner intent. Missing server grants cannot disprove it.
    if (this.store.one("SELECT 1 FROM sources WHERE kind='reward' LIMIT 1")) {
      blockers.push('legacy-sponsor-configured')
    }
    return blockers
  }
  /** Must run inside the same IMMEDIATE transaction as the verified first baseline and durable receipt. */
  establish(instance: string, account: string, cursor: Cursor): WorkTakeoverReceipt {
    requireCondition(
      this.blockers(instance, account).length === 0,
      'TAKEOVER_RECONCILIATION_REQUIRED',
      'Existing financial, sponsor or income history requires original-owner reconciliation',
      409,
    )
    requireCondition(
      !this.store.one('SELECT account FROM workIncomeBindings WHERE scope=?', cursor.scopeId),
      'BINDING_CONFLICT',
      'Work scope already has a wallet',
      409,
    )
    requireCondition(
      !this.store.one(
        "SELECT 1 FROM workIncomeReceipts WHERE json_extract(receipt, '$.cursor.scopeId')=? LIMIT 1",
        cursor.scopeId,
      ),
      'BINDING_CONFLICT',
      'Work scope has an existing income receipt requiring reconciliation',
      409,
    )
    const receipt: WorkTakeoverReceipt = {
      contract: 'economy.current-scope-takeover/v1',
      id: 'takeover:' + hash(canonical([instance, account, cursor.scopeId])),
      instanceId: instance,
      accountId: account,
      scopeId: cursor.scopeId,
      baseline: { ...cursor },
      createdAt: this.now(),
      policy: 'durable-admitted-v1',
      legacyPetWorkChannel: 'closed',
      admittedPrefix: {
        tokens: cursor.tokens,
        amount: Math.floor(cursor.tokens / TOKENS_PER_COIN),
        remainder: cursor.tokens % TOKENS_PER_COIN,
        basis: 'host-admitted-epoch-zero',
      },
      legacyHistory: 'unresolved',
    }
    this.store.run(
      'INSERT INTO workIncomeTakeovers VALUES(?,?,?,?)',
      instance,
      account,
      cursor.scopeId,
      JSON.stringify(receipt),
    )
    this.store.run('INSERT INTO workIncomeBindings VALUES(?,?,?)', instance, account, cursor.scopeId)
    return receipt
  }
}
