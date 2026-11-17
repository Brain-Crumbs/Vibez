import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync, statfsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { AgentProviderError, type AgentRunRequest } from "../agent-provider/index.js";
import type { ScopedWorkerRuntime } from "../host-policy/worker.js";
import { checkedProjectPath, digest, projectGit } from "../project-config/index.js";
import { isSha } from "../history/provenance.js";
import { LocalLlamaJournal, unavailable } from "./journal.js";
import { invalid, LOCAL_LLAMA_PROVIDER_ID, parseOutput, renderPrompt, responseSchema, roleNames, supportedTools, type LocalLlamaEdit } from "./protocol.js";
import { runIsolatedLlama, verifyAssets, type LocalLlamaAssets } from "./worker.js";

export { LOCAL_LLAMA_PROVIDER_ID, type LocalLlamaEdit } from "./protocol.js";
export type { LocalLlamaAssets } from "./worker.js";

export interface LocalLlamaRuntimeOptions {
  readonly repositoryRoot: string;
  readonly projectIdentity: string;
  readonly operationDirectory: string;
  readonly assets: LocalLlamaAssets;
  readonly contextTokens: number;
  readonly outputTokens: number;
  /** Trusted host selection of a finite set of committed text inputs at the request revision. */
  readonly snapshotPaths?: (request: AgentRunRequest) => readonly string[];
  /** A single existing file in the input scope. Review roles never receive this capability. */
  readonly editablePath?: (request: AgentRunRequest) => string | null;
  /** Synchronous trusted effect using an exclusive ref fence. Return only once committed or rolled back. */
  readonly replaceFile?: (edit: LocalLlamaEdit, input: {
    readonly expectedRevision: string; readonly expectedBranch: string; readonly signal: AbortSignal;
  }) => { readonly status: "COMMITTED"; readonly revision: string } | { readonly status: "ROLLED_BACK" };
  readonly runValidator: ScopedWorkerRuntime["runValidator"];
}

function outside(root: string, path: string) {
  const child = relative(root, path);
  return child === ".." || child.startsWith("../") || isAbsolute(child);
}

function requireInt(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid("Local inference budget exceeds the supported range.");
}

