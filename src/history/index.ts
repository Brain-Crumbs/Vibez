import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { FileEvidenceStore, EVIDENCE_STORE_SUPPORTED_SCHEMAS } from "../evidence-store/index.js";
import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { parseOrchestrationRunJournal } from "../orchestration-engine/index.js";
import { readPackageJson } from "../project-assets/index.js";
import { readPackageIdentity } from "../project-assets/identity.js";
import { digest, projectGit, resolveProjectConfig, writablePaths, type ProjectLocation } from "../project-config/index.js";
import { inspectEvidenceReferences } from "../recovery-tools/evidence-integrity.js";
import { checkRecoveryState } from "../recovery-tools/index.js";
import { createLocalStatusDependencies, readLocalLifecycleStates } from "../status-reporting/index.js";
import { parseStoredAssignment, readEvidenceHistories } from "../status-reporting/local-source.js";
import { loadTaskRegistry } from "../task-registry/index.js";
import { localHistoryIdentity } from "./native-writer.js";
import { evidenceReceiptIdentity, hashText, identityDigest, isSha, object, parseProvenance } from "./provenance.js";
import { validate as validateDriverRecord } from "../workflow-driver/io.js";
import { inventory, optionalStat, type HistoryFile } from "./snapshot.js";
import {
  assertImportedHistory, assertNativeRelocationFiles, assertNoNativeRelocation, assertRelocationBinding,
  assertRelocationCheckout, confirmNativeRelocationPublication, nativeRelocationRepository, openNativeRelocation,
  publishNativeRelocation,
  readRelocationManifest, verifyRelocationInventory, relocationReader,
  type NativeHistoryRelocationManifest, type NativeHistoryRelocationRecord,
} from "./relocation.js";

const priorPackage = "0.1.0-mig005.1";
const previousPackage = "0.1.0-mig007.0";
const driverReaderPackages = ["0.1.0-mig006.0", "0.1.0-rc.1", "0.1.0-rc.2", relocationReader];
const taskPattern = /^[A-Z]+-[0-9]{3,}$/;
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const settled = new Set(["PLANNED", "READY", "DONE"]);
const legacyLayout = { state: ".agent/state", driver: ".agent/driver" };
const observedOnly = "OBSERVATION_ONLY";

export const historyCompatibility = Object.freeze({
  version: 1,
  apiVersion: "1.0.0",
  cliEnvelopeVersion: "1.0.0",
  readerPackages: Object.freeze([priorPackage, previousPackage, ...driverReaderPackages]),
  evidenceVersions: EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  lifecycleVersions: Object.freeze(["1.0.0", "1.1.0"]),
  assignmentVersions: Object.freeze(["1.0.0", "1.1.0"]),
  authoredRecordVersions: Object.freeze({ task: "1.0.0", requirement: "1.0.0", moduleContractSchema: "1.1.0" }),
  projectConfigVersion: "1.0.0",
  orchestrationJournalVersion: 1,
  manualExchangeVersion: "1.0.0",
  recoveryAuditVersion: "1.0.0",
  provenanceReceiptVersion: 1,
});

export interface HistoryLocation {
  readonly repositoryRoot: string;
  readonly config?: Omit<ProjectLocation, "projectRoot">;
  /** Additional project-relative exchange directories used by the legacy manual CLI. */
  readonly legacyExchangePaths?: readonly string[];
}

export interface UpgradeCheckRequest extends HistoryLocation {
  readonly targetPackageVersion: string;
  readonly expectedSnapshotSha256?: string;
  readonly expectedConfigDigest?: string;
  readonly expectedProjectIdentity?: string;
  readonly expectedBindingSha256?: string | null;
  readonly expectedTaskBindingsSha256?: string;
  /** Trusted host/operator confirmation. File observations cannot attest process liveness. */
  readonly quiescence?: { readonly localWritersDrained: true; readonly externalSessionsDrained: true };
}

function commit(value: unknown) {
  return typeof value === "string" && commitPattern.test(value) ? value : null;
}

