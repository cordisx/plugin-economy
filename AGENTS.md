# Repository guide

Product code and product documentation belong here. Read docs/architecture.md before implementation.
Read the owning Mono rules before development: https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/README.md
Before styles or style-bearing DOM changes read https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/css.md (use the local Mono copy when available).
Use dprint for formatting and the shared ESLint max-lines policy. Keep source modules cohesive and below 1000 lines.
Use only public CordisX contracts. Report a missing Host capability rather than using private DOM, globals or bridges.
Keep secrets and local databases out of Git. Never execute uploaded game JavaScript in a trusted Host renderer or use node:vm as a security boundary.
Separate implemented, tested, live-verified and accepted claims. Tests must exercise actual behavior and failure paths.