export async function createLocalLlamaRuntime(input: LocalLlamaRuntimeOptions) {
  if (!Array.isArray(input.assets.libraries)) throw invalid("Pin every local inference library in the asset manifest.");
  const options = Object.freeze({ ...input, assets: Object.freeze({ ...input.assets,
    libraries: Object.freeze(input.assets.libraries.map(library => Object.freeze({ ...library }))) }) });
  if (process.platform !== "linux" || !isSha(options.projectIdentity) || !isAbsolute(options.repositoryRoot) ||
      !isAbsolute(options.operationDirectory) ||
      [options.repositoryRoot, options.operationDirectory].some(path => !lstatSync(path).isDirectory() || realpathSync(path) !== path) ||
      [options.repositoryRoot, options.operationDirectory].some(path => !outside("/usr", path)) ||
      !outside(options.repositoryRoot, options.operationDirectory) ||
      (statSync(options.operationDirectory).mode & 0o077) !== 0 ||
      ![0xef53, 0x794c7630, 0x58465342, 0x9123683e].includes(statfsSync(options.operationDirectory).type)) {
    throw invalid("Use an isolated Linux checkout and a separate private local operation directory.");
  }
  if (projectGit(options.repositoryRoot, ["rev-parse", "--show-prefix"]).trim() !== "") throw invalid("Select the exact project root.");
  requireInt(options.contextTokens, 1024, 32768);
  requireInt(options.outputTokens, 64, Math.min(4096, options.contextTokens - 512));
  for (const asset of [options.assets.launcherPath, options.assets.runtimeDirectory, options.assets.dependencyDirectory, options.assets.modelPath]) {
    if ([options.repositoryRoot, options.operationDirectory].some(root => !outside(root, asset) || !outside(asset, root))) {
      throw invalid("Inference assets may not overlap the worktree or private operations directory.");
    }
  }
  await verifyAssets(options.assets);
  const journal = new LocalLlamaJournal(options.operationDirectory);
  const configDigest = digest({ version: 1, assets: options.assets,
    contextTokens: options.contextTokens, outputTokens: options.outputTokens });
  const capabilities = Object.freeze({ providerId: LOCAL_LLAMA_PROVIDER_ID, supportedRoles: roleNames,
    supportsCancellation: true, supportsTimeout: true });
  const execute: ScopedWorkerRuntime["runAgent"] = async (request, scope) => {
    const role = scope.role;
    if (scope.projectIdentity !== options.projectIdentity || scope.worktreeRoot !== options.repositoryRoot ||
        role === undefined || role.role !== request.role || role.principal !== request.actorId ||
        role.provider !== LOCAL_LLAMA_PROVIDER_ID || role.model !== options.assets.model ||
        !roleNames.includes(role.role) || role.network !== "none" || request.toolPermissionPolicy.networkAccess !== "none" ||
        scope.maxTurns !== 1 || scope.maxCostMicros !== 0 ||
        request.contextPackage.schemaVersion !== "1.0.0" ||
        request.taskId !== request.contextPackage.taskId || request.role !== request.contextPackage.role ||
        request.revisionIdentity !== request.contextPackage.sourceRevision ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(request.revisionIdentity) || request.runId.trim() !== request.runId ||
        request.runId.length === 0 || !/^[A-Z]+-[0-9]{3,}$/.test(request.taskId)) {
      throw invalid("Run binding, role, or zero-cost offline inference allocation is invalid.");
    }
    requireInt(request.timeoutMs ?? 0, 1, 180_000);
    if (role.tools.some(name => !supportedTools.some(tool => tool === name) ||
        !request.toolPermissionPolicy.allowedTools.includes(name) || request.toolPermissionPolicy.deniedTools?.includes(name)) ||
        (request.role !== "Developer" && role.tools.includes("workspace.replace"))) {
      throw invalid("The requested capability exceeds the role’s offline tools.");
    }
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(request.timeoutMs!),
      ...(request.signal === undefined ? [] : [request.signal])]);
    const deadline = performance.now() + request.timeoutMs!;
    const expired = () => signal.aborted || performance.now() >= deadline;
    const stoppedError = () => new AgentProviderError(performance.now() >= deadline ? "TIMEOUT" : "CANCELLED",
      "The local invocation was interrupted.", false, LOCAL_LLAMA_PROVIDER_ID);
    if (expired()) throw stoppedError();
    const packet = JSON.stringify(request.contextPackage);
    // Detach the accepted identity before asynchronous inference or host effects.
    request = { ...request, contextPackage: JSON.parse(packet) as AgentRunRequest["contextPackage"] };
    const callHost = <T>(effect: () => T): T => {
      try { return effect(); } catch { throw unavailable("A trusted host input or effect failed. Check the private session records."); }
    };
    const files = role.tools.includes("snapshot.read") ? callHost(() => [...(options.snapshotPaths?.(request) ?? [])]) : [];
    if (files.length > 12 || new Set(files).size !== files.length) throw invalid("The snapshot file set exceeds the input budget.");
    const editablePath = request.role === "Developer" && role.tools.includes("workspace.replace")
      ? callHost(() => options.editablePath?.(request) ?? null) : null;
    if (editablePath !== null && (!files.includes(editablePath) || options.replaceFile === undefined)) {
      throw invalid("The replacement file must be in the approved committed snapshot.");
    }
    const paths = [...scope.paths];
    const attempt = digest([options.projectIdentity, request.taskId, request.role, request.runId]);
    const binding = digest([attempt, request.actorId, request.revisionIdentity, digest(packet),
      configDigest, scope.branch, role.tools, paths, files, editablePath, request.timeoutMs]);
    const replay = journal.find(attempt, binding);
    if (replay !== null) {
      if (replay.result !== undefined) return replay.result;
      throw unavailable("This local attempt is terminal. A new host-authorized invocation is required.");
    }
    const assertCurrent = () => {
      if (projectGit(options.repositoryRoot, ["rev-parse", "HEAD"]).trim() !== request.revisionIdentity ||
          projectGit(options.repositoryRoot, ["branch", "--show-current"]).trim() !== scope.branch) {
        throw invalid("The invocation revision is no longer current in the isolated checkout.");
      }
    };
    assertCurrent();
    const read = (path: string) => {
      if (!paths.some(prefix => path === prefix || path.startsWith(prefix + "/")) ||
          /^(?:\.git|\.agent|\.github)(?:\/|$)/i.test(path) || path === "AGENTS.md") {
        throw invalid("A snapshot path escapes the authorized role scope.");
      }
      checkedProjectPath(options.repositoryRoot, path, "file");
      const entry = projectGit(options.repositoryRoot, ["ls-tree", request.revisionIdentity, "--", path]).trim();
      if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry)) throw invalid("Select a tracked regular text file.");
      const content = projectGit(options.repositoryRoot, ["show", request.revisionIdentity + ":" + path]);
      if (content.includes("\0") || content.includes("\uFFFD")) throw invalid("Select a UTF-8 text snapshot.");
      return content;
    };
    const snapshots = Object.fromEntries(files.map(path => [path, read(path)]));
    const prompt = renderPrompt(request, packet, snapshots, binding, editablePath);
    const size = new TextEncoder().encode(prompt).byteLength;
    if (size > options.contextTokens - options.outputTokens - 32) throw invalid("The compiled prompt exceeds the input budget.");
    const intent = { version: 1 as const, attempt, binding, session: randomUUID(), role: request.role, revision: request.revisionIdentity,
      projectIdentity: options.projectIdentity, configDigest, provider: LOCAL_LLAMA_PROVIDER_ID,
      runtimeVersion: options.assets.runtimeVersion, model: options.assets.model, modelSha256: options.assets.modelSha256,
      occurredAt: new Date().toISOString() };
    await verifyAssets(options.assets);
    if (expired()) throw stoppedError();
    assertCurrent();
    scope.assertAuthorized();
    journal.begin(intent);
    if (expired()) {
      journal.finish(attempt, { binding, status: "CANCELLED" });
      throw stoppedError();
    }
    const worker = await runIsolatedLlama(options.assets, options.operationDirectory, prompt, responseSchema(binding, editablePath),
      options.contextTokens, options.outputTokens, signal);
    if (!worker.stopped) throw unavailable("Local worker termination is unconfirmed. The attempt is quarantined.");
    if (worker.output === null) {
      journal.finish(attempt, { binding, status: expired() ? "CANCELLED" : "TRANSPORT_FAILED" });
      if (expired()) throw stoppedError();
      throw unavailable("The local worker stopped without a valid response.");
    }
    let parsed;
    try {
      parsed = parseOutput(worker.output, request, binding, editablePath,
        "local-llama:" + attempt, new Date().toISOString());
    } catch (error) {
      journal.finish(attempt, { binding, status: "MALFORMED" });
      throw error;
    }
    if (expired()) {
      journal.finish(attempt, { binding, status: "CANCELLED" });
      throw stoppedError();
    }
    assertCurrent();
    let workspaceRevision: string | undefined;
    const edit = parsed.edit;
    if (edit !== null && edit.content !== snapshots[edit.path]) {
      // The trusted effect observes the exact source ref. Uncertain effects
      // keep the original lease and cannot be acknowledged as a PASS.
      scope.assertAuthorized();
      assertCurrent();
      if (expired()) {
        journal.finish(attempt, { binding, status: "CANCELLED" });
        throw stoppedError();
      }
      const effect = callHost(() => options.replaceFile!(edit, {
        expectedRevision: request.revisionIdentity, expectedBranch: scope.branch, signal,
      }));
      if (effect.status === "ROLLED_BACK") {
        assertCurrent();
        journal.finish(attempt, { binding, status: "EFFECT_REFUSED" });
        throw unavailable("The authorized workspace effect was rolled back.");
      }
      const git = (...args: string[]) => projectGit(options.repositoryRoot, args);
      if (effect.status !== "COMMITTED" || effect.revision !== git("rev-parse", "HEAD").trim() ||
          git("branch", "--show-current").trim() !== scope.branch ||
          git("rev-parse", "HEAD^").trim() !== request.revisionIdentity ||
          git("diff", "--name-only", "-z", request.revisionIdentity, "HEAD") !== edit.path + "\0" ||
          git("show", "HEAD:" + edit.path) !== edit.content) {
        throw unavailable("The workspace effect did not confirm exactly the approved one-file commit.");
      }
      workspaceRevision = effect.revision;
    }
    if (expired()) {
      journal.finish(attempt, { binding, status: "CANCELLED", ...(workspaceRevision === undefined ? {} : { workspaceRevision }) });
      throw stoppedError();
    }
    journal.finish(attempt, { binding, status: "COMPLETED", result: parsed.result,
      ...(workspaceRevision === undefined ? {} : { workspaceRevision }) });
    return parsed.result;
  };
  const runtime: ScopedWorkerRuntime = {
    provider: { providerId: LOCAL_LLAMA_PROVIDER_ID, capabilities: () => capabilities },
    runValidator: options.runValidator,
    async runAgent(request, scope) {
      try { return await execute(request, scope); }
      catch (error) {
        if (error instanceof AgentProviderError) throw error;
        throw unavailable("Local inference failed. Inspect the private session before retrying.");
      }
    },
  };
  return {
    runtime: Object.freeze(runtime),
    /** Inspect using the same trusted invocation identity retained in the private receipt. */
    retireDrainedAttempt: (attempt: string, binding: string, verifyDrained: () => boolean) =>
      journal.retire(attempt, binding, verifyDrained),
  };
}
