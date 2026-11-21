import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(stop => stop()));
    rmSync(root, { force: true, recursive: true });
  });
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
  async function start(commands = false) {
    const child = spawn(process.execPath, [entry, "manual-console", ...selection, "--origin", origin, ...(commands ? ["--commands"] : [])], { cwd: tools, windowsHide: true });
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
    children.push(stop);
    return { endpoint: found[1], code: found[2], stop };
  }
  function watch(sessionId) {
    const oneShot = process.platform === "win32";
    const child = spawn(process.execPath, [entry, "orchestrate", "watch", sessionId, ...(oneShot ? ["--once"] : []), ...selection],
      { cwd: tools, stdio: "ignore", windowsHide: true });
    const exit = once(child, "exit");
    const stop = async () => {
      if (!oneShot && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exit;
    };
    children.push(stop);
    return stop;
  }
  return { cli, project, start, watch };
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
    const call = request(endpoint + path, { method, headers, agent: false, timeout: process.platform === "win32" ? 90_000 : 15_000 }, res => {
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
  assert.deepEqual(cap.capabilities, ["run-list", "run-read", "packet-read", "history-read", "historical-packet-read", "receipt-read"]);
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

  const legacy = await read(runPath + "/history");
  assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
  const legacyEvents = legacy.data.data.events;
  const legacyReceipt = legacyEvents.find(event => event.details.kind === "receipt").details.receipt;
  assert.equal(legacyReceipt.requestId, null);
  assert.equal(legacyReceipt.expectedPacketId, waiting.pendingPacket);
  assert.equal(legacyReceipt.disposition, "rejected");
  assert.deepEqual((await read(runPath + "/receipts/" + legacyReceipt.receiptId + "/original")).data.data.body,
    { availability: "available", originalReply: "{", encoding: "utf-8" });
  const companion = file.slice(0, -3);
  const companionText = readFileSync(join(project, companion), "utf8");
  rmSync(join(project, companion));
  assert.deepEqual((await read(runPath + "/receipts/" + legacyReceipt.receiptId)).data.data, legacyReceipt);
  assert.ok((await read(runPath + "/history")).data.data.events.some(event =>
    event.details.kind === "receipt" && event.details.receipt.receiptId === legacyReceipt.receiptId));
  put(project, companion, companionText);
  const legacyPath = ".vibez/operations/driver/archive/" + digest("{") + ".input.json";
  rmSync(join(project, legacyPath));
  assert.equal((await read(runPath + "/receipts/" + legacyReceipt.receiptId + "/original")).data.data.body.reason, "missing");
  assert.equal((await read(runPath + "/history")).data.data.events.find(event =>
    event.details.kind === "reply").details.replyAvailability, "unavailable");
  assert.equal((await read(collection + "/" + sibling + "/receipts/" + legacyReceipt.receiptId + "/original")).status, 404);
  put(project, legacyPath, { original: "[redacted]" });
  assert.equal((await read(runPath + "/receipts/" + legacyReceipt.receiptId + "/original")).data.data.body.reason, "redacted");
  put(project, legacyPath, { original: "{" });

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
  const historic = await http(restarted.endpoint, rolePath, { headers: newHeaders });
  assert.equal(historic.status, 200);
  assert.equal(historic.data.data.body.originalMarkdown, nativeOriginal);
  assert.equal(historic.data.data.packet.role, "Developer");
  const lifecycleFile = ".vibez/state/lifecycle/DEMO-001.lifecycle.json";
  const lifecycleText = readFileSync(join(project, lifecycleFile), "utf8");
  const oldState = JSON.parse(lifecycleText);
  oldState.history.push(null);
  put(project, lifecycleFile, oldState);
  const legacyCorrupt = await http(restarted.endpoint, runPath + "/history", { headers: newHeaders });
  assert.equal(legacyCorrupt.status, 200, JSON.stringify(legacyCorrupt.data));
  assert.ok(legacyCorrupt.data.data.events.some(event =>
    event.details.kind === "receipt" && event.details.receipt.receiptId === legacyReceipt.receiptId));
  put(project, lifecycleFile, lifecycleText);
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
  assert.equal((await http(host.endpoint, path + "/history?limit=1", { headers })).status, 200);

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
  observeIntegration(project, profile, qa, { kind: "pull-request", number: 17, revision: changed.summary.revision,
    status: "open", draftKnown: false });
  observeIntegration(project, profile, qa, { kind: "ci", revision: changed.summary.revision, status: "pass" });
  const observed = (await http(host.endpoint, path, { headers })).data.data;
  assert.equal(observed.pullRequest.status, "draft");
  assert.equal(observed.pullRequest.revision, oldHead);
  assert.equal(observed.pullRequest.url, "https://github.com/fixture-owner/fixture-repo/pull/17");
  assert.equal(observed.ci.status, "pass");
  assert.equal(observed.ci.revision, changed.summary.revision);
  await host.stop();
  const client = await connectCommands(start, false);
  const history = await historyEvents(client, sessionId);
  assert.ok(history.some(event => event.details.kind === "pull-request" && event.details.pullRequest.revision === oldHead));
  assert.ok(history.some(event => event.details.kind === "ci" && event.details.ci.revision === changed.summary.revision));
});

async function connectCommands(start, commands) {
  const host = await start(commands);
  const paired = await http(host.endpoint, base + "/operator-session", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, kind: "pairingRequest", data: { code: host.code } }) });
  assert.equal(paired.status, 200);
  const headers = { Origin: origin, Authorization: "Bearer " + paired.data.data.token, "Content-Type": "application/json" };
  async function send(path, options = {}) {
    const result = await http(host.endpoint, path, { headers, ...options });
    if (result.status !== 429) return result;
    await pause(result.data.data.retryAfterMs + 40);
    return http(host.endpoint, path, { headers, ...options });
  }
  const cap = await send(base + "/capabilities");
  const { projectId, capabilities } = cap.data.data;
  const path = id => base + "/p/" + projectId + "/runs/" + id;
  function command(id, action, fields = {}, requestId = randomUUID()) {
    const data = { target: { projectId, sessionId: id, attemptId: id }, requestId, ...fields };
    return send(path(id) + "/" + action, { method: "POST",
      body: JSON.stringify({ version: 1, kind: action === "replies" ? "replyRequest" : "commandRequest", data }) });
  }
  return { host, send, path, command, capabilities, projectId, headers };
}

