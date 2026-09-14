# CordisX Economy

A self-hosted virtual entertainment Token ledger, typed client and CordisX wallet.
Balances remain in the original local instance/account. Only actual classified Codex Host model usage issues new Token. Games reserve a disclosed amount from each participant's local wallet, then capture at most that participant's principal and release its remainder. Scores and chips express game winnings. Pet purchases use the shared canonical local commerce service.

```sh
npm ci
npm run check
```

See [deployment and enrollment](docs/deployment.md), [HTTP API and SDK](docs/economy-api.md),
[wallet development](wallet/README.md), and [architecture scope](docs/architecture.md).
The SDK exports `@cordisx/economy/client`; server integration exports
`@cordisx/economy/server`. Operator commands are offline-only. Pet integration
uses durable orders through `economyWalletCommerce`. Historical rewards and migration claims are retired; exact committed receipts remain recoverable.

Status: experimental implementation. Tests cover actual HTTP, ledger failures,
independent-process races and crash rollback. Native wallet connection, consent and settlement were exercised against temporary accounts. Installed plugin
replacement verification remains separate; no merge, hosted deployment, formal release
or user acceptance is implied by local tests.

Experimental local wallet integration: [owner worker and transition](docs/local-wallet.md).

Current terminal contract and retirement semantics: [local spending](docs/local-spend.md).

The normal Economy package declares Protocol as an environment peer and Host as an optional environment peer required for configured terminal spending. Exact local normal SDK inputs are development dependencies only. External consumers provide the approved normal Protocol/Host packages directly; no Host override or package-relative SDK file dependency is required. The Protocol companion override still keeps Host and consumer on one identity.
