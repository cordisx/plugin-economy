/** Test-only reconstruction of old committed operations. Production routes are retired and tested separately. */
export function historicalRequest(economy, method, path, token, body, key) {
  const actor = economy.auth.authenticate(token)
  const operations = {
    '/v1/agreements': () => economy.agreements.create(actor, body),
    '/v1/reserve': () => economy.agreements.reserve(actor, body),
    '/v1/settle': () => economy.agreements.settle(actor, body),
    '/v1/cancel': () => economy.agreements.cancel(actor, body),
    '/v1/orders': () => economy.commerce.purchase(actor, body),
    '/v1/rewards/grant': () => economy.commerce.grant(actor, body),
    '/v1/migrations/claim': () => economy.commerce.claim(actor, body),
    '/v1/link-proofs': () => economy.auth.linkProof(actor, body),
    '/v1/link-proofs/redeem': () => economy.auth.redeemLinkProof(actor, body),
  }
  const execute = method === 'POST' ? operations[path] : undefined
  // Archived expiration arithmetic is exercised only in this historical fixture, never in the deployed entry.
  economy.agreements.sweep()
  if (!execute) return economy.request(method, path, token, body, key)
  return economy.store.idempotent(actor.instanceId, `${actor.kind}:${actor.subject}`, key, path, body, execute)
}
