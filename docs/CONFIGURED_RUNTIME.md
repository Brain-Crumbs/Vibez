# Configured project runtime

MIG-004 adds project selection and composition to the private Vibez build.
MIG-005 owns the supported package exports, executable aliases and public
installation instructions. The Fantasy Football consumer continues to use
its pinned source workflow until the separate consumer cutover.

## Prepare a project

Start with a dedicated Git checkout on local disk and one worktree. Set the
configured remote to the project's GitHub repository. On Windows the host
must verify local NTFS outside synchronized folders. On Linux the runtime
checks the filesystem type. Nested repositories, alternate Git directories,
network shares and synchronized state are unsupported. Keep runtime roots
outside tracked inputs and ignore them in Git.

1. Copy the shape of the [Alpha](../examples/alpha/vibez.config.json) or
   [Beta](../examples/beta/vibez.config.json) example into a host input
   object. Select project-owned task, requirement, contract and context-policy
   paths. Keep the context-policy file a tracked JSON object. It identifies
   the context input and cannot relax role visibility or lifecycle rules.
2. Call `previewProjectInit(projectRoot, "vibez.config.json", document)`
   from the private build's `dist/project-config/index.js`. Check the
   reported destination and contents. Call `initializeProjectConfig` with
   those same arguments to create the file exclusively. A repeated create
   returns a conflict. Commit the config and all referenced inputs.
3. Construct a trusted host and call `doctorProject(location, host)`.
   Doctor validates project identity, configuration, task dependencies,
   referenced requirements and contracts, storage and executor availability.
   It does not initialize the runtime directories or run validators.
4. Call `createProjectServices(location, host)` and use its services or
   `services.cli(args)`. The host supplies the absolute checkout root and
   the project-relative config path. Commands use the same registry and
   configured stores regardless of the caller's working directory.

The location has this shape:

```js
const location = {
  projectRoot: absoluteCheckoutPath,
  configPath: "vibez.config.json",
  verifyLocalStorage: verifyLocalNtfsOutsideSync,
};
```

The Windows storage callback is a trusted deployment check. The runtime calls it for the checkout and existing ancestors of runtime roots. The host should check the actual volume and sync policy before returning true. In a fixture,
the callback may attest to its known local test volume.

## Supply a host

A host owns credentials and binds adapter implementations to one repository.
Use a stable `identity` for the adapter versions and policy revision.
`hasCredentialReference` checks whether a configured credential reference is
available. Resolve the secret inside the adapter, outside tracked config.
Never put credentials in validator commands, command output, or policy data.

For a non-Node consumer, register the executable and arguments under the ID
used in the config. An absolute Python executable on Windows can be used
directly even when its path contains spaces.

```js
const host = {
  identity: "team-host@1",
  executors: new Map([
    ["python-test", {
      command: absolutePythonExecutable,
      args: ["-m", "unittest", "discover", "-s", "tests"],
      category: "test",
    }],
  ]),
  hasCredentialReference: id => credentialReferences.has(id),
  integration: {
    repository: "example/beta",
    publication: githubPublication,
    pullRequests: githubReadiness,
    ci: githubChecks,
    merge: githubControlledMerge,
  },
};

const report = await doctorProject(location, host);
if (!report.ok) throw new Error(report.message);
const services = await createProjectServices(location, host);
const status = await services.cli(["--json", "status"]);
process.stdout.write(status.stdout);
```

The existing `GitHubPullRequestOperations`,
`GitHubMergeReadinessPullRequestOperations`, `GitHubCiStatusOperations` and
`GitHubControlledMergePullRequestOperations` are available to trusted hosts
through the private build. Read-only hosts may supply adapters that report
unavailability when called. Publication, merge and recovery each require
separate host callbacks. Merge authorization binds the exact repository, PR
number and head SHA immediately before the merge provider call. Credentials
and a configured remote do not confer write authority.

For the npm profile, pass `npmValidatorCommands(absoluteNpmCliJs)` as
`executors`. This registers the Alpha profile's `node-build` and
`node-test` executors and uses Node to run npm's JavaScript entry point.
The command executor does not invoke a shell. Use an optional
project-relative `cwd` to run in a contained subdirectory.

The built-in `local-manual` provider uses the configured exchange root.
Configured `manual export` and `manual run` read request files beneath the
intake root. `manual import` reads beneath responses. The exchange argument
must identify the configured exchange directory. Other providers are
resolved by ID from `host.providers` and must cover the required roles and
timeouts. BOOT-037 remains the owner of the operator driver.

## State and compatibility

Configured status, diagnostics, validation, reviews, rework, PR, merge and
recovery use the same project identity and registry. A task's project
requirements and contracts come from Git at the exact source revision.
Packaged contract hashes identify library-owned inputs. A conflicting
contract ID fails closed. Task records and the `ipt.*` evidence schema
versions retain their existing identities.

The project identity record is host-local in the selected checkout's Git
directory. A task's first authorized assignment also binds its input
identities. Tracked product files and affected project contracts within the declared task scope can change between Developer start and validation. Later role packets read those contracts at the candidate revision. The original Developer invocation and review evidence keep their own revision identities. Changes to the config, host, requirements or contracts outside the task scope stop affected work before stale evidence or an old operation is reused. Preserve the binding
files with the corresponding state when diagnosing a stopped run.
After configured state is bound, the legacy executable refuses to open
that checkout implicitly. Legacy source-checkout factories remain available
for explicitly unconfigured hosts. Explicit low-level schema injection is
for trusted adapters and tests. The configured graph always uses package
schemas.

The supported storage model requires a trusted local operator and a single
worktree. Runtime directories are checked at entry and again at guarded
writes. Do not move roots or change links, mounts, permissions, or Git
configuration while a writer is active. Existing native task and operation
locks still govern simultaneous requests in the same configured checkout.

The configured retry baseline is immutable. An exhausted infrastructure
attempt can receive a separate host-authorized increase through
`services.orchestration.increaseRetryBudget(grant)`. Supply the same
task, owner, run and idempotency key, the execution-binding digest, the
observed attempt counts and a trusted authorization reference. The grant
appends an immutable hashed record while holding the run-store lock. The
host rechecks authority before retrying. The ceiling is ten attempts per
stage. Semantic review failures still use the bounded rework gate.

## Rollback

Stop configured writers, provider sessions and validation processes.
Retain the config, Git binding files, state, evidence, exchange and operations
directories. Record their paths and hashes before changing binaries. Restore
the exact prior compatible package, host identity and committed config. Run
doctor and status and verify they read the original history. If the binding
or a stored version differs, keep the store untouched for quiescent
compatibility reconciliation. The config-aware executable rejects implicit access to a bound checkout. Keep pre-MIG-004 executables out of bound checkouts because they predate that check. Moving or adopting
historical state is covered by [the compatibility plan](COMPATIBILITY.md).

## Verification

`npm test` includes a separate package-shaped directory and two Git consumers
without local schemas. The fixtures cover literal arguments, configured
state and manual exchange, exact-revision Developer and review contexts,
diagnostics and recovery, rejected setup and path escapes, and a resumed
provider attempt with a host-authorized budget. The independent delivery
reviews for MIG-004 are recorded separately in its PR.
