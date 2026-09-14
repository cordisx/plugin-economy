import { type LedgerEntry, type WorkIncomeState } from '@cordisx/economy/client'
import {
  type LegacyWorkRetirementReadService,
  LOCAL_ECONOMY_DOCUMENT_ID,
  type LocalIncomeReadiness,
  localState,
  type LocalStorage,
  localWallet,
  type LocalWalletBinding,
  type LocalWalletReadService,
  sameWallet,
  workCursor,
} from '@cordisx/economy/local'
import type { LocalWorkSettlementV1 } from '@cordisx/protocol/local-work-settlement/v1'
import type { ManagedSourceBindingV1 } from '@cordisx/protocol/plugin-http/v3'
import type { UsageV2, WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { Context } from '@deepseek-ai/cordis'
import type { CordisXJsonValue } from 'cordisx/contracts'
import { type ExplicitHistoryCorrection } from './history-correction.js'
import { type WalletHttp, WalletSession } from './session.js'
import { TrustedWorkIncomeObserver } from './work-issuance.js'
export type LocalWalletConfig = {
  readOnly?: boolean
  localEconomyOrigin?: string
  workRewardSourceId?: string
  localEconomyInstanceId?: string
  localEconomySourceId?: string
  workIncomeSourceId?: string
  legacyPetHistoryCorrection?: ExplicitHistoryCorrection | null
  legacyPetHistory?: 'requires-retirement' | 'never-enabled'
}
export { LOCAL_WALLET_SERVICE } from '@cordisx/economy/local'
export type { LocalWalletReadService } from '@cordisx/economy/local'
export class CanonicalWalletSession extends WalletSession {
  readonly #history: 'requires-retirement' | 'never-enabled'
  readonly #readOnly: boolean
  #disposed = false
  #worker?: TrustedWorkIncomeObserver
  #generation = 0
  #wallet?: LocalWalletBinding
  #reason = 'Local wallet not connected'
  #income: LocalIncomeReadiness = {
    status: 'unavailable',
    stage: 'wallet',
    coverage: 'partial',
    reason: 'Local wallet not connected',
  }
  readonly #incomeListeners = new Set<() => void>()
  #verifiedWorkScope?: string
  #verifiedRetirement?: LegacyWorkRetirementReadService
  #verifiedGeneration?: string
  #everProvider = false
  #retirementUnsubscribe?: () => void
  incomeStatus = (): LocalIncomeReadiness => {
    if (this.#disposed) {
      return { status: 'unavailable', stage: 'wallet', coverage: 'partial', reason: 'Wallet owner retired' }
    }
    const retirementCurrent = this.retirementCurrent()
    if (this.#income.status === 'ready' && !retirementCurrent) {
      return {
        status: 'unavailable',
        stage: 'retirement',
        coverage: 'partial',
        reason: 'Pet retirement provider changed',
      }
    }
    return { ...this.#income }
  }
  private setIncome(status: LocalIncomeReadiness['status'], stage: LocalIncomeReadiness['stage'], reason: string) {
    if (this.#disposed) return
    const value = this.#income = { status, stage, reason, coverage: 'partial' }
    queueMicrotask(() => {
      if (this.#income !== value || this.#disposed) return
      for (const listener of this.#incomeListeners) {
        try {
          listener()
        } catch { /* A readonly subscriber cannot interrupt settlement. */ }
      }
    })
  }
  readonly #storage: LocalStorage
  readonly service: LocalWalletReadService
  constructor(private readonly ctx: Context, private readonly config: LocalWalletConfig) {
    super(ctx.get('http') as WalletHttp | undefined)
    this.#readOnly = config.readOnly === true
    this.#history = config.legacyPetHistory ?? 'requires-retirement'
    if (!this.#readOnly && config.legacyPetHistoryCorrection) {
      throw new Error('Historical policy mutation retired; original records are preserved')
    }
    this.#storage = {
      load: async () => {
        const r = await ctx.documents.load(LOCAL_ECONOMY_DOCUMENT_ID)
        if (r.status === 'unavailable') throw new Error(r.diagnostic)
        return r.status === 'missing'
          ? { revision: 0, value: null }
          : { revision: r.snapshot.revision, value: r.snapshot.value }
      },
      save: async (revision, value) => {
        localState(value)
        const r = await ctx.documents.transaction({
          contract: 'cordisx.owner-documents/v1',
          documentId: LOCAL_ECONOMY_DOCUMENT_ID,
          expectedRevision: revision,
          schemaVersion: 1,
          value: value as unknown as CordisXJsonValue,
        })
        if (r.status === 'unavailable') throw new Error(r.diagnostic)
        return r.status === 'accepted'
      },
    }
    this.service = Object.freeze({
      incomeStatus: this.incomeStatus,
      workIncome: this.readWorkIncome,
      subscribeIncome: (listener: () => void) => {
        if (this.#disposed) return () => {}
        this.#incomeListeners.add(listener)
        return () => {
          this.#incomeListeners.delete(listener)
        }
      },
      ledger: async () => {
        const generation = this.#generation, wallet = this.#wallet, client = this.client
        if (!wallet || !client) return { status: 'unavailable' as const, reason: this.#reason }
        const entries = await client.ledger()
        if (generation !== this.#generation || entries.some(e => e.accountId !== wallet.accountId)) {
          return { status: 'unavailable' as const, reason: 'Wallet connection changed' }
        }
        return { status: 'ready' as const, wallet: { ...wallet }, entries }
      },
      contract: 'economy.local-wallet/v1' as const,
      summary: async () => {
        const generation = this.#generation, wallet = this.#wallet, client = this.client
        if (!wallet || !client) return { status: 'unavailable' as const, reason: this.#reason }
        const balance = await client.me()
        if (
          generation !== this.#generation || balance.instanceId !== wallet.instanceId
          || balance.accountId !== wallet.accountId
        ) {
          return { status: 'unavailable' as const, reason: 'Wallet connection changed' }
        }
        return {
          status: 'ready' as const,
          wallet: { ...wallet },
          available: balance.available,
          reserved: balance.reserved,
        }
      },
    })
  }
  get readOnly(): boolean {
    return this.#readOnly
  }
  get durableIncome(): boolean {
    const settlement = this.ctx.get('workSettlement') as LocalWorkSettlementV1 | undefined
    return !this.#disposed && settlement?.contract === 'cordisx.local-work-settlement/v1'
  }
  readWorkIncome = async (): Promise<WorkIncomeState> => {
    const generation = this.#generation, client = this.client, wallet = this.#wallet
    if (this.#disposed || !client || !wallet) throw new Error('Canonical income connection unavailable')
    const state = await client.workIncome()
    if (
      this.#disposed || generation !== this.#generation || this.client !== client
      || state.instanceId !== wallet.instanceId || state.accountId !== wallet.accountId
    ) {
      throw new Error('Canonical income owner or account changed')
    }
    if (
      !['pristine', 'active', 'reconciliation-required'].includes(state.status)
      || !Number.isSafeInteger(state.earned) || state.earned < 0
      || !Number.isSafeInteger(state.remainder) || state.remainder < 0 || state.remainder >= 10000
    ) {
      throw new Error('Canonical income state invalid')
    }
    return state
  }
  /** One explicit public read; never submits income, authorizes, or mutates owner documents. */
  readWorkUsage = async (): Promise<WorkUsageSnapshotV2> => {
    if (this.#readOnly) throw new Error('Usage reading paused in read-only mode')
    const generation = this.#generation
    const usage = this.ctx.get('usage') as UsageV2 | undefined
    if (this.#disposed || !usage?.readWork) throw new Error('Classified Host work usage unavailable')
    const snapshot = await usage.readWork()
    if (this.#disposed || generation !== this.#generation) {
      throw new Error('Work usage owner or provider changed')
    }
    if (snapshot.status === 'ready') workCursor(snapshot)
    return structuredClone(snapshot)
  }
  override get defaultOrigin(): string {
    return this.config.localEconomyOrigin || super.defaultOrigin
  }
  override async connect(origin: string) {
    if (this.#disposed) throw new Error('Wallet owner retired')
    if (this.#readOnly && !this.localAuthorityAvailable) {
      throw new Error('Read-only mode requires the existing local wallet authority')
    }
    this.stopIncome()
    const generation = this.#generation
    const current = () => !this.#disposed && generation === this.#generation
    const fence = () => {
      if (!current()) throw new Error('Wallet connection superseded or owner retired')
    }
    this.setIncome('connecting', 'wallet', 'Connecting canonical local wallet authority')
    try {
      const configured = new URL(this.config.localEconomyOrigin || origin).origin
      localWallet({ origin: configured, instanceId: 'validation', accountId: 'validation' })
      if (new URL(origin).origin !== configured) throw new Error('All consumers must use the configured local wallet')
      const record = await this.#storage.load()
      fence()
      const prior = record.value === null ? undefined : localState(record.value)
      if (this.#readOnly && !prior) throw new Error('Read-only mode requires the existing original wallet record')
      if (prior && prior.wallet.origin !== configured) throw new Error('Restore original local economy origin')
      const balance = await super.connect(configured, this.binding(configured, 'source-account'), {
        expected: prior?.wallet,
        allowEnrollment: !this.#readOnly,
      })
      fence()
      const wallet = localWallet({ origin: configured, instanceId: balance.instanceId, accountId: balance.accountId })
      for (let retry = 0; retry < 12; retry++) {
        const r = await this.#storage.load()
        fence()
        if (r.value !== null) {
          if (!sameWallet(localState(r.value).wallet, wallet)) {
            throw new Error('Restore canonical account; existing record preserved')
          }
          break
        }
        if (this.#readOnly) throw new Error('Original wallet record disappeared during read-only connection')
        const saved = await this.#storage.save(r.revision, { version: 1, wallet, remainder: 0, earned: 0 })
        fence()
        if (saved) break
        if (retry === 11) throw new Error('Wallet binding busy')
      }
      fence()
      this.#wallet = wallet
      if (this.#readOnly) this.setIncome('unavailable', 'wallet', 'Income paused in read-only mode')
      else await this.startIncome(wallet)
      fence()
      return balance
    } catch (error) {
      if (current()) {
        const reason = error instanceof Error ? error.message : 'Wallet connection failed'
        const cleanup = this.disconnect(), cleanupGeneration = this.#generation
        await cleanup
        if (!this.#disposed && cleanupGeneration === this.#generation) {
          this.#reason = reason
          this.setIncome('unavailable', 'wallet', reason)
        }
      }
      throw error
    }
  }
  private binding(origin: string, audience: ManagedSourceBindingV1['audience']): ManagedSourceBindingV1 {
    return {
      origin,
      instanceId: this.config.localEconomyInstanceId || 'local',
      sourceId: audience === 'work-income'
        ? (this.config.workIncomeSourceId || 'economy-local')
        : (this.config.localEconomySourceId || 'economy-local'),
      audience,
    }
  }
  private async startIncome(wallet: LocalWalletBinding) {
    const generation = this.#generation
    const worker = this.#worker = new TrustedWorkIncomeObserver(
      this.ctx,
      this.#storage,
      wallet,
      this.binding(wallet.origin, 'work-income'),
      this.#history,
      () => !this.#disposed && generation === this.#generation,
      scope => this.verifyRetirement(scope),
      () => this.retirementCurrent(),
      (status, stage, reason) => this.setIncome(status, stage, reason),
      async (from, to) => {
        const state = await this.readWorkIncome()
        const correction = state.scopeCorrection
        return correction?.contract === 'economy.empty-work-scope-correction/v1'
            && correction.instanceId === state.instanceId && correction.accountId === state.accountId
            && correction.fromScopeId === from && correction.toScopeId === to
            && ['prepared', 'completed'].includes(correction.status)
          ? correction
          : undefined
      },
    )
    await worker.start()
  }
  private retirementProvider(): LegacyWorkRetirementReadService | undefined {
    const service = this.ctx.get('petWorkRetirement') as LegacyWorkRetirementReadService | undefined
    if (service) this.#everProvider = true
    return service
  }
  private retirementCurrent(): boolean {
    const settlement = this.ctx.get('workSettlement') as LocalWorkSettlementV1 | undefined
    if (this.#verifiedWorkScope && !this.#disposed && settlement?.contract === 'cordisx.local-work-settlement/v1') {
      return true
    }
    const service = this.retirementProvider()
    return !!this.#verifiedRetirement && service === this.#verifiedRetirement
        && this.#verifiedRetirement.generationId === this.#verifiedGeneration && this.#verifiedRetirement.isActive()
      || this.#history === 'never-enabled' && !this.#everProvider && service === undefined
  }
  private async verifyRetirement(scopeId: string) {
    const settlement = this.ctx.get('workSettlement') as LocalWorkSettlementV1 | undefined
    if (settlement?.contract === 'cordisx.local-work-settlement/v1') {
      this.#verifiedWorkScope = undefined
      const state = await this.readWorkIncome()
      if (state.status === 'pristine') {
        // This read is only a preview. The Host signature and atomic server rule decide actual custody and credit.
        this.#verifiedWorkScope = scopeId
        return
      }
      const correction = state.scopeCorrection
      if (
        correction?.contract === 'economy.empty-work-scope-correction/v1' && correction.status === 'prepared'
        && correction.instanceId === state.instanceId && correction.accountId === state.accountId
        && correction.toScopeId === scopeId && correction.fromScopeId === state.cursor?.scopeId
        && state.remainder === 0 && state.earned === 0
      ) {
        // Formal operator authorization is only a preview; final signed settlement rechecks every zero-state row.
        this.#verifiedWorkScope = scopeId
        return
      }
      const receipt = state.takeover
      if (
        state.status === 'active' && receipt?.contract === 'economy.current-scope-takeover/v1'
        && receipt.instanceId === state.instanceId && receipt.accountId === state.accountId
        && receipt.scopeId === scopeId && state.cursor?.scopeId === scopeId
        && receipt.policy === 'durable-admitted-v1' && receipt.legacyPetWorkChannel === 'closed'
      ) {
        this.#verifiedWorkScope = scopeId
        return
      }
      throw new Error('Original income history requires reconciliation: ' + state.blockers.join(', '))
    }
    const service = this.retirementProvider()
    if (!service) {
      if (this.#history === 'never-enabled' && !this.#everProvider) return
      throw new Error('Original Pet retirement proof required; absence is not no-history evidence')
    }
    this.#everProvider = true
    if (
      service.contract !== 'economy.legacy-work-retirement/v1' || !service.retirement || !service.currentProducer
      || !service.subscribeInvalidation || !service.isActive || !service.generationId
    ) throw new Error('Unsupported Pet retirement provider')
    const generation = service.generationId
    const current = () =>
      !this.#disposed && this.retirementProvider() === service && service.generationId === generation
      && service.isActive()
    const fence = () => {
      if (!current()) throw new Error('Pet producer closed, replaced or changed generation')
    }
    fence()
    const producer = await service.currentProducer()
    fence()
    if (
      producer.status !== 'ready' || producer.disabled !== true || producer.scopeId !== scopeId
      || producer.producerGenerationId !== generation || producer.producerContract !== 'pet-work-observer-disabled/v1'
    ) throw new Error('Current Pet producer unavailable, active or wrong work scope')
    if (this.#history === 'never-enabled') {
      if (producer.originalRecord !== 'missing') {
        throw new Error('Never-enabled deployment requires genuinely missing original Pet record')
      }
    } else {
      const proof = await service.retirement()
      fence()
      if (
        producer.originalRecord !== 'present' || proof.status !== 'ready' || proof.pending !== false
        || proof.documentSchemaVersion !== 2 || !Number.isSafeInteger(proof.documentRevision)
        || Number(proof.documentRevision) < 0 || proof.scopeId !== scopeId || proof.producerGenerationId !== generation
        || proof.producerContract !== 'pet-work-observer-disabled/v1'
      ) throw new Error('Real pending-free Pet history proof required in the current work scope')
    }
    if (this.#verifiedRetirement !== service) {
      this.#retirementUnsubscribe?.()
      this.#verifiedRetirement = service
      this.#verifiedGeneration = generation
      this.#retirementUnsubscribe = service.subscribeInvalidation(() => {
        if (this.#verifiedRetirement !== service || this.#disposed) return
        this.#verifiedRetirement = undefined
        this.#verifiedGeneration = undefined
        this.setIncome('unavailable', 'retirement', 'Original Pet retirement evidence invalidated')
      })
    }
    fence()
    if (!this.retirementCurrent()) throw new Error('Pet retirement invalidated during subscription')
  }
  private stopIncome() {
    this.#generation++
    this.#verifiedWorkScope = undefined
    this.setIncome('unavailable', 'wallet', 'Local wallet disconnected')
    this.#retirementUnsubscribe?.()
    this.#retirementUnsubscribe = undefined
    this.#verifiedRetirement = undefined
    this.#worker?.dispose()
    this.#worker = undefined
    this.#wallet = undefined
  }
  override async disconnect() {
    this.stopIncome()
    await super.disconnect()
  }
  override dispose() {
    this.#disposed = true
    this.stopIncome()
    super.dispose()
    for (const listener of this.#incomeListeners) {
      try {
        listener()
      } catch { /* Terminal observers cannot interrupt owner disposal. */ }
    }
    this.#incomeListeners.clear()
  }
}
