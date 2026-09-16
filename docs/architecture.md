# Architecture checkpoint — 2026-09-09

## User-approved scope

The source requirement is manager task 01a08270-8be3-7fa3-a46d-c47e67efd2f1. The user authorized full implementation and independent parallel tasks.
This is a turn-based game platform, not a hard-coded poker app. Users publish versioned game UI and rule packages, create rooms, and friends load the same game without installing a dedicated CordisX plugin. Server-authoritative execution; no local authoritative alternate mode.
Multiple independently hosted servers are simultaneous data sources. The lobby aggregates room cards and filters by game/source/vacancy/Agent allowance. No global current-server context. Scope identity by server and account; pin game and protocol versions per match.
Top-level navigation: lobby, my Agents, dispatch center. History belongs in personal pages; data-source management belongs in settings. Match the native Host header. No separate game-selection tile section, no duplicate active-Agent banner above the right Agent panel.
An Agent can be dispatched to someone else's room using an isolated seat context through AgentLoop. Agents are declared, scoped and budgeted; cannot read another seat or call wallet mutation arbitrarily.
Modes: score-only, match-local chips, shared entertainment Token coins. These coins are virtual; no fiat, deposits or cash withdrawals. Unreviewed user games MAY use Token coins after explicit version/rules/review-state/stake/result-policy disclosure and join consent. Review status is descriptive, not a mandatory allowlist. Runtime safety and escrow bounds always apply.
Game author code cannot mint funds. Current terminal policy fixes each user’s reserved principal before the match; the signed decision captures at most that user’s principal and releases the remainder. No cross-wallet payout or game Token income is supported. Token economy is shared with Pet; separate economic instances do not automatically exchange assets.
Initial acceptance: Gomoku and Texas Hold'em; open and hidden information; rule package versioning, client isolation, two-user join, resume, timeout, replay, Agent dispatch, multi-source compatibility and Token-to-Pet spending. Self-hosting is first-class; Sites is a conditional deployment adapter, not a core dependency.

## Ownership

Manager owns cross-repository coordination and integration. Product owners modify only assigned directories. Public Host-contract gaps go through cordisx-protocol then Host; business game protocols stay here. Do not change another checkout or existing user preview.

## Delivery status

This is the agreed architecture input, not proof of implementation, runtime support or user acceptance.

## Local wallet authority candidate — 2026-09-13

The canonical economic Store and income arithmetic do not require Native login. Current managed source-account identity does. The local authority extension enrolls a persistent Host profile/realm Ed25519 public key against the existing canonical user account through a jointly verified original-account/new-key proof. Subsequent local session and actual work observations resolve that registered key to the original account. Source aliases and display profiles cannot select or replace wallet identity. Missing or revoked aliases fail closed; existing balances, receipts, agreements and immutable work scope remain in place.

Local delegation revocation retires only credentials issued through that alias. Remote Native credentials retain their existing independent lifecycle. Host profile, permission and runtime caller retirement fence local opaque handles; Native cloud-account refresh does not assign a different local wallet. Consumers cannot submit mint amounts, raw observations or account IDs. The Host reads classified root-work usage and signs it using the pinned local authority. Existing Pet-history and no-catch-up gates continue to govern issuance, independently of balance reads.

This section describes an independent source candidate, not a deployed or accepted local authority. Protocol/Host formal contracts and verified consumer integration precede runtime adoption.

The server explicitly opts in with `ECONOMY_LOCAL_WALLET=1` and the existing private source-account/work-income trust files. Local enrollment and account results use the original source-account server key; local work uses the original work-income server key. Source IDs may differ, but origin/instance and the local profile subject must identify one canonical realm. Auth/session/work use the same persistent authority alias; enrollment alone does not create an account or income frontier. A fresh original Native-pinned connection must identify the prior saved immutable wallet before enrollment. Only the explicit `local-wallet-not-enrolled` result permits that automatic initial enrollment. Revoked, prepared/submitted, keychain, network and owner errors preserve state and never fall back.

Multiple explicitly original-owner-verified profile keys may delegate to the same existing account. Each subject/key/account mapping stays immutable, revocation remains per delegation, and the existing one-account work-scope restriction is unchanged. A new profile can read that original wallet but cannot rebind its work scope.

## Terminal local spending — 2026-09-14

[Local spending](local-spend.md) supersedes historical financial mutation and timeout-refund behavior. The original R28 wallet, actual Host usage issuer, work scope, ledger, receipts and pending audit remain intact. This source candidate requires the normal public Host walletSpend provider contract; runtime installation and deployment are separate.
