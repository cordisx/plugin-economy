# Verification record — 2026-09-09

Implementation, simulation, native interaction and user acceptance are separate.
This record describes the owner delivery on `codex/shared-economy`, not a release
or permission to merge/deploy. Exact head and CI runs are attached to PR #1.

## Service and client

Seventeen behavior tests exercise the actual SQLite service and public typed HTTP
client: insufficient funds, price mismatch, free SKUs, permanent target-bound
receipts, duplicate/conflicting idempotency keys, grant namespaces/limits,
unauthorized game credits, forged service identity, instance/account isolation,
conserved settlement, partial funding cancellation, expiry/refund recovery,
one-time migration, enrollment/rotation and audience-bound link proofs. Sponsor HTTP tests also verify source/target identity, guarded instance mismatch, finite budget exhaustion, UTC daily reset and success after retrying an earlier failed key.

Separate OS processes race distinct and identical purchase keys. Only one debit
is committed; identical requests recover the same order. A worker is SIGKILLed
inside a debit transaction, and the recovered database has neither the debit nor
its audit entry. SQLite supply checks pass. These are persistent on-disk tests.

The offline CLI imported the complete Pet owner catalog: 229 SKUs, including 34
zero-price SKUs, without maintaining a second catalog here. Pet owner separately
exercised the real client, HTTP service and SQLite: game winner balance 200,
180-Token feeder purchase, remaining 20, lost-response/local-write recovery,
migration and cross-account rejection. Its exact evidence belongs in Pet's
integration test and owner handoff.

## Wallet artifact and lifecycle

The maintained beta.2 generator and `cordisx/vite` create a formal browser ESM
graph. Artifact tests verify every indexed byte length and SHA-256 digest,
initial CSS absence, dynamic page imports and lazy CSS. The packed wallet keeps
the complete entry/chunks/CSS/artifact set. Six wallet tests cover activation,
localized contract keys, artifact shape/integrity, origin confinement, opaque
HTTP references, abort/revoke cleanup and late-authorization disposal.

`cordisx dev --dry-run` resolves the source entry through launcher-owned Vite.
Real isolated native startup reached CDP renderer ready. Initial development
caught two integration mistakes (Cordis inject declaration and invalid mixed-case
locale keys); both were fixed and activation coverage was added.

## Native temporary-account exercise

Native executable: `/Applications/ChatGPT.app`, renderer `app://-/index.html`.
Host experimental commit: `4fb60431564931441927c474dd35188f6596274b`; its shared
tarball SHA-256 is `3cdbeb591c7087b6262a13a84ffd994f6435dc164b74342d1cebf5a4a1aeb560`.
Protocol types: `8adc1aab908263e692bd56ca6165b9aeadabe4b9`.

An independent profile and CORDISX_HOME were used. The Host's public Manager
policy controls granted this plugin the Manager navigation/body points. The
actual wallet body appeared beneath one Host-owned header, with no duplicate
page chrome. On the older baseline Host, connection controls were disabled with
an honest capability message. After a development source update the active body briefly remained blank; navigating away and reopening restored it. This is not proof of seamless installed replacement.

The new Host's masked credential prompt authorized the fixture origin. The
wallet retrieved and displayed `native-fixture / alice`, available 100 and
reserved 0. It displayed game version/digest, unreviewed state, game-service
identity, both of Alice's human/Agent seats, the aggregate 10-Token stake,
deadline, fixed outcomes and terms hash. Activating the explicit reserve control
produced an independently verified service balance of available 90/reserved 10.
The authorized game fixture settled the disclosed winning outcome; native
refresh displayed available 110/reserved 0 and terminal agreement/ledger state.
The native link-proof form also produced a code redeemed by the correct game
service/account. No user economy bearer was sent to a game server.

All credentials and balances in this exercise were generated fixture data.
Screenshots and private fixture credentials remain in ignored local artifacts;
none are part of the product package. The public Host transport owns secrets;
this evidence does not inspect or dump the user's Keychain.

## Unverified and conditional

- No production user data, real gameplay UI, native Agent execution or live Pet
  animation was exercised by this owner; those have their respective owners.
- Installed-generation replacement and complete light/dark/responsive/focus
  matrices are not claimed by artifact or development tests.
- Dockerfile exists, but the available machine's Docker daemon was not running;
  container runtime verification remains outstanding. The Node service is real
  and exercised through HTTP and persistent process tests.
- No Sites runtime with a durable SQLite volume was demonstrated. There is no
  Sites deployment or static-site substitute for the authoritative service.
- No merge, deployment, formal compatible set or user acceptance is implied.
