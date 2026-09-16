import { canonical } from '../spend/codec.js'
import { requireCondition } from './errors.js'
import type { LocalSpendEngine } from './local-spend.js'
import { spendHash } from './spend-signatures.js'
export type LegacyReceiptQuery = { kind: 'grant' | 'migration' | 'purchase'; requestId: string; input: string }
/** Pure read of an existing canonical idempotency receipt; no provisioning, POST retry, mint or fallback. */
export function legacyReceipt(engine: LocalSpendEngine, query: LegacyReceiptQuery): string | null {
  const input = JSON.parse(query.input) as Record<string, unknown>
  requireCondition(
    input && typeof input === 'object' && !Array.isArray(input),
    'INVALID_REQUEST',
    'Original saved input required',
  )
  let actor = `user:${engine.accountId}`, operation = '/v1/orders'
  if (query.kind === 'grant') {
    requireCondition(
      input.accountId === engine.accountId,
      'ACCOUNT_MISMATCH',
      'Historical grant must belong to the original wallet',
      403,
    )
    const source = engine.store.one<{ service: string }>(
      'SELECT service FROM sources WHERE instance=? AND id=?',
      engine.instanceId,
      String(input.sourceId),
    )
    if (!source) return null
    actor = `service:${source.service}`
    operation = '/v1/rewards/grant'
  } else if (query.kind === 'migration') operation = '/v1/migrations/claim'
  else requireCondition(query.kind === 'purchase', 'INVALID_REQUEST', 'Known historical receipt kind required')
  const row = engine.store.one<{ fingerprint: string; response: string }>(
    'SELECT fingerprint,response FROM idempotency WHERE instance=? AND actor=? AND key=?',
    engine.instanceId,
    actor,
    query.requestId,
  )
  if (!row) return null
  requireCondition(
    row.fingerprint === spendHash({ operation, input }),
    'HISTORICAL_CONFLICT',
    'Saved key/input differs from the original canonical operation',
    409,
  )
  const receipt = JSON.parse(row.response)
  requireCondition(
    receipt.instanceId === engine.instanceId && receipt.accountId === engine.accountId,
    'ACCOUNT_MISMATCH',
    'Historical receipt belongs to a different wallet',
    403,
  )
  return canonical(receipt)
}
