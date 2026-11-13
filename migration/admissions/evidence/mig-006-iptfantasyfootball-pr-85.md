Closes #78. Refs #1, #74, and Brain-Crumbs/Vibez#6.

A maintainer can prepare an issue from Markdown, select its task, copy the emitted role handoff into a fresh session, and drop the result into the inbox. The driver resumes the same run and delegates validation, reviews, PR readiness, and completion to the existing gates. Publication and ready conversion are explicit operations; a fresh merge requires host authorization for the exact repository, PR and SHA.

| Issue acceptance | Evidence |
| --- | --- |
| Guided setup; stdin and folder intake; clarification | Actual CLI setup and stdin/folder tests. Schema, dependency and committed-source checks precede assignment. Explicit issue fields are preserved; clarification replay restores the same registration and request. |
| Self-contained role, clarification and repair handoffs | Copy-ready Markdown with compiled context, exact schema and filled bindings. Independent Windows operator walkthrough used the emitted correction packet and an arbitrary inbox filename. |
| Automatic import; malformed, partial, duplicate and stale drops | Two-observation capture, immutable adapter publication, receipts, and lost-receipt replay. Rejected responses leave the pending role available. |
| Actionable errors and rework | Bound diagnostics, same-request recheck, immutable terminal review results, audited validation reset, and linked successor with the original assignment. |
| Durable restart and next task | Serialized scan/advance, request and packet preservation, checked registration and merge intents, completed reconciliation, and a distinct request for the explicitly selected dependent task. |
| General CLI and task selection | Discoverable `orchestrate` commands and versioned profile/session schemas; two independent fixture task IDs/branches, actual dependency gate, and declared review subsets. |
| Validation and contract-bearing review | Real repository validator and review gates, actual Developer HEAD and unchanged transport binding, nonempty requirements and dependency contracts, and UAT at the correct declared stage. |
| PR, CI, authority and recovery | Canonical draft, separate ready conversion, pinned remote and exact SHA, failing/pending CI and withheld grant, lost response and exact authorized reconciliation. Tested rejection of an additional push destination before and during lookup. |
| Compatibility and operator documentation | Unchanged manual packet/result and CLI envelope; Windows paths, PowerShell/POSIX examples, source and journal compatibility, and stop/preserve rollback in [the operator guide](docs/WORKFLOW_DRIVER.md). |

The end-to-end tests use real Git and local gates with fixture GitHub. They are distinct from the independent reviews of this implementation. The operator still opens fresh role sessions, enforces the displayed permissions, and supplies publication, ready and merge authority. No cutover or retired canary completion is asserted.

Validation

- Windows: full suite passed 879/879 on the review baseline. Re-ran the affected CLI publication and clarification cases as the follow-up fixes landed. Build and both Python schema checks passed on the final source (59 authored records).
- Adversarial mutation check detected both weakened guards (self-approval and changed pre-merge head).
- Independent QA, Architecture, and UAT each approved exact head `f02e12ac3cb9f407b257e46f09e29bdb8995b26f`. QA independently reproduced and then verified rejection of remote destination drift and hidden Git URL rewriting. UAT exercised stdin/folder intake, bound repair, restart, contract-bearing reviews, and the dependent task handoff in a disposable checkout.
- GitHub CI is required on the exact PR head before merge.