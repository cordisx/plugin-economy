# Economy HTTP API v1

Implementation owner: `cordisx/plugin-economy`. Experimental, implemented API;
this is the shared service/client contract, not a Host Protocol specification.
TypeScript types: [contracts](../src/client/contracts.ts), [client](../src/client/index.ts).

## Authority and transport

API base is `/v1`. JSON only, 256 KiB maximum body. HTTPS outside loopback.
`Authorization: Bearer <credential>` is required except session enrollment.
Credentials bind one economic instance and either one account or one authorized
service; request bodies cannot switch either. The operator provisions accounts,
service credentials and finite funding sources offline. There is no HTTP admin,
public mint, payment, deposit, withdrawal, or cross-instance transfer endpoint.

Service authorization can bind a particular game ID or explicitly `*` (all games
served by that credential). The latter permits user-published games without a
per-game operator allowlist. Both bind the game version/digest and authority in
the consent hash. `reviewStatus` is descriptive, not an authorization gate or a
promise that the game is fair.

Each mutation below requires `Idempotency-Key: <8–128 printable ASCII chars>`.
Keys are scoped to instance + principal kind + subject, across operations. A
successful response is durably stored in the same SQLite transaction. Reusing
the same key and canonical JSON returns that original response; another body or
operation returns `409 IDEMPOTENCY_CONFLICT`. Keys do not expire. After a lost
response, retry **the same body and key**, then GET current state: a replayed
reservation response is historical and may now be settled or expired. Failed
operations roll back fully and do not consume keys. Do not generate a fresh key
while the previous outcome is unknown. Business identifiers add deduplication
across keys (service + match, source + event, migration entitlement).

## Identity

- `POST /session {code}` exchanges an operator-created, ten-minute, single-use
  enrollment code for `{token,expiresAt,instanceId,accountId}`. Session lasts one
  hour. Enrollment is deliberately not idempotent; a lost response requires a
  new operator login code. This endpoint accepts no account selection.
- `POST /session/rotate` atomically revokes a live user session and returns a new
  session. Same lost-response rule. No automatic rotation retry.
- `DELETE /session` revokes the authenticated credential.
- `GET /me` (user) returns `{instanceId,accountId,available,reserved}`. Never send this credential to a game server, including a server hosted by a friend.

Secrets are random 256-bit credentials, only SHA-256 hashes persist server-side.
No cookies or query tokens are accepted. Renderer clients must use the public
Host secret-reference transport, never config/localStorage plaintext. Browser
origin allowlist defaults empty. Production ingress must enforce TLS, request
rate limits and connection limits; origin checks do not replace authentication.

## Account linking without spend authority

`POST /link-proofs {gameServiceId,gameAccountId}` (user, idempotent) issues
`{code,expiresAt}`: a random opaque 60-second proof bound to the authenticated
economy account, named game service and named game account. The game server
publishes its configured service ID with its economy URL. User confirms both
identities, then sends only this code to the game server.

`POST /link-proofs/redeem {code,gameAccountId}` (that service, idempotent) consumes
it once and returns `{instanceId,accountId,gameServiceId,gameAccountId}`. A wrong
service/account, expiry or repeated consumption returns `403 INVALID_LINK_PROOF`.
Same-key redemption replays the durable response, even after expiry. The code
is never a credential for `/me`, `/reserve` or any wallet operation. Redeeming
proves identity only; each stake still requires direct user confirmation.

## Game agreements and escrow

`POST /agreements` (authorized game service) body:

```json
{
  "matchId": "match-17",
  "game": {
    "id": "gomoku",
    "version": "1.0.0",
    "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reviewStatus": "unreviewed"
  },
  "participants": [
    { "accountId": "alice", "amount": 10 },
    { "accountId": "bob", "amount": 10 }
  ],
  "settlementPolicy": {
    "kind": "enumerated",
    "outcomes": [
      {
        "id": "alice-wins",
        "payouts": [{ "accountId": "alice", "amount": 20 }]
      },
      { "id": "bob-wins", "payouts": [{ "accountId": "bob", "amount": 20 }] },
      {
        "id": "draw",
        "payouts": [
          { "accountId": "alice", "amount": 10 },
          { "accountId": "bob", "amount": 10 }
        ]
      }
    ]
  },
  "expiresAt": 1800000000000
}
```

