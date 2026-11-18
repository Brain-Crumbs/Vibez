import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir, version } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const synthetic = Object.freeze({
  provider: "synthetic-provider",
  remote: "simulated-remote",
  validators: "synthetic-validator",
  realIntegrations: ["installed npm artifact", "public package exports", "local Git", "local filesystem"],
  humanInterventions: ["Test author supplies deterministic fault injection; no live role judgment is exercised."],
  liveAcceptance: false,
  resultMeaning: "PASS means the scenario assertions and evidence checks passed; an expected workflow EXCEPTION or non-PASS judgment is never rewritten.",
});
const entry = (name, covers, expected, children = []) => ({ name, covers, expected, children });
// Each fixture is classified explicitly. New source tests require a deliberate
// coverage entry; a filtered or incomplete run cannot silently become this matrix.
export const scenarios = [
  entry("one approved plan drives two dependent native tasks with one PR and merge per task",
    ["dependency-chain", "done-replay"], "Two tasks reach fixture DONE; replay preserves two PRs and two merge effects."),
  entry("validation failure preserves evidence and original assignment while using a successor",
    ["validation-rework", "history"], "A failed validation remains in evidence; one successor rework completes both tasks."),
  entry("lost PR and merge responses reconcile original effects without duplicate writes",
    ["uncertain-merge", "uncertain-publication", "restart"], "Lost acknowledgements reconcile the original two PRs and two merge effects."),
  entry("poll budgets survive restart and duplicate starts cannot create another assignment",
    ["over-budget", "restart", "duplicate-work"], "Three polls remain spent after reconnection; the operation stops BUDGET_EXHAUSTED with no merge."),
  entry("incomplete approval yields durable clarification and issue text cannot authorize tasks",
    ["denied", "durable-stop", "control-race"], "Unapproved work records CLARIFICATION_REQUIRED without agent effects; newer control remains authoritative."),
  entry("lost push and ready acknowledgements reconcile exact remote identity",
    ["uncertain-publication", "duplicate-effects"], "Uncertain push and ready calls reconcile exact identities without additional effects."),
  entry("review judgment rework creates a new attempt and respects the original cycle budget",
    ["review-rework", "history"], "The original blocked QA judgment remains; a fresh run and revision consume one rework."),
  entry("idle pause, drain and cancellation acknowledge honestly and resume the original identity",
    ["stop-resume", "restart"], "Pause, drain and cancel are durable; resume retains the original session and spent polls."),
  entry("active caller cancellation quarantines a hung worker and preserves the workspace claim",
    ["quarantine", "duplicate-work"], "An active worker is quarantined; resume and competing work are rejected until drain."),
  entry("cancel during an external validator cannot publish late evidence or reviews",
    ["quarantine", "late-result"], "Cancelled validator output cannot produce review work or advance IN_DEVELOPMENT."),
  entry("immutable journal tail recovers a lost snapshot without reusing old allowance",
    ["restart", "history", "unsafe-recovery"], "The journal repairs a lost snapshot; corrupt history and control records are rejected."),
  entry("publication rechecks dirty and drifting source after remote discovery",
    ["stale-head", "history"], "Dirty or changed source stops before push, PR creation or merge and preserves reviewed evidence.", ["dirty", "commit"]),
  entry("failed CI remains actionable across restart without spending poll allowance",
    ["failed-ci", "restart", "history"], "READINESS_BLOCKED survives restart with zero polls, retries or merge writes."),
  entry("competing same-ID callers cannot duplicate an active assignment or provider",
    ["duplicate-work"], "Competing start/resume calls retain one assignment and one Developer dispatch."),
  entry("revocation between reviewed work and publication prevents the next effect",
    ["revoked", "restart"], "INACTIVE_GRANT blocks publication and remains durable after restart."),
  entry("cancelled uncertain publication stays quarantined until its original callback drains",
    ["uncertain-publication", "quarantine", "late-result"], "The original callback must drain; its late return cannot rewrite the operation journal."),
  entry("operation deadline quarantines a slow writer and remains spent after drain",
    ["over-budget", "quarantine"], "A slow writer is quarantined; drained resume preserves BUDGET_EXHAUSTED and launches no validator."),
  entry("abandoned locks need host drain proof and native recovery authorization",
    ["restart", "recovery-authority", "history"], "Recovery requires host drain and native authorization; original lock bytes remain archived."),
  entry("zero rework allowance preserves the failed attempt across resume",
    ["over-budget", "validation-rework", "history"], "Failed validation remains DEV_VALIDATION_FAILED; restart cannot invent allowance or a successor."),
  entry("concurrent validation cannot replace the active signal or launch a second validator after cancellation",
    ["duplicate-work", "late-result"], "Only the original validator is charged; cancelled work cannot publish evidence."),
  entry("completed grant history permits a later approved plan without authorizing foreign replay",
    ["done-replay", "history", "denied"], "A later grant can inspect DONE history but cannot replay it; the original audit remains unchanged."),
  entry("an unfinished operation under another grant still owns the workspace",
    ["duplicate-work", "denied"], "A foreign grant cannot supersede an unfinished operation or cancel its identity."),
  entry("cancellation during pre-merge reads never dispatches a fresh merge",
    ["uncertain-merge", "quarantine"], "Cancellation during intent or final preflight leaves MERGE_READY and no merge effect.", ["intent", "fresh"]),
  entry("revocation during final merge preflight prevents the original authorized effect",
    ["revoked", "uncertain-merge"], "Final-preflight revocation is rechecked before the original authorized merge effect."),
  entry("unavailable provider stops durably without fabricating a successful role result",
    ["unavailable-provider", "restart", "history"], "An unavailable synthetic provider stops the original session without validation, publication or fabricated PASS."),
  entry("expired grant stops before assignment or effects and retains its durable reason",
    ["expired", "restart"], "INACTIVE_GRANT blocks assignment and all worker/remote effects across restart."),
  entry("policy denied publication keeps reviewed evidence and performs no remote write",
    ["denied", "restart", "history"], "OUT_OF_SCOPE blocks the ungranted push and preserves reviewed evidence after restart."),
  entry("host agent budget exhaustion retains denial across restart without another launch",
    ["over-budget", "restart", "history"], "The host records BUDGET_EXHAUSTED; restart launches no further agent and cannot turn the failed role into DONE."),
  entry("stale remote head cannot consume reviews or authorize a merge",
    ["stale-head", "restart", "history"], "A remote head mismatch stops with MERGE_READY and zero merge calls, preserving review evidence."),
  entry("successful CI for a stale revision cannot satisfy current head checks",
    ["stale-ci", "restart", "over-budget"], "Only the current exact head is queried; older successful CI leaves current work waiting and eventually exhausts its poll budget."),
  entry("a new supervisor process reconciles a quiescent uncertain merge checkpoint without losing failed history",
    ["process-restart", "restart", "uncertain-merge", "history", "done-replay"], "An interrupted OS process releases its idle policy lease at an uncertain-merge checkpoint; a distinct process reconciles the same grant/operation with unchanged failed records and exactly two total merge effects."),
];
const requiredCoverage = ["validation-rework", "review-rework", "stop-resume", "restart", "process-restart",
  "duplicate-work", "unavailable-provider", "stale-head", "stale-ci", "denied", "expired",
  "revoked", "over-budget", "uncertain-merge", "done-replay", "history"];
