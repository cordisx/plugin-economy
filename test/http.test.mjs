import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { bearerTransport, EconomyClient } from '../dist/client/index.js'
import { createEconomyServer, Economy } from '../dist/server/index.js'
test('HTTP uses real typed client, enrollment, body/origin/auth guards and no anonymous credit', async t => {
  const economy = new Economy(':memory:')
  economy.auth.createInstance('one', 1000)
  economy.auth.createAccount('one', 'alice')
  const code = economy.auth.enrollment('one', 'alice')
  const server = createEconomyServer(economy)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    economy.close()
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${url}/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const { token } = await login.json()
  const client = new EconomyClient(url, bearerTransport(fetch, () => token))
  assert.equal((await client.me()).accountId, 'alice')
  assert.equal((await fetch(`${url}/v1/me`)).status, 401)
  assert.equal(
    (await fetch(`${url}/v1/me`, { headers: { Origin: 'https://evil.test', Authorization: `Bearer ${token}` } }))
      .status,
    403,
  )
  assert.equal(
    (await fetch(`${url}/v1/credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    })).status,
    404,
  )
  assert.equal(
    (await fetch(`${url}/v1/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{',
    })).status,
    400,
  )
  assert.equal((await fetch(`${url}/v1/me?token=leak`)).status, 400)
})

test('sponsor preflight and guarded grants bind identity, conserve budgets and recover only the same event', async t => {
  let now = Date.UTC(2026, 8, 9, 23, 59, 59)
  const economy = new Economy(':memory:', () => now)
  economy.auth.createInstance('one', 1000)
  economy.auth.createAccount('one', 'alice')
  const user = economy.auth.login(economy.auth.enrollment('one', 'alice')).token
  const sponsor = economy.auth.createService('one', 'pet-sponsor', 'work', 100).token
  const stranger = economy.auth.createService('one', 'game', '*', 100).token
  economy.commerce.createSource('one', 'work', 'pet-sponsor', 'reward', 5, 4, 3)
  const server = createEconomyServer(economy)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    economy.close()
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const client = token => new EconomyClient(url, bearerTransport(fetch, () => token))
  const svc = client(sponsor)
  const status = await svc.rewardSource('work', 'alice')
  assert.deepEqual(status, {
    instanceId: 'one',
    accountId: 'alice',
    serviceId: 'pet-sponsor',
    sourceId: 'work',
    available: 5,
    dailyLimit: 4,
    accountDailyLimit: 3,
    dailyGranted: 0,
    accountDailyGranted: 0,
    resetsAt: Date.UTC(2026, 8, 10),
  })
  for (const token of [user, stranger]) {
    await assert.rejects(client(token).rewardSource('work', 'alice'), { code: 'FORBIDDEN' })
  }
  await assert.rejects(svc.rewardSource('work', 'missing'), { code: 'NOT_FOUND' })
  const body = {
    sourceId: 'work',
    accountId: 'alice',
    eventId: 'epoch-revision-1',
    amount: 3,
    expectedInstanceId: 'one',
  }
  const actor = economy.auth.authenticate(sponsor)
  const receipt = economy.store.idempotent(
    'one',
    'service:pet-sponsor',
    'reward-first',
    '/v1/rewards/grant',
    body,
    () => economy.commerce.grant(actor, body),
  )
  assert.deepEqual(await svc.grant(body, 'reward-first'), receipt)
  for (const key of ['new-event', 'another-key']) await assert.rejects(svc.grant(body, key), { code: 'ENTRY_RETIRED' })
  await assert.rejects(svc.grant({ ...body, amount: 2 }, 'reward-first'), { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal((await client(user).me()).available, 3)
  economy.store.assertConservation('one')
})
