# Self-hosting and recovery

The reference service is a real Node.js 24.14+ process using built-in SQLite.
It has no runtime npm dependencies and requires a persistent local disk.
SQLite is marked experimental by Node 24; pin and test runtime upgrades.
Only virtual entertainment Token is supported. Provisioning finite supply does
not create a redeemable claim, real-money value or a withdrawal mechanism.

## Install and provision

```sh
npm ci
npm run check
npm run admin -- instance friends 1000000
npm run admin -- account friends alice
npm run admin -- account friends bob
npm run admin -- service friends games '*' 1000
npm run admin -- service friends rewards usage 1
npm run admin -- source friends welcome rewards reward 10000 500 100
npm run admin -- source friends pet-legacy rewards migration 10000 500 100
npm run admin -- entitlement friends pet-legacy ORIGINAL_SNAPSHOT_SHA256 alice 100
npm run admin -- catalog-import friends /path/to/plugin-pet/economy/pet-catalog.json
npm run admin -- login-code friends alice
npm start
```

Service creation prints its credential **once**. Run it in a private terminal;
store it in the service operator's secret manager, not shell history, browser
storage, Git, rule packages or screenshots. Services are instance-scoped and
expire after 30 days. `*` explicitly authorizes games published by that service;
use a game ID for narrower installations. Stake limits still apply. A game
service cannot grant rewards without a separately provisioned source. Budget
allocation transfers from the finite issuer reserve; there is no top-up or
mint API. Catalog import is one atomic insert; duplicate SKUs fail the whole
batch, preserving original prices. Use the full versioned Pet owner catalog;
this repository intentionally does not maintain a second product inventory.

The one-time login code expires in ten minutes. Exchange it with `POST /v1/session`
via a trusted CLI/session provisioning utility and put the returned one-hour
session into Host-owned masked credential capture. The wallet never receives
its raw value. Session rotation needs a trusted client; a lost rotation response
requires a new login code. This initial release uses explicit operator enrollment
rather than claiming OIDC/password account discovery. Keep the database across
reinstall to preserve account IDs, deduplication and legacy claims.

`ECONOMY_DB` selects the database, `HOST` defaults to loopback, `PORT` to 8788,
and `ECONOMY_ORIGINS` is an optional comma-separated exact browser origin list.
The Host proxy does not need browser CORS. Do not use a shared server port
already occupied by another application. Startup never provisions users or
funds. `/healthz` exposes liveness only.

## Production boundary

Place the service behind a TLS reverse proxy. Enforce per-IP request/connection
limits, a 256 KiB request limit and authentication endpoint rate limits at that
proxy. The bearer API does not set cookies. Never make wildcard credentialed
CORS an ingress default. Restrict filesystem access to the service account;
startup sets umask 077 and database mode 0600. Protect backups with the same
controls. HTTP logs must not include Authorization, enrollment bodies or proofs.

The Dockerfile builds the service and runs it as the non-root `node` user with
`/data` as its persistent volume. Example (operator must provision the mounted
database before first use):

```sh
docker build -t cordisx-economy .
docker run --rm -p 127.0.0.1:8788:8788 -v economy-data:/data cordisx-economy
```

Do not put SQLite on NFS/object storage, a temporary serverless directory or a
multi-region shared disk. Multiple local workers sharing the same SQLite file
serialize through `BEGIN IMMEDIATE`; network frontends must point at this one
authoritative ledger. Horizontal distributed database support is not implemented.

## Backups, restart and incident recovery

Stop ingress and the service before a filesystem backup; copy the database and
any accompanying WAL/SHM files as one consistent set. Alternatively use SQLite's
online backup API from an operator utility. Never copy only the database from
a running WAL writer. Test restoration in a separate directory and run
`npm run admin -- audit INSTANCE` before accepting traffic.

Restart expires overdue open agreements and atomically refunds all reservations.
Partially committed operations are rolled back by SQLite. All successful keys
and receipts remain queryable. Game servers must retry the identical
idempotency key/body after uncertain responses and read terminal agreement
state before continuing. Pet must replay its saved purchase key and reconcile
the authenticated receipt before applying a local effect once.

Never delete idempotency, grant, entitlement, reservation or ledger rows to
“fix” a client. Restoration of an older backup can rewind previously observed
transactions: stop every consumer, reconcile external fulfillment journals and
publish an operator incident decision before reopening. This implementation
cannot make an arbitrary stale backup equivalent to the lost latest ledger.

## Conditional Sites adapter

The service is not a static site. A Sites deployment is eligible only if its
runtime offers Node 24's SQLite API, a durable single-writer local volume,
long-lived request handling, server-side secrets, bounded requests and TLS.
No Sites project or `.openai/hosting.json` is configured in this repository, and
these capabilities have not been demonstrated here. Therefore the implementation
ships a self-hosting Docker/process adapter and does not claim Sites compatibility
or deploy a transient ledger. A static wallet preview cannot substitute for the
service. If a later Sites runtime supplies an external transactional database,
add an explicit persistence adapter with the same concurrency/recovery suite.