const fixtureScenarios = () => scenarios.flatMap(item => item.children.length
  ? item.children.map(child => ({ ...item, fullName: item.name + " > " + child }))
  : [{ ...item, fullName: item.name }]);

export function redact(value, locations = []) {
  if (Array.isArray(value)) return value.map(item => redact(item, locations));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:token|accessToken|password|secret|authorization|credentials?)$/i.test(key)
      ? "[REDACTED]" : redact(item, locations)]));
  if (typeof value !== "string") return value;
  let text = value.replace(/fixture-token/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]");
  for (const [path, replacement] of locations.sort((a, b) => b[0].length - a[0].length)) {
    text = text.replaceAll(path, replacement).replaceAll(path.replaceAll("\\", "/"), replacement);
  }
  return text;
}

function collectFiles(directory, prefix, locations) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
    const path = join(directory, item.name), name = prefix + "/" + item.name;
    assert.ok(!lstatSync(path).isSymbolicLink(), "Fixture capture refuses symbolic links: " + name);
    if (item.isDirectory()) return collectFiles(path, name, locations);
    assert.ok(item.isFile(), "Fixture capture expects regular files: " + name);
    const bytes = readFileSync(path);
    let document;
    try { document = redact(JSON.parse(bytes.toString("utf8")), locations); } catch { /* Opaque bytes retain their digest only. */ }
    return [{ path: name, sha256: sha256(bytes), bytes: bytes.length,
      ...(document === undefined ? { content: "opaque fixture record; hash retained" }
        : { redactedSha256: sha256(json(document)), document }) }];
  });
}

