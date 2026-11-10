import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandPolicyDigest, parseHostGrant, ScopedHostPolicy, scopedAgentProvider, scopedMergeEffect,
  scopedValidator, verifyGitHubProtection } from "../dist/public/integration.js";

const head = "a".repeat(40);
const configDigest = "b".repeat(64);
const projectIdentity = "c".repeat(64);
const command = { kind: "command", validatorId: "build", category: "type-check",
  required: true, command: process.execPath, args: ["--version"], timeoutMs: 500 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "vibez host "));
  t.after(() => { if (cleanup) cleanup(); rmSync(root, { recursive: true, force: true }); });
  let cleanup;
  const ledgerDirectory = join(root, "ledger");
  const worktreeRoot = join(root, "worker");
  mkdirSync(ledgerDirectory);
  mkdirSync(worktreeRoot);
  const tasks = [{ taskId: "AUT-001", branch: "automation/one", paths: ["src"] },
    { taskId: "AUT-002", branch: "automation/two", paths: ["docs"] }];
  const grant = {
    schemaId: "vibez.host-grant", schemaVersion: "1.0.0", grantId: "test-grant",
    repository: "owner/repo", projectIdentity, configDigest, integrationRef: "main",
    notBeforeMs: 0, expiresAtMs: 10_000, tasks,
    roles: [{ role: "Developer", principal: "developer", provider: "runner", model: "dev-model", tools: ["read"], network: "none" },
      { role: "QA", principal: "reviewer", provider: "runner", model: "qa-model", tools: ["read"], network: "none" }],
    validators: [{ id: "build", commandDigest: commandPolicyDigest(command) }],
    requiredChecks: ["test"], requiredReviews: ["QA"], humanOnly: ["ready"],
    actions: ["start", "agent", "validator", "review", "rework", "push", "publish", "ready", "merge"],
    budgets: { maxConcurrent: 1, maxAgentTurns: 3, maxCostMicros: 100, maxCommands: 2, maxRuntimeMs: 3000, maxReworks: 1 },
  };
  const state = { revoked: false, enabled: true, now: 100, revision: head, checks: ["test"], drained: false,
    protectionsVerified: true, remoteHead: head };
  const options = { ledgerDirectory, worktreeRoot, grant, now: () => state.now, verifyDrained: () => state.drained,
    observe(operation) {
      const branch = tasks.find(task => task.taskId === operation.taskId)?.branch;
      return { repository: grant.repository, projectIdentity, configDigest, integrationRef: "main",
        revision: state.revision, branch, revoked: state.revoked, enabled: state.enabled,
        checks: state.checks, validators: grant.validators, reviews: ["QA"],
        pullRequest: { number: 7, head: branch, base: "main", revision: state.remoteHead, open: true, ready: true,
          protectionsVerified: state.protectionsVerified },
      };
    },
  };
  return { options, grant, state, onCleanup: action => { cleanup = action; } };
}

const operation = { action: "agent", taskId: "AUT-001", revision: head,
  principal: "developer", role: "Developer", provider: "runner", tools: ["read"], network: "none", maxTurns: 2, maxCostMicros: 60, timeoutMs: 500 };
const unused = async () => assert.fail("denied operation invoked an external boundary");

test("strict grant parser rejects version, duplicate principals and dangerous paths", t => {
  const { grant } = fixture(t);
  assert.ok(Object.isFrozen(parseHostGrant(grant).tasks[0].paths));
  for (const input of [{ ...grant, schemaVersion: "2.0.0" }, { ...grant, allowMerge: true },
    { ...grant, roles: [grant.roles[0], { ...grant.roles[1], principal: "DEVELOPER" }] },
    ...["src/../.git", ".github/workflows", "CON", "src/.", "src/" ].map(path => ({
      ...grant, tasks: [{ ...grant.tasks[0], paths: [path] }],
    }))]) assert.throws(() => parseHostGrant(input), { code: "OUT_OF_SCOPE" });
});

