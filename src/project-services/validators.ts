import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { DeveloperValidatorResolver } from "../dev-validation/index.js";
import type { ValidatorSpec } from "../validation-framework/index.js";
import { checkedProjectPath, ConfigError, type ResolvedProjectConfig } from "../project-config/index.js";

type CommandValidator = Extract<ValidatorSpec, { kind: "command" }>;
export interface ProjectValidatorCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly category: CommandValidator["category"];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export function configuredValidators(config: ResolvedProjectConfig,
  executors: ReadonlyMap<string, ProjectValidatorCommand>): DeveloperValidatorResolver {
  function resolve() {
    return config.document.validators.map(({ id, executorId }) => {
      const executable = executors.get(executorId);
      if (executable === undefined) throw new ConfigError("TOOL_UNAVAILABLE", `Host validator executor '${executorId}' is missing.`);
      if (!isAbsolute(executable.command) || (process.platform === "win32" && !/\.exe$/i.test(executable.command))) {
        throw new ConfigError("TOOL_UNAVAILABLE", `Executor '${executorId}' must identify an absolute native executable.`);
      }
      try {
        accessSync(executable.command, constants.X_OK);
      } catch {
        throw new ConfigError("TOOL_UNAVAILABLE", `Executable for validator '${id}' is unavailable.`);
      }
      const cwd = executable.cwd === undefined ? config.projectRoot : checkedProjectPath(config.projectRoot, executable.cwd, "directory");
      try {
        accessSync(cwd);
      } catch {
        throw new ConfigError("INPUT_MISSING", `Working directory for validator '${id}' is missing.`);
      }
      return Object.freeze({ validatorId: id, kind: "command" as const, category: executable.category, command: executable.command,
        args: Object.freeze([...executable.args]), cwd, required: true,
        ...(executable.timeoutMs === undefined ? {} : { timeoutMs: executable.timeoutMs }) });
    });
  }
  resolve();
  return { resolve };
}

/** Explicit npm profile. The host supplies the actual npm JS entry point. */
export function npmValidatorCommands(npmCli: string): ReadonlyMap<string, ProjectValidatorCommand> {
  if (!isAbsolute(npmCli)) throw new ConfigError("TOOL_UNAVAILABLE", "Supply an absolute npm CLI path.");
  try {
    accessSync(npmCli);
  } catch {
    throw new ConfigError("TOOL_UNAVAILABLE", "The npm CLI entry point is unavailable.");
  }
  return new Map<string, ProjectValidatorCommand>([
    ["node-build", { command: process.execPath, args: [npmCli, "run", "build"], category: "type-check" }],
    ["node-test", { command: process.execPath, args: [npmCli, "test"], category: "test", timeoutMs: 900000 }],
  ]);
}
