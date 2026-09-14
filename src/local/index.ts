export * from './commerce.js'
import type { HistoryDeclarationReceipt, LedgerEntry, WorkIncomeState } from '../client/contracts.js'
/** Experimental economy-owned local orchestration. No HTTP mint or consumer observation API. */
export const TOKENS_PER_COIN = 10_000
export const LOCAL_ECONOMY_DOCUMENT_ID = 'economy-local-wallet-v1'
export type LocalWalletBinding = { origin: string; instanceId: string; accountId: string }
export type Cursor = {
  scopeId: string
  sourceId: string
  epoch: string
  revision: number
  tokens: number
  observedThrough: number
}
export type UsageIntent = { eventId: string; wallet: LocalWalletBinding; from: Cursor; to: Cursor; amount: number }
export type UsageReceipt = { eventId: string; wallet: LocalWalletBinding; amount: number }
export type HistoryCorrection = {
  id: string
  from: 'requires-retirement'
  to: 'never-enabled'
  statement: string
  status: 'pending' | 'recorded' | 'cancelled'
  receipt?: HistoryDeclarationReceipt
}
export type LocalState = {
  historyCorrection?: HistoryCorrection
  version: 1
  legacyPetHistory?: 'requires-retirement' | 'never-enabled'
  sponsorSourceId?: string
  wallet: LocalWalletBinding
  cursor?: Cursor
  remainder: number
  earned: number
  pending?: UsageIntent & { gap: boolean }
  lastEventId?: string
}
/** Adapter must use one economy owner document with expected-revision transactions. */
export interface LocalStorage {
  load(): Promise<{ revision: number; value: unknown }>
  save(revision: number, value: LocalState): Promise<boolean>
}
const count = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200
export function localWallet(value: LocalWalletBinding): LocalWalletBinding {
  const u = new URL(value.origin)
  if (
    u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    || u.username || u.password || u.pathname !== '/' || u.search || u.hash
    || !id(value.instanceId) || !id(value.accountId)
  ) throw new Error('Invalid local wallet binding')
  return { origin: u.origin, instanceId: value.instanceId, accountId: value.accountId }
}
export const sameWallet = (a: LocalWalletBinding, b: LocalWalletBinding) =>
  a.origin === b.origin && a.instanceId === b.instanceId && a.accountId === b.accountId
