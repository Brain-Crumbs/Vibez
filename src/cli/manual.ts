import { assertLocalGateHistory } from "../status-reporting/local-source.js";
import { loadTaskRegistry } from "../task-registry/index.js";
import { recordLocalProvenance } from "../history/native-writer.js";
import { digest } from "../project-config/index.js";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentProviderError, AgentRunner, type AgentRunRequest } from "../agent-provider/index.js";
import { FileManualAgentProvider } from "../local-agent-adapter/index.js";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

export interface ConfiguredManual {
  readonly exchange: string;
  readonly provider?: FileManualAgentProvider;
  readonly inputPath: (path: string, operation: "export" | "import" | "run") => string;
  readonly verifyTaskHistory?: (taskId: string) => void;
  readonly verifyRequest: (request: AgentRunRequest) => void;
}

/** The manual surface only translates files to provider calls. It owns no gate. */
export async function runManualCommand(
  args: readonly string[],
  repositoryRoot: string,
  signal?: AbortSignal,
  configured?: ConfiguredManual,
): Promise<{ data: unknown; human: string }> {
  const operation = args[0];
  if (operation !== "export" && operation !== "import" && operation !== "run") {
    throw new AgentProviderError("INVALID_REQUEST", "Use manual export <request-file> <exchange-dir>, manual import <packet-id> <result-file> <exchange-dir>, or manual run <request-file> <exchange-dir>.", false);
  }
  const expected = operation === "import" ? 4 : 3;
  if (args.length !== expected || args.some((argument) => argument.trim().length === 0)) {
    throw new AgentProviderError("INVALID_REQUEST", `manual ${operation} requires exactly ${operation === "import" ? "<packet-id> <result-file> <exchange-dir>" : "<request-file> <exchange-dir>"}.`, false);
  }
  const root = resolve(repositoryRoot, args[expected - 1]!);
  if (configured !== undefined && (configured.provider === undefined || root !== configured.exchange)) {
    throw new AgentProviderError("INVALID_REQUEST", "Manual commands require the configured manual provider and exchange root.", false);
  }
  const provider = configured?.provider ?? new FileManualAgentProvider(root, {
    afterExport: ({ taskId, role, runId, actorId, revisionIdentity, providerId }) => {
      if (existsSync(join(repositoryRoot, ".git"))) recordLocalProvenance(repositoryRoot,
        digest({ taskId, role, runId, actorId, revisionIdentity }), null, providerId);
    },
  });
  const input = (value: string) => configured?.inputPath(value, operation) ?? resolve(repositoryRoot, value);
  async function verifyHistory(taskId: string): Promise<void> {
    if (configured !== undefined) configured.verifyTaskHistory?.(taskId);
    else if (existsSync(join(repositoryRoot, "tasks/definitions"))) {
      const registry = await loadTaskRegistry({ repositoryRoot });
      assertLocalGateHistory(repositoryRoot, registry, taskId);
    }
  }
  if (operation === "import") {
    await verifyHistory(provider.readPacket(args[1]!).taskId);
    const imported = provider.importResult(args[1]!, readJson(input(args[2]!)));
    return {
      data: { packetId: args[1], resultPath: imported.resultPath, reused: imported.reused, status: imported.result.status },
      human: `${imported.reused ? "Reused" : "Imported"} manual result for ${args[1]} (${imported.result.status}).\nResult: ${imported.resultPath}\nThe waiting provider can now read it; import itself runs no lifecycle gate.`,
    };
  }
  const value = readJson(input(args[1]!));
  if (typeof value !== "object" || value === null || Array.isArray(value) || "signal" in value) {
    throw new AgentProviderError("INVALID_REQUEST", "Request file must contain an AgentRunRequest JSON object without a signal field; cancellation belongs to the running process.", false);
  }
  const request = value as AgentRunRequest;
  if (configured === undefined) await verifyHistory(request.taskId);
  else configured.verifyRequest(request);
  if (operation === "export") {
    const packet = provider.exportPacket(request);
    const packetPath = provider.packetPath(packet.packetId);
    const resultPath = provider.resultPath(packet.packetId);
    return {
      data: { packetId: packet.packetId, packetPath, resultPath },
      human: `Exported role packet: ${packetPath}\nPacket ID: ${packet.packetId}\nRead its instructions in a fresh ${packet.role} session. Import the structured result with ${configured === undefined ? "'agent manual import'" : "the configured host's manual import command"}.\nResult destination: ${resultPath}`,
    };
  }
  const result = await new AgentRunner({ provider }).run({ ...request, ...(signal === undefined ? {} : { signal }) });
  return {
    data: result,
    human: `Manual role run ${result.runId}: ${result.outcome}\nTask: ${result.taskId}\nRole: ${result.role}\nRevision: ${result.revisionIdentity}\nThis is a provider result; deterministic validation and review gates retain authority.`,
  };
}

function readJson(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("Input must be a regular file no larger than 4 MiB.");
    const text = readFileSync(fd, "utf8");
    if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES) throw new Error("Input exceeds the 4 MiB limit.");
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AgentProviderError("INVALID_REQUEST", `Cannot read JSON input '${path}': ${error instanceof Error ? error.message : String(error)}`, false);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
