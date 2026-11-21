import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { createProjectServices, npmValidatorCommands } from "../project-services/index.js";
import { GitHubControlledMergePullRequestOperations } from "../controlled-merge/index.js";
import { GitHubCiStatusOperations, GitHubMergeReadinessPullRequestOperations } from "../merge-readiness/index.js";
import { GitHubPullRequestOperations } from "../pr-lifecycle/index.js";
import { resolveProjectConfig } from "../project-config/index.js";
import { loadSession, reconcileRegistration } from "../workflow-driver/intake.js";
import { ManualConsoleCommands } from "../manual-console/commands.js";
import { ManualConsoleReader } from "../manual-console/reader.js";
import { serveManualConsole } from "../manual-console/server.js";
import { step } from "../workflow-driver/driver.js";
import type { DriverSession } from "../workflow-driver/model.js";
import { driverDirectory, DriverError, hash, redact, requireValue, safePath } from "../workflow-driver/io.js";

interface ConsoleStep {
  kind: "manual-console-step";
  args: readonly string[];
  sessionId: string;
  profileHash: string;
  writerHash: string;
}

type StepResult = Pick<DriverSession, "pendingPacket" | "diagnosticId">;

function writerHash(root: string, directory: string) {
  return hash(readFileSync(safePath(root, directory + "/writer.lock"), "utf8"));
}

function runConsoleStep(work: ConsoleStep): Promise<StepResult> {
  return new Promise((resolveStep, reject) => {
    // Native validators run synchronously inside this worker. The listener
    // retains the writer lock while its own event loop serves scoped reads.
    const worker = new Worker(new URL(import.meta.url), { workerData: work });
    let result: StepResult | undefined;
    worker.once("message", value => { result = value as StepResult; });
    worker.on("error", () => { result = undefined; });
    worker.once("exit", code => {
      if (code === 0 && result) resolveStep(result);
      else reject(new DriverError("DRIVER_ERROR", "The console worker stopped before confirming the native operation."));
    });
  });
}

if (!isMainThread && workerData?.kind === "manual-console-step") {
  const work: ConsoleStep = workerData;
  void runConfiguredDriver(work.args, new AbortController().signal, () => {}, work).catch(() => {
    process.exitCode = 1;
  });
}

/** Standalone npm host. Custom executor/provider policies continue to use ProjectHost. */
export async function runStandaloneCli(argv: readonly string[], signal: AbortSignal, progress: (message: string) => void) {
  const command = argv.find(arg => arg !== "--json") === "manual-console" ? "manual-console" : "orchestrate";
  try {
    return await runConfiguredDriver(argv, signal, progress);
  } catch (cause) {
    const code = command === "manual-console" ? "MANUAL_CONSOLE_ERROR" :
      cause instanceof DriverError ? "ORCHESTRATE_ERROR" : "PROJECT_CONFIGURATION_REQUIRED";
    const message = redact(cause instanceof Error ? cause.message : "Unable to open the configured project.");
    const exitCode = cause instanceof DriverError && cause.code === "INVALID_INPUT" ? 2 as const : 4 as const;
    if (argv.includes("--json")) {
      return { exitCode, stdout: JSON.stringify({
        schemaVersion: "1.0.0", command, ok: false, data: null, error: { code, message },
      }) + "\n", stderr: "" };
    }
    return { exitCode, stdout: "", stderr: `${code}: ${message}\n` };
  }
}

