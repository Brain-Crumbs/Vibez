import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { git, get, markdown, put, response, sourceRoot } from "./helpers/driver-fixture.mjs";

const origin = "http://127.0.0.1:5173";
const base = "/manual-console/v1";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function snapshot(root) {
  const found = {};
  function walk(relative) {
    for (const item of readdirSync(join(root, relative), { withFileTypes: true })) {
      const file = join(relative, item.name);
      if (item.isDirectory()) walk(file);
      else found[file] = digest(readFileSync(join(root, file)));
    }
  }
  walk(".vibez");
  return { files: found, head: git(root, "rev-parse", "HEAD"), branch: git(root, "branch", "--show-current"),
    refs: git(root, "show-ref"), status: git(root, "status", "--porcelain") };
}

function install(t) {
  const nodeDir = dirname(process.execPath);
  const npm = process.env.npm_execpath ?? (process.platform === "win32" ?
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js") :
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  assert.ok(existsSync(npm), "Set npm_execpath to the installed npm CLI script.");
  const root = mkdtempSync(join(tmpdir(), "vibez console "));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  function call(cwd, file, args, input) {
    const run = spawnSync(process.execPath, [file, ...args], { cwd, input, encoding: "utf8", timeout: 90_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message);
    return run.stdout;
  }
  const tools = join(root, "tools");
  mkdirSync(tools);
  put(tools, "package.json", { private: true });
  const [{ filename }] = JSON.parse(call(sourceRoot, npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", root]));
  call(tools, npm, ["install", "--offline", "--no-audit", "--no-fund", join(root, filename)]);
  const installed = join(tools, "node_modules", "@brain-crumbs", "vibez");
  const entry = join(installed, "dist", "cli", "cli.js");

  const project = join(root, "consumer with spaces");
  mkdirSync(project);
  const config = get(installed, "examples/alpha/vibez.config.json");
  config.providers.credentials = [];
  config.project.repository = "fixture-owner/fixture-repo";
  put(project, "workflow.json", config);
  put(project, "work/tasks/.gitkeep", "");
  put(project, "work/contracts/.gitkeep", "");
  put(project, "work/policy.json", {});
  for (const taskId of ["DEMO-001", "DEMO-002", "DEMO-003"]) {
    put(project, `work/requirements/${taskId}.json`, { schemaId: "ipt.requirement", schemaVersion: "1.0.0",
      requirementId: `${taskId}-R1`, taskId, statement: "Deliver the marker.", acceptanceCriteria: ["Marker exists."], sourceRefs: ["fixture"] });
  }
  put(project, "package.json", { private: true, scripts: { build: "node --version", test: "node verify.mjs" } });
  put(project, "verify.mjs", "import { readFileSync } from 'node:fs'; process.exitCode = readFileSync('marker.txt', 'utf8') === 'correct' ? 0 : 1;");
  put(project, ".gitignore", ".vibez/\n");
  git(project, "init", "-b", "main");
  git(project, "config", "user.name", "Console fixture");
  git(project, "config", "user.email", "console@example.invalid");
  git(project, "remote", "add", "origin", "https://github.com/fixture-owner/fixture-repo.git");
  git(project, "add", ".");
  git(project, "commit", "-m", "Configure console fixture");
  const selection = ["--project", project, "--config", "workflow.json", "--npm-cli", npm,
    ...(process.platform === "win32" ? ["--local-ntfs"] : [])];
  const cli = (args, input) => JSON.parse(call(tools, entry, ["--json", "orchestrate", ...args, ...selection], input)).data;
  async function start() {
    const child = spawn(process.execPath, [entry, "manual-console", ...selection, "--origin", origin], { cwd: tools, windowsHide: true });
    const exit = once(child, "exit");
    let stderr = "";
    const found = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Console did not announce startup.")); }, 25_000);
      child.stderr.setEncoding("utf8").on("data", chunk => {
        stderr += chunk;
        const match = /endpoint: (http:\/\/127\.0\.0\.1:\d+)\r?\nPairing code: ([A-Za-z0-9_-]{43})\r?\n/.exec(stderr);
        if (match) { clearTimeout(timer); resolve(match); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Packaged console exited before listening: " + stderr.replace(/Pairing code: .+/g, "Pairing code: [redacted]"))); });
    });
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exit;
    };
    t.after(stop);
    return { endpoint: found[1], code: found[2], stop };
  }
  return { cli, project, start };
}

// Independent HTTP client. In particular it can send Host, Origin and chunked bytes
// without fetch rewriting them. Pairing material is never included in assertions/logs.
async function watchFor(cli, sessionId, predicate) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const data = cli(["watch", sessionId, "--once"]);
    if (predicate(data.session, data)) return data.session;
    await pause(650);
  }
  assert.fail("The CLI did not produce the expected observation within the polling budget.");
}

function http(endpoint, path, { method = "GET", headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const call = request(endpoint + path, { method, headers, agent: false, timeout: 15_000 }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", part => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: text ? JSON.parse(text) : null }));
    });
    call.on("error", reject);
    call.on("timeout", () => call.destroy(new Error("HTTP fixture timed out.")));
    if (chunked) call.write(body);
    call.end(chunked ? undefined : body);
  });
}

