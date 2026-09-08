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

## Unified experimental SDK checkpoint

An intermediate wallet/portable preparation pinned Host
`5101d6ec25409a65d939fb4214b4144a5eb672df` and Protocol
`465c444c65eec1be8e337b94c2cf658ed536f49c`. The provider's Host tarball
SHA-256 is `638477682bf0de2ce2ba5c1b6f793ffbc46b4e238324b17ba39fcb28e8164dc2`.
Wallet typecheck/build, all six wallet tests and development dry-run passed.
Two independent native launches on this candidate failed with
`CordisX Vite bootstrap timed out: CDP request timed out: Runtime.evaluate`.
The manager requested this tested dependency checkpoint be kept for shared
integration, with native validation pending Host diagnosis. The successful
transaction exercise above belongs to the older explicitly identified Host;
it must not be attributed to this candidate. No further native retries are
planned until the provider supplies a targeted fix or diagnostic direction.

## Portable provider checkpoint

The earlier portable checkpoint pinned Host `1d2636adbe239550fd70e3e82d4b43681a800833`
and Protocol `465c444c65eec1be8e337b94c2cf658ed536f49c`. Its Host package
SHA-256 is `fbb47a38f3dc31b1db8ffd78b8b182dae1f01ed9de5c07c27f290af95e92a274`.
The owner preparation script invokes that exact Host's portable SDK builder
without first installing its checkout. It verifies recorded Git inputs, all
package hashes, and the expected Host/Protocol checkpoint hashes; CI retains
raw packages, file lists, checksums and `sdk-evidence.json`, including on failure.

This follows diagnosis of the earlier H510 mismatch: Linux and local direct
packages were byte-identical; all 2,057 file contents matched the initial provider
package, with only `dist/src/cli.js` permission 0644 versus 0755 differing.
The provider now fixes executable permissions and bundles complete, verified
Channel/CLIProxy/Protocol dependencies from exact sources. The new consumer
incremental `npm install` completed in four seconds without recursive Git prepare.
Wallet typecheck/build, all six tests, lint/format and development dry-run passed.
Fresh Linux reproduction is tracked in PR #1. Native interaction on this
checkpoint remains pending; the Mac was locked and no native restart was made.
Provider packaging success and consumer checks do not imply a passing full Host
gate, formal compatibility, merge or release.

## Shared Protocol checkpoint

The current wallet pins Host `69b0146c4d4b6acd411758ae4ec3005ea74d0b89`
with unchanged Protocol `465c444c65eec1be8e337b94c2cf658ed536f49c`.
Host package SHA-256 is
`42f655ad735fd430e6f455bbb2e8da31f5eb564c247a3c31bbb1e9774df131c4`.
The Host no longer bundles a second Protocol module. One consumer override
points every Protocol edge to the wallet's exact Protocol tarball. A regression
check resolves the public HTTP type contract and Agent avatar runtime contract
from both Host and wallet and requires the same real file paths. No type casts
or skipped library checks conceal separate module identities.

One incremental normal npm install completed in three seconds. Wallet
build/typecheck, all seven wallet tests, format/lint and development dry-run pass.
The scoped Protocol/Channel/CLIProxy npm dependency tree passes and is retained
by CI. An unrestricted npm tree check also traverses the linked Economy parent:
it reports the existing shared ESLint Git metadata and React peer-range issues;
a globally clean dependency tree is not claimed. Linux cold reproduction is
attached to PR #1. Native validation is still pending; no native app was started
while the Mac remained locked.

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
