import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCandidate } from "./unattended-package.mjs";
import { controlClient, ownControlChannel } from "./unattended-host-control.mjs";
import { below, digest, git, githubObservation, json, pinnedFile, regular, safeEnvironment, sha256,
  validateCredential, validateSettings } from "./unattended-host-io.mjs";

export function pushAfterObservation(observe, authorize, push) {
  observe();
  authorize();
  return push();
}
/** GitHub cannot list checks for a commit it has not received. Keep that
 * known prepublication state distinct from a hosted CI transport failure. */
export async function readAcceptanceChecks(ci, ref, checkName, isUnpublishedHead) {
  const confirmsUnpublishedHead = (revision, check) => {
    try { return isUnpublishedHead(revision, check) === true; }
    catch { return false; } // A failed independent observation preserves the original CI error.
  };
  try { return await ci.listCheckRuns(ref, checkName); }
  catch (error) {
    if (error?.name !== "CiStatusProviderError" || error.code !== "PROVIDER_ERROR" ||
        error.status !== 422 || !/^[a-f0-9]{40}$/.test(ref) ||
        error.message !== "GitHub check-runs request failed (422): No commit found for SHA: " + ref ||
        !confirmsUnpublishedHead(ref, checkName)) throw error;
    return Object.freeze([]); // Missing evidence never satisfies merge readiness.
  }
}
/** Keep draft creation in the acceptance transport; the shared PR adapter
 * intentionally leaves readiness policy to its caller. */
export function draftPublicationFetch(repository, send) {
  const createUrl = "https://api.github.com/repos/" + repository + "/pulls";
  return (url, init = {}) => {
    if (init.method !== "POST" || url !== createUrl) return send(url, init);
    const body = JSON.parse(init.body);
    assert.ok(body && typeof body === "object" && !Array.isArray(body), "Invalid PR creation body.");
    assert.ok(body.draft === undefined || body.draft === true, "Acceptance cannot create a ready PR.");
    return send(url, { ...init, body: JSON.stringify({ ...body, draft: true }) });
  };
}
export const markerValidatorCode = "const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));if(x.content!=='status=ready\\n')process.exit(1);process.stdout.write('Exact marker content PASS\\n');";
const roleNames = ["Developer", "QA", "Architect", "UAT/Product"];
export function hostDrained(providerDirectory, hostDirectory, activeCount = 0) {
  if (activeCount !== 0 || existsSync(join(providerDirectory, "active")) || existsSync(join(providerDirectory, "mutating")) ||
    existsSync(join(hostDirectory, "source-effect.lock")) ||
    existsSync(join(hostDirectory, "pending-effects")) && readdirSync(join(hostDirectory, "pending-effects")).length > 0 ||
    readdirSync(hostDirectory).some(name => name.startsWith("source-index-"))) return false;
  try {
    return readdirSync(providerDirectory).every(name => {
      const directory = join(providerDirectory, name);
      const stat = lstatSync(directory);
      if (!/^[a-f0-9]{64}$/.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) return false;
      const intent = json(regular(join(directory, "intent.json"))), record = json(regular(join(directory, "terminal.json")));
      return intent.attempt === name && intent.version === 1 && record.sha256 === digest(record.terminal) &&
        record.terminal.binding === intent.binding &&
        ["COMPLETED", "TRANSPORT_FAILED", "CANCELLED", "EFFECT_REFUSED", "MALFORMED", "RETIRED"].includes(record.terminal.status);
    });
  } catch { return false; }
}
const writeRecord = (path, value) => {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
};
export function readHostJournal(directory, operationId, grantDigest) {
  const names = readdirSync(directory).sort();
  let previousSha256 = null;
  return names.map((name, index) => {
    assert.equal(name, String(index + 1).padStart(12, "0") + ".json", "Host journal is incomplete.");
    const row = json(regular(join(directory, name)));
    assert.equal(row.sha256, digest(row.record)); assert.equal(row.record.sequence, index + 1);
    assert.equal(row.record.operationId, operationId); assert.equal(row.record.grantDigest, grantDigest);
    assert.equal(row.record.previousSha256, previousSha256);
    previousSha256 = row.sha256; return row;
  });
}
export function appendHostJournal(directory, operationId, grantDigest, kind, details) {
  const prior = readHostJournal(directory, operationId, grantDigest);
  const record = { sequence: prior.length + 1, operationId, grantDigest, previousSha256: prior.at(-1)?.sha256 ?? null,
    kind, occurredAt: new Date().toISOString(), details };
  const row = { record, sha256: digest(record) };
  writeRecord(join(directory, String(record.sequence).padStart(12, "0") + ".json"), row);
  return row;
}

