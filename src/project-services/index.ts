import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { AgentProviderError, AgentRunner, type AgentProvider } from "../agent-provider/index.js";
import { ArchitectureReviewGate, RepositoryArchitectureContextSource } from "../architecture-review/index.js";
import { FileAssignmentLockStore } from "../assignment-lock/index.js";
import { runCli, type CliRunContext } from "../cli/core.js";
import { ControlledMergeController, FileControlledMergeTaskLock, type ControlledMergePullRequestPort } from "../controlled-merge/index.js";
import { DeveloperStartWorkflow, FileDeveloperStartStateStore } from "../dev-start/index.js";
import { DeveloperValidationGate } from "../dev-validation/index.js";
import { FileEvidenceStore } from "../evidence-store/index.js";
import { GitBranchLifecycleAdapter, LocalGitBranchOperations } from "../git-branch-lifecycle/index.js";
import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { checkProjectUpgrade, readProjectAudit, type UpgradeCheckRequest } from "../history/index.js";
import { evidenceReceiptIdentity, provenanceFor, recordProvenance } from "../history/provenance.js";
import { readEvidenceHistories } from "../status-reporting/local-source.js";
import { MergeReadinessPolicyEngine, type MergeReadinessPrPort, type MergeReadinessCiPort } from "../merge-readiness/index.js";
import { FileOrchestrationRunStore, SequentialOrchestrationEngine, type OrchestrationRunRequest } from "../orchestration-engine/index.js";
import { PullRequestLifecycleAdapter, type PullRequestOperations } from "../pr-lifecycle/index.js";
import { getAssetCatalog, readPackageJson } from "../project-assets/index.js";
import { checkedProjectPath, ConfigError, digest, projectGit, resolveProjectConfig, writablePaths, type ProjectLocation } from "../project-config/index.js";
import { FileQaReviewTaskLock, QaReviewGate, RepositoryQaContextSource } from "../qa-review/index.js";
import { checkRecoveryState, LocalRecoveryTools, parseRecoveryRequest, type RecoveryRequest } from "../recovery-tools/index.js";
import { ReviewFramework } from "../review-framework/index.js";
import { ReviewReworkGate } from "../review-rework/index.js";
import { createLocalStatusDependencies, ProjectStatusReporter } from "../status-reporting/index.js";
import { loadTaskRegistry, validateDependencyDag, type TaskRegistry, type TaskLifecycleState } from "../task-registry/index.js";
import { UatReviewGate } from "../uat-review/index.js";
import { WorkflowDiagnostics } from "../workflow-diagnostics/index.js";
import { createProjectContext, trackedFiles } from "./context.js";
import { createRetryBudget, type RetryBudgetGrant } from "./retry-budget.js";
import { configuredValidators, type ProjectValidatorCommand } from "./validators.js";

export type { RetryBudgetGrant } from "./retry-budget.js";
export { npmValidatorCommands, type ProjectValidatorCommand } from "./validators.js";

export interface ProjectIntegration {
  readonly repository: string;
  readonly publication: PullRequestOperations;
  readonly pullRequests: MergeReadinessPrPort;
  readonly ci: MergeReadinessCiPort;
  readonly merge: ControlledMergePullRequestPort;
}

export interface ProjectHost {
  /** Stable ID/version covering adapter implementations and trusted policy. */
  readonly identity: string;
  /** SHA-256 of the installed artifact, if the host independently verified it. */
  readonly verifiedArtifactSha256?: string;
  readonly executors: ReadonlyMap<string, ProjectValidatorCommand>;
  readonly providers?: ReadonlyMap<string, AgentProvider>;
  readonly hasCredentialReference?: (id: string) => boolean;
  readonly integration: ProjectIntegration;
  readonly authorizePublication?: (request: { repository: string; taskId: string; revision: string }) => boolean;
  readonly authorizeMerge?: (request: { repository: string; number: number; expectedHeadSha: string }) => boolean;
  readonly authorizeRetryBudget?: (grant: RetryBudgetGrant) => boolean;
  readonly authorizeRecovery?: (request: RecoveryRequest) => boolean;
}