test("scope, reviewer, gates, exact head and human-only boundaries fail before effects", async t => {
  const { options, state, onCleanup } = fixture(t);
  const policy = new ScopedHostPolicy(options);
  onCleanup(() => policy.close());
  await assert.rejects(policy.execute({ ...operation, taskId: "AUT-003" }, unused), { code: "OUT_OF_SCOPE" });
  await assert.rejects(policy.execute({ ...operation, role: "QA" }, unused), { code: "OUT_OF_SCOPE" });
  await assert.rejects(policy.execute({ action: "ready", taskId: operation.taskId, revision: head,
    pullRequestNumber: 7 }, unused), { code: "HUMAN_REQUIRED" });
  state.checks = [];
  await assert.rejects(policy.execute(operation, unused), { code: "STALE_BINDING" });
  state.checks = ["test"];
  const merge = scopedMergeEffect(policy);
  const task = { taskId: operation.taskId, canonicalBranch: "automation/one" };
  await assert.rejects(merge(task, { number: 8, expectedHeadSha: head }, unused), { code: "STALE_HEAD" });
  state.remoteHead = "d".repeat(40);
  await assert.rejects(merge(task, { number: 7, expectedHeadSha: head }, unused), { code: "STALE_HEAD" });
  state.remoteHead = head;
  state.protectionsVerified = false;
  await assert.rejects(merge(task, { number: 7, expectedHeadSha: head }, unused), { code: "PROTECTION_REQUIRED" });
  state.protectionsVerified = true;
  assert.equal(await merge(task, { number: 7, expectedHeadSha: head }, async () => "merged"), "merged");
  state.now = 10_000;
  await assert.rejects(policy.execute(operation, unused), { code: "INACTIVE_GRANT" });
  assert.deepEqual(policy.decisions().map(record => record.decision), [
    "deny", "deny", "deny", "deny", "deny", "deny", "deny", "allow", "settled", "deny",
  ]);
});

test("durable reservations serialize concurrent work and retain limits across restart", async t => {
  const { options, onCleanup } = fixture(t);
  const policy = new ScopedHostPolicy(options);
  let finish;
  const first = policy.execute(operation, async () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => new ScopedHostPolicy(options), { code: "WRITER_PENDING" });
  await assert.rejects(policy.execute({ ...operation, taskId: "AUT-002" }, unused), { code: "WRITER_PENDING" });
  finish("done");
  assert.equal(await first, "done");
  policy.close();

  const restored = new ScopedHostPolicy(options);
  onCleanup(() => restored.close());
  await assert.rejects(restored.execute({ ...operation, taskId: "AUT-002" }, unused), { code: "BUDGET_EXHAUSTED" });
  assert.equal(await restored.execute({ ...operation, taskId: "AUT-002", maxTurns: 1, maxCostMicros: 40 },
    async ({ paths }) => paths[0]), "docs");
  assert.equal(restored.decisions().filter(record => record.decision === "allow").length, 2);
});

