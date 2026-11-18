#!/usr/bin/env node
/** Installed release acceptance. This collector observes native authority; it never writes DONE. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectCompletion } from "./unattended-evidence.mjs";

import { canonical, fileInventory, sha256, verifyCandidate } from "./unattended-package.mjs";

export { canonical, fileInventory, sha256, verifyCandidate } from "./unattended-package.mjs";

const digest = value => sha256(canonical(value));
const put = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const exportedCodes = new Set(["UNSAFE_RECOVERY", "STALE_BINDING", "WRITER_PENDING", "BUDGET_EXHAUSTED",
  "POLICY_DENIED", "CLARIFICATION_REQUIRED", "OPERATION_ACTIVE", "SOURCE_CHANGED", "CI_FAILED",
  "HOST_REQUIRED", "CONTROL_BUSY", "DRIVER_BUSY", "PROTECTION_REQUIRED", "STORAGE_UNAVAILABLE",
  "INACTIVE_GRANT", "HUMAN_REQUIRED", "OUT_OF_SCOPE", "STALE_HEAD", "CONTROL_UNACKNOWLEDGED", "CI_PROVIDER_FAILED"]);
export function redactOperation(operation) {
  const result = Object.fromEntries(["schemaId", "schemaVersion", "operationId", "planId", "planHash", "grantDigest", "binding",
    "status", "startedAtMs", "nextAtMs", "sequence", "controlSequence", "polls", "retries", "reworks", "sessions",
    "current", "completed", "pending"].filter(key=>operation[key]!==undefined).map(key=>[key,operation[key]]));
  result.exception = operation.exception ? {
    code: exportedCodes.has(operation.exception.code) ? operation.exception.code : "UNCLASSIFIED_STOP",
    privateDetailSha256: digest(operation.exception),
    remediation: "Keep original operation, package, grant and records; inspect private details with the trusted operator."
  } : null;
  return result;
}

/** Commands are observed by the host. Outside-host activity requires an explicit operator attestation. */
export function assertNoHandoffs(report) {
  assert.equal(report.interventions.length, 0, "An intervention invalidates this happy-chain demonstration.");
  const commands = report.commandAudit;
  assert.ok(Array.isArray(commands) && commands.length > 0, "Missing original command journal.");
  let previous = null;
  for (const [index, row] of commands.entries()) {
    assert.equal(row.sha256, digest(row.record));
    assert.equal(row.record.sequence, index + 1);
    assert.equal(row.record.previousSha256, previous);
    assert.equal(row.record.operationId, report.operation.operationId);
    assert.equal(row.record.grantDigest, report.grantDigest);
    assert.equal(row.record.kind, "command");
    assert.equal(row.record.details.scenario, "live-chain");
    assert.ok(["start", "inspect"].includes(row.record.details.command), "Happy-chain acceptance cannot hide manual recovery/control.");
    assert.ok(Number.isFinite(Date.parse(row.record.occurredAt)));
    previous = row.sha256;
  }
  assert.equal(commands.filter(row => row.record.details.command === "start").length, 1);
  const attestation = report.operatorAttestation;
  assert.equal(attestation.status, "ATTESTED");
  assert.equal(attestation.operationId, report.operation.operationId);
  assert.equal(attestation.grantDigest, report.grantDigest);
  assert.equal(attestation.noRoutineHandoffs, true);
  assert.ok(typeof attestation.actor === "string" && attestation.actor.length > 0);
  assert.ok(typeof attestation.initialSetupRef === "string" && attestation.initialSetupRef.length > 0 &&
    !attestation.initialSetupRef.startsWith("PENDING"));
  assert.ok(Number.isFinite(Date.parse(attestation.occurredAt)));
  const through = commands.findIndex(row => row.sha256 === attestation.throughCommandSha256);
  assert.ok(through >= 0 && commands.slice(0, through + 1).some(row => row.record.details.command === "start"));
  assert.ok(commands.slice(through + 1).every(row => row.record.details.command === "inspect"),
    "Attestation cannot authorize unobserved future effects.");
  assert.ok(Date.parse(attestation.occurredAt) >= Date.parse(commands[through].record.occurredAt));
  assert.ok(report.tasks.every(task => Date.parse(attestation.occurredAt) >= Date.parse(task.pr.mergedAt)));
}