function verifyTree(root: string): void {
  let entries = 0;
  function visit(path: string, depth: number): void {
    if (depth > 32 || ++entries > 100000) throw new ConfigError("UNSAFE_PATH", "Runtime path exceeds inspection limits.");
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || (info.isFile() ? info.nlink > 1 : !info.isDirectory())) {
      throw new ConfigError("UNSAFE_PATH", "Runtime paths may contain only regular files and directories.");
    }
    if (info.isDirectory()) for (const name of readdirSync(path)) {
      if (name.toLowerCase() === ".git") throw new ConfigError("UNSAFE_PATH", "Runtime paths cannot contain a Git worktree.");
      visit(join(path, name), depth + 1);
    }
  }
  visit(root, 0);
}

export async function createProjectServices(location: ProjectLocation, host: ProjectHost) {
  const config = resolveProjectConfig(location);
  const { document, projectRoot, paths } = config;
  const repository = document.project.repository;
  const { integrationTarget, requiredChecks, remote } = document.policy;
  const statePaths = { state: document.paths.state, evidence: document.paths.evidence, orchestration: `${document.paths.operations}/orchestration` };
  if (!host.identity.trim() || host.integration.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new ConfigError("IDENTITY_CONFLICT", "The host integration does not bind the configured repository.");
  }
  for (const id of document.providers.credentials) {
    if (host.hasCredentialReference?.(id) !== true) throw new ConfigError("TOOL_UNAVAILABLE", `Host credential reference '${id}' is unavailable.`);
  }
  const catalog = getAssetCatalog();
  const context = createProjectContext(config, catalog);
  const contextPolicyDigest = context.load(config.revision).policyDigest;
  const validatorResolver = configuredValidators(config, host.executors);
  const manual = document.providers.execution === "local-manual"
    ? new FileManualAgentProvider(paths.exchange, { deferDirectory: true, configuredHost: true, beforeWrite: () => prepareWrite(),
      afterExport: ({ taskId, role, runId, actorId, revisionIdentity }) =>
        recordProvenance(auditRoot, digest({ taskId, role, runId, actorId, revisionIdentity }), null, engineProvenance, () => prepareWrite(auditRoot)),
    }) : undefined;
  const provider = manual ?? host.providers?.get(document.providers.execution);
  if (provider === undefined) throw new ConfigError("TOOL_UNAVAILABLE", `Execution provider '${document.providers.execution}' is unavailable.`);
  const registryFiles = trackedFiles(config, config.revision, document.paths.tasks, ".task.json");
  function registryIdentity(revision: string): string {
    const files = trackedFiles(config, revision, document.paths.tasks, ".task.json");
    return digest(files.map(path => {
      const tracked: unknown = JSON.parse(projectGit(projectRoot, ["show", `${revision}:${path}`]));
      if (digest(tracked) !== digest(JSON.parse(readFileSync(checkedProjectPath(projectRoot, path, "file"), "utf8")))) {
        throw new ConfigError("IDENTITY_CONFLICT", `Task definition '${path}' differs from the tracked revision.`);
      }
      return [path, tracked];
    }));
  }
  const registryDigest = registryIdentity(config.revision);
  const authoredRegistry = await loadTaskRegistry({ repositoryRoot: projectRoot, taskDirectory: paths.tasks });
  if (authoredRegistry.size !== registryFiles.length || [...authoredRegistry.values()].some(task => !registryFiles.includes(task.sourcePath.replaceAll("\\", "/")))) {
    throw new ConfigError("IDENTITY_CONFLICT", "Configured task directory includes untracked or unexpected definitions.");
  }
  const registry: TaskRegistry = new Map([...authoredRegistry].map(([id, task]) => [id,
    Object.freeze({ ...task, requiredReviewRoles: Object.freeze([...new Set([...task.requiredReviewRoles, ...document.policy.reviewRoles])]) })]));
  const graphErrors = validateDependencyDag(registry);
  if (graphErrors.length) throw new ConfigError("CONFIG_INVALID", "Task dependencies contain unresolved or cyclic edges.");
  const capabilities = provider.capabilities();
  const requiredRoles = new Set(["Developer", ...document.policy.reviewRoles, ...[...registry.values()].flatMap(task => task.requiredReviewRoles)]);
  if ([...requiredRoles].some(role => !(capabilities.supportedRoles as readonly string[]).includes(role)) ||
    !capabilities.supportsTimeout || !capabilities.supportsCancellation) {
    throw new ConfigError("TOOL_UNAVAILABLE", "Execution provider lacks the configured role, timeout, or cancellation capabilities.");
  }

  const inputsAt = (task: NonNullable<ReturnType<TaskRegistry["get"]>>, revision: string) => {
    const artifacts = context.artifactsFor(task, registry, revision);
    const projectContracts = artifacts.some(artifact => artifact.kind === "contract" && !artifact.sourcePath.startsWith("vibez-package:"));
    const scopedPaths = projectContracts && task.allowedPaths.length
      ? new Set(projectGit(projectRoot, ["ls-files", "-z", "--", ...task.allowedPaths.map(path => `:(glob)${path}`)]).split("\0"))
      : new Set<string>();
    return digest({ task, artifacts: artifacts.map(({ revision: _revision, ...artifact }) =>
      artifact.kind === "contract" && scopedPaths.has(artifact.sourcePath)
        ? { artifactId: artifact.artifactId, kind: artifact.kind, sourcePath: artifact.sourcePath }
        : artifact) });
  };
  for (const task of registry.values()) context.artifactsFor(task, registry, config.revision);
  const validatorBinding = validatorResolver.resolve([...registry.values()][0]!, config.revision);
  const executionBinding = digest({
    config: config.configDigest, project: config.projectIdentity, worktree: config.worktreeIdentity, assets: catalog,
    package: readPackageJson("package.json").sha256, contextPolicy: contextPolicyDigest, host: host.identity,
    provider: capabilities.providerId, validators: validatorBinding,
  });
  const engineProvenance = provenanceFor(config, executionBinding, contextPolicyDigest, capabilities.providerId, host.verifiedArtifactSha256);
  const auditRoot = join(paths.operations, "audit-provenance");
  const historyConfig = { configPath: location.configPath,
    ...(location.verifyLocalStorage === undefined ? {} : { verifyLocalStorage: location.verifyLocalStorage }) };
  const historyLocation = { repositoryRoot: projectRoot, config: historyConfig };
  const lifecycleRoot = join(paths.state, "lifecycle");
  const assignmentsRoot = join(paths.state, "assignments");
  const orchestrationRoot = join(paths.operations, "orchestration");

  const taskBindingPath = (taskId: string) => join(config.gitCommonDir, `vibez-task-${digest(taskId)}.json`);
  function readTaskBinding(taskId: string): string | null {
    const path = taskBindingPath(taskId);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new ConfigError("UNSAFE_PATH", "Unsafe task binding file.");
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  function assertTaskBinding(taskId: string, revision: string): void {
    const original = readTaskBinding(taskId);
    if (original === null) return;
    const task = registry.get(taskId);
    if (task === undefined || inputsAt(task, revision) !== original) {
      throw new ConfigError("IDENTITY_CONFLICT", `Tracked inputs for task '${taskId}' changed. Preserve its history and reconcile the original binding before continuing.`);
    }
  }

  function assertCurrent(taskId?: string): void {
    const revision = projectGit(projectRoot, ["rev-parse", "--verify", "HEAD"]).trim();
    config.assertCurrent(revision);
    if (registryIdentity(revision) !== registryDigest || context.load(revision).policyDigest !== contextPolicyDigest ||
      digest(validatorResolver.resolve([...registry.values()][0]!, revision)) !== digest(validatorBinding)) {
      throw new ConfigError("IDENTITY_CONFLICT", "Project inputs or validator bindings changed. Reload only after verifying the original run and history.");
    }
    for (const name of writablePaths) verifyTree(paths[name]);
    config.assertBinding(executionBinding);
    if (taskId !== undefined) assertTaskBinding(taskId, revision);
  }

  function guarded<Args extends unknown[], Result>(method: (...args: Args) => Result): (...args: Args) => Result {
    return (...args) => {
      assertCurrent();
      return method(...args);
    };
  }

  function assertTaskHistory(taskId: string): void {
    if (!registry.has(taskId)) return;
    source.lifecycle.get(taskId);
    source.assignments.get(taskId);
    readEvidenceHistories(paths.evidence, taskId, fileEvidence);
  }

  function taskGuarded<Request extends { readonly taskId: string }, Result>(method: (request: Request) => Result): (request: Request) => Result {
    return request => {
      assertCurrent(request?.taskId);
      if (typeof request?.taskId === "string") assertTaskHistory(request.taskId);
      return method(request);
    };
  }

  function prepareWrite(...directories: string[]): void {
    assertCurrent();
    config.bindStorage(executionBinding);
    for (const directory of directories) mkdirSync(directory, { recursive: true });
  }

  const fileEvidence = new FileEvidenceStore(paths.evidence, { deferDirectory: true, afterAppend: record => {
    const { subject, recordSha256 } = evidenceReceiptIdentity(record);
    recordProvenance(auditRoot, subject, recordSha256, engineProvenance, () => prepareWrite(auditRoot));
  } });
  const source = await createLocalStatusDependencies(projectRoot, registry, { state: paths.state, evidence: paths.evidence, evidenceStore: fileEvidence });
  const lifecycle = new FileDeveloperStartStateStore(lifecycleRoot, true);
  const stateStore = { get: source.lifecycle.get, save: (...args: Parameters<typeof lifecycle.save>) => {
    assertCurrent(args[0].taskId);
    prepareWrite(lifecycleRoot);
    lifecycle.save(...args);
  } };
  const assignmentFiles = new FileAssignmentLockStore(assignmentsRoot, true);
  const lockStore = {
    get: assignmentFiles.get.bind(assignmentFiles),
    getAudit: assignmentFiles.getAudit.bind(assignmentFiles),
    acquire: (request: Parameters<typeof assignmentFiles.acquire>[0]) => {
      const task = registry.get(request.taskId);
      if (task === undefined) throw new ConfigError("IDENTITY_CONFLICT", "Task is missing its configured inputs.");
      const currentRevision = gitOperations.currentRevision();
      assertTaskBinding(task.taskId, currentRevision);
      const bound = inputsAt(task, currentRevision);
      const target = gitOperations.localBranchExists(task.canonicalBranch) ? task.canonicalBranch : integrationTarget;
      const revision = projectGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${target}`]).trim();
      config.assertRevisionConfig(revision);
      if (registryIdentity(revision) !== registryDigest || inputsAt(task, revision) !== bound) {
        throw new ConfigError("IDENTITY_CONFLICT", "Canonical branch has different configured task inputs.");
      }
      prepareWrite(join(assignmentsRoot, ".history"), join(assignmentsRoot, ".claims"));
      try {
        writeFileSync(taskBindingPath(request.taskId), bound, { flag: "wx", encoding: "utf8" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || readTaskBinding(request.taskId) !== bound) throw error;
      }
      return assignmentFiles.acquire(request);
    },
    release: (request: Parameters<typeof assignmentFiles.release>[0]) => {
      config.assertStorage();
      verifyTree(paths.state);
      config.assertBinding(executionBinding);
      return assignmentFiles.release(request);
    },
    recoverStale: guarded(assignmentFiles.recoverStale.bind(assignmentFiles)),
  };
  const gitOperations = new LocalGitBranchOperations(projectRoot);
  const branchLifecycle = new GitBranchLifecycleAdapter(gitOperations, integrationTarget);
  const evidenceStore = {
    record: (payload: unknown) => {
      const validation = fileEvidence.validate(payload);
      if (!validation.ok) return validation;
      if (typeof payload === "object" && payload !== null && "taskId" in payload && typeof payload.taskId === "string") {
        assertCurrent(payload.taskId);
      }
      prepareWrite(paths.evidence);
      return fileEvidence.record(payload);
    },
    validate: fileEvidence.validate.bind(fileEvidence),
    getCurrent: fileEvidence.getCurrent.bind(fileEvidence),
    getHistory: fileEvidence.getHistory.bind(fileEvidence),
    checkRevision: fileEvidence.checkRevision.bind(fileEvidence),
  };
  const evidenceLocation = paths.evidence;
  const common = { registry, stateStore, branchLifecycle, evidenceStore, evidenceLocation };
  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation });
  const taskLock = new FileQaReviewTaskLock(lifecycleRoot, true);
  const review = { ...common, taskLock, reviewFramework };
  const startGate = new DeveloperStartWorkflow({ ...common, lockStore, contextSource: context });
  const validationGate = new DeveloperValidationGate({ ...common, validatorResolver });
  const qa = new QaReviewGate({ ...review, contextSource: new RepositoryQaContextSource(projectRoot, integrationTarget, context.artifactsFor, remote) });
  const architecture = new ArchitectureReviewGate({ ...review, contextSource: new RepositoryArchitectureContextSource(projectRoot, integrationTarget,
    (task, tasks, revision) => context.artifactsFor(task, tasks, revision, true), remote) });
  const uat = new UatReviewGate({ ...review, contextSource: { artifactsFor: (task, tasks, revision, role) =>
    role === "Developer" ? context.artifactsFor(task, tasks, revision) : [] } });
  const rework = new ReviewReworkGate({ ...common, taskLock: {
    withLock: (taskId, action) => taskLock.withLock(taskId, () => {
      const cycles = stateStore.get(taskId)?.history.filter(event => event.toState === "REWORK_REQUIRED").length ?? 0;
      if (stateStore.get(taskId)?.currentState !== "REWORK_REQUIRED" && cycles >= document.budgets.maxReworkCycles) {
        throw new ConfigError("IDENTITY_CONFLICT", "Project rework allowance is exhausted.");
      }
      return action();
    }),
  } });
  const readiness = new MergeReadinessPolicyEngine({
    registry, branchLifecycle, approvals: rework, evidence: evidenceStore, lifecycleState: stateStore, integrationTarget, requiredCiChecks: requiredChecks,
    pullRequests: host.integration.pullRequests, ciStatus: host.integration.ci,
  });
  const integration = host.integration.merge;
  const merge = new ControlledMergeController({ ...common, lockStore, integrationTarget, mergeReadiness: readiness,
    taskLock: new FileControlledMergeTaskLock(lifecycleRoot, {}, true),
    pullRequests: {
      findPullRequestsByHead: integration.findPullRequestsByHead.bind(integration),
      getPullRequest: integration.getPullRequest.bind(integration),
      mergePullRequest: guarded(async request => {
        if (host.authorizeMerge?.({ ...request, repository }) !== true) {
          throw new ConfigError("IDENTITY_CONFLICT", "Host authorization for the exact repository, PR, and head is required.");
        }
        return integration.mergePullRequest(request);
      }),
    },
  });
  const pr = new PullRequestLifecycleAdapter({ registry, branchLifecycle, integrationTarget, approvals: rework, pullRequests: host.integration.publication });
  const status = new ProjectStatusReporter(source);
  const diagnostics = new WorkflowDiagnostics({ source, validatorResolver, mergeReadiness: readiness });
  const recovery = await LocalRecoveryTools.create(projectRoot, {
    registry, paths: statePaths, source, ...(host.authorizeRecovery === undefined ? {} : { authorizeOverride: host.authorizeRecovery }),
  });

  function assertRegistryHistory(): void {
    for (const taskId of registry.keys()) assertTaskHistory(taskId);
  }
  const developerStart = { start: guarded((request: Parameters<typeof startGate.start>[0]) => {
    assertRegistryHistory();
    return startGate.start(request);
  }) };
  const developerValidation = { validate: taskGuarded(validationGate.validate.bind(validationGate)) };
  const qaReview = { prepareContext: taskGuarded(qa.prepareContext.bind(qa)), review: taskGuarded(qa.review.bind(qa)) };
  const architectureReview = { prepareContext: taskGuarded(architecture.prepareContext.bind(architecture)), review: taskGuarded(architecture.review.bind(architecture)) };
  const uatReview = { prepareContext: taskGuarded(uat.prepareContext.bind(uat)), review: taskGuarded(uat.review.bind(uat)) };
  const reviewRework = {
    enterRework: taskGuarded(rework.enterRework.bind(rework)),
    resumeDevelopment: taskGuarded(rework.resumeDevelopment.bind(rework)),
    getApprovalStatus: taskGuarded(rework.getApprovalStatus.bind(rework)),
  };
  const controlledMerge = { merge: taskGuarded((request: Parameters<typeof merge.merge>[0]) => {
    if (host.authorizeMerge === undefined) throw new ConfigError("IDENTITY_CONFLICT", "Controlled merge requires an explicit host authority.");
    return merge.merge(request);
  }) };
  const agentRunner = new AgentRunner({ provider });
  const runStore = new FileOrchestrationRunStore(orchestrationRoot, true);
  const grantsRoot = join(paths.operations, "retry-grants");
  const budget = createRetryBudget(grantsRoot, runStore, executionBinding, document.budgets.maxAttempts,
    () => prepareWrite(grantsRoot), host.authorizeRetryBudget);
  const engine = new SequentialOrchestrationEngine({
    developerStart, developerValidation, qaReview, architectureReview, uatReview, reviewRework,
    mergeReadiness: readiness, controlledMerge, taskRegistry: registry, lifecycleState: stateStore,
    runStore: {
      get: runStore.get.bind(runStore), save: runStore.save.bind(runStore),
      withLock: action => {
        prepareWrite(orchestrationRoot);
        return runStore.withLock(action);
      },
    },
    agentRunner: { run: guarded((request: Parameters<typeof agentRunner.run>[0]) => {
      const { taskId, role, runId, actorId, revisionIdentity } = request;
      assertTaskBinding(taskId, gitOperations.currentRevision());
      recordProvenance(auditRoot, digest({ taskId, role, runId, actorId, revisionIdentity }), null, engineProvenance, () => prepareWrite(auditRoot));
      return agentRunner.run(request);
    }) },
    retryPolicy: { maxAttempts: document.budgets.maxAttempts, delayMs: document.budgets.retryDelayMs },
    timeoutMsFor: () => document.budgets.providerTimeoutMs,
    maxAttemptsFor: budget.effective,
  });
  const configuredManual: NonNullable<CliRunContext["configuredManual"]> = {
    exchange: paths.exchange,
    ...(manual === undefined ? {} : { provider: manual }),
    inputPath: (path, operation) => {
      const allowed = operation === "import" ? paths.responses : paths.intake;
      try {
        const input = checkedProjectPath(projectRoot, path, "file");
        const child = relative(allowed, input);
        if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new Error("Outside input root.");
        return input;
      } catch {
        throw new AgentProviderError("INVALID_REQUEST", "Use a relative manual input file under the configured intake or response root.", false);
      }
    },
    verifyTaskHistory: taskId => {
      assertCurrent(taskId);
      assertTaskHistory(taskId);
    },
    verifyRequest: request => {
      assertCurrent(request.taskId);
      assertTaskHistory(request.taskId);
      const task = registry.get(request.taskId);
      if (task === undefined || !task.requiredReviewRoles.includes(request.role) ||
        branchLifecycle.currentRevision() !== request.revisionIdentity) {
        throw new AgentProviderError("INVALID_REQUEST", "Manual request must match a registered task, allowed role, and current revision.", false);
      }
    },
  };
  const recoveryCheck = guarded((now: string) => checkRecoveryState(projectRoot, { registry, now, paths: statePaths, source, validatorResolver }));
  const recoveryApply = guarded((request: unknown) => {
    const parsed = parseRecoveryRequest(request);
    assertCurrent(parsed.taskId);
    if (host.authorizeRecovery?.(parsed) !== true) throw new ConfigError("IDENTITY_CONFLICT", "Recovery requires explicit host authority.");
    return recovery.apply(parsed);
  });
  const readStatus = guarded(status.read.bind(status));
  const services = {
    config, catalog, executionBinding, registry: new Map(registry), context: { artifactsFor: guarded(context.artifactsFor) },
    evidence: { getHistory: guarded(fileEvidence.getHistory.bind(fileEvidence)), getCurrent: guarded(fileEvidence.getCurrent.bind(fileEvidence)) },
    validatorResolver,
    developerStart, developerValidation, qaReview, architectureReview, uatReview, reviewRework,
    pullRequests: { ensurePullRequest: taskGuarded(async (request: Parameters<typeof pr.ensurePullRequest>[0]) => {
      const revision = branchLifecycle.currentRevision();
      if (host.authorizePublication?.({ repository, taskId: request.taskId, revision }) !== true) {
        throw new ConfigError("IDENTITY_CONFLICT", "Host publication authorization is required.");
      }
      return pr.ensurePullRequest(request);
    }) },
    ci: host.integration.ci,
    mergeReadiness: { evaluate: taskGuarded(readiness.evaluate.bind(readiness)) },
    controlledMerge,
    orchestration: {
      increaseRetryBudget: taskGuarded(budget.increase),
      run: guarded((request: OrchestrationRunRequest) => {
        assertRegistryHistory();
        const key = request.idempotencyKey ?? request.runId;
        const start = runStore.get(key)?.values.start as { taskId?: string } | undefined;
        if (start?.taskId !== undefined) assertTaskBinding(start.taskId, gitOperations.currentRevision());
        return engine.run({ ...request,
          timeoutMs: Math.min(request.timeoutMs ?? document.budgets.operationTimeoutMs, document.budgets.operationTimeoutMs) });
      }),
    },
    status: { read: readStatus },
    diagnostics: {
      audit: (taskId: string) => readProjectAudit(historyLocation, taskId),
      checkUpgrade: (request: Omit<UpgradeCheckRequest, "repositoryRoot" | "config">) => checkProjectUpgrade({ ...request, ...historyLocation }),
      explainTask: guarded(diagnostics.explainTask.bind(diagnostics)),
      explainTransition: guarded(diagnostics.explainTransition.bind(diagnostics)),
      explainValidation: guarded(diagnostics.explainValidation.bind(diagnostics)),
      explainReviews: guarded(diagnostics.explainReviews.bind(diagnostics)),
      explainMerge: guarded(diagnostics.explainMerge.bind(diagnostics)),
    },
    recovery: { check: recoveryCheck, apply: recoveryApply },
    async cli(args: readonly string[], signal?: AbortSignal) {
      assertCurrent();
      const taskStates = new Map<string, TaskLifecycleState>();
      for (const taskId of registry.keys()) {
        const record = stateStore.get(taskId);
        if (record !== null) taskStates.set(taskId, record.currentState);
      }
      const cliContext: CliRunContext = {
        configuredProject: true, historyConfig, repositoryRoot: projectRoot, taskRegistry: registry, taskStates, developerStartWorkflow: developerStart,
        developerValidationGate: developerValidation, projectStatusReporter: { read: readStatus }, workflowDiagnostics: diagnostics,
        recoveryCheck, recoveryApply, configuredManual,
        ...(signal === undefined ? {} : { signal }),
      };
      return runCli(args, cliContext);
    },
  };
  assertCurrent();
  const currentBranch = gitOperations.currentBranch();
  for (const task of registry.values()) {
    if (task.canonicalBranch === currentBranch && source.lifecycle.get(task.taskId)?.currentState !== "DONE") {
      assertTaskBinding(task.taskId, config.revision);
    }
  }
  return Object.freeze(services);
}

export async function doctorProject(location: ProjectLocation, host: ProjectHost) {
  try {
    const services = await createProjectServices(location, host);
    return { ok: true as const, revision: services.config.revision, configDigest: services.config.configDigest };
  } catch (error: unknown) {
    return { ok: false as const, code: error instanceof ConfigError ? error.code : "PROJECT_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Unable to inspect project." };
  }
}
