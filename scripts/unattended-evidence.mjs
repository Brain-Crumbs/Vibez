import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const read = path => JSON.parse(readFileSync(path, "utf8"));

const stages = { Developer: "developer-agent", QA: "qa-agent", Architect: "architecture-agent", "UAT/Product": "uat-agent" };
export function readProviderSessions(setup, journals, { sha256, digest }) {
  const { config, providerDirectory } = setup;
  return readdirSync(providerDirectory).filter(name => existsSync(join(providerDirectory, name, "intent.json"))).map(name => {
    const base = join(providerDirectory, name), intent = read(join(base, "intent.json")), envelope = read(join(base, "terminal.json"));
    const terminal = envelope.terminal;
    assert.equal(intent.version, 1);
    assert.equal(intent.attempt, name);
    assert.equal(envelope.sha256, digest(terminal), "Provider terminal bytes do not match their receipt.");
    assert.ok(["COMPLETED", "TRANSPORT_FAILED", "CANCELLED", "EFFECT_REFUSED", "MALFORMED", "RETIRED"].includes(terminal.status));
    assert.equal(terminal.binding, intent.binding);
    assert.equal(intent.projectIdentity, config.projectIdentity);
    assert.equal(intent.configDigest, setup.expectedProviderConfigDigest);
    assert.equal(intent.provider, "local-llama.cpp", "Only the supported actual local runtime establishes this proof.");
    assert.ok(setup.providerIdentity, "Pinned provider identity is required.");
    for (const field of ["runtimeVersion", "model", "modelSha256"]) {
      assert.ok(typeof setup.providerIdentity[field] === "string" && setup.providerIdentity[field].length > 0);
      assert.equal(intent[field], setup.providerIdentity[field]);
    }
    const stage = stages[intent.role]; assert.ok(stage);
    const matches = journals.filter(journal => journal.values?.start?.taskId &&
      digest([config.projectIdentity, journal.values.start.taskId, intent.role, journal.runId + "::" + stage]) === intent.attempt);
    assert.equal(matches.length, 1, "Provider attempt has no unique original native run.");
    const journal = matches[0], taskId = journal.values.start.taskId, runId = journal.runId + "::" + stage;
    const cached = journal.values[stage];
    if (terminal.status === "COMPLETED") {
      assert.ok(cached?.result, "Completed provider result has no accepted native cache.");
      assert.deepEqual(terminal.result, cached.result, "Provider result differs from the owning runner's result.");
      assert.equal(terminal.result.runId, runId);
      assert.equal(terminal.result.taskId, taskId);
      assert.equal(terminal.result.role, intent.role);
      assert.equal(terminal.result.providerId, intent.provider);
      assert.equal(terminal.result.revisionIdentity, intent.revision);
    } else assert.equal(terminal.result, undefined);
    return { taskId, role: intent.role, session: intent.session, attempt: intent.attempt, runId,
      revision: intent.revision, outcome: terminal.result?.outcome ?? null, status: terminal.status,
      actorId: cached?.actorId ?? null, contextPackageId: cached?.contextId ?? null,
      providerConfigDigest: intent.configDigest, startedAt: intent.occurredAt,
      provider: intent.provider, runtimeVersion: intent.runtimeVersion, model: intent.model, modelSha256: intent.modelSha256,
      intentSha256: sha256(readFileSync(join(base, "intent.json"))), terminalSha256: sha256(readFileSync(join(base, "terminal.json"))) };
  });
}

