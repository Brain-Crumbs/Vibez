import { existsSync } from "node:fs";
import { FileDeveloperStartStateStore } from "../dev-start/index.js";
import { FileEvidenceStore } from "../evidence-store/index.js";
import { FileOrchestrationRunStore, type OrchestrationStageRecord } from "../orchestration-engine/index.js";
import type { ResolvedProjectConfig } from "../project-config/index.js";
import { successorId } from "../workflow-driver/inbox.js";
import { bindProfile, loadProfile, loadSession, sessionPath } from "../workflow-driver/intake.js";
import { driverDirectory, files, git, hash, object, orchestrationDirectory, redact, safePath, stateDirectory } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { pendingPackets, readOriginal, revision } from "./artifacts.js";
import { ConsoleProblem } from "./problem.js";
import { integrationObservations, validationIsActive } from "./observations.js";

const nativeId = /^[a-f0-9-]{36}$/;
const stages = {
  "developer-start": "assignment", "dev-validation": "developer-validation",
  "qa-review": "qa-review", "architecture-review": "architecture-review",
  "uat-review": "uat-review", "review-rework": "rework", "merge-readiness": "merge-readiness",
  "controlled-merge": "completion",
} as const;
type Phase = "prepared" | "active" | "waiting" | "blocked" | "rework" | "completed";
const notFound = () => new ConsoleProblem(404, "not-found", "The requested resource is unavailable.");
const unavailable = () => new ConsoleProblem(503, "temporarily-unavailable", "Restore the original configured project and driver profile, then retry.", 1000);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function stageFor(name: string | undefined) {
  return name && Object.hasOwn(stages, name) ? stages[name as keyof typeof stages] : undefined;
}
export class ManualConsoleReader {
  readonly projectId: string;
  readonly checkoutLabel: string;
  readonly #profileHash: string;
  readonly #root: string;

