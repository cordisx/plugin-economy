import type { HttpConnectionV1 } from '@cordisx/protocol/plugin-http/v1'
import type { HttpClientV4, ManagedSourceBindingV1 } from '@cordisx/protocol/plugin-http/v4'
type ExpectedWallet = { instanceId: string; accountId: string }
/** A temporary Native handle proves the original wallet only during first local-key enrollment. */
export async function authorizeLocalWallet(
  http: HttpClientV4,
  binding: ManagedSourceBindingV1,
  expected: ExpectedWallet | undefined,
  current: () => boolean,
  allowEnrollment = true,
) {
  const localBinding = { ...binding, audience: 'local-wallet' as const }
  const opened = await http.connectLocalAccount(localBinding)
  if (opened.status === 'accepted' || opened.code !== 'local-wallet-not-enrolled' || !allowEnrollment) return opened
  // This code is reserved by local open for a missing enrollment; retirement/network errors never enroll.
  const native = await http.connectAccount(binding)
  if (native.status !== 'accepted') return native
  const connection = native.value.connection
  let localConnection: HttpConnectionV1 | undefined
  let nativeReleased = false
  try {
    if (!current()) throw new Error('Wallet owner retired before local enrollment')
    const response = await http.request({
      connection,
      path: '/v1/me',
      method: 'GET',
      headers: { accept: 'application/json' },
      deadline: Date.now() + 10_000,
    })
    if (!current()) throw new Error('Wallet owner retired during original account validation')
    if (response.status !== 'accepted' || response.value.statusCode !== 200) {
      throw new Error('Original wallet validation unavailable')
    }
    const wallet = JSON.parse(response.value.body) as ExpectedWallet
    if (
      wallet.instanceId !== binding.instanceId || typeof wallet.accountId !== 'string'
      || (expected && (wallet.instanceId !== expected.instanceId || wallet.accountId !== expected.accountId))
    ) throw new Error('Restore original canonical account before local enrollment')
    const enrolled = await http.enrollLocalWallet({
      binding: { ...binding, audience: 'local-wallet-enrollment' },
      connection,
    })
    if (!current()) throw new Error('Wallet owner retired during local enrollment')
    if (enrolled.status !== 'accepted' || enrolled.value.statusCode !== 200) {
      throw new Error('Local wallet enrollment unavailable')
    }
    const local = await http.connectLocalAccount(localBinding)
    if (local.status === 'accepted') localConnection = local.value.connection
    if (!current()) throw new Error('Wallet owner retired during local account open')
    await http.revoke(connection)
    nativeReleased = true
    if (!current()) throw new Error('Wallet owner retired while releasing enrollment authority')
    localConnection = undefined
    return local
  } finally {
    const cleanup = [...(!nativeReleased ? [connection] : []), ...(localConnection ? [localConnection] : [])]
    await Promise.allSettled(cleanup.map(target => Promise.resolve().then(() => http.revoke(target))))
  }
}
