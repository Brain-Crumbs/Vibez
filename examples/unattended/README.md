# Independent installed unattended acceptance host

These files prepare a disposable Git consumer and external trusted host. The
consumer has two dependent tasks, each changing one existing marker file. All
four role sessions use the real pinned local llama.cpp/Bubblewrap runtime. The
host composes only the installed public Vibez exports, real GitHub adapters and
native validation, review and controlled-completion gates.

The example values are placeholders. Replace them with the exact candidate
receipt, Actions run/artifact IDs, two dedicated acceptance fixture issue
numbers, verified inference assets, private issuer module and grant interval.
The artifact must be the full `vibez-candidate-<source SHA>` artifact in the
consumer's repository. The generated CI downloads it by artifact ID and run ID,
verifies the committed package/source/digest pin, installs offline with scripts
disabled and validates the actual PR head through the installed public API.
Nothing in these examples grants repository administration authority.

Run the installed preparer with a private reviewed options document:

```sh
node /absolute/installed/package/scripts/prepare-unattended-consumer.mjs /absolute/host/options.json
```

Preparation creates a new local consumer, installs the exact package, commits
its seed and writes external `settings.json`, `grant.json`, `plan.json`,
`setup.mjs`, disabled `controls.json`, an empty intervention register and a
PENDING operator attestation. It does not request credentials, call GitHub,
publish refs, create issues, alter rules or enable the grant. It refuses an
existing destination. Preserve failed preparation directories.

Review `administration-proposal.json` against the owner's execution scope.
It records the exact seed, two fixture issues and two proposed rulesets.
Publication follows that scope; protection changes require the separate
repository administration decision. The integration ref is `acceptance/aut004-base`; task refs are
`acceptance/aut004-task-1` and `acceptance/aut004-task-2`. Neither rule matches
`main`. The no-bypass rule requires PRs, current-base CI from the pinned check
App, and disallows force pushes/deletion. A separate rule restricts updates to
the isolated controller App through PRs. The host queries authenticated live
rules and complete rulesets and fails closed when protection is absent,
incomplete, stale or mismatched.

### Private credentials and inference assets

The supported finite-run credential source is an administrator-issued private
JSON bundle. The administrator must already have the authorized publisher
identity and two separate repository-scoped App installations. Use the existing
approved credential broker to obtain the tokens **and actual returned metadata**;
creating those identities or granting new permissions is a separate setup step.

Copy `token-issuer.example.mjs` to the private host directory as
`credential-issuer.mjs` and copy `credentials.example.json` beside it as
`credentials.json`. Replace every placeholder with the approved broker result;
do not invent permissions, App/installation IDs or expiry. Restrict the directory
to mode 0700 and the bundle to mode 0600. The copied adapter works without code
edits, reads only this private bundle, and never logs, mints or refreshes tokens.
Its `expiresAt` values are ISO date strings, not epoch numbers. A shorter broker
lease is allowed; never extend the actual issuer expiry. Set grant `expiresAtMs`
earlier than the earliest credential expiry minus 30 seconds, and choose task
budgets that fit that interval. Expiry stops work; it does not silently refresh
authority. A resumed demonstration with manual credential repair cannot claim
zero routine handoffs.

A separately approved renewable broker can implement the same `issue(role)`
interface; pin its module and review its credential isolation separately.
Pin the exact copied issuer module's SHA-256.

Use `inference-assets.example.json` as the complete manifest shape. Replace all
paths and zero hashes with the verified assets described in
[LOCAL_HEADLESS.md](../../docs/LOCAL_HEADLESS.md). The libraries array must list
**every** required pinned runtime/dependency library; its two example rows are
not a complete binary inventory. `runnerSha256` hashes `llama-completion` inside
`runtimeDirectory`. `launcherSha256` hashes the approved isolated launcher.
The model identity and digest must match its actual GGUF bytes. Hash the final
manifest itself for `options.assets.sha256`; no installation or download is
triggered by supplying this JSON.

The publisher/read credential,
read-only worker credential and isolated controller installation token are
distinct. Only the controller adapter receives the controller token, and its
transport permits mutation only of the native merge endpoint on this exact
acceptance base/head. Provider processes receive no repository, host home,
credentials, network or shell tools. The validator runs fixed host-owned code
with marker bytes on stdin and a minimal environment; it does not execute
consumer-supplied code.

