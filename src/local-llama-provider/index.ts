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
  /** Trusted, scoped workspace effect. Must return only after committing or proving rollback. */
  readonly replaceFile?: (edit: LocalLlamaEdit, input: {
    readonly expectedRevision: string; readonly signal: AbortSignal;
  }) => Promise<void>;
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
  const options = Object.freeze({ ...input, assets: Object.freeze({ ...input.assets }) });
  if (process.platform !== "linux" || !isSha(options.projectIdentity) || !isAbsolute(options.repositoryRoot) ||
      !isAbsolute(options.operationDirectory) ||
      [options.repositoryRoot, options.operationDirectory].some(path => !lstatSync(path).isDirectory() || realpathSync(path) !== path) ||
      !outside(options.repositoryRoot, options.operationDirectory) ||
      (statSync(options.operationDirectory).mode & 0o077) !== 0 ||
      ![0xef53, 0x794c7630, 0x58465342, 0x9123683e].includes(statfsSync(options.operationDirectory).type)) {
    throw invalid("Use an isolated Linux checkout and a separate private local operation directory.");
  }
  if (projectGit(options.repositoryRoot, ["rev-parse", "--show-prefix"]).trim() !== "") throw invalid("Select the exact project root.");
  requireInt(options.contextTokens, 1024, 32768);
  requireInt(options.outputTokens, 64, Math.min(4096, options.contextTokens - 512));
  for (const asset of [options.assets.launcherPath, options.assets.runtimeDirectory, options.assets.dependencyDirectory, options.assets.modelPath]) {
    if (!outside(options.repositoryRoot, asset)) throw invalid("Inference assets are host-owned, outside the worktree.");
  }
  await verifyAssets(options.assets);
  const journal = new LocalLlamaJournal(options.operationDirectory);
  const configDigest = digest({ version: 1, assets: options.assets,
    contextTokens: options.contextTokens, outputTokens: options.outputTokens });
  const capabilities = Object.freeze({ providerId: LOCAL_LLAMA_PROVIDER_ID, supportedRoles: roleNames,
    supportsCancellation: true, supportsTimeout: true });
  const runtime: ScopedWorkerRuntime = {
    provider: { providerId: LOCAL_LLAMA_PROVIDER_ID, capabilities: () => capabilities },
    runValidator: options.runValidator,
    async runAgent(request, scope) {
      const role = scope.role;
      if (role === undefined || role.role !== request.role || role.principal !== request.actorId ||
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
      signal.throwIfAborted();
      const packet = JSON.stringify(request.contextPackage);
      // Detach the accepted identity before asynchronous inference or host effects.
      request = { ...request, contextPackage: JSON.parse(packet) as AgentRunRequest["contextPackage"] };
      const files = role.tools.includes("snapshot.read") ? [...(options.snapshotPaths?.(request) ?? [])] : [];
      if (files.length > 12 || new Set(files).size !== files.length) throw invalid("The snapshot file set exceeds the input budget.");
      const editablePath = request.role === "Developer" && role.tools.includes("workspace.replace")
        ? options.editablePath?.(request) ?? null : null;
      if (editablePath !== null && (!files.includes(editablePath) || options.replaceFile === undefined)) {
        throw invalid("The replacement file must be in the approved committed snapshot.");
      }
      const paths = [...scope.paths];
      const attempt = digest([options.projectIdentity, request.taskId, request.role, request.runId]);
      const binding = digest([attempt, request.actorId, request.revisionIdentity, digest(packet),
        configDigest, role.tools, paths, files, editablePath, request.timeoutMs]);
      const replay = journal.find(attempt, binding);
      if (replay !== null) {
        if (replay.result !== undefined) return replay.result;
        throw unavailable("This local attempt is terminal. A new host-authorized invocation is required.");
      }
      const assertCurrent = () => {
        if (projectGit(options.repositoryRoot, ["rev-parse", "HEAD"]).trim() !== request.revisionIdentity) {
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
      signal.throwIfAborted();
      journal.begin(intent);
      const worker = await runIsolatedLlama(options.assets, options.operationDirectory, prompt, responseSchema(binding, editablePath),
        options.contextTokens, options.outputTokens, signal);
      if (!worker.stopped) throw unavailable("Local worker termination is unconfirmed. The attempt is quarantined.");
      if (worker.output === null) {
        journal.finish(attempt, { binding, status: signal.aborted ? "CANCELLED" : "TRANSPORT_FAILED" });
        if (signal.aborted) throw new AgentProviderError("CANCELLED", "Local worker stopped after interruption.", false, LOCAL_LLAMA_PROVIDER_ID);
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
      if (signal.aborted) {
        journal.finish(attempt, { binding, status: "CANCELLED" });
        throw new AgentProviderError("CANCELLED", "Local worker stopped before accepting its result.", false, LOCAL_LLAMA_PROVIDER_ID);
      }
      assertCurrent();
      if (parsed.edit !== null && parsed.edit.content !== snapshots[parsed.edit.path]) {
        // Any uncertainty about the effect itself retains the original lease.
        // The effect is a trusted application operation, never a model subprocess tool.
        await options.replaceFile!(parsed.edit, { expectedRevision: request.revisionIdentity, signal });
      }
      journal.finish(attempt, { binding, status: "COMPLETED", result: parsed.result });
      return parsed.result;
    },
  };
  return {
    runtime: Object.freeze(runtime),
    /** Inspect using the same trusted invocation identity retained in the private receipt. */
    retireDrainedAttempt: (attempt: string, binding: string, verifyDrained: () => boolean) =>
      journal.retire(attempt, binding, verifyDrained),
  };
}
