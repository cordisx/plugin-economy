import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { CordisXReactPageProps } from 'cordisx/contracts'
import { type ReactElement, useEffect, useRef, useState } from 'cordisx/react'
import { Button, Card, Stack, Text } from 'cordisx/ui'
import type { Messages } from './messages.js'
/** Explicit readonly usage inspection. It cannot authorize, submit income or alter the frontier. */
export function WorkUsagePanel(
  { t, read }: Pick<CordisXReactPageProps<Messages>, 't'> & { read?: () => Promise<WorkUsageSnapshotV2> },
): ReactElement {
  const generation = useRef(0)
  const [snapshot, setSnapshot] = useState<WorkUsageSnapshotV2>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    generation.current++
    setSnapshot(undefined)
    setError('')
    setBusy(false)
    return () => {
      generation.current++
    }
  }, [read])
  const inspect = async () => {
    if (!read || busy) return
    const current = ++generation.current
    setSnapshot(undefined)
    setError('')
    setBusy(true)
    try {
      const result = await read()
      if (current === generation.current) setSnapshot(result)
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : 'Usage unavailable')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  return (
    <Card>
      <Stack gap='small'>
        <Text>{t('usage-title')}</Text>
        <Button disabled={!read || busy} onClick={() => void inspect()}>{t('usage-read')}</Button>
        {busy && <Text role='status'>{t('loading')}</Text>}
        {error && <Text role='alert' tone='danger'>{error}</Text>}
        {!snapshot && !busy && !error && <Text tone='muted'>{t('usage-not-read')}</Text>}
        {snapshot?.status === 'unavailable' && <Text role='status'>{t('income-unavailable')} · {snapshot.reason}</Text>}
        {snapshot?.status === 'ready' && (
          <>
            <Text>{t('usage-input')}: {snapshot.inputTokens.toLocaleString()}</Text>
            <Text>{t('usage-output')}: {snapshot.outputTokens.toLocaleString()}</Text>
            <Text>{t('usage-total')}: {snapshot.eligibleTokens.toLocaleString()}</Text>
            <Text tone='muted'>{t('usage-other')}</Text>
          </>
        )}
        {snapshot && (
          <details>
            <summary>{t('usage-details')}</summary>
            <pre>{JSON.stringify(snapshot, null, 2)}</pre>
          </details>
        )}
      </Stack>
    </Card>
  )
}