async function historyEvents(client, sessionId, limit = 25) {
  const events = [];
  let cursor;
  do {
    const query = "?limit=" + limit + (cursor ? "&cursor=" + cursor : "");
    const page = await client.send(client.path(sessionId) + "/history" + query);
    assert.equal(page.status, 200, JSON.stringify(page.data));
    assert.equal(page.data.kind, "history");
    assert.equal(page.data.data.sessionId, sessionId);
    events.push(...page.data.data.events);
    cursor = page.data.data.nextCursor;
  } while (cursor);
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  return events;
}

test("packaged console commands scope rejected replies and recover exact receipts across restart", { timeout: 300_000 }, async t => {
  const { cli, project, start } = install(t);
  cli(["init", "--actor-prefix", "operator", "--developer-tools", "read_file,write_file,git_commit",
    "--review-tools", "read_file,run_test", "--enforce-policies", "externally"]);
  const first = cli(["prepare", "--stdin"], markdown()).sessionId;
  const sibling = cli(["prepare", "--stdin"], markdown("DEMO-002")).sessionId;
  const blocked = cli(["prepare", "--stdin"], markdown("DEMO-003", ["DEMO-001"])
    .replace("Issue: #102", "Issue: #103")).sessionId;

  let client = await connectCommands(start, true);
  assert.ok(client.capabilities.includes("submit-reply"));
  assert.equal((await client.command(blocked, "start")).status, 422);
  const unselected = (await client.send(client.path(sibling))).data.data;
  assert.equal(unselected.summary.phase, "prepared");
  assert.equal(unselected.actions.includes("start"), false);
  assert.equal(unselected.blocker.code, "TASK_NOT_ELIGIBLE");
  assert.equal((await client.command(sibling, "start")).status, 422);
  assert.equal(cli(["status", sibling]).status, "PREPARED");
  assert.ok((await client.send(client.path(first))).data.data.actions.includes("start"));
  const lock = ".vibez/operations/driver/writer.lock";
  put(project, lock, "fixture-held-lock");
  const contention = await client.command(first, "start");
  assert.equal(contention.status, 409);
  assert.equal(contention.data.data.code, "writer-busy");
  rmSync(join(project, lock));

  const startId = randomUUID();
  const began = await client.command(first, "start", {}, startId);
  assert.equal(began.status, 200);
  assert.equal(began.data.data.operation.state, "finished", JSON.stringify(began.data));
  const developer = cli(["status", first]).pendingPacket;
  assert.ok(developer);
  const firstView = (await client.send(client.path(first))).data.data;
  assert.ok(firstView.actions.includes("submit-reply"));
  assert.match(firstView.nextAction, /submit the reply here/);
  assert.equal((await client.command(first, "start", {}, startId)).data.data.replayed, true);

  git(project, "switch", "main");
  const siblingRun = cli(["run", sibling]).session;
  assert.ok(siblingRun.pendingPacket);
  git(project, "switch", "feature/demo-001");

  const packet = get(project, ".vibez/exchange/" + developer + ".packet.json");
  const otherPacket = get(project, ".vibez/exchange/" + siblingRun.pendingPacket + ".packet.json");
  const valid = response(packet);
  valid.result.details.summary += " Includes literal "+String.fromCharCode(96).repeat(3);
  const displaced = JSON.stringify(response(otherPacket));
  const reply = (replyText, id = randomUUID(), expectedPacketId = developer) =>
    client.command(first, "replies", { expectedPacketId, replyText }, id);
  assert.equal((await reply(displaced, randomUUID(), siblingRun.pendingPacket)).data.data.code, "stale-target");
  for (const input of ["{", "\x60\x60\x60json\n{}\n\x60\x60\x60\n\x60\x60\x60json\n{}\n\x60\x60\x60",
    displaced, JSON.stringify({ schemaId: "ipt.driver-response", schemaVersion: "1.0.0",
      projectRoot: project, profileHash: cli(["status", first]).profileHash, packetId: developer, action: "recheck", sessionId: first }),
    JSON.stringify({ ...valid, role: "QA" }), JSON.stringify({ ...valid, runId: "other-run" }),
    JSON.stringify({ ...valid, revisionIdentity: "0".repeat(40) })]) {
    const rejected = await reply(input);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    const receiptId = rejected.data.data.operation.receiptId;
    const receipt = (await client.send(client.path(first) + "/receipts/" + receiptId)).data.data;
    assert.equal(receipt.disposition, "rejected");
    assert.equal(receipt.expectedPacketId, developer);
    assert.equal(receipt.importedPacketId, null);
    assert.equal(receipt.target.sessionId, first);
    assert.ok(receipt.repairPacketId);
    assert.equal((await client.send(client.path(first) + "/packets/" + receipt.repairPacketId)).status, 200);
    assert.equal(cli(["status", first]).pendingPacket, developer);
    assert.equal(cli(["status", sibling]).pendingPacket, siblingRun.pendingPacket);
    assert.equal((await client.send(client.path(sibling) + "/receipts/" + receiptId)).status, 404);
  }
  assert.deepEqual(readdirSync(join(project, ".vibez/operations/driver/archive")).filter(name => name.endsWith(".receipt.json")), []);

  // Wrong bytes aimed at A remain independently usable in B's normal CLI inbox.
  git(project, "switch", "feature/demo-002");
  put(project, ".vibez/inbox/responses/sibling.json", displaced);
  await watchFor(cli, sibling, (_session, data) => data.receipts.some(receipt => receipt.status === "ACCEPTED"));
  assert.ok(existsSync(join(project, ".vibez/exchange", siblingRun.pendingPacket + ".result.json")));
  rmSync(join(project, ".vibez/inbox/responses/sibling.json"));
  git(project, "switch", "feature/demo-001");

  // Give the native validation a failing marker. The import still succeeds.
  put(project, "marker.txt", "fixture failure");
  git(project, "add", "marker.txt");
  git(project, "commit", "-m", "Commit fixture marker");
  const fenced = "\x60\x60\x60json\n" + JSON.stringify(valid) + "\n\x60\x60\x60";
  const oldEvents = await historyEvents(client, first);
  const historyPath = client.path(first) + "/history?limit=2";
  const oldPage = (await client.send(historyPath)).data.data;
  assert.ok(oldPage.nextCursor);
  const key = randomUUID();
  const [left, right] = await Promise.all([reply(fenced, key), reply(fenced, key)]);
  for (const result of [left, right]) assert.ok([200, 202].includes(result.status), JSON.stringify(result.data));
  const accepted = (await client.send(client.path(first) + "/requests/" + key)).data.data;
  assert.equal(accepted.operation.state, "finished");
  const ref = accepted.operation.receiptId;
  assert.ok(ref);
  const receipt = (await client.send(client.path(first) + "/receipts/" + ref)).data.data;
  assert.equal(receipt.disposition, "accepted");
  assert.equal(receipt.importedPacketId, developer);
  const nextPage = (await client.send(historyPath + "&cursor=" + oldPage.nextCursor)).data.data;
  assert.deepEqual(nextPage.events, oldEvents.slice(2, 4), "An existing cursor keeps its snapshot while the native run advances.");
  const gate = (await client.send(client.path(first))).data.data;
  assert.equal(gate.gate.stage, "developer-validation");
  assert.equal(gate.gate.outcome, "fail");
  assert.equal((await reply(fenced + " ", key)).data.data.code, "conflicting-request");
  await client.host.stop();

  client = await connectCommands(start, true);
  const replay = await reply(fenced, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.data.replayed, true);
  assert.equal(replay.data.data.operation.receiptId, ref);
  assert.deepEqual((await client.send(client.path(first) + "/receipts/" + ref)).data.data, receipt);
  assert.equal(readdirSync(join(project, ".vibez/exchange")).filter(name => name === developer + ".result.json").length, 1);
  await client.host.stop();

  const readOnly = await connectCommands(start, false);
  assert.equal(readOnly.capabilities.includes("submit-reply"), false);
  assert.equal((await readOnly.command(first, "resume")).status, 422);
  assert.equal((await readOnly.send(readOnly.path(first))).data.data.gate.outcome, "fail");
  const beforeHistory = snapshot(project);
  const events = await historyEvents(readOnly, first, 3);
  const projected = events.find(event => event.details.kind === "receipt" && event.details.receipt.receiptId === ref);
  assert.deepEqual(projected.details.receipt, receipt);
  for (const [index, event] of events.entries()) {
    if (event.details.kind !== "receipt") continue;
    const earlier = events.findIndex(item => item.details.kind === "reply" && item.details.receiptId === event.details.receipt.receiptId);
    assert.ok(earlier >= 0 && earlier < index, "A submission without a timestamp still precedes its native receipt.");
    assert.equal(events[earlier].recordedAt, null);
  }
  assert.ok(events.some(event => event.details.kind === "receipt" && event.details.receipt.disposition === "rejected"));
  assert.ok(events.some(event => event.details.kind === "validation-check" && event.details.outcome === "fail" && event.details.required === true));
  assert.ok(events.some(event => event.details.kind === "gate" && event.details.gate.stage === "developer-validation"));
  const originalPath = readOnly.path(first) + "/receipts/" + ref + "/original";
  assert.equal((await readOnly.send(originalPath)).data.data.body.originalReply, fenced);
  assert.equal((await readOnly.send(readOnly.path(sibling) + "/receipts/" + ref + "/original")).status, 404);
  const cursor = (await readOnly.send(readOnly.path(first) + "/history?limit=1")).data.data.nextCursor;
  assert.equal((await readOnly.send(readOnly.path(sibling) + "/history?cursor=" + cursor)).data.data.code, "invalid-cursor");
  assert.equal((await readOnly.send(readOnly.path(first).split("/").slice(0, -1).join("/") + "?cursor=" + cursor)).data.data.code, "invalid-cursor");
  const layout = get(project, ".vibez/operations/driver/profile.json").storage;
  const checks = readdirSync(join(project, layout.evidence)).filter(name => name.startsWith("DEMO-001_003a_003avalidator"));
  const failPath = checks.map(name => layout.evidence + "/" + name + "/0000001.json")
    .find(name => get(project, name).payload.outcome === "FAIL");
  assert.ok(failPath, "The installed native runner must record a failing validator.");
  const originalCheck = readFileSync(join(project, failPath), "utf8");
  const editedCheck = JSON.parse(originalCheck);
  editedCheck.payload.outcome = "PASS";
  for (const check of editedCheck.payload.checks) check.outcome = "PASS";
  put(project, failPath, editedCheck);
  const withoutTamper = await historyEvents(readOnly, first);
  assert.ok(!withoutTamper.some(event => event.details.kind === "validation-check" &&
    event.details.validatorId === editedCheck.payload.validatorId), "Audit-rejected evidence must not become a historical result.");
  assert.ok(withoutTamper.some(event => event.details.kind === "gate" && event.details.gate.outcome === "fail"));
  put(project, failPath, originalCheck);
  const rejected = events.filter(event => event.details.kind === "receipt" &&
    event.details.receipt.disposition === "rejected").slice(0, 2);
  assert.equal(rejected.length, 2);
  const tiedAt = rejected[0].recordedAt;
  const consoleDirectory = layout.driver + "/console";
  const boundArchive = layout.driver + "/archive/bound";
  const originals = new Map();
  try {
    for (const event of rejected) {
      const { receiptId, requestId } = event.details.receipt;
      const directory = readdirSync(join(project, consoleDirectory)).map(name => consoleDirectory + "/" + name)
        .find(name => existsSync(join(project, name, receiptId + ".receipt.json")));
      assert.ok(directory);
      const storedPath = directory + "/" + receiptId + ".receipt.json";
      const inputHash = get(project, directory + "/" + requestId + ".request.json").inputHash;
      const nativePath = readdirSync(join(project, boundArchive)).filter(name => name.endsWith(".receipt.json"))
        .map(name => boundArchive + "/" + name).find(name => get(project, name).inputHash === inputHash);
      assert.ok(nativePath);
      for (const [location, field] of [[storedPath, "recordedAt"], [nativePath, "occurredAt"]]) {
        const original = readFileSync(join(project, location), "utf8");
        originals.set(location, original);
        put(project, location, { ...JSON.parse(original), [field]: tiedAt });
      }
    }
    const ids = rejected.map(event => event.eventId).sort();
    const tied = (await historyEvents(readOnly, first)).filter(event => ids.includes(event.eventId));
    assert.deepEqual(tied.map(event => event.recordedAt), [tiedAt, tiedAt]);
    assert.deepEqual(tied.map(event => event.eventId), ids, "Independent native timestamp ties use stable event IDs.");
  } finally {
    for (const [location, original] of originals) put(project, location, original);
  }
  assert.deepEqual(snapshot(project), beforeHistory);
  assert.equal(cli(["status", first]).sessionId, first);
});

