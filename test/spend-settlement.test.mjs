import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettlement } from '../dist/spend/index.js'
test('public settlement parser requires closed contract and conserved original principal', () => {
  const x = {
    contract: 'economy.spend-settlement/v1',
    reservationId: 'hold:1',
    decisionId: 'decision:1',
    decisionHash: 'a'.repeat(64),
    walletId: 'wallet:1',
    amount: 20,
    captured: 12,
    released: 8,
  }
  assert.deepEqual(parseSettlement(x), x)
  for (
    const invalid of [
      { ...x, payout: 8 },
      { ...x, captured: 13 },
      { ...x, captured: -1, released: 21 },
      { ...x, amount: 1e13 },
      { ...x, decisionHash: 'A'.repeat(64) },
      { ...x, [Symbol('hidden')]: 1 },
    ]
  ) assert.throws(() => parseSettlement(invalid), /Invalid/)
  const clone = parseSettlement(x)
  clone.amount = 99
  assert.equal(x.amount, 20)
})
