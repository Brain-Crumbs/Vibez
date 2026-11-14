# Vibez migration candidate

MIG-008 prepares `@brain-crumbs/vibez@0.1.0-rc.1` for a pinned consumer rollout.
The package remains private and UNLICENSED. See the [decision register](SUPPORT.md)
for distribution conditions and the [changelog](../CHANGELOG.md) for the candidate scope.

## Build and verify

From a clean reviewed checkout, run `npm ci`,
`npm run pack:candidate -- <new-directory>`, and
`npm run test:conformance -- <new-directory>` with Git, tar, Node 22 or 24, and
Python on PATH. The conformance run checks the exact tarball and both receipt
digests. The test workload installs offline in temporary directories outside
the source checkout and runs with only the installed runtime on the module path.

The CI matrix matches each local pack to a single reference digest and tests it under each
combination of Node 22 and 24 with Ubuntu 24.04 and the Windows runner. The
receipt identifies the tested revision and the tarball by SHA-256 and npm
SHA-512 integrity. Windows and Ubuntu results apply to the tested x64 runners.
See [support](SUPPORT.md) for storage boundaries. macOS, ARM, network shares,
cloud-sync directories and concurrent writers on separate hosts are unsupported.

## Install, diagnose and roll back

Obtain the tarball and `candidate.json` from the approved location in the
release receipt. Compare SHA-256 against the receipt and use
`npm install --engine-strict --save-exact <verified-tarball>` from a separate
tools directory. Commit the consumer's exact dependency and integrity lock
once adoption is authorized. Check `vibez --json --version` against the receipt.

Use [configured runtime](CONFIGURED_RUNTIME.md) to commit the project profile
and provide the required validator executors. Use the [manual driver guide](WORKFLOW_DRIVER.md)
for setup and handoffs. Run doctor, status, explain and recovery check before
attempting recovery. Audit records identify the original revision and references.

To roll back, follow the [stopped-writer procedure](COMPATIBILITY.md) and
restore the prior verified tarball, matching lockfile and configuration.
Retain and verify the current history and backup before opening a prior reader.
Keep writers stopped if the prior reader rejects any retained record.
Withdraw adoption guidance for a faulty candidate and supersede it with a
new version while preserving the original artifact and receipt.

## Release approval

The owner records the package identity decision, rights for the complete
candidate payload, release location, access and immutability policy before
distribution. The release record links the reviewed commit, source checkpoint,
matrix, independent reviews, and exact tarball digest. Public npm publication
requires a separate decision. A private pack, CI run or conformance fixture
does not itself distribute or accept the migration candidate.
