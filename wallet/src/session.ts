import { EconomyClient, EconomyClientError } from '@cordisx/economy/client'
import type { HttpClientV1, HttpConnectionV1 } from '@cordisx/protocol/plugin-http/v1'
/** Owns only opaque Host connection references. No bearer value enters this module. */
export class WalletSession {
  private connection?: HttpConnectionV1
  private lifetime = new AbortController()
  client?: EconomyClient
  constructor(private readonly http: HttpClientV1 | undefined) {}
  get available() {
    return this.http?.contract === 'cordisx.http-client/v1'
  }
  async connect(origin: string) {
    if (!this.http) throw new Error('Host HTTP authorization is unavailable')
    const url = new URL(origin)
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Enter the economy origin without a path')
    // Validate protocol before opening Host consent.
    new EconomyClient(origin, async () => {
      throw new Error('Not connected')
    })
    await this.disconnect()
    const authorization = await this.http.authorize({ origin: url.origin, credential: 'bearer' })
    if (authorization.status !== 'accepted') throw new Error(`Host authorization: ${authorization.code}`)
    const connection = authorization.value
    if (this.lifetime.signal.aborted) {
      await this.http.revoke(connection)
      throw new Error('Wallet was closed')
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
      return await this.client.me()
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }
  async disconnect() {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.client = undefined
    const previous = this.connection
    this.connection = undefined
    if (previous && this.http) await this.http.revoke(previous)
  }
  dispose() {
    this.lifetime.abort()
    const previous = this.connection
    this.connection = undefined
    this.client = undefined
    if (previous && this.http) void this.http.revoke(previous)
  }
}
