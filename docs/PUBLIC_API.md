# Supported package boundary (API v1)

Vibez is an ESM TypeScript/Node package with explicit exports and matching
declarations. `@brain-crumbs/vibez` is the approved GitHub Release package identity.
See [installation](INSTALL.md) and the [release decisions](SUPPORT.md). No wildcard exports, `src/`, `dist/`, or undocumented deep imports
are supported. No CommonJS guarantee in v1. Internal modules remain separate.

## Capability exports

The following is the deliberate supported list. Named existing interfaces keep
their producer/consumer meanings and associated request/result/error/port types;
MIG-005 must enumerate those types in declarations without exporting unrelated
implementation helpers. The [machine map](https://github.com/Brain-Crumbs/Vibez/blob/b64ac4e1fa19c03d379245ad8bce6d384ecaf601/migration/capabilities.json) covers
all 24 source modules, source contracts, current tests and downstream test owners.

| Subpath | Supported capability and principal API | Semantic boundary |
| --- | --- | --- |
| root (`.`) | `createProjectServices(location, host)`, `doctorProject`, `describeCapabilities` | One graph; construction/inspection does not start a run or create state |
| `./config` | `ProjectConfigV1`, `ResolvedProjectConfig`, `resolveProjectConfig`, `previewProjectInit`, `initializeProjectConfig`, `ConfigError` | Shape, containment and identity checks before writes |
| `./assets` | `getAssetCatalog`, `readSchema`, `readContract`  | Immutable installed bytes, declared versions and hashes; no remote lookup |
| `./registry` | `loadTaskRegistry`, `loadTaskRegistryFromPaths`, `discoverTaskDefinitionPaths`, `validateDependencyDag`, `resolveDependencyDag`, `selectNextEligibleTask`, `explainTaskEligibility` | Complete valid registry or error; native dependencies require genuine DONE |
| `./lifecycle` | `createLifecycleRecord`, `transitionLifecycle`, `getTransitionRule`, `FileAssignmentLockStore`, `GitBranchLifecycleAdapter`, `LocalGitBranchOperations` | Pure transitions plus explicit lock/Git ports; no bypassing owning gates |
| `./context` | `compileRoleContext`, context/artifact types and `ContextCompilationError` | Role visibility and semantic dependency projection stay intact |
| `./validation` | `ValidationExecutor`, `DeveloperValidationGate`, validator resolver/spec/result ports | Required checks, persisted exact-revision evidence, read-back before transition |
| `./evidence` | `FileEvidenceStore`, evidence/store ports and currency queries | Append-only history, exact schema/version and revision binding |
| `./review` | `ReviewFramework`, `QaReviewGate`, `ArchitectureReviewGate`, `UatReviewGate`, `ReviewReworkGate`, context-source ports | Actual independent judgments, complete context, legal rework; no self-approval |
| `./workflow` | `DeveloperStartWorkflow`, `SequentialOrchestrationEngine`, `FileOrchestrationRunStore`, `parseOrchestrationRunJournal`, orchestration ports | Start/validate/review/rework/readiness/merge delegated to existing owners |
| `./providers` | `AgentProvider`, `AgentRunner`, `AgentProviderError`, `FileManualAgentProvider`, packet/result types | All five roles and PASS/FAIL/BLOCKED remain reachable; transport is not approval |
| `./integration` | `PullRequestLifecycleAdapter`, `MergeReadinessPolicyEngine`, `ControlledMergeController`, their Git/GitHub/CI operation ports and concrete GitHub adapters | Canonical PR, current checks, exact head, separately granted merge authority |
| `./diagnostics` | Status, diagnostics and recovery ports, plus `readProjectAudit`, `checkProjectUpgrade`, `verifyHistoryBackup` and `historyCompatibility`, plus `prepareNativeHistoryRelocation` and `activateNativeHistoryRelocation` | Read-only checks and explicit host-owned activation for verified stopped native history |
| `./cli` | `runCli`, `CliRunContext`, `CliRunResult`, `OutputEnvelope`, `EXIT_CODES` | Stable command/exit/JSON behavior; no parsing human output |

Low-level port types needed for custom providers, stores, validators, context
sources and GitHub implementations are public under the owning subpath.
Factory internals, schema evaluator internals, filesystem locks/tokens, render
helpers, fake providers, memory stores, and test fixtures are not public defaults.
The root graph exposes named configured services for registry, lifecycle reads,
start, validation, context, evidence, QA, Architecture, UAT, rework, provider,
orchestration, PR, CI, readiness, controlled merge, status, diagnostics and
recovery. Callers do not construct child local factories with competing roots.

The declaration at each subpath specifies the named exports and port types. Use
`describeCapabilities()` for the installed package and API versions, CLI
envelope version and command support. The optional `apiVersion` and
`packageVersion` requirements check exact matches before starting work.

## Full lifecycle and CLI

Supported library chain: validated tasks/DAG → selection → assignment/canonical
branch/context → Developer → deterministic validation → required QA/Architect/UAT
→ legal rework or MERGE_READY → canonical PR/current CI → readiness → authorized
controlled merge → MERGED/DONE → idempotent reconciliation. Diagnostics and
read-only status remain usable at blocked stages. Recovery never fabricates a gate.

Preserve `agent` as the executable alias for compatibility; `vibez` is the equivalent standalone name. Current commands: `help`/`--help`/`-h`,
`version`/`--version`/`-v`, `next`, `status`, `start <owner> <run>`,
`validate <task> <actor> <run>`, `explain task|validation|reviews|merge <task>` or
`explain transition <request>`, `manual export|run <request> <exchange>`,
`manual import <packet> <result> <exchange>`, and `recovery check|apply <request>`
(`check` takes no request). Top-level `review` and `rework` remain reserved.
`orchestrate` exposes the accepted manual workflow driver implemented by #78
and integrated by MIG-006; see the [installed driver guide](WORKFLOW_DRIVER.md).
`--json` retains the v1 envelope, one stdout object, progress separately, and exit
codes 0/2/3/4/70. Successful transport/observation is not semantic PASS.

## #78 driver and #75 application-service agreement

These are migration-side integration contracts. Fantasy Football #78 is accepted,
and MIG-006 integrated its manual workflow driver into Vibez. #75 retains
ownership of planning and approved plan publication. AUT-003 implements the
shared application-service operation supervisor in the configured project graph;
future #75 HTTP callers use this same service. There is no separate HTTP or CLI
supervisor. Incompatible proposals require a reviewed contract revision.

| Consumer | Inputs from Vibez | Consumer owns | Must preserve / integration proof |
| --- | --- | --- | --- |
| FF #78 / MIG-006 | Resolved project graph, capability catalog, validator/provider IDs, revision-bound task context, gate/store ports | Reusable operator profile, intake/clarification, atomic registration, inbox/handoff/repair session and watch loop | Profile references this config's path + digest; cannot override identity, validators or role policy. One source of config. Full issue→packet→response→rework→PR/CI→authorized merge journey |
| FF #75 application service | Same configured graph plus `services.operations` and typed outcomes | Planning conversations/versioned plans, exact approval/publication, later HTTP adapter | Planning does not execute; approved plans enter the shared operation service; no duplicated scheduler or state machine |
| AUT-003 | Configured graph, original run identities and `ScopedHostPolicy` | Shared `WorkflowOperations` service, unattended dispatch and reconciliation | CLI and future HTTP delegate to the same implementation and native gates; no HTTP prerequisite |

Profile stores operator preferences and selected config reference/digest. Per-task
request stores task/owner/run/idempotency identity, exact source and authorized
scope; it cannot silently replace configuration. Supervisor operations retain
their own stable IDs and map to original engine identities, with repository-wide
writer exclusion. Read models distinguish operation state from task lifecycle,
include provenance/time/currency, bound artifact reads, and redact secrets.
Authorization for plan publication, execution, PR publication and exact-head merge
is distinct; existing grants need no redundant confirmation. HTTP/local security,
planner implementation and the HTTP adapter remain #75's work. The installed
`workflow` export exposes operation types and the supervisor; ordinary hosts use
`createProjectServices(location, { ...host, unattended })` and call
`services.operations`. The trusted host supplies approved plans, grant policy,
isolated worker, integration transport and drain attestations. Issue Markdown and
CLI callers cannot inject those capabilities. See the workflow guide for controls.

The integration export also provides ScopedHostPolicy, parseHostGrant,
scopedAgentProvider, scopedValidator, scopedMergeEffect and
verifyGitHubProtection. The configured ProjectHost accepts mergeEffect
alongside its existing exact-head authorization callback. Their host trust
and persistence requirements are in [the unattended host guide](UNATTENDED_HOST.md).

Use the [installed manual workflow driver](WORKFLOW_DRIVER.md) for guided setup and manual role handoffs.

## Installed acceptance host

The packaged [AUT-004 host and collector](UNATTENDED_ACCEPTANCE.md) compose these
public services from an independently installed artifact. They add no domain
engine or new supported ESM subpath. The preparation script performs local
setup with controls disabled; remote setup and enabling require the original
scoped authority. Consumers may continue using the existing manual APIs.
