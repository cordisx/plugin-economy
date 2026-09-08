import type { HttpClientV1 } from '@cordisx/protocol/plugin-http/v1'
import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXPluginManifestV1,
  type CordisXReactPageProps,
} from 'cordisx/contracts'
import { defineReactPage, lazy, Suspense } from 'cordisx/react'
import { en, type Messages, zh } from './messages.js'
import { WalletSession } from './session.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'wallet',
  name: 'Token Wallet',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

export const inject = ['i18n', 'pages', 'routes', 'slots', 'managerContent']

const page = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'overview',
  title: { key: 'page.title', fallback: 'Token wallet' },
  description: { key: 'page.description', fallback: 'Virtual Token, game approvals and purchase history.' },
  icon: 'host:info',
} as const

const route = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'overview',
  path: '/manager/extensions/wallet',
  outlet: 'manager.content',
  page: 'overview',
  title: { key: 'route.title', fallback: 'Token wallet' },
  description: { key: 'route.description', fallback: 'Open your shared Token wallet.' },
} as const

const OverviewPage = lazy(async () => {
  const module = await import('./overview-page.js')
  return { default: module.OverviewPage }
})

export function apply(ctx: Context): void {
  const session = new WalletSession(ctx.get('http') as HttpClientV1 | undefined)
  ctx.effect(() => () => session.dispose())
  const mountOverview = defineReactPage<Messages>((props: CordisXReactPageProps<Messages>) => (
    <Suspense fallback={null}>
      <OverviewPage {...props} session={session} />
    </Suspense>
  ))
  ctx.i18n.define<Messages>({ namespace: 'wallet', locale: 'en', default: true, messages: en })
  ctx.i18n.define<Messages>({ namespace: 'wallet', locale: 'zh-CN', messages: zh })
  ctx.pages.register<Messages>(page, mountOverview)
  ctx.routes.register(route)
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
