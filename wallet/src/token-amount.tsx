import type { ReactElement } from 'cordisx/react'
import tokenCoin from './assets/token-coin.png'
import './token-amount.css'
/** The coin labels Token amounts; it does not turn an unavailable balance into zero. */
export function TokenAmount(
  { value, signed = false, size = 'inline' }: { value?: number; signed?: boolean; size?: 'inline' | 'balance' },
): ReactElement {
  const amount = value === undefined ? '—' : `${signed && value > 0 ? '+' : ''}${value.toLocaleString()}`
  return (
    <span className={`economy-token-amount economy-token-amount--${size}`} role='img' aria-label={`${amount} Token`}>
      <span>{amount}</span>
      <span className='economy-token-amount__icon' aria-hidden='true'>
        <img src={tokenCoin} alt='' />
      </span>
      <span className='economy-token-amount__unit'>{' Token'}</span>
    </span>
  )
}
