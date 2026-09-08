# Token wallet plugin

The wallet shows account/instance identity, integer available and frozen Token,
recent ledger activity and purchase receipts. It reviews the exact game digest,
version, review state, service identity, covered human/Agent seats, stakes,
expiry and settlement policy before explicit user reserve consent. Game account
linking uses short-lived audience-bound proofs; no user spend credential is
sent to the game server.

The plugin consumes `ctx.http` from the public HTTP contract, with Host-owned
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
npm --prefix wallet ci --ignore-scripts
npm --prefix wallet run check
npm --prefix wallet run dev:dry-run
npm --prefix wallet run dev
```

These commands run from the repository root. `prepare-sdk` writes only ignored
`.cache` directories and builds public repositories at exact SHAs. Wallet
package file references point to those reproducible tarballs, never another
owner's absolute checkout. Current baseline Host lacks HTTP runtime support;
Protocol `8adc1aab908263e692bd56ca6165b9aeadabe4b9` supplies the experimental
types. Capability Host source/verification is coordinated separately.

Vite uses the maintained `cordisXPluginViteConfig()` helper and preserves the
formal `dist/runtime/artifact.json`, entry, shared chunk, lazy page chunk and
lazy CSS. The package `files` includes the whole graph. `npm pack --ignore-scripts`
from `wallet/` retains it. Source development still points to `src/wallet.tsx`.
No private React runtime is bundled.

## Verification scope

`check` typechecks, builds and tests artifact integrity and connection lifecycle.
Public transport tests use explicit Host fixtures and do not prove the native
Host adapter. `dev:dry-run` validates the launcher-owned Vite path without
starting the native app. Real `app://` authorization, page interaction, reload,
installed-generation replacement and visual theme checks require the capability
Host and are reported separately. The wallet is not an independently hosted
static login site, and native acceptance is not inferred from a screenshot.

Styles belong only to `.economy-wallet` inside the Host page body. Host owns
page header, navigation and scroll chrome. The plugin adds no second page header,
outer padding or nested scroll container. Root dprint/Malva and Stylelint cover
its CSS. Locale definitions include English and Simplified Chinese.
