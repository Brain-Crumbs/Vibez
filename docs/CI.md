# CI enforcement

[CI](../.github/workflows/ci.yml) runs against the actual PR head, and the
commit on a push to main or manual dispatch. Jobs check out Vibez with full
history, which the Git-based tests and provenance verifier need.

| Job | Deterministic checks |
| --- | --- |
| Build and test (Node) | Linux, Node 20. Locked npm install, build, full inherited tests and adversarial mutation checks. |
| Schema and contract validation (Python) | Linux, Python 3.11. Schema fixtures, authored records, design and provenance tests, and the sealed seed. The MIG-003 PR also checks the exact candidate tree and checkout. |
| Seed validation (Windows) | Windows, Node 24 and Python 3.11. Full suite, both schema checks and sealed seed verification. |

The engine's two inherited check names stay stable for BOOT-024 consumers.
For MIG-003, review all three jobs on the final PR head. Newer runs on a ref
supersede in-flight older runs. All jobs use the repository's own schema
tooling and standard development dependencies. CI performs deterministic
validation. The independent role judgments and merge policy are separate.

Use the [fresh checkout commands](../README.md#build-and-validate-a-fresh-checkout)
to reproduce checks locally. The [source record](../migration/SEED_EXPORT.md)
describes the separate raw-object comparison with Fantasy Football.
