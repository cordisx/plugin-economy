export class EconomyError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) {
    super(message)
  }
}
export function requireCondition(value: unknown, code: string, message: string, status = 400): asserts value {
  if (!value) throw new EconomyError(code, message, status)
}
export function textId(value: unknown, field: string): asserts value is string {
  requireCondition(
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value),
    'INVALID_INPUT',
    `${field} must be a bounded identifier`,
  )
}
export function integer(value: unknown, field: string, min = 0, max = 1_000_000_000_000): asserts value is number {
  requireCondition(
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max,
    'INVALID_INPUT',
    `${field} must be an integer in [${min}, ${max}]`,
  )
}
