# Architecture checkpoint — 2026-09-09

## User-approved scope

The source requirement is manager task 01a08270-8be3-7fa3-a46d-c47e67efd2f1. The user authorized full implementation and independent parallel tasks.
This is a turn-based game platform, not a hard-coded poker app. Users publish versioned game UI and rule packages, create rooms, and friends load the same game without installing a dedicated CordisX plugin. Server-authoritative execution; no local authoritative alternate mode.
Multiple independently hosted servers are simultaneous data sources. The lobby aggregates room cards and filters by game/source/vacancy/Agent allowance. No global current-server context. Scope identity by server and account; pin game and protocol versions per match.
Top-level navigation: lobby, my Agents, dispatch center. History belongs in personal pages; data-source management belongs in settings. Match the native Host header. No separate game-selection tile section, no duplicate active-Agent banner above the right Agent panel.
An Agent can be dispatched to someone else's room using an isolated seat context through AgentLoop. Agents are declared, scoped and budgeted; cannot read another seat or call wallet mutation arbitrarily.
Modes: score-only, match-local chips, shared entertainment Token coins. These coins are virtual; no fiat, deposits or cash withdrawals. Unreviewed user games MAY use Token coins after explicit version/rules/review-state/stake/result-policy disclosure and join consent. Review status is descriptive, not a mandatory allowlist. Runtime safety and escrow bounds always apply.
Game author code cannot mint funds. Platform fixes stakes and settlement policy before the match; game returns result, economic service applies conserved, idempotent settlement. Token economy is shared with Pet; separate economic instances do not automatically exchange assets.
Initial acceptance: Gomoku and Texas Hold'em; open and hidden information; rule package versioning, client isolation, two-user join, resume, timeout, replay, Agent dispatch, multi-source compatibility and Token-to-Pet spending. Self-hosting is first-class; Sites is a conditional deployment adapter, not a core dependency.

## Ownership

Manager owns cross-repository coordination and integration. Product owners modify only assigned directories. Public Host-contract gaps go through cordisx-protocol then Host; business game protocols stay here. Do not change another checkout or existing user preview.

## Delivery status

This is the agreed architecture input, not proof of implementation, runtime support or user acceptance.
