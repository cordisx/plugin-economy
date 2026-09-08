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
  await assert.rejects(svc.grant({ ...body, expectedInstanceId: 'other' }, 'wrong-instance'), {
    code: 'INSTANCE_MISMATCH',
  })
  const receipt = await svc.grant(body, 'reward-first')
  assert.deepEqual(receipt, {
    instanceId: 'one',
    accountId: 'alice',
    sourceId: 'work',
    eventId: body.eventId,
    amount: 3,
  })
  assert.deepEqual(await svc.grant(body, 'reward-first'), receipt)
  assert.deepEqual(await svc.grant(body, 'another-key'), receipt)
  await assert.rejects(svc.grant({ ...body, amount: 2 }, 'different-event-value'), { code: 'EVENT_CONFLICT' })
  const next = { ...body, eventId: 'epoch-revision-2', amount: 2 }
  await assert.rejects(svc.grant(next, 'retry-after-day'), { code: 'LIMIT_EXCEEDED', retryable: false })
  assert.equal((await svc.rewardSource('work', 'alice')).accountDailyGranted, 3)
  now += 2000
  assert.equal((await svc.rewardSource('work', 'alice')).accountDailyGranted, 0)
  // A failure is not a permanent cancellation: the identical key can succeed after the UTC reset.
  await svc.grant(next, 'retry-after-day')
  await assert.rejects(svc.grant({ ...body, eventId: 'no-budget', amount: 1 }, 'budget-empty'), {
    code: 'INSUFFICIENT_FUNDS',
  })
  assert.equal((await client(user).me()).available, 5)
  assert.equal((await svc.rewardSource('work', 'alice')).available, 0)
  economy.store.assertConservation('one')
})
