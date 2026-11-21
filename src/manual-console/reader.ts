import { existsSync } from "node:fs";
import { FileDeveloperStartStateStore } from "../dev-start/index.js";
import { FileEvidenceStore } from "../evidence-store/index.js";
import { FileOrchestrationRunStore, type OrchestrationRunJournal, type OrchestrationStageRecord } from "../orchestration-engine/index.js";
import type { ResolvedProjectConfig } from "../project-config/index.js";
import { successorId } from "../workflow-driver/inbox.js";
import { bindProfile, loadProfile, loadSession, sessionPath } from "../workflow-driver/intake.js";
import { driverDirectory, files, git, hash, object, orchestrationDirectory, redact, safePath, stateDirectory } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { pendingPackets, readOriginal, revision } from "./artifacts.js";
import { ConsoleProblem } from "./problem.js";

const nativeId = /^[a-f0-9-]{36}$/;
const stages = {
  "developer-start": "assignment", "dev-validation": "developer-validation",
  "qa-review": "qa-review", "architecture-review": "architecture-review",
  "uat-review": "uat-review", "review-rework": "rework", "merge-readiness": "merge-readiness",
  "controlled-merge": "completion",
} as const;
const activeStages = {
  "developer-agent": "assignment", "qa-agent": "qa-review", "architecture-agent": "architecture-review", "uat-agent": "uat-review",
  ...stages,
} as const;
type Phase = "prepared" | "waiting" | "active" | "blocked" | "rework" | "completed";
const notFound = () => new ConsoleProblem(404, "not-found", "The requested resource is unavailable.");
const unavailable = () => new ConsoleProblem(503, "temporarily-unavailable", "Restore the original configured project and driver profile, then retry.", 1000);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unknown = { state: "unknown" } as const;

function utc(input: unknown) {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) return null;
  const value = new Date(input).toISOString();
  return /^\d{4}-/.test(value) ? value : null;
}
function stageFor(name: string | undefined) {
  return name && Object.hasOwn(stages, name) ? stages[name as keyof typeof stages] : undefined;
}
function completedObservation(journal: OrchestrationRunJournal | null, stages: readonly OrchestrationStageRecord[]) {
  const result = journal?.values["merge-readiness"];
  const observedAt = utc([...stages].reverse().find(stage => stage.stage === "merge-readiness")?.finishedAt);
  if (!object(result) || !observedAt || !revision(result.revision)) return null;
  return { result, observedAt, revision: result.revision as string };
}

export class ManualConsoleReader {
  readonly projectId: string;
  readonly checkoutLabel: string;
  readonly #profileHash: string;
  readonly #root: string;

  constructor(private readonly config: ResolvedProjectConfig) {
    this.#root = config.projectRoot;
    this.projectId = config.projectIdentity;
    this.checkoutLabel = config.document.worktree.id;
    this.#profileHash = hash(loadProfile(this.#root, config));
    this.checkScope();
  }

