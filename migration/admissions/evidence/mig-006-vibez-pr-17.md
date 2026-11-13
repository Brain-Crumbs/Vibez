Closes #5. Refs #1 and Brain-Crumbs/IPTFantasyFootball#74.

MIG-005 packages Vibez as an installable ESM library with 14 explicit entry points and TypeScript declarations. The installed `vibez` and `agent` binaries share the existing v1 command contract. The package remains private and `UNLICENSED` pending the separate identity, rights and distribution decisions.

## Acceptance

| Criterion | Evidence |
| --- | --- |
| AC-01 | A fresh consumer imports every documented path and compiles against installed declarations using strict NodeNext. Deep imports reject. |
| AC-02 | The actual tarball installs offline into clean local and standalone npm prefixes. POSIX and Windows shims preserve help, installed version, reserved exit 3 and the JSON envelope. |
| AC-03 | CI inspects the tarball against the package allowlist. It contains compiled JS, declarations, runtime schemas and semantic contracts, config templates, operator guides and the rights notice. |
| AC-04 | The tarball test checks npm SHA-512 integrity and that install does not run workflow or modify the sentinel. Two builds from the same archived revision produced the same SHA-256. |
| AC-05 | The installed fixtures reject mismatched API/package versions and report missing tools and assets. Config preview, doctor and status leave workflow state untouched. |
| AC-06 | The package uses a provisional name and ships the source-export notice. Registry publication and artifact distribution remain gated on owner decisions. |

