import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { EconomyError, requireCondition } from './errors.js'

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${
    Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')
  }}`
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class Store {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    requireCondition(version <= 2, 'SCHEMA_TOO_NEW', 'Database was created by a newer economy service', 500)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, supply INTEGER NOT NULL CHECK(supply>=0));
      CREATE TABLE IF NOT EXISTS accounts(instance TEXT NOT NULL REFERENCES instances(id), id TEXT NOT NULL, kind TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 0 CHECK(available>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0), PRIMARY KEY(instance,id));
      CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY, instance TEXT NOT NULL, subject TEXT NOT NULL,
        kind TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY, instance TEXT NOT NULL, account TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS services(instance TEXT NOT NULL, id TEXT NOT NULL, game TEXT NOT NULL, maxStake INTEGER NOT NULL, PRIMARY KEY(instance,id));
      CREATE TABLE IF NOT EXISTS agreements(instance TEXT NOT NULL, id TEXT NOT NULL, service TEXT NOT NULL, match TEXT NOT NULL,
        body TEXT NOT NULL, termsHash TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT, PRIMARY KEY(instance,id), UNIQUE(instance,service,match));
      CREATE TABLE IF NOT EXISTS reservations(instance TEXT NOT NULL, agreement TEXT NOT NULL, account TEXT NOT NULL, PRIMARY KEY(instance,agreement,account));
      CREATE TABLE IF NOT EXISTS ledger(sequence INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, transactionId TEXT NOT NULL,
        account TEXT NOT NULL, availableDelta INTEGER NOT NULL, reservedDelta INTEGER NOT NULL, reason TEXT NOT NULL, reference TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'append-only ledger'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'append-only ledger'); END;
      CREATE TABLE IF NOT EXISTS idempotency(instance TEXT NOT NULL, actor TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(instance,actor,key));
      CREATE TABLE IF NOT EXISTS sources(instance TEXT NOT NULL, id TEXT NOT NULL, service TEXT NOT NULL, kind TEXT NOT NULL,
        daily INTEGER NOT NULL, accountDaily INTEGER NOT NULL, PRIMARY KEY(instance,id));
      CREATE TABLE IF NOT EXISTS grants(instance TEXT NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL, account TEXT NOT NULL, amount INTEGER NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(instance,source,event));
      CREATE TABLE IF NOT EXISTS entitlements(instance TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL, account TEXT NOT NULL, amount INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(instance,source,id));
      CREATE TABLE IF NOT EXISTS linkProofs(hash TEXT PRIMARY KEY, instance TEXT NOT NULL, account TEXT NOT NULL, service TEXT NOT NULL, gameAccount TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS items(instance TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, price INTEGER NOT NULL, namespace TEXT NOT NULL, PRIMARY KEY(instance,id));
      CREATE TABLE IF NOT EXISTS orders(instance TEXT NOT NULL, id TEXT NOT NULL, account TEXT NOT NULL, item TEXT NOT NULL, quantity INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(instance,id));
      CREATE TABLE IF NOT EXISTS inventory(instance TEXT NOT NULL, account TEXT NOT NULL, item TEXT NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(instance,account,item));
      `)
    this.transaction(() => {
      if (
        !this.all<{ name: string }>('PRAGMA table_info(orders)').some(column => column.name === 'fulfillmentTarget')
      ) this.db.exec('ALTER TABLE orders ADD COLUMN fulfillmentTarget TEXT')
      this.db.exec('PRAGMA user_version=2')
    })
  }
  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    const row = this.db.prepare(sql).get(...args)
    return row ? { ...row } as T : undefined
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args).map(row => ({ ...row })) as T[]
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args)
  }
  transaction<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      if (error instanceof Error && /database is (locked|busy)/.test(error.message)) {
        throw new EconomyError('BUSY', 'Retry the same idempotency key', 503, true)
      }
      throw error
    }
  }
  idempotent<T>(instance: string, actor: string, key: string, operation: string, input: unknown, fn: () => T): T {
    requireCondition(
      typeof key === 'string' && /^[\x21-\x7e]{8,128}$/.test(key),
      'IDEMPOTENCY_REQUIRED',
      'Idempotency-Key must contain 8–128 printable ASCII characters',
    )
    return this.transaction(() => {
      const fingerprint = hash(canonical({ operation, input }))
      const previous = this.one<{ fingerprint: string; response: string }>(
        'SELECT fingerprint,response FROM idempotency WHERE instance=? AND actor=? AND key=?',
        instance,
        actor,
        key,
      )
      if (previous) {
        requireCondition(
          previous.fingerprint === fingerprint,
          'IDEMPOTENCY_CONFLICT',
          'Key was used for a different request',
          409,
        )
        return JSON.parse(previous.response) as T
      }
      const result = fn()
      this.assertConservation(instance)
      this.run('INSERT INTO idempotency VALUES(?,?,?,?,?)', instance, actor, key, fingerprint, JSON.stringify(result))
      return result
    })
  }
  move(
    instance: string,
    account: string,
    available: number,
    reserved: number,
    reason: string,
    reference: string,
    now: number,
    transactionId: string,
  ) {
    const result = this.run(
      'UPDATE accounts SET available=available+?,reserved=reserved+? WHERE instance=? AND id=? AND available+?>=0 AND reserved+?>=0',
      available,
      reserved,
      instance,
      account,
      available,
      reserved,
    )
    requireCondition(
      result.changes === 1,
      'INSUFFICIENT_FUNDS',
      'Account missing or insufficient available/reserved Token',
      409,
    )
    this.run(
      'INSERT INTO ledger(instance,transactionId,account,availableDelta,reservedDelta,reason,reference,createdAt) VALUES(?,?,?,?,?,?,?,?)',
      instance,
      transactionId,
      account,
      available,
      reserved,
      reason,
      reference,
      now,
    )
  }
  transfer(instance: string, from: string, to: string, amount: number, reason: string, reference: string, now: number) {
    const tx = randomUUID()
    this.move(instance, from, -amount, 0, reason, reference, now, tx)
    this.move(instance, to, amount, 0, reason, reference, now, tx)
  }
  assertConservation(instance: string) {
    const row = this.one<{ supply: number; total: number }>(
      'SELECT supply,(SELECT COALESCE(SUM(available+reserved),0) FROM accounts WHERE instance=?) AS total FROM instances WHERE id=?',
      instance,
      instance,
    )
    requireCondition(row && row.supply === row.total, 'INVARIANT_FAILURE', 'Supply invariant violated', 500)
  }
  close() {
    this.db.close()
  }
}
