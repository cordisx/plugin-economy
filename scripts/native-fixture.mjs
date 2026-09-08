/** Isolated manual native-wallet fixture. Credentials only enter mode-0600 ignored files. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createEconomyServer, Economy } from '../dist/server/index.js'
const directory = process.env.ECONOMY_FIXTURE_DIR ?? '.cache/native-fixture'
process.umask(0o077)
mkdirSync(directory, { recursive: true, mode: 0o700 })
// Never point this fixture at a user's persistent database.
const economy = new Economy(':memory:')
economy.auth.createInstance('native-fixture', 1000)
for (const account of ['alice', 'bob']) economy.auth.createAccount('native-fixture', account)
economy.store.transaction(() => {
  for (const account of ['alice', 'bob']) {
    economy.store.transfer('native-fixture', '$issuer', account, 100, 'fixture-allocation', account, Date.now())
  }
  economy.store.assertConservation('native-fixture')
})
const alice = economy.auth.login(economy.auth.enrollment('native-fixture', 'alice'))
const bob = economy.auth.login(economy.auth.enrollment('native-fixture', 'bob'))
const game = economy.auth.createService('native-fixture', 'test-game', '*', 100)
const agreement = economy.request('POST', '/v1/agreements', game.token, {
  matchId: 'native-review',
  game: { id: 'gomoku', version: '1.0.0', digest: 'a'.repeat(64), reviewStatus: 'unreviewed' },
  participants: [{ accountId: 'alice', amount: 10, participantIds: ['alice-human', 'alice-agent'] }, {
    accountId: 'bob',
    amount: 10,
    participantIds: ['bob-human'],
  }],
  settlementPolicy: {
    kind: 'enumerated',
    outcomes: [{ id: 'alice-wins', payouts: [{ accountId: 'alice', amount: 20 }] }, {
      id: 'draw',
      payouts: [{ accountId: 'alice', amount: 10 }, { accountId: 'bob', amount: 10 }],
    }],
  },
  expiresAt: Date.now() + 30 * 60_000,
}, 'fixture-agreement')
economy.request(
  'POST',
  '/v1/reserve',
  bob.token,
  { agreementId: agreement.id, termsHash: agreement.termsHash },
  'fixture-bob-reserve',
)
const server = createEconomyServer(economy)
server.listen(0, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${server.address().port}`
  writeFileSync(`${directory}/session.json`, JSON.stringify({ origin, alice, bob, game, agreement }), { mode: 0o600 })
  console.info(
    `Native fixture ready at ${origin}; credentials in ${directory}/session.json. Expected wallet: native-fixture/alice, available=100, reserved=0.`,
  )
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => economy.close()))