async function openHistory(location: HistoryLocation, proposed?: NativeHistoryRelocationRecord) {
  const root = realpathSync(location.repositoryRoot);
  if (projectGit(root, ["rev-parse", "--show-prefix"]).trim() !== "") throw new Error("Select the original checkout root.");
  const revision = projectGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const config = location.config === undefined ? null : resolveProjectConfig({ ...location.config, projectRoot: root });
  const gitDir = config?.gitCommonDir ?? join(root, ".git");
  const markerPath = join(gitDir, "vibez-project.json");
  if (optionalStat(gitDir)?.isDirectory() !== true || optionalStat(gitDir)?.isSymbolicLink()) throw new Error("Select a dedicated original Git checkout.");
  const marker = optionalStat(markerPath);
  if (marker !== null && (marker.isSymbolicLink() || !marker.isFile() || marker.nlink !== 1)) throw new Error("Unsafe project binding.");
  const bindingText = marker === null ? null : readFileSync(markerPath, "utf8");
  const binding: unknown = bindingText === null ? null : JSON.parse(bindingText);
  if (bindingText !== null) {
    if (config === null || !object(binding) || Object.keys(binding).length !== 3 ||
      binding.worktreeIdentity !== config.worktreeIdentity || !isSha(binding.executionBinding) ||
      digest(binding.writablePaths) !== digest(writablePaths.map(name => process.platform === "win32"
        ? config.paths[name].toLowerCase() : config.paths[name]))) throw new Error("Runtime belongs to another project, worktree or layout.");
  }
  const exchanges = location.legacyExchangePaths ?? [];
  if (config !== null && exchanges.length !== 0) throw new Error("Configured projects already select their exchange root.");
  const exchangeRoots = [legacyLayout.state, ...exchanges];
  if (exchangeRoots.some((left, i) => exchangeRoots.some((right, j) => i !== j &&
    (left.toLowerCase() === right.toLowerCase() || left.toLowerCase().startsWith(right.toLowerCase() + "/"))))) {
    throw new Error("Legacy exchange paths overlap.");
  }
  const layout: Readonly<Record<string, string>> = config === null
    ? { ...legacyLayout, ...Object.fromEntries([...exchanges].sort().map((path, index) => [`exchange-${index}`, path])) }
    : Object.fromEntries(writablePaths.map(name => [name, config.document.paths[name]]));
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
  const bindingSha256 = bindingText === null ? null : hashText(bindingText);
  const taskMarkerNames = new Set([...registry.keys()].map(id => `vibez-task-${digest(id)}.json`));
  const readTaskBindings = () => digest(readdirSync(gitDir).filter(name => name.startsWith("vibez-task-")).sort().map(name => {
    const path = join(gitDir, name);
    const info = optionalStat(path);
    if (!taskMarkerNames.has(name) || info?.isFile() !== true || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("Unknown or unsafe task binding.");
    }
    const value = readFileSync(path, "utf8");
    if (!isSha(value)) throw new Error("Invalid task binding digest.");
    return [name, value];
  }));
  const taskBindingsSha256 = readTaskBindings();
  const projectIdentity = config?.projectIdentity ?? localHistoryIdentity(root);
  const installedRelocation = openNativeRelocation(root, projectIdentity);
  const relocation = proposed ?? installedRelocation?.record;
  if (relocation !== undefined && (config !== null || exchanges.length !== 0 || bindingText !== null ||
      taskBindingsSha256 !== digest([]) || (proposed !== undefined && installedRelocation !== null))) {
    throw new Error("Native relocation requires the original unconfigured runtime layout.");
  }
  if (proposed !== undefined) assertRelocationBinding(root, projectIdentity, proposed);
  function assertCurrent() {
    config?.assertCurrent(revision);
    if (installedRelocation !== null) installedRelocation.assertCurrent();
    else assertNoNativeRelocation(root);
    const info = optionalStat(markerPath);
    if ((info === null) !== (bindingSha256 === null) || (info !== null &&
      (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || hashText(readFileSync(markerPath, "utf8")) !== bindingSha256)) ||
      readTaskBindings() !== taskBindingsSha256 || projectGit(root, ["rev-parse", "--verify", "HEAD"]).trim() !== revision) {
      throw new Error("Snapshot bindings changed during inspection.");
    }
  }
  const recoveryOptions = {
    registry, paths, source,
    // History needs only validated identities and requiredness. It must be
    // able to inspect an archived project without its validator executables.
    ...(config === null ? {} : {
      declaredValidators: config.document.validators.map(({ id, required }) => ({ validatorId: id, required })),
    }),
  };
  return { root, config, projectIdentity, revision, relocation,
    registry, paths, source, layout, store, recoveryOptions, bindingSha256, taskBindingsSha256, assertCurrent };
}

