# Source deltas and end of duplicate ownership

[source-deltas.json](source-deltas.json) is an append-oriented decision ledger,
not task status. It distinguishes observed source integration from issue closure.
The inventory baseline is the accepted MIG-001 merge. The workflow code still
matches the engine pin; #76's contract-bearing UAT repair is not assumed present.

For each delta retain a stable ID, source issue/PR and exact commit, source
path/blob/SHA-256 list, reason for a source exception, destination owner/PR/commit,
transformed destination paths/hashes, compatibility impact, validation/review
evidence and pending/imported/excluded/superseded disposition. Nulls mean unknown
and block an imported claim. Corrections append a superseding entry with reason;
never silently change an accepted row. MIG-003 implements the reproducible
compare/import tool and fills exact paths/hashes before importing. This task
records the format and known outstanding work only.

FF #78 remains the sole general manual driver owner. MIG-006 imports that accepted
implementation once, translating the reusable profile to the shared config.
MIG-003 checks #76's actual accepted source fix and regression; closed issue state
is insufficient. If it is still absent, obtain the owning fix through its issue
and record its accepted delta rather than quietly repairing it in extraction.
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
