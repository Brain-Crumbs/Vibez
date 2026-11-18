# Installed unattended acceptance and operations

AUT-004 proves a bounded installed workflow. Read the release's acceptance
receipt before treating a package as an accepted unattended release. A local
candidate, passing fixture suite or completed native task alone does not
establish that result.

The supported headless profile is the local llama.cpp/Qwen3 adapter described in
[LOCAL_HEADLESS.md](LOCAL_HEADLESS.md): Ubuntu 24.04 x64 (including WSL 2), a
local ext4 checkout, Bubblewrap, and Node 22 or 24. The model receives fresh
role contexts and approved text snapshots. Developer can replace one existing
approved text file per task; reviewers have no replacement capability.
The host owns Git, validators, credentials, policy and integration. This profile
does not grant an agent a shell, network, secrets, arbitrary repository edits
or access to native evidence.

The package's manual/configured APIs retain their separately verified
Windows/Ubuntu matrix. The Linux headless profile is not a claim of native
Windows headless support.

## Evidence boundary

| Record | Establishes | Does not establish |
| --- | --- | --- |
| Installed live-chain report | Original provider sessions, native judgments, real GitHub heads/checks/merges, ordered completion and replay | Broader model capability or unattended deployment in another project |
| Installed fault-matrix report | Named failure assertions against the exact installed artifact, with retained fixture identities | Real provider or GitHub execution when those ports are simulated |
| Native audit | Original lifecycle, rejection/rework and evidence provenance | A new approval or permission to resume |
| Independent final reviews and CI | Acceptance of the exact feature/release revision | Approval of a later changed artifact |
| Release receipt | Source, artifact/checksums, support, accepted reports and approvals | Permission for npm publication or a consumer upgrade |

