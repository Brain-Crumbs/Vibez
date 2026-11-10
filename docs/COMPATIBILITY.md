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
MIG-007 adds the read-only inspection and backup verification below.

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
## Inspect a checkout and its evidence

From the original checkout, use the read-only commands below. For a configured
project invoke them through its host CLI, or call the same operations directly
from `@brain-crumbs/vibez/diagnostics` with an explicit location. The direct
inspection API is usable while an older package still holds the project binding.

```sh
vibez --json audit DEMO-001
vibez --json upgrade check 0.1.0-mig007.0
vibez --json upgrade check 0.1.0-mig007.0 quiescent
```

```ts
import { checkProjectUpgrade, readProjectAudit, verifyHistoryBackup } from
  "@brain-crumbs/vibez/diagnostics";

const location = {
  repositoryRoot: absoluteProjectRoot,
  config: { configPath: "vibez.config.json", verifyLocalStorage },
};
const audit = await readProjectAudit(location, "DEMO-001");
const check = await checkProjectUpgrade({
  ...location,
  targetPackageVersion: "0.1.0-mig007.0",
  quiescence: { localWritersDrained: true, externalSessionsDrained: true },
});
const backup = verifyHistoryBackup(absoluteBackupRoot, runtimeLayout, check.snapshotSha256!);
```

Omit `config` only for an original unconfigured checkout using `.agent/state`.
The legacy CLI observes exchanges at `.agent/state/manual-exchange`.
For any other legacy exchange, pass its project-relative path in
`legacyExchangePaths` to the inspection API and include that directory in the
protected backup. Exchange paths outside the project require separate operator
verification. The legacy CLI cannot discover external provider sessions.
`quiescent` asserts both checks were verified by the operator. The programmatic
request keeps the two attestations separate. CLI envelope success means the
inspection ran. Read `compatible`, `findings` and `authority` for its decision.

The audit projects lifecycle transitions in original order, including rejection
and rework, and links exact evidence sequences to their task and revision. The
evidence rows distinguish validation, independent role judgment and controlled
merge. Evidence currency is a storage observation. A superseded judgment may
still explain a historical event. The audit never grants approval or changes
which evidence a gate accepts. Provider exchanges and run checkpoints appear
as observations even when they report PASS. Free-form payloads, role context,
provider messages, paths, credentials and model reasoning are excluded. Opaque
actor, run, provider, event and lineage identifiers are displayed as correlation
digests. Use audit for shareable output. Existing operator-local status retains
the original ownership identifiers. Keep the private originals available to
authorized operators.

Configured and native gate writes associate the exact evidence lineage, sequence
and content digest with a versioned sidecar under the operations or legacy state root. The installed package manifest, optional
host-verified artifact SHA-256, project identity, configuration/policy digests
and provider identity describe the recording environment. For historical
records without a matching receipt, the audit reports an unknown engine. The
observing package version cannot establish the historical writer version.
A provider dispatch receipt can precede a result and carries no gate authority.
If the evidence write completes before its receipt can be published, the audit
reports unknown provenance rather than inferring a writer. Files remain local and writable by the account that controls
the checkout. Digests detect corruption where there is a recorded comparison.
Keep protected copies if an independent integrity reference is required.

The compatibility manifest is exported as `historyCompatibility`. It lists exact
package readers and the separate API, CLI, evidence, lifecycle, assignment,
configuration, manual exchange, recovery and orchestration versions. MIG-006
still owns the general driver and its future session formats. An unrecognized
reader or record blocks the upgrade. A known older reader refuses any history
containing the historical duplicate validation label that this version can
read. For supported historical collisions, the original label is retained and
the two attempts are distinguished by ordinal, revision and exact evidence
sequence.

## Stopped-writer backup and handoff

1. In the original checkout record the package/lockfile, verified artifact
   checksum, config revision, policy and host pin. Verify this is the same
   repository, worktree and path layout. Keep the original configured
   `.git/vibez-project.json` and task binding markers with the protected backup
   and record their hashes separately. The report includes the current binding
   digest when present.
