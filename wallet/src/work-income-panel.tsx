import type { WorkIncomeState } from '@cordisx/economy/client'
import type { LocalWalletReadService } from '@cordisx/economy/local'
import type { CordisXReactPageProps } from 'cordisx/contracts'
import { type ReactElement, useEffect, useState } from 'cordisx/react'
import { Card, Stack, Text } from 'cordisx/ui'
import type { Messages } from './messages.js'
import type { WalletSession } from './session.js'
import { TokenAmount } from './token-amount.js'
export function WorkIncomePanel(
  { t, session }: Pick<CordisXReactPageProps<Messages>, 't'> & {
    session: WalletSession & { service?: LocalWalletReadService }
  },
): ReactElement {
  const [state, setState] = useState<WorkIncomeState>()
  const [error, setError] = useState('')
  useEffect(() => {
    let closed = false, pending = false
    const read = async () => {
      if (closed || pending || !session.service?.workIncome) return
      pending = true
      try {
        const result = await session.service.workIncome()
        if (!closed) {
          setState(result)
          setError('')
        }
      } catch (reason) {
        if (!closed) {
          setState(undefined)
          setError(reason instanceof Error ? reason.message : 'Income unavailable')
        }
      } finally {
        pending = false
      }
    }
    void read()
    const unsubscribe = session.subscribe(() => {
      setState(undefined)
      void read()
    })
    const incomeUnsubscribe = session.service?.subscribeIncome?.(() => void read())
    const timer = setInterval(() => void read(), 5000)
    return () => {
      closed = true
      clearInterval(timer)
      unsubscribe()
      incomeUnsubscribe?.()
    }
  }, [session])
  return (
    <Card>
      <Stack gap='small'>
        <Text>{t('work-records')}</Text>
        {error && <Text tone='muted' role='status'>{error}</Text>}
        {state && (
          <>
            <Text>
              {t('work-earned')}: <TokenAmount value={state.earned} />
            </Text>
            <Text>{t('work-remainder')}: {state.remainder.toLocaleString()} / 10,000</Text>
            <Text tone='muted'>
              {t(
                state.status === 'active'
                  ? 'work-active'
                  : state.status === 'pristine'
                  ? 'work-first'
                  : 'work-reconcile',
              )}
            </Text>
            {state.takeover && (
              <>
                <Text>
                  {t('work-prefix')}: {state.takeover.admittedPrefix.tokens.toLocaleString()} ·{' '}
                  <TokenAmount value={state.takeover.admittedPrefix.amount} />
                </Text>
                <Text tone='muted'>{t('work-durable')}</Text>
                <Text tone='muted'>{t('work-history-separate')}</Text>
              </>
            )}
            {state.records.map(record => (
              <Text key={record.eventId}>
                {new Date(record.createdAt).toLocaleString()} · {t(
                  (record.kind === 'admitted-prefix' || record.kind === 'admitted-prefix-correction')
                    ? 'work-prefix'
                    : 'work-records',
                )} · {record.creditedTokens.toLocaleString()} · <TokenAmount value={record.amount} />
              </Text>
            ))}
            <details>
              <summary>{t('work-provenance')}</summary>
              <pre>{JSON.stringify(state, null, 2)}</pre>
            </details>
          </>
        )}
      </Stack>
    </Card>
  )
}