test("scoped ingress resumes after interrupted storage and an unacknowledged native import", { timeout: 300_000 }, async t => {
  const { cli, project, start, watch } = install(t);
  const { hash, stableId } = await import("../dist/workflow-driver/io.js");
  cli(["init", "--actor-prefix", "operator", "--developer-tools", "read_file,write_file,git_commit",
    "--review-tools", "read_file,run_test", "--enforce-policies", "externally"]);
  put(project, "verify.mjs", `import { existsSync, readFileSync, writeFileSync } from "node:fs";
writeFileSync(".vibez/validation-started", "");
const limit = Date.now() + 45000;
while (!existsSync(".vibez/validation-release") && Date.now() < limit) {
  await new Promise(resolve => setTimeout(resolve, 50));
}
writeFileSync(".vibez/validation-finished", "");
process.exitCode = readFileSync("marker.txt", "utf8") === "correct" ? 0 : 1;`);
  git(project, "add", "verify.mjs");
  git(project, "commit", "-m", "Configure observable slow validator");
  const first = cli(["prepare", "--stdin"], markdown()).sessionId;
  const initial = cli(["run", first]).session;
  const developer = initial.pendingPacket;
  put(project, "marker.txt", "correct");
  git(project, "add", "marker.txt");
  git(project, "commit", "-m", "Commit correct marker");
  const raw = JSON.stringify(response(get(project, ".vibez/exchange/" + developer + ".packet.json")));
  const key = randomUUID();
  const driver = ".vibez/operations/driver";
  const archive = join(project, driver, "archive/bound");
  mkdirSync(dirname(archive), { recursive: true });
  put(project, driver + "/archive/bound", "block atomic publication");
  const nativeResult = join(project, ".vibez/exchange", developer + ".result.json");

  let client = await connectCommands(start, true);
  const post = () => client.command(first, "replies", { expectedPacketId: developer, replyText: raw }, key);
  assert.equal((await post()).status, 202);
  assert.equal(existsSync(nativeResult), false);
  const lookup = () => client.send(client.path(first) + "/requests/" + key);
  assert.equal((await lookup()).data.data.operation.state, "pending");
  await client.host.stop();
  rmSync(archive);

  // Force a recoverable write failure between native receipt persistence and
  // the HTTP acknowledgment. The native result must survive this boundary.
  const target = { projectId: client.projectId, sessionId: first, attemptId: first };
  const profile = get(project, driver + "/profile.json");
  const scope = hash({ profile: hash(profile), projectId: target.projectId, sessionId: first });
  const id = stableId({ target, requestId: key, expected: developer, input: hash(raw) });
  const wireReceipt = join(project, driver, "console", scope, id + ".receipt.json");
  mkdirSync(wireReceipt);

  client = await connectCommands(start, true);
  const unrelated = join(dirname(archive), "corrupt.input.json");
  put(project, driver + "/archive/corrupt.input.json", "{");
  const interrupted = await post();
  assert.equal(interrupted.status, 202);
  assert.equal(existsSync(nativeResult), true);
  assert.equal(readFileSync(unrelated, "utf8"), "{");
  rmSync(unrelated);
  const nativeReceiptNames = readdirSync(archive).filter(item => item.endsWith(".receipt.json"));
  assert.equal(nativeReceiptNames.length, 1);
  const originalNative = readFileSync(join(archive, nativeReceiptNames[0]));
  await client.host.stop();
  rmSync(wireReceipt, { recursive: true });

  client = await connectCommands(start, true);
  assert.equal((await lookup()).data.data.operation.state, "pending");
  const advancing = post();
  const began = join(project, ".vibez/validation-started");
  const finished = join(project, ".vibez/validation-finished");
  const markerBudgetMs = process.platform === "win32" ? 60_000 : 10_000;
  const deadline = Date.now() + markerBudgetMs;
  let replyBeforeProbe;
  void advancing.then(result => { replyBeforeProbe = result; }, error => { replyBeforeProbe = { error: error.message }; });
  let stopWatcher;
  try {
    while (!existsSync(began) && !replyBeforeProbe && Date.now() < deadline) await pause(125);
    assert.ok(existsSync(began), "Console validation did not begin: " + JSON.stringify(replyBeforeProbe));
    const active = (await client.send(client.path(first))).data.data;
    assert.equal(active.summary.phase, "active");
    assert.equal(active.gate.stage, "developer-validation");
    assert.equal(existsSync(finished), false, "The listener must answer while a native validator is still running.");
    stopWatcher = watch(first);
    put(project, ".vibez/inbox/responses/concurrent.json", raw);
  } finally {
    put(project, ".vibez/validation-release", "");
  }
  const result = await advancing;
  await stopWatcher();
  rmSync(join(project, ".vibez/inbox/responses/concurrent.json"));
  assert.equal(result.status, 200);
  assert.equal(result.data.data.replayed, true);
  assert.equal(result.data.data.operation.receiptId, id);
  const receipt = (await client.send(client.path(first) + "/receipts/" + id)).data.data;
  assert.equal(receipt.disposition, "accepted");
  const after = cli(["status", first]);
  assert.notEqual(after.pendingPacket, developer);
  assert.equal(get(project, ".vibez/exchange/" + after.pendingPacket + ".packet.json").role, "QA");
  const packets = readdirSync(join(project, ".vibez/exchange")).filter(name => name.endsWith(".packet.json"));
  assert.equal(packets.filter(name => get(project, ".vibez/exchange/" + name).role === "QA").length, 1);
  assert.equal(readdirSync(join(project, ".vibez/exchange")).filter(name => name.endsWith(".result.json")).length, 1);
  assert.deepEqual(readFileSync(join(archive, nativeReceiptNames[0])), originalNative);
  assert.equal((await post()).data.data.operation.receiptId, id);
  assert.equal(cli(["status", first]).pendingPacket, after.pendingPacket);

  const current = client.path(first);
  const commandBody = JSON.stringify({ version: 1, kind: "commandRequest", data: { target, requestId: randomUUID() } });
  const beforeDenied = snapshot(project);
  assert.equal((await http(client.host.endpoint, current + "/resume", { method: "POST", body: commandBody })).status, 401);
  assert.equal((await http(client.host.endpoint, current + "/resume", {
    method: "POST", body: commandBody, headers: { ...client.headers, Origin: "https://foreign.example" },
  })).status, 403);
  assert.equal((await client.send(current.replace(client.projectId, "unrelated") + "/resume",
    { method: "POST", body: commandBody })).status, 404);
  for (const denied of ["publish", "approve", "ready", "recover-writer", "merge", "select"])
    assert.equal((await client.send(current + "/" + denied, { method: "POST", body: commandBody })).status, 404);
  assert.deepEqual(snapshot(project), beforeDenied);

  const resumed = await client.command(first, "resume");
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.data.operation.state, "finished");
  assert.equal(cli(["status", first]).pendingPacket, after.pendingPacket);

  const qaHead = git(project, "rev-parse", "HEAD");
  const qaPacket = get(project, ".vibez/exchange/" + after.pendingPacket + ".packet.json");
  put(project, "marker.txt", "intentional source drift");
  git(project, "add", "marker.txt");
  git(project, "commit", "-m", "Advance source past the bound QA packet");
  const blocked = await client.command(first, "resume");
  assert.equal(blocked.status, 422);
  const stale = await client.command(first, "replies", { expectedPacketId: after.pendingPacket, replyText: JSON.stringify(response(qaPacket)) });
  const staleReceipt = (await client.send(current + "/receipts/" + stale.data.data.operation.receiptId)).data.data;
  assert.equal(staleReceipt.disposition, "rejected");
  assert.equal(cli(["status", first]).pendingPacket, after.pendingPacket);

  git(project, "reset", "--hard", qaHead);
  const qa = await client.command(first, "replies", { expectedPacketId: after.pendingPacket, replyText: JSON.stringify(response(qaPacket, "FAIL")) });
  const qaReceipt = (await client.send(current + "/receipts/" + qa.data.data.operation.receiptId)).data.data;
  assert.equal(qaReceipt.disposition, "accepted");
  const rework = (await client.send(current)).data.data;
  assert.equal(rework.summary.phase, "rework");
  const repairId = rework.pending.repair.replyToPacketId;
  const template = get(project, ".vibez/outbox/" + repairId + ".diagnostic.json").responseTemplate;
  assert.equal(template.action, "rework");
  const forged = await client.command(first, "replies", { expectedPacketId: repairId, replyText: JSON.stringify({ ...template, action: "recheck" }) });
  const forgedReceipt = (await client.send(current + "/receipts/" + forged.data.data.operation.receiptId)).data.data;
  assert.equal(forgedReceipt.disposition, "rejected");
  assert.equal((await client.send(current)).data.data.pending.repair.replyToPacketId, repairId);
  const legal = await client.command(first, "replies", { expectedPacketId: repairId, replyText: JSON.stringify(template) });
  assert.equal(legal.status, 200);
  const linked = (await client.send(current)).data.data;
  assert.notEqual(linked.attempt.attemptId, first);
  assert.equal(linked.attempt.predecessorAttemptId, first);
  assert.equal(linked.pending.role.role, "Developer");

  const history = await historyEvents(client, first, 4);
  const linkAt = history.findIndex(event => event.details.kind === "rework");
  assert.ok(linkAt > 0);
  assert.deepEqual(history[linkAt].details, { kind: "rework", fromAttemptId: first, toAttemptId: linked.attempt.attemptId });
  const qaGate = history.find(event => event.details.kind === "gate" && event.details.gate.stage === "qa-review");
  assert.equal(qaGate.details.gate.revision, qaHead);
  const findingAt = history.findIndex(event => event.details.kind === "finding" &&
    event.details.role === "QA" && event.details.revision === qaHead);
  const qaReceiptAt = history.findIndex(event => event.details.kind === "receipt" && event.details.receipt.receiptId === qaReceipt.receiptId);
  assert.ok(qaReceiptAt >= 0 && findingAt > qaReceiptAt);
  const firstState = cli(["status", first]);
  const layout = get(project, ".vibez/operations/driver/profile.json").storage;
  const firstRecord = layout.driver + "/sessions/" + first + ".json";
  const journalFile = layout.orchestration + "/" + digest(firstState.request.idempotencyKey) + ".run.json";
  const savedJournal = readFileSync(join(project, journalFile), "utf8");
  const savedSession = readFileSync(join(project, firstRecord), "utf8");
  const olderSession = JSON.parse(savedSession);
  olderSession.result.stages = [];
  put(project, firstRecord, olderSession);
  rmSync(join(project, journalFile));
  const restoredGate = (await historyEvents(client, first)).find(event => event.eventId === qaGate.eventId);
  assert.equal(restoredGate.details.gate.revision, qaHead);
  assert.equal(restoredGate.details.gate.outcome, "fail");
  put(project, journalFile, savedJournal);
  put(project, firstRecord, savedSession);
  assert.ok(history.findIndex(event => event.details.kind === "handoff" &&
    event.details.packet.packetId === linked.pending.role.packetId) > linkAt);
  const historicalQa = await client.send(current + "/packets/" + after.pendingPacket);
  assert.equal(historicalQa.status, 200, JSON.stringify(historicalQa.data));
  assert.equal(historicalQa.data.data.target.attemptId, first);
  assert.equal(historicalQa.data.data.packet.revision, qaHead);
  assert.equal(historicalQa.data.data.body.originalMarkdown,
    readFileSync(join(project, ".vibez/outbox/" + after.pendingPacket + ".handoff.json.md"), "utf8"));
  const before = snapshot(project);
  await client.host.stop();
  const restarted = await connectCommands(start, false);
  assert.deepEqual(await historyEvents(restarted, first), history);
  assert.deepEqual((await restarted.send(restarted.path(first))).data.data.pending, linked.pending);
  assert.equal((await restarted.send(restarted.path(first) + "/packets/" + repairId)).status, 200);
  assert.deepEqual(snapshot(project), before);
  const qaMarkdown = ".vibez/outbox/" + after.pendingPacket + ".handoff.json.md";
  rmSync(join(project, qaMarkdown));
  const missingQa = (await restarted.send(restarted.path(first) + "/packets/" + after.pendingPacket)).data.data;
  assert.equal(missingQa.packet.role, "QA");
  assert.equal(missingQa.packet.revision, qaHead);
  assert.deepEqual(missingQa.body, { availability: "unavailable", reason: "missing" });
  put(project, qaMarkdown, historicalQa.data.data.body.originalMarkdown);
  assert.deepEqual(snapshot(project), before);
  await restarted.host.stop();
  assert.equal(cli(["resume", first, "--once"]).session.pendingPacket, linked.pending.role.packetId);
});