function observe(records, counts) {
  const refs = Object.fromEntries(["taskIds", "runIds", "sessionIds", "operationIds", "evidenceRefs", "revisions"].map(key => [key, new Set()]));
  const keys = { taskId: "taskIds", runId: "runIds", sessionId: "sessionIds", operationId: "operationIds",
    evidenceRef: "evidenceRefs", revisionIdentity: "revisions", sourceRevision: "revisions", revision: "revisions" };
  const operations = new Map(), nonPassEvidence = [], stopReasons = new Set();
  const walk = (value, path) => {
    if (!value || typeof value !== "object") return;
    if (value.lineageId && Number.isInteger(value.sequence)) refs.evidenceRefs.add(value.lineageId + "@" + value.sequence);
    if (value.schemaId === "vibez.workflow-operation" && value.operationId) {
      const prior = operations.get(value.operationId);
      if (!prior || value.sequence > prior.sequence) operations.set(value.operationId, value);
    }
    if (value.exception?.code) stopReasons.add(value.exception.code);
    if (value.decision === "deny" && value.reason) stopReasons.add(value.reason);
    if (path.startsWith("runtime/evidence/") &&
        ((typeof value.outcome === "string" && value.outcome !== "PASS") ||
         ["FAIL", "BLOCKED", "ERROR", "CANCELLED", "TIMEOUT"].includes(value.status))) {
      nonPassEvidence.push({ path, outcome: value.outcome ?? value.status,
        lineageId: value.lineageId ?? null, revision: value.revisionIdentity ?? null });
    }
    for (const [key, item] of Object.entries(value)) {
      if (keys[key] && typeof item === "string") refs[keys[key]].add(item);
      if (key === "sessions" && Array.isArray(item)) for (const id of item) if (typeof id === "string") refs.sessionIds.add(id);
      if (key === "evidenceRefs" && Array.isArray(item)) for (const id of item) if (typeof id === "string") refs.evidenceRefs.add(id);
      if (typeof item === "object") walk(item, path);
    }
  };
  for (const record of records) walk(record.document, record.path);
  walk(counts, "effects");
  return {
    references: Object.fromEntries(Object.entries(refs).map(([key, values]) => [key, [...values].sort()])),
    effectCounts: counts,
    finalOperations: [...operations.values()],
    stopReasons: [...stopReasons].sort(),
    nonPassEvidence,
    lifecycle: records.filter(record => record.path.startsWith("runtime/state/lifecycle/") && record.document?.currentState)
      .map(record => ({ path: record.path, sha256: record.sha256, ...record.document })),
  };
}

