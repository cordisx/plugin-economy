import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Economy } from './economy.js'
import { requireCondition } from './errors.js'
import { createEconomyServer } from './http.js'
import { LocalWalletIncome } from './local-wallet-income.js'
import { ManagedWorkIncome, type ManagedWorkTrust } from './managed-work.js'
import { createSpendProviderFactory } from './spend-provider-factory.js'
process.umask(0o077)
const path = resolve(process.env.ECONOMY_DB ?? './data/economy.sqlite')
mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
const economy = new Economy(path)
chmodSync(path, 0o600)
const trustInputs = (process.env.ECONOMY_MANAGED_TRUST_FILES || '').split(',').filter(Boolean).map(file => {
  const stat = lstatSync(file)
  requireCondition(
    stat.isFile() && (stat.mode & 0o777) === 0o600 && (process.getuid === undefined || stat.uid === process.getuid()),
    'INVALID_TRUST',
    'Managed trust file must be a private regular 0600 file',
  )
  return JSON.parse(readFileSync(file, 'utf8')) as ManagedWorkTrust
})
const trusts = trustInputs.map(trust => new ManagedWorkIncome(economy.store, trust))
requireCondition(
  trusts.length <= 2 && new Set(trusts.map(trust => trust.binding.audience)).size === trusts.length,
  'INVALID_TRUST',
  'Provision at most one managed trust per audience',
)
requireCondition(
  trusts.every(trust =>
    trust.binding.origin === trusts[0].binding.origin && trust.binding.instanceId === trusts[0].binding.instanceId
  ),
  'INVALID_TRUST',
  'Managed wallet identity and income must share origin and instance',
)
const localWallets = process.env.ECONOMY_LOCAL_WALLET === '1'
  ? trustInputs.flatMap(trust =>
    trust.binding.audience === 'source-account'
      ? [
        new LocalWalletIncome(economy.store, trust, 'local-wallet-enrollment'),
        new LocalWalletIncome(economy.store, trust, 'local-wallet'),
      ]
      : [new LocalWalletIncome(economy.store, trust, 'local-work-income')]
  )
  : []
const server = createEconomyServer(economy, {
  localWallets,
  workIncome: trusts.find(trust => trust.binding.audience === 'work-income'),
  sourceAccount: trusts.find(trust => trust.binding.audience === 'source-account'),
  allowedOrigins: (process.env.ECONOMY_ORIGINS ?? '').split(',').filter(Boolean),
})
const port = Number(process.env.PORT ?? 8788), host = process.env.HOST ?? '127.0.0.1'
requireCondition(
  !trusts.length || trusts.every(trust => trust.binding.origin === `http://${host === '::1' ? '[::1]' : host}:${port}`),
  'INVALID_TRUST',
  'Listener must match pinned local trust origin',
)
const spendInputs = [
  process.env.ECONOMY_SPEND_SOCKET,
  process.env.ECONOMY_SPEND_SECRET_FILE,
  process.env.ECONOMY_SPEND_RECEIPT_KEY_FILE,
]
requireCondition(
  spendInputs.every(x => !x) || spendInputs.every(Boolean),
  'INVALID_TRUST',
  'Spending socket, secret and stable receipt key must be configured together',
)
const spendTrust = trustInputs.find(trust => trust.binding.audience === 'source-account')
let spendProvider: { close(): Promise<void> } | undefined
if (spendInputs.every(Boolean)) {
  requireCondition(
    process.env.ECONOMY_LOCAL_WALLET === '1' && spendTrust,
    'INVALID_TRUST',
    'Spending requires the existing original local wallet trust',
  )
  const { listenWalletSpendProvider } = await import('cordisx/wallet-spend-provider/v1')
  spendProvider = await listenWalletSpendProvider({
    socketPath: spendInputs[0]!,
    secretFile: spendInputs[1]!,
    openSession: createSpendProviderFactory(economy.store, {
      origin: spendTrust.binding.origin,
      instanceId: spendTrust.binding.instanceId,
      receiptKeyFile: spendInputs[2]!,
    }),
  })
}
server.listen(
  port,
  host,
  () => console.info('Economy API ready at /v1'),
)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    void Promise.all([closed, spendProvider?.close()]).then(() => economy.close()).catch(error => {
      console.error(error instanceof Error ? error.message : 'Economy shutdown failed')
      process.exitCode = 1
    })
  })
}
