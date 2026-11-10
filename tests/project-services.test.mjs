import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AgentProviderError, FakeAgentProvider } from "../dist/agent-provider/index.js";
import { runCli } from "../dist/cli/core.js";
import { initializeProjectConfig, previewProjectInit } from "../dist/project-config/index.js";
import { createProjectServices, doctorProject } from "../dist/project-services/index.js";

const base = JSON.parse(readFileSync(new URL("../examples/beta/vibez.config.json", import.meta.url)));
const now = "2026-11-10T18:00:00.000Z";
const taskId = "DEMO-001";
const taskBranch = "feature/demo";

function fixture(t, name, adjust = () => {}, parent = tmpdir()) {
  const root = mkdtempSync(join(parent, "vibez project "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const config = structuredClone(base);
  config.project = { id: name, repository: `example/${name}` };
  config.providers.credentials = [];
  adjust(config);
  const put = (file, content) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(content, null, 2) + "\n");
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  git("remote", "add", "origin", `https://github.com/${config.project.repository}.git`);
  put("vibez.config.json", config);
  put("planning/tasks/demo.task.json", {
    schemaId: "ipt.task", schemaVersion: "1.0.0", taskId, title: "Configured project fixture",
    objective: "Use a project with no local core schemas", inScope: ["Make a fixture change"], outOfScope: ["External activity"],
    dependencies: [], canonicalBranch: taskBranch, allowedPaths: ["product.txt", "planning/contracts/demo.json"], requirements: ["DEMO-001-R1"],
    acceptanceCriteria: ["The configured command receives the literal argument"], validationPlan: ["Run the configured validator"],
    affectedContracts: ["control-plane.dev-start", "consumer.product"], requiredReviewRoles: ["Developer", "MergeController"],
  });
  put("planning/requirements/demo.json", {
    schemaId: "ipt.requirement", schemaVersion: "1.0.0", requirementId: "DEMO-001-R1", taskId,
    statement: "Only the configured fixture validator runs.", acceptanceCriteria: ["The configured validator receives one literal argument."], sourceRefs: [],
  });
  put("planning/contracts/demo.json", { moduleId: "consumer.product", moduleVersion: "1.0.0",
    knownConsumers: [{ consumerId: "consumer.downstream", expects: ["Product output remains consumable."] }] });
  put("planning/contracts/downstream.json", { moduleId: "consumer.downstream", moduleVersion: "1.0.0" });
  put("planning/policy.json", { description: "Fixture policy" });
  writeFileSync(join(root, ".gitignore"), ".vibez/\n");
  git("add", ".");
  git("commit", "-m", "Configure fixture");
  const location = { projectRoot: root, configPath: "vibez.config.json", verifyLocalStorage: () => true };
  const literal = "spaces & | ; ^ % $()";
  const unexpected = () => { throw new Error("Unexpected integration call"); };
  const host = {
    identity: "test-host@1",
    executors: new Map([["python-test", { command: process.execPath, cwd: "planning", category: "test",
      args: ["-e", `if (process.argv[1] !== ${JSON.stringify(literal)} || !process.cwd().endsWith('planning')) process.exit(1)`, literal] }]]),
    integration: {
      repository: config.project.repository,
      publication: { findOpenPullRequests: unexpected, createPullRequest: unexpected, updatePullRequest: unexpected },
      pullRequests: { findPullRequestsByHead: unexpected },
      ci: { listCheckRuns: unexpected },
      merge: { findPullRequestsByHead: unexpected, getPullRequest: unexpected, mergePullRequest: unexpected },
    },
  };
  return { root, git, location, host, config, put };
}

test("configured graph uses package assets and literal validators with isolated state", async t => {
  const alpha = fixture(t, "alpha");
  const beta = fixture(t, "beta");
  const installed = mkdtempSync(join(tmpdir(), "vibez installed "));
  t.after(() => rmSync(installed, { recursive: true, force: true }));
  for (const path of ["package.json", "dist", "schemas", "contracts", "docs/specs"]) {
    mkdirSync(join(installed, path, ".."), { recursive: true });
    cpSync(new URL(`../${path}`, import.meta.url), join(installed, path), { recursive: true });
  }
  const { createProjectServices: createInstalledServices } = await import(pathToFileURL(join(installed, "dist/project-services/index.js")).href);
  const a = await createInstalledServices(alpha.location, alpha.host);
  const b = await createInstalledServices(beta.location, beta.host);
  assert.notEqual(a.config.projectIdentity, b.config.projectIdentity);
  assert.equal(a.registry.get(taskId).requiredReviewRoles.includes("UAT/Product"), true);
  assert.equal(existsSync(join(alpha.root, ".vibez")), false);
  assert.equal(existsSync(join(beta.root, ".vibez")), false);
  const failed = await a.cli(["--json", "manual", "export", `${alpha.config.paths.intake}/missing.json`, alpha.config.paths.exchange]);
  assert.equal(failed.exitCode, 2);
  assert.throws(() => a.developerStart.start({ ownerId: "", runId: "fixture", occurredAt: now }), /ownerId/);
  await assert.rejects(a.developerValidation.validate({ taskId, actorId: "developer", runId: "validation", occurredAt: now }), /must be IN_DEVELOPMENT/);
  assert.equal(existsSync(join(alpha.root, ".git/vibez-project.json")), false);
  assert.equal(existsSync(a.config.paths.state), false);
  const before = await a.cli(["--json", "next"]);
  assert.equal(JSON.parse(before.stdout).data.taskId, taskId);
  const start = await a.developerStart.start({ ownerId: "developer", runId: "fixture", occurredAt: now });
  assert.equal(start.lifecycleState, "IN_DEVELOPMENT");
  assert.equal(start.context.artifacts.some(artifact => artifact.sourcePath.startsWith("vibez-package:")), true);
  assert.equal(start.context.artifacts.some(artifact => artifact.sourcePath === "planning/requirements/demo.json"), true);
  assert.equal(a.status.read(now).tasks[0].state, "IN_DEVELOPMENT");
  assert.equal(b.status.read(now).tasks[0].state, "PLANNED");
  const requestPath = `${alpha.config.paths.intake}/developer.json`;
  alpha.put(requestPath, { taskId, role: "Developer", actorId: "developer", runId: "manual-fixture", contextPackage: start.context,
    revisionIdentity: start.sourceRevision, toolPermissionPolicy: { allowedTools: [], networkAccess: "none" } });
  const exported = await a.cli(["--json", "manual", "export", requestPath, alpha.config.paths.exchange]);
  assert.equal(exported.exitCode, 0, exported.stdout + exported.stderr);
  const packet = JSON.parse(readFileSync(JSON.parse(exported.stdout).data.packetPath, "utf8"));
  assert.ok(packet.instructions.some(line => line.includes("configured host CLI")));
  assert.ok(packet.instructions.some(line => line.includes("installed Vibez package")));
  assert.ok(packet.instructions.every(line => !line.includes("agent manual import")));
  assert.equal((await runCli(["--json", "status"], { repositoryRoot: alpha.root })).exitCode, 4);
  writeFileSync(join(alpha.root, "product.txt"), "validated fixture revision\n");
  const producerPath = "planning/contracts/demo.json";
  const producer = JSON.parse(readFileSync(join(alpha.root, producerPath), "utf8"));
  alpha.put(producerPath, { ...producer, moduleVersion: "1.1.0" });
  alpha.git("add", "product.txt", producerPath);
  alpha.git("commit", "-m", "Change fixture");
  const result = await a.developerValidation.validate({ taskId, actorId: "developer", runId: "validation", occurredAt: now });
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.checks.map(check => check.validatorId), ["python-test"]);
  assert.ok(existsSync(a.config.paths.evidence));
  assert.ok(!existsSync(join(alpha.root, "schemas")) && !existsSync(join(alpha.root, ".agent")));
  assert.ok(!existsSync(b.config.paths.state));
  assert.equal(a.qaReview.prepareContext({ taskId }).context.artifacts.some(artifact => artifact.kind === "diff"), true);
  for (const [gate, reviewerId, details] of [
    [a.qaReview, "qa", { acceptanceCriteriaScenarios: ["Literal arguments"], regressionNegativeCaseCoverage: ["Rejected paths"] }],
    [a.architectureReview, "architect", { affectedContractsModules: a.registry.get(taskId).affectedContracts,
      dependencyConsumerSurfaces: ["consumer.product"], semanticCompatibilityAssessment: "Existing artifacts retain their meanings.",
      invariantDependencyRuleAssessment: "The configured project is the only writer." }],
    [a.uatReview, "uat", { intendedOutcomesScenarios: ["Operate from an unrelated cwd"], observedBehavior: ["The configured gates share evidence."] }],
  ]) {
    const { context } = gate.prepareContext({ taskId });
    assert.equal(context.sourceRevision, result.revision);
    assert.equal(context.artifacts.some(artifact => artifact.artifactId === "contract:consumer.downstream"), reviewerId === "architect");
    if (reviewerId === "architect") {
      assert.equal(context.artifacts.find(artifact => artifact.artifactId === "contract:consumer.product").content.moduleVersion, "1.1.0");
    }
    const judgment = gate.review({ taskId, reviewerId, runId: `review-${reviewerId}`, occurredAt: now, context,
      outcome: "PASS", findings: [], details });
    assert.equal(judgment.outcome, "PASS");
  }
  const recovery = await a.recovery.check(now);
  assert.equal(recovery.findings.some(finding => finding.code === "VALIDATION_EVIDENCE_MISSING"), false);
  await assert.rejects(createProjectServices(alpha.location, { ...alpha.host, identity: "different-host@1" }), /bound to another project/);
  const reverted = await createInstalledServices(alpha.location, alpha.host);
  assert.equal(reverted.status.read(now).tasks[0].state, "MERGE_READY");
  assert.equal(existsSync(join(installed, ".vibez")), false);
  assert.equal(existsSync(join(alpha.root, ".agent")), false);
});