// The fixture calls this only in an explicit evidence run, before deleting any
// state. This function writes observations, never lifecycle state or approvals.
export async function captureFixture({ name, lab, root, config, resolved, plan, counts, pulls, policyHistory }) {
  const output = process.env.VIBEZ_OPERATIONS_EVIDENCE;
  assert.ok(output && process.env.VIBEZ_OPERATIONS_IDENTITY, "Capture needs a bound evidence directory and identity.");
  const spec = fixtureScenarios().find(item => item.fullName === name);
  assert.ok(spec, "Unclassified installed fixture: " + name);
  const locations = [[root, "fixture://consumer"], [lab, "fixture://lab"]];
  const records = collectFiles(join(root, ".vibez"), "runtime", locations);
  for (const item of readdirSync(lab, { withFileTypes: true })) {
    if (item.isDirectory() && item.name !== basename(root)) records.push(...collectFiles(join(lab, item.name), "host/" + item.name, locations));
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const policies = [...new Map(policyHistory.map(policy => [policy.grantDigest, policy])).values()];
  const observed = observe(records, redact(counts, locations));
  const report = {
    schemaId: "vibez.installed-fault-scenario", schemaVersion: "1.0.0", name, covers: spec.covers,
    expectedObservations: spec.expected, execution: synthetic,
    identity: JSON.parse(readFileSync(process.env.VIBEZ_OPERATIONS_IDENTITY, "utf8")),
    binding: {
      projectIdentity: resolved.projectIdentity, configDigest: resolved.configDigest,
      configSha256: sha256(readFileSync(join(root, "vibez.config.json"))),
      config: redact(config, locations),
      planSha256: sha256(canonical(plan)), plan: redact(plan, locations),
      grants: policies.map(policy => ({ grantDigest: policy.grantDigest, grant: redact(policy.grant, locations) })),
    },
    observed: { ...observed, remotePullRequests: redact(pulls, locations) },
    history: {
      capturedBeforeCleanup: true, recordCount: records.length,
      recordIndexSha256: sha256(canonical(records.map(({ path, sha256 }) => ({ path, sha256 })))),
      note: "Original-byte hashes bind the redacted records. Fixture teardown occurs only after this capture; prior failed/superseded records are retained here.",
      records,
    },
  };
  mkdirSync(join(output, "captures"), { recursive: true });
  writeFileSync(join(output, "captures", sha256(name).slice(0, 20) + ".json"), json(report), { flag: "wx", mode: 0o600 });
}

export function parseTap(stdout) {
  const names = [], results = [], summary = {};
  for (const line of stdout.split(/\r?\n/)) {
    const subtest = /^(\s*)# Subtest: (.+)$/.exec(line);
    if (subtest) { const depth = subtest[1].length / 4; names[depth] = subtest[2]; names.length = depth + 1; continue; }
    const result = /^(\s*)(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO)(?: .*)?)?$/.exec(line);
    if (result) {
      const depth = result[1].length / 4;
      results.push({ name: result[3], fullName: [...names.slice(0, depth), result[3]].join(" > "),
        passed: result[2] === "ok" && !result[4], directive: result[4] ?? null });
    }
    const total = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (total) { assert.equal(summary[total[1]], undefined, "Duplicate TAP summary"); summary[total[1]] = Number(total[2]); }
  }
  return { results, summary };
}

export function validateTap(tap, expectedNames) {
  assert.equal(tap.summary.tests, expectedNames.length, "TAP test count does not match the complete suite");
  assert.equal(tap.results.length, expectedNames.length, "TAP result count does not match its test count");
  assert.deepEqual(tap.results.map(result => result.fullName).sort(), [...expectedNames].sort(), "TAP scenarios differ from the full source suite");
  assert.equal(tap.summary.pass, expectedNames.length, "Not every expected scenario passed");
  for (const key of ["fail", "cancelled", "skipped", "todo"]) assert.equal(tap.summary[key], 0, "TAP " + key + " must be zero");
  assert.ok(tap.results.every(result => result.passed), "A scenario failed or was not executed");
}

