# Project configuration v1 (specification)

[project-config.schema.json](specs/project-config.schema.json) describes the
tracked, non-secret project document. It is a new `vibez.project-config@1.0.0`
specification; it does not rename existing `ipt.*` records. Unknown fields and
versions reject. MIG-004 owns the resolver and complete service injection;
schema tests in MIG-002 prove only shape, not safe filesystem behavior.

## Inputs, precedence and authority

1. The trusted host selects an explicit config file and physical project root.
   Library callers pass them explicitly; CLI selection will be `--project` plus
   `--config` (MIG-005). No traversal to a parent project or source-checkout fallback.
2. Read the tracked config from the exact task revision. A reviewed setup may
   prepare it before execution, but no active request binds uncommitted inputs.
3. Apply only the schema's documented defaults (v1 requires all policy fields,
   so there are no hidden policy defaults). Project paths are relative to the
   selected root, never the process working directory or config-file directory.
4. Inject host services by ID: validators, providers, credential resolver,
   authorization, Git/CI adapter and filesystem services. Host policy may narrow
   the project request, never elevate an agent's requested permissions. Missing
   ID/capability or contradictory policy fails before any mutation.
5. A run request may select only an admitted task and bounded operational values.
   No environment variable or request overrides a tracked root, branch policy,
   validator/review requirement or provider binding. Legacy environment adapters
   must translate explicitly to host inputs and diagnose conflicts. Secrets are
   resolved at call time by host reference; never included in config, evidence,
   logs, error text, packets or digests.

The host credential map resolves names such as `github-main` to an environment
variable or secure store outside tracked config. The project file contains only
the name. A name is not authorization or a token. Validator command arrays are
host-registered by `executorId`; generated task text cannot supply shell commands.
The effective validator and review sets are the union of required project and
task declarations. Hosts may add checks or roles but cannot remove a task's
required ones. A selected provider must support that complete set. Retry/rework
budgets bound coordination; they never authorize retrying a terminal judgment.

## Physical identity and paths

`project.id` is a stable explicit ID, `repository` the canonical owner/repo, and
`worktree.id` an explicit stable local binding label. The resolver canonicalizes
the real Git common directory and worktree root (including Windows case and
symlink/junction resolution). It verifies the configured remote repository
identity and records the actual root and worktree binding in host-local metadata.
Copied config cannot turn another repository into the same writable project.

Durable identity is a tuple of repository identity, project ID and canonical
Git common directory; the checkout identity adds worktree ID and canonical root.
Task/run/packet keys remain their existing formats *inside* that scoped store.
No cross-project state scan or global lookup by task ID. Within one repository,
multiple worktrees must share a host-registered coordination root and single
writer policy; until explicitly supported/tested, simultaneous writers in
multiple worktrees are rejected. Merely choosing a different state directory
must not bypass that exclusion. Moving a checkout needs quiescent rebinding, not
silent identity regeneration or a pretend new run.

| Content | Resolution and mutation rule |
| --- | --- |
| Package schemas and engine semantic contracts | Resolve from installed package URL/catalog, with package version and content hashes. Read-only; never search cwd, consumer schemas or a sibling checkout |
| Task definitions, requirements, project contracts and context policy | Resolve configured relative paths in selected Git worktree at exact commit; reject absent/untracked/dirty content before certifying it |
| State, evidence, exchange, inbox/outbox, operation storage | Resolve explicit project paths through host-approved roots; initialize only on authorized mutation, not construction/status/diagnostics |
| Credentials | Host resolver only; no filesystem discovery or serialized secret |

Before writes, canonicalize existing ancestors and validate future children;
reject absolute/drive/UNC inputs, `..`, symlink/junction escapes, package-root
targets, root aliases into another project, and overlapping writable roots.
Requirements/contracts/tasks must not overlap writable roots. State/evidence/
exchange/intake/responses/outbox/operations must be pairwise disjoint. Host must
reject reuse of any root already bound to another project even with identical
task IDs. Recheck containment/binding at IO boundaries; schema regexes alone do
not prevent races or symlink escapes. MIG-004 and MIG-008 tests must prove
rejections make no provider calls or unauthorized writes.

## Graph and semantic contract discovery

`createProjectServices` resolves once, then supplies one registry, one lifecycle
store, shared evidence store, assignment/branch operations, context source,
validator resolver, required-role policy, provider runner, run store, PR/CI
policy and recovery authority to every gate. The orchestration/CLI/application
service receive that graph. Child factories may not reconstruct defaults or
consult cwd. Package assets cannot be overwritten by project path settings.

The package catalog indexes schema ID/version and engine contract ID/version,
relative package URL, SHA-256, source provenance and known-consumer metadata.
Context composition adds package contracts from the exact installed artifact
alongside project contracts/requirements read at the task commit. Record both
package digest and project revision in the context manifest. An ID collision
with different bytes is an explicit conflict, not last-writer-wins. Same-byte
duplicates may be deduplicated. Project authors declare dependency contract IDs;
they do not copy package contract files into their own repository.

Architect receives full affected/upstream contracts and downstream consumer
requirements/ranges. Developer/QA retain their narrower visibility. UAT retains
outcome scenarios and QA/Architecture evidence; the artifact catalog must still
be complete for gate compilation, including #76's contract-bearing regression.
Validate producer outputs against consumer accepted ranges *and* consumer-required
reachability. Structural typing alone cannot prove this.

## Hashes, currency and resume

Canonicalize config JSON recursively by object key, retain array order, reject
lossy values, and SHA-256 the UTF-8 encoding. `configDigest` covers the complete
non-secret document and config schema version. A separate execution binding
covers engine/package digest, asset catalog hashes, configDigest, host adapter
IDs/versions and policy digest, physical identities, and exact project/task/
requirement/contract/validator revisions. Secret values are excluded; credential
reference IDs and policy version are included.

Same-key resume compares this binding and the original task/owner/run/context.
Changed inputs reject with a conflict and legal recovery/rework guidance, never
overwrite a journal or reuse stale approval. Developer output may retain its
invocation revision while deterministic validation and later reviews resolve the
new HEAD; this is the existing deliberate exception, not permission to rebind a
review. Explicit host authorization for the exact PR/head is an out-of-band
operational grant, not a replacement config digest or agent-owned approval flag.
Budget increases need an audited host decision under existing engine limits;
attempts never reset. Timeouts/cancellation stop waiting, not necessarily external
tools; drain gates and verify quiescence before recovery.
