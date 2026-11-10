import { createProjectServices, describeCapabilities, doctorProject } from "@brain-crumbs/vibez";
import { getAssetCatalog } from "@brain-crumbs/vibez/assets";
import { initializeProjectConfig, previewProjectInit } from "@brain-crumbs/vibez/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const info = describeCapabilities({ apiVersion: "1.0.0", packageVersion: process.argv[2] });
assert.equal(info.packageName, "@brain-crumbs/vibez");
assert.ok(info.commands.some(x => x.name === "orchestrate" && x.status === "reserved"));
assert.ok(getAssetCatalog().schemas.length >= 10);
assert.throws(() => describeCapabilities({ apiVersion: "2.0.0" }), /unsupported.*compatible Vibez/);
assert.throws(() => describeCapabilities({ packageVersion: "8.0.0" }), /Install the pinned Vibez tarball/);
await assert.rejects(import("@brain-crumbs/vibez/dist/cli/core.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
git("init", "-b", "main");
git("config", "user.name", "Fixture");
git("config", "user.email", "fixture@example.test");
git("remote", "add", "origin", "https://github.com/example/beta.git");
const config = JSON.parse(readFileSync(join(root, "node_modules", "@brain-crumbs/vibez", "examples/beta/vibez.config.json")));
config.providers.credentials = [];
const path = "vibez.config.json";
previewProjectInit(root, path, config);
assert.ok(!existsSync(join(root, path)));
initializeProjectConfig(root, path, config);
assert.throws(() => initializeProjectConfig(root, path, config), /already exists/i);
for (const key of ["tasks", "requirements", "contracts"]) {
  mkdirSync(join(root, config.paths[key]), { recursive: true });
  writeFileSync(join(root, config.paths[key], ".gitkeep"), "");
}
writeFileSync(join(root, config.paths.contextPolicy), "{}");
git("add", path, "planning");
git("commit", "-m", "Configure consumer");
const location = { projectRoot: root, configPath: path, verifyLocalStorage: () => true };
const unavailable = () => { throw new Error("Unexpected integration operation"); };
const host = { identity: "fixture@1", executors: new Map(), integration: { repository: "example/beta",
  publication: { findOpenPullRequests: unavailable, createPullRequest: unavailable, updatePullRequest: unavailable },
  pullRequests: { findPullRequestsByHead: unavailable }, ci: { listCheckRuns: unavailable },
  merge: { findPullRequestsByHead: unavailable, getPullRequest: unavailable, mergePullRequest: unavailable } } };
const missing = await doctorProject(location, host);
assert.equal(missing.code, "TOOL_UNAVAILABLE");
assert.match(missing.message, /executor .* is missing/);
host.executors.set("python-test", { command: process.execPath, args: ["-e", "process.exit(1)"], category: "test" });
const doctor = await doctorProject(location, host);
assert.equal(doctor.ok, true, doctor.message);
const graph = await createProjectServices(location, host);
const status = await graph.cli(["--json", "status"]);
assert.equal(status.exitCode, 0);
assert.equal(JSON.parse(status.stdout).data.progress.total, 0);
assert.ok(!existsSync(join(root, ".vibez")));
assert.ok(!existsSync(join(root, ".git/vibez-project.json")));

const schemaRoot = join(root, "node_modules", "@brain-crumbs/vibez", "schemas/v1");
renameSync(schemaRoot, schemaRoot + ".missing");
const damaged = await doctorProject(location, host);
assert.equal(damaged.ok, false);
assert.ok(damaged.message.includes("schemas/v1"));
assert.match(damaged.message, /Reinstall the complete package/);
assert.ok(!existsSync(join(root, ".vibez")));
