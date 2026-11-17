#!/usr/bin/env node
/** Real-provider execution with simulated remote integration. Never publishes to GitHub. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [assetsFile, installedDirectory, candidateFile] = process.argv.slice(2);
if (!assetsFile || !installedDirectory || !candidateFile || process.argv.length !== 5) {
  throw Error("Usage: node rehearse-workflow-operations.mjs <trusted-assets.json> <installed-package-root> <candidate.json>");
}
if (process.platform !== "linux") throw Error("This real-provider rehearsal requires the supported Linux local-filesystem host.");
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const digest = value => sha256(canonical(value));
const installed = realpathSync(resolve(installedDirectory));
const candidatePath = realpathSync(resolve(candidateFile));
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
assert.match(candidate.sourceCommit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
assert.match(candidate.file, /^[A-Za-z0-9_.-]+[.]tgz$/);
const tarball = join(dirname(candidatePath), candidate.file);
const packed = readFileSync(tarball);
assert.equal(sha256(packed), candidate.sha256, "The candidate tarball must match its pack receipt.");
assert.equal("sha512-" + createHash("sha512").update(packed).digest("base64"), candidate.integrity);
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
assert.equal(manifest.name, "@brain-crumbs/vibez");
assert.equal(manifest.name, candidate.package);
assert.equal(manifest.version, candidate.version);
assert.equal(manifest.private, true);

// Preserve a new disposable lab and every original record, including failures.
const lab = mkdtempSync(join(tmpdir(), "vibez-real-operations-"));
const root = join(lab, "consumer"), providerDirectory = join(lab, "provider"), ledger = join(lab, "policy");
for (const directory of [root, providerDirectory, ledger, join(lab, "package")]) mkdirSync(directory, { mode: 0o700 });
const put = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
const write = (path, value) => put(join(root, path), value);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tree = directory => {
  const result = [];
  const visit = path => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), stat = lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, "Installed candidate entries must be regular files or directories.");
      if (stat.isDirectory()) visit(file);
      else { assert.equal(stat.isFile(), true); result.push({ path: relative(directory, file), sha256: sha256(readFileSync(file)) }); }
    }
  };
  visit(directory);
  return result;
};
const archiveEntries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
assert.ok(archiveEntries.every(path => path.startsWith("package/") && !path.split("/").includes("..")), "Unexpected packed entry.");
execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", join(lab, "package")]);
const installedFiles = tree(installed);
assert.deepEqual(installedFiles, tree(join(lab, "package")), "The installed package must exactly match the packed candidate.");
put(join(lab, "installed-files.json"), installedFiles);
put(join(lab, "candidate.json"), candidate);
const publicImport = async name => {
  const path = manifest.exports[name]?.import?.default;
  assert.ok(typeof path === "string" && /^\.\/dist\/public\/[a-z-]+[.]js$/.test(path), "Use the installed public export map.");
  return import(pathToFileURL(join(installed, path)).href);
};
const { createProjectServices } = await publicImport(".");
const { resolveProjectConfig } = await publicImport("./config");
const { createLocalLlamaRuntime, LOCAL_LLAMA_PROVIDER_ID } = await publicImport("./providers");
const { ScopedHostPolicy, commandPolicyDigest } = await publicImport("./integration");
const assets = JSON.parse(readFileSync(resolve(assetsFile), "utf8"));
const roleNames = ["Developer", "QA", "Architect", "UAT/Product"];
const configuration = JSON.parse(readFileSync(join(installed, "examples/beta/vibez.config.json"), "utf8"));
configuration.project = { id: "real-two-task-supervisor-proof", repository: "example/vibez-real-operations" };
configuration.providers = { execution: LOCAL_LLAMA_PROVIDER_ID, credentials: [] };
configuration.validators = [{ id: "marker", executorId: "marker", required: true }];
configuration.policy.requiredChecks = ["simulated-remote-ci"];
configuration.budgets = { maxAttempts: 2, retryDelayMs: 50, providerTimeoutMs: 180000, operationTimeoutMs: 1800000, maxReworkCycles: 2 };
const paths = configuration.paths;
write("vibez.config.json", configuration);
write(".gitignore", ".vibez/\n");
write(paths.contextPolicy, { description: "Disposable local consumer. Judge the supplied marker and its exact requirement independently." });
write(paths.contracts + "/marker.json", { moduleId: "consumer.marker", moduleVersion: "1.0.0",
  knownConsumers: [{ consumerId: "operator", expects: ["One status line. The approved change is status=draft to status=ready."] }] });
const tasks = [1, 2].map(n => ({ schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: `DEMO-00${n}`,
  title: `Make release marker ${n} ready`,
  objective: `Replace marker-${n}.txt with exactly status=ready followed by one newline. No other file changes.`,
  inScope: [`Rewrite marker-${n}.txt only.`], outOfScope: ["Other files and all remote operations."],
  dependencies: n === 1 ? [] : ["DEMO-001"], canonicalBranch: `feature/marker-${n}`, allowedPaths: [`marker-${n}.txt`],
  requirements: [`DEMO-00${n}-R1`], acceptanceCriteria: [`marker-${n}.txt is exactly status=ready plus one final LF.`],
  validationPlan: [`Run the marker validator and inspect current marker-${n}.txt.`],
  affectedContracts: ["consumer.marker"], requiredReviewRoles: [...roleNames, "MergeController"] }));
for (const [index, task] of tasks.entries()) {
  const n = index + 1;
  write(`marker-${n}.txt`, "status=draft\n");
  write(`${paths.tasks}/${n}.task.json`, task);
  write(`${paths.requirements}/${n}.json`, { schemaId: "ipt.requirement", schemaVersion: "1.0.0",
    requirementId: `DEMO-00${n}-R1`, taskId: task.taskId,
    statement: `The operator reads status=ready on one line in marker-${n}.txt after the committed change.`,
    acceptanceCriteria: task.acceptanceCriteria, sourceRefs: ["Disposable real-provider supervisor proof"] });
}
git("init", "-b", "main");
git("config", "user.name", "Real provider supervisor rehearsal");
git("config", "user.email", "proof@example.invalid");
git("remote", "add", "origin", "https://github.com/" + configuration.project.repository + ".git");
git("add", ".");
git("commit", "-m", "Seed two dependent disposable marker tasks");
const fixtureSource = git("rev-parse", "HEAD");
const location = { projectRoot: root, configPath: "vibez.config.json" };
const config = resolveProjectConfig(location);
const roles = roleNames.map((role, index) => ({ role, principal: `isolated-principal-${index}`, provider: LOCAL_LLAMA_PROVIDER_ID,
  model: assets.model, tools: role === "Developer" ? ["snapshot.read", "workspace.replace"] : ["snapshot.read"], network: "none" }));
const validatorCode = `const fs=require('node:fs'),cp=require('node:child_process');
const n=cp.execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim().match(/^feature\\/marker-([12])$/)?.[1];
if(!n)throw Error('Unexpected canonical branch');
if(fs.readFileSync('marker-'+n+'.txt','utf8')!=='status=ready\\n')throw Error('The marker differs from its acceptance criterion');
console.log('marker-'+n+' exact-content validation PASS');`;
const command = { kind: "command", validatorId: "marker", required: true, category: "test",
  command: process.execPath, args: ["-e", validatorCode], cwd: root, timeoutMs: 10000 };
const validationRuns = [], agentRuns = [], pulls = [], remote = new Map();
const counts = { push: 0, create: 0, ready: 0, merge: 0 };
let externalWriters = 0;
const drained = () => externalWriters === 0 && readdirSync(providerDirectory).every(name =>
  !existsSync(join(providerDirectory, name, "intent.json")) || existsSync(join(providerDirectory, name, "terminal.json")));
async function runValidator(spec, capability) {
  assert.equal(commandPolicyDigest(spec), commandPolicyDigest(command));
  assert.equal(spec.cwd, root);
  capability.signal.throwIfAborted();
  capability.assertAuthorized();
  const record = { revision: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"),
    commandDigest: commandPolicyDigest(spec), startedAt: new Date().toISOString() };
  externalWriters++;
  try {
    const result = await new Promise((accept, reject) => {
      let output = "", errors = "", failure;
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, signal: capability.signal,
        timeout: spec.timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" } });
      child.stdout.on("data", data => { output = (output + data).slice(-8192); });
      child.stderr.on("data", data => { errors = (errors + data).slice(-8192); });
      child.on("error", error => { failure = error; });
      // Wait for close even after abort so a returned result never asserts an undrained child.
      child.on("close", (exitCode, signal) => {
        Object.assign(record, { exitCode, signal, output, errors, endedAt: new Date().toISOString() });
        if (failure) reject(failure); else accept({ status: exitCode === 0 ? "PASS" : "FAIL", details: output || errors || "Validator exited without output." });
      });
    });
    return result;
  } finally { externalWriters--; validationRuns.push(record); put(join(lab, "validator-runs.json"), validationRuns); }
}
const { runtime } = await createLocalLlamaRuntime({ repositoryRoot: root, projectIdentity: config.projectIdentity,
  operationDirectory: providerDirectory, assets, contextTokens: 16384, outputTokens: 1024,
  snapshotPaths: request => [tasks.find(task => task.taskId === request.taskId).allowedPaths[0]],
  editablePath: request => tasks.find(task => task.taskId === request.taskId).allowedPaths[0],
  replaceFile(edit, { expectedRevision, expectedBranch, signal }) {
    const task = tasks.find(task => task.canonicalBranch === expectedBranch);
    assert.ok(task); assert.deepEqual(task.allowedPaths, [edit.path]);
    assert.equal(git("rev-parse", "HEAD"), expectedRevision);
    assert.equal(git("branch", "--show-current"), expectedBranch);
    assert.equal(git("status", "--porcelain"), "");
    signal.throwIfAborted();
    write(edit.path, edit.content);
    git("add", "--", edit.path);
    git("commit", "-m", `Implement ${task.taskId} using the isolated local provider`, "--", edit.path);
    return { status: "COMMITTED", revision: git("rev-parse", "HEAD") };
  }, runValidator });
const startedAt = Date.now();
const grant = { schemaId: "vibez.host-grant", schemaVersion: "1.0.0", grantId: "real-provider-two-task-proof",
  projectIdentity: config.projectIdentity, configDigest: config.configDigest, repository: configuration.project.repository,
  integrationRef: "main", notBeforeMs: startedAt - 1000, expiresAtMs: startedAt + 7200000,
  tasks: tasks.map(task => ({ taskId: task.taskId, branch: task.canonicalBranch, paths: task.allowedPaths })), roles,
  validators: [{ id: "marker", commandDigest: commandPolicyDigest(command) }],
  requiredChecks: configuration.policy.requiredChecks, requiredReviews: roleNames.slice(1),
  actions: ["start", "agent", "validator", "review", "rework", "push", "publish", "ready", "merge"], humanOnly: [],
  budgets: { maxConcurrent: 1, maxAgentTurns: 24, maxCommands: 6, maxCostMicros: 0, maxRuntimeMs: 4500000, maxReworks: 2 } };
const plan = { schemaId: "vibez.workflow-plan", schemaVersion: "1.0.0", planId: "real-provider-two-markers",
  tasks: tasks.map((task, index) => ({ taskId: task.taskId, issueNumber: index + 101, definitionSha256: digest(task) })),
  budgets: { maxPolls: 3, maxRetries: 2, maxReworks: 2, maxRuntimeMs: 1800000, initialDelayMs: 25, maxDelayMs: 100 } };
put(join(lab, "grant.json"), grant); put(join(lab, "plan.json"), plan);
const policy = new ScopedHostPolicy({ grant, ledgerDirectory: ledger, worktreeRoot: root,
  verifyDrained: drained, observe: operation => {
    const pr = pulls.find(pr => pr.number === operation.pullRequestNumber);
    return { projectIdentity: config.projectIdentity, configDigest: config.configDigest, repository: configuration.project.repository,
      integrationRef: "main", revision: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), revoked: false, enabled: true,
      checks: grant.requiredChecks, validators: grant.validators, reviews: grant.requiredReviews,
      ...(pr ? { pullRequest: { number: pr.number, revision: pr.head.sha, head: pr.head.ref, base: pr.base.ref,
        open: pr.state === "open", ready: !pr.draft, protectionsVerified: true } } : {}) };
  } });
const native = pr => ({ number: pr.number, htmlUrl: `https://github.com/${configuration.project.repository}/pull/${pr.number}`,
  headRef: pr.head.ref, headSha: pr.head.sha, baseRef: pr.base.ref, title: pr.title, body: pr.body,
  state: pr.state, merged: pr.merged ?? false, mergeCommitSha: pr.mergeCommitSha ?? null });
const response = value => ({ ok: true, status: 200, json: async () => value });
// These ports are test doubles. No fetch, push, PR, CI, protection or merge request leaves this process.
const fetchImpl = async (url, init) => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "api.github.com");
  if (parsed.pathname === "/graphql") {
    const pr = pulls.find(pr => pr.node_id === JSON.parse(init.body).variables.id);
    assert.ok(pr); pr.draft = false; counts.ready++;
    return response({ data: {} });
  }
  const number = /\/pulls\/(\d+)$/.exec(parsed.pathname)?.[1];
  return response(number ? pulls.find(pr => pr.number === Number(number)) : pulls.filter(pr => pr.state === "open" &&
    (!parsed.searchParams.get("head") || parsed.searchParams.get("head").endsWith(":" + pr.head.ref))));
};
const host = { identity: "real-provider-two-task-proof@1", requirePassingDeveloperResult: true,
  actorIdFor: (role, owner) => roles.find(entry => entry.role === role)?.principal ?? owner + "::controller",
  toolPermissionPolicyFor: role => ({ allowedTools: roles.find(entry => entry.role === role)?.tools ?? [], networkAccess: "none" }),
  executors: new Map([["marker", { command: command.command, args: command.args, category: command.category, timeoutMs: command.timeoutMs }]]),
  authorizePublication: () => true, authorizeMerge: () => true,
  integration: { repository: configuration.project.repository,
    publication: {
      findOpenPullRequests: async ({ head }) => pulls.filter(pr => pr.state === "open" && pr.head.ref === head).map(native),
      createPullRequest: async input => {
        counts.create++;
        const pr = { number: pulls.length + 1, node_id: `simulated-${pulls.length + 1}`, title: input.title, body: input.body, draft: true, state: "open",
          head: { sha: remote.get(`refs/heads/${input.head}`), ref: input.head, repo: { full_name: configuration.project.repository } },
          base: { ref: input.base, repo: { full_name: configuration.project.repository } } };
        pulls.push(pr); return native(pr);
      },
      updatePullRequest: async input => { const pr = pulls.find(pr => pr.number === input.number); Object.assign(pr, { title: input.title, body: input.body }); return native(pr); } },
    pullRequests: { findOpenPullRequests: async ({ head }) => pulls.filter(pr => pr.state === "open" && pr.head.ref === head).map(native) },
    ci: { listCheckRuns: async () => [{ name: "simulated-remote-ci", status: "completed", conclusion: "success", startedAt: new Date().toISOString() }] },
    merge: { findPullRequestsByHead: async head => pulls.filter(pr => pr.head.ref === head).map(native),
      getPullRequest: async number => native(pulls.find(pr => pr.number === number)),
      mergePullRequest: async ({ number, expectedHeadSha }) => {
        const pr = pulls.find(pr => pr.number === number);
        assert.equal(pr.head.sha, expectedHeadSha); assert.equal(pr.draft, false); assert.equal(pr.state, "open");
        counts.merge++; pr.state = "closed"; pr.merged = true; pr.mergeCommitSha = expectedHeadSha;
        return { merged: true, sha: expectedHeadSha, message: "Simulated remote integration accepted the exact reviewed head." };
      } } },
  unattended: { policy, plans: [plan], agentLimits: { maxTurns: 1, maxCostMicros: 0 }, verifyDrained: drained,
    synchronize: async (_base, head) => { git("switch", "main"); git("merge", "--ff-only", head); },
    runtime: { fetchImpl, token: "simulated-no-credential", remoteHead: (_url, ref) => remote.get(ref) ?? "",
      pushBranch: (_url, ref, head) => { counts.push++; remote.set(ref, head); } },
    worker: { provider: runtime.provider, runValidator,
      async runAgent(request, capability) {
        const record = { taskId: request.taskId, role: request.role, runId: request.runId, actorId: request.actorId,
          revision: request.revisionIdentity, startedAt: new Date().toISOString() };
        console.log(JSON.stringify({ stage: "real-provider-dispatch", ...record }));
        externalWriters++;
        try {
          const result = await runtime.runAgent(request, capability);
          Object.assign(record, { endedAt: new Date().toISOString(), outcome: result.outcome, evidenceRefs: result.evidenceRefs });
          return result;
        } catch (error) {
          Object.assign(record, { endedAt: new Date().toISOString(), errorCode: error.code ?? error.name });
          throw error;
        } finally { externalWriters--; agentRuns.push(record); put(join(lab, "agent-runs.json"), agentRuns); }
      } } } };
const operationId = randomUUID();
const report = { schemaId: "vibez.real-provider-operations-proof", schemaVersion: "1.0.0",
  evidenceKind: "real-provider execution with simulated remote integration",
  scope: "Disposable fixture only; not AUT-003 live reviews, hosted CI, PR approval, or completion.",
  lab, operationId, startedAt: new Date(startedAt).toISOString(), package: candidate,
  installedTreeSha256: digest(installedFiles), scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  fixtureSource, grantDigest: policy.grantDigest, planHash: digest(plan), projectIdentity: config.projectIdentity, configDigest: config.configDigest,
  provider: { providerId: LOCAL_LLAMA_PROVIDER_ID, assetsSha256: digest(assets), runtimeVersion: assets.runtimeVersion,
    launcherSha256: assets.launcherSha256, runnerSha256: assets.runnerSha256, model: assets.model, modelSha256: assets.modelSha256 },
  outcome: "RUNNING" };
put(join(lab, "report.json"), report);
console.log(JSON.stringify({ stage: "begin", lab, operationId, packageVersion: candidate.version, sourceCommit: candidate.sourceCommit }));
try {
  const services = await createProjectServices(location, host);
  const operation = await services.operations.start(plan.planId, operationId);
  put(join(lab, "operation.json"), operation);
  assert.equal(operation.status, "DONE", JSON.stringify(operation));
  assert.deepEqual(operation.completed, tasks.map(task => task.taskId));
  assert.deepEqual(counts, { push: 2, create: 2, ready: 2, merge: 2 });
  assert.equal(git("branch", "--show-current"), "main");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(externalWriters, 0);
  assert.equal(drained(), true);
  for (const n of [1, 2]) assert.equal(readFileSync(join(root, `marker-${n}.txt`), "utf8"), "status=ready\n");
  const nativeStatus = services.status.read(new Date().toISOString());
  assert.deepEqual(nativeStatus.tasks.map(task => [task.taskId, task.state]), tasks.map(task => [task.taskId, "DONE"]));
  put(join(lab, "native-status.json"), nativeStatus);
  const sessions = readdirSync(providerDirectory).filter(name => existsSync(join(providerDirectory, name, "intent.json"))).map(attempt => {
    const directory = join(providerDirectory, attempt);
    const intent = JSON.parse(readFileSync(join(directory, "intent.json"), "utf8"));
    const terminalFile = join(directory, "terminal.json");
    const terminal = JSON.parse(readFileSync(terminalFile, "utf8")).terminal;
    assert.equal(terminal.status, "COMPLETED");
    assert.equal(terminal.result.revisionIdentity, intent.revision);
    return { attempt, taskId: terminal.result.taskId, role: intent.role, runId: terminal.result.runId,
      session: intent.session, revision: intent.revision, workspaceRevision: terminal.workspaceRevision ?? null,
      outcome: terminal.result.outcome, configDigest: intent.configDigest,
      intentSha256: sha256(readFileSync(join(directory, "intent.json"))), terminalSha256: sha256(readFileSync(terminalFile)) };
  });
  assert.equal(new Set(sessions.map(session => session.session)).size, sessions.length);
  for (const task of tasks) for (const role of roleNames) assert.ok(sessions.some(session => session.taskId === task.taskId && session.role === role && session.outcome === "PASS"));
  assert.ok(validationRuns.length >= 2);
  const lastFirst = Math.max(...agentRuns.filter(run => run.taskId === tasks[0].taskId).map(run => Date.parse(run.endedAt)));
  const firstSecond = Math.min(...agentRuns.filter(run => run.taskId === tasks[1].taskId).map(run => Date.parse(run.startedAt)));
  assert.ok(lastFirst <= firstSecond, "The dependent task cannot dispatch before the predecessor completes.");
  const beforeReplay = { sessions: agentRuns.length, validations: validationRuns.length, ...counts };
  put(join(lab, "operation-audit.json"), services.operations.audit(operationId));
  const cli = await services.cli(["--json", "orchestrate", "operation", "status", operationId]);
  assert.equal(cli.exitCode, 0);
  const replay = await services.operations.start(plan.planId, operationId);
  assert.deepEqual(replay, operation);
  assert.deepEqual({ sessions: agentRuns.length, validations: validationRuns.length, ...counts }, beforeReplay);
  put(join(lab, "cli-status.json"), cli); put(join(lab, "policy-decisions.json"), policy.decisions());
  Object.assign(report, { outcome: "PASS", completedAt: new Date().toISOString(), fixtureFinalRevision: git("rev-parse", "HEAD"),
    operation, sessions, validationRuns, simulatedRemoteCounts: counts, replayDidNotRepeatWork: true,
    nativeStatusSha256: sha256(readFileSync(join(lab, "native-status.json"))),
    policyDecisionsSha256: sha256(readFileSync(join(lab, "policy-decisions.json"))) });
  put(join(lab, "report.json"), report);
  console.log(JSON.stringify({ stage: "complete", outcome: report.outcome, report: join(lab, "report.json"),
    reportSha256: sha256(readFileSync(join(lab, "report.json"))), realProviderSessions: sessions.length, realValidators: validationRuns.length,
    completed: operation.completed, simulatedRemoteCounts: counts }));
} catch (error) {
  Object.assign(report, { outcome: "FAIL", stoppedAt: new Date().toISOString(),
    error: { name: error.name, code: error.code ?? null, message: error.message }, agentRuns, validationRuns, simulatedRemoteCounts: counts });
  put(join(lab, "report.json"), report);
  console.error(JSON.stringify({ stage: "failed", report: join(lab, "report.json"), error: report.error }));
  throw error;
} finally { policy.close(); }