export function installedSource(source, packageName) {
  let transformed = source;
  for (const [file, suffix] of [["index", ""], ["config", "/config"], ["integration", "/integration"], ["diagnostics", "/diagnostics"]]) {
    const original = JSON.stringify("../dist/public/" + file + ".js");
    assert.equal(transformed.split(original).length - 1, 1, "Expected exactly one public source import: " + file);
    transformed = transformed.replace(original, JSON.stringify(packageName + suffix));
  }
  assert.doesNotMatch(transformed, /(?:from\s*|import\s*(?:\(\s*)?)\s*["'](?:\.{1,2}\/|\/|file:)/, "The staged suite cannot import implementation from a checkout");
  assert.doesNotMatch(transformed, /\.\.\/dist\//);
  return transformed;
}

export function cleanEnvironment(input) {
  const env = { ...input };
  for (const key of Object.keys(env)) if (/^(GIT_|NPM_CONFIG_|NODE_PATH$|NODE_OPTIONS$|NODE_TEST_CONTEXT$|GH_TOKEN$|GITHUB_TOKEN$|IPT_GITHUB_TOKEN$|IPT_RECOVERY_ADMIN_ACTORS$|NODE_AUTH_TOKEN$|VIBEZ_)/i.test(key)) delete env[key];
  return env;
}
function outside(parent, child) {
  const path = relative(realpathSync(parent), realpathSync(child));
  return path.startsWith(".." + sep) || path === ".." || isAbsolute(path);
}
function sourceInput(root, commit, path) {
  const bytes = readFileSync(join(root, path));
  assert.deepEqual(bytes, execFileSync("git", ["show", commit + ":" + path], { cwd: root }), "Commit the exact input before claiming candidate evidence: " + path);
  return { path, sha256: sha256(bytes),
    gitBlob: execFileSync("git", ["rev-parse", commit + ":" + path], { cwd: root, encoding: "utf8" }).trim() };
}

async function main(candidateArgument, outputArgument) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const candidate = realpathSync(resolve(candidateArgument));
  const receipt = JSON.parse(readFileSync(join(candidate, "candidate.json"), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(receipt.sourceCommit, commit, "Candidate must bind the checked-out source commit");
  const inputs = ["scripts/run-installed-fault-matrix.mjs", "tests/workflow-operations.test.mjs", "package.json"]
    .map(path => sourceInput(root, commit, path));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(receipt.package, "@brain-crumbs/vibez");
  assert.equal(receipt.package, manifest.name); assert.equal(receipt.version, manifest.version);
  assert.equal(receipt.file, manifest.name.replace(/^@/, "").replace("/", "-") + "-" + manifest.version + ".tgz");
  const archive = join(candidate, receipt.file), bytes = readFileSync(archive);
  assert.equal(receipt.sha256, sha256(bytes));
  assert.equal(receipt.integrity, "sha512-" + createHash("sha512").update(bytes).digest("base64"));
  const source = readFileSync(join(root, "tests/workflow-operations.test.mjs"), "utf8");
  assert.equal(sha256(source), inputs.find(input => input.path === "tests/workflow-operations.test.mjs").sha256);
  assert.deepEqual([...source.matchAll(/^test\("([^"]+)"/gm)].map(match => match[1]), scenarios.map(item => item.name),
    "Classify every top-level source test before running the matrix");
  const transformed = installedSource(source, manifest.name);
  const output = resolve(outputArgument);
  mkdirSync(output, { mode: 0o700 }); // An existing evidence run must never be replaced.
  assert.ok(outside(root, output), "Evidence must be outside the source checkout");
  const staging = mkdtempSync(join(tmpdir(), "vibez installed fault matrix "));
  assert.ok(outside(root, staging));
  const expectedNames = scenarios.flatMap(item => [...item.children.map(child => item.name + " > " + child), item.name]);
  const identity = {
    candidate: receipt,
    sourceTree: execFileSync("git", ["rev-parse", commit + "^{tree}"], { cwd: root, encoding: "utf8" }).trim(),
    inputs, transformedTestSha256: sha256(transformed),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, osVersion: version(), osRelease: release() },
  };
  writeFileSync(join(output, "identity.json"), json(identity), { mode: 0o600 });
  const report = { schemaId: "vibez.installed-fault-matrix", schemaVersion: "1.0.0", identity, execution: synthetic,
    startedAt: new Date().toISOString(), result: "FAIL", failures: [], scenarios: [], coverage: {},
    limitations: ["All agent judgments, validator outcomes and remote API effects are deterministic doubles.",
      "The two-process case interrupts a quiescent supervisor after its idle policy lease is released. It does not claim crash recovery while an active lease or real provider is running.",
      "The full supervisor suite runs here. Provider-internal protocol and sandbox tests remain separate; this is not AC-01/AC-02 live acceptance."] };
  const locations = [[root, "source://checkout"], [staging, "fixture://installed-consumer"]];
  try {
    const npm = [process.env.npm_execpath, resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
      join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].find(path => path && existsSync(path));
    assert.ok(npm, "Set npm_execpath to npm-cli.js, or run this command through an npm script.");
    const env = cleanEnvironment(process.env);
    const gitConfig = join(staging, "gitconfig"), npmConfig = join(staging, "npmrc"), globalConfig = join(staging, "npmrc-global");
    for (const path of [gitConfig, npmConfig, globalConfig]) writeFileSync(path, "");
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: "0",
      NPM_CONFIG_USERCONFIG: npmConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig });
    writeFileSync(join(staging, "package.json"), json({ private: true, type: "module" }));
    const installArgs = [npm, "--cache", join(staging, "npm-cache"), "install", "--offline", "--ignore-scripts",
      "--no-audit", "--no-fund", "--engine-strict", "--save-exact", archive];
    const install = spawnSync(process.execPath, installArgs, { cwd: staging, env, encoding: "utf8", timeout: 180000 });
    writeFileSync(join(output, "install.log"), redact((install.stdout ?? "") + (install.stderr ?? ""), locations));
    assert.equal(install.status, 0, "Offline candidate installation failed");
    const installed = realpathSync(join(staging, "node_modules", manifest.name));
    assert.ok(outside(root, installed));
    const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(installedManifest.name, receipt.package); assert.equal(installedManifest.version, receipt.version);
    assert.equal(JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8")).packages["node_modules/" + manifest.name].integrity, receipt.integrity);
    const exports = ["", "/config", "/integration", "/diagnostics"];
    writeFileSync(join(staging, "resolve-exports.mjs"),
      'import { realpathSync, readFileSync } from "node:fs";\n' +
      'import { fileURLToPath } from "node:url";\n' +
      'import { createHash } from "node:crypto";\n' +
      'const resolved = [];\n' +
      'for (const name of ' + JSON.stringify(exports.map(suffix => manifest.name + suffix)) + ') {\n' +
      ' const path = realpathSync(fileURLToPath(import.meta.resolve(name))); await import(name);\n' +
      ' resolved.push({name,path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")});\n' +
      '}\nconsole.log(JSON.stringify(resolved));\n');
    const resolution = JSON.parse(execFileSync(process.execPath, ["resolve-exports.mjs"], { cwd: staging, env, encoding: "utf8" }));
    for (const item of resolution) assert.ok(!outside(installed, item.path), "An export escaped the installed package");
    report.resolvedExports = resolution.map(item => ({ ...item, path: relative(installed, item.path).replaceAll("\\", "/") }));
    const testPath = join(staging, "operation-consumer.test.mjs"), collectorPath = join(staging, "capture.mjs");
    writeFileSync(testPath, transformed);
    const collectorBytes = readFileSync(fileURLToPath(import.meta.url));
    assert.equal(sha256(collectorBytes), inputs.find(input => input.path === "scripts/run-installed-fault-matrix.mjs").sha256);
    writeFileSync(collectorPath, collectorBytes);
    Object.assign(env, { VIBEZ_OPERATIONS_CONFIG: join(installed, "examples/beta/vibez.config.json"),
      VIBEZ_OPERATIONS_CAPTURE_MODULE: pathToFileURL(collectorPath).href,
      VIBEZ_OPERATIONS_EVIDENCE: output, VIBEZ_OPERATIONS_IDENTITY: join(output, "identity.json") });
    assert.equal(env.NODE_TEST_CONTEXT, undefined);
    const args = ["--test", "--test-reporter=tap", testPath];
    const run = spawnSync(process.execPath, args, { cwd: staging, env, encoding: "utf8",
      timeout: (process.platform === "win32" ? 30 : 15) * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    const stdout = run.stdout ?? "", stderr = run.stderr ?? "";
    writeFileSync(join(output, "matrix.tap"), redact(stdout, locations));
    writeFileSync(join(output, "matrix.stderr.log"), redact(stderr, locations));
    report.command = { executable: process.execPath, args: ["--test", "--test-reporter=tap", "operation-consumer.test.mjs"],
      nestedNodeTestContextCleared: true, testNameFilter: null, offlineInstall: true };
    report.process = { exitCode: run.status, signal: run.signal, error: run.error?.code ?? null,
      stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) };
    const tap = parseTap(stdout); report.tap = tap;
    const check = action => { try { action(); } catch (error) { report.failures.push(redact(error.message, locations)); } };
    check(() => assert.equal(run.status, 0, "Installed suite exited unsuccessfully"));
    check(() => assert.doesNotMatch(stderr, /skipping running files/i));
    check(() => validateTap(tap, expectedNames));
    const captures = existsSync(join(output, "captures")) ? readdirSync(join(output, "captures")).filter(name => name.endsWith(".json")) : [];
    check(() => assert.equal(captures.length, fixtureScenarios().length, "A fixture was not captured before cleanup"));
    mkdirSync(join(output, "scenarios"));
    for (const filename of captures.sort()) {
      const captureBytes = readFileSync(join(output, "captures", filename));
      const capture = JSON.parse(captureBytes);
      const result = tap.results.filter(item => item.fullName === capture.name);
      const priorFailures = report.failures.length;
      check(() => assert.equal(result.length, 1, "Each capture needs exactly one actual TAP result"));
      check(() => assert.deepEqual(capture.identity, identity));
      if (["validation failure preserves evidence and original assignment while using a successor",
        "review judgment rework creates a new attempt and respects the original cycle budget",
        "zero rework allowance preserves the failed attempt across resume",
        "a new supervisor process reconciles a quiescent uncertain merge checkpoint without losing failed history"].includes(capture.name)) {
        check(() => assert.ok(capture.observed.nonPassEvidence.length > 0, "Rework capture lost its original non-PASS evidence"));
      }
      const scenario = { ...capture, result: result[0]?.passed && report.failures.length === priorFailures ? "PASS" : "FAIL",
        evidenceValid: report.failures.length === priorFailures, tapResult: result[0] ?? null, captureSha256: sha256(captureBytes) };
      const scenarioBytes = json(scenario);
      writeFileSync(join(output, "scenarios", filename), scenarioBytes, { flag: "wx", mode: 0o600 });
      report.scenarios.push({ name: capture.name, result: scenario.result, covers: capture.covers,
        file: "scenarios/" + filename, sha256: sha256(scenarioBytes),
        taskIds: capture.observed.references.taskIds, runIds: capture.observed.references.runIds,
        sessionIds: capture.observed.references.sessionIds, stopReasons: capture.observed.stopReasons,
        nonPassEvidenceCount: capture.observed.nonPassEvidence.length });
    }
    check(() => assert.deepEqual(report.scenarios.map(item => item.name).sort(), fixtureScenarios().map(item => item.fullName).sort()));
    for (const category of requiredCoverage) {
      const matching = report.scenarios.filter(item => item.covers.includes(category));
      report.coverage[category] = matching.map(item => ({ name: item.name, result: item.result, evidence: item.file }));
      check(() => assert.ok(matching.length > 0 && matching.every(item => item.result === "PASS"), "Missing or failed coverage: " + category));
    }
    if (report.failures.length === 0) report.result = "PASS";
  } catch (error) {
    report.failures.push(redact(error.message, locations));
  } finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(output, "report.json"), json(report), { flag: "wx", mode: 0o600 });
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ result: report.result, report: join(output, "report.json"), tests: report.tap?.summary ?? null }));
  if (report.result !== "PASS") process.exitCode = 1;
}

function selfTest() {
  const tap = "TAP version 13\n# Subtest: parent\n    # Subtest: child\n    ok 1 - child\nok 1 - parent\n1..1\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  validateTap(parseTap(tap), ["parent", "parent > child"]);
  for (const altered of ["", tap.replace("# tests 2", "# tests 0"), tap.replace("# pass 2", "# pass 0"),
    tap.replace("ok 1 - child", "not ok 1 - child"), tap.replace("ok 1 - child", "ok 1 - child # SKIP fixture"),
    tap.replace("# cancelled 0", "# cancelled 1")]) assert.throws(() => validateTap(parseTap(altered), ["parent", "parent > child"]));
  const imports = ["index", "config", "integration", "diagnostics"].map(file => 'import {} from "../dist/public/' + file + '.js";').join("\n");
  assert.match(installedSource(imports, "@brain-crumbs/vibez"), /from "@brain-crumbs\/vibez"/);
  assert.throws(() => installedSource(imports + '\nimport "../source.js";', "@brain-crumbs/vibez"));
  assert.throws(() => installedSource(imports + '\nimport {} from "../source.js";', "@brain-crumbs/vibez"));
  const cleaned = cleanEnvironment({ PATH: "keep", NODE_TEST_CONTEXT: "child-v8", NODE_PATH: "bad",
    NODE_OPTIONS: "--import=bad", GITHUB_TOKEN: "secret", VIBEZ_OPERATIONS_CONFIG: "source" });
  assert.deepEqual(cleaned, { PATH: "keep" });
  assert.deepEqual(redact({ token: "secret", text: "Bearer abc123 fixture-token /fixture/a", outcome: "FAIL" },
    [["/fixture", "fixture://redacted"]]), { token: "[REDACTED]", text: "Bearer [REDACTED] [REDACTED] fixture://redacted/a", outcome: "FAIL" });
  const observed = observe([{ path: "runtime/evidence/review.json", document: { lineageId: "DEMO-001::QA",
    sequence: 1, payload: { outcome: "BLOCKED", taskId: "DEMO-001", runId: "original", revisionIdentity: "a".repeat(40) } } }], {});
  assert.equal(observed.nonPassEvidence.length, 1);
  assert.deepEqual(observed.references.evidenceRefs, ["DEMO-001::QA@1"]);
  assert.deepEqual(observed.references.runIds, ["original"]);
  for (const key of requiredCoverage) assert.ok(scenarios.some(item => item.covers.includes(key)));
  console.log("Installed fault matrix helper checks passed.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--self-test") selfTest();
  else if (process.argv.length === 4) await main(process.argv[2], process.argv[3]);
  else throw new Error("Usage: node scripts/run-installed-fault-matrix.mjs <candidate-directory> <new-evidence-directory> | --self-test");
}
