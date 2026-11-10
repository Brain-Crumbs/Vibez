# MIG-003 source seed

The canonical branch is `migration/mig-003-provenance-extraction` from Vibez
main `4c838c1598fce5348c3a8052146b42e4eb05e1a4`. The
[admission receipt](admissions/mig-003.json) records the sealed Vibez commit
and tree, MIG-002's accepted PR, exact-head CI and independent review references.
MIG-003 uses the last [pre-native seed acceptance](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/50ef51e7dd2443dd0cec644c04e8db1b7fd612f7/migration/SEED.md#end-the-exception).
The Vibez registry starts empty. The owner-authorized merge records seed
acceptance in GitHub.

## Source and rights

- [Accepted source](https://github.com/Brain-Crumbs/IPTFantasyFootball/tree/5cd23ef5415f2d2140654551f9152339417e4b58)
  contains the reviewed [#76 fix](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/84)
  and [passing main CI](https://github.com/Brain-Crumbs/IPTFantasyFootball/actions/runs/42538984027).
- The [owner decision](https://github.com/Brain-Crumbs/Vibez/issues/3#issuecomment-6747942125)
  covers the 244 candidate paths at that exact commit. Owner material retains
  its copyright where applicable, with no additional public license. The
  [support register](../docs/SUPPORT.md#mig-003-source-export-decision)
  describes the terms and the separate distribution gate.
- The reviewed [inventory](inventory.json) covers all 289 source paths.
  [Provenance](seed-provenance.json) lists the six source hash overrides from
  #76, every deliberate destination transformation, and Vibez-authored
  additions or removals. All remaining included files match the raw source
  bytes and path. The 45 retain rows stay in Fantasy Football. The module,
  schema and CLI data identities remain stable.

The audit traces the candidate paths to owner-controlled source history.
It found no vendored files or third-party redistribution notices in the
tracked candidate set. Preserve any applicable upstream notices on future
changes and hold files whose redistribution rights are unclear. The seed
checks regular tracked files for excluded paths, binary content and
recognizable credential signatures. Historical issue and runtime records stay
in Fantasy Football. The canary uses a new task and marker under
`tests/fixtures` and runs only in disposable repositories.

## Reproduce and validate

Run the [standalone checks](../README.md#build-and-validate-a-fresh-checkout)
in Vibez. The normal verifier reads the sealed tree and receipt from Vibez Git
history and validates coverage and hashes without the source repository.
Keep history available for those immutable object IDs.

For a source comparison, use a separate Fantasy Football clone containing the
approved commit. The verifier reads Git objects rather than working-tree files.

```sh
git clone --no-checkout https://github.com/Brain-Crumbs/IPTFantasyFootball.git .validation-source
mkdir .agent
python scripts/seed_export.py --source .validation-source --output .agent/reproduced-seed
```

Use an existing parent and a new output name. The tool reconstructs unchanged
imports from raw source objects. Deliberate adaptations and Vibez-authored
files are explicit byte inputs from the immutable reviewed seed commit.
It checks the mapping against the sealed tree and compares every output file.
The reproduced tree is the seed payload. The receipt and active delta ledger
are integration records outside that replay. Use `--check-head` to verify the
MIG-003 candidate and clean worktree against the payload and evidence. Normal
checks on later changes continue to verify the historical seed.

| Acceptance | Evidence |
| --- | --- |
| AC-01 | Fresh checkout, build and inherited tests, both Python validations and adversarial mutation checks. Windows and Linux CI each use a Vibez checkout. |
| AC-02 | All-path inventory, raw source scope digest, exact path and hash overrides, sealed tree and a fresh replay. |
| AC-03 | Tracked tree and clean worktree checks, path restrictions, credential signature scan and fixture boundaries. |
| AC-04 | Byte-identical engine and runtime schemas, #76 bridge tests and contract-bearing canary. |
| AC-05 | Exact-head CI, rights decision, historical acceptance receipt and [source delta ledger](source-deltas.json). |

The archived design check can be reproduced from the [MIG-002 checkout](https://github.com/Brain-Crumbs/Vibez/tree/053a53956a66881b4d92356fcc9f1deca321e875).
The seed CI reruns the design specification tests and checks the sealed
payload using Vibez alone.

## Ownership and rollback

Vibez owns the imported reusable baseline after acceptance. The
[delta ledger](SOURCE_DELTAS.md) keeps #78 with its Fantasy Football owner
and requires the MIG-008 synchronization checkpoint. For the next task,
use [Vibez admission guidance](../AGENTS.md) and a quiescent local state root.

Abandon a rejected seed branch or revert the reviewed integration via a PR.
Keep the rights decision, Git history and audit records. The source consumer
and runtime state stay in Fantasy Football throughout the seed.
