import { Economy } from '@cordisx/economy/server'
import { localWalletBytes } from '@cordisx/protocol/local-wallet/v1'
import { managedSourceBytes } from '@cordisx/protocol/managed-source/v1'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { generateKeyPairSync, sign } from 'node:crypto'
import { LocalWalletIncome } from '../../dist/server/local-wallet-income.js'
import { ManagedWorkIncome } from '../../dist/server/managed-work.js'
import { CanonicalWalletSession } from '../.cache/test-runtime/local-wallet.js'
export const origin = 'http://127.0.0.1:8788'
export const drain = () => new Promise(resolve => setTimeout(resolve, 35))
export function workIncomeFixture(t, localMode = false, durableMode = false) {
  const e = new Economy(':memory:')
  const host = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519')
  const binding = audience => ({ origin, instanceId: 'local', sourceId: 'economy-local', audience })
  const services = Object.fromEntries(
    ['source-account', 'work-income'].map(
      audience => [
        audience,
        new ManagedWorkIncome(e.store, {
          binding: binding(audience),
          hostPublicKey: host.publicKey.export({ type: 'spki', format: 'pem' }),
          serverPrivateKey: server.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        }),
      ],
    ),
  )
  let tokens = 0, proofPresent = true, proofReady = true, revoked = 0, submitted = [], manual = 0
  const retirementListeners = new Set()
  const usageListeners = new Set()
  const records = new Map(), connections = new Map(), owners = []
  t.after(() => {
    owners.forEach(s => s.dispose())
    e.close()
  })
  let currentScope = 'work-scope', currentEpoch = 'epoch-1'
  const snapshot = () => ({
    schemaVersion: 2,
    status: 'ready',
    policyId: 'codex-local-work-input-output-v2',
    coverage: 'partial',
    enabledAt: 1,
    inputTokens: tokens,
    outputTokens: 0,
    eligibleTokens: tokens,
    scopeId: currentScope,
    sourceId: 'codex-local',
    epoch: currentEpoch,
    revision: tokens,
    observedThrough: tokens,
    classification: {
      version: 'host-game-cwd-v1',
      hostGameTasks: 'excluded',
      forksAndSubagents: 'excluded',
      unknownSources: 'excluded',
    },
  })
  const signed = (audience, extra) => {
    const challenge = services[audience].challenge(
      new URLSearchParams({ sourceId: 'economy-local', instanceId: 'local', audience }),
    )
    const payload = {
      ...challenge.payload,
      contract: audience === 'work-income'
        ? 'cordisx.managed-work-observation/v1'
        : 'cordisx.managed-source-assertion/v1',
      subject: `codex:${'a'.repeat(43)}`,
      ...extra,
    }
    return { payload, signature: sign(null, managedSourceBytes(payload), host.privateKey).toString('base64url') }
  }
  const producer = {
    status: 'ready',
    disabled: true,
    originalRecord: 'present',
    scopeId: 'work-scope',
    producerContract: 'pet-work-observer-disabled/v1',
  }
  const proof = {
    generationId: 'pet-generation',
    isActive: () => proofPresent,
    currentProducer: async () => ({ ...producer, producerGenerationId: proof.generationId }),
    subscribeInvalidation: listener => {
      retirementListeners.add(listener)
      return () => retirementListeners.delete(listener)
    },
    contract: 'economy.legacy-work-retirement/v1',
    retirement: async () => ({
      status: proofReady ? 'ready' : 'unavailable',
      pending: !proofReady,
      scopeId: 'work-scope',
      producerGenerationId: proof.generationId,
      documentSchemaVersion: 2,
      documentRevision: 1,
      producerContract: 'pet-work-observer-disabled/v1',
    }),
  }
  const http = {
    contract: 'cordisx.http-client/v3',
    authorize: async () => {
      manual++
      throw Error('No manual budget authorization')
    },
    connectAccount: async input => {
      assert.equal(input.audience, 'source-account')
      const result = services['source-account'].session(signed('source-account', {})).payload.result
      const connection = {
        contract: 'cordisx.http-connection/v1',
        origin,
        credential: 'bearer',
        id: crypto.randomUUID(),
      }
      connections.set(connection.id, result.sessionToken)
      const { sessionToken, ...safe } = result
      return { status: 'accepted', value: { connection, response: { statusCode: 200, body: JSON.stringify(safe) } } }
    },
    submitWorkUsage: async input => {
      assert.deepEqual(
        Object.keys(input).sort(),
        (input.baseline
          ? ['audience', 'baseline', 'instanceId', 'origin', 'sourceId']
          : ['audience', 'instanceId', 'origin', 'sourceId']).sort(),
      )
      submitted.push(input)
      const result = services['work-income'].submit(
        signed('work-income', {
          snapshot: snapshot(),
          leaseId: 'l'.repeat(43),
          continuity: input.baseline ? 'baseline' : 'continuous',
        }),
      ).payload.result
      return { status: 'accepted', value: { statusCode: 200, body: JSON.stringify(result) } }
    },
    revoke: async connection => {
      revoked++
      connections.delete(connection.id)
    },
    request: async request => {
      if (request.path === '/v1/income/history-declaration') {
        const actor = e.auth.authenticate(connections.get(request.connection.id))
        const value = services['work-income'].issuer.history.apply(
          actor.instanceId,
          actor.subject,
          JSON.parse(request.body),
        )
        return { status: 'accepted', value: { statusCode: 200, body: JSON.stringify(value) } }
      }
      const body = e.request(
        request.method,
        request.path,
        connections.get(request.connection.id),
        request.body ? JSON.parse(request.body) : undefined,
        request.headers['idempotency-key'],
      )
      return { status: 'accepted', value: { statusCode: 200, body: JSON.stringify(body) } }
    },
  }
  let settlement, loseSettlementResponse = false
  let nativeOpens = 0
  if (localMode) {
    const key = generateKeyPairSync('ed25519'), bytes = key.publicKey.export({ type: 'spki', format: 'der' })
    const subject = 'host-local:' + createHash('sha256').update(bytes).digest('base64url')
    const controllers = Object.fromEntries(
      ['local-wallet-enrollment', 'local-wallet', 'local-work-income'].map(
        audience => [
          audience,
          new LocalWalletIncome(e.store, {
            binding: binding(audience === 'local-work-income' ? 'work-income' : 'source-account'),
            hostPublicKey: host.publicKey.export({ type: 'spki', format: 'pem' }),
            serverPrivateKey: server.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          }, audience),
        ],
      ),
    )
    let enrolled = false
    const localSigned = (audience, contract, extra = {}) => {
      const challenge = controllers[audience].challenge(
        new URLSearchParams({ sourceId: 'economy-local', instanceId: 'local', audience }),
      )
      const payload = { ...challenge.payload, contract, subject, ...extra }
      return {
        payload,
        signature: sign(
          null,
          localWalletBytes(payload),
          audience === 'local-wallet-enrollment' ? host.privateKey : key.privateKey,
        ).toString('base64url'),
      }
    }
    const original = http.connectAccount
    http.contract = 'cordisx.http-client/v4'
    http.connectAccount = async input => {
      nativeOpens++
      return original(input)
    }
    http.connectLocalAccount = async input => {
      assert.equal(input.audience, 'local-wallet')
      if (!enrolled) return { status: 'unavailable', code: 'local-wallet-not-enrolled' }
      const result =
        controllers['local-wallet'].session(localSigned('local-wallet', 'cordisx.local-wallet-assertion/v1')).payload
          .result
      const connection = {
        contract: 'cordisx.http-connection/v1',
        origin,
        credential: 'bearer',
        id: crypto.randomUUID(),
      }
      connections.set(connection.id, result.sessionToken)
      const { sessionToken, ...safe } = result
      return { status: 'accepted', value: { connection, response: { statusCode: 200, body: JSON.stringify(safe) } } }
    }
    http.enrollLocalWallet = async input => {
      assert.equal(input.binding.audience, 'local-wallet-enrollment')
      const result = controllers['local-wallet-enrollment'].enroll(
        localSigned('local-wallet-enrollment', 'cordisx.local-wallet-enrollment/v1', {
          nativeSubject: 'codex:' + 'a'.repeat(43),
          publicKey: bytes.toString('base64'),
        }),
        connections.get(input.connection.id),
      ).payload.result
      assert.equal(result.enrolled, true)
      enrolled = true
      return { status: 'accepted', value: { statusCode: 200, body: JSON.stringify(result) } }
    }
    http.submitLocalWorkUsage = async input => {
      assert.equal(input.audience, 'local-work-income')
      assert.equal('snapshot' in input || 'amount' in input || 'accountId' in input, false)
      submitted.push(input)
      const result = controllers['local-work-income'].submit(
        localSigned('local-work-income', 'cordisx.local-work-observation/v1', {
          snapshot: snapshot(),
          leaseId: 'l'.repeat(43),
          continuity: input.baseline ? 'baseline' : 'continuous',
        }),
      ).payload.result
      return { status: 'accepted', value: { statusCode: 200, body: JSON.stringify(result) } }
    }
    if (durableMode) {
      settlement = {
        contract: 'cordisx.local-work-settlement/v1',
        settle: async input => {
          assert.deepEqual(Object.keys(input).sort(), ['audience', 'instanceId', 'origin', 'sourceId'])
          assert.equal(input.audience, 'local-work-income')
          submitted.push(input)
          const result = controllers['local-work-income'].settle(
            localSigned('local-work-income', 'cordisx.local-work-settlement/v1', { snapshot: snapshot() }),
          ).payload.result
          if (loseSettlementResponse) {
            loseSettlementResponse = false
            return { status: 'unavailable', code: 'host-unavailable' }
          }
          return { status: 'accepted', value: { statusCode: 200, body: JSON.stringify(result) } }
        },
      }
    }
    http.submitWorkUsage = async () => {
      throw Error('v4 must use local work authority')
    }
  }
  const documents = {
    load: async id =>
      records.has(id) ? { status: 'loaded', snapshot: structuredClone(records.get(id)) } : { status: 'missing' },
    transaction: async r => {
      const old = records.get(r.documentId)
      if ((old?.revision || 0) !== r.expectedRevision) return { status: 'conflict' }
      records.set(r.documentId, { revision: r.expectedRevision + 1, value: structuredClone(r.value) })
      return { status: 'accepted' }
    },
  }
  const usage = {
    readWork: async () => snapshot(),
    subscribe: listener => {
      usageListeners.add(listener)
      return () => {
        usageListeners.delete(listener)
      }
    },
  }
  let currentProof = proof
  const ctx = {
    get: name =>
      name === 'http'
        ? http
        : name === 'usage'
        ? usage
        : name === 'workSettlement'
        ? settlement
        : name === 'petWorkRetirement' && proofPresent
        ? currentProof
        : undefined,
    documents,
  }
  return {
    e,
    ctx,
    http,
    documents,
    issuer: services['work-income'].issuer,
    records,
    submitted,
    proof,
    producer,
    show: () => {
      proofPresent = true
    },
    replace: next => {
      currentProof = next
    },
    owner: config => {
      const s = new CanonicalWalletSession(ctx, config || {})
      owners.push(s)
      return s
    },
    moveScope: (scope, epoch) => {
      currentScope = scope
      currentEpoch = epoch
    },
    change: value => {
      tokens = value
      usageListeners.forEach(listener => listener())
    },
    retire: () => {
      proofPresent = false
      retirementListeners.forEach(listener => listener())
    },
    pending: value => {
      proofReady = !value
    },
    loseSettlementResponse: () => {
      loseSettlementResponse = true
    },
    nativeOpens: () => nativeOpens,
    manual: () => manual,
    revoked: () => revoked,
  }
}
