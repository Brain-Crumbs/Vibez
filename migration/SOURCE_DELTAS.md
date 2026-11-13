# Source deltas and end of duplicate ownership

[source-deltas.json](source-deltas.json) is an append-oriented decision ledger,
not task status. It distinguishes observed source integration from issue closure.
The inventory baseline is the accepted MIG-001 merge. The appended #76 row
identifies the accepted Fantasy Football repair and the sealed Vibez import.
The original pending row preserves the earlier observation.

For each delta retain a stable ID, source issue/PR and exact commit, source
path/blob/SHA-256 list, reason for a source exception, destination owner/PR/commit,
transformed destination paths/hashes, compatibility impact, validation/review
evidence and pending/imported/excluded/superseded disposition. Nulls mean unknown
and block an imported claim. Corrections append a superseding entry with reason;
never silently change an accepted row. See the [seed verifier](SEED_EXPORT.md)
for the reproducible source and destination comparison.

FF #78 delivered the general manual driver. [MIG-006](https://github.com/Brain-Crumbs/Vibez/issues/6) integrates its accepted changes once, translating the profile to shared project configuration. The [BOOT-037 path receipt](mig-006-driver-import.json) accounts for the exact source delta. Reusable driver fixes belong in Vibez after this integration.
MIG-003 imports #76 from the accepted [Fantasy Football PR #84](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/84).
The ledger records its six source and destination paths with the exact hashes.
#75 retains planning/publication/application service and supervisor semantics;
its HTTP transport is not a migration prerequisite.

MIG-008 owns the final synchronization receipt: compare the latest authoritative
source main to the inventory/export pin, enumerate **all** path changes including
new files, reconcile #76/#78 and other accepted fixes, verify each reusable delta
is imported exactly once or explicitly excluded with accepted rationale, rerun
installed parity and independent reviews, and record destination SHA plus actual
tarball digest. Missing deltas or unresolved parity block release/cutover.

After this accepted checkpoint all reusable implementation changes land in Vibez;
Fantasy Football receives exact dependency updates. A subsequent urgent source
exception must reopen the checkpoint with linked accepted delta and revalidation,
not create indefinite dual maintenance. MIG-009 performs the pinned consumer
cutover with one authoritative writer and the recorded rollback window.
MIG-010 alone removes the allowlisted dormant duplicates after acceptance and
window gates; preserve project input, runtime history and archive links.
