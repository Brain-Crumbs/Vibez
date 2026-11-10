import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, deepFreeze } from "../local-agent-adapter/json.js";
import { assertSupportedSchema, schemaErrors } from "../local-agent-adapter/schema.js";
import { packageRoot, readPackageJson } from "../project-assets/index.js";

export const inputPaths = ["tasks", "requirements", "contracts", "contextPolicy"] as const;
export const writablePaths = ["state", "evidence", "exchange", "intake", "responses", "outbox", "operations"] as const;
type PathName = (typeof inputPaths)[number] | (typeof writablePaths)[number];

export interface ProjectConfigV1 {
  readonly schemaId: "vibez.project-config";
  readonly schemaVersion: "1.0.0";
  readonly project: { readonly id: string; readonly repository: string };
  readonly worktree: { readonly id: string };
  readonly paths: Readonly<Record<PathName, string>>;
  readonly validators: readonly { readonly id: string; readonly executorId: string; readonly required: true }[];
  readonly policy: {
    readonly integrationTarget: string;
    readonly remote: string;
    readonly requiredChecks: readonly string[];
    readonly reviewRoles: readonly ("QA" | "Architect" | "UAT/Product")[];
    readonly publication: "host-authorized";
    readonly merge: "exact-pr-head-host-authorized";
  };
  readonly providers: { readonly execution: string; readonly credentials: readonly string[] };
  readonly budgets: {
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
    readonly providerTimeoutMs: number;
    readonly operationTimeoutMs: number;
    readonly maxReworkCycles: number;
  };
}

export interface ProjectLocation {
  readonly projectRoot: string;
  readonly configPath: string;
  /** Windows hosts must attest the checkout is on local NTFS outside sync or redirected folders. */
  readonly verifyLocalStorage?: (root: string) => boolean;
}

export interface ResolvedProjectConfig {
  readonly document: ProjectConfigV1;
  readonly configPath: string;
  readonly configDigest: string;
  readonly projectRoot: string;
  readonly gitCommonDir: string;
  readonly projectIdentity: string;
  readonly worktreeIdentity: string;
  readonly revision: string;
  readonly paths: Readonly<Record<PathName, string>>;
  assertCurrent(revision?: string): void;
  assertStorage(): void;
  assertRevisionConfig(revision: string): void;
  assertBinding(executionBinding: string): void;
  bindStorage(executionBinding: string): void;
}

export class ConfigError extends Error {
  constructor(readonly code: "CONFIG_INVALID" | "INPUT_MISSING" | "IDENTITY_CONFLICT" | "UNSAFE_PATH" | "UNSUPPORTED_STORAGE" | "TOOL_UNAVAILABLE", message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseProjectConfig(input: unknown): ProjectConfigV1 {
  const value: unknown = JSON.parse(canonicalJson(input));
  const { document: schema } = readPackageJson("docs/specs/project-config.schema.json");
  assertSupportedSchema(schema);
  const errors = schemaErrors(value, schema);
  if (errors.length) throw new ConfigError("CONFIG_INVALID", errors.join("; "));
  const config = value as ProjectConfigV1;
  if (new Set(config.validators.map(validator => validator.id)).size !== config.validators.length) {
    throw new ConfigError("CONFIG_INVALID", "Duplicate validator IDs.");
  }
  for (const check of config.policy.requiredChecks) {
    if (!check.trim() || check !== check.trim()) throw new ConfigError("CONFIG_INVALID", "Required CI check names must be nonempty and trimmed.");
  }
  return deepFreeze(config);
}

function assertGitEnvironment(): void {
  const redirected = Object.keys(process.env).some(key =>
    /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_PARAMETERS)$/i.test(key));
  const configCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const safeConfig = Number.isInteger(configCount) && configCount >= 0 && configCount <= 128 &&
    Array.from({ length: configCount }, (_, index) => process.env[`GIT_CONFIG_KEY_${index}`])
      .every(key => key?.toLowerCase() === "safe.directory");
  if (redirected || !safeConfig) throw new ConfigError("IDENTITY_CONFLICT", "Clear Git environment overrides before running a configured project.");
}

export function projectGit(root: string, args: readonly string[]): string {
  assertGitEnvironment();
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
    return execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  } catch {
    throw new ConfigError("TOOL_UNAVAILABLE", `Git could not complete '${args[0]}'. Verify Git and the selected repository.`);
  }
}

