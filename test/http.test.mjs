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
