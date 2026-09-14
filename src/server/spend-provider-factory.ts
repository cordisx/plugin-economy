import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import type { Store } from './database.js'
import { requireCondition, textId } from './errors.js'
import { LocalSpendEngine } from './local-spend.js'
import { LocalWalletIdentities } from './local-wallet-identities.js'
import { openSpendProviderSession, type SpendProviderWallet } from './spend-provider.js'
import { receiptKey, spendHash } from './spend-signatures.js'
/** Operator-provisioned stable key. Never generate, rotate or repair it as a side effect of opening a wallet. */
export function loadSpendReceiptKey(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    requireCondition(
      stat.isFile() && (stat.mode & 0o777) === 0o600
        && (process.getuid === undefined || stat.uid === process.getuid()) && stat.size > 0 && stat.size <= 8192,
      'INVALID_KEY',
      'Receipt key must be an owner-owned private regular 0600 file',
    )
    return receiptKey(readFileSync(fd, 'utf8')).key
  } finally {
    closeSync(fd)
  }
}
/** Trusted launcher configuration and existing Store only. All accounts must already have their original verified local alias. */
export function createSpendProviderFactory(
  store: Store,
  config: { origin: string; instanceId: string; receiptKeyFile: string },
) {
  const url = new URL(config.origin)
  requireCondition(
    url.origin === config.origin && ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname),
    'INVALID_TRUST',
    'Pinned canonical local Economy origin required',
  )
  textId(config.instanceId, 'instanceId')
  const key = loadSpendReceiptKey(config.receiptKeyFile)
  const realm = 'realm:' + spendHash({ origin: config.origin, instanceId: config.instanceId })
  const aliases = new LocalWalletIdentities(store, config.instanceId, realm)
  return (wallet: SpendProviderWallet, live: () => boolean) => {
    requireCondition(
      live() && wallet.origin === config.origin && wallet.instanceId === config.instanceId,
      'WALLET_MISMATCH',
      'Trusted Host wallet must match the pinned original local Economy',
      403,
    )
    const fingerprint = createHash('sha256').update(Buffer.from(wallet.publicKey, 'base64')).digest('hex')
    requireCondition(
      aliases.publicKey(wallet.subject) === wallet.publicKey
        && aliases.resolve({ realm, subject: wallet.subject, keyFingerprint: fingerprint }) === wallet.accountId,
      'WALLET_MISMATCH',
      'Existing original local delegation required',
      403,
    )
    return openSpendProviderSession(new LocalSpendEngine(store, config.instanceId, wallet.accountId, key), wallet, live)
  }
}