  constructor(private readonly config: ResolvedProjectConfig, private readonly commandsEnabled = false) {
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

  commandSession(id: string) {
    const profile = this.checkScope();
    const view = this.#view(profile, this.#rootSession(profile, id), new Date().toISOString());
    return { profile, session: this.#session(profile, view.detail.attempt.attemptId), detail: view.detail };
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

  #actionableRole(branch: string, head: string | null, role: string | null, packetRevision: string | null, session: DriverSession) {
    if (!head || !packetRevision) return false;
    const root = this.#root;
    try {
      if (git(root, "branch", "--show-current") !== branch ||
          git(root, "rev-parse", "--verify", "HEAD") !== head ||
          hash(JSON.parse(git(root, "show", `${head}:${session.definitionPath}`))) !== session.definitionHash) return false;
      if (role !== "Developer") return head === packetRevision;
      git(root, "merge-base", "--is-ancestor", packetRevision, head);
      return true;
    } catch { return false; }
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
    const staleRole = role !== null && !this.#actionableRole(branch, sourceRevision, role.ref.role, role.ref.revision, session);
    const roleInputIsObsolete = (role !== null && !staleRole) || journal?.pendingStage === "dev-validation";
    const failure = journal?.lastFailure?.code === "WAITING_INPUT" && roleInputIsObsolete ? undefined : journal?.lastFailure;
    const writer = ["writer.lock", "writer-recovery.lock"].some(name => existsSync(safePath(root, `${driverDirectory(profile)}/${name}`)));

    const done = state?.currentState === "DONE" && state.history.at(-1);
    const doneForRun = done && done.runId === `${session.request.runId}::controlled-merge`;
    const evidence = doneForRun && new FileEvidenceStore(safePath(root, profile.storage!.evidence), { readOnly: true })
      .getCurrent(`${session.taskId}::merge`);
    const completion = evidence ? evidence.payload : null;
    const mergeHead = revision(completion?.revisionIdentity);
    const merged = evidence && completion?.schemaId === "ipt.merge-evidence" && completion.taskId === session.taskId &&
      mergeHead && mergeHead === done.revisionIdentity && `${evidence.lineageId}@${evidence.sequence}` === done.evidenceRef &&
      typeof completion.recordedAt === "string" && typeof completion.pullRequestNumber === "number" &&
      Number.isSafeInteger(completion.pullRequestNumber) && completion.pullRequestNumber > 0 ?
      { recordedAt: completion.recordedAt, revisionIdentity: mergeHead, pullRequestNumber: completion.pullRequestNumber } : null;
    const rework = state?.currentState === "REWORK_REQUIRED" ||
      (session.predecessor !== null && session.status === "PREPARED" && !journal);
    const blockedDependency = session.status === "PREPARED" && dependencies.find(id => lifecycle(id)?.currentState !== "DONE");
    const validationActive = journal?.pendingStage === "dev-validation" && validationIsActive(root, profile, session);
    const phase: Phase = merged ? "completed" : rework ? "rework" : role && !staleRole ? "waiting" :
      validationActive ? "active" : staleRole || diagnostic || blockedDependency || result?.stopped || failure ? "blocked" :
      session.status === "PREPARED" && !journal ? "prepared" : "blocked";

    const stopped = result?.stopped;
    const usableDiagnostic = diagnostic?.code === "WAITING_INPUT" && role && !staleRole ? null : diagnostic;
    const reason = validationActive ? null : staleRole ? this.#diagnostic("STALE_ROLE_SOURCE", "Restore the bound task branch and revision, then inspect or resume this attempt with Vibez.") :
      usableDiagnostic ? this.#diagnostic(usableDiagnostic.code, usableDiagnostic.message) :
      stopped ? this.#diagnostic("WORKFLOW_STOPPED", stopped.reason) :
      failure ? this.#diagnostic(failure.code, failure.message) :
      blockedDependency ? this.#diagnostic("DEPENDENCY_NOT_DONE", `Wait for ${blockedDependency} to complete in Vibez.`) :
      writer ? this.#diagnostic("WRITER_BUSY", "A Vibez writer holds the checkout. Inspect or resume it from the CLI.") :
      phase === "blocked" ? this.#diagnostic("STATE_UNCERTAIN", "Inspect this attempt with the Vibez CLI before retrying.") : null;
    const observedStage = [...stageRecords].reverse().find(item => item.stage === stopped?.stage && stageFor(item.stage)) ??
      [...stageRecords].reverse().find(item => stageFor(item.stage));
    const stageName = stageFor(observedStage?.stage);
    const gateEvent = observedStage && state?.history.slice().reverse().find(event => event.runId === observedStage.runId);
    const gate = phase === "active" ? { state: "running", stage: "developer-validation" } :
      phase === "waiting" && role?.ref.role ? { state: "awaiting-role", role: role.ref.role } :
      stageName && observedStage ? { state: "observed", stage: stageName, outcome: observedStage.outcome.toLowerCase(),
        revision: revision(gateEvent?.revisionIdentity), diagnostic: observedStage.outcome === "PASS" ? null : reason } :
      { state: "idle" };

    const { pullRequest, ci } = integrationObservations(root, profile, session, merged);
    const registeredRevision = session.status === "PREPARED" && !journal ? revision(session.registrationRevision) : null;

    const actions: string[] = role || (repair && phase !== "completed") ? ["read-packet"] : [];
    if (this.commandsEnabled && !writer) {
      if (phase === "prepared") actions.push("start");
      else if (phase === "blocked" && !role && diagnostic?.code !== "DEPENDENCY_NOT_DONE" && !blockedDependency && !repair) actions.push("resume");
      else if (rework && session.predecessor && session.status === "PREPARED" && !repair) actions.push("resume");
      if ((phase === "waiting" && role) || (repair && replyToPacketId && phase !== "completed")) actions.push("submit-reply");
    }
    const nextAction = phase === "waiting" ? (actions.includes("submit-reply")
      ? "Copy the current handoff into a fresh role session, then submit the reply here."
      : "Copy the current handoff into a fresh role session and return the reply through the Vibez CLI inbox.") :
      phase === "active" ? "Wait for Vibez to finish developer validation." :
      phase === "prepared" ? (actions.includes("start") ? "Start this prepared session." : "Start this prepared session from the Vibez CLI.") :
      phase === "rework" ? (actions.includes("submit-reply") ? "Copy the offered repair into a fresh role session and submit its reply here."
        : actions.includes("resume") ? "Resume the linked attempt." : "Inspect the recorded review and continue through Vibez CLI rework.") :
      phase === "blocked" ? (stopped ? this.#diagnostic("WORKFLOW_STOPPED", stopped.remediation).message : "Resolve the blocker in Vibez and refresh this run.") : null;
    return {
      role: phase === "waiting" || staleRole ? role : null, repair: phase === "completed" ? null : repair,
      detail: {
        summary: {
          projectId: this.projectId, sessionId: first.sessionId, currentAttemptId: session.sessionId, observedAt,
          taskId: session.taskId, issueUrl: `https://github.com/${profile.repository}/issues/${session.issueNumber}`,
          checkoutLabel: this.checkoutLabel, branch, revision: sourceRevision ?? registeredRevision, phase,
        },
        attempt: { attemptId: session.sessionId, predecessorAttemptId: session.predecessor, nativeRunId: journal?.runId ?? null },
        gate, blocker: phase === "completed" ? null : reason, nextAction,
        pending: { role: phase === "waiting" || staleRole ? role?.ref ?? null : null,
          repair: repair && replyToPacketId && phase !== "completed" ? { packet: repair.ref, replyToPacketId } : null },
        actions,
        pullRequest, ci,
      },
    };
  }
}
