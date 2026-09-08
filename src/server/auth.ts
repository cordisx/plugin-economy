import { randomBytes } from 'node:crypto'
import type { Principal } from '../client/contracts.js'
import { hash, Store } from './database.js'
import { integer, requireCondition, textId } from './errors.js'
export const secret = () => randomBytes(32).toString('base64url')
export class Auth {
  constructor(readonly store: Store, readonly now = Date.now) {}
  authenticate(token: string | undefined): Principal {
    requireCondition(
      token && token.length <= 256,
      'UNAUTHORIZED',
      'A valid bearer session or service credential is required',
      401,
    )
    const row = this.store.one<{ instance: string; subject: string; kind: 'user' | 'service'; expires: number }>(
      'SELECT instance,subject,kind,expires FROM credentials WHERE hash=? AND revoked=0',
      hash(token),
    )
    requireCondition(row && row.expires > this.now(), 'UNAUTHORIZED', 'Credential expired, revoked, or unknown', 401)
    return { instanceId: row.instance, subject: row.subject, kind: row.kind }
  }
  /** CLI/operator boundary. Never expose these provisioning methods as HTTP routes. */
  createInstance(id: string, supply: number) {
    textId(id, 'instance')
    integer(supply, 'supply', 1)
    this.store.transaction(() => {
      requireCondition(
        !this.store.one('SELECT id FROM instances WHERE id=?', id),
        'ALREADY_EXISTS',
        'Instance already exists',
        409,
      )
      this.store.run('INSERT INTO instances VALUES(?,?)', id, supply)
      this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', id, '$issuer', 'system')
      this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', id, '$shop', 'system')
      this.store.move(id, '$issuer', supply, 0, 'genesis', id, this.now(), 'genesis')
      this.store.assertConservation(id)
    })
  }
  createAccount(instance: string, id: string) {
    textId(id, 'account')
    this.store.run('INSERT INTO accounts VALUES(?,?,?,0,0)', instance, id, 'user')
  }
  enrollment(instance: string, account: string): string {
    requireCondition(
      this.store.one('SELECT id FROM accounts WHERE instance=? AND id=? AND kind=?', instance, account, 'user'),
      'NOT_FOUND',
      'User account not found',
      404,
    )
    const code = secret()
    this.store.run('INSERT INTO enrollments VALUES(?,?,?,?,0)', hash(code), instance, account, this.now() + 600_000)
    return code
  }
  login(code: string) {
    requireCondition(typeof code === 'string' && code.length <= 256, 'UNAUTHORIZED', 'Invalid enrollment code', 401)
    return this.store.transaction(() => {
      const row = this.store.one<{ instance: string; account: string }>(
        'SELECT instance,account FROM enrollments WHERE hash=? AND consumed=0 AND expires>?',
        hash(code),
        this.now(),
      )
      requireCondition(row, 'UNAUTHORIZED', 'Enrollment code expired or consumed', 401)
      this.store.run('UPDATE enrollments SET consumed=1 WHERE hash=?', hash(code))
      return this.issue(row.instance, row.account, 'user', 3_600_000)
    })
  }
  issue(instance: string, subject: string, kind: 'user' | 'service', ttl: number) {
    const token = secret(), expiresAt = this.now() + ttl
    this.store.run('INSERT INTO credentials VALUES(?,?,?,?,?,0)', hash(token), instance, subject, kind, expiresAt)
    return { token, expiresAt, instanceId: instance, accountId: kind === 'user' ? subject : undefined }
  }
  rotate(token: string) {
    return this.store.transaction(() => {
      const actor = this.authenticate(token)
      requireCondition(actor.kind === 'user', 'FORBIDDEN', 'Only user sessions rotate here', 403)
      this.revoke(token)
      return this.issue(actor.instanceId, actor.subject, 'user', 3_600_000)
    })
  }
  revoke(token: string) {
    this.store.run('UPDATE credentials SET revoked=1 WHERE hash=?', hash(token))
  }
  createService(instance: string, id: string, game: string, maxStake: number) {
    textId(id, 'service')
    if (game !== '*') textId(game, 'game')
    integer(maxStake, 'maxStake', 1)
    return this.store.transaction(() => {
      this.store.run('INSERT INTO services VALUES(?,?,?,?)', instance, id, game, maxStake)
      return this.issue(instance, id, 'service', 30 * 86_400_000)
    })
  }
}