The [install and rollback guide](https://github.com/Brain-Crumbs/Vibez/blob/46dddcb0668b4a92e691eb5a0a6f8d2f19303e38/docs/INSTALL.md) covers verified artifacts, both CLI names, configured hosts and restoring the exact prior binary/lockfile/config while preserving runtime history. The general driver remains under #6.

## Native execution

MIG-004's native DONE and original merge evidence `MIG-004::merge@1` satisfied the dependency in the original Vibez state store. Admission at `46ca8ed7e60b9ed58e9c07f232e5b4bec9c91f81` received independent QA, Architecture and UAT review before native selection and start. Developer `mig005-developer`, run `mig005-20261110`.

Architecture rejected `4bf20f460404e00d1203bf37903e8b42716ea96f` because public CLI metadata was mutable and linked guides were missing from the tarball. UAT also identified the missing empty-registry step. Native rework preserved the original findings. The revised package freezes shared metadata, includes the guides and documents the registry prerequisite.



## Final verification

All evidence below binds `46dddcb0668b4a92e691eb5a0a6f8d2f19303e38`.

- `repository:build` PASS at evidence sequence 2.
- `repository:test` PASS at evidence sequence 2.
- Schema fixtures, 36 repository records, nine Python tests and historical seed verification passed.
- Both adversarial mutation checks detected their weakened guards.
- GitHub's Node, Python and Windows jobs passed. [Exact-head CI](https://github.com/Brain-Crumbs/Vibez/actions/runs/42891698566)

Native validation result SHA-256 `09bd2856f348a3a7decf87096ab8fb08bb9d9643549c4fd0c0d2bf805aeaf902`.

Private candidate `@brain-crumbs/vibez@0.1.0-mig005.1` built twice with Node v24.18.0 and npm 11.16.0.

- Tarball SHA-256 `71b30590b1ab8db1b3046c1aec577af4010cbb2d89a4282b7604a4c077686204`
- npm integrity `sha512-OgrQkuwaAFSn5b7SqOaPOMIVFPnvoLXQBqrs84i7eoaI1D3Cbr/zjf5MeAVKjIqw24LxUr60ay2M31h16XE05Q==`

## Independent reviews

<details>
<summary>QA independent PASS</summary>

Agent session `/root/qa`. Report SHA-256 `4e69ed9d491a43eb6f50cb13690fa5c5eddf55e2e3cd27af882b46e13159fe7b`. Native stage `ARCHITECTURE_REVIEW`.

- AC-01/02: Fresh Windows exact-head checkout ran the installed-package test and all 18 CLI tests on Node 24.18.0/npm 11.16.0. The isolated consumer compiled and imported every supported ESM entry, and both npm local shims and the standalone alias executed.
- AC-03: Inspected all 221 members of the 0.1.0-mig005.1 archive. The six shipped guides, notice, templates, schemas, runtime contracts, ESM and declarations are present. Confirmed the guides relative links against tar members and their pinned Git references against Git. No Git, agent state, environment, test or planning inputs are present.
- AC-04: Two clean pack:candidate runs at 46dddcb produced identical SHA-256 71b30590b1ab8db1b3046c1aec577af4010cbb2d89a4282b7604a4c077686204. Independently verified SHA-512 integrity, candidate identity and source commit. The installed package test confirmed the no-hooks and no-unexpected-project-writes contract.
- AC-05/06: The configured missing-executor, missing-schema, and unsupported identity scenarios still fail with actionable guidance. The package remains private and UNLICENSED, includes its export notice, and documents release identity, channel and rights gates.

- The installed helper rejected attempts to mutate reserved command entries, EXIT_CODES and validator categories with TypeError. The reserved command continued to return exit 3.
- All 17 validation-framework regression cases passed, including rejection of unsupported category, executor absence and deterministic ordering.
- The documentation now identifies the legacy empty-registry marker and provides working bundled links from the installation guide.

</details>

<details>
<summary>Architecture independent PASS</summary>

Agent session `/root/architecture`. Report SHA-256 `4bcce117a1b8121d3815955544c874f63b97369037d05d289f13b6a99fb30093`. Native stage `UAT_REVIEW`.

- control-plane.cli-shell
- control-plane.local-agent-adapter
- control-plane.validation-framework
- control-plane.task-registry
- control-plane.pr-lifecycle
- control-plane.ci-enforcement
- control-plane.merge-readiness
- control-plane.controlled-merge

- Fantasy Football #75 configured application graph and capability discovery
- Fantasy Football #78 provider, role packet, and configured CLI ports
- Standalone and legacy agent binary callers
- External strict NodeNext declarations
- Package-owned runtime assets and execution binding
- Private package candidate provenance and rollback

The explicit ESM export map and corresponding declarations preserve the existing configured graph and named registry, validation, review, provider, integration and diagnostics ports. GitHub fetch parameters remain structurally compatible and use package-owned type declarations. The installed tarball test passed in a separate Windows checkout, including strict TypeScript imports, configured primitives from an unrelated working directory, both binary aliases, rejection of undocumented paths, version checks and damaged assets. Freezing metadata at the producer prevents consumers from modifying the reserved-command exit code or accepted validator categories. Installed documentation now includes the configured host, CLI, distribution and rollback guides, with immutable source links for related materials outside the package.

The change exposes the established service graph and preserves exact revision validation, role visibility, independent review, publication and controlled merge authority. The existing package-manifest binding stays in place. Upgrade and rollback guidance requires stopped writers, the exact compatible prior package and config, and preservation of append-only evidence and state. The manifest stays private and UNLICENSED, distribution remains separately gated, and installation invokes no workflow or install hooks. Two independent local packs of this exact commit using Node 24.18.0 and npm 11.16.0 matched SHA-256 71b30590b1ab8db1b3046c1aec577af4010cbb2d89a4282b7604a4c077686204.

</details>

<details>
<summary>UAT/Product independent PASS</summary>

Agent session `/root/uat`. Report SHA-256 `70107871c888346b2936aa2cca4c779045457786afe39340414fa128e09e54ac`. Native stage `MERGE_READY`.

- An operator builds a private exact-revision candidate, verifies its identity and digests, and finds the linked setup, CLI, release and rollback guides in the installed payload.
- An independent Windows operator installs the verified artifact locally and globally, then uses both executable aliases from a separate checkout containing the documented empty registry marker.
- A library consumer checks package and API identity, previews and initializes tracked configuration, and observes diagnostics and status without mutating runtime state.
- A maintainer restores a previously verified immutable package with its exact lockfile and committed project configuration while writers remain stopped.

- The Windows 24.18.0 and npm 11.16.0 private candidate verified source commit 46dddcb0668b4a92e691eb5a0a6f8d2f19303e38, version 0.1.0-mig005.1, SHA-256 71b30590b1ab8db1b3046c1aec577af4010cbb2d89a4282b7604a4c077686204 and matching npm SHA-512 integrity. The tarball includes all four linked operator guides and the two API/install guides. PUBLIC_API links the omitted machine map to the verified immutable base revision. The install guide now instructs tracking tasks/definitions/.gitkeep. Both earlier UAT documentation findings are resolved.
- Offline engine-strict local and isolated-prefix global installs succeeded after hiding the source checkout. The local install preserved its sentinel and added only package metadata and dependencies. The four Windows shims passed help, exact manifest version in the v1 envelope, status, next and reserved review/rework/orchestrate exit code 3. The project remained free of workflow state and tracked changes.
- Independent installed ESM imports rejected mismatched API and package versions with guidance. Config preview was read-only, initialization refused to overwrite, a missing registered executor was reported, and configured doctor and status passed once executors were supplied. Removing installed schemas caused doctor to reject with reinstall guidance.
- Restored the prior private candidate 0.1.0-mig005.0 with its original package and lockfile bytes via offline engine-strict npm ci. Doctor, configured status and the legacy agent alias passed. The previous lockfile and tracked project config hashes matched, and state and binding files remained absent. The candidate is private and UNLICENSED. Scope control, approved distribution channel and package rights remain release gates. No artifact was published.

</details>

## Controlled completion

GitHub merged the reviewed head after all required checks passed. The native controller recorded DONE at `d1ee95ceee47f1241bc0a5757e9d9bcf8801bbfb` with `MIG-005::merge@1`.

Native merge result SHA-256 `e2ac8a625623faa8a1b4df9795ffa2887af402b011631784746f64527efaaa75`.
