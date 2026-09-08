export * from './contracts.js'
import type {
  Agreement,
  AgreementInput,
  ApiErrorBody,
  CancelInput,
  GrantInput,
  Item,
  LedgerEntry,
  Order,
  PurchaseInput,
  ReserveInput,
  SettleInput,
  Wallet,
} from './contracts.js'
export type Transport = (
  request: { method: string; url: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; body: string }>
export class EconomyClientError extends Error {
  constructor(public code: string, message: string, public status: number, public retryable: boolean) {
    super(message)
  }
}
/** Supply a Host public transport + secret reference in renderer contexts. Never persist bearer tokens in config. */
export class EconomyClient {
  readonly baseUrl: string
  constructor(baseUrl: string, readonly transport: Transport) {
    const url = new URL(baseUrl)
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Invalid economy base URL')
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('HTTPS is required outside loopback')
    }
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1`
  }
  async request<T>(method: string, path: string, body?: unknown, key?: string, signal?: AbortSignal): Promise<T> {
    const result = await this.transport({
      method,
      url: this.baseUrl + path,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(result.body)
    } catch {
      throw new EconomyClientError(
        'INVALID_RESPONSE',
        'Economy returned invalid JSON',
        result.status,
        result.status >= 500,
      )
    }
    if (result.status < 200 || result.status >= 300) {
      const error = (parsed as ApiErrorBody).error
      throw new EconomyClientError(
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? 'Economy request failed',
        result.status,
        error?.retryable ?? false,
      )
    }
    return parsed as T
  }
  me(signal?: AbortSignal) {
    return this.request<Wallet>('GET', '/me', undefined, undefined, signal)
  }
  ledger(signal?: AbortSignal) {
    return this.request<LedgerEntry[]>('GET', '/ledger', undefined, undefined, signal)
  }
  items(signal?: AbortSignal) {
    return this.request<Item[]>('GET', '/items', undefined, undefined, signal)
  }
  inventory() {
    return this.request<{ itemId: string; quantity: number }[]>('GET', '/inventory')
  }
  orders() {
    return this.request<Order[]>('GET', '/orders')
  }
  order(id: string) {
    return this.request<Order>('GET', `/orders/${encodeURIComponent(id)}`)
  }
  purchase(body: PurchaseInput, key: string) {
    return this.request<Order>('POST', '/orders', body, key)
  }
  createAgreement(body: AgreementInput, key: string) {
    return this.request<Agreement>('POST', '/agreements', body, key)
  }
  agreement(id: string, signal?: AbortSignal) {
    return this.request<Agreement>('GET', `/agreements/${encodeURIComponent(id)}`, undefined, undefined, signal)
  }
  reserve(body: ReserveInput, key: string) {
    return this.request<Agreement>('POST', '/reserve', body, key)
  }
  settle(body: SettleInput, key: string) {
    return this.request<Agreement>('POST', '/settle', body, key)
  }
  cancel(body: CancelInput, key: string) {
    return this.request<Agreement>('POST', '/cancel', body, key)
  }
  linkProof(body: { gameServiceId: string; gameAccountId: string }, key: string) {
    return this.request<{ code: string; expiresAt: number }>('POST', '/link-proofs', body, key)
  }
  redeemLinkProof(body: { code: string; gameAccountId: string }, key: string) {
    return this.request<{ instanceId: string; accountId: string; gameServiceId: string; gameAccountId: string }>(
      'POST',
      '/link-proofs/redeem',
      body,
      key,
    )
  }
  grant(body: GrantInput, key: string) {
    return this.request<{ sourceId: string; eventId: string; amount: number }>('POST', '/rewards/grant', body, key)
  }
  claim(body: { sourceId: string; entitlementId: string }, key: string) {
    return this.request<
      { instanceId: string; accountId: string; sourceId: string; entitlementId: string; amount: number }
    >(
      'POST',
      '/migrations/claim',
      body,
      key,
    )
  }
}
/** Server/CLI only; inject fetch and credential provider. No implicit retries of money mutations. */
export function bearerTransport(fetcher: typeof fetch, token: () => string): Transport {
  return async request => {
    const response = await fetcher(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${token()}` },
      body: request.body,
      signal: request.signal,
      redirect: 'error',
      credentials: 'omit',
    })
    return { status: response.status, body: await response.text() }
  }
}
