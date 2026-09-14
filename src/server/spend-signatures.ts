import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto'
import {
  canonical,
  decode,
  parseDecision,
  parseReservation,
  parseSigned,
  parseTerms,
  parseWalletChallenge,
  signingBytes,
} from '../spend/codec.js'
import type { Signed, SpendDecision, SpendReservation, SpendTerms } from '../spend/contracts.js'
import { requireCondition } from './errors.js'
export const spendHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export function receiptKey(input: string | KeyObject): { key: KeyObject; publicKey: string } {
  const key = typeof input === 'string' ? createPrivateKey(input) : input
  requireCondition(
    key.type === 'private' && key.asymmetricKeyType === 'ed25519',
    'INVALID_KEY',
    'Private Ed25519 receipt key required',
  )
  return { key, publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url') }
}
export function signed<T extends { contract: string }>(payload: T, key: KeyObject): Signed<T> {
  return { payload, signature: sign(null, signingBytes(payload), key).toString('base64url') }
}
export function checked<T extends { contract: string }>(
  value: unknown,
  parse: (x: unknown) => T,
  publicKey: string,
): Signed<T> {
  const envelope = parseSigned(value, parse)
  requireCondition(
    verify(
      null,
      signingBytes(envelope.payload),
      createPublicKey({ key: Buffer.from(decode(publicKey)), type: 'spki', format: 'der' }),
      Buffer.from(decode(envelope.signature)),
    ),
    'INVALID_SIGNATURE',
    'Spend signature does not match the pinned key',
    403,
  )
  return envelope
}
export const checkedTerms = (value: unknown) => {
  const e = parseSigned(value, parseTerms)
  return checked(e, parseTerms, e.payload.servicePublicKey)
}
export const checkedReservation = (value: unknown): Signed<SpendReservation> => {
  const e = parseSigned(value, parseReservation)
  return checked(e, parseReservation, e.payload.walletPublicKey)
}
export const checkedDecision = (value: unknown): Signed<SpendDecision> => {
  const e = parseSigned(value, parseDecision)
  return checked(e, parseDecision, e.payload.servicePublicKey)
}
export function matchBinding(a: SpendTerms, b: SpendReservation | SpendDecision): boolean {
  return a.serviceOrigin === b.serviceOrigin && a.servicePublicKey === b.servicePublicKey && a.serverId === b.serverId
    && a.matchId === b.matchId && spendHash(a) === b.termsHash
}
export const decisionId = (terms: SpendTerms) =>
  'decision:'
  + spendHash({
    serviceOrigin: terms.serviceOrigin,
    servicePublicKey: terms.servicePublicKey,
    serverId: terms.serverId,
    matchId: terms.matchId,
    termsHash: spendHash(terms),
  })

export const checkedWalletChallenge = (value: unknown) => {
  const e = parseSigned(value, parseWalletChallenge)
  return checked(e, parseWalletChallenge, e.payload.servicePublicKey)
}