/** Pure validation also used by the release preflight; a fixture label can never establish live acceptance. */
export function assertLiveChain(report) {
  assert.equal(report.evidenceKind, "LIVE_GITHUB_INSTALLED_CHAIN");
  assert.equal(report.package.package, "@brain-crumbs/vibez");
  assert.match(report.package.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(report.package.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.package.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  for (const key of ["installedTreeSha256", "configurationDigest", "providerConfigurationDigest", "projectIdentity", "grantDigest", "planDigest", "setupSha256"])
    assert.match(report[key], /^[a-f0-9]{64}$/, "Missing exact " + key);
  assert.ok(report.requiredValidators.length > 0);
  assert.equal(report.operation.status, "DONE");
  assert.equal(report.operation.planHash, report.planDigest);
  assert.equal(report.operation.grantDigest, report.grantDigest);
  assertNoHandoffs(report);
  assert.ok(report.tasks.length >= 2);
  assert.deepEqual(report.operation.completed, report.tasks.map(task => task.taskId));
  assert.equal(new Set(report.tasks.map(task => task.taskId)).size, report.tasks.length);
  assert.equal(new Set(report.tasks.map(task => task.pr.number)).size, report.tasks.length);
  const prior = new Set();
  for (const task of report.tasks) {
    assert.equal(task.state, "DONE");
    assert.match(task.sourceRevision, /^[a-f0-9]{40}$/);
    assert.match(task.mergeCommitSha, /^[a-f0-9]{40}$/);
    assert.equal(task.pr.repository, report.repository);
    assert.equal(task.pr.baseRef, report.integrationRef);
    assert.equal(task.pr.headRef, task.branch);
    assert.equal(task.pr.headSha, task.sourceRevision);
    assert.equal(task.pr.mergeCommitSha, task.mergeCommitSha);
    assert.equal(task.pr.merged, true);
    assert.equal(task.pr.draft, false);
    assert.ok(task.pr.mergedAt && Number.isFinite(Date.parse(task.pr.mergedAt)));
    assert.ok(task.dependencies.every(id => prior.has(id)), "Chain dependency did not complete first.");
    if (prior.size) assert.ok(task.dependencies.length > 0, "The demonstration must include a dependent task.");
    const roles = ["QA", "Architect", "UAT/Product"];
    for (const role of roles) {
      const review = task.reviews.find(item => item.role === role);
      assert.ok(review, "Missing independent required role.");
      assert.equal(review.outcome, "PASS");
      assert.equal(review.revision, task.sourceRevision);
      assert.ok(review.actorId && review.session && review.evidenceRef && review.runId);
      assert.match(review.contextPackageId, /^[a-f0-9]{64}$/);
    }
    assert.equal(new Set(task.reviews.map(item => item.actorId)).size, task.reviews.length);
    assert.equal(new Set(task.reviews.map(item => item.session)).size, task.reviews.length);
    assert.ok(!task.reviews.some(item => item.actorId === task.developerActorId));
    assert.ok(task.validators.length > 0);
    assert.deepEqual(task.validators.map(item=>item.id).sort(), [...report.requiredValidators].sort());
    assert.equal(task.nativeAudit.state, "DONE");
    assert.deepEqual(task.nativeAudit.findings, []);
    assert.equal(task.nativeAuditSha256, digest(task.nativeAudit));
    assert.ok(task.validators.every(item => item.outcome === "PASS" && item.revision === task.sourceRevision));
    assert.ok(report.requiredChecks.length > 0);
    for (const required of report.requiredChecks) {
      assert.ok(task.checks.some(check => check.name === required.name && check.appId === required.appId &&
        check.headSha === task.sourceRevision && check.status === "completed" && check.conclusion === "success"),
        "Missing trusted exact-head successful check.");
    }
    assert.ok(!task.checks.some(check => check.status !== "completed" || !["success", "neutral", "skipped"].includes(check.conclusion)),
      "Relevant pending or failed CI cannot be hidden by the required subset.");
    const sessions = report.sessions.filter(session => session.taskId === task.taskId);
    for (const role of ["Developer", ...roles]) assert.ok(sessions.some(session => session.role === role && session.outcome === "PASS"));
    for (const review of task.reviews) {
      assert.ok(sessions.some(session => session.session === review.session && session.role === review.role &&
        session.revision === task.sourceRevision && session.outcome === "PASS" && session.provider === "local-llama.cpp" &&
        session.runId === review.runId && session.contextPackageId === review.contextPackageId && session.actorId === review.actorId), "Approval does not bind a final real session.");
    }
    if (prior.size) {
      const predecessor = report.tasks[report.tasks.indexOf(task) - 1];
      assert.ok(sessions.every(session => Date.parse(session.startedAt) >= Date.parse(predecessor.pr.mergedAt)));
    }
    prior.add(task.taskId);
  }
  assert.equal(new Set(report.sessions.map(session => session.session)).size, report.sessions.length);
  assert.equal(report.replay.noNewEffects, true);
  for (const store of ["lifecycle", "provider", "policy", "evidence", "operations", "host"])
    for (const suffix of ["Before", "After"]) assert.match(report.replay[store + suffix], /^[a-f0-9]{64}$/);
  assert.equal(report.replay.lifecycleBefore, report.replay.lifecycleAfter);
  assert.equal(report.replay.providerBefore, report.replay.providerAfter);
  assert.equal(report.replay.policyBefore, report.replay.policyAfter);
  assert.equal(report.replay.evidenceBefore, report.replay.evidenceAfter);
  assert.equal(report.replay.operationsBefore, report.replay.operationsAfter);
  assert.equal(report.replay.hostBefore, report.replay.hostAfter);
}

/** Always uses the actual GitHub HTTPS origin; an injected fixture transport is not accepted here. */
export async function githubRead(repository, suffix, token) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(suffix.startsWith("/") && !suffix.includes(".."));
  const response = await fetch("https://api.github.com/repos/" + repository + suffix, {
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30000), redirect: "error",
  });
  assert.ok(response.ok, "GitHub evidence read failed with HTTP " + response.status);
  return response.json();
}

