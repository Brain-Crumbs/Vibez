import { FileDeveloperStartStateStore } from "../dev-start/index.js";
import { FileEvidenceStore } from "../evidence-store/index.js";
import type { readProjectAudit } from "../history/index.js";
import { FileOrchestrationRunStore, type OrchestrationStageRecord, type OrchestrationStageId } from "../orchestration-engine/index.js";
import type { ResolvedProjectConfig } from "../project-config/index.js";
import { hash, object, orchestrationDirectory, safePath, stableId, stateDirectory } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { nativeObject, revision } from "./artifacts.js";
import { recordedTime, safeText } from "./history-artifacts.js";
import { integrationObservations } from "./observations.js";

const stages = {
  "developer-start": "assignment", "dev-validation": "developer-validation", "qa-review": "qa-review",
  "architecture-review": "architecture-review", "uat-review": "uat-review", "review-rework": "rework",
  "merge-readiness": "merge-readiness", "controlled-merge": "completion",
} as const;
const nativeReviewRun = {
  "qa-review": "qa-agent", "architecture-review": "architecture-agent", "uat-review": "uat-agent",
} as const;
function nativeStageRun(source: string, stage: string) {
  const suffix = Object.hasOwn(nativeReviewRun, stage) ? nativeReviewRun[stage as keyof typeof nativeReviewRun] : stage;
  return source + "::" + suffix;
}

export function stageFor(name: string | undefined) {
  return name && Object.hasOwn(stages, name) ? stages[name as keyof typeof stages] : undefined;
}
type Audit = Awaited<ReturnType<typeof readProjectAudit>>;
const outcome = (value: unknown) => value === "PASS" ? "pass" : value === "FAIL" ? "fail" : value === "BLOCKED" ? "blocked" : null;
const safePart = (value: string) => value.replace(/[^A-Za-z0-9-]/g, ch => "_" + ch.charCodeAt(0).toString(16).padStart(4, "0"));