After the one-time setup has been authorized and verified, enable the exact
grant in the external controls file. Use the generated setup module with
`unattended-acceptance.mjs` for start, inspect, pause, drain, cancel or resume.
Keep the same setup, operation UUID, package, grant and journals on restart.
The initial grant controls autonomous task selection, role dispatch, validation,
review, publication, exact-head CI polling and native completion. Distinct
role principals and fresh provider session records bind every judgment to the
owning gate's revision.

While a host is running, separate inspect/pause/drain/cancel processes connect
to its private durable control channel. They verify the original policy-lease,
settings, grant and package binding without obtaining credentials or creating a
second effects runner. The original owner records and executes the native
control. A RUNNING or QUARANTINED response is not confirmed drain: inspect the
same operation until its native status acknowledges the control. After a normal
host close, an inspection can open the stopped host normally. A stale or
unresponsive owner leaves the request and all leases intact; timeout is not
permission to replace the writer. Preserve the control-channel owner receipt
during crash recovery and independently verify the original process has stopped.

The runner or original control owner records each command before dispatch. The host records hash-linked
dispatch/effect receipts and the provider records its own durable intent and
terminal receipt. The external `interventions.json` register is an operator
statement about actions outside the host: record every routine handoff,
exception intervention or separately scoped scenario control with actor, time
and description. Do not erase entries. After observing the run, an operator
may set `operator-attestation.json` to ATTESTED with its original operation and
grant, setup authorization reference, actor, ISO timestamp, the last command
journal SHA-256 and a truthful `noRoutineHandoffs` boolean. Completion evidence
distinguishes this statement from observed host events. An empty register alone
does not prove zero handoffs; the initial PENDING attestation cannot pass.

Every uncertain provider or source effect retains its original reservation.
The drain check rejects the provider's actual `active`/`mutating` directories,
missing or corrupt terminal receipts, source-effect fence/index and pending
remote effects. An uncertain request is not retried under a new operation.
Inspect the original remote PR/ref and external process identity, verify its
outcome and drain. Abrupt crashes with abandoned owners require a separate
reviewed administrator recovery; this packaged host does not supply those
recovery hooks. For normal restart, obtain PAUSED/DRAINED acknowledgment and
wait for the original host to exit before resume. The host never
deletes those fences automatically or infers drain from their age.

These checked-in examples and deterministic host tests are support material.
Only a completed report with genuine real provider, CI, protected GitHub merge,
native DONE and explicit intervention evidence establishes live acceptance.


### Attest the completed run

A DONE operation with a PENDING attestation intentionally produces BLOCKED and
exit 2 at collection; its native tasks remain DONE. Inspect the private records
and both GitHub merges first. Never repeat `start` to get a passing report.
Read the last command envelope's `.sha256` field; `sha256sum` of that JSON file
is a different value.

From the private host directory, the following local Node script preserves the
generated operation/grant/setup bindings and writes the operator's statement.
Set `actor` and `noRoutineHandoffs` truthfully after inspection.

```js
import { readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
const actor = "authorized-operator";
const noRoutineHandoffs = true; // Assert only after inspecting the complete run.
const attestation = JSON.parse(readFileSync("operator-attestation.json", "utf8"));
const last = readdirSync("commands").filter(n => n.endsWith(".json")).sort().at(-1);
if (!last) throw new Error("No original command record");
const envelope = JSON.parse(readFileSync("commands/" + last, "utf8"));
if (envelope.record.operationId !== attestation.operationId ||
    envelope.record.grantDigest !== attestation.grantDigest) throw new Error("Binding mismatch");
Object.assign(attestation, { status: "ATTESTED", actor, occurredAt: new Date().toISOString(),
  throughCommandSha256: envelope.sha256, noRoutineHandoffs });
writeFileSync("operator-attestation.next.json", JSON.stringify(attestation, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
renameSync("operator-attestation.next.json", "operator-attestation.json");
```

Retain the original PENDING document as a private backup before updating it.
Run `inspect` afterward. The collector accepts read-only inspection after the
attested command prefix; it rejects a new start/resume/control step in the
happy-chain proof. Keep separate scenario identities for intentional controls.