export async function main(argv) {
  const [setupPath, command = "inspect"] = argv;
  assert.ok(setupPath && ["start", "resume", "inspect", "pause", "drain", "cancel"].includes(command),
    "Usage: node unattended-acceptance.mjs <trusted-setup-module.mjs> start|resume|inspect|pause|drain|cancel");
  const setupFile = realpathSync(setupPath);
  const { openAcceptance } = await import(pathToFileURL(setupFile).href);
  assert.equal(typeof openAcceptance, "function");
  const setup = await openAcceptance({ command });
  // Setup is trusted executable host code supplied once, not an issue, model response or JSON authority.
  try {
  const { services, policy, plan, operationId, projectRoot, config, providerDirectory, readToken, outputDirectory } = setup;
  assert.match(operationId, /^[a-f0-9-]{36}$/);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const reportPath = join(outputDirectory, stamp + "-" + command + ".json");
  let result;
    setup.receipt = verifyCandidate(setup.candidateFile, setup.installedDirectory, join(outputDirectory, "verified-" + stamp));
    setup.setupSha256 = digest({ moduleSha256: sha256(readFileSync(setupFile)), settingsSha256: setup.setupSha256 });
    if (!setup.controlOnly) setup.recordCommand(command);
    if (command === "start") result = await services.operations.start(plan.planId, operationId);
    else if (command === "resume") result = await services.operations.resume(operationId);
    else if (command === "inspect") result = await services.operations.inspect(operationId);
    else result = await services.operations[command](operationId);
    const record = { schemaId: "vibez.unattended-observation", schemaVersion: "1.0.0", observedAt: new Date().toISOString(),
      setupSha256: sha256(readFileSync(setupFile)), command, operationId, operation: redactOperation(result),
      authority: "OBSERVATION_ONLY" };
    put(reportPath, record);
    console.log(JSON.stringify({ status: result.status, report: reportPath, sha256: sha256(readFileSync(reportPath)) }));
    if (setup.controlOnly) return 0;
    if (result.status !== "DONE") return result.status === "EXCEPTION" || result.status === "QUARANTINED" ? 2 : 0;
    await collectCompletion(setup, { githubRead, assertLiveChain, fileInventory, sha256, digest, put, git, redactOperation });
    return 0;
  } finally { await setup.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    // Never publish raw exceptions, child stderr, credentials or model reasoning.
    console.error(JSON.stringify({ outcome: "BLOCKED", code: exportedCodes.has(error.code) ? error.code : "HOST_FAILED",
      remediation: "Keep original records and operation identity; inspect the trusted host locally." }));
    process.exitCode = 2;
  }
}