test("revocation aborts active writer and requires verified drain after an uncertain result", async t => {
  const { options, state, onCleanup } = fixture(t);
  const policy = new ScopedHostPolicy(options);
  let signal;
  const current = policy.execute(operation, async capability => {
    signal = capability.signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  state.revoked = true;
  await assert.rejects(current, { code: "INACTIVE_GRANT" });
  assert.equal(signal.aborted, true);
  assert.equal(policy.decisions().filter(record => record.reason === "INACTIVE_GRANT").length, 1);
  const first = policy.decisions()[0].operationId;
  policy.close();
  const restored = new ScopedHostPolicy(options);
  onCleanup(() => restored.close());
  state.revoked = false;
  await assert.rejects(restored.execute(operation, unused), { code: "WRITER_PENDING" });
  assert.throws(() => restored.reconcileDrained(first), { code: "WRITER_PENDING" });
  state.drained = true;
  restored.reconcileDrained(first);
  await assert.rejects(restored.execute(operation, unused), { code: "BUDGET_EXHAUSTED" });
});

test("the provider and validator adapters charge actual launches and narrow worker capabilities", async t => {
  const { options, onCleanup } = fixture(t);
  const policy = new ScopedHostPolicy(options);
  onCleanup(() => policy.close());
  let invoked = 0;
  const runtime = { provider: { providerId: "runner", capabilities: () => ({}) },
    async runAgent(request, capability) {
      invoked += 1;
      assert.equal(request.actorId, "developer");
      assert.deepEqual(capability.paths, ["src"]);
      assert.deepEqual(capability.role.tools, ["read"]);
      assert.equal(capability.role.network, "none");
      assert.equal(capability.role.model, "dev-model");
      return { outcome: "PASS" };
    },
    async runValidator(spec, capability) {
      invoked += 1;
      assert.deepEqual(spec.args, ["--version"]);
      assert.deepEqual(capability.paths, ["src"]);
      return { status: "PASS", diagnostics: "" };
    },
  };
  const provider = scopedAgentProvider(policy, runtime, { maxTurns: 2, maxCostMicros: 60 });
  const request = { actorId: "developer", role: "Developer", taskId: "AUT-001", revisionIdentity: head,
    timeoutMs: 500, toolPermissionPolicy: { allowedTools: ["read"], networkAccess: "none" } };
  await assert.rejects(provider.run({ ...request, toolPermissionPolicy: { allowedTools: ["shell"], networkAccess: "full" } }),
    { code: "OUT_OF_SCOPE" });
  assert.equal(invoked, 0);
  assert.equal(policy.decisions().at(-1).decision, "deny");
  assert.deepEqual(await provider.run(request), { outcome: "PASS" });
  await assert.rejects(scopedValidator(policy, runtime, { ...command, args: ["foreign"] }, "AUT-001", head).execute(),
    { code: "OUT_OF_SCOPE" });
  assert.deepEqual(await scopedValidator(policy, runtime, command, "AUT-001", head).execute(), { status: "PASS", diagnostics: "" });
  assert.equal(invoked, 2);
});

test("GitHub profile requires source-pinned checks, distinct no-bypass rules and read-only workers", () => {
  const rules = ["pull_request", "non_fast_forward", "deletion"].map(type => ({ type, ruleset_id: 1 }));
  rules.push({ type: "required_status_checks", ruleset_id: 1, parameters: {
    strict_required_status_checks_policy: true, required_status_checks: [{ context: "test", integration_id: 14 }],
  } });
  rules.push({ type: "update", ruleset_id: 2 });
  const rulesets = [{ id: 1, enforcement: "active", bypass_actors: [] }, { id: 2, enforcement: "active",
    bypass_actors: [{ actor_type: "Integration", actor_id: 23, bypass_mode: "pull_request" }] }];
  const expected = { repository: "owner/repo", integrationRef: "main", nowMs: 1000, maxAgeMs: 1000,
    trustedCheckSources: { test: 14 }, controllerAppId: 23 };
  const observation = { rules, rulesets, repository: "owner/repo", integrationRef: "main", observedAtMs: 1000,
    workerPermissions: [{ metadata: "read", contents: "read", pull_requests: "read" }] };
  assert.doesNotThrow(() => verifyGitHubProtection(observation, expected));
  for (const change of [{ rules: [] }, { rulesets: [rulesets[1]] }, { repository: "foreign/repo" },
    { workerPermissions: [{ metadata: "read", contents: "write" }] }, { observedAtMs: 1001 }, { integrationRef: "other" }, { observedAtMs: -10000 }]) {
    assert.throws(() => verifyGitHubProtection({ ...observation, ...change }, expected), { code: "PROTECTION_REQUIRED" });
  }
});

test("runtime review and unknown action denial cannot journal untrusted input", async t => {
  const { options, onCleanup } = fixture(t);
  const policy = new ScopedHostPolicy(options);
  onCleanup(() => policy.close());
  await assert.rejects(policy.execute({ action: "review", taskId: "AUT-001", revision: head,
    role: "Developer", principal: "developer" }, unused), { code: "OUT_OF_SCOPE" });
  await assert.rejects(policy.execute({ action: { credential: "secret-marker" }, taskId: "AUT-001", revision: head },
    unused), { code: "OUT_OF_SCOPE" });
  assert.equal(policy.decisions().at(-1).action, null);
  assert.equal(JSON.stringify(policy.decisions()).includes("secret-marker"), false);
});
