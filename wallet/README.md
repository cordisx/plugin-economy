# Token wallet plugin

The wallet shows account/instance identity, integer available and frozen Token,
recent ledger activity and purchase receipts. It reviews the exact game digest,
version, review state, service identity, covered human/Agent seats, stakes,
expiry and settlement policy before explicit user reserve consent. Game account
linking uses short-lived audience-bound proofs; no user spend credential is
sent to the game server.

The plugin consumes the public `http` service (optional discovery via Cordis `ctx.get`) from the public HTTP contract, with Host-owned
masked token capture. Only opaque references enter plugin code. Reconnect after
plugin reload; disconnect revokes the connection. Older Hosts display a disabled
connection with an explicit capability message. No renderer fetch, secret config,
private bridge or local-authoritative wallet is provided.

## Develop and package

The scaffold was generated with maintained `create-cordisx-plugin` beta.2 from
Host commit `b75fa2c6f9563924feca271242e2709c136033a3`. The npm beta.1 generator
is obsolete for this artifact format. Reproduce the pinned development SDK:

```sh
npm ci
npm run build
node scripts/prepare-sdk.mjs
npm --prefix wallet ci
npm --prefix wallet run check
npm --prefix wallet run dev:dry-run
npm --prefix wallet run dev
```

These commands run from the repository root. `prepare-sdk` writes only ignored
`.cache` directories and delegates to the exact Host commit’s portable builder. It does not install the Host checkout first: the builder archives exact sources, builds and verifies the bundled Git plugins, and normalizes executable permissions. Expected package hashes are checked against the provider checkpoint and retained in CI evidence. Wallet
package file references point to those reproducible tarballs, never another
owner's absolute checkout. The pinned experimental capability Host is `be2403c70664ff6624671224a405e409874d59c7`;
Protocol `465c444c65eec1be8e337b94c2cf658ed536f49c` supplies the experimental
types. The wallet applies one npm override referencing that same Protocol dependency throughout the graph so Host and plugin share its module identity. Host source/verification is coordinated separately; this is not a merged/released dependency.

Vite uses the maintained `cordisXPluginViteConfig()` helper and preserves the
formal `dist/runtime/artifact.json`, entry, shared chunk, lazy page chunk and
lazy CSS. The package `files` includes the whole graph. `npm pack --ignore-scripts`
from `wallet/` retains it. Source development still points to `src/wallet.tsx`.
No private React runtime is bundled.

For a native test with isolated accounts, run `node scripts/native-fixture.mjs` from the repository root and use the generated private fixture session in Host masked capture. This fixture keeps its ledger in memory and cannot target a production database. Grant this plugin the `manager.settings.navigation-items` and `manager.content` extension points using Host Manager, then open Token wallet.

## Verification scope

`check` typechecks, builds and tests artifact integrity and connection lifecycle.
Public transport tests use explicit Host fixtures and do not prove the native
Host adapter. `dev:dry-run` validates the launcher-owned Vite path without
starting the native app. Real `app://` authorization, balance retrieval, multi-seat agreement disclosure, user reserve, settlement refresh and account-link proof redemption were exercised against isolated temporary data. Installed-generation replacement and complete theme checks remain separate. The wallet is not an independently hosted
static login site, and native acceptance is not inferred from a screenshot.

Styles belong only to `.economy-wallet` inside the Host page body. Host owns
page header, navigation and scroll chrome. The plugin adds no second page header,
outer padding or nested scroll container. Root dprint/Malva and Stylelint cover
its CSS. Locale definitions include English and Simplified Chinese.

## Notification feedback

See [operation notifications and candidate SDK setup](../.agents/docs/notifications.md).
