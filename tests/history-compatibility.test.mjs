import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/cli/core.js";
import { inspectEvidenceReferences } from "../dist/recovery-tools/evidence-integrity.js";
import { createLocalEvidenceWriter, recordLocalProvenance } from "../dist/history/native-writer.js";
import { FileEvidenceStore } from "../dist/evidence-store/index.js";
import {
  activateNativeHistoryRelocation, checkProjectUpgrade, historyCompatibility, prepareNativeHistoryRelocation,
  readProjectAudit, verifyHistoryBackup,
} from "../dist/public/diagnostics.js";

const timestamp = "2026-11-10T20:00:00Z";
const taskId = "BOOT-003";
const oldPackage = "0.1.0-mig005.1";
const newPackage = "0.1.0-mig006.0";
const drain = { localWritersDrained: true, externalSessionsDrained: true };
const layout = { state: ".agent/state" };
const secret = "fixture-secret-never-in-export";
const roles = JSON.parse(readFileSync(new URL("../schemas/fixtures/v1/review-result.roles-valid.json", import.meta.url), "utf8"));
const fixture = name => JSON.parse(readFileSync(new URL(`../schemas/fixtures/v1/${name}.valid.json`, import.meta.url), "utf8"));

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "vibez audit "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function history(t, repeat = false, id = taskId, provenance = false) {
  const taskId = id;
  const root = temp(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Audit fixture");
  git("config", "user.email", "fixture@example.invalid");
  const canonicalBranch = "fixture/audit";
  const task = { ...fixture("task"), taskId, dependencies: [], canonicalBranch, requirements: [], affectedContracts: [] };
  mkdirSync(join(root, "tasks/definitions"), { recursive: true });
  writeFileSync(join(root, "tasks/definitions", taskId.toLowerCase() + ".task.json"), JSON.stringify(task));
  git("add", "tasks");
  git("commit", "-m", "First fixture revision");
  const first = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "Second fixture revision");
  const second = git("rev-parse", "HEAD");
  git("branch", canonicalBranch);
  const store = provenance ? createLocalEvidenceWriter(root) : new FileEvidenceStore(join(root, layout.state, "evidence"));
  function evidence(payload) {
    const result = store.record(payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    return `${result.record.lineageId}@${result.record.sequence}`;
  }
  const lifecyclePath = join(root, layout.state, "lifecycle", `${taskId}.lifecycle.json`);
  mkdirSync(join(lifecyclePath, ".."), { recursive: true });
  const validation = { ...fixture("validation-evidence"), taskId };
  const eventId = `dev-validation:${taskId}:assigned-run:IN_DEVELOPMENT->DEV_VALIDATED`;
  const event = (id, fromState, toState, revisionIdentity, evidenceRef = "observation") => ({
    eventId: id, taskId, fromState, toState, revisionIdentity, evidenceRef, occurredAt: timestamp,
    actorId: secret, runId: "assigned-run", reason: secret,
  });
  const history = [];
  function validate(revision) {
    history.push(event(eventId, "IN_DEVELOPMENT", "DEV_VALIDATED", revision, evidence({ ...validation, revisionIdentity: revision })));
  }
  validate(first);
  if (repeat) {
    history.push(event("qa-entry", "DEV_VALIDATED", "QA_REVIEW", first, "qa-review:request:qa"));
    const qa = roles.find(record => record.role === "QA");
    const failure = evidence({ ...qa, outcome: "FAIL", revisionIdentity: first,
      nonPass: { reason: secret, remediation: secret } });
    history.push(event("qa-fail", "QA_REVIEW", "QA_FAILED", first, failure));
    history.push(event("rework", "QA_FAILED", "REWORK_REQUIRED", first, failure));
    history.push(event("review-rework:resume", "REWORK_REQUIRED", "IN_DEVELOPMENT", first, failure));
    validate(second);
  }
  const reviewed = repeat ? second : first;
  history.push(event("qa-pass-entry", "DEV_VALIDATED", "QA_REVIEW", reviewed, "qa-review:request:qa-new"));
  const schema = fixture("review-result");
  const qaPass = evidence({ ...roles.find(record => record.role === "QA"), taskId, revisionIdentity: reviewed });
  const architecture = evidence({ ...schema, taskId, revisionIdentity: reviewed, reviewerId: secret });
  history.push(event("qa-pass", "QA_REVIEW", "ARCHITECTURE_REVIEW", reviewed, qaPass));
  history.push(event("arch-pass", "ARCHITECTURE_REVIEW", "UAT_REVIEW", reviewed, architecture));
  const uat = evidence({ ...roles.find(record => record.role === "UAT/Product"), taskId, revisionIdentity: reviewed });
  history.push(event("uat-pass", "UAT_REVIEW", "MERGE_READY", reviewed, uat));
  const merge = evidence({ ...fixture("merge-evidence"), taskId, revisionIdentity: reviewed, mergeCommitSha: second });
  history.push(event("merged", "MERGE_READY", "MERGED", reviewed, merge));
  history.push(event("done", "MERGED", "DONE", reviewed, merge));
  const record = { schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId, currentState: "DONE", history };
  writeFileSync(lifecyclePath, JSON.stringify(record, null, 2) + "\n");
  return { root, lifecyclePath, record };
}

test("the current reader preserves valid legacy duplicate validation labels and blocks the known incompatible downgrade", async t => {
  const { root, lifecyclePath, record } = history(t, true);
  const before = readFileSync(lifecyclePath);
  const location = { repositoryRoot: root };
  const report = await readProjectAudit(location, taskId);
  assert.equal(report.state, "DONE");
  assert.equal(report.events.filter(event => event.to === "DEV_VALIDATED").length, 2);
  assert.equal(report.events.filter(event => event.to === "DEV_VALIDATED").every(event => event.references[0].resolves), true);
  assert.equal(report.evidence.filter(evidence => evidence.schemaId === "ipt.validation-evidence").length, 2);
  assert.equal(report.evidence.every(record => record.engine === null), true);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  const check = await checkProjectUpgrade({ ...location, quiescence: drain, targetPackageVersion: newPackage });
  assert.equal(check.compatible, true, JSON.stringify(check));
  const rollback = await checkProjectUpgrade({ ...location, quiescence: drain, targetPackageVersion: oldPackage });
  assert.deepEqual(rollback.findings, ["PRIOR_READER_REJECTS_LEGACY_COLLISION"]);
  const cli = await runCli(["--json", "audit", taskId], location);
  assert.equal(cli.exitCode, 0);
  assert.equal(JSON.parse(cli.stdout).data.state, "DONE");
  assert.deepEqual(readFileSync(lifecyclePath), before);

  record.history[5].evidenceRef = record.history[0].evidenceRef;
  writeFileSync(lifecyclePath, JSON.stringify(record));
  await assert.rejects(readProjectAudit(location, taskId), /History unavailable/);
  assert.match((await runCli(["--json", "next"], location)).stdout, /duplicate event identity/);
});

test("quiescent upgrade and rollback preflight verify a nonempty backup and refuse damaged or changing inputs", async t => {
  const { root, lifecyclePath, record } = history(t);
  const location = { repositoryRoot: root };
  const check = version => checkProjectUpgrade({ ...location, quiescence: drain, targetPackageVersion: version });
  const baseline = await check(newPackage);
  assert.equal(baseline.compatible, true, JSON.stringify(baseline));
  assert.ok(baseline.fileCount >= 5);
  const offline = temp(t);
  mkdirSync(join(offline, ".agent"));
  cpSync(join(root, layout.state), join(offline, layout.state), { recursive: true });
  assert.equal(verifyHistoryBackup(offline, layout, baseline.snapshotSha256).matches, true);
  assert.equal((await check(oldPackage)).compatible, true);
  assert.ok((await check("99.0.0")).findings.includes("UNSUPPORTED_READER"));
  assert.equal(historyCompatibility.orchestrationJournalVersion, 1);

  const writer = join(root, layout.state, "orchestration");
  mkdirSync(writer);
  writeFileSync(join(writer, ".orchestration.lock"), "unknown-owner");
  const running = await check(newPackage);
  assert.equal(running.compatible, false);
  assert.ok(running.findings.includes("WRITER_OR_UNRECONCILED_LOCK"));
  rmSync(join(writer, ".orchestration.lock"));
  const unconfirmed = await checkProjectUpgrade({ ...location, targetPackageVersion: newPackage });
  assert.ok(unconfirmed.findings.includes("EXTERNAL_SESSIONS_UNCONFIRMED"));

  record.schemaVersion = "99.0.0";
  writeFileSync(lifecyclePath, JSON.stringify(record));
  const unsupported = await checkProjectUpgrade({ ...location, quiescence: drain,
    expectedSnapshotSha256: baseline.snapshotSha256, targetPackageVersion: newPackage });
  assert.equal(unsupported.compatible, false);
  assert.ok(unsupported.findings.includes("HISTORY_UNREADABLE_OR_UNSUPPORTED"));
  assert.ok(unsupported.findings.includes("BACKUP_HASH_MISMATCH"));
  assert.equal(verifyHistoryBackup(root, layout, baseline.snapshotSha256).matches, false);

  // Restore into an empty staging directory and compare all restored bytes.
  const restored = temp(t);
  mkdirSync(join(restored, ".agent"));
  cpSync(join(offline, layout.state), join(restored, layout.state), { recursive: true });
  assert.equal(verifyHistoryBackup(restored, layout, baseline.snapshotSha256).matches, true);
});

test("references to another role and missing historical failure evidence are not trustworthy", async t => {
  const { root, lifecyclePath, record } = history(t, true);
  const location = { repositoryRoot: root };
  const qa = record.history.find(event => event.eventId === "qa-pass");
  const arch = record.history.find(event => event.eventId === "arch-pass");
  qa.evidenceRef = arch.evidenceRef;
  record.history.find(event => event.eventId === "qa-fail").evidenceRef = `${taskId}::role::QA@99`;
  writeFileSync(lifecyclePath, JSON.stringify(record));
  const audit = await readProjectAudit(location, taskId);
  assert.equal(audit.events.find(event => event.from === "QA_REVIEW" && event.to === "ARCHITECTURE_REVIEW").references[0].resolves, false);
  const result = await checkProjectUpgrade({ ...location, quiescence: drain, targetPackageVersion: newPackage });
  assert.ok(result.findings.includes("LIFECYCLE_EVIDENCE_MISMATCH"));
  assert.ok(result.findings.includes("LIFECYCLE_EVIDENCE_MISSING"));
  assert.equal(result.compatible, false);
});

test("unsupported evidence blocks legacy writers and a changed receipted record blocks handoff", async t => {
  const { root, lifecyclePath, record } = history(t);
  const location = { repositoryRoot: root };
  const writer = createLocalEvidenceWriter(root);
  const validation = fixture("validation-evidence");
  assert.equal(writer.record({ ...validation, revisionIdentity: record.history[0].revisionIdentity }).ok, true);
  const audit = await readProjectAudit(location, taskId);
  const receipted = audit.evidence.find(record => record.schemaId === "ipt.validation-evidence" && record.sequence === 2);
  assert.equal(receipted.engine.packageVersion, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const lineage = validation.validatorId;
  const evidencePath = join(root, layout.state, "evidence", `${taskId}_003a_003avalidator_003a_003a${lineage}`, "0000002.json");
  const data = JSON.parse(readFileSync(evidencePath, "utf8"));
  data.payload.checks[0].evidenceRef = "changed fixture contents";
  writeFileSync(evidencePath, JSON.stringify(data));
  const result = await checkProjectUpgrade({ ...location, quiescence: drain, targetPackageVersion: newPackage });
  assert.ok(result.findings.includes("EVIDENCE_RECEIPT_MISMATCH"));
  data.payload.schemaVersion = "99.0.0";
  writeFileSync(evidencePath, JSON.stringify(data));
  rmSync(lifecyclePath);
  const attempted = await runCli(["--json", "start", "developer", "guard-test"], location);
  assert.notEqual(attempted.exitCode, 0);
  assert.throws(() => readFileSync(lifecyclePath), { code: "ENOENT" });
  const exchange = ".agent/state/manual-exchange";
  writeFileSync(join(root, "request.json"), JSON.stringify({ taskId }));
  const manual = await runCli(["--json", "manual", "export", "request.json", exchange], location);
  assert.notEqual(manual.exitCode, 0);
  assert.match(manual.stdout, /unsupported|invalid evidence payload/);
  assert.equal(existsSync(join(root, exchange)), false);
});

test("recovery reset and resume keep their intent references, while a no-review merge needs validation", () => {
  const intent = ".agent/state/recovery/reset.intent.json";
  const event = (fromState, toState, evidenceRef = intent) => ({ eventId: "history-event", taskId,
    fromState, toState, occurredAt: timestamp, reason: "fixture", revisionIdentity: "a".repeat(40), evidenceRef });
  const reset = event("QA_REVIEW", "BLOCKED");
  const route = event("BLOCKED", "REWORK_REQUIRED");
  const resume = event("REWORK_REQUIRED", "IN_DEVELOPMENT");
  for (const [current, previous] of [[reset, undefined], [route, reset], [resume, route]]) {
    assert.deepEqual(inspectEvidenceReferences(taskId, current, new Map(), previous), []);
  }
  const skippedReview = event("DEV_VALIDATED", "MERGE_READY", `${taskId}::validator::build@7`);
  assert.equal(inspectEvidenceReferences(taskId, skippedReview, new Map())[0].code, "LIFECYCLE_EVIDENCE_MISSING");
});

test("an unknown archived assignment version blocks an otherwise quiescent handoff", async t => {
  const { root } = history(t);
  const directory = join(root, layout.state, "assignments/.history");
  mkdirSync(directory, { recursive: true });
  const record = { ...fixture("assignment-lock"), taskId, status: "RELEASED", schemaVersion: "99.0.0" };
  writeFileSync(join(directory, `${taskId}-fixture-released-2026-11-10T20_3A00_3A00Z-0.json`), JSON.stringify(record));
  const report = await checkProjectUpgrade({ repositoryRoot: root, quiescence: drain, targetPackageVersion: newPackage });
  assert.equal(report.compatible, false);
  assert.ok(report.findings.includes("HISTORY_UNREADABLE_OR_UNSUPPORTED"));
});

test("valid assignment archives may contain recovery-like text in the lock ID", async t => {
  const { root } = history(t);
  const directory = join(root, layout.state, "assignments/.history");
  mkdirSync(directory, { recursive: true });
  const lockId = "job-recovery-claim-old";
  const record = { ...fixture("assignment-lock"), taskId, lockId, status: "RELEASED" };
  writeFileSync(join(directory, `${taskId}-${lockId}-released-2026-11-10T20_3A00_3A00Z-0.json`), JSON.stringify(record));
  const report = await checkProjectUpgrade({ repositoryRoot: root, quiescence: drain, targetPackageVersion: newPackage });
  assert.equal(report.compatible, true, JSON.stringify(report));
});

const relocationVersion = "0.1.0-rc.3";
const relocationOrigin = "https://github.com/example/native.git";
const relocationMarker = ".git/vibez-native-relocation/history.json";
const relocationGit = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();

async function relocationExport(root) {
  const repositoryRoot = root;
  relocationGit(root, "remote", "add", "origin", relocationOrigin);
  const check = await checkProjectUpgrade({ repositoryRoot, targetPackageVersion: relocationVersion, quiescence: drain });
  assert.equal(check.compatible, true, JSON.stringify(check));
  const exported = await prepareNativeHistoryRelocation({ repositoryRoot, quiescence: drain,
    expectedSnapshotSha256: check.snapshotSha256 });
  return exported;
}

test("a digest-pinned native restore retains original provenance and refuses an injected or modified historical receipt", async t => {
  const { root } = history(t, true, taskId, true);
  const sourceAudit = await readProjectAudit({ repositoryRoot: root }, taskId);
  assert.ok(sourceAudit.evidence.every(record => record.engine?.projectIdentity === sourceAudit.projectIdentity));
  const { manifest, manifestSha256 } = await relocationExport(root);
  const target = temp(t);
  relocationGit(target, "clone", root, ".");
  relocationGit(target, "remote", "set-url", "origin", relocationOrigin);
  mkdirSync(join(target, ".agent"));
  cpSync(join(root, layout.state), join(target, layout.state), { recursive: true });
  const request = { repositoryRoot: target, quiescence: drain, sourceManifest: manifest,
    expectedSourceManifestSha256: manifestSha256 };
  const check = version => checkProjectUpgrade({ repositoryRoot: target, quiescence: drain, targetPackageVersion: version });

  assert.equal((await check(relocationVersion)).compatible, false);
  await assert.rejects(activateNativeHistoryRelocation({ ...request, expectedSourceManifestSha256: "0".repeat(64) }), /pinned digest/);
  await assert.rejects(activateNativeHistoryRelocation({ ...request, quiescence: { ...drain, externalSessionsDrained: false } }), /drained/);
  relocationGit(target, "remote", "set-url", "origin", "https://github.com/example/foreign.git");
  await assert.rejects(activateNativeHistoryRelocation(request), /different checkout/);
  relocationGit(target, "remote", "set-url", "origin", relocationOrigin);
  assert.equal(existsSync(join(target, relocationMarker)), false);

  const accepted = await activateNativeHistoryRelocation(request);
  const markerBefore = readFileSync(join(target, relocationMarker));
  assert.deepEqual(await activateNativeHistoryRelocation(request), accepted);
  assert.deepEqual(readFileSync(join(target, relocationMarker)), markerBefore);
  assert.notEqual(accepted.destinationProjectIdentity, manifest.projectIdentity);
  assert.equal(verifyHistoryBackup(target, layout, manifest.snapshotSha256).matches, true);
  const restored = await readProjectAudit({ repositoryRoot: target }, taskId);
  assert.deepEqual(restored.events, sourceAudit.events);
  assert.deepEqual(restored.evidence, sourceAudit.evidence);
  assert.deepEqual(restored.findings, []);
  assert.equal((await check(relocationVersion)).compatible, true);
  assert.deepEqual((await check("0.1.0-rc.2")).findings, ["PRIOR_READER_REJECTS_RELOCATED_HISTORY"]);
  await assert.rejects(prepareNativeHistoryRelocation({ repositoryRoot: target, quiescence: drain,
    expectedSnapshotSha256: manifest.snapshotSha256 }), /already has/);

  const receipt = manifest.files.find(file => file.name.startsWith("audit-provenance/"));
  const receiptPath = join(target, layout.state, receipt.name);
  rmSync(receiptPath);
  assert.equal((await check(relocationVersion)).compatible, false);
  cpSync(join(root, layout.state, receipt.name), receiptPath);

  recordLocalProvenance(root, "1".repeat(64), null, "fixture");
  cpSync(join(root, layout.state, "audit-provenance"), join(target, layout.state, "audit-provenance"), { recursive: true });
  assert.equal((await check(relocationVersion)).compatible, false);
  await assert.rejects(readProjectAudit({ repositoryRoot: target }, taskId), /History unavailable/);
});

test("relocation verifies the precise union of completed stores and still records destination provenance", async t => {
  const { root } = history(t, false, taskId, true);
  const otherTask = "BOOT-490";
  const { root: target } = history(t, false, otherTask, true);
  relocationGit(target, "fetch", root, "main");
  relocationGit(target, "merge", "--allow-unrelated-histories", "--no-edit", "FETCH_HEAD");
  const source = await relocationExport(root);
  const baseline = await relocationExport(target);
  const repositoryRoot = target;
  const request = { repositoryRoot, quiescence: drain, sourceManifest: source.manifest,
    expectedSourceManifestSha256: source.manifestSha256 };
  const before = await readProjectAudit({ repositoryRoot }, otherTask);
  cpSync(join(root, layout.state), join(target, layout.state), { recursive: true });
  await assert.rejects(activateNativeHistoryRelocation(request), /restored bytes differ/i);
  await assert.rejects(activateNativeHistoryRelocation({ ...request, destinationBaseline: {
    manifest: source.manifest, expectedManifestSha256: source.manifestSha256,
  } }), /different checkout/);
  assert.equal(existsSync(join(target, relocationMarker)), false);
  const accepted = await activateNativeHistoryRelocation({ ...request, destinationBaseline: {
    manifest: baseline.manifest, expectedManifestSha256: baseline.manifestSha256,
  } });
  const prior = await readProjectAudit({ repositoryRoot }, taskId);
  const own = await readProjectAudit({ repositoryRoot }, otherTask);
  assert.equal(prior.state, "DONE");
  assert.equal(own.state, "DONE");
  assert.deepEqual(own.events, before.events);
  assert.deepEqual(own.evidence, before.evidence);
  assert.equal(prior.evidence[0].engine.projectIdentity, source.manifest.projectIdentity);
  assert.equal(own.evidence[0].engine.projectIdentity, accepted.destinationProjectIdentity);

  // New local bookkeeping after cutover does not affect any imported hash.
  recordLocalProvenance(target, "8".repeat(64), null, "fixture");
  const post = await checkProjectUpgrade({ repositoryRoot, quiescence: drain, targetPackageVersion: relocationVersion });
  assert.equal(post.compatible, true, JSON.stringify(post));
  assert.equal(post.fileCount, source.manifest.files.length + baseline.manifest.files.length + 1);
});