Example timestamp must be replaced with a future Unix **millisecond** timestamp.
Each participant may include `participantIds: string[]` to disclose all human/Agent seats covered by its aggregated stake. Seat IDs must be unique across accounts and are included in the terms hash. Same-owner human and Agent seats aggregate into one account allocation.

One to eight distinct accounts; positive integer stakes bounded by the service's
operator-authorized maximum. One to 256 enumerated outcomes, each with unique
recipient IDs, nonnegative integer payouts, sum exactly equal to the pot.
Alternatively `settlementPolicy: {kind:"conserved-payouts"}` explicitly authorizes
the owning server to select arbitrary conserved payouts among participants.
This supports poker side pots and final stacks. The wallet must disclose that
the game service controls allocation and that review is not a fairness guarantee.
No fees, outsiders, fractional values, negative values or minting are allowed.
Supply, aggregate pot and amounts are bounded by 1,000,000,000,000 Token.

Response from create and `GET /agreements/:id`:

```ts
type Agreement = AgreementInput & {
  id: string
  instanceId: string
  serviceId: string
  termsHash: string // SHA-256 of canonical immutable terms + authority
  state: 'open' | 'settled' | 'cancelled' | 'expired'
  outcomeId: string | null
  reservations: string[] // account IDs whose stakes were reserved
}
```

GET is allowed only to the owning service and participating users. Reservations
remain listed in terminal states as audit facts, not current frozen balances.
For conserved settlement, `outcomeId` currently stores canonical payout JSON;
ledger entries are authoritative for payouts.

- `POST /reserve {agreementId,termsHash}` (user): user must first see and explicitly
  confirm the instance, service, game version/digest, review state, own stake,
  deadline and exact fixed policy. Only their account is frozen; game service
  credentials cannot reserve. A second key cannot double-reserve that account.
- `POST /settle {agreementId,termsHash,outcomeId}` (owning service, enumerated) or
  `{agreementId,termsHash,payouts:[{accountId,amount}]}` (conserved policy): requires
  every stake reserved and open/unexpired agreement. Atomically removes all
  frozen amounts and credits payouts. Game code returns results; only the
  authorized server selects settlement. Never give its service credential to
  game packages, Agents, clients or renderer JavaScript.
- `POST /cancel {agreementId,reason}` (owning service): bounded identifier reason,
  atomically refunds every existing reservation, including partially funded
  matches. Before expiry, participants ask their game server to cancel. After
  expiry, refunds do not require the game server to be online.

State transitions: `open -> settled | cancelled | expired`. No reopen. Repeated
terminal writes with a new key return conflict; replaying the original key
returns its recorded success. The database checks deadlines under its write
transaction; an independent sweep commits expiry refunds before processing
requests, every second while running, and at restart. Failed late settlement
cannot undo refund. Absolute deadline is immutable, 1 second to 24 hours from
creation. Game server must set its total round/time budget below this deadline
and stop after economic expiration. No in-flight extension exists in v1.

## Wallet, catalog and Pet

- `GET /ledger` returns the latest 200 account entries: `sequence,transactionId,
  accountId,availableDelta,reservedDelta,reason,reference,createdAt`.
- `GET /items` returns `{id,title,price,namespace}[]` from the instance's
  operator-managed catalog. CLI `catalog-import INSTANCE catalog.json` atomically imports the complete owner-provided JSON catalog; CLI `item` registers immutable priced SKUs, such as
  `pet.food.apple` with namespace `pet`. Clients cannot set prices or merchants.
