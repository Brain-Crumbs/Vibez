import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { FileEvidenceStore, EVIDENCE_STORE_SUPPORTED_SCHEMAS } from "../evidence-store/index.js";
import { schemaErrors } from "../local-agent-adapter/schema.js";
import { parseOrchestrationRunJournal } from "../orchestration-engine/index.js";
import { readPackageJson } from "../project-assets/index.js";
import { readPackageIdentity } from "../project-assets/identity.js";
import { digest, projectGit, resolveProjectConfig, writablePaths, type ProjectLocation } from "../project-config/index.js";
import { checkRecoveryState } from "../recovery-tools/index.js";
import { createLocalStatusDependencies, readLocalLifecycleStates } from "../status-reporting/index.js";
import { readEvidenceHistories } from "../status-reporting/local-source.js";
import { loadTaskRegistry } from "../task-registry/index.js";
import { hashText, identityDigest, isSha, object, parseProvenance } from "./provenance.js";
import { inventory, optionalStat, type HistoryFile } from "./snapshot.js";

const priorPackage = "0.1.0-mig005.1";
const currentPackage = "0.1.0-mig007.0";
const taskPattern = /^[A-Z]+-[0-9]{3,}$/;
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const settled = new Set(["PLANNED", "READY", "DONE"]);
const legacyLayout = { state: ".agent/state" };
const observedOnly = "OBSERVATION_ONLY";

export const historyCompatibility = Object.freeze({
  version: 1,
  apiVersion: "1.0.0",
  cliEnvelopeVersion: "1.0.0",
  readerPackages: Object.freeze([priorPackage, currentPackage]),
  evidenceVersions: EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  lifecycleVersions: Object.freeze(["1.0.0", "1.1.0"]),
  assignmentVersions: Object.freeze(["1.0.0", "1.1.0"]),
  authoredRecordVersions: Object.freeze({ task: "1.0.0", requirement: "1.0.0", moduleContractSchema: "1.0.0" }),
  projectConfigVersion: "1.0.0",
  orchestrationJournalVersion: 1,
  manualExchangeVersion: "1.0.0",
  recoveryAuditVersion: "1.0.0",
  provenanceReceiptVersion: 1,
});

export interface HistoryLocation {
  readonly repositoryRoot: string;
  readonly config?: Omit<ProjectLocation, "projectRoot">;
}

export interface UpgradeCheckRequest extends HistoryLocation {
  readonly targetPackageVersion: string;
  readonly expectedSnapshotSha256?: string;
  readonly expectedConfigDigest?: string;
  readonly expectedProjectIdentity?: string;
  readonly expectedBindingSha256?: string | null;
  /** Trusted host/operator confirmation. File observations cannot attest process liveness. */
  readonly quiescence?: { readonly localWritersDrained: true; readonly externalSessionsDrained: true };
}

function commit(value: unknown) {
  return typeof value === "string" && commitPattern.test(value) ? value : null;
}

async function openHistory(location: HistoryLocation) {
  const root = realpathSync(location.repositoryRoot);
  if (projectGit(root, ["rev-parse", "--show-prefix"]).trim() !== "") throw new Error("Select the original checkout root.");
  const revision = projectGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const config = location.config === undefined ? null : resolveProjectConfig({ projectRoot: root, ...location.config });
  const gitDir = config?.gitCommonDir ?? join(root, ".git");
  const markerPath = join(gitDir, "vibez-project.json");
  if (optionalStat(gitDir)?.isDirectory() !== true || optionalStat(gitDir)?.isSymbolicLink()) throw new Error("Select a dedicated original Git checkout.");
  const marker = optionalStat(markerPath);
  if (marker !== null && (marker.isSymbolicLink() || !marker.isFile() || marker.nlink !== 1)) throw new Error("Unsafe project binding.");
  const bindingText = marker === null ? null : readFileSync(markerPath, "utf8");
  const binding: unknown = bindingText === null ? null : JSON.parse(bindingText);
  if (binding !== null) {
    if (config === null || !object(binding) || Object.keys(binding).length !== 3 ||
      binding.worktreeIdentity !== config.worktreeIdentity || !isSha(binding.executionBinding) ||
      digest(binding.writablePaths) !== digest(writablePaths.map(name => process.platform === "win32"
        ? config.paths[name].toLowerCase() : config.paths[name]))) throw new Error("Runtime belongs to another project, worktree or layout.");
  }
  const layout = config === null ? legacyLayout : Object.fromEntries(writablePaths.map(name => [name, config.document.paths[name]]));
  const state = config?.document.paths.state ?? legacyLayout.state;
  const evidence = config?.document.paths.evidence ?? `${state}/evidence`;
  const orchestration = config === null ? `${state}/orchestration` : `${config.document.paths.operations}/orchestration`;
  const paths = { state, evidence, orchestration };
  const registry = await loadTaskRegistry(config === null ? { repositoryRoot: root } :
    { repositoryRoot: root, taskDirectory: config.paths.tasks });
  const store = new FileEvidenceStore(join(root, evidence), { readOnly: true });
  const source = await createLocalStatusDependencies(root, registry, {
    state: join(root, state), evidence: join(root, evidence), evidenceStore: store,
  });
  return { root, config, revision, registry, paths, source, layout, store, bindingSha256: bindingText === null ? null : hashText(bindingText) };
}

