# Changelog

## 0.1.0-rc.4 (private candidate)

- Adds one configured operation supervisor for approved dependent tasks, shared
  by the service and CLI, with scoped roles, native gates, PR/CI coordination,
  bounded retries/rework, durable controls and uncertain-effect reconciliation.
- Adds validation-owned rework that retains failed validator evidence and the
  original assignment. Existing manual workflow commands remain supported.
- Adds operation-history reader support. rc.3 and earlier cannot read the new
  operation records; rc.4 retains existing rc.3 relocation support without
  rewriting historical records. See the compatibility and workflow guides.

## 0.1.0-rc.2

- Resolves configured validator evidence in the read-only history audit and
  upgrade preflight, including during active review.
- Preserves existing history formats and the fail-closed upgrade safeguards.
  Archive an unfinished rc.1 run with its original reader and use a separately
  admitted checkout for the corrected run.

## 0.1.0-rc.1

- Packages the configured manual workflow driver, the audited BOOT-037 import,
  and the contract-bearing UAT bridge.
- Includes compatibility inspection for existing lifecycle and evidence records
  and stopped-writer upgrade and rollback guidance.
- Keeps the existing ESM API, CLI aliases and `ipt.*` schema identities.
- Adds an installed-artifact conformance matrix and a migration source checkpoint.
- Distributes the owner-approved candidate through immutable GitHub Releases,
  limited to verified Ubuntu 24.04/ext4 and Windows Server 2025/NTFS x64
  on Node 22 and 24. Windows 11 remains unsupported.