async function runConfiguredDriver(argv: readonly string[], signal: AbortSignal, progress: (message: string) => void, work?: ConsoleStep) {
  const scoped = argv.filter(arg => arg !== "--json");
  const consoleHost = scoped[0] === "manual-console";
  const consoleUsage = "vibez manual-console --project CHECKOUT --origin http://127.0.0.1:5173 [--port PORT] [--commands]";
  if (consoleHost && scoped.length === 2 && ["help", "--help", "-h"].includes(scoped[1]!))
    return { exitCode: 0 as const, stdout: consoleUsage + "\n", stderr: "" };
  if (!consoleHost && (scoped[0] !== "orchestrate" || scoped.length === 1 || ["help", "--help", "-h"].includes(scoped[1]!))) return null;

  const args = [...argv];
  function take(flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    requireValue(value && !value.startsWith("--") && args.lastIndexOf(flag) === index, `Specify one value for ${flag}.`);
    args.splice(index, 2);
    return value;
  }
  const project = take("--project");
  const selectedConfig = take("--config");
  const npmCli = take("--npm-cli");
  const consoleOrigin = consoleHost ? take("--origin") : undefined;
  const consolePort = consoleHost ? take("--port") ?? "0" : "0";
  const projectRoot = resolve(project ?? process.cwd());
  const configPath = selectedConfig ?? "vibez.config.json";
  if (!consoleHost && !project && !selectedConfig && !existsSync(join(projectRoot, configPath))) return null;

  const consoleCommands = consoleHost && args.includes("--commands");
  if (consoleCommands) args.splice(args.indexOf("--commands"), 1);
  const ntfs = args.includes("--local-ntfs");
  if (ntfs) args.splice(args.indexOf("--local-ntfs"), 1);
  if (consoleHost) requireValue(args.length === 1 && project && consoleOrigin &&
    /^(0|[1-9][0-9]{0,4})$/.test(consolePort) && Number(consolePort) <= 65535, consoleUsage);
  const location = {
    projectRoot, configPath,
    ...(ntfs ? { verifyLocalStorage: () => true } : {}),
  };
  const config = resolveProjectConfig(location);
  const { document } = config;
  if (scoped[1] === "prepare" || scoped[1] === "watch") await reconcileRegistration(config);
  const repository = document.project.repository;
  const [owner, repo] = repository.split("/") as [string, string];
  const token = process.env.IPT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const mergeAuthorization = process.env.IPT_DRIVER_MERGE;
  const options = { owner, repo, token: token ?? "credentials-required" };
  const credentialed = typeof token === "string" && token.length > 0;
  const fetchImpl: typeof globalThis.fetch = (url, init) => {
    if (!credentialed) throw new DriverError("CREDENTIALS_REQUIRED", "Supply host GitHub credentials to query or update pull requests.");
    return globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(30000), redirect: "error" });
  };
  const publication = new GitHubPullRequestOperations({ ...options, fetchImpl: (url, init) => {
    const body = init.method === "POST" && url.endsWith("/pulls") ? JSON.stringify({ ...JSON.parse(init.body ?? "{}"), draft: true }) : init.body;
    return fetchImpl(url, { ...init, ...(body === undefined ? {} : { body }) });
  } });
  const installedNpm = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const executors = npmValidatorCommands(resolve(npmCli ?? process.env.npm_execpath ?? installedNpm));
  const services = await createProjectServices(location, {
    identity: "vibez-standalone-manual-npm@1",
    executors,
    hasCredentialReference: id => id === "github-main" && credentialed,
    integration: {
      repository, publication,
      pullRequests: new GitHubMergeReadinessPullRequestOperations({ ...options, fetchImpl }),
      ci: new GitHubCiStatusOperations({ ...options, fetchImpl }),
      merge: new GitHubControlledMergePullRequestOperations({ ...options, fetchImpl }),
    },
    authorizePublication: request => credentialed && request.repository === repository && (scoped[1] === "publish" || scoped[1] === "ready"),
    authorizeMerge: request => !consoleHost && credentialed && mergeAuthorization === `${request.repository}#${request.number}@${request.expectedHeadSha}`,
    authorizeRecovery: request => !consoleHost && (process.env.IPT_RECOVERY_ADMIN_ACTORS ?? "").split(",").includes(request.actorId),
  });
  if (consoleHost) {
    const reader = new ManualConsoleReader(services.config, consoleCommands);
    const runtime = { services: services.driverForCurrentRevision, ...(token ? { token } : {}) };
    if (work) {
      const profile = reader.checkScope();
      requireValue(consoleCommands && hash(profile) === work.profileHash &&
        writerHash(projectRoot, driverDirectory(profile)) === work.writerHash,
        "Console work requires the original profile and native writer.");
      const session = loadSession(projectRoot, profile, work.sessionId);
      const { pendingPacket, diagnosticId } = await step(projectRoot, profile, session, { ...runtime, manualConsole: true });
      parentPort?.postMessage({ pendingPacket, diagnosticId });
      return null;
    }
    const commands = consoleCommands ? new ManualConsoleCommands(projectRoot, reader, runtime, (profile, session) =>
      runConsoleStep({ kind: "manual-console-step", args: argv, sessionId: session.sessionId, profileHash: hash(profile),
        writerHash: writerHash(projectRoot, driverDirectory(profile)) })) : undefined;
    await serveManualConsole(reader, consoleOrigin!, Number(consolePort), signal, progress, commands);
    return { exitCode: 0 as const, stdout: "", stderr: "" };
  }
  return services.cli(args, signal, {
    progress, ...(token ? { token } : {}), ...(mergeAuthorization ? { mergeAuthorization } : {}),
  });
}
