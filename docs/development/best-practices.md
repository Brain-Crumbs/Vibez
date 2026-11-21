# Evidence-backed development practices

These practices preserve the constitution and task-specific requirements; they do
not authorize new work, reviews, merges or lifecycle mutations.

## BP-001 — Verify effects of rejected workflow actions

- **Status:** active
- **Added / latest revision:** 2026-10-12
- **Rule and scope:** For a workflow safety regression, assert the specific rejection
  and inspect the effects at its persistence/provider boundaries. Compare prior
  lifecycle/evidence/assignment bytes when rejection should be read-only; inspect
  preserved history for legitimate recovery. Count attempted irreversible calls,
  not only successful effects.
- **Rationale / exceptions:** An exception after an unsafe provider call does not
  prove safe rejection. Recovery and diagnostic observations may intentionally add
  audit records; verify those authorized writes instead of demanding global silence.
- **Evidence:** [BOOT-034 #36](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/36),
  [implementation PR #72](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/72),
  ADV-001–016 in [the scenario map](../ADVERSARIAL_TESTS.md#scenario-and-invariant-map).

## BP-002 — Prove a safety test detects the guard's removal

- **Status:** active
- **Added / latest revision:** 2026-10-12
- **Rule and scope:** Where practical, run a safety test against an unmodified
  disposable runtime copy and then against a single deliberately weakened guard.
  Require a passing baseline and an assertion failure in the named test. Treat a
  loader error, timeout, missing anchor or surviving mutation as failed verification.
- **Rationale / exceptions:** A passing negative-path test can rely on an unrelated
  later guard. Small isolated mutations demonstrate which guard it actually protects.
  This bounded proof complements regular tests; it is not an exhaustive mutation
  score, and must never weaken the real checkout or production configuration.
- **Evidence:** [BOOT-034 #36](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/36),
  [implementation PR #72](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/72),
  SELF_APPROVAL/ADV-007 and PRE_MERGE_HEAD/ADV-009 in
  [the mutation proof](../ADVERSARIAL_TESTS.md#mutation-proof).

## BP-003 — Test the same wire contract downstream consumers pin

- **Status:** active
- **Added / latest revision:** 2026-11-20
- **Rule and scope:** Validate paired positive and negative payloads against the
  published wire schema. Include route-specific shape and version failures.
  Assert cross-document identities and exact bytes independently when shape
  validation alone cannot establish the behavioral promise.
- **Rationale:** A parallel validator can drift from the pinned artifact.
  Structural validity alone leaves receipt/gate confusion and whitespace loss
  undetected.
- **Evidence:** [Vibez #39](https://github.com/Brain-Crumbs/Vibez/issues/39)
  and the [manual console conformance cases](../specs/manual-console-v1/fixtures.json).

## Change history

| Date | ID | Change | Reason | Evidence |
| --- | --- | --- | --- | --- |
| 2026-10-12 | BP-001 | added | Rejection must precede unsafe persistence/provider effects | BOOT-034 #36; ADV-001–016 |
| 2026-10-12 | BP-002 | added | Confirm named tests detect two deliberately removed guards | BOOT-034 #36; mutation proof |
| 2026-10-12 | BP-001 | revised | Link the submitted implementation for reviewable evidence | [PR #72](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/72) |
| 2026-10-12 | BP-002 | revised | Link the submitted mutation proof implementation | [PR #72](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/72) |
| 2026-11-20 | BP-003 | added | Validate published transport shapes and independent cross-document promises | [Vibez #39](https://github.com/Brain-Crumbs/Vibez/issues/39) |
