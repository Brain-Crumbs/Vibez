# Distribution and support decisions

This is a design decision register. A decision marked unresolved is a release
blocker, not permission to guess. The migration task can be accepted with these
explicit blockers under AC-05; MIG-003/005/008 must enforce the relevant gate.

| Decision | Disposition | Accountable owner and resolution criterion |
| --- | --- | --- |
| Repository | Brain-Crumbs/Vibez, public, accepted | Owner selected destination; MIG-003 verifies rights before copying source |
| Package | Private candidate uses provisional `@brain-crumbs/vibez`, single ESM package, no CJS guarantee | Brain-Crumbs confirms scope/name control and collision check before approving a distributed artifact identity. The public registry returned no published package for that name during MIG-005; scope control remains unresolved |
| Channel | Immutable versioned tarball plus SHA-256 first; no npm publication | Brain-Crumbs approves actual release location/access and immutability policy before MIG-008; public npm requires a later explicit decision |
| Source/license rights | Scoped owner authorization for the MIG-003 source snapshot | [Decision and audit](https://github.com/Brain-Crumbs/Vibez/issues/3#issuecomment-6747942125). MIG-003 verifies each included path against the exact snapshot and records any required notices or exclusions before copying |
| Runtime | Target Node 22 and 24 LTS, ESM, npm lockfile | MIG-005 establishes engines/package semantics; MIG-008 passes both majors. Historical Node 20 build remains a compatibility probe, not a security/support promise |
| OS | Windows 11 NTFS and Ubuntu 24.04 local ext4 are the original targets; x64 baseline | MIG-008 verifies the exact runner environments. Windows 11, macOS and ARM require their own installed conformance evidence before claiming support |
| Filesystem | Single host, local disk, atomic same-directory publication, file fsync; POSIX directory fsync where available | MIG-004/007/008 test interruptions. Windows lacks directory fsync; no power-loss directory-entry durability guarantee. Network shares, cloud-sync directories and distributed writers unsupported for authoritative runtime stores |
| Source history | Allowlisted exact-revision snapshot with per-path Git blob/SHA-256 and immutable source links | MIG-003 reproduces export independently; full history and old issues remain in Fantasy Football |
| Rollback window | Seven days and one accepted ordinary task, whichever later | MIG-009 records dates/evidence, then MIG-010 may remove only inventoried dormant copies; see compatibility contract |

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
Package distribution requires its separate channel and rights decision. The
private candidate has `UNLICENSED` metadata and ships the source export
notice. Generating and testing the tarball locally grants no distribution rights.

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
