import type {
  Signed,
  SpendDecision,
  SpendReservation,
  SpendTerms,
  WalletBinding,
  WalletChallenge,
} from './contracts.js'
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${
    Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')
  }}`
}
const fail = (ok: unknown): void => {
  if (!ok) throw new Error('Invalid economy spend contract')
}
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  fail(
    value && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value))
      && Reflect.ownKeys(value).every(key => typeof key === 'string')
      && Object.keys(value).sort().join(',') === expected.sort().join(','),
  )
}
const id = (x: unknown) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x)
const number = (x: unknown, min = 0) => Number.isSafeInteger(x) && Number(x) >= min && Number(x) <= 1_000_000_000_000
export function decode(value: string): Uint8Array {
  fail(/^[A-Za-z0-9_-]+$/.test(value))
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0))
  fail(encode(bytes) === value)
  return bytes
}
export function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function publicKey(value: unknown): asserts value is string {
  fail(typeof value === 'string' && /^[A-Za-z0-9_-]{59}$/.test(value))
  const bytes = decode(value as string), prefix = [48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0]
  fail(bytes.length === 44 && prefix.every((x, i) => bytes[i] === x))
}
function service(x: Record<string, unknown>) {
  fail(typeof x.serviceOrigin === 'string')
  const u = new URL(x.serviceOrigin as string)
  fail(
    u.origin === x.serviceOrigin && !u.username && !u.password
      && (u.protocol === 'https:'
        || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))),
  )
  publicKey(x.servicePublicKey)
  fail(id(x.serverId) && id(x.matchId))
}
function participant(x: Record<string, unknown>) {
  fail(id(x.gameAccountId) && id(x.walletId) && number(x.amount, 1))
  publicKey(x.walletPublicKey)
}
export function parseTerms(input: unknown): SpendTerms {
  keys(input, [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
    'matchId',
    'game',
    'participants',
    'policy',
    'acceptBefore',
  ])
  const x = structuredClone(input)
  fail(
    x.contract === 'economy.spend-terms/v1' && x.policy === 'capture-and-release'
      && Number.isSafeInteger(x.acceptBefore) && Number(x.acceptBefore) >= 0,
  )
  service(x)
  keys(x.game, ['id', 'version', 'digest', 'reviewStatus'])
  fail(
    id(x.game.id) && id(x.game.version)
      && typeof x.game.digest === 'string' && /^[a-f0-9]{64}$/.test(x.game.digest)
      && ['reviewed', 'unreviewed'].includes(String(x.game.reviewStatus)),
  )
  fail(Array.isArray(x.participants) && x.participants.length > 0 && x.participants.length <= 8)
  const accounts = new Set(), wallets = new Set()
  for (const p of x.participants as unknown[]) {
    keys(p, ['gameAccountId', 'walletId', 'walletPublicKey', 'amount'])
    participant(p)
    fail(!accounts.has(p.gameAccountId) && !wallets.has(p.walletId))
    accounts.add(p.gameAccountId)
    wallets.add(p.walletId)
  }
  return x as unknown as SpendTerms
}
export function parseReservation(input: unknown): SpendReservation {
  keys(input, [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
    'matchId',
    'termsHash',
    'reservationId',
    'nonce',
    'gameAccountId',
    'walletId',
    'walletPublicKey',
    'amount',
  ])
  const x = structuredClone(input)
  service(x)
  participant(x)
  fail(
    x.contract === 'economy.spend-reservation/v1' && id(x.reservationId)
      && typeof x.termsHash === 'string' && /^[a-f0-9]{64}$/.test(x.termsHash)
      && typeof x.nonce === 'string' && /^[a-f0-9]{64}$/.test(x.nonce),
  )
  return x as unknown as SpendReservation
}
export function parseDecision(input: unknown): SpendDecision {
  keys(input, [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
    'matchId',
    'termsHash',
    'decisionId',
    'action',
    'entries',
  ])
  const x = structuredClone(input)
  service(x)
  fail(
    x.contract === 'economy.spend-decision/v1' && id(x.decisionId)
      && typeof x.termsHash === 'string' && /^[a-f0-9]{64}$/.test(x.termsHash)
      && ['capture', 'refund'].includes(String(x.action)) && Array.isArray(x.entries) && x.entries.length <= 8,
  )
  const seen = new Set()
  for (const entry of x.entries as unknown[]) {
    keys(entry, ['reservation', 'captureAmount'])
    const receipt = parseSigned(entry.reservation, parseReservation)
    fail(
      number(entry.captureAmount) && Number(entry.captureAmount) <= receipt.payload.amount
        && (x.action !== 'refund' || entry.captureAmount === 0) && !seen.has(receipt.payload.reservationId),
    )
    seen.add(receipt.payload.reservationId)
  }
  return x as unknown as SpendDecision
}
export function parseSigned<T>(input: unknown, parse: (value: unknown) => T): Signed<T> {
  keys(input, ['payload', 'signature'])
  fail(typeof input.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(input.signature))
  fail(decode(input.signature as string).length === 64)
  return { payload: parse(input.payload), signature: input.signature as string }
}
export function signingBytes(payload: { contract: string }): Uint8Array {
  return new TextEncoder().encode(`${payload.contract}\0${canonical(payload)}`)
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('')
}
export async function verifySigned<T extends { contract: string }>(value: Signed<T>, key: string): Promise<boolean> {
  publicKey(key)
  const imported = await crypto.subtle.importKey(
    'spki',
    decode(key).buffer as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    'Ed25519',
    imported,
    decode(value.signature).buffer as ArrayBuffer,
    signingBytes(value.payload).buffer as ArrayBuffer,
  )
}

export function parseWalletChallenge(input: unknown): WalletChallenge {
  keys(input, ['contract', 'serviceOrigin', 'servicePublicKey', 'serverId', 'gameAccountId', 'nonce', 'expiresAt'])
  const x = structuredClone(input)
  fail(
    x.contract === 'economy.spend-wallet-challenge/v1' && id(x.gameAccountId) && id(x.serverId)
      && typeof x.nonce === 'string' && /^[a-f0-9]{64}$/.test(x.nonce)
      && Number.isSafeInteger(x.expiresAt) && Number(x.expiresAt) >= 0,
  )
  service({ ...x, matchId: 'binding' })
  return x as unknown as WalletChallenge
}
export function parseWalletBinding(input: unknown): WalletBinding {
  keys(input, [
    'contract',
    'serviceOrigin',
    'servicePublicKey',
    'serverId',
    'gameAccountId',
    'nonce',
    'expiresAt',
    'walletId',
    'walletPublicKey',
  ])
  const x = structuredClone(input)
  fail(x.contract === 'economy.spend-wallet-binding/v1' && id(x.walletId))
  publicKey(x.walletPublicKey)
  const { walletId: _walletId, walletPublicKey: _walletPublicKey, ...challenge } = x
  parseWalletChallenge({ ...challenge, contract: 'economy.spend-wallet-challenge/v1' })
  return x as unknown as WalletBinding
}
