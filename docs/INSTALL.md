# Install and verify a Vibez candidate

Vibez is one ESM package for Node.js 22 or 24. npm installs the tarball and
creates the executable shims. Repository commands also need Git. TypeScript
and Python with jsonschema are development tools for building or checking
Vibez itself. Running the installed package requires only Node.js, Git for
repository operations, and any executors supplied by the selected project.

## Build and verify locally

From a clean committed Vibez checkout, run `npm ci` and
`npm run pack:candidate -- <new-output-directory>`. Use Git and a tar
executable on PATH. The command archives the exact commit, builds in a
temporary directory, and writes a versioned tarball and
`candidate.json`. The receipt records the commit, package identity, Node and
npm versions, SHA-256 and npm SHA-512 integrity. Compare the receipt and
artifact before installing. For example, use `sha256sum /path/to/candidate.tgz`
on Ubuntu or `Get-FileHash -Algorithm SHA256 C:\path\to\candidate.tgz` in
PowerShell. A missing receipt, mismatch, or existing output directory blocks
reuse of that candidate location.

The approved package identity is `@brain-crumbs/vibez`. Obtain the tarball,
`candidate.json`, `release.json` and `SHA256SUMS` from the
[versioned GitHub Release](https://github.com/Brain-Crumbs/Vibez/releases/tag/v0.1.0-rc.2).
The release is a prerelease for the staged consumer migration. Compare the
tarball SHA-256 and SHA-512 with `candidate.json`, and its source commit with
the release tag and `release.json`. Reject missing or mismatched evidence.
An approved consumer pins the immutable asset URL and integrity in its lockfile.
See [distribution and tested platforms](SUPPORT.md). `private: true` prevents
npm publication; GitHub tarball installation remains supported.

## Install and run

In an independent npm consumer, run
`npm install --engine-strict --save-exact /path/to/candidate.tgz` to test a
verified local copy. This adds the dependency and lockfile entry. The package
has no install hooks and does not initialize or execute a project.

| Scope | Ubuntu shell | Windows PowerShell |
| --- | --- | --- |
| Local binary | `./node_modules/.bin/vibez --help` | `.\node_modules\.bin\vibez.cmd --help` |
| Standalone install | `npm install --global --engine-strict /path/to/candidate.tgz` | `npm install --global --engine-strict C:\path\to\candidate.tgz` |
| Standalone binary on PATH | `vibez --json --version` | `vibez.cmd --json --version` |

Use `npm prefix -g` to locate the installation. On Ubuntu the global
executables are in its `bin` subdirectory. On Windows npm puts the shims in
the prefix itself. A dedicated npm prefix keeps a rehearsal isolated from
other global tools. Both installations provide `agent` as an alias for
`vibez` with the same arguments, exit codes and v1 JSON envelope. The
`version` command reads the installed manifest.

Repository primitives such as `status` and `next` use the checkout from
which the executable is invoked. For an empty registry, create and track an
empty marker such as `tasks/definitions/.gitkeep` before calling `status` or `next`.
Use [the configured graph](CONFIGURED_RUNTIME.md)
to address an explicitly selected project from another working directory.
The general `review` and `rework` commands still return exit
3. Manual packet commands keep their existing behavior. See the
[CLI reference](CLI.md) for arguments and failure codes.

## Installed headless acceptance

For the bounded Linux local-provider host, use the packaged
[unattended acceptance guide](UNATTENDED_ACCEPTANCE.md) and
[preparation example](../examples/unattended/README.md). Installing the package
never enables a grant or changes repository protection. rc.5 is an acceptance
candidate until an immutable release receipt identifies its live proof and
reviews. The rc.2 link above remains the accepted Fantasy Football pin.

## Library use and rollback

Import the [supported ESM paths](PUBLIC_API.md) in JavaScript or TypeScript
with NodeNext module resolution. Call
`describeCapabilities({ apiVersion: "1.0.0", packageVersion: pinnedVersion })`
before configuring a graph when the caller requires those exact identities.
Use `doctorProject` to identify a missing configured tool or package asset.

Keep prior immutable tarballs, their checksums and the matching lockfile
and committed config. Stop all writers before replacing an installed build.
The configured runtime binds package manifest bytes and the config to the
project state. Resume an existing bound run with the exact prior build and
configuration. Restore the pinned dependency and lockfile with the prior
verified artifact, then inspect with doctor and read-only status before
reenabling writers. Preserve state, evidence, exchange and binding files.
If the prior reader rejects the newer history, keep the store stopped for
a reviewed compatibility decision. See [compatibility and rollback](COMPATIBILITY.md).

Use the [installed manual workflow driver](WORKFLOW_DRIVER.md) for guided setup and manual role handoffs.
