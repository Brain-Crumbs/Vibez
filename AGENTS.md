# Vibez operating instructions

Read this file, [migration/README.md](migration/README.md), the assigned issue and
[roadmap #1](https://github.com/Brain-Crumbs/Vibez/issues/1) before changing files.
The inherited architectural invariants are the [source constitution at the audited
revision](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/50ef51e7dd2443dd0cec644c04e8db1b7fd612f7/CONSTITUTION.md).
Deterministic state outranks narrative; roles are independent; semantic consumer
contracts, exact revision evidence, idempotency and controlled completion remain
mandatory. No product work, arbitrary workflow graphs or synthetic DONE records.

MIG-002 is a pre-native design task under the accepted
[seed procedure](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/50ef51e7dd2443dd0cec644c04e8db1b7fd612f7/migration/SEED.md).
The owner assigned exactly the next eligible task, publication and merge after
independent QA, Architecture and UAT plus required CI. The earlier MIG-001
instruction to stop at a ready PR applied to that prior assignment only.

Use the exact canonical branch in the issue, based on current main. Inspect
existing work; never overwrite it. Read every prerequisite's accepted evidence.
Staged definitions are not assignments or selector input. Preserve source
history and stopped canary records. Do not copy runtime state or approvals.

For this task run the design checks in the README and the pinned engine's full
build, tests, schema/contract and adversarial checks. Destination CI must check
the PR head SHA, including the source inventory and pinned schema tooling.
Require three distinct role agents to inspect the final revision. Fix findings,
rerun affected checks and reviews after every revision, and retain reports with
their exact SHA in the PR. Developer self-review is not independent approval.

Before merge, re-read branch/base/head, required exact-head checks, all reviews,
unresolved threads, mergeability and any repository protection. Merge only the
reviewed SHA within the owner's grant; never bypass protections. This seed PR
acceptance is not a native lifecycle transition. Do not manufacture lifecycle
records to represent it. MIG-003 records its historical prerequisite receipt.
MIG-004 and later cannot use the pre-native seed exception.
