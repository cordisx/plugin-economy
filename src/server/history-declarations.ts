import type { HistoryDeclarationReceipt, HistoryDeclarationRequest } from '../client/contracts.js'
import { Store } from './database.js'
import { requireCondition, textId } from './errors.js'
/** Audited policy correction only: no balances, old work records or financial ledger are mutated. */
export class HistoryDeclarations {
  constructor(readonly store: Store, readonly now = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS historyDeclarations(instance TEXT NOT NULL, account TEXT NOT NULL,
      id TEXT NOT NULL, statement TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY(instance,account,id));
      CREATE UNIQUE INDEX IF NOT EXISTS historyDeclarationActive ON historyDeclarations(instance,account)
      WHERE status IN ('pending','confirmed');`)
  }
  assertUnblocked(instance: string, account: string) {
    requireCondition(
      !this.store.one(
        "SELECT id FROM historyDeclarations WHERE instance=? AND account=? AND status='pending'",
        instance,
        account,
      ),
      'HISTORY_CORRECTION_PENDING',
      'Explicit history correction requires reconciliation',
      409,
    )
  }
  private pristine(instance: string, account: string) {
    const wallet = this.store.one<{ kind: string; available: number; reserved: number }>(
      'SELECT kind,available,reserved FROM accounts WHERE instance=? AND id=?',
      instance,
      account,
    )
    requireCondition(
      wallet?.kind === 'user' && wallet.available === 0 && wallet.reserved === 0,
      'HISTORY_STARTED',
      'History correction requires an unused zero wallet',
      409,
    )
    for (
      const table of [
        'ledger',
        'workIncomeBindings',
        'workIncomeFrontiers',
        'workIncomeReceipts',
        'workIncomeEpochs',
        'workIncomeLeases',
      ]
    ) {
      requireCondition(
        !this.store.one(`SELECT 1 FROM ${table} WHERE instance=? AND account=? LIMIT 1`, instance, account),
        'HISTORY_STARTED',
        'Income, accounting history or cutover already exists',
        409,
      )
    }
  }
  apply(instance: string, account: string, value: unknown): HistoryDeclarationReceipt {
    textId(instance, 'instance')
    textId(account, 'account')
    const request = value as HistoryDeclarationRequest
    requireCondition(
      request && Object.keys(request).sort().join(',') === 'contract,id,stage,statement'
        && request.contract === 'economy.history-declaration/v1' && /^history:[a-f0-9-]{36}$/.test(request.id)
        && ['begin', 'confirm', 'cancel', 'lookup'].includes(request.stage) && typeof request.statement === 'string'
        && request.statement.trim() === request.statement && request.statement.length > 0
        && request.statement.length <= 1000,
      'INVALID_INPUT',
      'An explicit manual history declaration is required',
    )
    return this.store.transaction(() => {
      let row = this.store.one<{ statement: string; created: number; status: HistoryDeclarationReceipt['status'] }>(
        'SELECT statement,created,status FROM historyDeclarations WHERE instance=? AND account=? AND id=?',
        instance,
        account,
        request.id,
      )
      requireCondition(
        !row || row.statement === request.statement,
        'IDEMPOTENCY_CONFLICT',
        'Preserve the original manual statement',
        409,
      )
      if (request.stage === 'begin' && !row) {
        this.pristine(instance, account)
        requireCondition(
          !this.store.one(
            "SELECT id FROM historyDeclarations WHERE instance=? AND account=? AND status IN ('pending','confirmed')",
            instance,
            account,
          ),
          'HISTORY_CONFLICT',
          'Another explicit declaration already exists',
          409,
        )
        row = { statement: request.statement, created: this.now(), status: 'pending' }
        this.store.run(
          'INSERT INTO historyDeclarations VALUES(?,?,?,?,?,?)',
          instance,
          account,
          request.id,
          row.statement,
          row.created,
          row.status,
        )
      } else if (request.stage === 'confirm') {
        requireCondition(
          row && row.status !== 'cancelled',
          'HISTORY_CONFLICT',
          'Original pending declaration required',
          409,
        )
        if (row.status === 'pending') {
          this.pristine(instance, account)
          this.store.run(
            "UPDATE historyDeclarations SET status='confirmed' WHERE instance=? AND account=? AND id=?",
            instance,
            account,
            request.id,
          )
          row.status = 'confirmed'
        }
      } else if (request.stage === 'cancel') {
        requireCondition(
          row?.status !== 'confirmed',
          'HISTORY_CONFLICT',
          'Confirmed declaration cannot be cancelled',
          409,
        )
        if (!row) {
          row = { statement: request.statement, created: this.now(), status: 'cancelled' }
          this.store.run(
            'INSERT INTO historyDeclarations VALUES(?,?,?,?,?,?)',
            instance,
            account,
            request.id,
            row.statement,
            row.created,
            row.status,
          )
        } else {
          this.store.run(
            "UPDATE historyDeclarations SET status='cancelled' WHERE instance=? AND account=? AND id=?",
            instance,
            account,
            request.id,
          )
          row.status = 'cancelled'
        }
      }
      requireCondition(
        row,
        request.stage === 'lookup' ? 'HISTORY_NOT_FOUND' : 'HISTORY_CONFLICT',
        'Original declaration required',
        request.stage === 'lookup' ? 404 : 409,
      )
      return {
        contract: 'economy.history-declaration/v1',
        instanceId: instance,
        accountId: account,
        id: request.id,
        from: 'requires-retirement',
        to: 'never-enabled',
        statement: row.statement,
        createdAt: row.created,
        status: row.status,
      }
    })
  }
}