function folded(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function inside(root: string, path: string): boolean {
  const child = relative(folded(root), folded(path));
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function portableSegments(path: string): string[] {
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." ||
    /[<>:"\\|?*\u0000-\u001f]/.test(segment) || /[ .]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment) ||
    [".git", "node_modules"].includes(segment.toLowerCase()))) {
    throw new ConfigError("UNSAFE_PATH", `Unsafe project-relative path '${path}'.`);
  }
  return segments;
}

/** Reject links at every existing component, including the leaf. */
export function checkedProjectPath(root: string, path: string, kind: "file" | "directory"): string {
  const segments = portableSegments(path);
  let target = root;
  for (const [index, segment] of segments.entries()) {
    target = join(target, segment);
    if ((kind === "directory" || index < segments.length - 1) && lstatExists(join(target, ".git"))) throw new ConfigError("UNSAFE_PATH", `Path '${path}' crosses a nested Git worktree.`);
    try {
      const stat = lstatSync(target);
      const correctType = index === segments.length - 1 && kind === "file" ? stat.isFile() : stat.isDirectory();
      if (stat.isSymbolicLink() || !correctType) throw new ConfigError("UNSAFE_PATH", `Unexpected file type or link at '${path}'.`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return target;
}

function verifyStorage(root: string, attestation: ProjectLocation["verifyLocalStorage"]): void {
  if (/^(?:\\\\|\/\/)/.test(root) || root.split(/[\\/]/).some(part => /^(?:OneDrive(?: - .*)?|Dropbox|iCloudDrive)$/i.test(part))) {
    throw new ConfigError("UNSUPPORTED_STORAGE", "Use a local checkout outside network shares and synchronized folders.");
  }
  if (process.platform === "win32") {
    if (attestation?.(root) !== true) throw new ConfigError("UNSUPPORTED_STORAGE", "The host must verify local NTFS storage outside synchronized folders.");
  } else if (process.platform !== "linux" || ![0xef53, 0x794c7630, 0x58465342, 0x9123683e].includes(statfsSync(root).type) || attestation?.(root) === false) {
    throw new ConfigError("UNSUPPORTED_STORAGE", "The checkout is not on supported local storage.");
  }
}

function readJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError("CONFIG_INVALID", `Invalid JSON in ${label}.`);
  }
}

function checkRepository(root: string, config: ProjectConfigV1): void {
  projectGit(root, ["check-ref-format", `refs/heads/${config.policy.integrationTarget}`]);
  for (const direction of [[], ["--push"]]) {
    const remotes = projectGit(root, ["remote", "get-url", ...direction, "--all", config.policy.remote]).trim().split(/\r?\n/);
    const repo = remotes[0]?.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)\/?$/i)?.[1];
    if (remotes.length !== 1 || repo?.replace(/\.git$/i, "").toLowerCase() !== config.project.repository.toLowerCase()) {
      throw new ConfigError("IDENTITY_CONFLICT", "Configured repository does not match the Git remote's read and write targets.");
    }
  }
}

function resolveDocumentPaths(projectRoot: string, configPath: string, config: ProjectConfigV1, gitCommonDir: string) {
  const paths = Object.freeze(Object.fromEntries([...inputPaths, ...writablePaths].map(name =>
    [name, checkedProjectPath(projectRoot, config.paths[name], name === "contextPolicy" ? "file" : "directory")])) as Record<PathName, string>);
  const runtimePackageRoot = realpathSync(packageRoot);
  const protectedPaths = [configPath, gitCommonDir, ...inputPaths.map(name => paths[name])];
  if (folded(runtimePackageRoot) === folded(projectRoot)) {
    protectedPaths.push(...["dist", "src", "schemas", "docs", "contracts"].map(path => join(projectRoot, path)));
  } else {
    protectedPaths.push(runtimePackageRoot);
  }
  for (const name of writablePaths) {
    const target = paths[name];
    if (protectedPaths.some(path => inside(path, target) || inside(target, path)) ||
      writablePaths.some(other => other !== name && (inside(paths[other], target) || inside(target, paths[other])))) {
      throw new ConfigError("UNSAFE_PATH", `Writable path '${name}' overlaps another project or package input.`);
    }
  }
  return paths;
}

