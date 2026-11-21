# Installed manual console host

The manual console host serves run status and exact current handoffs for one
configured Vibez checkout. It uses the [manual console v1 wire contract](MANUAL_CONSOLE_CONTRACT.md)
and the same session, exchange, orchestration and evidence records as
`vibez orchestrate`.

## Start an operator session

Use a dedicated local checkout with committed project configuration and an
initialized local-manual profile. Follow [Configure the selected checkout](WORKFLOW_DRIVER.md#configure-the-selected-checkout)
for the configuration, profile and storage requirements. Use
`vibez orchestrate next` to inspect eligibility. Select an already registered
task with `vibez orchestrate select TASK --issue-number N` and open its session.
The host also sees runs already started through the CLI.

Launch the installed executable from a private operator terminal:

```sh
vibez manual-console --project /absolute/path/to/checkout --origin http://127.0.0.1:5173
```

Use the exact Homebase loopback origin, including its port. Omit `--port` to
let the operating system choose a listener port, or set it explicitly. Use
`--config` for a different committed project configuration. On Windows,
verify the checkout and runtime directories are on local NTFS outside sync
or redirected folders, and pass `--local-ntfs`. A trusted operator can
supply the configured credential and npm options as for `orchestrate`.

The host prints its `http://127.0.0.1:<port>` endpoint and a one-use pairing
code. A client can discover v1 at `GET /manual-console`, then send the code
as a `pairingRequest` to `POST /manual-console/v1/operator-session`. Use
the returned bearer in the `Authorization` header for protected calls.
Keep credentials in the private terminal or the client's memory. Pairing
expires after five minutes. The session lasts up to eight hours or until
the host stops. Restart the host to rotate an expired or consumed code or
revoke the bearer. Pair again after a restart or after a client discards
its in-memory credential.

## Inspect a run

Read `GET /manual-console/v1/capabilities`, then use the configured
`projectId` to list runs and open a stable session ID. The run reports
the current attempt, checkout label, canonical branch, revision, gate,
blocker, next action and the time of observation. PR and CI remain unknown
until the native evidence establishes an observation. A projection may use
an older but revision-bound CI or merge observation, so compare its revision
to the run summary.

Request the displayed packet ID from that run's `/packets/ID` endpoint.
The response includes the exact Markdown string and SHA-256 when the
original artifact is available. Copy the decoded string. Known packets
with missing, unsupported or oversized artifacts still return an explicit
body availability state. Only current role and repair packets are
accessible in this version.

Use the CLI for start, resume, reply import, rework and publication. The
v1 capability response advertises the enabled read operations. Pairing
grants access to those reads for this checkout. Status polls, failed requests
and copying leave native records untouched. Reads return the observed state
while the CLI is active. After a connection failure, retain the last
verified snapshot and its original observation time as described in the
contract.

## Stop and verify rollback

Stop the host with Ctrl+C. Reopen the same session with
`vibez orchestrate status SESSION --project CHECKOUT`. The CLI uses the same
profile, native journals and handoffs. No console-specific runtime migration
or data cleanup is needed.

From a source checkout, run `npm run build` and
`node --test tests/manual-console-host.test.mjs` to pack and install Vibez in disposable directories and check the real CLI and HTTP
paths with an independent client.
