import { createServer, type IncomingMessage } from 'node:http'
import { Economy } from './economy.js'
import { EconomyError, requireCondition } from './errors.js'
import type { LocalWalletIncome } from './local-wallet-income.js'
import type { ManagedWorkIncome } from './managed-work.js'
const MAX_BODY = 256 * 1024
async function readBody(request: IncomingMessage) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new EconomyError('BODY_TOO_LARGE', 'Request exceeds 256 KiB', 413)
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new EconomyError('INVALID_JSON', 'Malformed JSON')
  }
}
/** Bearer-only API: no cookies, credentialed CORS, query credentials, or browser localStorage. */
export function createEconomyServer(
  economy: Economy,
  options: {
    allowedOrigins?: string[]
    workIncome?: ManagedWorkIncome
    sourceAccount?: ManagedWorkIncome
    localWallets?: LocalWalletIncome[]
  } = {},
) {
  const localWallets = options.localWallets ?? []
  requireCondition(
    localWallets.length <= 3 && new Set(localWallets.map(local => local.binding.audience)).size === localWallets.length,
    'INVALID_TRUST',
    'At most one local trust per audience',
  )
  const target = options.sourceAccount ?? options.workIncome ?? localWallets[0]
  requireCondition(
    localWallets.every(local =>
      local.binding.origin === target!.binding.origin && local.binding.instanceId === target!.binding.instanceId
    ),
    'INVALID_TRUST',
    'Local authority must use the same canonical wallet realm',
  )
  const allowed = new Set(options.allowedOrigins ?? [])
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Vary', 'Origin')
    try {
      const origin = request.headers.origin
      if (origin && !allowed.has(origin)) throw new EconomyError('ORIGIN_DENIED', 'Origin is not allowed', 403)
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        response.writeHead(204)
        response.end()
        return
      }
      const path = request.url ?? ''
      if (path === '/healthz' && request.method === 'GET') {
        response.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (
        (options.workIncome || options.sourceAccount || options.localWallets?.length) && request.method === 'GET'
        && path.startsWith('/v1/auth/host/challenge?')
      ) {
        const url = new URL(
          path,
          (options.workIncome || options.sourceAccount || options.localWallets![0])!.binding.origin,
        )
        const audience = url.searchParams.get('audience')
        const source = audience === 'source-account'
          ? options.sourceAccount
          : audience === 'work-income'
          ? options.workIncome
          : options.localWallets?.find(local => local.binding.audience === audience)
        if (!source) throw new EconomyError('FORBIDDEN', 'Managed audience not provisioned', 403)
        if (url.hash) throw new EconomyError('INVALID_URL', 'Fragment is not supported')
        response.end(JSON.stringify(source.challenge(url.searchParams)))
        return
      }
      if (path.includes('?') || path.includes('#')) {
        throw new EconomyError('INVALID_URL', 'Query credentials and parameters are not supported')
      }
      if (request.method === 'POST' && ['/v1/income/work', '/v1/income/history-declaration'].includes(path)) {
        throw new EconomyError(
          'ENTRY_RETIRED',
          'Historical income mutation retired; actual usage uses the canonical private settlement path',
          410,
        )
      }
      const authorization = request.headers.authorization
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
      const body = request.method === 'POST' ? await readBody(request) : undefined
      if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) {
        throw new EconomyError('CONTENT_TYPE', 'Content-Type must be application/json', 415)
      }
      const contract = (body as { payload?: { contract?: unknown } } | undefined)?.payload?.contract
      const localAudience = contract === 'cordisx.local-wallet-assertion/v1'
        ? 'local-wallet'
        : ['cordisx.local-work-observation/v1', 'cordisx.local-work-settlement/v1'].includes(String(contract))
        ? 'local-work-income'
        : contract === 'cordisx.local-wallet-enrollment/v1'
        ? 'local-wallet-enrollment'
        : undefined
      if (localAudience && request.method === 'POST') {
        const local = options.localWallets?.find(candidate => candidate.binding.audience === localAudience)
        if (!local) throw new EconomyError('FORBIDDEN', 'Local wallet audience not provisioned', 403)
        if (path === '/v1/auth/host/local-wallet/enroll' && localAudience === 'local-wallet-enrollment') {
          response.end(JSON.stringify(local.enroll(body, token)))
          return
        }
        if (path === '/v1/auth/host/session' && localAudience === 'local-wallet') {
          response.end(JSON.stringify(local.session(body)))
          return
        }
        if (path === '/v1/income/work/settle' && localAudience === 'local-work-income') {
          response.end(JSON.stringify(local.settle(body)))
          return
        }
        if (path === '/v1/income/work' && localAudience === 'local-work-income') {
          response.end(JSON.stringify(local.submit(body)))
          return
        }
        throw new EconomyError('FORBIDDEN', 'Local assertion route differs', 403)
      }
      if (options.sourceAccount && request.method === 'POST' && path === '/v1/auth/host/session') {
        response.end(JSON.stringify(options.sourceAccount.session(body)))
        return
      }
      const key = request.headers['idempotency-key']
      const result = economy.request(request.method ?? '', path, token, body, typeof key === 'string' ? key : undefined)
      response.end(JSON.stringify(result))
    } catch (error) {
      const known = error instanceof EconomyError
      response.statusCode = known ? error.status : 500
      if (known && error.retryable) response.setHeader('Retry-After', '1')
      response.end(
        JSON.stringify({
          error: {
            code: known ? error.code : 'INTERNAL',
            message: known ? error.message : 'Internal transaction failure',
            retryable: known ? error.retryable : true,
          },
        }),
      )
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 30
  return server
}