  checkScope(): DriverProfile {
    try {
      const profile = loadProfile(this.#root, this.config);
      bindProfile(profile, this.config);
      if (hash(profile) !== this.#profileHash || this.config.document.providers.execution !== "local-manual") throw unavailable();
      return profile;
    } catch { throw unavailable(); }
  }

  list() {
    const profile = this.checkScope();
    const root = this.#root;
    const observedAt = new Date().toISOString();
    const runs = [];
    for (const name of files(safePath(root, `${driverDirectory(profile)}/sessions`), ".json")) {
      try {
        const session = this.#session(profile, name.slice(0, -5));
        if (session.predecessor === null) runs.push(this.#view(profile, session, observedAt).detail.summary);
      } catch (error) {
        if (!(error instanceof ConsoleProblem && error.status === 404)) throw error;
      }
    }
    return runs.sort((a, b) => compare(a.taskId, b.taskId) || compare(a.sessionId, b.sessionId));
  }

  run(id: string) {
    const profile = this.checkScope();
    return this.#view(profile, this.#rootSession(profile, id), new Date().toISOString()).detail;
  }

  packet(sessionId: string, id: string) {
    const profile = this.checkScope();
    const root = this.#rootSession(profile, sessionId);
    const current = this.#view(profile, root, new Date().toISOString());
    const packet = [current.role, current.repair].find(record => record?.ref.packetId === id);
    if (!packet) throw notFound();
    const body = readOriginal(this.#root, packet);
    // A separate CLI process can import a result while we read the file.
    const rechecked = this.#view(this.checkScope(), this.#rootSession(profile, sessionId), new Date().toISOString());
    if (rechecked.detail.attempt.attemptId !== current.detail.attempt.attemptId ||
        ![rechecked.role, rechecked.repair].some(record => record?.ref.packetId === id)) throw notFound();
    return {
      target: { projectId: this.projectId, sessionId, attemptId: current.detail.attempt.attemptId },
      packet: packet.ref, body,
    };
  }

  #session(profile: DriverProfile, id: string): DriverSession {
    if (!nativeId.test(id)) throw notFound();
    try { return loadSession(this.#root, profile, id); } catch { throw notFound(); }
  }

  #rootSession(profile: DriverProfile, id: string): DriverSession {
    const session = this.#session(profile, id);
    if (session.predecessor !== null) throw notFound();
    return session;
  }

  #diagnostic(code: unknown, message: unknown) {
    const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "DRIVER_BLOCKED";
    const safeMessage = typeof message === "string" ?
      redact(message).split(this.#root).join("[checkout]").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]").trim().slice(0, 2048) : "";
    return { code: safeCode, message: safeMessage || "Inspect this run with the Vibez CLI." };
  }

  #view(profile: DriverProfile, first: DriverSession, observedAt: string) {
    const root = this.#root;
    let session = first;
    for (let count = 0; ; count++) {
      const nextId = successorId(session.sessionId);
      if (!existsSync(sessionPath(root, profile, nextId))) break;
      const next = this.#session(profile, nextId);
      if (count >= 10 || next.predecessor !== session.sessionId || next.taskId !== first.taskId ||
          next.definitionHash !== first.definitionHash || next.issueNumber !== first.issueNumber ||
          next.registrationRevision !== first.registrationRevision || next.request.ownerId !== first.request.ownerId ||
          next.request.assignmentKey !== first.request.idempotencyKey || next.request.assignmentRunId !== first.request.runId)
        throw unavailable();
      session = next;
    }

    let branch: string;
    let dependencies: string[];
    try {
      if (!revision(session.registrationRevision)) throw notFound();
      const definition = JSON.parse(git(root, "show", `${session.registrationRevision}:${session.definitionPath}`));
      if (hash(definition) !== session.definitionHash || definition.taskId !== session.taskId ||
          typeof definition.canonicalBranch !== "string" || definition.canonicalBranch.length > 256 || !Array.isArray(definition.dependencies)) throw notFound();
      branch = definition.canonicalBranch;
      dependencies = definition.dependencies;
    } catch { throw notFound(); }
    let sourceRevision: string | null = null;
    try { sourceRevision = revision(git(root, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`)); }
    catch { /* Prepared tasks can have no local topic branch. */ }

    const lifecycleRoot = `${stateDirectory(profile)}/lifecycle`;
    const lifecycleStore = new FileDeveloperStartStateStore(safePath(root, lifecycleRoot), true);
    const lifecycle = (taskId: string) => {
      safePath(root, `${lifecycleRoot}/${taskId}.lifecycle.json`);
      return lifecycleStore.get(taskId);
    };
    const state = lifecycle(session.taskId);
    const journal = new FileOrchestrationRunStore(safePath(root, orchestrationDirectory(profile)), true)
      .get(session.request.idempotencyKey ?? session.request.runId);
    if (journal && (journal.runId !== session.request.runId || journal.ownerId !== session.request.ownerId)) throw unavailable();
    const result = session.result?.runId === session.request.runId && session.result.taskId === session.taskId ? session.result : null;
    const stageRecords = ((journal?.values.stages as OrchestrationStageRecord[] | undefined) ?? result?.stages) ?? [];
    const { role, repair, replyToPacketId, diagnostic } = pendingPackets(root, profile, session);
    const writer = ["writer.lock", "writer-recovery.lock"].some(name => existsSync(safePath(root, `${driverDirectory(profile)}/${name}`)));

    const done = state?.currentState === "DONE" && state.history.at(-1);
    const doneForRun = done && done.runId === `${session.request.runId}::controlled-merge`;
    const evidence = doneForRun && new FileEvidenceStore(safePath(root, profile.storage!.evidence), { readOnly: true })
      .getCurrent(`${session.taskId}::merge`);
    const merged = evidence && evidence.payload.schemaId === "ipt.merge-evidence" && evidence.payload.taskId === session.taskId &&
      evidence.payload.revisionIdentity === done.revisionIdentity && `${evidence.lineageId}@${evidence.sequence}` === done.evidenceRef ?
      evidence.payload : null;
    const rework = state?.currentState === "REWORK_REQUIRED" ||
      (session.predecessor !== null && session.status === "PREPARED" && !journal);
    const blockedDependency = session.status === "PREPARED" && dependencies.find(id => lifecycle(id)?.currentState !== "DONE");
    const stage = journal?.pendingStage && activeStages[journal.pendingStage];
    const active = writer && stage && !journal?.lastFailure && !diagnostic;
    const phase: Phase = merged ? "completed" : rework ? "rework" : role ? "waiting" :
      diagnostic || blockedDependency || result?.stopped || journal?.lastFailure ? "blocked" :
      active ? "active" : session.status === "PREPARED" && !journal ? "prepared" : "blocked";

    const stopped = result?.stopped;
    const reason = diagnostic ? this.#diagnostic(diagnostic.code, diagnostic.message) :
      stopped ? this.#diagnostic("WORKFLOW_STOPPED", stopped.reason) :
      journal?.lastFailure ? this.#diagnostic(journal.lastFailure.code, journal.lastFailure.message) :
      blockedDependency ? this.#diagnostic("DEPENDENCY_NOT_DONE", `Wait for ${blockedDependency} to complete in Vibez.`) :
      writer && !active ? this.#diagnostic("WRITER_BUSY", "A Vibez writer holds the checkout. Inspect or resume it from the CLI.") :
      phase === "blocked" ? this.#diagnostic("STATE_UNCERTAIN", "Inspect this attempt with the Vibez CLI before retrying.") : null;
    const observedStage = [...stageRecords].reverse().find(item => item.stage === stopped?.stage && stageFor(item.stage)) ??
      [...stageRecords].reverse().find(item => stageFor(item.stage));
    const stageName = stageFor(observedStage?.stage);
    const gateEvent = observedStage && state?.history.slice().reverse().find(event => event.runId === observedStage.runId);
    const gate = phase === "waiting" && role?.ref.role ? { state: "awaiting-role", role: role.ref.role } :
      phase === "active" && stage ? { state: "running", stage } :
      stageName && observedStage ? { state: "observed", stage: stageName, outcome: observedStage.outcome.toLowerCase(),
        revision: revision(gateEvent?.revisionIdentity), diagnostic: observedStage.outcome === "PASS" ? null : reason } :
      { state: "idle" };

    const completedAt = utc(merged?.recordedAt);
    const pullRequest = merged && completedAt ? { state: "observed", status: "merged", observedAt: completedAt,
      revision: merged.revisionIdentity, url: `https://github.com/${profile.repository}/pull/${merged.pullRequestNumber}` } : unknown;
    const readiness = completedObservation(journal, stageRecords);
    // A native successful readiness check had exact-head CI. A failed aggregate
    // readiness check can include unrelated blockers, so report only explicit CI outcomes.
    const reasons = Array.isArray(readiness?.result.reasons) ? readiness.result.reasons.filter(object) : [];
    const failedChecks = reasons.filter(item => item.code === "CI_CHECK_NOT_SUCCESSFUL");
    const ciStatus = readiness?.result.ready === true ? "pass" : failedChecks.some(item => item.condition === "failed") ? "fail" :
      failedChecks.some(item => item.observedStatus === "in_progress" || item.observedStatus === "queued") ? "pending" :
      failedChecks.length ? "blocked" : null;
    const ci = readiness && ciStatus ? { state: "observed", status: ciStatus, observedAt: readiness.observedAt,
      revision: readiness.revision, url: null } : unknown;

    const nextAction = phase === "waiting" ? "Copy the current handoff into a fresh role session and return the reply through the Vibez CLI inbox." :
      phase === "prepared" ? "Start this prepared session from the Vibez CLI." :
      phase === "rework" ? "Inspect the recorded review and continue through Vibez CLI rework." :
      phase === "blocked" ? (stopped ? this.#diagnostic("WORKFLOW_STOPPED", stopped.remediation).message : "Resolve the blocker in Vibez and refresh this run.") : null;
    return {
      role: phase === "waiting" ? role : null, repair: phase === "completed" ? null : repair,
      detail: {
        summary: {
          projectId: this.projectId, sessionId: first.sessionId, currentAttemptId: session.sessionId, observedAt,
          taskId: session.taskId, issueUrl: `https://github.com/${profile.repository}/issues/${session.issueNumber}`,
          checkoutLabel: this.checkoutLabel, branch, revision: sourceRevision ?? revision(session.registrationRevision), phase,
        },
        attempt: { attemptId: session.sessionId, predecessorAttemptId: session.predecessor, nativeRunId: journal?.runId ?? null },
        gate, blocker: phase === "completed" ? null : reason, nextAction,
        pending: { role: phase === "waiting" ? role?.ref ?? null : null,
          repair: repair && replyToPacketId && phase !== "completed" ? { packet: repair.ref, replyToPacketId } : null },
        actions: (phase === "waiting" && role) || (repair && phase !== "completed") ? ["read-packet"] : [],
        pullRequest, ci,
      },
    };
  }
}