function readTrackedConfig(root: string, revision: string, path: string): unknown {
  let text: string;
  try {
    text = projectGit(root, ["show", `${revision}:${path}`]);
  } catch (error) {
    if (error instanceof ConfigError && error.code === "TOOL_UNAVAILABLE") {
      throw new ConfigError("INPUT_MISSING", "Selected config is missing at the target Git revision.");
    }
    throw error;
  }
  return readJson(text, "tracked project config");
}

export function resolveProjectConfig(location: ProjectLocation): ResolvedProjectConfig {
  if (!isAbsolute(location.projectRoot)) throw new ConfigError("UNSAFE_PATH", "Select an absolute project root.");
  let projectRoot: string;
  try {
    projectRoot = realpathSync(location.projectRoot);
  } catch {
    throw new ConfigError("INPUT_MISSING", "Project root does not exist.");
  }
  verifyStorage(projectRoot, location.verifyLocalStorage);
  for (let parent = dirname(projectRoot); parent !== dirname(parent); parent = dirname(parent)) {
    if (lstatExists(join(parent, ".git"))) throw new ConfigError("UNSAFE_PATH", "Nested Git worktrees are unsupported.");
  }
  if (projectGit(projectRoot, ["rev-parse", "--show-prefix"]).trim() !== "") {
    throw new ConfigError("IDENTITY_CONFLICT", "Select the Git worktree root.");
  }
  const gitCommonDir = realpathSync(resolve(projectRoot, projectGit(projectRoot, ["rev-parse", "--git-common-dir"]).trim()));
  if (folded(gitCommonDir) !== folded(join(projectRoot, ".git")) || lstatSync(join(projectRoot, ".git")).isSymbolicLink()) {
    throw new ConfigError("IDENTITY_CONFLICT", "A dedicated checkout with its own physical Git directory is required.");
  }
  const revision = projectGit(projectRoot, ["rev-parse", "--verify", "HEAD"]).trim();
  const configPath = checkedProjectPath(projectRoot, location.configPath, "file");
  if (!lstatExists(configPath)) throw new ConfigError("INPUT_MISSING", "Selected config is missing. Initialize and commit it before use.");
  const config = parseProjectConfig(readTrackedConfig(projectRoot, revision, location.configPath));
  const configDigest = digest(config);
  const projectIdentity = digest([config.project.repository.toLowerCase(), config.project.id, folded(gitCommonDir)]);
  const worktreeIdentity = digest([projectIdentity, config.worktree.id, folded(projectRoot)]);
  const paths = resolveDocumentPaths(projectRoot, configPath, config, gitCommonDir);
  const identityFile = join(gitCommonDir, "vibez-project.json");
  const binding = (executionBinding: string) => canonicalJson({ executionBinding, worktreeIdentity, writablePaths: writablePaths.map(name => folded(paths[name])) });

  function assertStorage(): void {
    if (folded(realpathSync(projectRoot)) !== folded(projectRoot) ||
      folded(realpathSync(resolve(projectRoot, projectGit(projectRoot, ["rev-parse", "--git-common-dir"]).trim()))) !== folded(gitCommonDir) ||
      projectGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter(part => part.startsWith("worktree ")).length !== 1) {
      throw new ConfigError("IDENTITY_CONFLICT", "Use the original dedicated worktree and Git directory.");
    }
    for (const name of writablePaths) {
      const path = checkedProjectPath(projectRoot, config.paths[name], "directory");
      let ancestor = path;
      while (!lstatExists(ancestor)) ancestor = dirname(ancestor);
      verifyStorage(ancestor, location.verifyLocalStorage);
    }
    if (process.platform === "linux") {
      const mounted = readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean).map(row =>
        row.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
      if (mounted.some(path => path !== undefined && path !== projectRoot && inside(projectRoot, path) &&
        writablePaths.some(name => inside(paths[name], path) || inside(path, paths[name])))) {
        throw new ConfigError("UNSUPPORTED_STORAGE", "Configured runtime paths cannot cross nested mounts.");
      }
    }
  }

  function assertRevisionConfig(expected: string): void {
    const gitConfig = readTrackedConfig(projectRoot, expected, location.configPath);
    checkedProjectPath(projectRoot, location.configPath, "file");
    if (digest(gitConfig) !== configDigest || digest(readJson(readFileSync(configPath, "utf8"), "working project config")) !== configDigest) {
      throw new ConfigError("IDENTITY_CONFLICT", "Project configuration changed. Reload the graph after quiescing the original workflow.");
    }
  }

  function assertCurrent(expected = projectGit(projectRoot, ["rev-parse", "--verify", "HEAD"]).trim()): void {
    assertStorage();
    if (projectGit(projectRoot, ["rev-parse", "--verify", "HEAD"]).trim() !== expected) {
      throw new ConfigError("IDENTITY_CONFLICT", "Selected project revision changed.");
    }
    checkRepository(projectRoot, config);
    assertRevisionConfig(expected);
    for (const name of inputPaths) checkedProjectPath(projectRoot, config.paths[name], name === "contextPolicy" ? "file" : "directory");
  }

  function assertBinding(executionBinding: string): void {
    if (lstatExists(identityFile) && (!lstatSync(identityFile).isFile() || readFileSync(identityFile, "utf8") !== binding(executionBinding))) {
      throw new ConfigError("IDENTITY_CONFLICT", "The repository is bound to another project, worktree, or writable layout.");
    }
  }

  assertCurrent(revision);
  for (const name of inputPaths) {
    if (!lstatExists(paths[name])) throw new ConfigError("INPUT_MISSING", `Configured ${name} input is missing.`);
  }
  return Object.freeze({ document: config, configPath, configDigest, projectRoot, gitCommonDir, projectIdentity, worktreeIdentity, revision, paths, assertCurrent, assertStorage, assertRevisionConfig,
    assertBinding,
    bindStorage(executionBinding: string): void {
      assertCurrent();
      assertBinding(executionBinding);
      try {
        writeFileSync(identityFile, binding(executionBinding), { flag: "wx", encoding: "utf8" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        assertBinding(executionBinding);
      }
    },
  });
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function previewProjectInit(projectRoot: string, configPath: string, value: unknown) {
  if (!isAbsolute(projectRoot)) throw new ConfigError("UNSAFE_PATH", "Select an absolute project root.");
  const root = realpathSync(projectRoot);
  if (projectGit(root, ["rev-parse", "--show-prefix"]).trim() !== "") {
    throw new ConfigError("IDENTITY_CONFLICT", "Select the Git worktree root for setup.");
  }
  const path = checkedProjectPath(root, configPath, "file");
  if (inside(realpathSync(packageRoot), path)) throw new ConfigError("UNSAFE_PATH", "Config initialization cannot modify the Vibez package.");
  const document = parseProjectConfig(value);
  resolveDocumentPaths(root, path, document, join(root, ".git"));
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (!lstatExists(dirname(path)) || !lstatSync(dirname(path)).isDirectory()) throw new ConfigError("INPUT_MISSING", "Create the config parent directory first.");
  return Object.freeze({ path, content, exists: lstatExists(path) });
}

export function initializeProjectConfig(projectRoot: string, configPath: string, value: unknown): string {
  const preview = previewProjectInit(projectRoot, configPath, value);
  if (preview.exists) throw new ConfigError("IDENTITY_CONFLICT", "Configuration already exists. Review it without overwriting.");
  writeFileSync(preview.path, preview.content, { flag: "wx", encoding: "utf8" });
  return preview.path;
}
