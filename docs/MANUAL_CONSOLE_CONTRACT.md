# Manual console HTTP contract v1

[Homebase #22](https://github.com/Brain-Crumbs/Homebase/issues/22) defines the
operator workflow. [Vibez #39](https://github.com/Brain-Crumbs/Vibez/issues/39)
defines this contract. Its boundary is one configured checkout with
already-admitted tasks. Implementations of the listener, writer routes and UI
follow in their owning issues.

## Connect and negotiate

The operator starts the opt-in Vibez host for an existing configuration. The
host binds a single IPv4 loopback address, `127.0.0.1`, on a configured or
OS-assigned port. It prints the endpoint and a pairing code to the private
operator terminal. The operator opens Homebase on a configured loopback origin
such as `http://127.0.0.1:5173` and enters the endpoint and code in connection
controls. The endpoint is just `http://127.0.0.1:<port>`. Credentials travel in
the pairing JSON body or the `Authorization: Bearer <token>` header. Keep them
in memory for the browser tab. A reload or host restart can require re-pairing.
Bookmark only the project and stable session IDs. Reconnection restores native
state on those IDs.

Before sending a code or token, the consumer must accept only the literal
`http://127.0.0.1:<port>` with an explicit decimal port from 1 through 65535.
Reject aliases, alternate address spellings, userinfo, paths, queries and
fragments. Keep that exact origin for the life of the bearer and build all
resource URLs locally from the route table. Do not accept response-supplied
origins or follow redirects, including on discovery and pairing. Use
`redirect: "error"` for browser fetches. A port/endpoint change clears the
bearer and requires a new pairing.

Generate 32 cryptographically random bytes for each pairing code and token,
encoded as unpadded base64url. A pairing code expires after five minutes, can be
consumed once, and must be scoped to this host's checkout and profile. Rotate it
from the trusted host if used, expired or lost. The operator session expires
within eight hours and ends at host restart or trusted revocation. Validate the
token and its checkout/profile scope on every protected request. Pairing grants
these console operations only. Compare credentials safely and never record the
pairing body, authorization header, token, or reply text in HTTP logs, browser
telemetry, URLs, shipped assets, or persistent browser storage. Native retention
of authorized reply evidence follows the existing driver rules.

Verify the exact listener `Host` and TCP loopback peer for every request. Ignore
forwarded identity headers. Reject foreign and opaque browser origins before
looking up resources. A request with an Origin must match the one explicitly
configured Homebase origin, including its port. Return CORS headers for that
exact origin with `Vary: Origin`. A preflight may allow only the listed methods
and `Authorization`/`Content-Type` headers. It reads no protected state.
Non-browser clients may omit Origin and use the same pairing and bearer
credentials. The host uses no cookies, redirects, proxy mode, or alternate
listener addresses. Apply `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff` to all responses. The reader treats Markdown,
reply text and diagnostics as inert display text.

Discover versions on the stable route before pairing. The supported major is
currently `1`. Pick a version the consumer implements. On no overlap, show
unsupported and preserve any old observation. Do not send commands, guess
payloads, or silently use a different version. A request to an unsupported
major returns HTTP 400 with the version-neutral `unsupportedVersion` document.
A wrong or missing version in a v1 JSON body is an invalid request and has no
effect. All other v1 application responses and JSON requests use the
`{ "version": 1, "kind": "...", "data": ... }` envelope. The route selects the
permitted kind. GET requests have no body.

## Routes

`p`, `s`, `packet`, `request`, and `receipt` in paths below stand for the
corresponding opaque project, root session, packet, caller request, and receipt
identifiers. `/p/{p}/runs/{s}` is abbreviated as **run** below. Every route after
discovery is relative to `/manual-console/v1`. JSON uses UTF-8 and
`Content-Type: application/json`. Protected routes require the operator bearer.

| Method and path | Authorization | Body kind | Success status and response kind |
| --- | --- | --- | --- |
| `GET /manual-console` (absolute) | Loopback and origin | — | 200 `discovery` document |
| `POST /operator-session` | Pairing code in body | `pairingRequest` | 200 `operatorSession` |
| `GET /capabilities` | Bearer | — | 200 `capabilities` |
| `GET /p/{p}/runs?limit=&cursor=` | Bearer | — | 200 `runList` |
| `GET {run}` | Bearer | — | 200 `run` |
| `GET {run}/packets/{packet}` | Bearer | — | 200 `correspondence` |
| `POST {run}/start` | Bearer | `commandRequest` | 200 or 202 `operationView` |
| `POST {run}/resume` | Bearer | `commandRequest` | 200 or 202 `operationView` |
| `POST {run}/replies` | Bearer | `replyRequest` | 200 or 202 `operationView` |
| `GET {run}/requests/{request}` | Bearer | — | 200 or 202 `operationView` |
| `GET {run}/receipts/{receipt}` | Bearer | — | 200 `receipt` |
| `GET {run}/receipts/{receipt}/original` | Bearer | — | 200 `replyOriginal` |
| `GET {run}/history?limit=&cursor=` | Bearer | — | 200 `history` |

`capabilities` names the installed operations enabled under host policy.
`packet-read` covers current role and repair packets. `historical-packet-read`
covers historical packets and authorized reply originals. Start and resume
operate on the already-prepared/current attempt exposed by the run. The
per-run `actions` intersect host capabilities with the driver's observed
eligibility and current evidence. They are hints. Recheck under the existing
writer fence before any side effect. The browser receives no merge, ready,
publication, admission or lock recovery control. Opening, copying or polling a run performs no dispatch.

### Identity and original text

Use the configured project identity for `projectId`, with a display-safe
`checkoutLabel`. Server-side scope includes the configuration/profile binding.
`sessionId` is the root driver session ID. Following native predecessor links
keeps it stable while `currentAttemptId` and `attempt.attemptId` identify a
specific driver session record, including the first attempt. Use the native
orchestration run ID when recorded. Packet IDs come from the original role or
repair envelope. Resolve IDs from validated records after scoping to the
configured checkout, profile, session and lineage. A URL path, ID, label or
posted body cannot name an arbitrary checkout, remote, or filesystem path.

Return the original UTF-8 Markdown from the bound artifact, including all
line endings, trailing spaces, fences, code points and the final newline.
`sha256` is over those original UTF-8 bytes. JSON escaping is transport-only.
Copy the decoded string. Never regenerate it from the inner JSON, normalize
newlines, or trim trailing space. Unknown role or revision on older history
uses null. For known bound correspondence whose original is missing, redacted,
unsupported, or too large, return its identity and unavailable reason. A
foreign or unbound ID receives 404 without its metadata. For native reply
archives, expose original text only where safe and authorized. Retain diagnostic
and receipt evidence when text is unavailable.

### Commands, receipt and gate

A command request includes `target` (`projectId`, `sessionId`, `attemptId`) and
a caller-generated UUIDv4 `requestId`. A reply also includes
`expectedPacketId` and `replyText`. The target IDs must agree with the route
and the current attempt for a new operation. The expected packet must belong
to that attempt and be the pending role packet or its active diagnostic repair
packet. A pending repair identifies the displayed `packet` and the separate
`replyToPacketId`. When the driver asks for a corrected role result, this is
the original role packet. For a typed diagnostic response, it is the repair
packet itself. Apply the template from the original Markdown. A correct role
reply remains valid when a repair preview is present. Keep any packet identity
found inside the reply separate from the trusted association in the request.

Accept the exact raw JSON text or one fenced JSON block through the existing
driver parser. Carry the intended target and expected packet in an additive,
durable submission correlation before exposing bytes to the shared inbox.
Process under the native writer lock. Never let a bound response be deferred to
a different waiting session. Ingress deduplication includes the project,
profile, attempt, expected packet, and exact input bytes. A global byte hash
alone is insufficient for bound ingress. A rejection in another target cannot
settle a bound request or consume an unbound CLI inbox entry with the same
bytes. Keep bound rejection evidence separate from the CLI's global
input-hash archive. A native result already imported for the same packet can
be reused through the native accepted fence, only after verifying its original
binding. Malformed text and wrong packet, role, run or
revision fields produce a rejected import receipt for the correct target with
a safe diagnostic after the request is admitted. The correct pending packet
remains available. An obsolete explicit target or expected packet at admission is
a command conflict. Reject it before inbox processing. This differs from
a reply body with stale binding submitted to an otherwise current target.

Persist the request identity and exact intent (operation, former target,
expected packet and decoded input bytes) before any effect. Scope the request
key to the project/profile and root session. Compare and replay an existing
key **before** freshness checks. A same-key retry with byte-identical intent
returns the same operation and original receipt ID (if settled), including
after a restart or the run advances. Mark its response `replayed: true`. A
changed intent under the same key yields 409. Retain request lookup and receipt
correlations alongside native history for as long as the run remains
available. Failure or uncertain delivery must preserve enough evidence to
reconcile the native import and its receipt without performing a second
judgment. If a browser loses the response, query the request by ID. If still
unknown, retry the identical request with the same key. A corrected reply uses
a fresh key after rejection. Never infer an import from polling the next role.

A POST returns 202 while pending and 200 when settled. Request lookup uses
200 regardless of the operation state.
A finished reply always has a receipt ID, with the driver import outcome
`accepted`, `reused` or `rejected`. For start/resume the receipt ID is null.
A settled failure has an explicit problem and no receipt. Return a settled
operation failure only when submission has definitively produced no native
receipt. Interrupted or uncertain submissions remain pending during
reconciliation. Unsupported or invalid requests rejected before reservation
return an HTTP problem with no operation. Reads of existing requests,
including replays of settled requests, use the original attempt even when the
current attempt moved on. A receipt is immutable. Its public ID is opaque, stable, and bound to the
project, profile and attempt. Derive it from a recorded correlation/native
receipt identity so a later read returns the same reference. Uncorrelated
legacy receipts appear only where native evidence establishes their lineage.
`reused` means the native
importer reused the accepted input. `replayed` means this HTTP request key was
already reserved. Subsequent validator, reviewer and CI outcomes appear only
on `run` and `history`; a successful import may later yield a failed gate.

### Observations, ordering and failures

`observedAt` records the successful scoped read in UTC. A recorded event's
timestamp is its original native time when available. A run snapshot reports
the native phase, gate, actionable blocker, next action, current revision and
pending correspondence independently. Use the same evidence to project phase
and action hints on CLI-originated and console-originated runs.

| Phase | First applicable native condition |
| --- | --- |
| `completed` | The attempt has a controller-confirmed final `DONE` lifecycle and merge evidence for that task. |
| `rework` | Native review or recovery requires legal rework, or the reconciled linked successor is prepared but has yet to start. A browser may submit only an offered driver diagnostic response. |
| `waiting` | A current, unconsumed role packet is actionable. A correction diagnostic can coexist with the role. Project `awaiting-role` from its bound role. |
| `blocked` | The driver stopped at a failed/blocked validator, review, authorization, or externally resolved gate, or the native evidence cannot establish a usable phase. Preserve known outcomes and safe diagnostics. |
| `active` | Native evidence identifies an in-flight stage for that attempt. Use `running` for its known stage. |
| `prepared` | The bound first attempt has a prepared intake/selection and has never begun execution. |

A diagnostic can persist a native session tag of `WAITING` after the workflow
has stopped. A diagnostic ID or that tag alone establishes neither an
actionable role nor a running stage. Inspect the attempt's result, latest
native lifecycle/evidence, and any pending packet and its accepted fence.
Use the current observed stage result for `gate.state: "observed"` and reserve
`idle` for snapshots without established gate activity. Native validation
maps to `developer-validation`, the three review gates to `qa-review`,
`architecture-review`, and `uat-review`, and the controlled merge result to
`completion`. Use native publication, CI and readiness evidence for their
corresponding stages. A global writer held by another operation can withhold
mutations and supply a blocker even while the current role is readable. When
the host cannot prove an action is available, omit it.

For PR and CI, use independent
`unknown` or `observed` states. An observed result includes its own observation
time and exact revision. Preserve an older observation as such, even when
the checkout is at another revision. Render it as older when revisions differ.
Never infer CI pass from an accepted reply, PR state or missing check data.

Poll read routes after the host's `pollAfterMs` (at least one second), after a
command settles, and on reconnect. Cancel stale page requests and discard
responses for a superseded selection. `runView` is a consumer-only conformance
shape. On disconnect retain the last verified snapshot and its unchanged
timestamp when available. Withhold mutations until a fresh observation and
authorization. An empty, successful run list is distinct from unauthorized,
unavailable and unsupported service.

History is oldest-first. Prefer native causal and append order. For
independent records without a common sequence, use recorded time and stable
event ID to break ties. Place events with no trustworthy timestamp according
to native causal order where available, otherwise after the dated records in
stable ID order. Preserve event IDs across equivalent reads and service
restart. Link rework to both attempts. Include a `validation-check` entry for each resolved
native validator result. Use its evidence outcome (PASS, FAIL or BLOCKED), the
original revision/required flag where recorded, a stable scoped evidence ID
and a safe diagnostic. Surface both the individual checks and the aggregate
gate when present. Page tokens are opaque, authenticated
and bound to scope, route and stable page boundary. Use a stable snapshot per
pagination sequence, so new events appear on a fresh sequence. A malformed or
expired cursor returns 400 with `invalid-cursor`. List order is task ID then
root session ID. Default and maximum page size are 25 objects. A short page
with a cursor has more results. A null cursor is terminal.

| HTTP status | Problem codes and behavior |
| --- | --- |
| 400 | `invalid-request`, including malformed HTTP JSON, unexpected schema/kind, or a body target that disagrees with the route, or `invalid-cursor`. An unsupported path major uses the stable document above. |
| 401 | `unauthorized` for an absent/expired/invalid token or pairing code. |
| 403 | `forbidden` for an untrusted peer, origin or Host. |
| 404 | `not-found` for missing, foreign or unbound resources. No lookup detail. |
| 409 | `stale-target`, `writer-busy` or `conflicting-request`. Refresh or follow the supplied retry delay. |
| 413 | `payload-too-large` before queueing. The native driver still applies its own input limits. |
| 422 | `unsupported-action` when the host or current eligible run cannot perform the command. |
| 429 | `rate-limited`; wait for the supplied retry interval. |
| 503 | `temporarily-unavailable`; recover uncertain requests by their original key. |
| 500 | `internal-error` with a bounded, sanitized message. Reconcile an uncertain command. |

Preflights may return 204. For 409, 429 and 503 the server can include
`retryAfterMs` in the problem body, otherwise null. Apply the bound before
allocating or parsing the body. General JSON requests top out at 64 KiB;
`replyRequest` bodies top out at 32 MiB of transfer-decoded, uncompressed
UTF-8 JSON and 4 MiB of decoded reply UTF-8. Response JSON is limited to
64 MiB and original handoff Markdown to 8 MiB of UTF-8. These are byte limits
in addition to scalar/schema bounds. No request compression. Rate-limit
pairing to at most five failed attempts per minute per listener and other
requests to at most ten per second per operator session. Polling should use a
single in-flight read per resource. Limit paths/query strings to 4096 bytes.
Do not truncate a packet or reply to satisfy a byte limit.

## Native mapping and open implementation work

| Contract data | Existing source and additional work |
| --- | --- |
| Prepared/saved session, task and revision | [Driver session model](../src/workflow-driver/model.ts) and [intake/selection](../src/workflow-driver/intake.ts) bind checkout, profile, issue, task, registration revision and run request. Resolve current attempt and head from its driver and Git observations. Project identity comes from the configured [services](../src/project-services/index.ts). |
| Role, next step, blocker and original body | [Driver](../src/workflow-driver/driver.ts) emits a role envelope and original Markdown bound to the native role/context/result binding. [Intake](../src/workflow-driver/intake.ts) emits diagnostic IDs and companion repair Markdown. The host projects native observations and returns only allowed actions under policy. |
| Reply association and receipt | [Inbox](../src/workflow-driver/inbox.ts) hashes exact input, archives receipts, validates native packet binding and may defer the packet for another waiting session. Legacy records lack a trustworthy binding for some rejected inputs. The host needs durable pre-inbox target/expected-packet/request correlation. Preserve legacy ambiguity and exclude unbound records from a scoped run. |
| Attempt and gate history | Native lifecycle/evidence and [project audit](../src/history/index.ts) establish outcomes and current evidence. Driver session result, observations, archive and linked predecessors supply detail. Derive a read projection. Do not import, rewrite, relocate or reapprove existing evidence as part of a read. |
| PR and CI | Driver/orchestration and native audit evidence establish observations with provenance. Old or unavailable evidence may leave results unknown. The host must never independently upgrade native authority, replace a writer lock, or claim an unrecorded result. |

## Consumer conformance and rollback

Copy [the schema](specs/manual-console-v1/schema.json) and [the fixture
manifest](specs/manual-console-v1/fixtures.json) from the same full Vibez Git
commit or merge SHA. These files are standalone JSON with internal references
and require no Node modules, source-tree imports, remote schema references, or
Vibez package installation. Pin the verified MR-001 merge SHA and content
SHA-256s in the consumer. Do not pin a moving branch or version label alone.
Each fixture names its schema definition, expected validity and payload. For
a browser validator, use JSON Schema Draft 2020-12 with date-time/URI format
checks and bind the expected definition to the route. Wire timestamps are ASCII UTC
RFC 3339 calendar times with a terminal `Z`, seconds from 00 through 59, and
optional 1–9 fractional digits. Links are HTTPS URIs with an ASCII hostname,
valid optional port and percent escapes. The fixture text, identifiers and
credentials are synthetic. The replies model the transport and cannot be
replayed against a live driver session. The in-repository reproduction is
`python -m unittest discover -s tests -p 'test_manual_console_contract.py'`
after installing `schemas/requirements.txt`.

The schema checks shape. Identity correlation, byte lengths, authorization,
request replay, stable ordering and native import are behavioral requirements
for the host and consumer. The conformance suite checks representative
cross-document identities and Markdown bytes. Live HTTP and driver evidence
belongs to the later implementation tasks. Unknown versions are rejected
before feature use. Because v1 uses closed shape and enum vocabularies,
compatible clarifications keep existing validity and meaning. Incompatible
shapes, semantics or narrowed limits require a separately negotiated major.

Before consumers adopt v1, revert this specification and its conformance
changes in a reviewed PR if needed. No runtime or persisted format changes
occur in this task. Keep the task definition, original Git history and native
completion/audit evidence available for inspection. Once consumers exist,
disable routes and drain active writers before stopping the host. Preserve
native and additive correlation records and use a compatible CLI and pinned
consumer/host pair for resumption.
