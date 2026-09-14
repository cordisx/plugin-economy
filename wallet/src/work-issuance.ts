import type { WorkScopeCorrection } from '@cordisx/economy/client'
import {
  type LocalIncomeReadiness,
  localState,
  type LocalStorage,
  type LocalWalletBinding,
  sameWallet,
  workCursor,
} from '@cordisx/economy/local'
import type { LocalWorkSettlementV1 } from '@cordisx/protocol/local-work-settlement/v1'
import type { HttpClientV3, ManagedSourceBindingV1 } from '@cordisx/protocol/plugin-http/v3'
import type { HttpClientV4 } from '@cordisx/protocol/plugin-http/v4'
import type { UsageV2 } from '@cordisx/protocol/usage/v2'
import type { Context } from '@deepseek-ai/cordis'
import type { CordisXJsonValue } from 'cordisx/contracts'
type IssuanceState = {
  version: 1
  wallet: LocalWalletBinding
  scopeId: string
  pending?: { id: string; owner: string; status: 'active' | 'failed' | 'retired' }
  lastEventId?: string
  scopeHistory?: { correctionId: string; previous: unknown }[]
}
/** The only owner observer; Host reads and signs actual usage, server owns all coin arithmetic. */
export class TrustedWorkIncomeObserver {
  readonly #ownerId = crypto.randomUUID()
  #closed = false
  #stage: LocalIncomeReadiness['stage'] = 'usage'
  #baseline = true
  #serial: Promise<void> = Promise.resolve()
  #timer?: ReturnType<typeof setInterval>
  #unsubscribe?: () => void
  constructor(
    private readonly ctx: Context,
    private readonly storage: LocalStorage,
    private readonly wallet: LocalWalletBinding,
    private readonly binding: ManagedSourceBindingV1,
    private readonly history: 'requires-retirement' | 'never-enabled',
    private readonly current: () => boolean,
    private readonly verifyRetirement: (scopeId: string) => Promise<void>,
    private readonly retirementCurrent: () => boolean,
    private readonly publish: (
      status: LocalIncomeReadiness['status'],
      stage: LocalIncomeReadiness['stage'],
      reason: string,
    ) => void,
    private readonly correction?: (from: string, to: string) => Promise<WorkScopeCorrection | undefined>,
  ) {}
  private setIncome(
    status: LocalIncomeReadiness['status'],
    stage: LocalIncomeReadiness['stage'],
    reason: string,
  ): void {
    this.#stage = stage
    this.publish(status, stage, reason)
  }
  async start() {
    const wallet = this.wallet, http = this.ctx.get('http') as HttpClientV3 | HttpClientV4 | undefined
    const settlement = this.ctx.get('workSettlement') as LocalWorkSettlementV1 | undefined
    const durable = settlement?.contract === 'cordisx.local-work-settlement/v1'
    const usage = this.ctx.get('usage') as UsageV2 | undefined
    const current = () => !this.#closed && this.current()
    if (
      !http || !['cordisx.http-client/v3', 'cordisx.http-client/v4'].includes(http.contract) || !http.submitWorkUsage
      || !usage?.readWork
    ) {
      this.setIncome('unavailable', 'usage', 'Trusted local income requires Host HTTP v3/v4 and classified usage')
      return
    }
    if (this.binding.instanceId !== wallet.instanceId) {
      throw new Error('Managed economy instance mismatch')
    }
    for (let retry = 0; retry < 12; retry++) {
      const record = await this.storage.load()
      if (!current()) return
      const state = localState(record.value)
      if (!sameWallet(state.wallet, wallet)) throw new Error('Preserve original canonical wallet identity')
      if (state.pending) {
        throw new Error('Resolve original finite sponsor pending receipt before usage issuance cutover')
      }
      if (state.legacyPetHistory && state.legacyPetHistory !== this.history) {
        throw new Error('Preserve original Pet history declaration')
      }
      if (state.legacyPetHistory === this.history) break
      state.legacyPetHistory = this.history
      const saved = await this.storage.save(record.revision, state)
      if (!current()) return
      if (saved) break
      if (retry === 11) throw new Error('Canonical wallet declaration busy')
    }
    const refresh = () => {
      const run = this.#serial.then(async () => {
        if (!current()) return
        let ownedIntent: string | undefined
        let terminated = true
        try {
          this.setIncome('connecting', 'usage', 'Reading classified actual local work')
          const cursor = workCursor(await usage.readWork())
          if (!current()) return
          this.setIncome('connecting', 'retirement', 'Checking original pending-free Pet retirement')
          await this.verifyRetirement(cursor.scopeId)
          if (!current()) return
          const canonical = localState((await this.storage.load()).value)
          if (!current()) return
          if (
            !sameWallet(canonical.wallet, wallet) || canonical.legacyPetHistory !== this.history
            || canonical.historyCorrection?.status === 'pending' || canonical.pending
          ) {
            throw new Error('Pinned history changed or a declaration/pending transaction requires reconciliation')
          }
          const r = await this.ctx.documents.load('economy-work-issuance-v1')
          if (!current()) return
          if (r.status === 'unavailable') throw new Error(r.diagnostic)
          const prior = r.status === 'loaded' ? r.snapshot.value as unknown as IssuanceState : undefined
          if (durable && r.status === 'loaded' && (!prior || typeof prior !== 'object' || Array.isArray(prior))) {
            throw new Error('Preserve invalid existing issuance document for review')
          }
          if (prior && (prior.version !== 1 || !sameWallet(prior.wallet, wallet))) {
            throw new Error('Preserve original usage issuance identity')
          }
          let scopeHistory = prior?.scopeHistory
          if (prior && prior.scopeId !== cursor.scopeId) {
            const correction = durable ? await this.correction?.(prior.scopeId, cursor.scopeId) : undefined
            if (!current()) return
            if (
              !correction || (prior.lastEventId !== undefined && prior.lastEventId !== correction.expectedEventId)
              || (!prior.lastEventId && !prior.pending)
            ) {
              throw new Error('Preserve original usage issuance identity without exact operator correction')
            }
            scopeHistory = [...(scopeHistory ?? []), { correctionId: correction.id, previous: structuredClone(prior) }]
          }
          if (prior?.pending) {
            if (
              !prior.pending.id || !prior.pending.owner
              || !['active', 'failed', 'retired'].includes(prior.pending.status)
            ) throw new Error('Preserve invalid issuance intent for review')
            // Legacy issuance requires terminal owner evidence. Durable settlement replays through the authoritative
            // server frontier and stable receipt, so even an unknown old response cannot create a second credit.
            if (prior.pending.status === 'active' && !durable) {
              this.setIncome('unavailable', 'settlement', 'Previous income request lacks termination evidence')
              return
            }
          }
          const revision = r.status === 'loaded' ? r.snapshot.revision : 0
          const intentId = crypto.randomUUID(), baseline = this.#baseline || !prior || !!prior.pending
          const intent: IssuanceState = {
            version: 1,
            wallet,
            scopeId: cursor.scopeId,
            pending: { id: intentId, owner: this.#ownerId, status: 'active' },
            lastEventId: prior?.lastEventId,
            ...(scopeHistory ? { scopeHistory } : {}),
          }
          // Undefined is not an owner JSON value.
          if (!intent.lastEventId) delete intent.lastEventId
          const saved = await this.ctx.documents.transaction({
            contract: 'cordisx.owner-documents/v1',
            documentId: 'economy-work-issuance-v1',
            expectedRevision: revision,
            schemaVersion: 1,
            value: intent as unknown as CordisXJsonValue,
          })
          if (saved.status !== 'accepted') return
          ownedIntent = intentId
          if (!current()) return
          // Revalidate after CAS: no new issuer operation while the original producer is unresolved.
          await this.verifyRetirement(cursor.scopeId)
          if (!current()) return
          if (!this.retirementCurrent()) throw new Error('Pet retirement invalidated before issuer submission')
          this.setIncome('connecting', 'settlement', 'Submitting trusted Host observation to usage issuer')
          terminated = false
          const response = durable
            ? await settlement.settle({ ...this.binding, audience: 'local-work-income' })
            : http.contract === 'cordisx.http-client/v4'
            ? await http.submitLocalWorkUsage({
              ...this.binding,
              audience: 'local-work-income',
              ...(baseline ? { baseline: true as const } : {}),
            })
            : await http.submitWorkUsage({ ...this.binding, ...(baseline ? { baseline: true as const } : {}) })
          terminated = response.status === 'accepted'
            || !['host-unavailable', 'stale-generation'].includes(response.code)
          if (!current()) return
          if (!this.retirementCurrent()) throw new Error('Pet retirement invalidated while issuer response was pending')
          if (response.status !== 'accepted') throw new Error(`Trusted work income: ${response.code}`)
          if (response.value.statusCode !== 200) throw new Error(`Usage issuer HTTP ${response.value.statusCode}`)
          const result = JSON.parse(response.value.body) as {
            wallet: LocalWalletBinding
            receipt: {
              eventId: string
              binding: { scopeId: string; instanceId: string; accountId: string }
              amount: number
              remainder: number
              policy?: string
              cursor?: {
                scopeId: string
                sourceId: string
                epoch: string
                revision: number
                tokens: number
                observedThrough: number
              }
            }
          }
          const receipt = result.receipt
          if (
            !result.wallet || !sameWallet(result.wallet, wallet) || !receipt
            || receipt.binding.scopeId !== cursor.scopeId || receipt.binding.instanceId !== wallet.instanceId
            || receipt.binding.accountId !== wallet.accountId || !/^work:[a-f0-9]{64}$/.test(receipt.eventId)
            || !Number.isSafeInteger(receipt.amount) || receipt.amount < 0 || !Number.isSafeInteger(receipt.remainder)
            || receipt.remainder < 0 || receipt.remainder >= 10000
            || durable && (receipt.policy !== 'durable-admitted-v1' || !receipt.cursor
                || receipt.cursor.scopeId !== cursor.scopeId)
          ) throw new Error('Trusted issuer receipt identity mismatch')
          const after = await this.ctx.documents.load('economy-work-issuance-v1')
          if (!current()) return
          if (
            after.status !== 'loaded' || (after.snapshot.value as unknown as IssuanceState).pending?.id !== intentId
          ) {
            return
          }
          const completed: IssuanceState = {
            version: 1,
            wallet,
            scopeId: cursor.scopeId,
            lastEventId: receipt.eventId,
            ...(scopeHistory ? { scopeHistory } : {}),
          }
          const committed = await this.ctx.documents.transaction({
            contract: 'cordisx.owner-documents/v1',
            documentId: 'economy-work-issuance-v1',
            expectedRevision: after.snapshot.revision,
            schemaVersion: 1,
            value: completed as unknown as CordisXJsonValue,
          })
          if (!current() || committed.status !== 'accepted') return
          if (!this.retirementCurrent()) {
            throw new Error('Pet retirement invalidated before income readiness publication')
          }
          this.#baseline = false
          this.setIncome(
            'ready',
            'settlement',
            durable
              ? 'Durable admitted input/output income active; legacy history remains separate'
              : 'Actual local classified usage income active; partial coverage',
          )
        } catch (error) {
          this.#baseline = true
          if (current()) {
            this.setIncome(
              'unavailable',
              this.#stage,
              error instanceof Error ? error.message : 'Usage issuance unavailable',
            )
          }
        } finally {
          // Only a trusted SDK terminal reply or no send permits release; transport-unknown stays active.
          if (ownedIntent && terminated) await this.releaseIntent(ownedIntent)
        }
      })
      this.#serial = run.catch(() => {})
    }
    this.#unsubscribe = usage.subscribe(refresh)
    this.#timer = setInterval(refresh, 5000)
    refresh()
  }
  private async releaseIntent(id: string): Promise<void> {
    try {
      const r = await this.ctx.documents.load('economy-work-issuance-v1')
      if (r.status !== 'loaded') return
      const state = r.snapshot.value as unknown as IssuanceState
      if (state.pending?.id !== id || state.pending.owner !== this.#ownerId) return
      state.pending.status = this.#closed ? 'retired' : 'failed'
      await this.ctx.documents.transaction({
        contract: 'cordisx.owner-documents/v1',
        documentId: 'economy-work-issuance-v1',
        expectedRevision: r.snapshot.revision,
        schemaVersion: 1,
        value: state as unknown as CordisXJsonValue,
      })
    } catch { /* Unavailable lifecycle evidence preserves the active intent and blocks takeover. */ }
  }
  dispose(): void {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#unsubscribe?.()
    this.#timer = undefined
    this.#unsubscribe = undefined
  }
}
