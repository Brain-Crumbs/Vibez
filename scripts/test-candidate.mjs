import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir, version } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(process.argv.length === 3 && npm, "Usage: npm run test:conformance -- <candidate-directory>");
const candidate = realpathSync(resolve(process.argv[2]));
const receipt = JSON.parse(readFileSync(join(candidate, "candidate.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

assert.equal(receipt.sourceCommit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
assert.equal(receipt.package, manifest.name);
assert.equal(receipt.version, manifest.version);
assert.equal(receipt.file, `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`);
const archive = join(candidate, receipt.file);
const bytes = readFileSync(archive);
assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.sha256);
assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), receipt.integrity);

const paths = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
assert.ok(paths.every(path => path.startsWith("package/")));
const assets = [
  ...readdirSync(join(root, "schemas/v1")).map(name => "schemas/v1/" + name),
  ...readdirSync(join(root, "contracts"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "examples")
    .map(entry => "contracts/" + entry.name + "/module-contract.json"),
  "docs/specs/project-config.schema.json", "examples/alpha/vibez.config.json", "examples/beta/vibez.config.json",
];
const staging = mkdtempSync(join(tmpdir(), "vibez offline conformance "));
try {
  const fromSource = relative(realpathSync(root), realpathSync(staging));
  assert.ok(fromSource.startsWith("..") || isAbsolute(fromSource), "Staging must be outside the source checkout.");
  mkdirSync(join(staging, "tests", "helpers"), { recursive: true });
  for (const path of ["packed-package.test.mjs", "helpers/driver-fixture.mjs", "helpers/packed-consumer.mjs"]) {
    cpSync(join(root, "tests", path), join(staging, "tests", path));
  }
  cpSync(join(root, "node_modules", "typescript"), join(staging, "compiler"), { recursive: true });
  const packaged = join(staging, receipt.file);
  cpSync(archive, packaged);
  writeFileSync(join(staging, "inputs.json"), JSON.stringify({
    receipt, manifest, archive: packaged, packagePaths: paths.map(path => path.slice("package/".length)),
    assets, tsc: join(staging, "compiler", "bin", "tsc"),
  }));
  const gitConfig = join(staging, "gitconfig");
  const npmConfig = join(staging, "npmrc");
  writeFileSync(gitConfig, "");
  const npmGlobalConfig = join(staging, "npmrc-global");
  writeFileSync(npmConfig, "");
  writeFileSync(npmGlobalConfig, "");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|NPM_CONFIG_|NODE_PATH$|NODE_OPTIONS$|GH_TOKEN$|GITHUB_TOKEN$|NODE_AUTH_TOKEN$|VIBEZ_DRIVER_TEST_)/i.test(key)) delete env[key];
  }
  Object.assign(env, { VIBEZ_CONFORMANCE_INPUTS: "inputs.json", npm_execpath: npm, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: "0", NPM_CONFIG_USERCONFIG: npmConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig });
  execFileSync(process.execPath, ["--test", "tests/packed-package.test.mjs"],
    { cwd: staging, stdio: "inherit", env, timeout: 15 * 60 * 1000 });
  console.log(JSON.stringify({ revision: receipt.sourceCommit, version: receipt.version,
    sha256: receipt.sha256, node: process.version, platform: process.platform, osVersion: version(),
    osRelease: release(), arch: process.arch }));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
