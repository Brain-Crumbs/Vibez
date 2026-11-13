# Installed manual workflow driver

Install the exact verified private tarball using [Install](INSTALL.md). This
guide applies to both `vibez` and the compatibility alias `agent`.

Bracketed names such as `<intake>` and `<operations>` below refer to
the corresponding configured paths, relative to the selected checkout.

## Configure the selected checkout

Commit one [project configuration](CONFIGURED_RUNTIME.md) and its task,
requirements, contracts and context-policy directories in a dedicated local
Git checkout. The installed `examples/alpha/vibez.config.json` is a starting
point for an npm project. Set its project repository, branch and remote,
required check names and roots to match the consumer. For offline setup
and intake, set `providers.credentials` to an empty list. Use
`github-main` with a host-supplied token when credential availability
is required on every invocation. Track an empty marker in
an empty task or contract directory. Ignore the configured writable roots in Git.

Use `--project` to select the checkout and `--config` to name its tracked
configuration when it differs from `vibez.config.json`. The standalone host
supports npm build and test executor IDs `node-build` and `node-test`. If npm
cannot be discovered beside Node, supply `--npm-cli` with its absolute JS path.
On Windows, first verify that the checkout and runtime roots use local NTFS
outside synchronized or redirected folders, then add `--local-ntfs`. Keep
these options on subsequent commands. A trusted library host can supply its
own executors and storage verification through `createProjectServices` and
invoke the same command through `services.cli(args)`.

Run the profile setup once. These choices bind the external role identities
and their allowed tools. Use a fresh independent session for each reviewer
and enforce tool restrictions in that session.

```text
vibez orchestrate init --actor-prefix maintainer --developer-tools read_file,write_file,git_commit --review-tools read_file,run_test --enforce-policies externally
```

The profile is bound to the committed config digest. It uses configured
intake, response, outbox and exchange paths and writes its sessions, archive,
receipts and recovery records below `<operations>/driver`. The configured
state/evidence and orchestration stores remain authoritative. Leave existing
profiles and bindings intact when resuming.

## Prepare or select a task

Paste issue Markdown via stdin or save it and use `--issue-file`:

```sh
vibez orchestrate prepare --stdin < 'selected issue.md'
vibez orchestrate prepare --issue-file 'selected issue.md'
```

```powershell
Get-Content -Raw -LiteralPath 'selected issue.md' | vibez orchestrate prepare --stdin
```

You can also drop a `.md` file in the printed issues inbox and run
`orchestrate watch` (add `--once` for one scan). Wait for two scans at least
500 ms apart when using `--once`. Write to a temporary suffix then rename to
`.md` or `.json` after saving. Ordinary saves are accepted once two observations
match. A paused slow copy that looks stable can produce one rejection for those
bytes; the completed file is processed independently.

Use these exact headings, with `- none` for an intentionally empty list. Do not
omit required information. `Issue` can be a number or the complete issue URL
for this repository. Point requirements and contracts at already committed
project records; the driver does not create arbitrary artifacts from prose.
This example is for an isolated consumer fixture with no earlier eligible
task. Check `orchestrate next` on the actual checkout; the retained canary
definition is untouched and is not approval to run or change the old canary.

```markdown
# Deliver the documented output
Task ID: DEMO-001
Canonical branch: feature/demo-001
Issue: #101

## Objective
Deliver the documented marker for the operator.

## In scope
- marker.txt
## Out of scope
- Changing the workflow engine
## Dependencies
- none
## Allowed paths
- marker.txt
## Requirements
- DEMO-001-R1
## Acceptance criteria
- The operator sees the exact requested marker.
## Validation plan
- npm run build
- npm test
## Affected contracts
- control-plane.cli-shell
## Required review roles
- Developer
- QA
- Architect
- UAT/Product
- MergeController
```

Incomplete input emits a clarification handoff. Copy its `.diagnostic.json.md`
into a fresh chat and save the proposed response to the response inbox. It
contains the original issue, task schema, binding and response template. Do
not guess missing dependencies, issue metadata or requirements. Review the
proposal before saving it. It cannot make itself eligible or authorize a run.

The driver retains original Markdown and source hash, checks the proposed task
through the registry, DAG and context compiler, and stages it under `<operations>/driver`
before exposing the complete definition. Registration writes a Git commit
using an isolated index, then advances the exact clean local integration ref and
restores only the committed definition into the checkout. It does not push or
assign. Interrupted registration is
reconciled by presenting the identical input again. Do not commit unrelated
changes or switch the integration branch during registration. Same-input
preparation reuses the session. Changes to existing issue content, task ID or
branch are conflicts, not replacement permission.

For an already committed task definition use
`orchestrate select DEMO-001 --issue-number 101`. Use `orchestrate next` to
inspect eligibility. `run SESSION` starts only if that task is the unchanged
deterministic next choice. Dependencies are satisfied only by native evidence,
not by issue closure. `status` lists prepared sessions; `status SESSION` shows
the original request, pending packet, last diagnostic and stage evidence.

## Run, review, and resume

1. Start `orchestrate watch SESSION` in a dedicated checkout. Alternatively
   run `orchestrate run SESSION` and repeat `orchestrate resume SESSION` for
   bounded scan/advance cycles. Startup scans existing inbox files.
2. Copy the whole outbound `*.handoff.json.md` into a fresh role chat with
   access to the named checkout and the displayed tools. The file contains the
   gate-compiled context, permissions, exact response schema and filled binding.
   Developer can commit on the canonical branch; reviewers leave it unchanged.