/** Redacted projection of original native records plus fresh authenticated GitHub reads. */
export async function collectCompletion(setup, kit) {
  const { githubRead, assertLiveChain, fileInventory, sha256, digest, put, git } = kit;
  const { services, policy, plan, operationId, projectRoot: root, config, providerDirectory, outputDirectory } = setup;
  const repository = config.document.project.repository, integrationRef = config.document.policy.integrationTarget;
  const token = await setup.readToken();
  const get = suffix => githubRead(repository, suffix, token);
  assert.equal(setup.verifyDrained(), true, "Original external writers must be verified drained.");
  const operation = services.operations.inspect(operationId);
  assert.equal(operation.status, "DONE");
  const evidenceRoot = config.paths.evidence;
  const stateRoot = config.paths.state;
  const journals = fileInventory(join(config.paths.operations, "orchestration"))
    .filter(row => row.path.endsWith(".run.json")).map(row => read(join(config.paths.operations, "orchestration", row.path)));
  const sessions = readProviderSessions(setup, journals, kit);
  const histories = fileInventory(evidenceRoot).filter(row => row.path.endsWith(".json")).map(row => {
    const record = read(join(evidenceRoot, row.path));
    return { ...record, originalSha256: row.sha256 };
  });
  const tasks = [];
  for (const entry of plan.tasks) {
    const audit = await services.diagnostics.audit(entry.taskId);
    assert.deepEqual(audit.findings, [], "Native history integrity must pass before evidence export.");
    const definition = services.registry.get(entry.taskId);
    assert.ok(definition);
    const records = histories.filter(row => row.payload?.taskId === entry.taskId);
    const mergeRecords = records.filter(row => row.payload.schemaId === "ipt.merge-evidence");
    assert.equal(mergeRecords.length, 1, "Expected one native controlled completion.");
    const merge = mergeRecords[0].payload, head = merge.revisionIdentity;
    const pr = await get("/pulls/" + merge.pullRequestNumber);
    assert.equal(pr.head.repo.full_name, repository);
    assert.equal(pr.base.repo.full_name, repository);
    git(root, "merge-base", "--is-ancestor", merge.mergeCommitSha, "HEAD");
    const checks = [];
    for (let page = 1; ; page++) {
      assert.ok(page <= 20, "Too many check-run pages; inspect without accepting truncated evidence.");
      const response = await get("/commits/" + head + "/check-runs?filter=latest&per_page=100&page=" + page);
      checks.push(...response.check_runs.map(run => ({ id: run.id, name: run.name, headSha: run.head_sha,
        status: run.status, conclusion: run.conclusion, appId: run.app?.id, url: run.html_url })));
      if (checks.length >= response.total_count) break;
      assert.ok(response.check_runs.length > 0, "Incomplete CI evidence pagination.");
    }
    const finalRoles = ["QA", "Architect", "UAT/Product"].map(role => {
      const matches = records.filter(row => row.payload.role === role).sort((a,b)=>b.sequence-a.sequence);
      assert.ok(matches.length);
      const record = matches[0], payload = record.payload;
      assert.equal(payload.revisionIdentity, head, "Latest judgment is stale.");
      assert.equal(payload.outcome, "PASS", "Latest judgment does not approve completion.");
      const session = sessions.find(item => item.taskId === entry.taskId && item.role === role && item.revision === head &&
        payload.evidenceRefs?.includes("local-llama:" + item.attempt));
      assert.ok(session, "Native judgment must bind a real independently recorded provider attempt.");
      assert.equal(payload.reviewerId, session.actorId);
      assert.equal(payload.contextPackageId, session.contextPackageId);
      assert.equal(payload.reviewId, entry.taskId + ":" + role + ":" + head + ":" + session.runId);
      return { role, actorId: payload.reviewerId, session: session.session, revision: head, outcome: payload.outcome,
        contextPackageId: payload.contextPackageId, runId: session.runId, evidenceRef: record.lineageId + "@" + record.sequence, sha256: record.originalSha256 };
    });
    const validators = [...new Set(records.filter(row=>row.payload.schemaId === "ipt.validation-evidence").map(row=>row.lineageId))]
      .map(lineage => records.filter(row=>row.lineageId===lineage).sort((a,b)=>b.sequence-a.sequence)[0])
      .map(record=>({ evidenceRef: record.lineageId + "@" + record.sequence,
        outcome: record.payload.outcome, revision: record.payload.revisionIdentity, id: record.payload.validatorId, sha256: record.originalSha256 }));
    assert.deepEqual(validators.map(item => item.evidenceRef.split("::validator::")[1]?.split("@")[0]).sort(),
      config.document.validators.map(item => item.id).sort(), "Every declared validator must have current native evidence.");
    tasks.push({ taskId: entry.taskId, dependencies: definition.dependencies, branch: definition.canonicalBranch, state: audit.state,
      sourceRevision: head, mergeCommitSha: merge.mergeCommitSha, developerActorId: merge.assignmentLockAtMerge.ownerId,
      reviews: finalRoles, validators, checks, nativeAudit: audit, nativeAuditSha256: digest(audit),
      pr: { number: pr.number, url: pr.html_url, repository, baseRef: pr.base.ref, headRef: pr.head.ref,
        headSha: pr.head.sha, merged: pr.merged, draft: pr.draft, mergedAt: pr.merged_at, mergeCommitSha: pr.merge_commit_sha } });
  }
  const before = { lifecycle: digest(fileInventory(stateRoot)), provider: digest(fileInventory(providerDirectory)),
    policy: digest(policy.decisions()), evidence: digest(fileInventory(evidenceRoot)), operations: digest(fileInventory(config.paths.operations)),
    host: digest(setup.hostAudit()) };
  assert.deepEqual(await services.operations.start(plan.planId, operationId), operation);
  const after = { lifecycle: digest(fileInventory(stateRoot)), provider: digest(fileInventory(providerDirectory)),
    policy: digest(policy.decisions()), evidence: digest(fileInventory(evidenceRoot)), operations: digest(fileInventory(config.paths.operations)),
    host: digest(setup.hostAudit()) };
  assert.deepEqual(after, before, "DONE replay must not create another authority effect.");
  for (const task of tasks) {
    const prs = await get("/pulls?state=all&head=" + encodeURIComponent(repository.split("/")[0] + ":" + task.branch) + "&per_page=100");
    assert.equal(prs.length, 1, "The chain must not create duplicate PRs.");
    assert.equal(prs[0].number, task.pr.number);
    const pr = await get("/pulls/" + task.pr.number);
    assert.equal(pr.merge_commit_sha, task.mergeCommitSha);
  }
  const report = { schemaId: "vibez.unattended-acceptance", schemaVersion: "1.0.0",
    evidenceKind: "LIVE_GITHUB_INSTALLED_CHAIN", observedAt: new Date().toISOString(), repository, integrationRef,
    package: setup.receipt.candidate, installedTreeSha256: setup.receipt.installedTreeSha256,
    configurationDigest: config.configDigest, providerConfigurationDigest: setup.expectedProviderConfigDigest, projectIdentity: config.projectIdentity, grantDigest: policy.grantDigest,
    planDigest: digest(plan), setupSha256: setup.setupSha256, operation: kit.redactOperation(operation), tasks, sessions,
    operationAudit: services.operations.audit(operationId).map(kit.redactOperation),
    requiredChecks: setup.requiredChecks, requiredValidators: config.document.validators.map(item=>item.id),
    interventions: setup.readInterventions(), operatorAttestation: setup.readOperatorAttestation(),
    commandAudit: setup.commandLog(), hostAudit: setup.hostAudit(),
    replay: { noNewEffects: true, lifecycleBefore: before.lifecycle, lifecycleAfter: after.lifecycle,
      providerBefore: before.provider, providerAfter: after.provider, policyBefore: before.policy, policyAfter: after.policy,
      evidenceBefore: before.evidence, evidenceAfter: after.evidence, operationsBefore: before.operations, operationsAfter: after.operations, hostBefore: before.host, hostAfter: after.host } };
  assertLiveChain(report);
  const path = join(outputDirectory, "live-chain-" + operationId + ".json");
  if (existsSync(path)) {
    // Inspection is repeatable; keep the originally observed immutable report.
    const original = read(path); assertLiveChain(original);
    // Later read-only inspection can add command observations but cannot replace
    // the candidate, task, session, native authority or original attestation.
    for (const key of ["evidenceKind", "repository", "integrationRef", "package", "installedTreeSha256",
      "configurationDigest", "providerConfigurationDigest", "projectIdentity", "grantDigest", "planDigest",
      "setupSha256", "operation", "tasks", "sessions", "operationAudit", "requiredChecks",
      "requiredValidators", "interventions", "operatorAttestation", "replay"])
      assert.deepEqual(report[key], original[key], "Original acceptance identity changed: " + key);
    assert.deepEqual(report.hostAudit.slice(0, original.hostAudit.length), original.hostAudit);
    assert.ok(report.hostAudit.slice(original.hostAudit.length).every(row => row.record.kind === "protection-observed"));
    assert.deepEqual(report.commandAudit.slice(0, original.commandAudit.length), original.commandAudit);
    assert.ok(report.commandAudit.slice(original.commandAudit.length).every(row => row.record.details.command === "inspect"));
  } else put(path, report);
  console.log(JSON.stringify({ outcome: "PASS", evidenceKind: report.evidenceKind, report: path, sha256: sha256(readFileSync(path)) }));
  return report;
}