test("packaged manual console preserves native CLI state and authenticates scoped read-only HTTP", { timeout: 180_000 }, async t => {
  const { cli, project, start } = install(t);
  cli(["init", "--actor-prefix", "operator", "--developer-tools", "read_file,write_file,git_commit",
    "--review-tools", "read_file,run_test", "--enforce-policies", "externally"]);
  // Prepare a sibling and start the first task through the installed CLI.
  const first = cli(["prepare", "--stdin"], markdown()).sessionId;
  const sibling = cli(["prepare", "--stdin"], markdown("DEMO-002", ["DEMO-001"])).sessionId;
  const prepared = cli(["prepare", "--stdin"], markdown("DEMO-003").replace("Issue: #102", "Issue: #103")).sessionId;
  assert.ok(first && sibling && prepared);
  const initial = cli(["run", first]).session;
  assert.ok(initial.pendingPacket, "The installed CLI should emit a Developer handoff.");
  const waiting = cli(["status", first]);
  assert.equal(waiting.pendingPacket, initial.pendingPacket);
  const file = `.vibez/outbox/${waiting.pendingPacket}.handoff.json.md`;
  const nativeOriginal = readFileSync(join(project, file), "utf8");
  const original = nativeOriginal.replaceAll("\n", "\r\n").replace("# Developer handoff", "# Developer handoff — exact  ");
  put(project, file, original);

  const before = snapshot(project);
  const host = await start();
  const talk = (path, options) => http(host.endpoint, path, options);
  const discovery = await talk("/manual-console");
  assert.deepEqual(discovery.data, { protocol: "vibez.manual-console", versions: [1] });
  assert.equal(discovery.headers["cache-control"], "no-store");
  assert.equal(discovery.headers["x-content-type-options"], "nosniff");
  assert.equal((await talk("/manual-console", { headers: { Host: "localhost:1234" } })).status, 403);
  for (const bad of ["https://outside.example", "null", origin + ".bad"]) {
    const denied = await talk(base + "/capabilities", { headers: { Origin: bad } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  }
  const preflight = await talk(base + "/capabilities", { method: "OPTIONS", headers: { Origin: origin,
    "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.equal(preflight.headers.vary, "Origin");
  assert.equal((await talk(base + "/capabilities", { method: "OPTIONS", headers: { Origin: origin,
    "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "X-Forbidden" } })).status, 400);
  assert.equal((await talk(base + "/capabilities")).status, 401);
  const unsupported = await talk("/manual-console/v90/capabilities");
  assert.deepEqual(unsupported.data, { protocol: "vibez.manual-console", code: "unsupported-version", versions: [1] });
  const pair = (value, extra = {}) => talk(base + "/operator-session", { method: "POST", headers: { Origin: origin,
    "Content-Type": "application/json" }, body: typeof value === "string" ? value : JSON.stringify(value), ...extra });
  const enrollment = { version: 1, kind: "pairingRequest", data: { code: host.code } };
  assert.equal((await pair({ ...enrollment, version: 2 })).status, 400);
  assert.equal((await pair("x".repeat(65537), { chunked: true })).status, 413);
  const paired = await pair(enrollment);
  assert.equal(paired.status, 200);
  assert.equal(paired.data.kind, "operatorSession");
  assert.ok(Date.parse(paired.data.data.expiresAt) > Date.now());
  assert.equal((await pair(enrollment)).status, 401);
  const headers = { Authorization: "Bearer " + paired.data.data.token };
  const read = async path => {
    const result = await talk(path, { headers });
    if (result.status !== 429) return result;
    await pause(result.data.data.retryAfterMs + 20);
    return talk(path, { headers });
  };
  const cap = (await read(base + "/capabilities")).data.data;
  assert.deepEqual(cap.capabilities, ["run-list", "run-read", "packet-read"]);
  const collection = base + "/p/" + cap.projectId + "/runs";
  const firstPage = (await read(collection + "?limit=1")).data.data;
  assert.equal(firstPage.runs[0].sessionId, first);
  assert.ok(firstPage.nextCursor);
  assert.equal((await read(collection + "?cursor=invalid")).data.data.code, "invalid-cursor");
  const runPath = collection + "/" + first;
  const rolePath = runPath + "/packets/" + waiting.pendingPacket;
  const run = (await read(runPath)).data.data;
  assert.equal(run.summary.phase, "waiting");
  assert.equal(run.summary.branch, "feature/demo-001");
  assert.equal(run.summary.revision, git(project, "rev-parse", "HEAD"));
  assert.equal(run.attempt.nativeRunId, waiting.request.runId);
  assert.deepEqual(run.gate, { state: "awaiting-role", role: "Developer" });
  assert.deepEqual(run.pullRequest, { state: "unknown" });
  assert.deepEqual(run.ci, { state: "unknown" });
  assert.deepEqual(run.actions, ["read-packet"]);
  const observation = (await read(rolePath)).data.data;
  assert.equal(observation.body.originalMarkdown, original);
  assert.equal(observation.body.sha256, digest(original));
  assert.equal(observation.packet.packetId, waiting.pendingPacket);
  assert.equal(observation.target.sessionId, first);
  assert.equal((await read(collection + "/" + sibling + "/packets/" + waiting.pendingPacket)).status, 404);
  assert.equal((await read(collection.replace(cap.projectId, "foreign") + "/" + first)).status, 404);
  assert.equal((await read(runPath + "/packets/..%2f..%2fworkflow.json")).status, 404);
  assert.equal((await talk(runPath + "/start", { method: "POST", headers })).status, 422);
  await pause(1100);
  assert.equal((await read(rolePath)).data.data.body.originalMarkdown, original);
  assert.deepEqual(snapshot(project), before, "Poll, copy and refused requests must not advance or write any native state.");

  const next = (await read(collection + "?cursor=" + firstPage.nextCursor)).data.data;
  assert.equal(next.runs[0].sessionId, sibling);
  assert.equal(next.runs[0].phase, "blocked");
  assert.ok(next.nextCursor);
  const last = (await read(collection + "?cursor=" + next.nextCursor)).data.data;
  assert.equal(last.runs[0].sessionId, prepared);
  assert.equal(last.runs[0].phase, "prepared");
  assert.equal(last.nextCursor, null);
  assert.equal(next.runs[0].observedAt, firstPage.runs[0].observedAt);
  const blockedRead = await read(collection + "/" + sibling);
  assert.equal(blockedRead.status, 200, JSON.stringify(blockedRead.data));
  const dependencyBlocked = blockedRead.data.data;
  assert.equal(dependencyBlocked.blocker.code, "DEPENDENCY_NOT_DONE");
  assert.deepEqual(dependencyBlocked.actions, []);

  put(project, file, nativeOriginal);
  put(project, ".vibez/inbox/responses/invalid.json", "{");
  const repair = await watchFor(cli, first, session => session.diagnosticId);
  const afterRepair = (await read(runPath)).data.data;
  assert.equal(afterRepair.summary.phase, "waiting");
  assert.equal(afterRepair.pending.repair.replyToPacketId, waiting.pendingPacket);
  const repairPath = runPath + "/packets/" + repair.diagnosticId;
  const repaired = (await read(repairPath)).data.data;
  assert.equal(repaired.body.originalMarkdown, readFileSync(join(project, `.vibez/outbox/${repair.diagnosticId}.diagnostic.json.md`), "utf8"));
  assert.equal(repaired.packet.kind, "repair");
  assert.equal(repaired.packet.role, "Developer");

  const boundFile = join(project, file);
  rmSync(boundFile);
  assert.equal((await read(rolePath)).data.data.body.reason, "missing");
  put(project, file, Buffer.alloc(8 * 1024 * 1024 + 1).toString("ascii"));
  assert.equal((await read(rolePath)).data.data.body.reason, "too-large");
  rmSync(boundFile);
  const other = join(project, "unbound.txt");
  put(project, "unbound.txt", "UNBOUND_SENTINEL");
  if (process.platform !== "win32") {
    symlinkSync(other, boundFile);
    const denied = (await read(rolePath)).data.data.body;
    assert.deepEqual(denied, { availability: "unavailable", reason: "unsupported" });
    rmSync(boundFile);
  }
  rmSync(other);
  put(project, file, nativeOriginal);

  // The stable list snapshot remains coherent after native changes and host stop
  // leaves the exact CLI state readable with the original binary.
  const beforeStop = snapshot(project);
  await host.stop();
  await assert.rejects(talk("/manual-console"), error => error.code === "ECONNREFUSED" || error.code === "ECONNRESET");
  assert.equal(cli(["status", first]).pendingPacket, waiting.pendingPacket);
  assert.deepEqual(snapshot(project), beforeStop);
  assert.equal(existsSync(join(project, ".agent")), false);
  const restarted = await start();
  assert.equal((await http(restarted.endpoint, base + "/capabilities", { headers })).status, 401);
  const again = await http(restarted.endpoint, base + "/operator-session", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...enrollment, data: { code: restarted.code } }) });
  assert.equal(again.status, 200);
  const newHeaders = { Authorization: "Bearer " + again.data.data.token };
  assert.equal((await http(restarted.endpoint, rolePath, { headers: newHeaders })).data.data.body.originalMarkdown, nativeOriginal);

  // Let the installed CLI consume the Developer response and fail its actual
  // validator. A diagnostic WAITING tag cannot masquerade as an active role.
  put(project, "marker.txt", "incorrect");
  git(project, "add", "marker.txt");
  git(project, "commit", "-m", "Set fixture marker");
  const nativePacket = get(project, file.slice(0, -3)).packet;
  put(project, ".vibez/inbox/responses/valid.json", response(nativePacket));
  const stopped = await watchFor(cli, first, session => session.result?.finalLifecycleState === "DEV_VALIDATION_FAILED");
  assert.equal(stopped.result?.finalLifecycleState, "DEV_VALIDATION_FAILED");
  const blocked = (await http(restarted.endpoint, runPath, { headers: newHeaders })).data.data;
  assert.equal(blocked.summary.phase, "blocked");
  assert.equal(blocked.gate.state, "observed");
  assert.equal(blocked.gate.stage, "developer-validation");
  assert.equal(blocked.gate.outcome, "fail");
  assert.equal(blocked.pending.role, null);
  assert.equal((await http(restarted.endpoint, rolePath, { headers: newHeaders })).status, 404);
  await restarted.stop();
});

test("native reviewer source drift and revision-bound integration snapshots remain visible", { timeout: 180_000 }, async t => {
  const { cli, project, start } = install(t);
  cli(["init", "--actor-prefix", "operator", "--developer-tools", "read_file,write_file,git_commit",
    "--review-tools", "read_file,run_test", "--enforce-policies", "externally"]);
  const sessionId = cli(["prepare", "--stdin"], markdown()).sessionId;
  const developer = cli(["run", sessionId]).session;
  const developerPacket = get(project, `.vibez/outbox/${developer.pendingPacket}.handoff.json`).packet;
  put(project, "marker.txt", "correct");
  git(project, "add", "marker.txt");
  git(project, "commit", "-m", "Complete fixture implementation");
  put(project, ".vibez/inbox/responses/developer.json", response(developerPacket));
  const qa = await watchFor(cli, sessionId, session => session.pendingPacket && session.pendingPacket !== developer.pendingPacket);
  const qaPacket = get(project, `.vibez/outbox/${qa.pendingPacket}.handoff.json`).packet;
  assert.equal(qaPacket.role, "QA");
  const oldHead = git(project, "rev-parse", "HEAD");
  const host = await start();
  const paired = await http(host.endpoint, base + "/operator-session", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, kind: "pairingRequest", data: { code: host.code } }) });
  assert.equal(paired.status, 200);
  const headers = { Authorization: "Bearer " + paired.data.data.token };
  const cap = (await http(host.endpoint, base + "/capabilities", { headers })).data.data;
  const path = base + "/p/" + cap.projectId + "/runs/" + sessionId;
  const before = (await http(host.endpoint, path, { headers })).data.data;
  assert.equal(before.summary.phase, "waiting");
  assert.equal(before.blocker, null);
  assert.equal(before.gate.role, "QA");
  assert.equal((await http(host.endpoint, path + "/history?limit=1", { headers })).status, 422);

  git(project, "commit", "--allow-empty", "-m", "Advance source beyond the reviewer binding");
  const changed = (await http(host.endpoint, path, { headers })).data.data;
  assert.equal(changed.summary.phase, "blocked");
  assert.equal(changed.blocker.code, "STALE_ROLE_SOURCE");
  assert.equal(changed.pending.role.revision, oldHead);
  assert.notEqual(changed.summary.revision, oldHead);
  put(project, ".vibez/inbox/responses/qa.json", response(qaPacket));
  const refused = await watchFor(cli, sessionId, (_session, data) =>
    data.receipts.some(receipt => receipt.packetId === qa.pendingPacket && receipt.status === "REJECTED"));
  assert.equal(refused.pendingPacket, qa.pendingPacket);

  // Supply a synthetic provider observation through the native producer while
  // the installed listener reads the same scoped store. The old PR head remains
  // independently attributable alongside successful CI for the current head.
  const { loadProfile } = await import("../dist/workflow-driver/intake.js");
  const { resolveProjectConfig } = await import("../dist/project-config/index.js");
  const { observeIntegration } = await import("../dist/workflow-driver/driver.js");
  const config = resolveProjectConfig({ projectRoot: project, configPath: "workflow.json", verifyLocalStorage: () => true });
  const profile = loadProfile(project, config);
  observeIntegration(project, profile, qa, { kind: "pull-request", number: 17, revision: oldHead, status: "draft", draftKnown: true });
  observeIntegration(project, profile, qa, { kind: "ci", revision: changed.summary.revision, status: "pass" });
  const observed = (await http(host.endpoint, path, { headers })).data.data;
  assert.equal(observed.pullRequest.status, "draft");
  assert.equal(observed.pullRequest.revision, oldHead);
  assert.equal(observed.pullRequest.url, "https://github.com/fixture-owner/fixture-repo/pull/17");
  assert.equal(observed.ci.status, "pass");
  assert.equal(observed.ci.revision, changed.summary.revision);
  await host.stop();
});
