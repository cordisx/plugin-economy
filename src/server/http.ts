import { createServer, type IncomingMessage } from 'node:http'
import { Economy } from './economy.js'
import { EconomyError } from './errors.js'
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
export function createEconomyServer(economy: Economy, options: { allowedOrigins?: string[] } = {}) {
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
      if (path.includes('?') || path.includes('#')) {
        throw new EconomyError('INVALID_URL', 'Query credentials and parameters are not supported')
      }
      const authorization = request.headers.authorization
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
      const body = request.method === 'POST' ? await readBody(request) : undefined
      if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) {
        throw new EconomyError('CONTENT_TYPE', 'Content-Type must be application/json', 415)
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
