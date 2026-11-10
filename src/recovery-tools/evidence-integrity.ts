import type { StoredEvidenceRecord } from "../evidence-store/index.js";
import type { LifecycleHistoryEvent } from "../lifecycle/index.js";

const reviewer = new Map([
  ["QA_REVIEW", "QA"], ["ARCHITECTURE_REVIEW", "Architect"], ["UAT_REVIEW", "UAT/Product"],
  ["QA_FAILED", "QA"], ["ARCHITECTURE_FAILED", "Architect"], ["UAT_FAILED", "UAT/Product"],
]);

export function inspectEvidenceReferences(taskId: string, event: LifecycleHistoryEvent,
  histories: ReadonlyMap<string, readonly StoredEvidenceRecord[]>, previous?: LifecycleHistoryEvent) {
  // The recovery owner separately checks intent/result references and hashes.
  // A reset from a review state is not the review gate's judgment.
  if (event.toState === "BLOCKED") return [];
  const resumed = event.fromState === "REWORK_REQUIRED" && event.toState === "IN_DEVELOPMENT";
  const role = resumed ? reviewer.get(previous?.fromState ?? "") : reviewer.get(event.fromState);
  const merge = event.toState === "MERGED" || event.toState === "DONE";
  const validation = event.toState === "DEV_VALIDATED" || event.toState === "DEV_VALIDATION_FAILED" ||
    (event.fromState === "DEV_VALIDATED" && event.toState === "MERGE_READY");
  const schema = merge ? "ipt.merge-evidence" : validation ? "ipt.validation-evidence"
    : role !== undefined ? "ipt.review-result" : null;
  if (schema === null) return [];
  const nonPass = event.toState.endsWith("_FAILED") || event.toState === "REWORK_REQUIRED" || resumed;
  return (event.evidenceRef ?? "").split(",").map(reference => {
    const match = /^(.*)@([1-9][0-9]*)$/.exec(reference);
    if (!match || !match[1]!.startsWith(`${taskId}::`) || !Number.isSafeInteger(Number(match[2]))) {
      return { reference, lineage: null, sequence: null, code: "LIFECYCLE_EVIDENCE_REF_INVALID" };
    }
    const lineage = match[1]!;
    const sequence = Number(match[2]);
    const record = histories.get(lineage)?.find(item => item.sequence === sequence);
    const detail = { reference, lineage, sequence };
    if (!record) return { ...detail, code: "LIFECYCLE_EVIDENCE_MISSING" };
    const payload = record.payload;
    if (payload.taskId !== taskId || payload.schemaId !== schema || payload.revisionIdentity !== event.revisionIdentity ||
      (role !== undefined && payload.role !== role)) return { ...detail, code: "LIFECYCLE_EVIDENCE_MISMATCH" };
    if (schema === "ipt.review-result" && (nonPass ? !["FAIL", "BLOCKED"].includes(String(payload.outcome)) : payload.outcome !== "PASS")) {
      return { ...detail, code: nonPass ? "LIFECYCLE_EVIDENCE_NOT_FAILURE" : "LIFECYCLE_EVIDENCE_NOT_PASS" };
    }
    return { ...detail, code: null };
  });
}
