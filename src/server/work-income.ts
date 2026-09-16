import { randomUUID } from 'node:crypto'
import type { WorkIncomeRecord, WorkIncomeState } from '../client/contracts.js'
import { type Cursor, TOKENS_PER_COIN, workCursor } from '../local/index.js'
import { canonical, hash, Store } from './database.js'
import { requireCondition, textId } from './errors.js'
import { HistoryDeclarations } from './history-declarations.js'
import { WorkScopeCorrections } from './work-scope-correction.js'
import { WorkTakeover } from './work-takeover.js'
export type WorkIncomeBinding = { instanceId: string; accountId: string; scopeId: string }
/** Only a pinned Host verifier may construct this value. Never deserialize it from a user bearer request. */
export type VerifiedWorkObservation = {
  binding: WorkIncomeBinding
  snapshot: unknown
  baseline: boolean
  leaseId?: string
  /** Only local Host signature verification may request this pristine first baseline. */
  policy?: 'durable-admitted-v1'
  /** Private verifier rechecks original delegation under the financial transaction lock. */
  authorization?: () => void
  firstTakeover?: true
}
export type WorkIncomeReceipt = {
  eventId: string
  binding: WorkIncomeBinding
  amount: number
  remainder: number
  cursor: Cursor
  coverage: 'partial'
  policy?: 'durable-admitted-v1'
}
type Frontier = { cursor: string; remainder: number }
const safe = (value: number) => Number.isSafeInteger(value) && value >= 0
/** Server-owned accounting, independent of finite sponsor rewards. Transport must verify Host signatures first. */
export class WorkIncomeIssuer {
  readonly corrections: WorkScopeCorrections
  readonly takeover: WorkTakeover
  readonly history: HistoryDeclarations
  constructor(readonly store: Store, readonly now = Date.now) {
    this.history = new HistoryDeclarations(store, now)
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workIncomeObservations(instance TEXT NOT NULL, account TEXT NOT NULL,
        event TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(instance,account,event));
      CREATE TABLE IF NOT EXISTS workIncomeLeases(instance TEXT NOT NULL, account TEXT NOT NULL, lease TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(instance,account));
      CREATE TABLE IF NOT EXISTS workIncomeBindings(instance TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL,
        PRIMARY KEY(instance,account), UNIQUE(instance,scope));
      CREATE TABLE IF NOT EXISTS workIncomeFrontiers(instance TEXT NOT NULL, account TEXT NOT NULL, cursor TEXT NOT NULL,
        remainder INTEGER NOT NULL, PRIMARY KEY(instance,account));
      CREATE TABLE IF NOT EXISTS workIncomeEpochs(instance TEXT NOT NULL, account TEXT NOT NULL, epoch TEXT NOT NULL,
        PRIMARY KEY(instance,account,epoch));
      CREATE TABLE IF NOT EXISTS workIncomeReceipts(instance TEXT NOT NULL, account TEXT NOT NULL, event TEXT NOT NULL,
        fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(instance,account,event));
    `)
    this.takeover = new WorkTakeover(store, now)
    this.corrections = new WorkScopeCorrections(store, now)
  }
  state(instance: string, account: string): WorkIncomeState {
    const correction = this.corrections.state(instance, account)
    const takeover = this.takeover.receipt(instance, account)
    const row = this.store.one<Frontier>(
      'SELECT cursor,remainder FROM workIncomeFrontiers WHERE instance=? AND account=?',
      instance,
      account,
    )
    const blockers = this.takeover.blockers(instance, account)
    const total = this.store.one<{ earned: number }>(
      "SELECT COALESCE(SUM(json_extract(receipt, '$.amount')),0) AS earned FROM workIncomeReceipts WHERE instance=? AND account=?",
      instance,
      account,
    )!
    const legacy = this.store.one<{ total: number }>(
      "SELECT COALESCE(SUM(amount),0) AS total FROM grants WHERE instance=? AND account=? AND event GLOB 'pet-work:*'",
      instance,
      account,
    )!
    const records = this.store.all<{ record: string }>(
      'SELECT record FROM workIncomeObservations WHERE instance=? AND account=? ORDER BY rowid DESC LIMIT 50',
      instance,
      account,
    ).map(r => JSON.parse(r.record) as WorkIncomeRecord)
    requireCondition(
      safe(total.earned + legacy.total),
      'NUMERIC_OVERFLOW',
      'Lifetime work income exceeds exact integer range',
      409,
    )
    return {
      instanceId: instance,
      accountId: account,
      status: row ? 'active' : blockers.length ? 'reconciliation-required' : 'pristine',
      blockers: row ? [] : blockers,
      remainder: row?.remainder ?? 0,
      earned: total.earned + legacy.total,
      legacySponsoredEarned: legacy.total,
      records,
      ...(correction ? { scopeCorrection: correction } : {}),
      ...(takeover ? { takeover } : {}),
      ...(row ? { cursor: JSON.parse(row.cursor) as Cursor } : {}),
    }
  }
  /** Used only after verified managed source-account identity; creates no coins or scope frontier. */
  provisionIdentity(instanceId: string, accountId: string): void {
    textId(instanceId, 'instanceId')
    textId(accountId, 'accountId')
    this.store.transaction(() => {
      if (!this.store.one('SELECT id FROM instances WHERE id=?', instanceId)) {
        this.store.run('INSERT INTO instances VALUES(?,0)', instanceId)
        this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', instanceId, '$issuer', 'system')
        this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', instanceId, '$shop', 'system')
      }
      const old = this.store.one<{ kind: string }>(
        'SELECT kind FROM accounts WHERE instance=? AND id=?',
        instanceId,
        accountId,
      )
      requireCondition(!old || old.kind === 'user', 'BINDING_CONFLICT', 'Native identity must be a user wallet', 409)
      if (!old) this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', instanceId, accountId, 'user')
      this.store.assertConservation(instanceId)
    })
  }
  /** Trusted Host identity provisioning only. Binding accountId must come from the verified source-auth subject mapping. */
  provision(binding: WorkIncomeBinding): void {
    textId(binding.instanceId, 'instanceId')
    textId(binding.accountId, 'accountId')
    requireCondition(
      typeof binding.scopeId === 'string' && binding.scopeId.length > 0 && binding.scopeId.length <= 200,
      'INVALID_INPUT',
      'An opaque Host work scope is required',
    )
    this.store.transaction(() => {
      this.corrections.assertTarget(binding.instanceId, binding.accountId, binding.scopeId)
      const custody = this.store.one<{ instance: string; account: string }>(
        'SELECT instance,account FROM workIncomeTakeovers WHERE scope=?',
        binding.scopeId,
      )
      requireCondition(
        !custody || custody.instance === binding.instanceId && custody.account === binding.accountId,
        'BINDING_CONFLICT',
        'Work scope already has a durable canonical issuer',
        409,
      )
      this.history.assertUnblocked(binding.instanceId, binding.accountId)
      const old = this.store.one<{ scope: string }>(
        'SELECT scope FROM workIncomeBindings WHERE instance=? AND account=?',
        binding.instanceId,
        binding.accountId,
      )
      const scope = this.store.one<{ account: string }>(
        'SELECT account FROM workIncomeBindings WHERE instance=? AND scope=?',
        binding.instanceId,
        binding.scopeId,
      )
      requireCondition(!old || old.scope === binding.scopeId, 'BINDING_CONFLICT', 'Work scope cannot be rebound', 409)
      requireCondition(
        !scope || scope.account === binding.accountId,
        'BINDING_CONFLICT',
        'Work scope already has a wallet',
        409,
      )
      if (!this.store.one('SELECT id FROM instances WHERE id=?', binding.instanceId)) {
        this.store.run('INSERT INTO instances VALUES(?,0)', binding.instanceId)
        this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', binding.instanceId, '$issuer', 'system')
        this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', binding.instanceId, '$shop', 'system')
      }
      const account = this.store.one<{ kind: string }>(
        'SELECT kind FROM accounts WHERE instance=? AND id=?',
        binding.instanceId,
        binding.accountId,
      )
      requireCondition(
        !account || account.kind === 'user',
        'BINDING_CONFLICT',
        'Work identity must be a user wallet',
        409,
      )
      if (!account) {
        this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', binding.instanceId, binding.accountId, 'user')
      }
      if (!old) {
        this.store.run(
          'INSERT INTO workIncomeBindings VALUES(?,?,?)',
          binding.instanceId,
          binding.accountId,
          binding.scopeId,
        )
      }
      this.store.assertConservation(binding.instanceId)
    })
  }
  /** Trusted provisioning boundary; not an HTTP/user/service operation. No editable nickname identity. */
  bind(binding: WorkIncomeBinding): void {
    textId(binding.instanceId, 'instanceId')
    textId(binding.accountId, 'accountId')
    requireCondition(
      typeof binding.scopeId === 'string' && binding.scopeId.length > 0 && binding.scopeId.length <= 200,
      'INVALID_INPUT',
      'An opaque Host work scope is required',
    )
    this.store.transaction(() => {
      this.corrections.assertTarget(binding.instanceId, binding.accountId, binding.scopeId)
      const custody = this.store.one<{ instance: string; account: string }>(
        'SELECT instance,account FROM workIncomeTakeovers WHERE scope=?',
        binding.scopeId,
      )
      requireCondition(
        !custody || custody.instance === binding.instanceId && custody.account === binding.accountId,
        'BINDING_CONFLICT',
        'Work scope already has a durable canonical issuer',
        409,
      )
      requireCondition(
        this.store.one(
          'SELECT id FROM accounts WHERE instance=? AND id=? AND kind=?',
          binding.instanceId,
          binding.accountId,
          'user',
        ),
        'NOT_FOUND',
        'User account not found',
        404,
      )
      const old = this.store.one<{ scope: string }>(
        'SELECT scope FROM workIncomeBindings WHERE instance=? AND account=?',
        binding.instanceId,
        binding.accountId,
      )
      requireCondition(!old || old.scope === binding.scopeId, 'BINDING_CONFLICT', 'Work scope cannot be rebound', 409)
      const scope = this.store.one<{ account: string }>(
        'SELECT account FROM workIncomeBindings WHERE instance=? AND scope=?',
        binding.instanceId,
        binding.scopeId,
      )
      requireCondition(
        !scope || scope.account === binding.accountId,
        'BINDING_CONFLICT',
        'Work scope already has a wallet',
        409,
      )
      if (!old) {
        this.store.run(
          'INSERT INTO workIncomeBindings VALUES(?,?,?)',
          binding.instanceId,
          binding.accountId,
          binding.scopeId,
        )
      }
    })
  }
  /** Caller must supply an already verified, fresh, audience-bound Host observation. No amount input exists. */
  accept(observation: VerifiedWorkObservation): WorkIncomeReceipt {
    const { binding } = observation
    let baseline = observation.baseline
    requireCondition(typeof baseline === 'boolean', 'INVALID_INPUT', 'Baseline mode is required')
    const next = workCursor(observation.snapshot)
    requireCondition(
      next.scopeId === binding.scopeId,
      'BINDING_CONFLICT',
      'Observation scope differs from wallet binding',
      403,
    )
    const durableFingerprint = observation.policy
      ? hash(canonical({ binding, next, policy: observation.policy }))
      : undefined
    return this.store.transaction(() => {
      observation.authorization?.()
      // Exact first-snapshot retry must not depend on whether its frontier already committed.
      if (durableFingerprint) {
        const committed = this.store.one<{ receipt: string }>(
          'SELECT receipt FROM workIncomeReceipts WHERE instance=? AND account=? AND event=?',
          binding.instanceId,
          binding.accountId,
          'work:' + durableFingerprint,
        )
        if (committed) return JSON.parse(committed.receipt) as WorkIncomeReceipt
      }
      this.corrections.assertTarget(binding.instanceId, binding.accountId, binding.scopeId)
      const correction = observation.policy === 'durable-admitted-v1'
        ? this.corrections.pending(binding.instanceId, binding.accountId, binding.scopeId)
        : undefined
      if (correction) this.corrections.begin(correction, next)
      const prefix = !!observation.firstTakeover || !!correction
      if (observation.firstTakeover && !correction) {
        requireCondition(
          observation.policy === 'durable-admitted-v1',
          'INVALID_INPUT',
          'Takeover requires durable settlement policy',
        )
        requireCondition(baseline === true, 'INVALID_INPUT', 'First takeover requires verified baseline')
        this.history.assertUnblocked(binding.instanceId, binding.accountId)
        this.takeover.establish(binding.instanceId, binding.accountId, next)
      }
      const scopeOwner = this.store.one<{ instance: string; account: string }>(
        'SELECT instance,account FROM workIncomeTakeovers WHERE scope=?',
        binding.scopeId,
      )
      requireCondition(
        !scopeOwner || scopeOwner.instance === binding.instanceId && scopeOwner.account === binding.accountId,
        'BINDING_CONFLICT',
        'Work scope already has a durable canonical issuer',
        409,
      )
      const takeover = this.takeover.receipt(binding.instanceId, binding.accountId)
      requireCondition(
        !takeover || observation.policy === 'durable-admitted-v1',
        'WORK_POLICY_CONFLICT',
        'This canonical account uses durable admitted-work settlement',
        409,
      )
      requireCondition(
        observation.policy !== 'durable-admitted-v1' || !!takeover,
        'TAKEOVER_RECONCILIATION_REQUIRED',
        'Original-owner income reconciliation required before policy transition',
        409,
      )
      if (observation.leaseId !== undefined) {
        requireCondition(/^[A-Za-z0-9_-]{43}$/.test(observation.leaseId), 'INVALID_INPUT', 'Invalid Host work lease')
        const lease = this.store.one<{ lease: string; seen: number }>(
          'SELECT lease,seen FROM workIncomeLeases WHERE instance=? AND account=?',
          binding.instanceId,
          binding.accountId,
        )
        baseline ||= !lease || lease.lease !== observation.leaseId || this.now() - lease.seen > 15000
          || this.now() < lease.seen
        this.store.run(
          'INSERT INTO workIncomeLeases VALUES(?,?,?,?) ON CONFLICT(instance,account) DO UPDATE SET lease=excluded.lease,seen=excluded.seen',
          binding.instanceId,
          binding.accountId,
          observation.leaseId,
          this.now(),
        )
      }
      const fingerprint = durableFingerprint ?? hash(canonical({ binding, next, baseline }))
      const eventId = `work:${fingerprint}`
      const pinned = this.store.one<{ scope: string }>(
        'SELECT scope FROM workIncomeBindings WHERE instance=? AND account=?',
        binding.instanceId,
        binding.accountId,
      )
      requireCondition(pinned?.scope === binding.scopeId, 'FORBIDDEN', 'Trusted work-income binding required', 403)
      const receipt = this.store.one<{ fingerprint: string; receipt: string }>(
        'SELECT fingerprint,receipt FROM workIncomeReceipts WHERE instance=? AND account=? AND event=?',
        binding.instanceId,
        binding.accountId,
        eventId,
      )
      if (receipt) return JSON.parse(receipt.receipt) as WorkIncomeReceipt
      const row = this.store.one<Frontier>(
        'SELECT cursor,remainder FROM workIncomeFrontiers WHERE instance=? AND account=?',
        binding.instanceId,
        binding.accountId,
      )
      const old: Cursor | undefined = row && !correction ? JSON.parse(row.cursor) : undefined
      requireCondition(
        observation.policy !== 'durable-admitted-v1' || !old || old.sourceId === next.sourceId,
        'FRONTIER_CONFLICT',
        'Durable work source cannot change',
        409,
      )
      const epochKey = hash(canonical([next.sourceId, next.epoch]))
      const sameEpoch = old && old.sourceId === next.sourceId && old.epoch === next.epoch
      if (sameEpoch) {
        requireCondition(
          next.revision >= old.revision && next.tokens >= old.tokens && next.observedThrough >= old.observedThrough,
          'FRONTIER_REGRESSION',
          'Work frontier cannot move backwards',
          409,
        )
        requireCondition(
          next.revision !== old.revision || next.tokens === old.tokens,
          'FRONTIER_CONFLICT',
          'Same revision has conflicting counters',
          409,
        )
      } else {
        requireCondition(
          !this.store.one(
            'SELECT epoch FROM workIncomeEpochs WHERE instance=? AND account=? AND epoch=?',
            binding.instanceId,
            binding.accountId,
            epochKey,
          ),
          'RETIRED_EPOCH',
          'Cannot return to an earlier work epoch',
          409,
        )
      }
      // Host-admitted cumulative counters remain verifiable after a consumer lease or connection changes.
      // Only a genuinely different epoch lacks a comparable delta. Previously earned fractional tokens survive it.
      const eligible = observation.policy === 'durable-admitted-v1'
        ? (sameEpoch ? next.tokens - old!.tokens : prefix ? next.tokens : 0) + (row?.remainder ?? 0)
        : baseline || !sameEpoch
        ? 0
        : next.tokens - old!.tokens + row!.remainder
      requireCondition(safe(eligible), 'NUMERIC_OVERFLOW', 'Work delta exceeds exact integer storage', 409)
      const amount = Math.floor(eligible / TOKENS_PER_COIN), remainder = eligible % TOKENS_PER_COIN
      if (!sameEpoch) {
        this.store.run('INSERT INTO workIncomeEpochs VALUES(?,?,?)', binding.instanceId, binding.accountId, epochKey)
      }
      if (amount) {
        const totals = this.store.one<{ supply: number; available: number }>(
          'SELECT i.supply,a.available FROM instances i JOIN accounts a ON a.instance=i.id WHERE i.id=? AND a.id=?',
          binding.instanceId,
          binding.accountId,
        )
        requireCondition(
          totals && safe(totals.supply + amount) && safe(totals.available + amount),
          'NUMERIC_OVERFLOW',
          'Coin balance exceeds exact integer storage',
          409,
        )
        this.store.run('UPDATE instances SET supply=supply+? WHERE id=?', amount, binding.instanceId)
        this.store.move(
          binding.instanceId,
          binding.accountId,
          amount,
          0,
          'work-income',
          eventId,
          this.now(),
          randomUUID(),
        )
      }
      this.store.run(
        'INSERT INTO workIncomeFrontiers VALUES(?,?,?,?) ON CONFLICT(instance,account) DO UPDATE SET cursor=excluded.cursor,remainder=excluded.remainder',
        binding.instanceId,
        binding.accountId,
        JSON.stringify(next),
        remainder,
      )
      const result: WorkIncomeReceipt = {
        eventId,
        binding: { ...binding },
        amount,
        remainder,
        cursor: next,
        coverage: 'partial',
        ...(observation.policy ? { policy: observation.policy } : {}),
      }
      this.store.run(
        'INSERT INTO workIncomeReceipts VALUES(?,?,?,?,?)',
        binding.instanceId,
        binding.accountId,
        eventId,
        fingerprint,
        JSON.stringify(result),
      )
      const record: WorkIncomeRecord = {
        eventId,
        kind: observation.policy === 'durable-admitted-v1'
          ? correction
            ? 'admitted-prefix-correction'
            : prefix
            ? 'admitted-prefix'
            : sameEpoch
            ? 'admitted-delta'
            : 'epoch-anchor'
          : 'legacy-observation',
        amount,
        remainderBefore: row?.remainder ?? 0,
        remainderAfter: remainder,
        creditedTokens: observation.policy === 'durable-admitted-v1'
          ? sameEpoch ? next.tokens - old!.tokens : prefix ? next.tokens : 0
          : (!baseline && !!sameEpoch)
          ? next.tokens - old!.tokens
          : 0,
        snapshot: structuredClone(observation.snapshot),
        createdAt: this.now(),
        ...(old ? { from: old } : {}),
      }
      this.store.run(
        'INSERT INTO workIncomeObservations VALUES(?,?,?,?)',
        binding.instanceId,
        binding.accountId,
        eventId,
        JSON.stringify(record),
      )
      if (correction) this.corrections.complete(correction, result)
      this.store.assertConservation(binding.instanceId)
      return result
    })
  }
}
