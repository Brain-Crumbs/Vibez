import type { AgentProvider, AgentRunRequest } from "../agent-provider/index.js";
import type { CommandValidatorSpec, ValidatorOutcome } from "../validation-framework/index.js";
import { digest } from "../project-config/index.js";
import { type ScopedCapabilities, type ScopedHostPolicy, type HostGrant } from "./index.js";

/**
 * Implementations are privileged host code. They enforce the supplied limits
 * in an external worker isolation boundary and return only after drain.
 */
export interface ScopedWorkerRuntime {
  readonly provider: Pick<AgentProvider, "providerId" | "capabilities">;
  runAgent(request: AgentRunRequest, capability: ScopedCapabilities & {
    readonly maxTurns: number; readonly maxCostMicros: number;
  }): ReturnType<AgentProvider["run"]>;
  runValidator(command: CommandValidatorSpec, capability: ScopedCapabilities): Promise<ValidatorOutcome>;
}

export interface ScopedAgentLimits {
  readonly maxTurns: number;
  readonly maxCostMicros: number;
}

export function scopedAgentProvider(policy: ScopedHostPolicy, runtime: ScopedWorkerRuntime, limits: ScopedAgentLimits): AgentProvider {
  return {
    providerId: runtime.provider.providerId,
    capabilities: runtime.provider.capabilities.bind(runtime.provider),
    async run(request) {
      const timeoutMs = request.timeoutMs ?? 0;
      return policy.execute({ action: "agent", taskId: request.taskId, revision: request.revisionIdentity,
        role: request.role as HostGrant["roles"][number]["role"], principal: request.actorId, timeoutMs,
        provider: runtime.provider.providerId, tools: request.toolPermissionPolicy.allowedTools,
        network: request.toolPermissionPolicy.networkAccess, ...limits }, capability => {
        const signal = request.signal ? AbortSignal.any([request.signal, capability.signal]) : capability.signal;
        signal.throwIfAborted();
        const tools = request.toolPermissionPolicy.allowedTools
          .filter(tool => !request.toolPermissionPolicy.deniedTools?.includes(tool));
        const role = capability.role!;
        const agentPolicy = Object.freeze({ ...role, tools: Object.freeze(tools),
          network: request.toolPermissionPolicy.networkAccess === "none" ? "none" as const : role.network });
        return runtime.runAgent({ ...request, signal }, { ...capability, role: agentPolicy, signal, ...limits });
      });
    },
  };
}

export function commandPolicyDigest(spec: CommandValidatorSpec): string {
  return digest({ command: spec.command, args: spec.args ?? [], cwd: spec.cwd ?? null });
}

export function scopedValidator(policy: ScopedHostPolicy, runtime: ScopedWorkerRuntime, spec: CommandValidatorSpec,
  taskId: string, revision: string) {
  const command = Object.freeze({ ...spec, args: Object.freeze([...(spec.args ?? [])]) });
  const commandDigest = commandPolicyDigest(command);
  return {
    kind: "function" as const,
    validatorId: command.validatorId,
    category: command.category,
    required: command.required,
    execute: () => policy.execute({ action: "validator", taskId, revision, validatorId: command.validatorId,
      commandDigest, timeoutMs: command.timeoutMs ?? 0 }, capability => runtime.runValidator(command, capability)),
  };
}
