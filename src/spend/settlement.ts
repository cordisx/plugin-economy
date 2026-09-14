import type { SpendSettlement } from './contracts.js'
/** Validates the public signed settlement payload; signature verification uses verifySigned with the reservation wallet key. */
export function parseSettlement(input: unknown): SpendSettlement {
  const x = input as SpendSettlement,
    fields = ['contract', 'reservationId', 'decisionId', 'decisionHash', 'walletId', 'amount', 'captured', 'released']
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  const n = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000_000
  if (
    !x || typeof x !== 'object' || Array.isArray(x) || ![Object.prototype, null].includes(Object.getPrototypeOf(x))
    || Reflect.ownKeys(x).length !== fields.length || Object.keys(x).sort().join(',') !== fields.sort().join(',')
    || x.contract !== 'economy.spend-settlement/v1'
    || !id(x.reservationId) || !id(x.decisionId) || !id(x.walletId) || !/^[a-f0-9]{64}$/.test(x.decisionHash)
    || !n(x.amount) || !n(x.captured) || !n(x.released) || x.amount !== x.captured + x.released
  ) throw new Error('Invalid spend settlement contract')
  return structuredClone(x)
}
