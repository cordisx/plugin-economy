import type { Agreement, LedgerEntry, Order, Wallet } from '@cordisx/economy/client'
import type { CordisXReactPageProps, NotificationsV1 } from 'cordisx/contracts'
import { useEffect, useState } from 'cordisx/react'
import { Button, Card, Stack, Text } from 'cordisx/ui'
import type { Messages } from './messages.js'
import type { WalletSession } from './session.js'
import './wallet.css'
export function OverviewPage(
  { t, session, notifications, signal }: CordisXReactPageProps<Messages> & {
    session: WalletSession
    notifications: NotificationsV1
  },
) {
  const [origin, setOrigin] = useState('http://127.0.0.1:8788')
  const [wallet, setWallet] = useState<Wallet>()
  const [ledger, setLedger] = useState<LedgerEntry[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [agreementId, setAgreementId] = useState('')
  const [agreement, setAgreement] = useState<Agreement>()
  const [serviceId, setServiceId] = useState('')
  const [gameAccount, setGameAccount] = useState('')
  const [linkCode, setLinkCode] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => () => {
    session.dispose()
  }, [session])
  const refresh = async () => {
    const client = session.client
    if (!client) return
    const [current, entries, receipts] = await Promise.all([client.me(), client.ledger(), client.orders()])
    setWallet(current)
    setLedger(entries)
    setOrders(receipts)
    if (agreement) setAgreement(await client.agreement(agreement.id))
  }
  const run = (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    void action().catch(() => {
      if (!signal.aborted) {
        notifications.show({ kind: 'operation.failed', type: 'error', message: t('operation-failed') })
      }
    }).finally(() => {
      if (!signal.aborted) setBusy(false)
    })
  }
  return (
    <Stack gap='large' className='economy-wallet'>
      <Text tone='muted'>{t('virtual')}</Text>
      {busy && <Text role='status'>{t('loading')}</Text>}
      {!session.available && <Text tone='muted'>{t('unavailable')}</Text>}
      {!wallet
        ? (
          <Card>
            <Stack gap='medium'>
              <label>
                {t('origin')}
                <input
                  value={origin}
                  onChange={event => setOrigin(event.target.value)}
                  placeholder='https://economy.example'
                  disabled={busy || !session.available}
                />
              </label>
              <Text tone='muted'>{t('connect-help')}</Text>
              <Button
                disabled={busy || !session.available}
                variant='primary'
                onClick={() =>
                  run(async () => {
                    setWallet(await session.connect(origin))
                    await refresh()
                  })}
              >
                {t('connect')}
              </Button>
            </Stack>
          </Card>
        )
        : (
          <>
            <Card>
              <Stack gap='medium'>
                <Text>{t('identity')}: {wallet.instanceId} / {wallet.accountId}</Text>
                <Stack direction='row' gap='large' wrap>
                  <Text>
                    {t('available')}: <strong>{wallet.available.toLocaleString()}</strong>
                  </Text>
                  <Text>
                    {t('reserved')}: <strong>{wallet.reserved.toLocaleString()}</strong>
                  </Text>
                </Stack>
                <Stack direction='row' gap='small'>
                  <Button disabled={busy || !session.available} onClick={() => run(refresh)}>{t('refresh')}</Button>
                  <Button
                    disabled={busy || !session.available}
                    onClick={() =>
                      run(async () => {
                        await session.disconnect()
                        setWallet(undefined)
                        setAgreement(undefined)
                        setLinkCode('')
                      })}
                  >
                    {t('disconnect')}
                  </Button>
                </Stack>
              </Stack>
            </Card>
            <Card>
              <Stack gap='medium'>
                <label>
                  {t('agreement')}
                  <input
                    value={agreementId}
                    disabled={busy || !session.available}
                    onChange={event => {
                      setAgreementId(event.target.value)
                      setAgreement(undefined)
                    }}
                  />
                </label>
                <Button
                  disabled={busy || !agreementId}
                  onClick={() => run(async () => setAgreement(await session.client!.agreement(agreementId)))}
                >
                  {t('inspect')}
                </Button>
                {agreement && (
                  <Stack gap='medium'>
                    <Text>{t('game')}: {agreement.game.id} / {agreement.game.version}</Text>
                    <Text className='economy-wallet-digest'>SHA-256: {agreement.game.digest}</Text>
                    <Text tone={agreement.game.reviewStatus === 'unreviewed' ? 'danger' : 'muted'}>
                      {t(agreement.game.reviewStatus)}
                    </Text>
                    <Text>{t('authority')}: {agreement.serviceId}</Text>
                    <Text>{t('deadline')}: {new Date(agreement.expiresAt).toLocaleString()}</Text>
                    <Text>{t('participants')}</Text>
                    {agreement.participants.map(p => (
                      <Text key={p.accountId}>
                        {p.accountId}: {p.amount} Token{p.participantIds ? ` · ${p.participantIds.join(', ')}` : ''}
                      </Text>
                    ))}
                    <Text>
                      {t('policy')}: {t(agreement.settlementPolicy.kind === 'enumerated' ? 'enumerated' : 'conserved')}
                    </Text>
                    {agreement.settlementPolicy.kind === 'enumerated'
                      && agreement.settlementPolicy.outcomes.map(outcome => (
                        <Text key={outcome.id}>
                          {outcome.id}: {outcome.payouts.map(p => `${p.accountId} ${p.amount}`).join(' / ')}
                        </Text>
                      ))}
                    <Text className='economy-wallet-digest'>{t('hash')}: {agreement.termsHash}</Text>
                    {agreement.state !== 'open'
                      ? <Text>{t('closed')} ({agreement.state})</Text>
                      : agreement.reservations.includes(wallet.accountId)
                      ? <Text>{t('confirmed')}</Text>
                      : (
                        <Button
                          variant='primary'
                          disabled={busy || agreement.expiresAt <= Date.now()}
                          onClick={() =>
                            run(async () => {
                              // Reserve is also unique by agreement/account; reload cannot double-freeze.
                              await session.client!.reserve({
                                agreementId: agreement.id,
                                termsHash: agreement.termsHash,
                              }, `wallet-reserve:${agreement.id}`)
                              await refresh()
                            })}
                        >
                          {t('confirm')} ({agreement.participants.find(p => p.accountId === wallet.accountId)?.amount}
                          {' '}
                          Token)
                        </Button>
                      )}
                  </Stack>
                )}
              </Stack>
            </Card>
            <Card>
              <Stack gap='medium'>
                <Text>{t('link-title')}</Text>
                <label>
                  {t('service-id')}
                  <input
                    value={serviceId}
                    disabled={busy || !session.available}
                    onChange={event => {
                      setServiceId(event.target.value)
                      setLinkCode('')
                    }}
                  />
                </label>
                <label>
                  {t('game-account')}
                  <input
                    value={gameAccount}
                    disabled={busy || !session.available}
                    onChange={event => {
                      setGameAccount(event.target.value)
                      setLinkCode('')
                    }}
                  />
                </label>
                <Text tone='muted'>{t('link-help')}</Text>
                <Button
                  disabled={busy || !serviceId || !gameAccount}
                  onClick={() =>
                    run(async () => {
                      const proof = await session.client!.linkProof({
                        gameServiceId: serviceId,
                        gameAccountId: gameAccount,
                      }, `wallet-link:${crypto.randomUUID()}`)
                      setLinkCode(proof.code)
                    })}
                >
                  {t('link')}
                </Button>
                {linkCode && (
                  <label>
                    {t('link-code')}
                    <input readOnly value={linkCode} />
                  </label>
                )}
              </Stack>
            </Card>
            <Card>
              <Stack gap='small'>
                <Text>{t('orders')}</Text>
                {!orders.length && <Text tone='muted'>{t('empty')}</Text>}
                {orders.map(order => (
                  <Text key={order.id}>{order.itemId} × {order.quantity} · {order.total} Token · {order.id}</Text>
                ))}
              </Stack>
            </Card>
            <Card>
              <Stack gap='small'>
                <Text>{t('ledger')}</Text>
                {!ledger.length && <Text tone='muted'>{t('empty')}</Text>}
                {ledger.map(entry => (
                  <Text key={entry.sequence}>
                    {new Date(entry.createdAt).toLocaleString()} · {entry.reason} ·{' '}
                    {entry.availableDelta > 0 ? '+' : ''}
                    {entry.availableDelta} / {entry.reservedDelta > 0 ? '+' : ''}
                    {entry.reservedDelta} · {entry.reference}
                  </Text>
                ))}
              </Stack>
            </Card>
          </>
        )}
    </Stack>
  )
}
