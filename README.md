# Vibez

Vibez is the source home of the deterministic agent development workflow.
This seed builds directly from a Vibez checkout. It uses the existing private
development package identity while the public API and installation contract
are prepared.

The [migration record](migration/SEED_EXPORT.md) links the audited source
snapshot, export decision, scope, validation, and rollback. See the [roadmap](https://github.com/Brain-Crumbs/Vibez/issues/1)
and [Fantasy Football #74](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/74)
for ownership and sequencing.

## Build and validate a fresh checkout

Use Git, Node.js 20 or later, npm, and Python 3.11 or later. TypeScript and
Python jsonschema are development tools. The compiled Node CLI needs neither
Python nor a Fantasy Football checkout for ordinary commands.

```sh
npm ci
python -m pip install -r schemas/requirements.txt
npm run build
npm test
python schemas/validate_fixtures.py
python schemas/validate_repository_contracts.py
python -m unittest discover -s tests -p 'test_*.py'
python scripts/seed_export.py
npm run test:adversarial:mutations
```

Use an isolated Python environment. In PowerShell, use `npm.cmd` if needed
and set `$env:IPT_PYTHON` to the schema-enabled interpreter if `python` on
PATH points elsewhere. The tests create disposable Git repositories. Use
`npm run canary:rehearse` for a [local fixture walkthrough](docs/SEED_REHEARSAL.md).

```sh
node dist/cli/cli.js --help
node dist/cli/cli.js --json status
```

A fresh checkout has an empty active registry. Follow [operating instructions](AGENTS.md)
before registering or starting work. The project configuration examples describe
the design for later portability work.

- [CLI and operator documentation](docs/README.md)
- [Public API design](docs/PUBLIC_API.md)
- [Project configuration design](docs/PROJECT_CONFIG.md)
- [Compatibility and rollback](docs/COMPATIBILITY.md)
- [Support and distribution decisions](docs/SUPPORT.md)
