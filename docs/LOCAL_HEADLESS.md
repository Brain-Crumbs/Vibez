# Local headless role execution

Vibez supports fresh offline role invocations through the neutral
`AgentProvider` boundary. The tested runtime is llama.cpp `b12477` with
Qwen3-4B-Q4_K_M and Bubblewrap on x64 Ubuntu 24.04, including WSL 2. Use
Node 22 or 24 and a local ext4 checkout and operations directory. The
inference process uses the CPU. No provider account or network credentials
are required. The existing manual adapter remains available on the
supported package platforms.

## Prepare the trusted host

1. Obtain the Ubuntu x64 [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases/tag/b12477)
   and verify its published SHA-256 before extracting it to a host directory.
   Install Bubblewrap and libgomp from the signed Ubuntu archive or use
   the same verified files in a private tools directory. Verify that ordinary
   users can create mount, PID and network namespaces. Disable any fallback
   launcher that runs the binary outside those namespaces.
2. Obtain the [pinned GGUF model](https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf).
   The tested model SHA-256 is
   `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
   Keep all binaries, libraries, model bytes and invocation records outside
   the project. Give only the host authority over these paths.
3. Supply `LocalLlamaAssets` with canonical absolute paths for the verified
   launcher, extracted llama.cpp directory, Ubuntu library directory and
   model. Pin launcher, `llama-completion` and model SHA-256 values, plus
   runtime and model names. List each required shared library separately
   with its directory (`runtime` or `dependencies`), filename and SHA-256.
   Pins are verified before every launch and only the listed files are
   mounted. Keep both asset and OS mounts separate from the repository
   and operations directory.
4. Use `createLocalLlamaRuntime` from `@brain-crumbs/vibez/providers` and
   pass its runtime to `scopedAgentProvider` in `./integration`. The
   operation directory must be private, on a supported local filesystem,
   outside the repository, and shared by all incarnations of that project
   host. Register the resulting provider as `local-llama.cpp` with existing
   configured services. Supply trusted \`actorIdFor\` and
   \`toolPermissionPolicyFor\` mappings on \`ProjectHost\`. Increment the host
   identity if the implementation or policy changes. Assign a distinct principal to Developer, QA,
   Architect and UAT/Product. The native controller retains merge authority.

```ts
const { runtime } = await createLocalLlamaRuntime({
  repositoryRoot,
  projectIdentity,
  operationDirectory,
  assets,
  contextTokens: 16_384,
  outputTokens: 768,
  snapshotPaths: selectApprovedCommittedTextFiles,
  editablePath: selectOneApprovedDeveloperFile,
  replaceFile: trustedSingleFileEffect,
  runValidator: existingIsolatedValidator,
});
const provider = scopedAgentProvider(policy, runtime, { maxTurns: 1, maxCostMicros: 0 });
```

The runtime validator port uses the existing trusted isolated executor.
Configured native validation resolves commands through `ProjectHost.executors`.
Use isolated launcher commands for validators that run repository code.


## Scope and result binding

Each invocation starts one fresh process with the owning gate's compiled
context. With `snapshot.read`, the trusted host may include the contents of
approved tracked files at the invocation revision. Developer may receive
`workspace.replace` for one existing approved file in that snapshot.
The model proposes replacement text through the structured response.
Only the host's scoped effect can apply it. The runtime rechecks the
current grant, checkout, branch and revision immediately before the effect.
The host must use a synchronous, exclusive source-ref fence for that
one authorized file. Return \`COMMITTED\` with the exact resulting revision,
or \`ROLLED_BACK\` after settling without a commit. The runtime verifies the
single parent, changed path and exact bytes on Git HEAD before recording a
completed edit. A late effect never returns PASS. Reviewers
receive no replacement capability. For an invocation that produces a
commit, use the old revision for the invocation record. Native validation
and later reviews use fresh contexts for the actual resulting HEAD.

The Bubblewrap process sees the approved runtime and local model, a
transient private prompt file and private OS namespace surfaces. It has
no worktree mount, host home, credentials, shell tool or network access.
Tool names are checked against the scoped role and the request's denied
tools. Use host-approved contexts and files without secrets. The adapter
refuses common credential shapes and role-message delimiters cannot
be passed as model control tokens. Raw diagnostics and model reasoning
never enter result or execution records.

The output binds a digest of project, configuration, task, role,
actor, run, invocation revision, gate context and exact tool scope.
It must end normally, match the binding and validate all fields before
the runtime constructs a neutral result or accepts an edit. Existing
runner and review gates still validate and record the role judgment.
The provider record has no approval or merge authority.

## Budget, interruption and rollback

A run consumes one policy turn, uses one process and has one positive
deadline of at most 180 seconds. The pinned local profile enforces the
context and generation limits and uses six CPU threads. The runtime
requires zero metered provider cost. It rejects cloud use, unsupported
tools and larger allocations before launch. The host still charges the
reserved time and turn through the normal durable policy ledger.

The versioned intent and exclusive lease are durable before launch.
Journal mutation is serialized across local host processes. An incomplete
mutation remains blocked. Preserve those records and inspect the affected
operation offline after all original writers are stopped.
The attempt identity and binding cannot change on retry. A terminal
response is reused from the private journal. An uncertain launch,
termination or workspace effect leaves the original attempt reserved.
The launcher acknowledgement and process-exit observation establish
normal termination. If either is unavailable, the runtime retains a
quarantined lease and blocks another invocation. The caller may see the
runner deadline elapse before this teardown completes.

Inspect the intent and terminal records in the host operation directory.
Stop or drain the original worker and confirm any workspace effect at the
original revision before retiring an unresolved attempt. The trusted
host can call `retireDrainedAttempt` with that attempt's exact binding
and independently verified drain. This preserves the intent and terminal
record. The host policy's separate reservation also needs its documented
reconciliation. Never use a new attempt, provider or manual inbox for
an unresolved original binding. After confirming there are no active
writers, a newly authorized compatible workflow can select the manual
adapter. Keep all old runtime records and approvals under their original
identities.

## Rehearsal and conformance

Run `npm run build` and
`node scripts/rehearse-local-llama.mjs /absolute/path/to/verified-assets.json`.
The script invokes configured \`services.orchestration.run\` in a
disposable consumer. It launches Developer and the three reviewers, then records the resulting developer revision and
checks actual validation and reviews through the native gates. It ends
at `MERGE_READY` in that disposable checkout with no remote integration.
It provides real provider evidence for the bounded task. The independent
feature reviews and actual delivery CI run separately.

Run `node --test tests/local-llama-provider.test.mjs` for deterministic
transport and protocol fault coverage. The transport double is limited to
those fixtures.
