# Repository guide

Product code and product documentation belong here. Read docs/architecture.md before implementation.
Read the owning Mono rules before development: https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/README.md
Before styles or style-bearing DOM changes read https://github.com/cordisx/cordisxmono/blob/main/.agents/rules/css.md (use the local Mono copy when available).
Use dprint for formatting and the shared ESLint max-lines policy. Keep source modules cohesive and below 1000 lines.
Use only public CordisX contracts. Report a missing Host capability rather than using private DOM, globals or bridges.
Keep secrets and local databases out of Git. Never execute uploaded game JavaScript in a trusted Host renderer or use node:vm as a security boundary.
Separate implemented, tested, live-verified and accepted claims. Tests must exercise actual behavior and failure paths.

## Operation notifications

Use the public `ctx.notifications.show()` service for operation feedback and
require `notifications` in plugin injection. Do not create a custom Toast,
manually positioned alert, or page-wide success/error paragraph. Keep field
validation and durable business state beside the relevant object. Use stable
semantic `kind` values, localized safe text, and notification rules owned by Host;
never expose raw exceptions or notify on every polling attempt.
See the [Host notification guide](https://github.com/cordisx/cordisx/blob/3158c0401a3f604727f623f1a8ac584017dd8540/.agents/docs/notifications.md)
for the interaction contract and older-Host capability boundary.

The notification migration currently uses exact feature-branch SDK/Protocol
revisions; it is not evidence of a formal release or a Mono pointer upgrade.

Candidate notification SDK setup: [notification migration](./.agents/docs/notifications.md).
