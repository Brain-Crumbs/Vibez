# Distribution and support decisions

This register records the approved distribution and support boundary. The
[owner decision](https://github.com/Brain-Crumbs/Vibez/pull/23#issuecomment-6902648199) on 2026-11-15 confirms the package identity and complete-payload
distribution rights, selects GitHub Releases, and limits support to verified
platforms. Publication and acceptance still require exact-artifact evidence.

| Decision | Disposition | Accountable owner and resolution criterion |
| --- | --- | --- |
| Repository | Brain-Crumbs/Vibez, public, accepted | Owner selected destination; MIG-003 verifies rights before copying source |
| Package | `@brain-crumbs/vibez`, single ESM package, no CJS guarantee | Owner confirmed identity control. `private: true` prevents npm publication; it does not prohibit the approved GitHub tarball channel |
| Channel | Public GitHub Releases in Brain-Crumbs/Vibez; immutable versioned tarball, receipt and SHA-256; no npm publication | Enable GitHub release immutability before publishing. Preserve original assets/tags and issue a new version for corrections. A prerelease is the MIG-009 adoption candidate |
| Source/license rights | Owner-authorized source export and complete MIG-008 candidate distribution | Retain source provenance, copyright and notices. The 2026-11-15 decision authorizes package distribution; `UNLICENSED` remains and no additional public license is granted |
| Runtime | Node 22 and 24, ESM, npm lockfile | Both majors must pass the exact-candidate CI matrix. Node 20 is unsupported |
| OS | Ubuntu 24.04 local ext4 and Windows Server 2025 local NTFS, x64, each on Node 22/24 | Owner approved this verified matrix. Local Windows 10/Node 24 is additional observational evidence only. Windows 11, other Windows versions, macOS and ARM are not supported by this candidate |
| Filesystem | Single host, local disk, atomic same-directory publication, file fsync; POSIX directory fsync where available | MIG-004/007/008 test interruptions. Windows lacks directory fsync; no power-loss directory-entry durability guarantee. Network shares, cloud-sync directories and distributed writers unsupported for authoritative runtime stores |
| Source history | Allowlisted exact-revision snapshot with per-path Git blob/SHA-256 and immutable source links | MIG-003 reproduces export independently; full history and old issues remain in Fantasy Football |
| M1 cleanup | Accepted MIG-010 cleanup; no elapsed-time or ordinary-feature waiting gate | [Issue #82 revision](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/82) superseded those proposed gates on 2026-11-16; parity, review, rollback and preserved-history requirements remained |

## MIG-003 source export decision

Brain-Crumbs authorized the audited source export on 2026-11-09 for material
the owner owns or has permission to redistribute. The scope is the 244
`copy` and `adapt` candidates in the reviewed inventory, resolved at Fantasy
Football commit `5cd23ef5415f2d2140654551f9152339417e4b58`, for export into
public `Brain-Crumbs/Vibez`. The owner's material retains its copyright where
applicable, with no additional public license. GitHub's public-repository
terms apply.

Use the [owner decision and scope digest](https://github.com/Brain-Crumbs/Vibez/issues/3#issuecomment-6747942125)
to verify the exact candidate set. Keep required upstream notices and exclude
any material with unclear redistribution rights until permission is recorded.
Changes to the source revision or expanded scope require a refreshed decision.
The separate 2026-11-15 owner decision now authorizes the complete MIG-008
candidate through GitHub Releases. The package retains `UNLICENSED` metadata
and the source export notice. Local packing alone does not constitute release
acceptance, and npm publication remains unauthorized.

## Support and release evidence

The package manifest targets Node 22 and 24. MIG-005 CI exercises the packed
binary on Ubuntu with Node 22 and Windows with Node 24. MIG-008 owns the full
installed consumer matrix. The pinned design-validation engine still declares
Node >=20. MIG-002 checks design on Python 3.11 and local Windows Python; the
engine regression suite does not prove the future package matrix.

The maintainer's release receipt must identify exact source/destination SHA,
package name/version and checksum, supported reader/data versions, OS/runtime
results, accepted source deltas, rights/license decision and independent reviews.
No install hook may grant permissions, start workflows, create remote resources
or overwrite project files. Example initialization in MIG-005 must be explicit,
non-destructive and conflict-aware.

AUT-004's headless proof is separately limited to Ubuntu 24.04 x64 (including
WSL 2 on local ext4), Bubblewrap and the exact local llama.cpp/Qwen3 pins in
[LOCAL_HEADLESS.md](LOCAL_HEADLESS.md). Native Windows headless support is not
established by the general package matrix. The immutable release receipt must
name the installed live-chain/fault reports and independent final reviews;
[acceptance instructions](UNATTENDED_ACCEPTANCE.md) do not themselves certify a release.