[AUT-003](https://github.com/Brain-Crumbs/Vibez/pull/29) used actual isolated
local roles with simulated remote ports. Preserve that historical result.
Only a report with actual GitHub observations may satisfy AUT-004's live-chain
criterion. The retired live canary is unrelated.

## One-time preparation

Use a dedicated stopped checkout and host directory on supported local storage.
Keep the host directory private and outside both the checkout and installed
package. Preserve prior operation stores instead of reusing their identities.

1. Download the immutable tarball, candidate/release receipts and checksums from
   the approved GitHub release, or obtain the exact candidate CI artifact for
   pre-release acceptance. Verify SHA-256 and npm SHA-512 integrity, source SHA
   and artifact/run identity. Install the tarball with npm into an independent
   directory. No package install hook creates tasks or starts work.
2. Prepare the pinned runtime/model/launcher assets from
   [LOCAL_HEADLESS.md](LOCAL_HEADLESS.md). Pin every input by hash.
3. Supply the trusted token-issuer module described by the packaged
   unattended host example. The publisher is the trusted host identity;
   the separate controller App can integrate only an exact reviewed PR.
   Worker credentials must be read-only and are not mounted in local roles.
   Never put credential values in setup JSON, Git, model context or an export.
4. Prepare two complete dependent task definitions, their requirements,
   canonical branches and approved one-file scopes. The acceptance preparer
   creates an independent consumer and a reviewable administrative request;
   it performs no remote writes. Use dedicated fixture issue numbers, not
   the AUT-004 implementation issue.
5. Review the generated seed and branch-scoped protection requests under the
   repository's separate administrative authorization. Require a no-bypass
   PR/check/force-push/deletion ruleset and a separate controller-only update
   restriction on the acceptance integration ref. The host verifies the
   effective rules and exact trusted check-writer IDs before allowing effects.
6. Pin the project configuration, plan, grant, package and host implementation.
   Grants must enumerate the task branches/paths, independent role principals,
   provider/model/tools, validators, required checks, permitted actions,
   expiration and budgets. The generated control starts disabled. Enable
   only the reviewed setup. An issue, agent response or successful test
   cannot enable it.

The acceptance consumer can download the immutable full candidate CI artifact,
named `vibez-candidate-<source-sha>`, by its exact artifact and workflow run
IDs. Its CI verifies the downloaded source receipt, SHA-256 and SHA-512 before
installing. Runtime stores, token issuers, grants and model files are excluded
from the committed consumer.

## Run and inspect

The external trusted setup module exports `openAcceptance()` and creates the
configured host from the installed package. Keep that module and its hash with
the original grant. The packaged runner uses the same application-service
operation methods as the CLI; it is not another scheduler or lifecycle engine.

```sh
node /absolute/installed/vibez/scripts/unattended-acceptance.mjs /private/setup.mjs start
node /absolute/installed/vibez/scripts/unattended-acceptance.mjs /private/setup.mjs inspect
```

A single start drives the approved dependency order, isolated roles, native
validation/reviews, bounded legal rework, publication, CI polling and exact-head
controlled completion. The original operation UUID is stored before dispatch.
Do not assign the second task manually or create its PR separately.

Inspect the operation status, not only process exit or JSON-envelope success.
The live completion collector independently reads actual GitHub PR/check data,
correlates original provider results with native orchestration contexts and
judgments, includes the redacted native audit, and checks every configured
validator. It preserves historical failures. DONE replay must leave native
state, evidence, provider receipts, policy decisions and operation journals
unchanged and must retain the same remote PR/merge identities.

The first DONE observation remains unaccepted while the external operator
attestation is PENDING. After inspecting the complete original run, the operator
records a truthful ATTESTED statement bound to the operation, grant and last
command-journal SHA, with actor, time and initial setup authority. Then use
`inspect` to collect the proof. Read-only inspection may follow that attested
prefix; another start/resume/control command cannot silently become part of
the happy-chain proof. This attestation describes activity outside the host;
the host does not claim it can observe every human action.

Retain the command/intervention record. The zero-handoff claim covers the
happy-chain execution after initial setup/grant. Record any manual response
import, role switching, task assignment, source repair, publication or merge
intervention. Intentional failure/control experiments have their own scenario
records and must not silently replace the happy-chain result.

## Control and recover

```sh
node /absolute/installed/vibez/scripts/unattended-acceptance.mjs /private/setup.mjs pause
node /absolute/installed/vibez/scripts/unattended-acceptance.mjs /private/setup.mjs drain
node /absolute/installed/vibez/scripts/unattended-acceptance.mjs /private/setup.mjs resume
node /absolute/installed/vibez/scripts/unattended-acceptance.mjs /private/setup.mjs cancel
```

Pause/drain prevent later dispatch; cancellation requests interruption.
A request is not proof that an original worker or remote effect stopped.
Check the control acknowledgment and provider/source-effect reservations.
An unresolved launcher, mutation lease or source index keeps the operation
quarantined. After process interruption, inspect original process/session
identities and side effects before approved abandoned-lock recovery. Never
delete a lease merely because it is old.

| Stop | Operator action |
| --- | --- |
| Missing or changed grant/config/package | Restore the exact approved binding; retain the rejected operation |
| Denied, expired or revoked policy | Inspect the original decision; do not issue a new operation to reset limits |
| Exhausted retry/rework/poll budget | Retain the spent allowance and failed judgments; obtain a scoped decision for any further work |
| Unavailable/uncertain provider | Reconcile the original attempt and verify drain; do not launch a duplicate writer |
| Stale source, CI or PR | Inspect actual branch/head/check identity and use the owning rework/publication path |
| Uncertain merge response | Read the original PR and native completion record; reconcile before any new merge request |
| Ambiguous task | Keep the durable clarification exception until a reviewed plan resolves it |

Raw private failure text stays in the original host store. Shareable operation
observations include fixed reason codes, a private-detail digest and a stable
remediation; they do not export arbitrary exception messages or model output.

## Upgrade and rollback

rc.5 reads the rc.4 operation formats without rewriting their original records.
Both understand workflow-operation/plan 1.0.0. rc.3 and earlier readers refuse
operation history even after DONE. An artifact change is not permission to
rebind an unfinished run.

Disable new admission, request drain, verify original external writers and
remote effects, and retain the original package/configuration, full runtime
roots, provider receipts, grant/decision ledger and intervention record.
Hash the stopped snapshot and protected backup. Run the installed
`services.diagnostics.checkUpgrade` for the exact target reader and snapshot.
Only restore a compatible package/configuration under that supported procedure.
Keep an incompatible newer store available read-only; never overwrite it with
an older snapshot or reset budgets. See [COMPATIBILITY.md](COMPATIBILITY.md).

Manual fallback is optional. Use the original compatible host and operation's
`resume(originalId, true)` to step through existing authority. A pending
headless binding cannot be silently converted into a manual-provider inbox.

## Migrated Fantasy Football boundary

[MIG-010](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/87) completed
the M1 cleanup. Fantasy Football remains an exact pinned rc.2 consumer with
no authoritative embedded engine. Its current manual wrapper deliberately
rejects a different package version and restricts its admitted task scope.

AUT-004 tests the untouched consumer and separately inspects the candidate's
public APIs against a disposable copy of its project inputs. This is not a
production dependency update, transplanted native history or a claim that the
old wrapper is already unattended. A consumer upgrade needs its own committed
pin/configuration/admission and stopped-writer checks.

The [roadmap](https://github.com/Brain-Crumbs/Vibez/issues/1) owns M2 acceptance;
[extraction #74](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/74)
retains M1 evidence. [API #75](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/75)
is closed as not planned; no conversational planner, HTTP service or distributed
scheduler is delivered by this acceptance work.

## Installed fault matrix

From the exact clean committed source corresponding to the candidate receipt:

```sh
npm run test:installed-faults -- /absolute/candidate-directory /absolute/new-evidence-directory
```

This harness installs the exact tarball offline into an independent consumer,
rewrites only test imports to supported public exports, and executes the full
operations failure suite. Its report retains each scenario, positive execution
counts, original fixture identities and hashes. Provider and remote ports in
these scenarios are simulated; the report cannot substitute for the installed
live GitHub chain. Keep the original private capture and share only its redacted
report. Interrupted, filtered or partial test runs cannot establish acceptance.
