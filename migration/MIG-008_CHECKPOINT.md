# MIG-008 source synchronization and acceptance evidence

The Fantasy Football inventory baseline is `50ef51e7dd2443dd0cec644c04e8db1b7fd612f7`.
The approved export is `5cd23ef5415f2d2140654551f9152339417e4b58`.
The checkpoint compares against Fantasy Football main
`ff9e467a870d26850330563a27359de44f151ea7`, the final BOOT-037 merge.

- [#76 repair](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/84)
  contributes six changed files present in the sealed Vibez import (DELTA-004).
- [#78 delivery](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/85)
  contributes 55 changed or added paths. The [driver import](mig-006-driver-import.json)
  and DELTA-005 map 52 to the accepted Vibez integration. Fantasy Football's
  AGENTS.md, BOOTSTRAP.md and README.md describe its own operating policy and
  remain in that repository.
- [#75](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/75) contributes
  no committed changes in this interval and retains its planning/service scope.

Fetch both histories and run the read-only check from Vibez:

```sh
git -C '<fantasy-football-checkout>' fetch origin main
python scripts/verify-source-checkpoint.py --source '<fantasy-football-checkout>' --source-main origin/main
```

This verifies path coverage, raw source bytes, sealed destination hashes and
continued destination ancestry. If source main advances, reopen reconciliation
before releasing. Reusable implementation changes belong in Vibez after the
checkpoint is accepted. The consumer cutover and subsequent cleanup are MIG-009
and MIG-010.

| Requirement | Evidence |
| --- | --- |
| AC-01 | Installed ESM and TypeScript exports, bundled assets, both executable aliases, project inputs and CLI/operator workflow. |
| AC-02 | Independent Git roots sharing a task ID. The non-npm consumer uses its Python validator and configured review roles. |
| AC-03 | Exact binding, invalid input, review rework, missing/pending CI, withheld effects, uncertain response and idempotent reconciliation. |
| AC-04 | Source checkpoint command above, exact CI head, candidate receipt and checksum. |
| AC-05 | Maintainer guide, automated rejection of an unsettled upgrade and byte-verified backup/restore. The PR records independent UAT of the supported stopped-writer upgrade and rollback with the prior installed artifact. Actual download requires the approved immutable release and a fresh check from that channel. |
| AC-06 | The matrix runs isolated consumer fixtures with simulated GitHub. The linked delivery PR records the real review, CI and controlled completion evidence separately. |

The support register and release receipt govern distribution and supported
platforms. Read exact per-run results from the named delivery PR and CI jobs.