type History = Awaited<ReturnType<typeof openHistory>>;

function historyText(history: History, file: HistoryFile): string {
  const base = history.layout[file.area];
  if (base === undefined) throw new Error("Unknown history area.");
  const value = readFileSync(join(history.root, base, file.name), "utf8");
  if (hashText(value) !== file.sha256) throw new Error("Record changed while inspected.");
  return value;
}

function assertCompletedNativeHistory(history: History, files: readonly HistoryFile[]) {
  assertNativeRelocationFiles(files);
  const completed = new Set<string>();
  for (const file of files.filter(file => file.name.startsWith("lifecycle/"))) {
    const id = /^lifecycle\/([A-Z]+-[0-9]{3,})\.lifecycle\.json$/.exec(file.name)?.[1];
    if (id === undefined || !history.registry.has(id) || history.source.lifecycle.get(id)?.currentState !== "DONE") {
      throw new Error("Native relocation requires completed lifecycle records.");
    }
    completed.add(id);
  }
  for (const file of files) {
    let task: unknown;
    if (file.name.startsWith("assignments/.history/")) {
      task = /^assignments\/\.history\/([A-Z]+-[0-9]{3,})(?:-|\.)/.exec(file.name)?.[1];
    } else if (file.name.startsWith("evidence/")) {
      const evidence: unknown = JSON.parse(historyText(history, file));
      task = object(evidence) && object(evidence.payload) ? evidence.payload.taskId : null;
    } else if (file.name.startsWith("recovery/") && file.name.endsWith(".intent.json")) {
      const intent: unknown = JSON.parse(historyText(history, file));
      task = object(intent) && object(intent.request) ? intent.request.taskId : null;
    } else {
      continue;
    }
    if (typeof task !== "string" || !completed.has(task)) {
      throw new Error("Native relocation refuses records without a completed task.");
    }
  }
}

