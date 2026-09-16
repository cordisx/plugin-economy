import type { Principal } from '../client/contracts.js'
import { canonical, Store } from './database.js'
import { EconomyError, requireCondition } from './errors.js'
export const RETIRED_MUTATIONS = new Set([
  '/v1/link-proofs',
  '/v1/link-proofs/redeem',
  '/v1/agreements',
  '/v1/reserve',
  '/v1/settle',
  '/v1/cancel',
  '/v1/orders',
  '/v1/rewards/grant',
  '/v1/migrations/claim',
])
/** Only a previously committed exact operation can be recovered. Unknown historical transactions stay pending. */
export function recoverRetired(store: Store, actor: Principal, path: string, body: unknown, key?: string): unknown {
  const prior = key
    ? store.one<{ fingerprint: string; response: string }>(
      'SELECT fingerprint,response FROM idempotency WHERE instance=? AND actor=? AND key=?',
      actor.instanceId,
      `${actor.kind}:${actor.subject}`,
      key,
    )
    : undefined
  if (!prior) {
    throw new EconomyError('ENTRY_RETIRED', 'Historical mutation retired; use the local wallet authority', 410)
  }
  requireCondition(
    prior.fingerprint === hashRequest(path, body),
    'IDEMPOTENCY_CONFLICT',
    'Historical key is bound to a different exact operation',
    409,
  )
  return JSON.parse(prior.response)
}
import { hash } from './database.js'
const hashRequest = (operation: string, input: unknown) => hash(canonical({ operation, input }))
