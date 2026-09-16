# Local service configuration and recovery

The terminal wallet is a Node.js 24.14+ process with one persistent local SQLite Store. Keep the original DB and its wallet aliases, work scope, receipts, ledger and pending audit. Provisioning and configuration instructions are not permission to modify a running installation.

## Source installation

Run `npm ci` against the frozen normal package inputs and `npm run check`. The source graph pins normal Host/Protocol SDK packages; do not copy individual compiled SDK files or install a second Protocol identity. `ECONOMY_DB`, `HOST`, `PORT` and `ECONOMY_ORIGINS` retain their existing meanings. Startup never provisions accounts or funds. `/healthz` is liveness only.

The existing private `ECONOMY_MANAGED_TRUST_FILES` and `ECONOMY_LOCAL_WALLET=1` configuration controls original local enrollment and actual work income. Preserve those bindings. New empty test installations can provision `instance ID 0` and accounts; nonzero genesis, source issuance and migration entitlements are retired. Catalog import remains one atomic import from the versioned Pet owner catalog.

The optional spending provider uses the public Node-only `cordisx/wallet-spend-provider/v1` listener. Configure `ECONOMY_SPEND_SOCKET`, `ECONOMY_SPEND_SECRET_FILE` and `ECONOMY_SPEND_RECEIPT_KEY_FILE` together through trusted launcher configuration. These select its private socket, owner-owned 0600 shared secret and stable owner-owned 0600 Ed25519 receipt key. Original origin and instance come only from the existing source-account trust. Bind it to the original local Economy origin/instance and existing Store. It must not be exposed as a public HTTP signer or selected by a renderer. Host independently owns the matching trusted private socket configuration and Native authorization.

The receipt key and IPC secret must be explicitly provisioned outside the renderer. Retain their identity across restart. Do not generate replacements to recover a missing key; key replacement cannot rebind pending reservations. The provider fails if an original authority alias is absent or revoked.

## Recovery

SQLite WAL, FULL synchronization and `BEGIN IMMEDIATE` serialize writers sharing this one persistent local volume. Restart rolls back incomplete transactions. It does not expire or refund historical agreements or new spending holds. A deadline, disconnect or unknown response never proves a refund or cancelled purchase.

Game consumers retain original source/key/terms/request and query the exact durable service decision. Pet retains exact pending purchase input/request and queries `order` or explicitly obtains a definite cancelled receipt. Purchase and cancellation share one permanent request slot; a committed Order remains an Order. Do not replace uncertain requests with fresh keys.

Stop consumers and writers before a filesystem backup, preserving SQLite plus WAL/SHM as a consistent set, or use SQLite's online backup API. Protect DB, private keys and backup files with owner-only access. Audit restored data in an isolated directory before any operational decision. Restoring an old backup can rewind receipts already observed elsewhere; copied offline wallets do not have global double-spend protection. Never delete ledger, idempotency, reservation, cancellation, migration, reward or pending records to repair a client.

## Deployment boundary

The terminal wallet provider requires the same local device authority and a private local Unix socket. This source delivery does not deploy it or restart an active service. The historical Docker/process adapter does not establish a remote terminal-wallet deployment. Game backend hosting is a separate owner task. A static wallet preview or Sites page cannot substitute for the original local ledger.