test("doctor and init are observational until an explicit exclusive create", async t => {
  const { root, location, host, config } = fixture(t, "setup");
  assert.equal(previewProjectInit(root, "preview.json", config).exists, false);
  assert.equal(existsSync(join(root, "preview.json")), false);
  const missing = await doctorProject({ ...location, configPath: "preview.json" }, host);
  assert.equal(missing.code, "INPUT_MISSING");
  const path = initializeProjectConfig(root, "preview.json", config);
  const bytes = readFileSync(path, "utf8");
  assert.throws(() => initializeProjectConfig(root, "preview.json", config), /already exists/);
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.equal((await doctorProject(location, { ...host, executors: new Map() })).code, "TOOL_UNAVAILABLE");
  assert.equal(existsSync(join(root, ".vibez")), false);
});

test("escaped and redirected paths fail before creating state", async t => {
  const unsafe = fixture(t, "unsafe", config => { config.paths.state = "../escaped"; });
  assert.equal((await doctorProject(unsafe.location, unsafe.host)).ok, false);
  const a = fixture(t, "links");
  const b = fixture(t, "destination");
  mkdirSync(join(a.root, ".vibez"));
  symlinkSync(b.root, join(a.root, ".vibez/state"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await doctorProject(a.location, a.host)).code, "UNSAFE_PATH");
  assert.equal(existsSync(join(b.root, "lifecycle")), false);
  assert.equal(existsSync(join(a.root, ".git/vibez-project.json")), false);
});


