import type { WorkScopeCorrection, WorkScopeCorrectionPlan, WorkTakeoverReceipt } from '../client/contracts.js'
import { type Cursor, TOKENS_PER_COIN } from '../local/index.js'
import { canonical, hash, Store } from './database.js'
import { requireCondition, textId } from './errors.js'
export type EmptyScopeCorrectionPlan = WorkScopeCorrectionPlan
type Row = { authorization: string; completed: string | null }
/** Explicit operator authorization only; ordinary users and signed work observations cannot prepare corrections. */
export class WorkScopeCorrections {
  constructor(readonly store: Store, readonly now = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workIncomeScopeCorrections(instance TEXT NOT NULL,account TEXT NOT NULL,
      fromScope TEXT NOT NULL UNIQUE,toScope TEXT NOT NULL UNIQUE,authorization TEXT NOT NULL,completed TEXT,
      PRIMARY KEY(instance,account));`)
  }
  state(instance: string, account: string): WorkScopeCorrection | undefined {
    const row = this.store.one<Row>(
      'SELECT authorization,completed FROM workIncomeScopeCorrections WHERE instance=? AND account=?',
      instance,
      account,
    )
    if (!row) return undefined
    const authorization = JSON.parse(row.authorization)
    return {
      ...authorization,
      status: row.completed ? 'completed' : 'prepared',
      ...(row.completed ? { receipt: JSON.parse(row.completed) } : {}),
    }
  }
  retired(scope: string): boolean {
    return !!this.store.one('SELECT 1 FROM workIncomeScopeCorrections WHERE fromScope=?', scope)
  }
  pending(instance: string, account: string, scope: string): WorkScopeCorrection | undefined {
    const correction = this.state(instance, account)
    return correction?.status === 'prepared' && correction.toScopeId === scope ? correction : undefined
  }
  assertTarget(instance: string, account: string, scope: string): void {
    requireCondition(!this.retired(scope), 'WORK_SCOPE_RETIRED', 'Incorrect empty scope is permanently retired', 409)
    const row = this.store.one<{ instance: string; account: string }>(
      'SELECT instance,account FROM workIncomeScopeCorrections WHERE toScope=?',
      scope,
    )
    requireCondition(
      !row || row.instance === instance && row.account === account,
      'SCOPE_CORRECTION_CONFLICT',
      'Authorized correct scope belongs to the original account',
      409,
    )
  }
  private unpaid(scope: string): void {
    requireCondition(
      !this.store.one('SELECT 1 FROM workIncomeBindings WHERE scope=?', scope)
        && !this.store.one('SELECT 1 FROM workIncomeTakeovers WHERE scope=?', scope)
        && !this.store.one("SELECT 1 FROM workIncomeReceipts WHERE json_extract(receipt,'$.cursor.scopeId')=?", scope),
      'SCOPE_CORRECTION_CONFLICT',
      'Correct scope already has accounting custody or a receipt',
      409,
    )
  }
  private exact(plan: EmptyScopeCorrectionPlan): { takeover: WorkTakeoverReceipt; cursor: Cursor; rows: unknown } {
    const { instanceId: i, accountId: a } = plan
    const fail = (value: unknown) =>
      requireCondition(
        value,
        'SCOPE_CORRECTION_CONFLICT',
        'Empty scope accounting changed or does not match the authorized zero event',
        409,
      )
    const rows: Record<string, unknown[]> = {}
    for (
      const table of [
        'accounts',
        'workIncomeTakeovers',
        'workIncomeBindings',
        'workIncomeFrontiers',
        'workIncomeEpochs',
        'workIncomeReceipts',
        'workIncomeObservations',
        'workIncomeLeases',
        'ledger',
        'grants',
        'entitlements',
        'orders',
        'reservations',
        'historyDeclarations',
      ]
    ) {
      rows[table] = this.store.db.prepare(
        `SELECT * FROM ${table} WHERE instance=? AND ${table === 'accounts' ? 'id' : 'account'}=? ORDER BY rowid`,
      ).all(i, a)
      fail(
        rows[table].length
          === ([
              'accounts',
              'workIncomeTakeovers',
              'workIncomeBindings',
              'workIncomeFrontiers',
              'workIncomeEpochs',
              'workIncomeReceipts',
              'workIncomeObservations',
            ].includes(table)
            ? 1
            : 0),
      )
    }
    const wallet = rows.accounts[0] as { kind: string; available: number; reserved: number }
    fail(wallet.kind === 'user' && wallet.available === 0 && wallet.reserved === 0)
    fail(!this.store.one("SELECT 1 FROM sources WHERE kind='reward'"))
    const takeoverRow = rows.workIncomeTakeovers[0] as { scope: string; receipt: string }
    const takeover = JSON.parse(takeoverRow.receipt) as WorkTakeoverReceipt
    const frontier = rows.workIncomeFrontiers[0] as { cursor: string; remainder: number }
    const cursor = JSON.parse(frontier.cursor) as Cursor
    const receiptRow = rows.workIncomeReceipts[0] as { event: string; receipt: string }
    const receipt = JSON.parse(receiptRow.receipt)
    const observationRow = rows.workIncomeObservations[0] as { event: string; record: string }
    const record = JSON.parse(observationRow.record)
    fail(
      (rows.workIncomeBindings[0] as { scope: string }).scope === plan.fromScopeId
        && takeoverRow.scope === plan.fromScopeId,
    )
    fail(
      takeover.contract === 'economy.current-scope-takeover/v1' && takeover.instanceId === i && takeover.accountId === a
        && takeover.scopeId === plan.fromScopeId && takeover.policy === 'durable-admitted-v1'
        && takeover.legacyPetWorkChannel === 'closed'
        && takeover.admittedPrefix.tokens === 0 && takeover.admittedPrefix.amount === 0
        && takeover.admittedPrefix.remainder === 0,
    )
    fail(
      cursor.scopeId === plan.fromScopeId && cursor.tokens === 0 && cursor.revision === 0 && frontier.remainder === 0
        && canonical(cursor) === canonical(takeover.baseline),
    )
    fail(
      receiptRow.event === plan.expectedEventId && receipt.eventId === plan.expectedEventId && receipt.amount === 0
        && receipt.remainder === 0
        && receipt.policy === 'durable-admitted-v1' && canonical(receipt.cursor) === canonical(cursor)
        && receipt.binding.instanceId === i && receipt.binding.accountId === a
        && receipt.binding.scopeId === plan.fromScopeId,
    )
    fail(
      observationRow.event === plan.expectedEventId && record.eventId === plan.expectedEventId
        && record.kind === 'admitted-prefix'
        && record.amount === 0 && record.remainderBefore === 0 && record.remainderAfter === 0
        && record.creditedTokens === 0
        && record.snapshot.scopeId === cursor.scopeId && record.snapshot.sourceId === cursor.sourceId
        && record.snapshot.epoch === cursor.epoch
        && record.snapshot.revision === 0 && record.snapshot.eligibleTokens === 0 && record.snapshot.inputTokens === 0
        && record.snapshot.outputTokens === 0,
    )
    fail(
      !this.store.one(
        'SELECT 1 FROM workIncomeBindings WHERE scope=? AND (instance<>? OR account<>?)',
        plan.fromScopeId,
        i,
        a,
      ),
    )
    return { takeover, cursor, rows }
  }
  prepare(plan: EmptyScopeCorrectionPlan): WorkScopeCorrection {
    requireCondition(
      plan?.contract === 'economy.empty-work-scope-correction/v1'
        && Object.keys(plan).sort().join(',')
          === 'accountId,contract,evidenceDigest,expectedEventId,fromScopeId,instanceId,toScopeId',
      'INVALID_INPUT',
      'Exact empty scope correction plan required',
    )
    textId(plan.instanceId, 'instanceId')
    textId(plan.accountId, 'accountId')
    requireCondition(
      typeof plan.fromScopeId === 'string' && plan.fromScopeId.length > 0 && plan.fromScopeId.length <= 200
        && typeof plan.toScopeId === 'string' && plan.toScopeId.length > 0 && plan.toScopeId.length <= 200
        && plan.fromScopeId !== plan.toScopeId
        && /^work:[a-f0-9]{64}$/.test(plan.expectedEventId) && /^[a-f0-9]{64}$/.test(plan.evidenceDigest),
      'INVALID_INPUT',
      'Pinned scopes, zero event and reviewed evidence digest required',
    )
    return this.store.transaction(() => {
      const existing = this.state(plan.instanceId, plan.accountId)
      if (existing) {
        requireCondition(
          canonical(existing.plan) === canonical(plan),
          'SCOPE_CORRECTION_CONFLICT',
          'Another correction is already authorized',
          409,
        )
        return existing
      }
      const before = this.exact(plan)
      this.assertTarget(plan.instanceId, plan.accountId, plan.toScopeId)
      this.unpaid(plan.toScopeId)
      requireCondition(
        !this.retired(plan.toScopeId),
        'SCOPE_CORRECTION_CONFLICT',
        'Correct scope has already been retired',
        409,
      )
      const authorization: Omit<WorkScopeCorrection, 'status'> = {
        contract: 'economy.empty-work-scope-correction/v1',
        id: 'correction:' + hash(canonical(plan)),
        instanceId: plan.instanceId,
        accountId: plan.accountId,
        fromScopeId: plan.fromScopeId,
        toScopeId: plan.toScopeId,
        expectedEventId: plan.expectedEventId,
        evidenceDigest: plan.evidenceDigest,
        plan,
        audit: before.rows,
        auditDigest: hash(canonical(before.rows)),
        preparedAt: this.now(),
      }
      this.store.run(
        'INSERT INTO workIncomeScopeCorrections VALUES(?,?,?,?,?,NULL)',
        plan.instanceId,
        plan.accountId,
        plan.fromScopeId,
        plan.toScopeId,
        JSON.stringify(authorization),
      )
      return this.state(plan.instanceId, plan.accountId)!
    })
  }
  /** Called only inside the verified settlement's final IMMEDIATE transaction. No caller amount or cursor input. */
  begin(correction: WorkScopeCorrection, next: Cursor): void {
    const before = this.exact(correction.plan)
    requireCondition(
      hash(canonical(before.rows)) === correction.auditDigest && next.scopeId === correction.toScopeId
        && next.sourceId === before.cursor.sourceId,
      'SCOPE_CORRECTION_CONFLICT',
      'Authorized empty state or original work source changed',
      409,
    )
    this.unpaid(next.scopeId)
    const takeover: WorkTakeoverReceipt = {
      ...before.takeover,
      id: 'takeover:' + hash(canonical([correction.instanceId, correction.accountId, next.scopeId])),
      scopeId: next.scopeId,
      baseline: { ...next },
      createdAt: this.now(),
      admittedPrefix: {
        tokens: next.tokens,
        amount: Math.floor(next.tokens / TOKENS_PER_COIN),
        remainder: next.tokens % TOKENS_PER_COIN,
        basis: 'host-admitted-epoch-zero',
      },
    }
    this.store.run(
      'UPDATE workIncomeTakeovers SET scope=?,receipt=? WHERE instance=? AND account=?',
      next.scopeId,
      JSON.stringify(takeover),
      correction.instanceId,
      correction.accountId,
    )
    this.store.run(
      'UPDATE workIncomeBindings SET scope=? WHERE instance=? AND account=?',
      next.scopeId,
      correction.instanceId,
      correction.accountId,
    )
  }
  complete(correction: WorkScopeCorrection, receipt: unknown): void {
    this.store.run(
      'UPDATE workIncomeScopeCorrections SET completed=? WHERE instance=? AND account=? AND completed IS NULL',
      JSON.stringify(receipt),
      correction.instanceId,
      correction.accountId,
    )
  }
}