- `POST /orders {itemId,quantity,expectedTotal?}` (user) returns `{instanceId,accountId,id,itemId,quantity,total}`;
  debits balance, credits the shop reserve and records order/inventory in one
  transaction. Quantity 1–100. Wallet/Pet callers should always set `expectedTotal` from the displayed catalog; a mismatch returns `409 PRICE_CHANGED` before debit. Retrying the same purchase key returns the same
  receipt. No public debit-only or arbitrary credit operation exists.
- `GET /orders` returns latest 200 own receipts; `GET /orders/:id` returns one;
  `GET /inventory` returns durable `{itemId,quantity}[]`.

Pet should bind its local fulfillment journal to economy URL + returned
instance/account + order ID. Persist the purchase key before calling; replay
that request after an uncertain response. Apply local effects once, CAS the
journal, and reconcile an interrupted local write via the receipt. The economy
commits the entitlement; Pet owns idempotent consumption/fulfillment. Do not
trust a caller-provided receipt object without retrieving the authenticated
order. No Pet product code is owned here.

## Authorized income and one-time migration

`POST /rewards/grant {sourceId,accountId,eventId,amount}` requires a service
credential explicitly assigned to that reward source. Each source is pre-funded
from a finite issuer reserve by the offline operator. Per-source daily and
per-account daily limits apply atomically; exhausted funding rejects. A normal
game service has no source and cannot grant rewards. Event uniqueness is
`(instance,sourceId,eventId)`, permanently across accounts, credentials,
reinstalls and plugin versions. The same event with another amount/account is
`409 EVENT_CONFLICT`, even with a fresh idempotency key.

Host local usage is partial, potentially spoofed, and never cloud billing
proof. An operator choosing to sponsor such rewards must label that evidence,
authorize a narrow service/source budget, use stable upstream event namespaces,
and exclude unknown/unattributable/game-inference usage. The economy does not
turn untrusted usage into an entitlement and does not expose user reward claims.

Migration is an **operator-approved entitlement**, not a client balance import:

1. Pet preserves a legacy snapshot and SHA-256 digest before conversion.
2. Operator reviews the local proof under an explicit migration policy and
   provisions a finite migration source and entitlement with the CLI.
3. Entitlement ID is a stable original snapshot digest (64 hex characters),
   scoped to the permanent source, bound to the destination instance/account,
   with an operator-approved integer amount. Do not rotate source IDs on reinstall.
4. `POST /migrations/claim {sourceId,entitlementId}` (user) atomically consumes that
   entitlement and transfers funds. No amount or snapshot balance is accepted.
   Replay same key returns success; another key returns `409 MIGRATION_CONSUMED`.
   Successful claims include `instanceId,accountId,sourceId,entitlementId,amount`. Other accounts receive not-found. Local restore never resets server records.

## Failure semantics and hosting

Errors: `{error:{code,message,retryable}}`. 400 invalid inputs/payout/conservation;
401 invalid credentials; 403 wrong authority; 404 inaccessible/missing record;
409 insufficient balance, closed/expired agreement, unfunded match, limits,
business duplication or idempotency conflict; 413 body limit; 503 `BUSY` with
`Retry-After: 1`. 500 returns redacted `INTERNAL` and permits same-key retry;
invariant failures stop mutation. Network loss/5xx may be ambiguous: retry the
identical key/body and consult current GET state. Validation/auth/conflicts are
not retryable without resolving the cause. Enrollment/rotation are exceptions
as documented above.

SQLite WAL + FULL synchronous + BEGIN IMMEDIATE serialize writers across
processes on one persistent local filesystem. Every operation includes account
updates, append-only audit entries, order/reservation/grant state and successful
idempotency response in the same commit. No async work occurs inside a money
transaction. Restart rolls back incomplete commits. This is a single-volume
self-hosting design, not a multi-region distributed ledger. See
[deployment](deployment.md) for backup, restoration and conditional Sites use.