test("nested worktrees and missing task inputs are rejected before writes", async t => {
  const parent = fixture(t, "outer");
  const nested = fixture(t, "inner", () => {}, parent.root);
  assert.equal((await doctorProject(nested.location, nested.host)).code, "UNSAFE_PATH");
  const missing = fixture(t, "missing");
  missing.git("rm", "planning/requirements/demo.json");
  missing.put("planning/requirements/unrelated.json", { requirementId: "OTHER-R1" });
  missing.git("add", ".");
  missing.git("commit", "-m", "Omit required input");
  const result = await doctorProject(missing.location, missing.host);
  assert.equal(result.code, "INPUT_MISSING");
  assert.match(result.message, /DEMO-001-R1/);
  assert.equal(existsSync(join(missing.root, ".vibez")), false);
});

test("host-authorized retry increases preserve an exhausted run across a reload", async t => {
  const { root, location, host, config } = fixture(t, "retry", value => {
    value.providers.execution = "fixture-provider";
    value.budgets.maxAttempts = 1;
  });
  const provider = new FakeAgentProvider({ providerId: "fixture-provider" });
  provider.setHandler(() => { throw new AgentProviderError("PROVIDER_ERROR", "Retryable fixture error", true, provider.providerId); });
  let allowed = false;
  host.providers = new Map([[provider.providerId, provider]]);
  host.authorizeRetryBudget = grant => allowed && grant.authorizationRef === "fixture-grant";
  const services = await createProjectServices(location, host);
  const request = { ownerId: "developer", runId: "budget-fixture", occurredAt: now };
  await assert.rejects(services.orchestration.run(request), /Retryable fixture error/);
  assert.equal(provider.requests.length, 1);
  const grant = { ...request, idempotencyKey: request.runId, taskId, executionBinding: services.executionBinding,
    previousMaxAttempts: 1, maxAttempts: 2, observedAttempts: { "developer-agent": 1 },
    actor: "fixture-host", reason: "Transient outage resolved", authorizationRef: "fixture-grant" };
  await assert.rejects(services.orchestration.increaseRetryBudget(grant), /unauthorized/);
  allowed = true;
  await assert.rejects(services.orchestration.increaseRetryBudget({ ...grant, maxAttempts: 11 }), /invalid/);
  await assert.rejects(services.orchestration.increaseRetryBudget({ ...grant, observedAttempts: {} }), /stale/);
  assert.equal(existsSync(join(root, config.paths.operations, "retry-grants")), false);
  assert.equal((await services.orchestration.increaseRetryBudget(grant)).maxAttempts, 2);
  const reopened = await createProjectServices(location, host);
  assert.equal(reopened.executionBinding, services.executionBinding);
  await assert.rejects(reopened.orchestration.run(request), /Retryable fixture error/);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].runId, provider.requests[1].runId);
  await assert.rejects(reopened.orchestration.increaseRetryBudget(grant), /stale/);
});


test("start preflights the canonical branch before assignment and checkout", async t => {
  const { root, git, location, host } = fixture(t, "branch-drift");
  git("switch", "-c", taskBranch);
  git("rm", "vibez.config.json");
  git("commit", "-m", "Remove target config");
  git("switch", "main");
  const services = await createProjectServices(location, host);
  assert.throws(() => services.developerStart.start({ ownerId: "developer", runId: "branch-drift", occurredAt: now }),
    /config is missing at the target Git revision/);
  assert.equal(git("branch", "--show-current"), "main");
  assert.equal(existsSync(join(root, ".git/vibez-project.json")), false);
  assert.equal(existsSync(join(root, ".vibez")), false);
});
