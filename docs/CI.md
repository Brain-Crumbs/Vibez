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
supersede in-flight older runs. All jobs use Vibez's schema tooling and
standard development dependencies.

## PR head vs. merge-commit checkout

PR jobs check out `github.event.pull_request.head.sha` explicitly. The
reviewed head and each check therefore refer to the same commit, even when
GitHub generates a preview merge against main.

## Running the same checks locally

Use the [fresh checkout commands](../README.md#build-and-validate-a-fresh-checkout)
to reproduce checks locally. The [source record](../migration/SEED_EXPORT.md)
describes the separate raw-object comparison with Fantasy Football.

## Out of scope follow-up

Repository administrators control protection rules. CI performs deterministic
validation, and the independent role judgments and merge policy run separately.