3. Save the raw response as any `.json` filename in the response inbox, or save
   a single fenced JSON block in `.md`. No surrounding text, multiple blocks,
   packet lookup, manual import command or request editing is needed. The
   driver checks the binding and source, then uses the existing manual adapter.
   A Developer result still binds to invocation revision; the intake fence and
   validators bind to the actual committed HEAD it produced.
4. Inspect the receipt and next packet. A malformed/unaccepted response can be
   corrected against the same packet using the original role schema and
   template included in the bound repair handoff. A terminal result stays immutable. A
   failed review enters legal rework; import its typed `rework` proposal or run
   `orchestrate rework SESSION`. The linked successor uses a new judgment and
   preserves the original assignment and predecessor evidence.
5. For failed validation or terminal provider error needing a reset, stop and
   verify all local **and external** writers. Use the audited BOOT-032 path:
   `orchestrate recover SESSION --quiescent --reason '...' --authorization-ref REF`
   with trusted `IPT_RECOVERY_ADMIN_ACTORS` configuration. Then use
   `orchestrate rework SESSION`. The proposal does not authorize the reset.
   See [the recovery guide](https://github.com/Brain-Crumbs/Vibez/blob/85fdce8cbe0ac0d46b46a1e0b4772df485a6b76b/docs/RECOVERY.md). If a diagnosis is an external prerequisite,
   fix that prerequisite and return `recheck`, or explicitly resume the same
   session. The driver does not loop on unchanged CI, credentials or approval.

`--json` emits one existing envelope on stdout. Watch progress goes to stderr;
successful observations of waiting/stopped gates return 0 with the explicit
state in data, invalid usage returns 2, blocked command operations return 4.
`Ctrl+C` stops waiting and drains the active gate; external sessions can still
run and must be stopped separately. Another watcher can scan later without
repeating completed operations. After abrupt termination inside a mutation,
inspect `orchestrate inspect-writer` and use `recover-writer --quiescent
--lock-hash HASH --reason TEXT` only after confirming that all writers stopped.
If the native orchestration token also remains, use `recover-run SESSION
--quiescent --reason TEXT`. Neither action deletes journals or evidence.

## Publish and complete

Supply `IPT_GITHUB_TOKEN` or `GITHUB_TOKEN` to the trusted host for publication and CI checks. Keep it out of role sessions and validator environments.

When `MERGE_READY`, `orchestrate publish SESSION` authorizes a non-force push
of the reviewed SHA and creation/update of the one canonical draft PR. Check
the remote, issue, branch, base and exact head. The configured remote must have one read and
one push destination, with no Git rule that rewrites either checked URL.
`orchestrate ready SESSION`
separately authorizes ready conversion of that existing PR. After the exact
head checks are green and approval is established, supply the trusted host
value `IPT_DRIVER_MERGE=owner/repo#NUMBER@FULL_SHA` and resume the same session.
For PowerShell use `$env:IPT_DRIVER_MERGE = 'owner/repo#NUMBER@FULL_SHA'`. A
different head, failed/pending CI, conflicting PR or withheld authorization
cannot complete. Keep other GitHub writers quiescent around publication and
ready conversion. GitHub's ready API does not provide a compare-and-swap SHA;
the driver checks the target before and after, and merge uses GitHub's SHA
condition. The native controller owns MERGED, lock release, DONE, and
reconciliation of a lost merge response. An already confirmed merge does not
issue a second PUT. Reconciliation is scoped to the exact authorized intent
recorded before the first attempt; an earlier merged PR on the same branch or
SHA cannot complete this session.

The completion handoff reports the next eligible candidate. Switch back to
the clean configured integration branch, refresh it as appropriate, and explicitly select the next
prepared session. The previous request is never reused for another task.

## Data, compatibility, and rollback

Sessions, intake receipts, observations, archives, merge intents and repair records
live under `<operations>/driver`. Preserve the separately configured intake,
response, outbox and canonical exchange roots as well as state and evidence.
Back up all of these with writers stopped.
Receipt and session records coordinate retries; they are not review evidence
or merge grants. Legacy `manual export/import/run`, canary rehearsal and CLI
envelopes remain supported. New role handoffs are companions to unchanged
manual packet/result formats. Do not import directly into a driver exchange:
the driver must bind the accepted result to its own current source fence.

To roll back, stop/drain the driver and external role sessions. Disable the
entry point or use the prior checkout. Preserve the driver and gate directories
read-only with their original Git history. Older orchestration journal readers
do not understand the successor's additive assignment fields; keep active
BOOT-037 attempts with the compatible engine, or quarantine the whole stopped
project state for reconciliation. Never delete journals, reset counters or
overwrite evidence to make an older version resume. Fixture GitHub and
scripted role outcomes in tests prove behavior, not live independent approval.


## Compatibility and rollback

Stop the watcher and all external role sessions and validation processes.
Preserve the committed config, Git bindings, operations, state, evidence,
exchange, and inbox archives together. The previous installed binary does
not resume these driver sessions or read successor metadata. An attempt
started on the driver stays with its exact compatible artifact and profile.
Keep that checkout and history available for read-only inspection when
restoring a previously compatible artifact in a separate checkout. Keep the newest history archived and accessible even if the old reader cannot resume it. Never delete an accepted result, journal or binding to force a
downgrade. See [Compatibility](COMPATIBILITY.md).
