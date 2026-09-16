import type { EconomyClient, HistoryDeclarationReceipt } from '@cordisx/economy/client'
import {
  type HistoryCorrection,
  type LocalState,
  localState,
  type LocalStorage,
  type LocalWalletBinding,
  sameWallet,
  workCursor,
} from '@cordisx/economy/local'
import type { UsageV2 } from '@cordisx/protocol/usage/v2'
import type { Context } from '@deepseek-ai/cordis'
export type ExplicitHistoryCorrection = { action: 'confirm-never-enabled' | 'cancel'; statement: string }
/** Explicit own-profile policy correction. Pending local/server records survive uncertain replies and crashes. */
export async function correctHistory(
  ctx: Context,
  storage: LocalStorage,
  client: EconomyClient,
  wallet: LocalWalletBinding,
  desired: 'requires-retirement' | 'never-enabled',
  config: ExplicitHistoryCorrection,
  current: () => boolean,
  verifyNever: (scope: string) => Promise<void>,
  producerCurrent: () => boolean,
): Promise<void> {
  const fence = () => {
    if (!current()) throw new Error('History correction owner changed')
  }
  let verified = false
  const producerFence = () => {
    if (verified && !producerCurrent()) throw new Error('Original producer invalidated during history correction')
  }
  const read = async () => {
    const record = await storage.load()
    fence()
    const state = localState(record.value)
    if (!sameWallet(state.wallet, wallet)) throw new Error('History correction cannot change the wallet')
    return { record, state }
  }
  const pristine = (state: LocalState) => {
    if (state.pending || state.cursor || state.lastEventId || state.earned !== 0 || state.remainder !== 0) {
      throw new Error('Original work history or pending prevents correction')
    }
  }
  const noCutover = async () => {
    const document = await ctx.documents.load('economy-work-issuance-v1')
    fence()
    producerFence()
    if (document.status !== 'missing') {
      throw new Error('Existing or unavailable issuance document prevents history correction')
    }
  }
  const proof = async () => {
    const usage = ctx.get('usage') as UsageV2 | undefined
    if (!usage?.readWork) throw new Error('Current classified work scope required for explicit declaration')
    const cursor = workCursor(await usage.readWork())
    fence()
    await verifyNever(cursor.scopeId)
    fence()
    if (!producerCurrent()) throw new Error('Original producer changed during history correction')
    verified = true
  }
  const receipt = async (operation: HistoryCorrection, stage: 'begin' | 'confirm' | 'cancel' | 'lookup') => {
    if (stage !== 'cancel') producerFence()
    const value = await client.historyDeclaration({
      contract: 'economy.history-declaration/v1',
      id: operation.id,
      statement: operation.statement,
      stage,
    })
    fence()
    if (stage !== 'cancel') producerFence()
    if (
      value.contract !== 'economy.history-declaration/v1' || value.instanceId !== wallet.instanceId
      || value.accountId !== wallet.accountId
      || value.id !== operation.id || value.statement !== operation.statement || value.from !== operation.from
      || value.to !== operation.to
      || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !['pending', 'confirmed', 'cancelled'].includes(value.status)
    ) throw new Error('Manual declaration receipt mismatch')
    return value
  }
  const saveOperation = async (
    operation: HistoryCorrection,
    policy: LocalState['legacyPetHistory'],
    response?: HistoryDeclarationReceipt,
  ) => {
    for (let retry = 0; retry < 12; retry++) {
      const { record, state } = await read()
      if (policy === 'never-enabled') producerFence()
      if (state.historyCorrection?.id !== operation.id) {
        throw new Error('Another manual history correction owns this document')
      }
      if (state.historyCorrection.status === 'cancelled' && operation.status !== 'cancelled') {
        throw new Error('Original correction was cancelled')
      }
      if (state.historyCorrection.status === 'recorded') {
        if (operation.status === 'cancelled') throw new Error('Confirmed declaration cannot be cancelled')
        return
      }
      if (
        operation.status !== 'cancelled'
        && !(operation.status === 'recorded' && state.legacyPetHistory === 'never-enabled'
          && response?.status === 'confirmed')
      ) pristine(state)
      state.legacyPetHistory = policy
      state.historyCorrection = { ...operation, ...(response ? { receipt: response } : {}) }
      if (policy === 'never-enabled') producerFence()
      const saved = await storage.save(record.revision, state)
      fence()
      if (policy === 'never-enabled') producerFence()
      if (saved) return
    }
    throw new Error('Manual history correction document busy')
  }
  let { state } = await read(), operation = state.historyCorrection
  if (config.action === 'cancel') {
    if (desired !== 'requires-retirement' || !operation || operation.status === 'recorded') {
      throw new Error('Only an unfinished correction can be explicitly cancelled to requires-retirement')
    }
    if (config.statement !== operation.statement) {
      throw new Error('Preserve the original manual statement when cancelling')
    }
    const response = await receipt(operation, 'cancel')
    if (response.status !== 'cancelled') throw new Error('History correction cancellation not confirmed')
    await saveOperation({ ...operation, status: 'cancelled' }, 'requires-retirement', response)
    return
  }
  if (
    desired !== 'never-enabled' || !config.statement.trim() || config.statement.trim() !== config.statement
    || config.statement.length > 1000
  ) throw new Error('Explicit never-enabled manual statement required')
  if (operation && operation.status !== 'cancelled' && operation.statement !== config.statement) {
    throw new Error('Preserve the original manual statement for recovery')
  }
  if (operation?.status === 'recorded' && state.legacyPetHistory === 'never-enabled') {
    if ((await receipt(operation, 'begin')).status !== 'confirmed') {
      throw new Error('Original server declaration not confirmed')
    }
    return
  }
  if (operation?.status === 'pending') {
    await proof()
    let existing: HistoryDeclarationReceipt | undefined
    try {
      existing = await receipt(operation, 'lookup')
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'HISTORY_NOT_FOUND' && 'status' in error
          && error.status === 404)
      ) throw error
    }
    if (existing?.status === 'confirmed') {
      await noCutover()
      await saveOperation({ ...operation, status: 'recorded' }, 'never-enabled', existing)
      return
    }
    if (existing?.status === 'cancelled') throw new Error('Explicit cancellation must restore conservative policy')
  }
  pristine(state)
  await noCutover()
  await proof()
  if (!operation || operation.status === 'cancelled') {
    const id = `history:${crypto.randomUUID()}`
    operation = { id, from: 'requires-retirement', to: 'never-enabled', statement: config.statement, status: 'pending' }
    let installed = false
    for (let retry = 0; retry < 12; retry++) {
      const { record, state: next } = await read()
      pristine(next)
      await noCutover()
      if (next.historyCorrection?.status === 'pending' || next.historyCorrection?.status === 'recorded') {
        if (next.historyCorrection.statement !== config.statement) {
          throw new Error('Another explicit declaration is pending')
        }
        operation = next.historyCorrection
        installed = true
        break
      }
      if (next.legacyPetHistory !== 'requires-retirement') {
        throw new Error('Conservative original policy required for correction')
      }
      next.historyCorrection = operation
      const saved = await storage.save(record.revision, next)
      fence()
      if (saved) {
        installed = true
        break
      }
    }
    if (!installed) throw new Error('Manual declaration document busy')
  }
  const begun = await receipt(operation, 'begin')
  if (begun.status === 'cancelled') throw new Error('Original declaration was cancelled')
  await proof()
  await noCutover()
  await saveOperation({ ...operation, status: 'pending' }, 'requires-retirement', begun)
  await proof()
  await noCutover()
  const confirmed = await receipt(operation, 'confirm')
  if (confirmed.status !== 'confirmed') throw new Error('Server declaration confirmation required')
  await saveOperation({ ...operation, status: 'recorded' }, 'never-enabled', confirmed)
  fence()
}
