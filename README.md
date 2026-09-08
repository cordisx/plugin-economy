# CordisX Economy

A self-hosted virtual entertainment Token ledger, typed client and CordisX wallet.
Balances are integer, instance/account-scoped and conserved. Users explicitly
approve immutable game terms before their stakes are frozen; authorized game
servers can settle only within those terms. Unreviewed games can participate.
There is no real money, cash withdrawal, public mint or arbitrary client credit.

```sh
npm ci
npm run check
```

See [deployment and enrollment](docs/deployment.md), [HTTP API and SDK](docs/economy-api.md),
[wallet development](wallet/README.md), and [architecture scope](docs/architecture.md).
The SDK exports `@cordisx/economy/client`; server integration exports
`@cordisx/economy/server`. Operator commands are offline-only. Pet integration
uses durable orders and operator-approved, one-time migration entitlements.

Status: experimental implementation. Tests cover actual HTTP, ledger failures,
independent-process races and crash rollback. Native wallet connection, consent and settlement were exercised against temporary accounts. Installed plugin
replacement verification remains separate; no merge, hosted deployment, formal release
or user acceptance is implied by local tests.
