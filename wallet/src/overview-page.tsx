import type { LedgerEntry } from '@cordisx/economy/client'
import type { LocalWalletReadService } from '@cordisx/economy/local'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { CordisXReactPageProps } from 'cordisx/contracts'
import { type ReactElement, useEffect, useState } from 'cordisx/react'
import { Button, HoverCard, Stack, Text } from 'cordisx/ui'
import type { Messages } from './messages.js'
import type { WalletSession } from './session.js'
import { TokenAmount } from './token-amount.js'
import { observeWalletView, type WalletView, walletViewFailed } from './wallet-view.js'
import { WorkIncomePanel } from './work-income-panel.js'
import { WorkUsagePanel } from './work-usage-panel.js'
import './wallet-ui.css'
type Props = CordisXReactPageProps<Messages> & {
  session: WalletSession & {
    service?: LocalWalletReadService
    readOnly?: boolean
    readWorkUsage?: () => Promise<WorkUsageSnapshotV2>
  }
}
function useView(session: Props['session']) {
  const [view, setView] = useState<WalletView>({
    origin: session.origin || session.defaultOrigin,
    ledger: [],
    orders: [],
  })
  const [retry, setRetry] = useState(0)
  useEffect(() => observeWalletView(session, setView), [session, retry])
  return { view, retry: () => setRetry(value => value + 1) }
}
function ActivityRows({ entries, t }: { entries: LedgerEntry[]; t: Props['t'] }): ReactElement {
  const reason = (entry: LedgerEntry) => {
    if (entry.reason.includes('work')) return t('ui.work')
    if (entry.reason.includes('purchase')) return t('ui.purchase')
    if (entry.reason.includes('reserve')) return t('ui.reserve')
    if (entry.reason.includes('release') || entry.reason.includes('refund')) return t('ui.refund')
    if (entry.reason.includes('settle')) return t('ui.settle')
    if (entry.reason.includes('reward') || entry.reason.includes('grant')) return t('ui.reward')
    return t('ui.adjustment')
  }
  return (
    <div className='wallet-ui__activity'>
      {entries.map(entry => {
        const net = entry.availableDelta + entry.reservedDelta
        return (
          <div className='wallet-ui__entry' key={`${entry.accountId}:${entry.sequence}`}>
            <span className='wallet-ui__direction' aria-hidden='true'>{net > 0 ? '↙' : net < 0 ? '↗' : '↔'}</span>
            <div className='wallet-ui__entry-description'>
              <strong>{reason(entry)}</strong>
              <Text tone='muted'>
                {new Date(entry.createdAt).toLocaleString()} · {entry.serviceId || t('ui.wallet-source')}
              </Text>
            </div>
            <div className='wallet-ui__entry-amount'>
              <TokenAmount value={net || entry.reservedDelta} signed />
              {net === 0 && <Text tone='muted'>{t('ui.reservation-change')}</Text>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
function Failure({ retry, t }: { retry: () => void; t: Props['t'] }): ReactElement {
  return (
    <Stack direction='row' gap='small' align='center'>
      <Text tone='danger' role='alert'>{t('ui.error')}</Text>
      <Button variant='ghost' onClick={retry}>{t('ui.retry')}</Button>
    </Stack>
  )
}
export function OverviewPage({ t, session, navigation }: Props): ReactElement {
  const { view, retry } = useView(session)
  const wallet = view.wallet
  const failed = walletViewFailed(view, session.available)
  return (
    <div className='wallet-ui'>
      <section className='wallet-ui__balance' aria-label={t('ui.available')}>
        <Stack direction='row' gap='small' align='center'>
          <Text tone='muted'>{t('ui.available')}</Text>
          <HoverCard
            placement='bottom'
            trigger={<Button variant='ghost' aria-label={t('ui.help')}>ⓘ</Button>}
            content={
              <div className='wallet-ui__help'>
                <Text>{t('ui.exchange')}</Text>
                <Text tone='muted'>{t('ui.coverage')}</Text>
                <Button variant='ghost' onClick={() => void navigation.navigate({ id: 'diagnostics' })}>
                  {t('ui.diagnostics')}
                </Button>
              </div>
            }
          />
        </Stack>
        {wallet
          ? (
            <div className='wallet-ui__balance-number'>
              <TokenAmount value={wallet.available} size='balance' />
            </div>
          )
          : failed
          ? (
            <div className='wallet-ui__balance-number'>
              <TokenAmount />
            </div>
          )
          : (
            <div
              className='wallet-ui__skeleton wallet-ui__skeleton--balance'
              role='status'
              aria-label={t('ui.loading')}
            />
          )}
        {!!wallet?.reserved && (
          <Text tone='muted'>
            {t('ui.reserved')} <TokenAmount value={wallet.reserved} />
          </Text>
        )}
      </section>
      {failed && <Failure t={t} retry={retry} />}
      <section>
        <div className='wallet-ui__section-heading'>
          <h2 className='wallet-ui__heading'>{t('ui.recent')}</h2>
          <Button variant='ghost' onClick={() => void navigation.navigate({ id: 'activity' })}>{t('ui.all')}</Button>
        </div>
        {wallet
          ? view.ledger.length
            ? <ActivityRows entries={view.ledger.slice(0, 5)} t={t} />
            : <Text tone='muted'>{t('empty')}</Text>
          : !failed && (
            <div className='wallet-ui__skeleton wallet-ui__skeleton--rows' role='status' aria-label={t('ui.loading')} />
          )}
      </section>
    </div>
  )
}
export function ActivityPage({ t, session, navigation }: Props): ReactElement {
  const { view, retry } = useView(session)
  return (
    <div className='wallet-ui'>
      <Button variant='ghost' onClick={() => void navigation.navigate({ id: 'overview' })}>{t('ui.back')}</Button>
      <h2 className='wallet-ui__heading'>{t('ui.activity')}</h2>
      <Text tone='muted'>{t('ui.activity-limit')}</Text>
      {view.error ? <Failure t={t} retry={retry} /> : view.wallet
        ? view.ledger.length
          ? <ActivityRows entries={view.ledger} t={t} />
          : <Text tone='muted'>{t('empty')}</Text>
        : <div className='wallet-ui__skeleton wallet-ui__skeleton--rows' role='status' aria-label={t('ui.loading')} />}
    </div>
  )
}
export function DiagnosticsPage({ t, session, navigation }: Props): ReactElement {
  const { view, retry } = useView(session)
  const [income, setIncome] = useState(() => session.service?.incomeStatus?.())
  useEffect(() => session.service?.subscribeIncome?.(() => setIncome(session.service?.incomeStatus?.())), [session])
  return (
    <div className='wallet-ui'>
      <Button variant='ghost' onClick={() => void navigation.navigate({ id: 'overview' })}>{t('ui.back')}</Button>
      <h2 className='wallet-ui__heading'>{t('ui.diagnostics')}</h2>
      <Text>{view.wallet ? `${view.wallet.instanceId} / ${view.wallet.accountId}` : '—'}</Text>
      <Text tone='muted'>{view.origin}</Text>
      {view.error && <Text tone='danger'>{view.error}</Text>}
      {income && <Text tone='muted'>{income.status} · {income.stage} · {income.reason}</Text>}
      <Button variant='secondary' onClick={retry}>{t('refresh')}</Button>
      <WorkIncomePanel t={t} session={session} />
      {!session.readOnly && <WorkUsagePanel t={t} read={session.readWorkUsage} />}
    </div>
  )
}