/** Trusted host only. Inputs are an operator-approved setup, never a model response or task document. */
export async function openAcceptance(settingsFile, { command: requestedCommand = "start" } = {}) {
  assert.ok(["start", "resume", "inspect", "pause", "drain", "cancel"].includes(requestedCommand));
  assert.equal(process.platform, "linux", "The supported host requires Linux with local filesystem isolation.");
  regular(realpathSync(settingsFile));
  const settings = validateSettings(json(settingsFile));
  const projectRoot = realpathSync(settings.projectRoot), hostDirectory = realpathSync(settings.hostDirectory);
  assert.equal(projectRoot, settings.projectRoot);
  assert.equal(hostDirectory, settings.hostDirectory);
  assert.ok(!below(projectRoot, hostDirectory) && !below(hostDirectory, projectRoot), "Host state and checkout must be separate.");
  assert.equal(lstatSync(hostDirectory).mode & 0o077, 0, "Host state must be private to its owner.");
  for (const field of ["assets", "grant", "plan", "tokenIssuer"]) {
    pinnedFile(settings[field]);
    assert.ok(!below(projectRoot, settings[field].path), "Authority and credentials must remain outside the project.");
  }
  assert.ok(below(hostDirectory, settings.controlsFile));
  const verificationParent = mkdtempSync(join(hostDirectory, "package-verification-"));
  const receipt = verifyCandidate(settings.candidateFile, settings.installedDirectory, join(verificationParent, "package"));
  const publicImport = async name => {
    const target = receipt.manifest.exports[name]?.import?.default;
    assert.ok(typeof target === "string" && /^\.\/dist\/public\/[a-z-]+[.]js$/.test(target));
    return import(pathToFileURL(join(receipt.installed, target)).href);
  };
  const { createProjectServices } = await publicImport(".");
  const { resolveProjectConfig } = await publicImport("./config");
  const { createLocalLlamaRuntime, LOCAL_LLAMA_PROVIDER_ID } = await publicImport("./providers");
  const { ScopedHostPolicy, commandPolicyDigest, verifyGitHubProtection, GitHubPullRequestOperations,
    GitHubMergeReadinessPullRequestOperations, GitHubCiStatusOperations, GitHubControlledMergePullRequestOperations } = await publicImport("./integration");
  const location = { projectRoot, configPath: "vibez.config.json" };
  const config = resolveProjectConfig(location), document = config.document;
  assert.equal(document.project.repository, settings.repository);
  assert.equal(document.policy.integrationTarget, settings.integrationRef);
  assert.equal(document.providers.execution, LOCAL_LLAMA_PROVIDER_ID);
  assert.deepEqual(document.policy.requiredChecks, settings.requiredChecks.map(check => check.name));
  assert.deepEqual(document.policy.reviewRoles, roleNames.slice(1));
  const grant = json(pinnedFile(settings.grant)), plan = json(pinnedFile(settings.plan)), assets = json(pinnedFile(settings.assets));
  assert.equal(grant.projectIdentity, config.projectIdentity);
  assert.equal(grant.configDigest, config.configDigest);
  assert.equal(grant.repository, settings.repository);
  assert.equal(grant.integrationRef, settings.integrationRef);
  assert.equal(plan.tasks.length, 2);
  const tasks = plan.tasks.map(entry => {
    const file = readdirSync(config.paths.tasks).find(name => name.endsWith(".task.json") && json(join(config.paths.tasks, name)).taskId === entry.taskId);
    assert.ok(file, "The approved task definition is missing.");
    const task = json(regular(join(config.paths.tasks, file)));
    assert.equal(digest(task), entry.definitionSha256);
    assert.equal(task.allowedPaths.length, 1);
    assert.match(task.allowedPaths[0], /^marker-[12][.]txt$/);
    assert.deepEqual(grant.tasks.find(scope => scope.taskId === task.taskId),
      { taskId: task.taskId, branch: task.canonicalBranch, paths: task.allowedPaths });
    return task;
  });
  assert.deepEqual(tasks.map(t => t.taskId), ["PROOF-001", "PROOF-002"]);
  assert.deepEqual(tasks.map(t => t.dependencies), [[], ["PROOF-001"]]);
  assert.deepEqual(tasks.map(t => t.allowedPaths[0]), ["marker-1.txt", "marker-2.txt"]);
  assert.equal(new Set(tasks.map(t => t.canonicalBranch)).size, 2);
  assert.equal(new Set(plan.tasks.map(t => t.issueNumber)).size, 2);
  git(projectRoot, ["merge-base", "--is-ancestor", settings.seedRevision, "HEAD"]);
  const providerDirectory = join(hostDirectory, "provider"), ledger = join(hostDirectory, "ledger"),
    outputDirectory = join(hostDirectory, "reports"), effectDirectory = join(hostDirectory, "effects"),
    commandDirectory = join(hostDirectory, "commands"), pendingDirectory = join(hostDirectory, "pending-effects");
  for (const path of [providerDirectory, ledger, outputDirectory, effectDirectory, commandDirectory, pendingDirectory]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    assert.equal(realpathSync(path), path);
    assert.equal(lstatSync(path).mode & 0o077, 0);
  }
  const controlBinding = { operationId: settings.operationId, grantDigest: digest(grant),
    settingsSha256: sha256(readFileSync(settingsFile)), packageSha256: receipt.candidate.sha256 };
  if (["inspect", "pause", "drain", "cancel"].includes(requestedCommand) && existsSync(join(ledger, "host.lease"))) {
    const client = await controlClient({ hostDirectory, binding: controlBinding });
    return { controlOnly: true, services: { operations: client.operations }, close: client.close,
      operationId: settings.operationId, plan, projectRoot, config, providerDirectory, outputDirectory, receipt,
      requiredChecks: settings.requiredChecks, setupSha256: controlBinding.settingsSha256,
      candidateFile: settings.candidateFile, installedDirectory: settings.installedDirectory };
  }
  const issuer = await import(pathToFileURL(pinnedFile(settings.tokenIssuer)).href);
  assert.equal(typeof issuer.issue, "function");
  const credentials = Object.fromEntries(await Promise.all(["publisher", "worker", "controller"].map(async role =>
    [role, validateCredential(await issuer.issue(role), role, settings.repository, settings.controllerAppId)])));
  assert.equal(new Set(Object.values(credentials).map(c => c.token)).size, 3, "Publisher, worker and controller credentials must be distinct.");
  const token = role => validateCredential(credentials[role], role, settings.repository, settings.controllerAppId).token;
  const [owner, repo] = settings.repository.split("/");
  const remoteUrl = "https://github.com/" + settings.repository + ".git";
  assert.equal(git(projectRoot, ["remote", "get-url", "--all", document.policy.remote]), remoteUrl);
  assert.equal(git(projectRoot, ["remote", "get-url", "--push", "--all", document.policy.remote]), remoteUrl);
  const command = { kind: "command", validatorId: "marker", required: true, category: "test",
    command: process.execPath, args: ["-e", markerValidatorCode], cwd: projectRoot, timeoutMs: 10000 };
  assert.deepEqual(grant.validators, [{ id: "marker", commandDigest: commandPolicyDigest(command) }]);
  assert.deepEqual(document.validators, [{ id: "marker", executorId: "marker", required: true }]);
  assert.deepEqual(grant.roles.map(role => role.role), roleNames);
  for (const role of grant.roles) {
    assert.equal(role.provider, LOCAL_LLAMA_PROVIDER_ID); assert.equal(role.model, assets.model);
    assert.equal(role.network, "none");
    assert.deepEqual(role.tools, role.role === "Developer" ? ["snapshot.read", "workspace.replace"] : ["snapshot.read"]);
  }
  const controls = () => {
    regular(settings.controlsFile);
    const value = json(settings.controlsFile);
    assert.deepEqual(Object.keys(value).sort(), ["enabled", "grantDigest", "revoked"]);
    assert.equal(value.grantDigest, digest(grant));
    assert.equal(typeof value.enabled, "boolean"); assert.equal(typeof value.revoked, "boolean");
    return value;
  };
  controls();
  let active = 0, observationCache;
  const verifyDrained = () => hostDrained(providerDirectory, hostDirectory, active);
  const protection = number => {
    token("worker"); // Metadata describes an actual issuer-narrowed token; no token enters any worker.
    if (!observationCache || Date.now() - observationCache.observedAtMs > 28000 || observationCache.pullRequest?.number !== number) {
      observationCache = githubObservation({ repository: settings.repository, integrationRef: settings.integrationRef,
        token: token("publisher"), ...(number === undefined ? {} : { pullRequestNumber: number }) });
      assert.equal(observationCache.branch.ref, "refs/heads/" + settings.integrationRef);
      assert.equal(observationCache.branch.object.sha, git(projectRoot, ["rev-parse", "refs/heads/" + settings.integrationRef]),
        "The remote integration base moved; synchronize only through the original owning gate.");
      recordEffect("protection-observed", { repository: observationCache.repository, integrationRef: observationCache.integrationRef,
        observedAtMs: observationCache.observedAtMs, rules: observationCache.rules, rulesets: observationCache.rulesets,
        workerPermissions: [credentials.worker.permissions], baseRevision: observationCache.branch.object.sha,
        ...(observationCache.pullRequest ? { pullRequest: { number: observationCache.pullRequest.number,
          head: observationCache.pullRequest.head.sha, base: observationCache.pullRequest.base.ref } } : {}) });
    }
    const snapshot = { ...observationCache, workerPermissions: [credentials.worker.permissions] };
    verifyGitHubProtection(snapshot, { repository: settings.repository, integrationRef: settings.integrationRef,
      nowMs: Date.now(), maxAgeMs: 30000, controllerAppId: settings.controllerAppId,
      trustedCheckSources: Object.fromEntries(settings.requiredChecks.map(check => [check.name, check.appId])) });
    return snapshot;
  };
  const assertDiff = task => {
    const base = git(projectRoot, ["rev-parse", "refs/heads/" + settings.integrationRef]);
    git(projectRoot, ["merge-base", "--is-ancestor", base, "HEAD"]);
    const changed = git(projectRoot, ["diff", "--name-only", "-z", base, "HEAD"]).split("\0").filter(Boolean);
    assert.ok(changed.every(path => task.allowedPaths.includes(path)), "The exact candidate diff exceeds its one-file grant.");
  };
  const policy = new ScopedHostPolicy({ grant, ledgerDirectory: ledger, worktreeRoot: projectRoot, verifyDrained,
    observe(operation) {
      pinnedFile(settings.grant); pinnedFile(settings.plan); pinnedFile(settings.assets); pinnedFile(settings.tokenIssuer);
      const revision = git(projectRoot, ["rev-parse", "HEAD"]), branch = git(projectRoot, ["branch", "--show-current"]);
      config.assertCurrent(revision);
      const task = tasks.find(t => t.taskId === operation.taskId);
      assert.ok(task, "The operation is outside the approved proof chain.");
      const remoteAction = ["push", "publish", "ready", "merge"].includes(operation.action);
      if (remoteAction) { assert.equal(git(projectRoot, ["status", "--porcelain"]), ""); assertDiff(task); }
      const observed = remoteAction ? protection(operation.pullRequestNumber) : undefined;
      const pr = observed?.pullRequest;
      if (pr) {
        assert.equal(pr.head.repo.full_name, settings.repository); assert.equal(pr.base.repo.full_name, settings.repository);
      }
      return { projectIdentity: config.projectIdentity, configDigest: config.configDigest, repository: document.project.repository,
        integrationRef: document.policy.integrationTarget, revision, branch, ...controls(), checks: document.policy.requiredChecks,
        validators: [{ id: "marker", commandDigest: commandPolicyDigest(command) }], reviews: document.policy.reviewRoles,
        ...(pr ? { pullRequest: { number: pr.number, revision: pr.head.sha, head: pr.head.ref, base: pr.base.ref,
          open: pr.state === "open", ready: !pr.draft, protectionsVerified: true } } : {}) };
    } });
  const recordEffect = (kind, value) => appendHostJournal(effectDirectory, settings.operationId, policy.grantDigest, kind, value);
  const commandLog = () => readHostJournal(commandDirectory, settings.operationId, policy.grantDigest);
  const recordCommand = command => {
    assert.ok(["start", "resume", "inspect", "pause", "drain", "cancel"].includes(command));
    return appendHostJournal(commandDirectory, settings.operationId, policy.grantDigest, "command", { command, scenario: "live-chain" });
  };
  const readInterventions = () => {
    const register = json(regular(join(hostDirectory, "interventions.json")));
    assert.equal(register.operationId, settings.operationId); assert.ok(Array.isArray(register.entries));
    for (const entry of register.entries) {
      assert.ok(typeof entry.actor === "string" && entry.actor.length && Number.isFinite(Date.parse(entry.occurredAt)));
      assert.ok(typeof entry.description === "string" && entry.description.length);
      assert.ok(["routine-handoff", "exception-intervention", "scenario-control"].includes(entry.kind));
    }
    return register.entries;
  };
  const readOperatorAttestation = () => json(regular(join(hostDirectory, "operator-attestation.json")));
  const pendingEffect = (kind, details) => {
    const record = recordEffect(kind + "-intent", details);
    const path = join(pendingDirectory, record.sha256 + ".json");
    writeRecord(path, record);
    return () => { recordEffect(kind + "-settled", { intentSha256: record.sha256 }); unlinkSync(path); };
  };
  const runValidator = async (spec, capability) => {
    assert.equal(commandPolicyDigest(spec), commandPolicyDigest(command));
    capability.signal.throwIfAborted(); capability.assertAuthorized();
    const revision = git(projectRoot, ["rev-parse", "HEAD"]), branch = git(projectRoot, ["branch", "--show-current"]);
    const task = tasks.find(t => t.canonicalBranch === branch); assert.ok(task);
    const path = regular(join(projectRoot, task.allowedPaths[0]));
    const content = readFileSync(path, "utf8");
    active++;
    let status = "FAIL";
    try {
      // Only this pinned host-owned program runs. Repository bytes are data on stdin.
      execFileSync(spec.command, spec.args, { cwd: spec.cwd, env: safeEnvironment(),
        input: JSON.stringify({ content }), timeout: spec.timeoutMs, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
      capability.assertAuthorized(); capability.signal.throwIfAborted();
      assert.equal(git(projectRoot, ["rev-parse", "HEAD"]), revision);
      assert.equal(git(projectRoot, ["status", "--porcelain"]), "");
      status = "PASS"; return { status, details: "Pinned host validator compared the committed task marker with its exact acceptance bytes." };
    } catch { return { status, details: "Exact marker validation failed or its authorization/revision changed." }; }
    finally { active--; recordEffect("validator", { taskId: task.taskId, revision, commandDigest: commandPolicyDigest(spec), status, occurredAt: new Date().toISOString() }); }
  };
  try {
    const { runtime } = await createLocalLlamaRuntime({ repositoryRoot: projectRoot, projectIdentity: config.projectIdentity,
      operationDirectory: providerDirectory, assets, contextTokens: 16384, outputTokens: 1024,
      snapshotPaths: request => [...tasks.find(t => t.taskId === request.taskId).allowedPaths],
      editablePath: request => tasks.find(t => t.taskId === request.taskId).allowedPaths[0],
      replaceFile(edit, { expectedRevision, expectedBranch, signal }) {
        const task = tasks.find(t => t.canonicalBranch === expectedBranch); assert.ok(task);
        assert.deepEqual(task.allowedPaths, [edit.path]);
        const file = regular(join(projectRoot, edit.path)), mode = lstatSync(file).mode & 0o777;
        const lock = join(hostDirectory, "source-effect.lock"), fd = openSync(lock, "wx", 0o600);
        let settled = false;
        active++;
        try {
          assert.equal(git(projectRoot, ["rev-parse", "HEAD"]), expectedRevision);
          assert.equal(git(projectRoot, ["branch", "--show-current"]), expectedBranch);
          assert.equal(git(projectRoot, ["status", "--porcelain"]), "");
          assertDiff(task); signal.throwIfAborted();
          recordEffect("commit-intent", { taskId: task.taskId, parent: expectedRevision, path: edit.path, sha256: sha256(edit.content) });
          const index = join(hostDirectory, "source-index-" + expectedRevision);
          assert.ok(!existsSync(index), "An earlier file effect needs reconciliation.");
          const env = { GIT_INDEX_FILE: index };
          git(projectRoot, ["read-tree", expectedRevision], { env });
          const blob = git(projectRoot, ["hash-object", "-w", "--stdin"], { input: edit.content });
          const gitMode = git(projectRoot, ["ls-tree", expectedRevision, "--", edit.path]).split(" ")[0];
          assert.equal(gitMode, "100644");
          git(projectRoot, ["update-index", "--cacheinfo", gitMode + "," + blob + "," + edit.path], { env });
          const tree = git(projectRoot, ["write-tree"], { env });
          const revision = git(projectRoot, ["commit-tree", tree, "-p", expectedRevision, "-m", "Implement " + task.taskId + " through the isolated provider"]);
          signal.throwIfAborted();
          assert.equal(git(projectRoot, ["status", "--porcelain"]), "");
          const control = controls();
          assert.ok(control.enabled && !control.revoked && Date.now() >= grant.notBeforeMs && Date.now() < grant.expiresAtMs);
          pinnedFile(settings.grant);
          git(projectRoot, ["update-ref", "refs/heads/" + expectedBranch, revision, expectedRevision]);
          writeFileSync(file, edit.content, { mode });
          git(projectRoot, ["read-tree", revision]);
          assert.equal(git(projectRoot, ["status", "--porcelain"]), "");
          recordEffect("commit", { taskId: task.taskId, parent: expectedRevision, revision, path: edit.path, sha256: sha256(edit.content) });
          unlinkSync(index); settled = true;
          return { status: "COMMITTED", revision };
        } finally { active--; closeSync(fd); if (settled) unlinkSync(lock); }
      }, runValidator });
    const fetchFor = role => async (url, init = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://api.github.com"); assert.ok(!parsed.username && !parsed.password);
      assert.ok(parsed.pathname.startsWith("/repos/" + settings.repository + "/") || parsed.pathname === "/graphql");
      const method = init.method ?? "GET";
      if (role === "controller" && method !== "GET") {
        const match = new RegExp("^/repos/" + settings.repository + "/pulls/([0-9]+)/merge$").exec(parsed.pathname);
        assert.ok(match && method === "PUT", "Controller credential is restricted to the native merge endpoint.");
        observationCache = undefined;
        const body = JSON.parse(init.body), observed = protection(Number(match[1])), pr = observed.pullRequest;
        assert.equal(body.sha, git(projectRoot, ["rev-parse", "HEAD"]));
        assert.equal(pr.head.sha, body.sha); assert.equal(pr.base.ref, settings.integrationRef);
        assert.ok(tasks.some(task => task.canonicalBranch === pr.head.ref));
        const control = controls();
        assert.ok(control.enabled && !control.revoked && Date.now() >= grant.notBeforeMs && Date.now() < grant.expiresAtMs);
      } else if (role === "publisher" && method !== "GET") {
        if (parsed.pathname === "/graphql") {
          assert.equal(method, "POST");
          assert.match(JSON.parse(init.body).query, /markPullRequestReadyForReview/);
        } else {
          assert.ok(["POST", "PATCH"].includes(method) && new RegExp("^/repos/" + settings.repository + "/pulls(?:/[0-9]+)?$").test(parsed.pathname));
          const body = JSON.parse(init.body);
          if (method === "POST") {
            assert.equal(body.base, settings.integrationRef); assert.equal(body.draft, true);
            assert.ok(tasks.some(task => task.canonicalBranch === body.head));
          }
        }
      }
      const headers = { ...init.headers, Authorization: "Bearer " + token(role) };
      const settle = method === "GET" ? () => {} : pendingEffect("github", { role, method, path: parsed.pathname,
        requestSha256: sha256(init.body ?? "") });
      active++;
      try {
        const response = await fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30000), redirect: "error" });
        if (method !== "GET") recordEffect("github-response", { role, method, path: parsed.pathname, httpStatus: response.status });
        settle(); return response;
      }
      catch { const error = new Error("GitHub transport did not confirm its original effect."); error.code = "TRANSPORT_ERROR"; throw error; }
      finally { active--; }
    };
    const publisherOptions = { owner, repo, token: token("publisher"), fetchImpl: fetchFor("publisher") };
    const controllerOptions = { owner, repo, token: token("controller"), fetchImpl: fetchFor("controller") };
    const githubCi = new GitHubCiStatusOperations(publisherOptions);
    const isUnpublishedHead = (ref, checkName) => {
      if (!settings.requiredChecks.some(check => check.name === checkName)) return false;
      const branch = git(projectRoot, ["branch", "--show-current"]);
      const task = tasks.find(task => task.canonicalBranch === branch);
      if (!task || git(projectRoot, ["rev-parse", "HEAD"]) !== ref ||
          git(projectRoot, ["status", "--porcelain"]) !== "") return false;
      const remoteRef = "refs/heads/" + branch;
      const history = readHostJournal(effectDirectory, settings.operationId, policy.grantDigest);
      if (!history.some(({ record }) => record.kind === "commit" &&
          record.details.taskId === task.taskId && record.details.revision === ref) ||
          history.some(({ record }) => record.kind === "push-intent" && record.details.ref === remoteRef) ||
          readdirSync(pendingDirectory).length !== 0) return false;
      assert.equal(git(projectRoot, ["remote", "get-url", "--all", document.policy.remote]), remoteUrl);
      const remote = git(projectRoot, ["ls-remote", "--refs", remoteUrl, remoteRef], { token: token("publisher") });
      if (remote !== "" || git(projectRoot, ["branch", "--show-current"]) !== branch ||
          git(projectRoot, ["rev-parse", "HEAD"]) !== ref || git(projectRoot, ["status", "--porcelain"]) !== "") return false;
      recordEffect("ci-not-published", { taskId: task.taskId, branch, revision: ref, check: checkName });
      return true;
    };
    const host = { identity: "vibez-unattended-acceptance@1:" + sha256(readFileSync(new URL(import.meta.url))),
      verifiedArtifactSha256: receipt.candidate.sha256, requirePassingDeveloperResult: true,
      actorIdFor: (role, ownerId) => grant.roles.find(r => r.role === role)?.principal ?? ownerId + "::native-controller",
      toolPermissionPolicyFor: role => ({ allowedTools: grant.roles.find(r => r.role === role)?.tools ?? [], networkAccess: "none" }),
      executors: new Map([["marker", { command: command.command, args: command.args, category: command.category, timeoutMs: command.timeoutMs }]]),
      authorizePublication: request => request.repository === settings.repository && tasks.some(t => t.taskId === request.taskId),
      authorizeMerge: request => request.repository === settings.repository && Number.isSafeInteger(request.number) && /^[a-f0-9]{40}$/.test(request.expectedHeadSha),
      integration: { repository: settings.repository, publication: new GitHubPullRequestOperations({
          ...publisherOptions, fetchImpl: draftPublicationFetch(settings.repository, publisherOptions.fetchImpl) }),
        pullRequests: new GitHubMergeReadinessPullRequestOperations(publisherOptions), ci: { listCheckRuns: (ref, name) => readAcceptanceChecks(githubCi, ref, name, isUnpublishedHead) },
        merge: new GitHubControlledMergePullRequestOperations(controllerOptions) },
      unattended: { policy, plans: [plan], agentLimits: { maxTurns: 1, maxCostMicros: 0 }, verifyDrained,
        worker: { provider: runtime.provider, runValidator, async runAgent(request, capability) {
          recordEffect("dispatch", { taskId: request.taskId, role: request.role, runId: request.runId,
            actorId: request.actorId, revision: request.revisionIdentity });
          active++;
          try {
            const result = await runtime.runAgent(request, capability);
            recordEffect("role-result", { taskId: request.taskId, role: request.role, runId: request.runId,
              revision: request.revisionIdentity, outcome: result.outcome });
            return result;
          } finally { active--; }
        } },
        runtime: { fetchImpl: fetchFor("publisher"), token: token("publisher"),
          remoteHead(url, ref) { assert.equal(url, remoteUrl); return git(projectRoot, ["ls-remote", url, ref], { token: token("publisher") }).split(/\s/)[0] ?? ""; },
          pushBranch(url, ref, revision) {
            assert.equal(url, remoteUrl); assert.equal(revision, git(projectRoot, ["rev-parse", "HEAD"]));
            assert.ok(tasks.some(task => ref === "refs/heads/" + task.canonicalBranch));
            const fence = () => {
              pinnedFile(settings.grant); pinnedFile(settings.plan);
              config.assertCurrent(revision);
              assert.equal(git(projectRoot, ["rev-parse", "HEAD"]), revision);
              const task = tasks.find(task => ref === "refs/heads/" + task.canonicalBranch);
              assert.equal(git(projectRoot, ["branch", "--show-current"]), task.canonicalBranch);
              assert.equal(git(projectRoot, ["status", "--porcelain"]), ""); assertDiff(task);
              const control = controls();
              if (!control.enabled || control.revoked || Date.now() < grant.notBeforeMs || Date.now() >= grant.expiresAtMs)
                throw Object.assign(new Error("The execution grant no longer authorizes publication."), { code: "INACTIVE_GRANT" });
            };
            pushAfterObservation(() => { observationCache = undefined; protection(); }, fence, () => {
              const settle = pendingEffect("push", { ref, revision });
              fence();
              git(projectRoot, ["push", "--porcelain", url, revision + ":" + ref], { token: token("publisher") }); settle();
            });
          } },
        async synchronize(integrationRef, acceptedHead) {
          assert.equal(integrationRef, settings.integrationRef);
          assert.equal(git(projectRoot, ["status", "--porcelain"]), "");
          git(projectRoot, ["fetch", "--no-tags", remoteUrl, "refs/heads/" + integrationRef], { token: token("publisher") });
          git(projectRoot, ["merge-base", "--is-ancestor", acceptedHead, "FETCH_HEAD"]);
          git(projectRoot, ["switch", integrationRef]); git(projectRoot, ["merge", "--ff-only", "FETCH_HEAD"]);
        } } };
    const services = await createProjectServices(location, host);
    const channel = ownControlChannel({ hostDirectory, binding: controlBinding, operations: services.operations, recordCommand });
    return { services, policy, close: () => channel.close(() => policy.close()), plan, operationId: settings.operationId, projectRoot, config, providerDirectory,
      readToken: async () => token("publisher"), outputDirectory, receipt, requiredChecks: settings.requiredChecks,
      get interventions() { return readInterventions(); }, readInterventions, readOperatorAttestation, commandLog, recordCommand,
      hostAudit: () => readHostJournal(effectDirectory, settings.operationId, policy.grantDigest), setupSha256: sha256(readFileSync(settingsFile)), candidateFile: settings.candidateFile,
      installedDirectory: settings.installedDirectory,
      providerIdentity: { providerId: LOCAL_LLAMA_PROVIDER_ID, runtimeVersion: assets.runtimeVersion, model: assets.model, modelSha256: assets.modelSha256 },
      expectedProviderConfigDigest: digest({ version: 1, assets, contextTokens: 16384, outputTokens: 1024 }),
      verifyDrained };
  } catch (error) { policy.close(); throw error; }
}
