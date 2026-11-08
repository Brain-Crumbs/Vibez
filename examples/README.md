# Two consumer design walkthroughs

These examples are specifications for MIG-004/008 conformance tests, not runnable
configurations for the current source factory. Both intentionally use task ID
`DEMO-001`, different project identities/roots and different validators.

| Consumer | Host-selected root | Validators | Expected binding |
| --- | --- | --- | --- |
| [Alpha](alpha/vibez.config.json) | POSIX `/srv/projects/alpha` | Host `node-build` and `node-test` | alpha-demo + example/alpha + physical Git identity; task data under work/tasks |
| [Beta](beta/vibez.config.json) | Windows `C:\\Projects\\Beta Service` | Host `python-test` | beta-demo + example/beta + physical Git identity; task data under planning/tasks |

A host registers those executor IDs with explicit command arrays and working
directories, a `local-manual` provider, and credential reference `github-main`.
Alpha's commands might be `npm run build` and `npm test`; Beta's might be
`python -m unittest`. These commands are host policy, not task-generated text.
Both examples require all independent reviews and exact check names. The driver
profile points to the config plus digest; per-task requests retain their own
owner/run/key without copying provider/validator/policy settings.

UAT walkthrough: locate each consumer's tasks, requirements and contracts using
the schema's paths; locate distinct state/evidence/exchange/inbox/outbox roots;
explain which engine assets come from the package; trace DEMO-001 through the
same configured lifecycle graph; identify who may authorize PR/merge; then trace
legal failure/rework/resume and compatible/refused rollback from the docs.

Required downstream negative scenarios:

1. Launch from an unrelated cwd: explicit project still resolves identical
   inputs; omitted project/config rejects without creating directories.
2. Give Alpha a symlink/junction into Beta or reuse Beta's bound state root:
   reject before reads of Beta's task state, provider dispatch or any write.
3. Copy Alpha's config into Beta or reuse the same task/run/packet ID: physical
   repository binding prevents aliasing; historic evidence never transfers.
4. Remove a packaged schema, change version or shadow an engine contract with
   project bytes: explicit failure, no source checkout fallback or weakened roles.
5. Change config/provider policy while a packet waits: resume conflicts; retain
   original identities/evidence. Separate authorized recovery cannot invent PASS.
6. Attempt parallel worktrees, shared network/cloud-sync storage or rollback to
   an unsupported reader: fail before mutation under the documented support gate.

MIG-002 tests parse and validate both example documents and reject malformed
design inputs. The filesystem/provider assertions above are not executed by that
schema checker; MIG-004/007/008 must prove them against the installed runtime.
