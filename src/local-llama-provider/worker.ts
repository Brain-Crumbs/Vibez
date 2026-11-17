import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, createReadStream, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { object } from "../history/provenance.js";
import { invalid } from "./protocol.js";

export interface LocalLlamaAssets {
  /** Trusted Bubblewrap binary and unpacked, operator-verified Ubuntu llama.cpp distribution. */
  readonly launcherPath: string;
  readonly launcherSha256: string;
  readonly runtimeDirectory: string;
  readonly runnerSha256: string;
  readonly dependencyDirectory: string;
  readonly libraries: readonly {
    readonly directory: "runtime" | "dependencies";
    readonly filename: string;
    readonly sha256: string;
  }[];
  readonly modelPath: string;
  readonly modelSha256: string;
  readonly runtimeVersion: string;
  readonly model: string;
}

async function verifyFile(path: string, expectedSha256: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("Expected an unlinked local inference file.");
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  if (hash.digest("hex") !== expectedSha256) throw invalid("An inference asset does not match its approved digest.");
}

function libraryPaths(assets: LocalLlamaAssets) {
  const targets = new Set<string>();
  if (!Array.isArray(assets.libraries) || assets.libraries.length > 64) throw invalid("Invalid local library manifest.");
  return assets.libraries.map(item => {
    if (!["runtime", "dependencies"].includes(item.directory) ||
        !/^lib[A-Za-z0-9_.+-]+[.]so(?:[.][0-9]+)*$/.test(item.filename)) {
      throw invalid("A library manifest entry is outside the supported profile.");
    }
    const parent = item.directory === "runtime" ? assets.runtimeDirectory : assets.dependencyDirectory;
    const source = realpathSync(join(parent, item.filename));
    const target = "/runtime/" + item.filename;
    if (!source.startsWith(parent + "/") || targets.has(target)) throw invalid("A library overlaps or escapes its pinned directory.");
    targets.add(target);
    return { source, target, sha256: item.sha256 };
  });
}

/** Only an operator-approved fixed toolchain is mounted. No worktree, home or credential path is mounted. */
export async function verifyAssets(assets: LocalLlamaAssets) {
  if (process.platform !== "linux" || ![assets.launcherPath, assets.runtimeDirectory,
    assets.dependencyDirectory, assets.modelPath].every(path => isAbsolute(path) && realpathSync(path) === path) ||
    ![assets.runtimeVersion, assets.model].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(value))) {
    throw invalid("Local inference requires canonical paths and a pinned Linux toolchain.");
  }
  await Promise.all([
    verifyFile(assets.launcherPath, assets.launcherSha256),
    verifyFile(join(assets.runtimeDirectory, "llama-completion"), assets.runnerSha256),
    verifyFile(assets.modelPath, assets.modelSha256),
    ...libraryPaths(assets).map(library => verifyFile(library.source, library.sha256)),
  ]);
}

export interface LlamaProcessResult {
  readonly stopped: boolean;
  readonly output: string | null;
}

function processAlive(pid: number) {
  try {
    // The launcher reports the host PID. A reused PID also counts as ambiguous.
    lstatSync("/proc/" + String(pid));
    return true;
  } catch (error: unknown) {
    return !object(error) || error.code !== "ENOENT";
  }
}

export async function runIsolatedLlama(assets: LocalLlamaAssets, cwd: string, prompt: string, schema: unknown,
  contextTokens: number, outputTokens: number, signal: AbortSignal): Promise<LlamaProcessResult> {
  if (signal.aborted) return { stopped: true, output: null };
  // Node's child input is a socket. llama-completion's file reader needs a
  // regular file, so mount only this transient, private prompt.
  const inputDirectory = mkdtempSync(join(cwd, "input-"));
  const input = join(inputDirectory, "prompt");
  try {
    const fd = openSync(input, "wx", 0o600);
    try { writeFileSync(fd, prompt, { encoding: "utf8" }); } finally { closeSync(fd); }
    return await runProcess(assets, cwd, input, schema, contextTokens, outputTokens, signal);
  } finally {
    try { unlinkSync(input); } finally { rmdirSync(inputDirectory); }
  }
}

function runProcess(assets: LocalLlamaAssets, cwd: string, input: string, schema: unknown,
  contextTokens: number, outputTokens: number, signal: AbortSignal): Promise<LlamaProcessResult> {
  const args = [
    "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--info-fd", "3",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/runtime", "--ro-bind", join(assets.runtimeDirectory, "llama-completion"), "/runtime/llama-completion",
    ...libraryPaths(assets).flatMap(library => ["--ro-bind", library.source, library.target]),
    "--ro-bind", assets.modelPath, "/model.gguf", "--ro-bind", input, "/prompt",
    "--chdir", "/tmp", "--setenv", "HOME", "/tmp",
    "--setenv", "LD_LIBRARY_PATH", "/runtime",
    "/runtime/llama-completion", "--model", "/model.gguf", "--offline", "--no-display-prompt",
    "--no-conversation", "--no-context-shift", "--no-warmup", "--no-perf", "--simple-io", "--file", "/prompt",
    "--ctx-size", String(contextTokens), "--n-predict", String(outputTokens), "--threads", "6",
    "--temp", "0", "--n-gpu-layers", "0", "--json-schema", JSON.stringify(schema),
  ];
  return new Promise(resolve => {
    const child = spawn(assets.launcherPath, args, { cwd, env: { LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "ignore", "pipe"] });
    const decoder = new TextDecoder();
    let info = "", output = "", failed = false;
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGKILL");
      stopDeadline ??= setTimeout(() => resolve({ stopped: false, output: null }), 1000);
    };
    child.once("error", () => { failed = true; });
    child.stdout.on("data", bytes => {
      if (failed || signal.aborted) return;
      output += decoder.decode(bytes, { stream: true });
      if (output.length > 128 * 1024) {
        failed = true;
        abort();
      }
    });
    child.stdio[3]?.on("data", bytes => {
      if (failed) return;
      info += new TextDecoder().decode(bytes);
      if (info.length > 1024) { failed = true; abort(); }
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(stopDeadline);
      let childPid: unknown;
      try { childPid = (JSON.parse(info) as { "child-pid": unknown })["child-pid"]; } catch { /* No launch acknowledgement. */ }
      const stopped = child.pid === undefined ||
        (typeof childPid === "number" && Number.isSafeInteger(childPid) && childPid > 0 && !processAlive(childPid));
      resolve({ stopped, output: stopped && !failed && !signal.aborted && code === 0 ? output + decoder.decode() : null });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
