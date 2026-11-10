# Isolated workflow rehearsal

Run `npm run canary:rehearse` from a Vibez checkout. The command creates a
new Git repository under the ignored `.agent/canary-rehearsals` folder,
or under a directory supplied after `--`. It runs the marker workload
with the local role gates, file evidence store and manual packet adapter.
The injected fixture handles PR, CI and merge requests within the temporary
repository. It checks exact-PR/head authorization and same-key reconciliation.

The task and marker live under `tests/fixtures`. The harness requires
fixture identities, an injected provider and transport, and a repository
with no remotes. The generated summary and packets describe a fixture
exercise. Independent reviews and live lifecycle decisions use their own
revision-bound evidence.

The full suite includes the contract-bearing #76 scenario and
[adversarial coverage](ADVERSARIAL_TESTS.md). See the [historical Fantasy
Football canary guide](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/5cd23ef5415f2d2140654551f9152339417e4b58/docs/CANARY.md)
for the source repository's records.
