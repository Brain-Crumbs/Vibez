# Compatibility and rollback contract

The first extraction preserves all existing `ipt.*` schema IDs, exact supported
record versions and meaning. It also preserves `control-plane.*` module IDs,
historic task/run/review identities, CLI envelope version 1, evidence currency,
retry accounting and semantic PASS/FAIL/BLOCKED distinctions. Branding is not a
data migration. Package semver, module contract versions and data schema versions
are separate identities and are recorded independently.

| Surface | Compatibility rule | Proof owner |
| --- | --- | --- |
| ESM API/types | Explicit supported subpaths only; removal, narrowed range, changed error/result meaning or required port is breaking even if it compiles | MIG-005/008 |
| CLI | Existing `agent` arguments, aliases, exit codes and JSON envelope remain; new commands additive; no false success for reserved commands | MIG-005/006 |
| Schemas | Resolve exact ID, reject missing/unsupported versions; patch cannot change validity/meaning, minor only backward-compatible supported additions; breaking shape/range/identity needs major | MIG-007 |
| Persisted state/evidence | No rewrite/rebinding of journals, approvals, attempts or append-only history; older reader support must be explicitly declared | MIG-007/009 |
| Provider/store/validator adapters | Preserve role isolation, abort/idempotency, required ranges, atomicity and declared capability/error semantics; no concrete vendor in domain | MIG-004/006/008 |
| Configuration/context | Versioned schema plus content/policy/package binding; changed identity rejects resume; full contract catalogs retain semantic visibility | MIG-004/007/008 |

No blanket same-major acceptance: readers explicitly declare minor/patch support.
Unknown versions block before writes/provider dispatch. Missing assets/config
must produce actionable errors, not fallback into the old source checkout.
MIG-007 implements compatibility inspection and fixtures for historical records,
unknown versions, changed configuration, overlapping task IDs and stopped runs.

## Upgrade and consumer cutover

MIG-008 proves the actual tarball in a clean second consumer, imports/types/CLI/
assets/full manual journey and Windows/POSIX failure cases without either source
checkout on module resolution paths. MIG-009 pins the immutable version/checksum
in Fantasy Football and rehearses adoption. Stop all engine, watcher, direct gate
and external provider writers first; record their verified quiescence. Prefer
completed runs; stopped historical runs may remain read-only quarantined with
original identities. No forced completion or rebinding of CANARY-001.

Snapshot config and state/evidence byte hashes plus old/new package and lockfile
identities. Run read-only compatibility/preflight, then enable only one engine.
Same-project binary upgrade is distinct from repository extraction: source
assignments and approvals never move into Vibez. If any active writer or unknown
format remains, abort the upgrade without advancing anything.

## Rollback window and conditions

Proposed bounded window: at least seven calendar days after MIG-009 adoption and
one accepted ordinary feature task through the installed engine, whichever is
later. MIG-009's maintainer records the exact start/end and accepted evidence;
MIG-010 cannot delete the dormant implementation before that gate. This is a
removal condition, not an authorization to execute an extra task now.

Rollback stops/drains writers, checks that the previous binary/config supports
every record written since cutover, and restores the exact prior dependency,
lockfile and configuration. Preserve all new evidence/journals; never restore a
stale runtime snapshot over newer history. If the old reader cannot read new
records, leave the store quarantined and use an explicitly reviewed forward
repair/migration rather than destructive downgrade. Rehearse both compatible
rollback and refused incompatible rollback in MIG-007/009.

For MIG-002 itself, revise design before extraction or revert only this design
PR. Keep the empty anchor, prior Git decision versions, evidence and unresolved
rights. No engine/store was moved or upgraded by this task.