function scanObservations(history: History, files: readonly HistoryFile[]) {
  const findings = new Set<string>();
  const provenance = new Map<string, ReturnType<typeof parseProvenance>[]>();
  const relocation = history.relocation;
  const imported = relocation === undefined ? undefined : assertImportedHistory(relocation, files);
  const runs: { taskId: string | null; ownerDigest: string | null; runDigest: string | null;
    keyDigest: string | null; attempts: Record<string, number>; pendingStage: string | null; authority: string }[] = [];
  const agentResults: { taskId: string; subject: unknown; view: Record<string, unknown> }[] = [];
  const exchange = new Map<string, { packets: Set<string>; results: Set<string> }>();
  for (const file of files) {
    const text = () => historyText(history, file);
    const legacyDefaultExchange = history.config === null && file.area === "state" && file.name.startsWith("manual-exchange/");
    const exchangePath = legacyDefaultExchange ? `${legacyLayout.state}/manual-exchange`
      : /^exchange(?:-[0-9]+)?$/.test(file.area) ? history.layout[file.area] : undefined;
    if ((["state", "operations"].includes(file.area) || exchangePath !== undefined) &&
      (/(?:^|\/)\.claims\//.test(file.name) || /(?:\.lock(?:\.json)?|\.mutex|\.tmp)$/.test(file.name))) {
      findings.add("WRITER_OR_UNRECONCILED_LOCK");
    }
    const stateFamily = history.config === null
      ? /^(?:assignments|audit-provenance|evidence|lifecycle|orchestration|recovery)\//
      : /^(?:assignments|lifecycle|recovery)\//;
    if (file.area === "state" && !legacyDefaultExchange && !stateFamily.test(file.name)) findings.add("UNSUPPORTED_STATE_RECORD");
    if (file.area === "state" && file.name.startsWith("assignments/.history/")) {
      const archive = file.name.slice("assignments/.history/".length);
      const taskId = /^([A-Z]+-[0-9]{3,})(?:-|\.)/.exec(archive)?.[1];
      if (taskId === undefined || !history.registry.has(taskId)) throw new Error("Unknown assignment archive.");
      if (archive === `${taskId}.audit.jsonl`) {
        for (const line of text().split("\n").filter(Boolean)) {
          const entry: unknown = JSON.parse(line);
          if (!object(entry) || !["ACQUIRED", "REACQUIRED", "RELEASED", "RECOVERED_STALE"].includes(String(entry.action)) ||
            !["occurredAt", "actorId", "runId", "reason"].every(key => typeof entry[key] === "string") ||
            Object.keys(entry).some(key => !["action", "occurredAt", "actorId", "runId", "reason", "priorLockId", "resultingLockId"].includes(key))) {
            throw new Error("Unsupported assignment audit entry.");
          }
        }
      } else {
        const entry: unknown = JSON.parse(text());
        if (object(entry) && !("schemaId" in entry) && "expectedStaleLockId" in entry) {
          const keys = ["taskId", "expectedStaleLockId", "recoveryActorId", "recoveryRunId", "recoveryReason",
            "replacementLockId", "replacementOwnerId", "replacementRunId", "claimedAt"];
          if (!/-recovery-claim-[^/]+-\d+\.json$/.test(archive) || entry.taskId !== taskId ||
            Object.keys(entry).length !== keys.length || !keys.every(key => typeof entry[key] === "string" && entry[key] !== "")) throw new Error("Unsupported assignment claim archive.");
        } else {
          if (!/-(?:released|stale)-[^/]+-\d+\.json$/.test(archive)) throw new Error("Unknown assignment archive format.");
          parseStoredAssignment(entry, taskId, "assignment archive");
        }
      }
    }
    const driverPath = file.area === "driver" ? file.name :
      file.area === "operations" && file.name.startsWith("driver/") ? file.name.slice("driver/".length) : null;
    if (driverPath !== null) {
      if (driverPath === "profile.json") validateDriverRecord(history.root, "driver-profile", JSON.parse(text()));
      else if (/^sessions\/[a-f0-9-]{36}\.json$/.test(driverPath)) {
        const session: unknown = JSON.parse(text());
        validateDriverRecord(history.root, "driver-session", session);
        if (!object(session) || !["DONE", "STOPPED"].includes(String(session.status))) findings.add("UNSETTLED_DRIVER_SESSION");
      } else if (/^(?:writer|writer-recovery)\.lock$/.test(driverPath)) findings.add("ACTIVE_DRIVER_WRITER");
      else if (!/^(?:accepted|archive|inbox|outbound|exchange|intakes|merge-intents|observations|repair-attempts|reports|selections|staged|writer-recovery)\//.test(driverPath)) {
        findings.add("UNSUPPORTED_OPERATION_RECORD");
      }
    }
    if (file.area === "operations" && !/^(?:audit-provenance|orchestration|retry-grants|driver)\//.test(file.name)) {
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
    if ((file.area === "operations" || file.area === "state") && file.name.startsWith("audit-provenance/") && !file.name.endsWith(".tmp")) {
      const receipt = parseProvenance(text(), file.name.slice("audit-provenance/".length));
      const projectIdentity = relocation !== undefined && imported?.has(file.name) && file.area === "state"
        ? relocation.source.projectIdentity : history.projectIdentity;
      if (receipt.projectIdentity !== projectIdentity) throw new Error("Foreign provenance receipt.");
      const existing = provenance.get(receipt.subject) ?? [];
      existing.push(receipt);
      provenance.set(receipt.subject, existing);
    }
    if (exchangePath !== undefined && !file.name.endsWith(".tmp")) {
      const name = legacyDefaultExchange ? file.name.slice("manual-exchange/".length) : file.name;
      const match = /^([a-f0-9]{64})\.(packet|result)\.json$/.exec(name);
      if (match === null) throw new Error("Unsupported exchange record.");
      const group = exchange.get(exchangePath) ?? { packets: new Set<string>(), results: new Set<string>() };
      (match[2] === "packet" ? group.packets : group.results).add(match[1]!);
      exchange.set(exchangePath, group);
    }
  }
  const attempts = [];
  for (const [path, { packets, results }] of exchange) {
    const provider = new FileManualAgentProvider(join(history.root, path), {
      deferDirectory: true, ...(history.config === null ? {} : { configuredHost: true }),
    });
    if ([...results].some(id => !packets.has(id))) throw new Error("Manual result has no original packet.");
    for (const id of packets) {
      const { packet, result } = provider.readExchange(id);
      if (result === null) findings.add("UNSETTLED_EXTERNAL_PACKET");
      const { taskId, role, runId, actorId, revisionIdentity } = packet;
      attempts.push({ taskId, subject: { taskId, role, runId, actorId, revisionIdentity },
        view: { packetId: id, role, revision: commit(revisionIdentity),
          actorDigest: identityDigest(actorId), runDigest: identityDigest(runId), providerDigest: identityDigest(packet.providerId),
          state: result?.status ?? "PENDING", authority: observedOnly } });
    }
  }
  const recorded = new Map<string, string>();
  const mismatched = new Set<string>();
  if ([...provenance.values()].some(receipts => receipts.some(receipt => receipt.recordSha256 !== null))) {
    for (const id of history.registry.keys()) {
      for (const records of readEvidenceHistories(join(history.root, history.paths.evidence), id, history.store).values()) {
        for (const record of records) {
          const identity = evidenceReceiptIdentity(record);
          recorded.set(identity.subject, identity.recordSha256);
        }
      }
    }
  }
  for (const receipts of provenance.values()) {
    for (const receipt of receipts) {
      if (receipt.recordSha256 !== null && recorded.get(receipt.subject) !== receipt.recordSha256) {
        findings.add("EVIDENCE_RECEIPT_MISMATCH");
        mismatched.add(receipt.subject);
      }
    }
  }
  return { findings, provenance, mismatched, runs, attempts: [...attempts, ...agentResults] };
}

/** Inspect validated evidence and original lifecycle history without returning arbitrary stored text. */
async function inspectProjectAudit(location: HistoryLocation, taskId: string) {
  if (!taskPattern.test(taskId)) throw new Error("Select a registered task ID.");
  const history = await openHistory(location);
  if (!history.registry.has(taskId)) throw new Error("Select a registered task ID.");
  const snapshot = inventory(history.root, history.layout);
  const observations = scanObservations(history, snapshot.files);
  const engineFor = (subject: string, recordSha256: string | null) => {
    const matches = observations.provenance.get(subject)?.filter(receipt => receipt.recordSha256 === recordSha256) ?? [];
    if (matches.length !== 1) return null;
    const { subject: _subject, recordSha256: _hash, ...engine } = matches[0]!;
    return engine;
  };
  const lifecycle = history.source.lifecycle.get(taskId);
  const histories = readEvidenceHistories(join(history.root, history.paths.evidence), taskId, history.store);
  const evidence = [...histories.values()].flatMap(records => records.map(record => {
    const payload = record.payload;
    const contentDigest = digest(payload);
    const identity = evidenceReceiptIdentity(record);
    return {
      lineageDigest: digest(record.lineageId), sequence: record.sequence, status: record.status, contentDigest,
      schemaId: payload.schemaId, schemaVersion: payload.schemaVersion, revision: commit(payload.revisionIdentity),
      role: payload.role ?? null, reviewerDigest: identityDigest(payload.reviewerId), outcome: payload.outcome ?? "MERGED",
      engine: engineFor(identity.subject, identity.recordSha256), authority: "RECORDED_EVIDENCE",
      merge: payload.schemaId === "ipt.merge-evidence" ? {
        pullRequestNumber: payload.pullRequestNumber, mergeCommitSha: commit(payload.mergeCommitSha),
        policyDecisionDigest: identityDigest(payload.policyDecisionReference),
      } : null,
    };
  }));
  const events = (lifecycle?.history ?? []).map((event, index) => ({
    ordinal: index + 1, eventDigest: digest(event.eventId), from: event.fromState ?? null, to: event.toState,
    occurredAt: event.occurredAt, revision: commit(event.revisionIdentity), actorDigest: identityDigest(event.actorId),
    runDigest: identityDigest(event.runId), references: inspectEvidenceReferences(taskId, event, histories, lifecycle?.history[index - 1]).map(reference => {
      const mismatched = reference.lineage !== null && observations.mismatched.has(digest([reference.lineage, reference.sequence]));
      const finding = reference.code ?? (mismatched ? "EVIDENCE_RECEIPT_MISMATCH" : null);
      return { lineageDigest: digest(reference.lineage ?? reference.reference),
        sequence: reference.sequence, resolves: finding === null, finding };
    }), authority: "RECORDED_TRANSITION",
  }));
  const integrity = await checkRecoveryState(history.root, history.recoveryOptions);
  if (inventory(history.root, history.layout).snapshotSha256 !== snapshot.snapshotSha256) throw new Error("Runtime changed during inspection.");
  history.assertCurrent();
  return { version: 1, taskId, projectIdentity: history.projectIdentity, configDigest: history.config?.configDigest ?? null,
    checkoutRevision: history.revision, state: lifecycle?.currentState ?? "PLANNED", events, evidence,
    providerAttempts: observations.attempts.filter(attempt => attempt.taskId === taskId)
      .map(({ view, subject }) => ({ ...view, engine: engineFor(digest(subject), null) })),
    runs: observations.runs.filter(run => run.taskId === taskId),
    findings: [...new Set([...observations.findings,
      ...integrity.findings.filter(finding => finding.taskId === taskId).map(finding => finding.code)])].sort(),
  };
}

/** Read-only task audit with safe failures for application and CLI consumers. */
export async function readProjectAudit(location: HistoryLocation, taskId: string) {
  try {
    return await inspectProjectAudit(location, taskId);
  } catch {
    throw new Error("History unavailable. Inspect the original checkout, registered task and runtime records.");
  }
}

/** Read-only decision aid. A compatible report never authorizes a writer or rebinds a run. */
export function checkProjectUpgrade(request: UpgradeCheckRequest) {
  return inspectUpgrade(request);
}

async function inspectUpgrade(request: UpgradeCheckRequest, proposed?: NativeHistoryRelocationRecord) {
  const findings = new Set<string>();
  const target = historyCompatibility.readerPackages.find(version => version === request.targetPackageVersion) ?? null;
  if (target === null) findings.add("UNSUPPORTED_READER");
  if (request.quiescence?.localWritersDrained !== true) findings.add("LOCAL_WRITERS_UNCONFIRMED");
  if (request.quiescence?.externalSessionsDrained !== true) findings.add("EXTERNAL_SESSIONS_UNCONFIRMED");
  let snapshotSha256: string | null = null;
  let configDigest: string | null = null;
  let bindingSha256: string | null = null;
  let taskBindingsSha256: string | null = null;
  let checkoutRevision: string | null = null;
  let projectIdentity: string | null = null;
  let fileCount = 0;
  try {
    const history = await openHistory(request, proposed);
    configDigest = history.config?.configDigest ?? null;
    projectIdentity = history.projectIdentity;
    bindingSha256 = history.bindingSha256;
    taskBindingsSha256 = history.taskBindingsSha256;
    checkoutRevision = history.revision;
    const snapshot = inventory(history.root, history.layout);
    if (proposed !== undefined) assertCompletedNativeHistory(history, snapshot.files);
    const observations = scanObservations(history, snapshot.files);
    if (history.relocation !== undefined && target !== relocationReader) findings.add("PRIOR_READER_REJECTS_RELOCATED_HISTORY");
    for (const code of observations.findings) findings.add(code);
    if ((target === null || !driverReaderPackages.includes(target)) && snapshot.files.some(file => file.area === "driver" || file.area === "operations" && file.name.startsWith("driver/"))) {
      findings.add("PRIOR_READER_DOES_NOT_SUPPORT_DRIVER_HISTORY");
    }
    for (const id of history.registry.keys()) {
      const record = history.source.lifecycle.get(id);
      if (record === null) continue;
      if (!settled.has(record.currentState)) findings.add("UNSETTLED_LIFECYCLE");
      if (id === "CANARY-001" && record.currentState !== "DONE") findings.add("RETIRED_CANARY_REQUIRES_QUARANTINE");
      if (target === priorPackage && new Set(record.history.map(event => event.eventId)).size !== record.history.length) {
        findings.add("PRIOR_READER_REJECTS_LEGACY_COLLISION");
      }
    }
    const check = await checkRecoveryState(history.root, history.recoveryOptions);
    for (const finding of check.findings) findings.add(finding.code);
    if (history.config === null) readLocalLifecycleStates(history.root, history.registry);
    const second = inventory(history.root, history.layout);
    if (snapshot.snapshotSha256 !== second.snapshotSha256) findings.add("SNAPSHOT_CHANGED");
    history.assertCurrent();
    snapshotSha256 = second.snapshotSha256;
    fileCount = second.files.length;
  } catch {
    findings.add("HISTORY_UNREADABLE_OR_UNSUPPORTED");
  }
  if (request.expectedSnapshotSha256 !== undefined && request.expectedSnapshotSha256 !== snapshotSha256) findings.add("BACKUP_HASH_MISMATCH");
  if (request.expectedProjectIdentity !== undefined && request.expectedProjectIdentity !== projectIdentity) findings.add("PROJECT_IDENTITY_MISMATCH");
  if (request.expectedConfigDigest !== undefined && request.expectedConfigDigest !== configDigest) findings.add("CONFIG_DIGEST_MISMATCH");
  if (request.expectedBindingSha256 !== undefined && request.expectedBindingSha256 !== bindingSha256) findings.add("STORAGE_BINDING_CHANGED");
  if (request.expectedTaskBindingsSha256 !== undefined && request.expectedTaskBindingsSha256 !== taskBindingsSha256) findings.add("TASK_BINDINGS_CHANGED");
  return { version: 1, compatible: findings.size === 0, inspectedWith: readPackageIdentity().version, target,
    checkoutRevision, projectIdentity, configDigest, bindingSha256, taskBindingsSha256, snapshotSha256, fileCount,
    findings: [...findings].sort(), authority: observedOnly,
    recovery: findings.size === 0 ? "Verify the protected backup and keep writers drained through the documented same-checkout handoff."
      : "Keep the original bytes and engine pin. Resolve the reported conditions or retain the store read-only.",
  };
}

export { verifyHistoryBackup } from "./snapshot.js";

export type { NativeHistoryRelocationManifest, NativeHistoryRelocationRecord } from "./relocation.js";

type RelocationQuiescence = NonNullable<UpgradeCheckRequest["quiescence"]>;

export interface NativeHistoryExportRequest {
  readonly repositoryRoot: string;
  readonly expectedSnapshotSha256: string;
  readonly quiescence: RelocationQuiescence;
}

function assertRelocationQuiescence(quiescence: RelocationQuiescence) {
  if (quiescence?.localWritersDrained !== true || quiescence?.externalSessionsDrained !== true) {
    throw new Error("Confirm all original and destination writers and external sessions are drained.");
  }
}

/** Export a verified stopped native snapshot without writing or transferring any runtime file. */
export async function prepareNativeHistoryRelocation(request: NativeHistoryExportRequest) {
  assertRelocationQuiescence(request.quiescence);
  if (!isSha(request.expectedSnapshotSha256)) throw new Error("Pin the source snapshot SHA-256.");
  const { repositoryRoot, quiescence, expectedSnapshotSha256 } = request;
  const history = await openHistory({ repositoryRoot });
  assertRelocationCheckout(history.root);
  assertNoNativeRelocation(history.root);
  const repository = nativeRelocationRepository(history.root);
  const report = await inspectUpgrade({ repositoryRoot, quiescence, expectedSnapshotSha256,
    expectedProjectIdentity: history.projectIdentity, expectedBindingSha256: null,
    expectedTaskBindingsSha256: digest([]), targetPackageVersion: relocationReader });
  if (!report.compatible) throw new Error("Source history is not compatible: " + report.findings.join(", "));
  const snapshot = inventory(history.root, history.layout);
  assertCompletedNativeHistory(history, snapshot.files);
  if (snapshot.snapshotSha256 !== expectedSnapshotSha256 || nativeRelocationRepository(history.root) !== repository) {
    throw new Error("Only the pinned, completed native snapshot can be exported.");
  }
  history.assertCurrent();
  const manifest: NativeHistoryRelocationManifest = { version: 1, repository, revision: history.revision,
    projectIdentity: history.projectIdentity, ...snapshot };
  return { manifest, manifestSha256: digest(manifest) };
}

export interface NativeHistoryActivationRequest {
  readonly repositoryRoot: string;
  readonly sourceManifest: unknown;
  readonly expectedSourceManifestSha256: string;
  readonly destinationBaseline?: { readonly manifest: unknown; readonly expectedManifestSha256: string };
  readonly quiescence: RelocationQuiescence;
}

/** Accept an independently verified manifest over a stopped restore. Only a host-local Git marker is written. */
export async function activateNativeHistoryRelocation(request: NativeHistoryActivationRequest): Promise<NativeHistoryRelocationRecord> {
  assertRelocationQuiescence(request.quiescence);
  const source = readRelocationManifest(request.sourceManifest, request.expectedSourceManifestSha256);
  const { repositoryRoot, quiescence, destinationBaseline } = request;
  const baseline = destinationBaseline === undefined ? undefined :
    readRelocationManifest(destinationBaseline.manifest, destinationBaseline.expectedManifestSha256);
  const history = await openHistory({ repositoryRoot });
  const destinationBaselineSha256 = destinationBaseline?.expectedManifestSha256 ?? null;
  if (baseline !== undefined && (baseline.projectIdentity !== history.projectIdentity ||
      baseline.repository !== source.repository)) {
    throw new Error("The destination baseline belongs to a different checkout.");
  }
  if (baseline !== undefined) projectGit(history.root, ["merge-base", "--is-ancestor", baseline.revision, "HEAD"]);
  const record: NativeHistoryRelocationRecord = {
    version: 1, source, sourceManifestSha256: request.expectedSourceManifestSha256,
    destinationProjectIdentity: history.projectIdentity, destinationRevision: history.revision, destinationBaselineSha256,
  };
  if (history.relocation !== undefined) {
    if (history.relocation.sourceManifestSha256 !== record.sourceManifestSha256 ||
        history.relocation.destinationBaselineSha256 !== destinationBaselineSha256) throw new Error("Another relocation is already active.");
    assertImportedHistory(history.relocation, inventory(history.root, history.layout).files);
    history.assertCurrent();
    confirmNativeRelocationPublication(history.root);
    return history.relocation;
  }
  assertRelocationBinding(history.root, history.projectIdentity, record);
  const restored = inventory(history.root, history.layout);
  verifyRelocationInventory(source, baseline, restored.files);
  const expectedSnapshotSha256 = restored.snapshotSha256;
  const report = await inspectUpgrade({ repositoryRoot, quiescence, expectedSnapshotSha256,
    expectedProjectIdentity: history.projectIdentity, expectedBindingSha256: null,
    expectedTaskBindingsSha256: digest([]), targetPackageVersion: relocationReader }, record);
  if (!report.compatible) throw new Error("Restored history is not compatible: " + report.findings.join(", "));
  if (inventory(history.root, history.layout).snapshotSha256 !== expectedSnapshotSha256) {
    throw new Error("Restored history changed before activation.");
  }
  history.assertCurrent();
  assertRelocationBinding(history.root, history.projectIdentity, record);
  publishNativeRelocation(history.root, record);
  return record;
}
