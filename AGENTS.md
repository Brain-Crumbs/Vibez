# Vibez operating instructions

Read this file, [the constitution](CONSTITUTION.md), the assigned issue,
[migration guidance](migration/SEED_EXPORT.md), and the [roadmap](https://github.com/Brain-Crumbs/Vibez/issues/1).
Inspect affected semantic contracts and consumers before implementation.
Deterministic state and revision-bound evidence govern decisions. Keep roles
independent and preserve historical records.

Use the issue's canonical branch from current main. Inspect existing work and
verify accepted prerequisites before admitting the task. Explicit owner
authorization governs publication and merge. Keep unrelated work outside the
candidate.

MIG-003 is the last implementation under the [reviewed seed protocol](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/50ef51e7dd2443dd0cec644c04e8db1b7fd612f7/migration/SEED.md).
Its acceptance is the reviewed GitHub PR, with the export receipt and exact-head
checks. The active registry begins empty. Historical receipts document accepted
prerequisites. They are not lifecycle state, assignments, or current approvals.
Fixture workloads run in disposable repositories.

Before admitting MIG-004 or later, follow [Vibez admission](migration/SEED_EXPORT.md#next-task-admission).
Verify the accepted MIG-003 PR, sealed commit and CI on main. Use the
project-local `.agent/state` store in a quiescent checkout on a supported local
filesystem. Retain external and pre-native prerequisites as evidence-backed
admission edges. Native tasks use the registry, lifecycle, independent reviews
and controlled completion. The seed exception ends with MIG-003.

Run the [repository checks](README.md#build-and-validate-a-fresh-checkout) and
any task-specific checks. Obtain independent QA, Architecture and UAT/Product
reviews for the final revision. Resolve findings and repeat the affected
checks and reviews after changes. Keep reviewer reports and exact-head
validation in the PR.

Before merging, verify branch, base, head, CI, reviews, discussion, mergeability
and protection. Bind authorized integration to the reviewed head. Only the
native controller can record native MERGED and DONE. Keep credentials, runtime
state, exchange packets and live canary records outside the repository.
