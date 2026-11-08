# MIG-002 extraction boundary and evidence

Inventory source: `Brain-Crumbs/IPTFantasyFootball` at
`50ef51e7dd2443dd0cec644c04e8db1b7fd612f7` (accepted MIG-001 merge).
The separate engine/tooling pin remains
`fbc46888ce0bd2af454f471561911a913d32e6fc`, private
`@iptfantasyfootball/control-plane@0.1.0`, lock hash in the
[admission receipt](admissions/mig-002.json). The engine source and runtime schemas
are unchanged between these pins; MIG-002 exports neither.

MIG-001 is the only direct prerequisite and has no implementation prerequisites.
Its accepted main merge, PR head, independent review identities/hashes, CI run
and fetched evidence bytes are recorded in the receipt. Original local handoff
artifacts were compared to their published hashes; no lifecycle/approval store
is copied. The historical PR text still says 'not merged'; current GitHub merge
facts supersede that stale handoff sentence. Native MERGE_READY is not DONE, and
this external admission does not assert controlled completion in Fantasy Football.

The destination had no refs or open PRs. Three fresh agents checked the exact
empty root `5ac4a575cc4748f6e5c4623456002e4962241722`, empty tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`, intended remote and exception before
its non-force publication to main. [Anchor reports](anchor-reviews/anchor-qa.json)
are historical publication evidence, not approval of the later design revision.
The canonical design branch is `migration/mig-002-boundaries-and-contracts`.

## Inventory interpretation

[inventory.json](inventory.json) has one explicit entry for **every one of 289
tracked files**, including 24 source modules, runtime schemas, contracts,
scripts, tests/helpers, CI, docs, tasks and prior migration material. Each entry
records exact source path/blob/hash, category, action, destination, implementation
owner and downstream test owner. Git blob hashes use original repository bytes,
not checkout line-ending conversions. New/deleted source paths require a new
inventory revision; broad globs never authorize an unreviewed export.

- `vibez`: planned library-owned code/assets or reusable tooling/docs. `copy`
  means preserve bytes during MIG-003; `adapt` needs a separately recorded
  transformation and destination hash, especially package/CI/governance.
- `consumer`: retained source project definitions and evidence/review layout
  guidance; consumers author their own task/requirement/contract/config inputs.
- `test-example`: reusable automated fixtures/rehearsals only. Canary-specific
  tooling must stay a test/example; no active CANARY-001 definition is installed.
- `historical`: retained in Fantasy Football, accessed through immutable Git
  links; `source:` destinations mean no destination copy. MIG-001 staged plan
  stays historical; future task admission is separately reviewed.

Schema/contract design standards and engine contract manifests belong to Vibez;
project business contracts belong to consumers. `contracts/examples` are test
examples. The source currently has no fantasy product implementation. Ignored
`.agent`, credentials, build output, dependencies and worktrees are never exports.
Rights remain unresolved; an inventory `copy` is a design decision, not current
redistribution permission. MIG-003 must stop before source copying until the
rights decision in [SUPPORT](../docs/SUPPORT.md) is satisfied.

## Acceptance-to-evidence map

| MIG-002 | Evidence and validation |
| --- | --- |
| AC-01 | Complete per-file inventory; exact source comparison; capability/CLI map and all nine #74 criteria in capabilities.json |
| AC-02 | PUBLIC_API.md full lifecycle, adapter seams and #75/#78 shared graph; independent semantic Architecture review |
| AC-03 | PROJECT_CONFIG.md + strict schema + two consumer examples; shape checks and UAT walkthrough; runtime tests owned downstream |
| AC-04 | COMPATIBILITY.md preserves records/CLI/adapters and defines version rejection, upgrade and rollback |
| AC-05 | SUPPORT.md decision owners, criteria, unresolved rights/name/channel and required support matrix |
| AC-06 | SOURCE_DELTAS.md and source-deltas.json; final checkpoint and ownership transfer gates |

PR review evidence must bind the final candidate SHA, with QA/Architecture/UAT
reports from separate agents and exact-head `Design contracts (ubuntu-latest)`
and `Design contracts (windows-latest)` CI checks. Reports/check outputs are PR
evidence; this table is a mapping, never an asserted test result.

The staged `migration/tasks/mig-002.task.json` and requirement preserve issue
scope/criteria. The receipt records the expanded seed-only allowed paths and
applicable validation commands. No active registry or runtime state exists here.
The checker validates shapes and graph through pinned source tooling; it does
not admit tasks or launch a selector. MIG-003 retains this accepted PR/head/merge,
review/CI hashes as a pre-native prerequisite receipt. Before MIG-004, the seed
exception ends and normal native admission/review/controlled completion applies.

## Remaining ownership

FF #37/#1 still own bootstrap authority reconciliation. MIG-002 does not declare
cutover, resume the stopped canary, implement #76/#78, or close the parent epic.
The next source-export task must also satisfy rights and source-delta gates;
finishing MIG-002 alone cannot make every downstream step executable.
