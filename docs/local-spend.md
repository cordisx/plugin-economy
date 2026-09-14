# Terminal local wallet spending

## Authority

Token income comes only from the existing actual classified Codex Host model usage issuer. Its original wallet account, immutable work scope, frontier and receipt deduplication remain unchanged. A game server cannot issue income, move another wallet's money into a winner's wallet or choose an alternative recipient. Game rewards use scores or match-local chips.

The private Economy provider operates on the same existing SQLite Store. Trusted launcher configuration pins the original local origin and instance. Host supplies the original profile authority; Economy resolves its existing account alias before every operation. Missing, revoked or changed aliases fail. No provider method enrolls an alias, copies assets or substitutes a new wallet.

The operator provisions a stable private Ed25519 receipt key in an owner-owned regular 0600 file. Opening the provider does not generate or repair it. Symlinks and public permissions are rejected; the key is pinned to each existing wallet identity and changing it fails. Local device owners, administrators and processes with the same authority can alter local software or files. This design does not promise protection against those actors or global double-spend protection across copied wallets.

## Game contract

`@cordisx/economy/spend` publishes the strict portable contract, canonical encoding, hashes, signature verification and settlement parser. Signed terms bind the exact service origin/key/server, game ID/version/digest/review state, match, account/wallet/key/principal participants, admission deadline and `capture-and-release` policy. Review state is disclosed; unreviewed games remain eligible after fixed Native consent. Prior service-signed challenge and original wallet proof bind each Game account.

Host owns service origin/key approval, independent fixed Native consent and private Unix-socket authorization. Renderer plugins use `ctx.walletSpend`; they cannot obtain raw signing keys, grant objects or arbitrary signing/IPC authority. Economy accepts only the private quote handle in the authenticated connection. Disconnect, owner retirement and deadline close the session synchronously; the final transaction fence prevents a stale authorization committing.

Reserve atomically moves available principal to reserved and persists the signed reservation nonce and stable request mapping. A lost reply recovers the exact original receipt. Terms or body changes under the same source/match/request conflict.

A durable service decision captures between zero and the same user's frozen principal, returning the remainder to that same wallet. Captured Token is consumed; supply decreases by that amount. Refund captures zero. Capture requires the complete disclosed reservation set. A global refund can omit reservations the service never received, permitting recovery of an unacknowledged hold. The decision binds immutable terms, has one deterministic ID and an exact immutable signed body. A different capture/refund or body after the first committed decision is rejected. Replay returns the same signed settlement.

The service must durably commit its non-equivocal decision before returning it. Admission deadlines do not expire a hold or authorize a second refund decision. Economy does not refund through startup, sweep, elapsed time, client abort or inference from an unknown result. Keep pending reservations and reconcile the original service decision.

## Pet commerce and definite cancellation

Wallet publishes `economyWalletCommerce` with public `economy.local-wallet-commerce/v1` methods. Pet consumes that facade; the actual Host caller is the Wallet owner. Host identifies the real store/SKU/quantity/price/target in its fixed Native purchase dialog. No consumer supplies an owner string, raw credential, arbitrary grant or financial recipient.

The private purchase quote copies exact catalog price and original intent. Purchase atomically commits debit, Order, inventory and request receipt in the existing Store. Request ID plus canonical original input remains permanent. `order` and `orders` are authenticated reads. Fulfillment uses the original Order and target once in Pet's own journal.

Definite Native cancellation persists `economy.local-purchase-cancelled/v1` with original instance/account/store/request, exact input and canonical SHA-256 input hash. It shares the same transaction/request slot as purchase. If purchase won first, cancellation returns the original Order. If cancellation won first, late purchase returns the tombstone without debit or inventory. Cancellation-only quotes disclose the original input and can clean up an old intent after its catalog price changed; they cannot authorize purchase.

A disconnect, abort, expired connection, ambiguous reply or `order:null` is not definite cancellation. Pet retains the exact pending intent until an authenticated Order or cancelled receipt resolves it. Generation changes do not adopt late replies. Optional operation deadlines and abort signals pass through the public facade. Read-only maintenance blocks mutations.

## Retired history

Historical ordinary bearer financial POST routes, reward grants, migration claims, legacy work conversion and historical correction configuration are retired. Exact committed actor/key/operation/input replies may be read; absent replies remain absent. `legacyReceipt` uses the saved original body and request key, checks the original account and never signs or writes a replacement response. Old receipts retain their original unsigned representation.

Original balances, ledger, issuance receipts, migration/reward records, Order/inventory records, pending documents and scope-history audit are preserved. Do not clear, reset, rebind or automatically refund them. Historical fixture tests exercise archived arithmetic directly; separate production tests prove those HTTP entry points cannot create new financial mutations.

## Source delivery boundary

Normal package tests and temporary SQLite/Host IPC checks are source evidence. They do not mean actual DB/Registry/Keychain changes, a signer installation, Native end-to-end acceptance, service restart, merge, publication or deployment.

The normal Economy package declares Protocol as an environment peer and Host as an optional environment peer required for configured terminal spending. Exact local normal SDK inputs are development dependencies only. External consumers provide the approved normal Protocol/Host packages directly; no Host override or package-relative SDK file dependency is required. The Protocol companion override still keeps Host and consumer on one identity.
