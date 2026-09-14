import { LOCAL_WALLET_COMMERCE_SERVICE } from '@cordisx/economy/local'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXPluginManifestV11,
  type CordisXReactPageProps,
} from 'cordisx/contracts'
import { defineReactPage, lazy, Suspense } from 'cordisx/react'
import { createWalletCommerceFacade, type HostCommercePort } from './commerce-facade.js'
import { CanonicalWalletSession, LOCAL_WALLET_SERVICE, type LocalWalletConfig } from './local-wallet.js'
import { en, type Messages, zh } from './messages.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  schemaVersion: 11,
  services: [],
  id: 'wallet',
  name: 'Wallet',
  capabilities: [
    { name: 'usage.read', required: true, scope: { profile: 'current' } },
    {
      name: 'ui.extension-points.render',
      required: true,
      scope: { extensionPoints: ['manager.settings.navigation-items', 'manager.content'] },
    },
  ],
} as const satisfies CordisXPluginManifestV11

export const inject = ['i18n', 'pages', 'routes', 'slots', 'managerContent', 'documents', 'http', 'usage']

const page = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'overview',
  title: { key: 'page.title', fallback: 'Wallet' },
  description: { key: 'page.description', fallback: 'Balance and activity.' },
  icon: 'host:info',
} as const

const route = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'overview',
  path: '/manager/extensions/wallet',
  outlet: 'manager.content',
  page: 'overview',
  title: { key: 'route.title', fallback: 'Wallet' },
  description: { key: 'route.description', fallback: 'Open your wallet.' },
} as const

const OverviewPage = lazy(async () => {
  const module = await import('./overview-page.js')
  return { default: module.OverviewPage }
})

const ActivityPage = lazy(async () => ({ default: (await import('./overview-page.js')).ActivityPage }))
const DiagnosticsPage = lazy(async () => ({ default: (await import('./overview-page.js')).DiagnosticsPage }))

export const Config = Schema.object({
  readOnly: Schema.boolean().default(false).description(
    'Maintenance only: read the existing wallet and activity without income synchronization, usage reads or history corrections.',
  ),
  localEconomyOrigin: Schema.string().default('').description(
    'Canonical local loopback economy origin; existing binding cannot be replaced.',
  ),
  localEconomyInstanceId: Schema.string().default('local').description('Pinned managed economy instance.'),
  localEconomySourceId: Schema.string().default('economy-local').description(
    'Managed economy source-account identity.',
  ),
  workIncomeSourceId: Schema.string().default('economy-local').description(
    'Managed work-income source; no sponsor budget.',
  ),
})

export function apply(ctx: Context, config: LocalWalletConfig = {}): void {
  const session = new CanonicalWalletSession(ctx, config)
  ctx.provide(LOCAL_WALLET_SERVICE, session.service)
  let hostCommerce: HostCommercePort | undefined, commerceRetired = false
  ctx.provide(
    LOCAL_WALLET_COMMERCE_SERVICE,
    createWalletCommerceFacade(session, () => {
      if (commerceRetired) return undefined
      return hostCommerce = ctx.get('walletSpend')
    }),
  )
  ctx.effect(() => () => {
    commerceRetired = true
    hostCommerce?.dispose()
  })
  ctx.effect(() => () => session.dispose())
  if (config.localEconomyOrigin) void session.connect(config.localEconomyOrigin).catch(() => {})
  const mountOverview = defineReactPage<Messages>((props: CordisXReactPageProps<Messages>) => (
    <Suspense fallback={null}>
      <OverviewPage {...props} session={session} />
    </Suspense>
  ))
  ctx.i18n.define<Messages>({ namespace: 'wallet', locale: 'en', default: true, messages: en })
  ctx.i18n.define<Messages>({ namespace: 'wallet', locale: 'zh-CN', messages: zh })
  ctx.pages.register<Messages>(page, mountOverview)
  ctx.routes.register(route)
  for (
    const [id, component, title] of [
      ['activity', ActivityPage, 'Activity'],
      ['diagnostics', DiagnosticsPage, 'Connection details'],
    ] as const
  ) {
    ctx.pages.register<Messages>(
      { ...page, id, title: { key: id === 'activity' ? 'ui.activity' : 'ui.diagnostics', fallback: title } },
      defineReactPage<Messages>(props => {
        const Page = component
        return (
          <Suspense fallback={null}>
            <Page {...props} session={session} />
          </Suspense>
        )
      }),
    )
    ctx.routes.register({
      ...route,
      id,
      path: `/manager/extensions/wallet/${id}`,
      page: id,
      title: { key: id === 'activity' ? 'ui.activity' : 'ui.diagnostics', fallback: title },
    })
  }
  ctx.managerContent.register({
    $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
    schemaVersion: 1,
    id: 'root',
    route: { id: 'overview' },
    header: { title: { kind: 'route' } },
  })
  ctx.slots.register({ name: 'manager.settings.navigation-items', id: 'wallet', group: 'after-settings', order: 160 }, {
    route: { id: 'overview' },
  })
}

export { LOCAL_WALLET_SERVICE } from './local-wallet.js'
export type { LocalWalletReadService } from './local-wallet.js'
