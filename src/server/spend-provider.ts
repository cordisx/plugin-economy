import { createHash } from 'node:crypto'
import type { PoolQuote } from '../pool/contracts.js'
import { canonical } from '../spend/codec.js'
import type { SpendStatus } from '../spend/contracts.js'
import { requireCondition } from './errors.js'
import { legacyReceipt, type LegacyReceiptQuery } from './legacy-receipts.js'
import { openLocalCommerceSession } from './local-commerce.js'
import { LocalPoolEngine } from './local-pool.js'
import { type BindingQuote, LocalSpendEngine, type SpendQuote } from './local-spend.js'
import { LocalWalletIdentities } from './local-wallet-identities.js'
import { checkedDecision, checkedTerms, spendHash } from './spend-signatures.js'
export type SpendProviderSource = { serviceOrigin: string; servicePublicKey: string; serverId: string }
export type SpendProviderWallet = {
  origin: string
  instanceId: string
  accountId: string
  subject: string
  publicKey: string
}
export type SpendProviderRecord = { reservation: string; state: SpendStatus['state']; settlement?: string }
const record = (value: SpendStatus): SpendProviderRecord => ({
  reservation: canonical(value.reservation),
  state: value.state,
  ...(value.settlement ? { settlement: canonical(value.settlement) } : {}),
})
const sourceMatches = (a: SpendProviderSource, b: SpendProviderSource) =>
  a.serviceOrigin === b.serviceOrigin && a.servicePublicKey === b.servicePublicKey && a.serverId === b.serverId
/** Consumed only by the authenticated Host Node UDS server adapter. No listener, signer or authority registry is provided to renderer plugins. */
export function openSpendProviderSession(
  engine: LocalSpendEngine,
  wallet: SpendProviderWallet,
  live: () => boolean,
  poolEngine?: LocalPoolEngine,
) {
  requireCondition(
    wallet.instanceId === engine.instanceId && wallet.accountId === engine.accountId,
    'WALLET_MISMATCH',
    'Use the existing canonical wallet',
    403,
  )
  const aliases = new LocalWalletIdentities(
    engine.store,
    wallet.instanceId,
    'realm:' + spendHash({ origin: wallet.origin, instanceId: wallet.instanceId }),
  )
  const fingerprint = createHash('sha256').update(Buffer.from(wallet.publicKey, 'base64')).digest('hex')
  let active = true
  const current = () => {
    requireCondition(active, 'AUTHORIZATION_RETIRED', 'Provider session retired', 403)
    requireCondition(live(), 'AUTHORIZATION_RETIRED', 'Trusted IPC operation is no longer active', 403)
    requireCondition(
      aliases.resolve({ realm: aliases.realm, subject: wallet.subject, keyFingerprint: fingerprint })
        === engine.accountId,
      'WALLET_MISMATCH',
      'Original local delegation changed',
      403,
    )
  }
  current()
  const session = engine.openSession(current)
  const commerce = openLocalCommerceSession(engine, current)
  const pool = poolEngine?.openSession(current)
  const poolRecord = (r: import('../pool/contracts.js').PoolStatus) => ({ ...r, reservation: canonical(r.reservation) })
  return Object.freeze({
    ...commerce,
    ...(pool && poolEngine
      ? {
        pool: {
          quote: (terms: string, requestId: string) => {
            const handle = pool.quote(JSON.parse(terms), requestId)
            return { handle, terms: canonical(JSON.parse(terms)) }
          },
          reserve: (handle: object) => poolRecord(pool.reserve(handle as PoolQuote)),
          lookup: (source: SpendProviderSource, requestId: string) => {
            current()
            const r = poolEngine.lookup(source, requestId)
            return r ? poolRecord(r) : null
          },
          applyDecision: (source: SpendProviderSource, input: string) => {
            current()
            const decision = JSON.parse(input)
            requireCondition(
              sourceMatches(source, decision.payload.terms.payload),
              'SOURCE_MISMATCH',
              'Original pool source required',
              403,
            )
            return poolRecord(poolEngine.applyDecision(decision, current))
          },
        },
      }
      : {}),
    legacyReceipt: (query: LegacyReceiptQuery) => {
      current()
      return legacyReceipt(engine, query)
    },
    identity: () => {
      current()
      return { walletId: engine.walletId, walletPublicKey: engine.walletPublicKey }
    },
    quote: (terms: string, requestId: string) => {
      const envelope = checkedTerms(JSON.parse(terms))
      const handle = session.quote(envelope, requestId)
      return { handle, terms: canonical(envelope) }
    },
    reserve: (handle: object) => record(session.reserve(handle as SpendQuote)),
    quoteBinding: (challenge: string) => {
      const envelope = JSON.parse(challenge)
      const handle = session.quoteBinding(envelope)
      return { handle, challenge: canonical(envelope) }
    },
    bindGameAccount: (handle: object) => canonical(session.bindGameAccount(handle as BindingQuote)),
    lookup: (source: SpendProviderSource, requestId: string) => {
      current()
      const value = engine.lookupRequest(source, requestId)
      return value ? record(value) : null
    },
    applyDecision: (source: SpendProviderSource, input: string) => {
      current()
      const envelope = checkedDecision(JSON.parse(input))
      requireCondition(
        sourceMatches(source, envelope.payload),
        'SOURCE_MISMATCH',
        'Decision belongs to the pinned source',
        403,
      )
      return engine.applyDecision(envelope, current).map(record)
    },
    close: () => {
      active = false
      session.close()
      pool?.close()
    },
  })
}