export function historicalGates(config: ResolvedProjectConfig, profile: DriverProfile, session: DriverSession, audit: Audit | null) {
  const root = config.projectRoot;
  const configuredRevisions = new Map<string, boolean>();
  const validatorRequired = (id: string, sha: string | null) => {
    if (!sha || !config.document.validators.some(entry => entry.id === id && entry.required)) return null;
    if (!configuredRevisions.has(sha)) {
      try { config.assertRevisionConfig(sha); configuredRevisions.set(sha, true); }
      catch { configuredRevisions.set(sha, false); }
    }
    return configuredRevisions.get(sha) ? true : null;
  };
  const source = session.request.runId;
  const attemptId = session.sessionId;
  const history = (() => {
    try {
      const directory = stateDirectory(profile) + "/lifecycle";
      safePath(root, directory + "/" + session.taskId + ".lifecycle.json");
      return (new FileDeveloperStartStateStore(safePath(root, directory), true).get(session.taskId)?.history ?? [])
        .filter(event => object(event) && typeof event.eventId === "string" && typeof event.runId === "string" &&
          typeof event.toState === "string" && typeof event.reason === "string" && typeof event.evidenceRef === "string");
    } catch { return []; }
  })();
  const journal = (() => {
    try {
      const stored = new FileOrchestrationRunStore(safePath(root, orchestrationDirectory(profile)), true)
        .get(session.request.idempotencyKey ?? source);
      return stored?.runId === source && stored.ownerId === session.request.ownerId ? stored : null;
    } catch { return null; }
  })();
  const result = session.result?.runId === source && session.result.taskId === session.taskId ? session.result : null;
  type StageRecord = Pick<OrchestrationStageRecord, "stage" | "role" | "runId" | "outcome" | "finishedAt" | "summary" | "evidenceRefs">;
  const savedStages = journal?.values.stages ?? result?.stages;
  const records: StageRecord[] = Array.isArray(savedStages) ? [...savedStages] as StageRecord[] : [];
  const nativeOutcomes = {
    "dev-validation": { role: null, pass: ["DEV_VALIDATED"], fail: ["DEV_VALIDATION_FAILED"] },
    "qa-review": { role: "QA", pass: ["ARCHITECTURE_REVIEW", "UAT_REVIEW", "MERGE_READY"], fail: ["QA_FAILED"] },
    "architecture-review": { role: "Architect", pass: ["UAT_REVIEW", "MERGE_READY"], fail: ["ARCHITECTURE_FAILED"] },
    "uat-review": { role: "UAT/Product", pass: ["MERGE_READY"], fail: ["UAT_FAILED"] },
    "controlled-merge": { role: null, pass: ["DONE"], fail: [] },
  } as const;
  type LifecycleGate = keyof typeof nativeOutcomes;
  const order = Object.keys(stages) as OrchestrationStageId[];
  // Old or interrupted runs can keep the lifecycle transition without its
  // journal summary. Match the entire stage run ID and original evidence refs.
  const inferred = new Set<string>();
  for (const event of history) {
    const stage = (Object.keys(nativeOutcomes) as LifecycleGate[]).find(name => event.runId === nativeStageRun(source, name));
    const runId = source + "::" + stage;
    if (!stage || records.some(record => record?.runId === runId)) continue;
    const mapping = nativeOutcomes[stage];
    const hasState = (states: readonly string[]) => states.includes(event.toState);
    const outcome = hasState(mapping.pass) ? "PASS" : hasState(mapping.fail) ? "FAIL" : null;
    if (!outcome) continue;
    const record: StageRecord = { stage, role: mapping.role, runId, outcome,
      finishedAt: event.occurredAt, summary: event.reason, evidenceRefs: event.evidenceRef.split(",") };
    const next = records.findIndex(other => other && order.indexOf(other.stage) > order.indexOf(stage));
    records.splice(next === -1 ? records.length : next, 0, record);
    inferred.add(runId);
  }
  const evidence = new FileEvidenceStore(safePath(root, profile.storage!.evidence), { readOnly: true });
  const scopedAudit = new Map(audit?.events.map(event => [event.eventDigest, event]));
  const observedEvidence = new Map(audit?.evidence.map(entry => [entry.lineageDigest + "@" + entry.sequence, entry]));
  const events: { eventId: string; attemptId: string; recordedAt: string | null; after: string[]; details: object }[] = [];
  let merged: Parameters<typeof integrationObservations>[3] = null;
  let priorGate: string | undefined;
  const stageGates = new Map<string, string>();
  for (const record of records) {
    if (!object(record)) continue;
    const stage = stageFor(record.stage);
    let state = outcome(record.outcome);
    if (!stage || !state || record.runId !== source + "::" + record.stage) continue;
    const lifecycle = history.slice().reverse().find(event => event.runId === nativeStageRun(source, record.stage));
    const audited = lifecycle && scopedAudit.get(hash(JSON.stringify(lifecycle.eventId)));
    const sha = revision(audited?.revision ?? lifecycle?.revisionIdentity);
    const time = recordedTime(record.finishedAt) ?? recordedTime(audited?.occurredAt ?? lifecycle?.occurredAt);
    const dependencies = priorGate ? [priorGate] : [];
    const scopedRefs = new Set(lifecycle?.evidenceRef.split(",").map(ref => ref.trim()));
    let verifiedReview = false;
    for (const ref of Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []) {
      if (typeof ref !== "string" || !scopedRefs.has(ref)) continue;
      const match = /^([A-Za-z0-9:/._+ -]{1,360})@([1-9][0-9]{0,6})$/.exec(ref);
      if (!match) continue;
      const lineage = match[1]!;
      const sequence = match[2]!;
      if (!lineage.startsWith(session.taskId + "::")) continue;
      const lineageDigest = hash(JSON.stringify(lineage));
      const auditedReference = audited?.references.find(reference => reference.lineageDigest === lineageDigest &&
        reference.sequence === Number(sequence));
      if (audited && !auditedReference?.resolves) continue;
      const auditedRecord = observedEvidence.get(lineageDigest + "@" + sequence);
      const recordPath = profile.storage!.evidence + "/" + safePart(lineage) + "/" + sequence.padStart(7, "0") + ".json";
      const raw = nativeObject(root, recordPath);
      if (raw?.lineageId !== lineage || raw.sequence !== Number(sequence) || !object(raw.payload) ||
          raw.payload.taskId !== session.taskId || !evidence.validate(raw.payload).ok ||
          (auditedRecord && auditedRecord.contentDigest !== hash(raw.payload))) continue;
      const payload = raw.payload;
      const evidenceTime = recordedTime(payload.recordedAt);
      const evidenceRevision = revision(payload.revisionIdentity);
      if (sha && evidenceRevision !== sha) continue;
      if (record.stage === "dev-validation" && payload.schemaId === "ipt.validation-evidence") {
        const value = outcome(payload.outcome);
        if (!value || typeof payload.validatorId !== "string" || payload.validatorId.length > 256) continue;
        const eventId = stableId({ attemptId, validation: ref });
        const check = Array.isArray(payload.checks) && object(payload.checks[0]) ? payload.checks[0] : null;
        dependencies.push(eventId);
        events.push({ eventId, attemptId, recordedAt: evidenceTime, after: priorGate ? [priorGate] : [],
          details: { kind: "validation-check", validatorId: payload.validatorId, outcome: value, revision: evidenceRevision,
            required: validatorRequired(payload.validatorId, evidenceRevision), evidenceId: eventId,
            diagnostic: value === "pass" ? null : { code: "VALIDATION_CHECK", message: safeText(check?.details, root, "Inspect the native validator evidence.") } } });
      }
      if (payload.schemaId === "ipt.review-result" && payload.role === record.role && Array.isArray(payload.findings)) {
        const judgment = outcome(payload.outcome);
        if (!judgment) continue;
        if (inferred.has(record.runId)) state = judgment;
        else if (state !== judgment) continue;
        verifiedReview = true;
        for (const finding of payload.findings) {
          if (!object(finding) || typeof finding.findingId !== "string") continue;
          const eventId = stableId({ attemptId, ref, findingId: finding.findingId });
          dependencies.push(eventId);
          events.push({ eventId, attemptId, recordedAt: evidenceTime, after: priorGate ? [priorGate] : [],
            details: { kind: "finding", role: payload.role, revision: evidenceRevision,
              findingId: eventId, summary: safeText(finding.observed, root, "Inspect the native reviewer finding.") } });
        }
      }
      if (record.stage === "controlled-merge" && lifecycle?.toState === "DONE" && payload.schemaId === "ipt.merge-evidence" &&
          evidenceTime && evidenceRevision && typeof payload.pullRequestNumber === "number" &&
          Number.isSafeInteger(payload.pullRequestNumber) && payload.pullRequestNumber > 0)
        merged = { recordedAt: evidenceTime, revisionIdentity: evidenceRevision, pullRequestNumber: payload.pullRequestNumber };
    }
    if (inferred.has(record.runId) && Object.hasOwn(nativeReviewRun, record.stage) && state !== "pass" && !verifiedReview) continue;
    const eventId = stableId({ attemptId, gate: record.runId });
    events.push({ eventId, attemptId, recordedAt: time, after: dependencies,
      details: { kind: "gate", gate: { state: "observed", stage, outcome: state, revision: sha,
        diagnostic: state === "pass" ? null : { code: "WORKFLOW_GATE", message: safeText(record.summary, root, "Inspect the recorded gate with Vibez.") } } } });
    priorGate = eventId;
    stageGates.set(record.stage, eventId);
  }
  const { pullRequest, ci } = integrationObservations(root, profile, session, merged);
  if (pullRequest.state === "observed")
    events.push({ eventId: stableId({ attemptId, pullRequest }), attemptId, recordedAt: pullRequest.observedAt, after: [],
      details: { kind: "pull-request", pullRequest } });
  if (ci.state === "observed")
    events.push({ eventId: stableId({ attemptId, ci }), attemptId, recordedAt: ci.observedAt, after: [], details: { kind: "ci", ci } });
  return { events, stageGates };
}