type History = Awaited<ReturnType<typeof openHistory>>;

function scanObservations(history: History, files: readonly HistoryFile[]) {
  const findings = new Set<string>();
  const provenance = new Map<string, ReturnType<typeof parseProvenance>[]>();
  const runs: { taskId: string | null; ownerDigest: string | null; runDigest: string | null;
    keyDigest: string | null; attempts: Record<string, number>; pendingStage: string | null; authority: string }[] = [];
  const agentResults: { taskId: string; subject: unknown; view: Record<string, unknown> }[] = [];
  const packets = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>>();
  const packetSchema = readPackageJson("schemas/v1/local-agent-packet.schema.json").document;
  const resultSchema = readPackageJson("schemas/v1/local-agent-result.schema.json").document;
  for (const file of files) {
    const text = () => {
      const base = history.layout[file.area as keyof typeof history.layout];
      if (base === undefined) throw new Error("Unknown history area.");
      const value = readFileSync(join(history.root, base, file.name), "utf8");
      if (hashText(value) !== file.sha256) throw new Error("Record changed while inspected.");
      return value;
    };
    if (["state", "operations", "exchange"].includes(file.area) &&
      (/(?:^|\/)\.claims\//.test(file.name) || /(?:\.lock(?:\.json)?|\.mutex|\.tmp)$/.test(file.name))) {
      findings.add("WRITER_OR_UNRECONCILED_LOCK");
    }
    if (file.area === "operations" && !/^(?:audit-provenance|orchestration|retry-grants)\//.test(file.name)) {
      findings.add("UNSUPPORTED_OPERATION_RECORD");
    }
    if (file.area === "operations" && file.name.startsWith("retry-grants/") && !file.name.endsWith(".tmp")) {
      const receipt: unknown = JSON.parse(text());
      if (!object(receipt) || !object(receipt.grant) || Object.keys(receipt).length !== 2 ||
        digest(receipt.grant) !== receipt.sha256 || !isSha(receipt.grant.executionBinding) ||
        typeof receipt.grant.idempotencyKey !== "string" ||
        file.name !== `retry-grants/${digest(receipt.grant.idempotencyKey)}.${receipt.grant.previousMaxAttempts}.json`) {
        throw new Error("Unsupported retry receipt.");
      }
    }
    if ((file.area === "state" || file.area === "operations") && file.name.startsWith("orchestration/") && file.name.endsWith(".run.json")) {
      const journal = parseOrchestrationRunJournal(text());
      if (file.name !== `orchestration/${hashText(journal.idempotencyKey)}.run.json`) throw new Error("Run journal binding mismatch.");
      const start = journal.values.start;
      const taskId = object(start) && typeof start.taskId === "string" && taskPattern.test(start.taskId) ? start.taskId : null;
      if (journal.pendingStage || journal.values.result === undefined || taskId === null ||
        !history.registry.has(taskId) || history.source.lifecycle.get(taskId)?.currentState !== "DONE") findings.add("UNSETTLED_RUN");
      runs.push({ taskId, ownerDigest: identityDigest(journal.ownerId), runDigest: identityDigest(journal.runId),
        keyDigest: identityDigest(journal.idempotencyKey), attempts: journal.attempts, pendingStage: journal.pendingStage ?? null,
        authority: observedOnly });
      if (taskId !== null) for (const [stage, attempts] of Object.entries(journal.attempts)) {
        const cached = journal.values[stage];
        if (!object(cached) || !object(cached.result)) continue;
        const { role, runId, revisionIdentity, providerId, outcome } = cached.result;
        agentResults.push({ taskId, subject: { taskId, role, runId, actorId: cached.actorId, revisionIdentity },
          view: { stage, attempts, role, runDigest: identityDigest(runId), actorDigest: identityDigest(cached.actorId),
            providerDigest: identityDigest(providerId), revision: commit(revisionIdentity), outcome, authority: observedOnly } });
      }
    }
    if (file.area === "operations" && file.name.startsWith("audit-provenance/") && !file.name.endsWith(".tmp")) {
      const receipt = parseProvenance(text(), file.name.slice("audit-provenance/".length));
      if (receipt.projectIdentity !== history.config?.projectIdentity) throw new Error("Foreign provenance receipt.");
      const { subject, ...engine } = receipt;
      const existing = provenance.get(subject) ?? [];
      existing.push({ subject, ...engine });
      provenance.set(subject, existing);
    }
    if (file.area === "exchange" && !file.name.endsWith(".tmp")) {
      const match = /^([a-f0-9]{64})\.(packet|result)\.json$/.exec(file.name);
      const document: unknown = JSON.parse(text());
      if (match === null || !object(document) || document.packetId !== match[1] ||
        schemaErrors(document, match[2] === "packet" ? packetSchema : resultSchema).length !== 0) throw new Error("Unsupported exchange record.");
      (match[2] === "packet" ? packets : results).set(match[1]!, document);
    }
  }
  const attempts = [];
  for (const [id, packet] of packets) {
    const result = results.get(id);
    const binding = packet.resultBinding;
    if (!object(binding) || Object.keys(binding).some(key => packet[key] !== binding[key] ||
      (result !== undefined && result[key] !== binding[key]))) throw new Error("Manual result binding mismatch.");
    if (result === undefined) findings.add("UNSETTLED_EXTERNAL_PACKET");
    attempts.push({ taskId: packet.taskId, subject: { taskId: packet.taskId, role: packet.role, runId: packet.runId,
      actorId: packet.actorId, revisionIdentity: packet.revisionIdentity },
      view: { packetId: id, role: packet.role, revision: commit(packet.revisionIdentity),
        actorDigest: identityDigest(packet.actorId), runDigest: identityDigest(packet.runId), providerDigest: identityDigest(packet.providerId),
        state: result?.status ?? "PENDING", authority: observedOnly } });
  }
  if ([...results.keys()].some(id => !packets.has(id))) throw new Error("Manual result has no original packet.");
  return { findings, provenance, runs, attempts: [...attempts, ...agentResults] };
}

/** Inspect validated evidence and original lifecycle history without returning arbitrary stored text. */
export async function readProjectAudit(location: HistoryLocation, taskId: string) {
  if (!taskPattern.test(taskId)) throw new Error("Select a registered task ID.");
  const history = await openHistory(location);
  if (!history.registry.has(taskId)) throw new Error("Select a registered task ID.");
  const snapshot = inventory(history.root, history.layout);
  const observations = scanObservations(history, snapshot.files);
  const engineFor = (subject: unknown) => {
    const matches = observations.provenance.get(digest(subject)) ?? [];
    if (matches.length !== 1) return null;
    const { subject: _subject, ...engine } = matches[0]!;
    return engine;
  };
  const lifecycle = history.source.lifecycle.get(taskId);
  const histories = readEvidenceHistories(join(history.root, history.paths.evidence), taskId, history.store);
  const evidence = [...histories.values()].flatMap(records => records.map(record => {
    const payload = record.payload;
    const contentDigest = digest(payload);
    return {
      lineageDigest: digest(record.lineageId), sequence: record.sequence, status: record.status, contentDigest,
      schemaId: payload.schemaId, schemaVersion: payload.schemaVersion, revision: commit(payload.revisionIdentity),
      role: payload.role ?? null, reviewerDigest: identityDigest(payload.reviewerId), outcome: payload.outcome ?? "MERGED",
      engine: engineFor(payload), authority: "RECORDED_EVIDENCE",
      merge: payload.schemaId === "ipt.merge-evidence" ? {
        pullRequestNumber: payload.pullRequestNumber, mergeCommitSha: commit(payload.mergeCommitSha),
        policyDecisionDigest: identityDigest(payload.policyDecisionReference),
      } : null,
    };
  }));
  const events = (lifecycle?.history ?? []).map((event, index) => ({
    ordinal: index + 1, eventDigest: digest(event.eventId), from: event.fromState ?? null, to: event.toState,
    occurredAt: event.occurredAt, revision: commit(event.revisionIdentity), actorDigest: identityDigest(event.actorId),
    runDigest: identityDigest(event.runId), references: (event.evidenceRef ?? "").split(",").flatMap(reference => {
      const match = /^(.*)@([1-9][0-9]*)$/.exec(reference);
      if (!match) return [];
      const sequence = Number(match[2]);
      const record = histories.get(match[1]!)?.find(candidate => candidate.sequence === sequence);
      return [{ lineageDigest: digest(match[1]), sequence, resolves: record?.payload.revisionIdentity === event.revisionIdentity &&
        record?.payload.taskId === taskId }];
    }), authority: "RECORDED_TRANSITION",
  }));
  const integrity = await checkRecoveryState(history.root, { registry: history.registry, paths: history.paths, source: history.source });
  if (inventory(history.root, history.layout).snapshotSha256 !== snapshot.snapshotSha256) throw new Error("Runtime changed during inspection.");
  return { version: 1, taskId, projectIdentity: history.config?.projectIdentity ?? null, configDigest: history.config?.configDigest ?? null,
    checkoutRevision: history.revision, state: lifecycle?.currentState ?? "PLANNED", events, evidence,
    providerAttempts: observations.attempts.filter(attempt => attempt.taskId === taskId)
      .map(({ view, subject }) => ({ ...view, engine: engineFor(subject) })),
    runs: observations.runs.filter(run => run.taskId === taskId),
    findings: integrity.findings.filter(finding => finding.taskId === taskId).map(finding => finding.code),
  };
}

/** Read-only decision aid. A compatible report never authorizes a writer or rebinds a run. */
export async function checkProjectUpgrade(request: UpgradeCheckRequest) {
  const findings = new Set<string>();
  const target = historyCompatibility.readerPackages.find(version => version === request.targetPackageVersion) ?? null;
  if (target === null) findings.add("UNSUPPORTED_READER");
  if (request.quiescence?.localWritersDrained !== true) findings.add("LOCAL_WRITERS_UNCONFIRMED");
  if (request.quiescence?.externalSessionsDrained !== true) findings.add("EXTERNAL_SESSIONS_UNCONFIRMED");
  let snapshotSha256: string | null = null;
  let configDigest: string | null = null;
  let bindingSha256: string | null = null;
  let checkoutRevision: string | null = null;
  let projectIdentity: string | null = null;
  let fileCount = 0;
  try {
    const history = await openHistory(request);
    configDigest = history.config?.configDigest ?? null;
    projectIdentity = history.config?.projectIdentity ?? null;
    bindingSha256 = history.bindingSha256;
    checkoutRevision = history.revision;
    const snapshot = inventory(history.root, history.layout);
    const observations = scanObservations(history, snapshot.files);
    for (const code of observations.findings) findings.add(code);
    for (const id of history.registry.keys()) {
      const record = history.source.lifecycle.get(id);
      if (record === null) continue;
      if (!settled.has(record.currentState)) findings.add("UNSETTLED_LIFECYCLE");
      if (id === "CANARY-001" && record.currentState !== "DONE") findings.add("RETIRED_CANARY_REQUIRES_QUARANTINE");
      if (target === priorPackage && new Set(record.history.map(event => event.eventId)).size !== record.history.length) {
        findings.add("PRIOR_READER_REJECTS_LEGACY_COLLISION");
      }
    }
    const check = await checkRecoveryState(history.root, { registry: history.registry, paths: history.paths, source: history.source });
    for (const finding of check.findings) findings.add(finding.code);
    if (history.config === null) readLocalLifecycleStates(history.root, history.registry);
    const second = inventory(history.root, history.layout);
    if (snapshot.snapshotSha256 !== second.snapshotSha256 ||
      projectGit(history.root, ["rev-parse", "--verify", "HEAD"]).trim() !== history.revision) findings.add("SNAPSHOT_CHANGED");
    snapshotSha256 = second.snapshotSha256;
    fileCount = second.files.length;
  } catch {
    findings.add("HISTORY_UNREADABLE_OR_UNSUPPORTED");
  }
  if (request.expectedSnapshotSha256 !== undefined && request.expectedSnapshotSha256 !== snapshotSha256) findings.add("BACKUP_HASH_MISMATCH");
  if (request.expectedProjectIdentity !== undefined && request.expectedProjectIdentity !== projectIdentity) findings.add("PROJECT_IDENTITY_MISMATCH");
  if (request.expectedConfigDigest !== undefined && request.expectedConfigDigest !== configDigest) findings.add("CONFIG_DIGEST_MISMATCH");
  if (request.expectedBindingSha256 !== undefined && request.expectedBindingSha256 !== bindingSha256) findings.add("STORAGE_BINDING_CHANGED");
  return { version: 1, compatible: findings.size === 0, inspectedWith: readPackageIdentity().version, target,
    checkoutRevision, projectIdentity, configDigest, bindingSha256, snapshotSha256, fileCount,
    findings: [...findings].sort(), authority: observedOnly,
    recovery: findings.size === 0 ? "Verify the protected backup and keep writers drained through the documented same-checkout handoff."
      : "Keep the original bytes and engine pin. Resolve the reported conditions or retain the store read-only.",
  };
}

export { verifyHistoryBackup } from "./snapshot.js";