2. Disable restart paths for the CLI, any service, watcher, scheduler or direct
   gate invocations. Close them and independently verify no runner still holds
   a state writer. End external role sessions and verify they can no longer
   publish responses. A timeout, stale lock age, absence of a lock, or an empty
   packet directory cannot establish that external work ended. Handle retained
   tokens through the exact-version audited recovery procedure. Reconcile
   pending packets against their original provider and identities only after
   external work has ended.
3. Run the incoming reader from a separate installed location as a **read-only**
   process against the original checkout. Require `compatible: true`.
   Keep the read-only report and its runtime snapshot digest. Copy the
   configured state/evidence/operations/exchange/intake/responses/outbox roots
   to an access-controlled backup with the same relative layout, or copy
   `.agent/state` for unconfigured state. Retain any separately selected
   unconfigured exchange directories as additional protected backups. Preserve
   all original evidence, receipts, lifecycle and ownership history. Compare
   the backup and a restore into an empty staging directory with
   `verifyHistoryBackup` using the recorded digest. Also compare the exact
   separate config, marker and lockfile hashes. Recheck the original using
   `expectedSnapshotSha256`, `expectedConfigDigest` and
   `expectedBindingSha256` and `expectedTaskBindingsSha256` as applicable
   before changing the engine pin.
4. Install the verified target using its exact dependency and lockfile.
   For configured storage, the old marker includes an engine binding that
   intentionally rejects the new package. With all writers still disabled and
   the marker hash still matching the report, archive the exact old marker
   under a new protected filename outside the runtime roots. Move only that
   single marker out of its active path. Keep the task bindings and all runtime
   files. Validate target configuration and inspect status using the incoming
   host. Enable only the incoming writer. Its first authorized operation claims
   the active marker using the existing exclusive binding protocol. Never
   remove a marker to resume an unfinished run or change its inputs.
5. Keep the source reader and original records available read-only throughout
   the rollback window. If a reader cannot open the store or the evidence hash
   comparison fails, stop and retain the original bytes. A failed transition
   before the target writer first claims the marker can restore the exact
   archived marker while all writers remain drained.

For rollback, repeat the quiescence and verification steps against the **latest**
runtime snapshot, with the older version selected as the target. Keep every
record added since upgrade. Archive the outgoing marker, restore the exact prior
lockfile/config/marker in the same checkout, and verify status using the pinned
prior reader before enabling it. An incompatible result requires retaining the
current reader or an independently reviewed forward repair. Restoring an earlier
runtime snapshot over newer history would lose evidence. Backup restoration is
for a verified offline copy or exact disaster recovery with separate operator
authorization.

Preserve a stopped unfinished store, including retired CANARY-001, as an
access-controlled read-only archive with its original checkout, binary,
configuration, and paths. The preflight blocks in-place upgrade while unsettled
state remains. An operator who needs a new active store must establish separate
project storage under the consuming project's admission rules. Inspect the
archive without starting tasks, changing bindings, importing results or making
historical approvals count in the new store. Copying source code to another
repository never transfers its operating state or approvals.

### MIG-007 acceptance evidence

| Criterion | Regression coverage |
| --- | --- |
| AC-01 | Shipped source-version fixtures and the legacy duplicate writer pattern preserve original lifecycle and evidence bytes. |
| AC-02 | Audit correlates exact-revision transitions, evidence, provider attempts and configured recording provenance. |
| AC-03 | Unknown format, changed config/storage binding, stale task inputs and missing evidence references refuse continuation. |
| AC-04 | Nonempty snapshot, backup and staged restore compare all runtime hashes. Prior-reader compatibility rejects the historical collision. |
| AC-05 | Presence of writer tokens or unfinished exchanges blocks, in addition to the independent drain confirmation. |
| AC-06 | Exports omit free-form content and distinguish immutable evidence from observations. |