const epoch = (a: Cursor, b: Cursor) => a.scopeId === b.scopeId && a.sourceId === b.sourceId && a.epoch === b.epoch
function cursor(value: unknown): Cursor {
  const c = value as Cursor
  if (
    !c || !id(c.scopeId) || !id(c.sourceId) || !id(c.epoch) || !count(c.revision)
    || !count(c.tokens) || !count(c.observedThrough)
  ) throw new Error('Invalid work cursor')
  return {
    scopeId: c.scopeId,
    sourceId: c.sourceId,
    epoch: c.epoch,
    revision: c.revision,
    tokens: c.tokens,
    observedThrough: c.observedThrough,
  }
}
/** Structural validation of the public usage/v2 projection, never v1 aggregate fallback. */
export function workCursor(value: unknown): Cursor {
  const s = value as Record<string, unknown>, c = s?.classification as Record<string, unknown>
  if (
    !s || s.schemaVersion !== 2 || s.status !== 'ready' || s.policyId !== 'codex-local-work-input-output-v2'
    || s.coverage !== 'partial' || !count(s.enabledAt) || !count(s.inputTokens) || !count(s.outputTokens)
    || !count(s.eligibleTokens) || s.inputTokens + s.outputTokens !== s.eligibleTokens
    || !c || c.version !== 'host-game-cwd-v1' || c.hostGameTasks !== 'excluded'
    || c.forksAndSubagents !== 'excluded' || c.unknownSources !== 'excluded'
  ) throw new Error('Eligible root-work usage unavailable')
  return cursor({ ...s, tokens: s.eligibleTokens })
}
export function localState(value: unknown): LocalState {
  const s = value as LocalState
  if (!s || s.version !== 1 || !count(s.remainder) || s.remainder >= TOKENS_PER_COIN || !count(s.earned)) {
    throw new Error('Invalid local economy record; preserve original')
  }
  if (s.sponsorSourceId !== undefined && !/^[A-Za-z0-9._:-]{1,120}$/.test(s.sponsorSourceId)) {
    throw new Error('Invalid pinned sponsor source')
  }
  if (s.legacyPetHistory !== undefined && !['requires-retirement', 'never-enabled'].includes(s.legacyPetHistory)) {
    throw new Error('Invalid legacy history declaration')
  }
  const correction = s.historyCorrection
  if (correction) {
    if (
      !/^history:[a-f0-9-]{36}$/.test(correction.id) || correction.from !== 'requires-retirement'
      || correction.to !== 'never-enabled'
      || !['pending', 'recorded', 'cancelled'].includes(correction.status) || typeof correction.statement !== 'string'
      || !correction.statement.trim() || correction.statement.length > 1000
    ) throw new Error('Invalid explicit history correction')
    const receipt = correction.receipt
    if (
      receipt
      && (receipt.contract !== 'economy.history-declaration/v1' || receipt.id !== correction.id
        || receipt.statement !== correction.statement
        || receipt.instanceId !== s.wallet.instanceId || receipt.accountId !== s.wallet.accountId
        || receipt.from !== correction.from || receipt.to !== correction.to
        || !count(receipt.createdAt) || !['pending', 'confirmed', 'cancelled'].includes(receipt.status))
    ) throw new Error('History correction receipt mismatch')
    if (
      correction.status === 'recorded' && (receipt?.status !== 'confirmed' || s.legacyPetHistory !== 'never-enabled')
    ) throw new Error('Confirmed manual declaration receipt required')
    if (
      correction.status === 'cancelled'
      && (receipt?.status !== 'cancelled' || s.legacyPetHistory !== 'requires-retirement')
    ) throw new Error('Cancelled declaration receipt required')
  }
  const wallet = localWallet(s.wallet)
  if (!sameWallet(wallet, s.wallet)) throw new Error('Noncanonical wallet record')
  if (s.cursor) cursor(s.cursor)
  if (s.lastEventId !== undefined && !/^work:[a-f0-9]{64}$/.test(s.lastEventId)) {
    throw new Error('Invalid receipt event')
  }
  if (s.pending) {
    const p = s.pending
    if (
      !s.cursor || !sameWallet(localWallet(p.wallet), wallet) || !/^work:[a-f0-9]{64}$/.test(p.eventId)
      || !count(p.amount) || p.amount < 1 || typeof p.gap !== 'boolean'
    ) throw new Error('Invalid pending intent')
    const from = cursor(p.from), to = cursor(p.to)
    const previousRemainder = p.amount * TOKENS_PER_COIN + s.remainder - (to.tokens - from.tokens)
    if (!count(previousRemainder) || previousRemainder >= TOKENS_PER_COIN) throw new Error('Invalid pending amount')
    if (
      !epoch(from, to) || to.tokens < from.tokens || to.revision <= from.revision
      || to.observedThrough < from.observedThrough || JSON.stringify(to) !== JSON.stringify(cursor(s.cursor))
    ) throw new Error('Invalid pending frontier')
  }
  return structuredClone(s)
}
async function eventId(wallet: LocalWalletBinding, from: Cursor, to: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify([wallet.origin, wallet.instanceId, wallet.accountId, from, to]))
  return 'work:'
    + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0'))
      .join('')
}
/** Only the economy owner supplies trusted Host observations and an idempotent local writer.
 * This engine cannot establish snapshot provenance or mint authority by itself. */
