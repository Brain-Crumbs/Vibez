import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tsc = join(root, "node_modules/typescript/bin/tsc");
const npm = process.env.npm_execpath;
const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const publicApi = {
  "": "createProjectServices",
  "/config": "resolveProjectConfig",
  "/assets": "getAssetCatalog",
  "/registry": "selectNextEligibleTask",
  "/lifecycle": "createLifecycleRecord",
  "/context": "compileRoleContext",
  "/validation": "ValidationExecutor",
  "/evidence": "FileEvidenceStore",
  "/review": "QaReviewGate",
  "/workflow": "SequentialOrchestrationEngine",
  "/providers": "AgentRunner",
  "/integration": "ControlledMergeController",
  "/diagnostics": "ProjectStatusReporter",
  "/cli": "runCli",
};

function invokeAlias(directory, alias, args, cwd) {
  if (process.platform !== "win32") {
    return spawnSync(join(directory, alias), args, { cwd, encoding: "utf8" });
  }
  // All command arguments here are fixed fixture strings. Put the directory on
  // PATH so cmd can resolve npm's .cmd shim even if the prefix contains spaces.
  return spawnSync(process.env.ComSpec, ["/d", "/c", alias + ".cmd", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: directory + delimiter + process.env.PATH },
  });
}

test("actual npm tarball serves independent JS, TypeScript and standalone CLI consumers", t => {
  assert.ok(npm, "Run via npm test or npm run test:package.");
  const temp = mkdtempSync(join(tmpdir(), "vibez pack "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runNpm = (args, cwd) => run(process.execPath, [npm, "--cache", join(temp, "npm-cache"), ...args], cwd);
  const [pack] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], root));
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  const archive = join(temp, pack.filename);
  assert.equal(pack.integrity, "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64"));

  const paths = new Set(pack.files.map(file => file.path));
  const assets = [
    ...readdirSync(join(root, "schemas/v1")).map(name => "schemas/v1/" + name),
    ...readdirSync(join(root, "contracts"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== "examples")
      .map(entry => "contracts/" + entry.name + "/module-contract.json"),
    "docs/specs/project-config.schema.json", "examples/alpha/vibez.config.json", "examples/beta/vibez.config.json",
  ];
  const included = new Set([...assets, "package.json", "NOTICE.md", "README.md", "docs/INSTALL.md", "docs/PUBLIC_API.md",
    "docs/CLI.md", "docs/COMPATIBILITY.md", "docs/CONFIGURED_RUNTIME.md", "docs/SUPPORT.md"]);
  for (const path of included) assert.ok(paths.has(path), path);
  for (const path of paths) assert.ok(included.has(path) || /^dist\/.+\.(js|d\.ts)$/.test(path), "Unexpected packaged file " + path);
  assert.deepEqual(Object.keys(manifest.exports), Object.keys(publicApi).map(path => "." + path));
  for (const { import: entry } of Object.values(manifest.exports)) {
    assert.ok(paths.has(entry.types.slice(2)));
    assert.ok(paths.has(entry.default.slice(2)));
  }

  const project = join(temp, "consumer");
  const unrelated = join(temp, "other working directory");
  mkdirSync(project);
  mkdirSync(unrelated);
  writeFileSync(join(project, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(join(project, "sentinel.txt"), "unchanged\n");
  runNpm(["install", "--offline", "--no-audit", "--no-fund", "--save-exact", archive], project);
  assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package-lock.json", "package.json", "sentinel.txt"]);
  assert.equal(readFileSync(join(project, "sentinel.txt"), "utf8"), "unchanged\n");
  const installed = join(project, "node_modules", manifest.name);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(installedManifest.dependencies ?? {}, {});
  assert.ok(!existsSync(join(project, "node_modules/typescript")));
  for (const event of ["preinstall", "install", "postinstall"]) assert.equal(installedManifest.scripts?.[event], undefined);
  assert.equal(JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"))
    .packages["node_modules/" + manifest.name].integrity, pack.integrity);

  const imports = Object.entries(publicApi).map(([path, name]) =>
    'import { ' + name + ' } from "' + manifest.name + path + '";').join("\n");
  const useValues = "if (![" + Object.values(publicApi).join(", ") + "].every(value => typeof value === \"function\")) throw new Error(\"Invalid API export\");\n";
  const consumer = join(project, "consumer.ts");
  writeFileSync(consumer, imports + "\n" +
    'import type { ProjectHost } from "' + manifest.name + '";\n' +
    'import type { ProjectConfigV1 } from "' + manifest.name + '/config";\n' +
    'import type { AgentProvider, LocalAgentPacket } from "' + manifest.name + '/providers";\n' +
    'import type { MergeReadinessCiPort } from "' + manifest.name + '/integration";\n' +
    'export type Ports = [ProjectHost, ProjectConfigV1, AgentProvider, LocalAgentPacket, MergeReadinessCiPort];\n' +
    useValues);
  run(process.execPath, [tsc, "--strict", "--target", "ES2022", "--module", "NodeNext", consumer], unrelated);

  const module = join(project, "consumer.mjs");
  run(process.execPath, [join(project, "consumer.js")], unrelated);
  writeFileSync(module, readFileSync(join(root, "tests/helpers/packed-consumer.mjs"), "utf8"));
  run(process.execPath, [module, pack.version], unrelated);

  const localBin = join(project, "node_modules", ".bin");
  for (const alias of ["agent", "vibez"]) {
    const help = invokeAlias(localBin, alias, ["--help"], unrelated);
    assert.equal(help.status, 0, help.error?.message || help.stderr);
    assert.match(help.stdout, /Usage:/);
    const version = invokeAlias(localBin, alias, ["--json", "--version"], unrelated);
    assert.equal(version.status, 0, version.error?.message || version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), { schemaVersion: "1.0.0", ok: true, command: "version",
      data: { cliVersion: pack.version, outputSchemaVersion: "1.0.0" }, error: null });
    const reserved = invokeAlias(localBin, alias, ["--json", "orchestrate"], unrelated);
    assert.equal(reserved.status, 3, reserved.error?.message || reserved.stderr);
    assert.equal(JSON.parse(reserved.stdout).error.code, "COMMAND_NOT_IMPLEMENTED");
  }

  const prefix = join(temp, "global prefix");
  runNpm(["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", archive], unrelated);
  const global = invokeAlias(process.platform === "win32" ? prefix : join(prefix, "bin"), "vibez", ["--json", "--version"], unrelated);
  assert.equal(global.status, 0, global.error?.message || global.stderr);
  assert.equal(JSON.parse(global.stdout).data.cliVersion, pack.version);
  assert.deepEqual(readdirSync(unrelated), []);
});
