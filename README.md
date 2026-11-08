# Vibez

Vibez is the planned reusable home of the deterministic agent development
workflow. This repository currently contains the reviewed extraction design and
its checks, **not an installable engine or a released package**.

This is [MIG-002](https://github.com/Brain-Crumbs/Vibez/issues/2), coordinated with
the [roadmap](https://github.com/Brain-Crumbs/Vibez/issues/1) and
[Fantasy Football #74](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/74).

- [Migration inventory and execution evidence](migration/README.md)
- [Public API and consumer seams](docs/PUBLIC_API.md)
- [Project configuration and identity](docs/PROJECT_CONFIG.md)
- [Compatibility, upgrade and rollback](docs/COMPATIBILITY.md)
- [Distribution decisions and support](docs/SUPPORT.md)
- [Two consumer walkthroughs](examples/README.md)

## Validate this design

Use Python 3.11+ with `jsonschema` installed from the pinned source requirements.
Clone the source into separate directories; do not use a production runtime store.

```sh
git clone https://github.com/Brain-Crumbs/IPTFantasyFootball.git .validation-source
git -C .validation-source checkout --detach 50ef51e7dd2443dd0cec644c04e8db1b7fd612f7
git clone https://github.com/Brain-Crumbs/IPTFantasyFootball.git .validation-engine
git -C .validation-engine checkout --detach fbc46888ce0bd2af454f471561911a913d32e6fc
python -m pip install -r .validation-engine/schemas/requirements.txt
python scripts/check_design.py --source .validation-source --engine .validation-engine
python -m unittest discover -s tests -p 'test_*.py'
```

The same commands work in PowerShell; quote paths containing spaces. For the
separate source-engine regression checks, run `npm ci`, `npm run build`,
`npm test`, `python schemas/validate_fixtures.py`,
`python schemas/validate_repository_contracts.py` and
`npm run test:adversarial:mutations` from `.validation-engine` (use `npm.cmd` on
Windows if required). Set `IPT_PYTHON` to that environment's Python executable
when it differs from the `python` on PATH. There is no destination build yet.

The design checker is read-only. It verifies exact Git blob coverage/hashes,
module/CLI/epic traceability, staged records using the pinned schema, evidence
hashes, documentation links and example shapes. Negative tests check the
checker and schema; they do not claim runtime isolation, workflow completion,
or independent product acceptance. MIG-004/007/008 own those implementation proofs.
