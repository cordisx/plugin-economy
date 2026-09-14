# Token wallet plugin

The Wallet shows the original local account, available and reserved Token, activity and receipts. Income continues through the existing public Host usage/HTTP contracts and the canonical actual-work issuer. The approved page and shared coin visuals remain unchanged.

Wallet publishes `economyLocalWallet` for reads and `economyWalletCommerce` for Pet catalog, purchases, definite cancellation and receipt recovery. Commerce consumes the optional public `ctx.walletSpend` service. Host attaches it to the actual Wallet owner without a new manifest capability. The fixed Native confirmation identifies the original wallet and real store/SKU/quantity/price/target. Host owns authorization and private IPC; Wallet never supplies an owner identity, signing grant or arbitrary bridge.

An absent Host capability is explicit unavailable. Unknown replies and generation changes retain pending requests. An authenticated cancelled receipt includes the exact original intent and canonical hash. Read-only maintenance blocks mutations. Current semantics are in [local spending](../docs/local-spend.md).

## Develop and package

From the repository root, validate the frozen normal SDK inputs with `node scripts/prepare-sdk.mjs`, run `npm ci`, `npm --prefix wallet ci`, `npm run check`, `npm --prefix wallet run check` and `npm --prefix wallet run dev:dry-run`. The package lock and SDK inventory pin the supplied normal Host and Protocol packages. A single override retains one Protocol identity; never replace individual compiled SDK files or use a second protocol installation.

Vite uses `cordisXPluginViteConfig()` and preserves the complete runtime artifact, shared chunks, lazy page and lazy CSS. The package includes the full graph. Source development still uses `src/wallet.tsx`. The public React runtime remains external.

## Verification scope

Normal checks cover types, artifact graph, canonical service behavior and lifecycle. Temporary fixtures and private IPC integration do not prove that a running Host installed this candidate or that Native end-to-end acceptance occurred. `dev:dry-run` validates the launcher Vite path without starting the native app. This delivery does not restart a preview, replace runtime plugins, merge or deploy.

Styles stay inside `.economy-wallet` within the Host page body. Host owns header, navigation and scrolling. English and Simplified Chinese locale definitions remain available.

The normal Economy package declares Protocol as an environment peer and Host as an optional environment peer required for configured terminal spending. Exact local normal SDK inputs are development dependencies only. External consumers provide the approved normal Protocol/Host packages directly; no Host override or package-relative SDK file dependency is required. The Protocol companion override still keeps Host and consumer on one identity.