export class LocalWorkIncome {
  #baseline = true
  #closed = false
  #serial: Promise<void> = Promise.resolve()
  readonly wallet: LocalWalletBinding
  constructor(
    private readonly storage: LocalStorage,
    wallet: LocalWalletBinding,
    private readonly commit: (intent: UsageIntent) => Promise<UsageReceipt>,
    private readonly canCommit: (amount: number) => Promise<boolean> = async () => true,
  ) {
    this.wallet = localWallet(wallet)
  }
  pause(): void {
    this.#baseline = true
  }
  dispose(): void {
    this.#closed = true
    this.pause()
  }
  observe(snapshot: unknown, valid: () => boolean = () => true): Promise<void> {
    const run = this.#serial.then(() => this.process(snapshot, () => !this.#closed && valid()))
    this.#serial = run.catch(() => {})
    return run
  }
  private async process(snapshot: unknown, current: () => boolean): Promise<void> {
    try {
      const nextCursor = workCursor(snapshot)
      for (let retry = 0; retry < 12 && current(); retry++) {
        const record = await this.storage.load()
        if (!current()) return
        const prior = record.value === null ? undefined : localState(record.value)
        if (prior && !sameWallet(prior.wallet, this.wallet)) {
          throw new Error('Restore canonical wallet; no automatic rebind')
        }
        if (prior?.pending) {
          if (
            !prior.pending.gap && (this.#baseline || !epoch(prior.pending.to, nextCursor)
              || nextCursor.tokens > prior.pending.to.tokens)
          ) {
            prior.pending.gap = true
            if (!await this.storage.save(record.revision, prior)) continue
          }
          await this.deliver(prior.pending, current)
          return
        }
        const old = prior?.cursor
        if (
          old && epoch(old, nextCursor) && (nextCursor.tokens < old.tokens || nextCursor.revision < old.revision
            || nextCursor.observedThrough < old.observedThrough)
        ) throw new Error('Work usage regressed; preserve frontier')
        if (old && epoch(old, nextCursor) && nextCursor.revision === old.revision && nextCursor.tokens !== old.tokens) {
          throw new Error('Conflicting work revision')
        }
        const reset = this.#baseline || !old || !epoch(old, nextCursor)
        if (!reset && nextCursor.revision === old!.revision) return
        const eligible = reset ? 0 : nextCursor.tokens - old!.tokens + prior!.remainder
        if (!count(eligible)) throw new Error('Unsafe usage delta')
        const amount = Math.floor(eligible / TOKENS_PER_COIN)
        const allowed = !amount || await this.canCommit(amount)
        if (!current()) return
        const state: LocalState = {
          version: 1,
          wallet: this.wallet,
          cursor: nextCursor,
          ...(prior?.legacyPetHistory ? { legacyPetHistory: prior.legacyPetHistory } : {}),
          ...(prior?.sponsorSourceId ? { sponsorSourceId: prior.sponsorSourceId } : {}),
          remainder: allowed ? eligible % TOKENS_PER_COIN : 0,
          earned: prior?.earned ?? 0,
          ...(prior?.lastEventId ? { lastEventId: prior.lastEventId } : {}),
        }
        if (amount && allowed) {
          state.pending = {
            eventId: await eventId(this.wallet, old!, nextCursor),
            wallet: this.wallet,
            from: old!,
            to: nextCursor,
            amount,
            gap: false,
          }
        }
        if (!current()) return
        if (!await this.storage.save(record.revision, state)) continue
        this.#baseline = false
        if (state.pending) await this.deliver(state.pending, current)
        return
      }
      if (current()) throw new Error('Local income record busy')
    } catch (error) {
      this.pause()
      throw error
    }
  }
  private async deliver(intent: UsageIntent & { gap: boolean }, current: () => boolean): Promise<void> {
    if (!current()) {
      this.pause()
      return
    }
    if (intent.eventId !== await eventId(this.wallet, intent.from, intent.to)) {
      throw new Error('Income event fingerprint mismatch')
    }
    if (!current()) {
      this.pause()
      return
    }
    // A network failure preserves this exact event; a later observation never adds another debt.
    const receipt = await this.commit({
      eventId: intent.eventId,
      wallet: intent.wallet,
      from: intent.from,
      to: intent.to,
      amount: intent.amount,
    })
    if (!current()) {
      this.pause()
      return
    }
    if (
      receipt.eventId !== intent.eventId || receipt.amount !== intent.amount || !sameWallet(receipt.wallet, this.wallet)
    ) throw new Error('Income receipt mismatch')
    for (let retry = 0; retry < 12 && current(); retry++) {
      const record = await this.storage.load()
      if (!current()) return
      const state = localState(record.value)
      if (!sameWallet(state.wallet, this.wallet)) throw new Error('Canonical wallet changed')
      if (state.lastEventId === intent.eventId && !state.pending) {
        this.#baseline ||= intent.gap
        return
      }
      if (state.pending?.eventId !== intent.eventId) throw new Error('Income intent changed')
      this.#baseline ||= state.pending.gap
      state.earned += intent.amount
      if (!count(state.earned)) throw new Error('Unsafe earned amount')
      state.lastEventId = intent.eventId
      delete state.pending
      if (await this.storage.save(record.revision, state)) return
    }
    if (current()) throw new Error('Income receipt record busy')
  }
}

export const LOCAL_WALLET_SERVICE = 'economyLocalWallet'
/** Consumers receive no grant client, credential, observation method or mutable frontier. */
export type LocalIncomeReadiness = {
  status: 'unavailable' | 'connecting' | 'ready'
  stage: 'wallet' | 'usage' | 'retirement' | 'issuer' | 'settlement'
  coverage: 'partial'
  reason: string
}
export interface LocalWalletReadService {
  /** Readonly lifecycle status, independent of wallet balance readiness. */
  incomeStatus?(): LocalIncomeReadiness
  workIncome?(): Promise<WorkIncomeState>
  subscribeIncome?(listener: () => void): () => void
  readonly contract: 'economy.local-wallet/v1'
  ledger(): Promise<
    { status: 'unavailable'; reason: string } | { status: 'ready'; wallet: LocalWalletBinding; entries: LedgerEntry[] }
  >
  summary(): Promise<
    { status: 'unavailable'; reason: string } | {
      status: 'ready'
      wallet: LocalWalletBinding
      available: number
      reserved: number
    }
  >
}

/** Economy consumer requires lifecycle invalidation, never guesses producer history from absence. */
export interface LegacyWorkRetirementReadService {
  readonly contract: 'economy.legacy-work-retirement/v1'
  readonly generationId: string
  isActive(): boolean
  subscribeInvalidation(listener: () => void): () => void
  currentProducer(): Promise<
    {
      status: string
      disabled?: boolean
      originalRecord: 'missing' | 'present' | 'unavailable' | 'invalid'
      scopeId?: string
      producerContract?: string
      producerGenerationId?: string
    }
  >
  retirement(): Promise<
    {
      status: string
      pending?: boolean
      scopeId?: string
      producerContract?: string
      producerGenerationId?: string
      documentSchemaVersion?: number
      documentRevision?: number
    }
  >
}
