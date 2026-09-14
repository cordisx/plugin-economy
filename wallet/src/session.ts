import { EconomyClient, EconomyClientError } from '@cordisx/economy/client'
import type { HttpClientV1, HttpConnectionV1 } from '@cordisx/protocol/plugin-http/v1'
import type { HttpClientV3, ManagedSourceBindingV1 } from '@cordisx/protocol/plugin-http/v3'
import type { HttpClientV4 } from '@cordisx/protocol/plugin-http/v4'
import { authorizeLocalWallet } from './local-authorization.js'
export type WalletHttp = Omit<HttpClientV1, 'contract'> & {
  readonly contract:
    | 'cordisx.http-client/v1'
    | 'cordisx.http-client/v2'
    | 'cordisx.http-client/v3'
    | 'cordisx.http-client/v4'
}
/** Owns only opaque Host connection references. No bearer value enters this module. */
export class WalletSession {
  private closed = false
  private generation = 0
  private connection?: HttpConnectionV1
  private lifetime = new AbortController()
  private readonly listeners = new Set<() => void>()
  client?: EconomyClient
  get origin(): string | undefined {
    return this.connection?.origin
  }
  get defaultOrigin(): string {
    return 'http://127.0.0.1:8788'
  }
  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch { /* Page observers cannot alter connection lifetime. */ }
    }
  }
  constructor(private readonly http: WalletHttp | undefined) {}
  get localAuthorityAvailable(): boolean {
    return !this.closed && this.http?.contract === 'cordisx.http-client/v4'
  }
  get available() {
    return !this.closed && !!this.http
      && ['cordisx.http-client/v1', 'cordisx.http-client/v2', 'cordisx.http-client/v3', 'cordisx.http-client/v4']
        .includes(this.http.contract)
  }
  async connect(
    origin: string,
    managed?: ManagedSourceBindingV1,
    local?: { expected?: { instanceId: string; accountId: string }; allowEnrollment?: boolean },
  ) {
    if (this.closed) throw new Error('Wallet was closed')
    if (!this.http) throw new Error('Host HTTP authorization is unavailable')
    const url = new URL(origin)
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Enter the economy origin without a path')
    // Validate protocol before opening Host consent.
    new EconomyClient(origin, async () => {
      throw new Error('Not connected')
    })
    const generation = ++this.generation
    await this.release()
    const current = () => !this.closed && generation === this.generation
    if (!current()) throw new Error('Wallet was closed')
    if (managed && !['cordisx.http-client/v3', 'cordisx.http-client/v4'].includes(this.http.contract)) {
      throw new Error('Managed local login requires Host HTTP v3')
    }
    const authorization = local && managed && this.http.contract === 'cordisx.http-client/v4'
      ? await authorizeLocalWallet(this.http as HttpClientV4, managed, local.expected, current, local.allowEnrollment)
      : managed
      ? await (this.http as HttpClientV3).connectAccount(managed)
      : await this.http.authorize({ origin: url.origin, credential: 'bearer' })
    if (authorization.status !== 'accepted') throw new Error(`Host authorization: ${authorization.code}`)
    const connection = 'connection' in authorization.value ? authorization.value.connection : authorization.value
    if (!current() || this.lifetime.signal.aborted) {
      await this.http.revoke(connection)
      throw new Error('Wallet was closed')
    }
    if (
      connection.contract !== 'cordisx.http-connection/v1' || connection.origin !== url.origin
      || connection.credential !== 'bearer'
    ) {
      await this.http.revoke(connection)
      throw new Error('Wallet authorization scope mismatch')
    }
    this.connection = connection
    const signal = this.lifetime.signal
    this.client = new EconomyClient(origin, async request => {
      const target = new URL(request.url)
      if (target.origin !== connection.origin) throw new Error('Economy origin changed')
      const result = await this.http!.request({
        connection,
        path: target.pathname,
        method: request.method as 'GET' | 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(request.headers['Idempotency-Key'] ? { 'idempotency-key': request.headers['Idempotency-Key'] } : {}),
        },
        body: request.body,
        deadline: Date.now() + 10_000,
        signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
      })
      if (result.status !== 'accepted') {
        throw new EconomyClientError(
          result.code,
          `Host request: ${result.code}`,
          0,
          ['network-error', 'deadline-exceeded'].includes(result.code),
        )
      }
      return { status: result.value.statusCode, body: result.value.body }
    })
    try {
      const wallet = await this.client.me()
      if (!current()) throw new Error('Wallet was closed')
      if (
        local?.expected
        && (wallet.instanceId !== local.expected.instanceId || wallet.accountId !== local.expected.accountId)
      ) throw new Error('Restore original canonical account; wallet binding preserved')
      this.notify()
      return wallet
    } catch (error) {
      if (current()) {
        this.generation++
        await this.release()
      }
      throw error
    }
  }
  async disconnect() {
    this.generation++
    await this.release()
  }
  private async release() {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.client = undefined
    this.notify()
    const previous = this.connection
    this.connection = undefined
    if (previous && this.http) await this.http.revoke(previous)
  }
  dispose() {
    this.closed = true
    this.generation++
    this.lifetime.abort()
    const previous = this.connection
    this.connection = undefined
    this.client = undefined
    this.notify()
    this.listeners.clear()
    if (previous && this.http) void this.http.revoke(previous)
  }
}
