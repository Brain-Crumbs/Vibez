#!/usr/bin/env node
/** Prepare local reviewable inputs only. This program never calls GitHub or enables its execution grant. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markerValidatorCode } from "./unattended-host.mjs";
import { digest, git, json, pinnedFile, regular, safeEnvironment, sha256 } from "./unattended-host-io.mjs";
import { verifyCandidate } from "./unattended-package.mjs";

export function protectionRequests(repository, integrationRef, requiredChecks, controllerAppId) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(integrationRef, /^acceptance\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(requiredChecks.length && Number.isSafeInteger(controllerAppId) && controllerAppId > 0);
  const common = { target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/" + integrationRef], exclude: [] } } };
  return [
    { method: "POST", path: "/repos/" + repository + "/rulesets", body: { ...common,
      name: integrationRef + "-required-evidence", bypass_actors: [], rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true,
          allowed_merge_methods: ["merge"] } },
        { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false, required_status_checks: requiredChecks.map(check => ({ context: check.name, integration_id: check.appId })) } },
        { type: "non_fast_forward" }, { type: "deletion" } ] } },
    { method: "POST", path: "/repos/" + repository + "/rulesets", body: { ...common,
      name: integrationRef + "-controller-update", bypass_actors: [
        { actor_type: "Integration", actor_id: controllerAppId, bypass_mode: "pull_request" } ], rules: [{ type: "update" }] } },
  ];
}
export function consumerFiles(options, candidate, template) {
  assert.match(options.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(options.integrationRef, /^acceptance\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(Array.isArray(options.issueNumbers) && options.issueNumbers.length === 2 && new Set(options.issueNumbers).size === 2 &&
    options.issueNumbers.every(number => Number.isSafeInteger(number) && number > 0));
  assert.equal(options.branches.length, 2);
  assert.equal(new Set([options.integrationRef, ...options.branches]).size, 3);
  for (const branch of options.branches) {
    assert.match(branch, /^acceptance\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.ok(!branch.startsWith(options.integrationRef + "/") && !options.integrationRef.startsWith(branch + "/"));
  }
  assert.equal(options.requiredChecks.length, 1);
  assert.equal(options.requiredChecks[0].name, "Unattended acceptance");
  assert.equal(options.artifact.repository, options.repository, "This fixture supports an artifact in the same repository.");
  assert.ok(Number.isSafeInteger(options.artifact.runId) && options.artifact.runId > 0);
  assert.ok(Number.isSafeInteger(options.artifact.artifactId) && options.artifact.artifactId > 0);
  assert.equal(options.artifact.name, "vibez-candidate-" + candidate.sourceCommit);
  const config = structuredClone(template);
  config.project = { id: options.projectId, repository: options.repository };
  config.providers = { execution: "local-llama.cpp", credentials: [] };
  config.validators = [{ id: "marker", executorId: "marker", required: true }];
  config.policy.integrationTarget = options.integrationRef;
  config.policy.requiredChecks = options.requiredChecks.map(check => check.name);
  config.budgets = { maxAttempts: 2, retryDelayMs: 100, providerTimeoutMs: 180000, operationTimeoutMs: 2700000, maxReworkCycles: 2 };
  const roles = ["Developer", "QA", "Architect", "UAT/Product"];
  const tasks = [1, 2].map((n, index) => ({ schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: "PROOF-00" + n,
    title: "Make acceptance marker " + n + " ready",
    objective: "Replace marker-" + n + ".txt with exactly status=ready followed by one LF. Change no other path.",
    inScope: ["Rewrite marker-" + n + ".txt only."], outOfScope: ["All other files, policy, configuration and remote operations."],
    dependencies: n === 1 ? [] : ["PROOF-001"], canonicalBranch: options.branches[index], allowedPaths: ["marker-" + n + ".txt"],
    requirements: ["PROOF-00" + n + "-R1"], acceptanceCriteria: ["marker-" + n + ".txt is exactly status=ready followed by one LF."],
    validationPlan: ["Run the pinned marker validator and inspect the exact committed marker."],
    affectedContracts: ["consumer.marker"], requiredReviewRoles: [...roles, "MergeController"] }));
  const files = {
    "vibez.config.json": config,
    ".gitignore": ".vibez/\n.vibez-artifact/\nnode_modules/\n",
    "package.json": { name: options.projectId, version: "0.0.0", private: true, type: "module",
      dependencies: { "@brain-crumbs/vibez": "file:.vibez-artifact/" + candidate.file } },
    "engine-pin.json": { candidate, artifact: options.artifact },
    [config.paths.contextPolicy]: { description: "Independent installed acceptance consumer. Judge only the supplied task marker and its exact requirement. Earlier task markers are prerequisites, never editable scope." },
    [config.paths.contracts + "/marker.json"]: { moduleId: "consumer.marker", moduleVersion: "1.0.0",
      knownConsumers: [{ consumerId: "operator", expects: ["Each marker contains exactly status=ready followed by one LF after its task."] }] },
  };
  for (const [index, task] of tasks.entries()) {
    files["marker-" + (index + 1) + ".txt"] = "status=draft\n";
    files[config.paths.tasks + "/" + task.taskId + ".task.json"] = task;
    files[config.paths.requirements + "/" + task.taskId + ".json"] = { schemaId: "ipt.requirement", schemaVersion: "1.0.0",
      requirementId: task.requirements[0], taskId: task.taskId, statement: task.objective, acceptanceCriteria: task.acceptanceCriteria,
      sourceRefs: ["https://github.com/" + options.repository + "/issues/" + options.issueNumbers[index]] };
  }
  files["scripts/verify-acceptance.mjs"] = [
    'import assert from "node:assert/strict";',
    'import { readFileSync, readdirSync } from "node:fs";',
    'import { createHash } from "node:crypto";',
    'import { execFileSync } from "node:child_process";',
    'const read = path => JSON.parse(readFileSync(path,"utf8"));',
    'const expected = read("engine-pin.json").candidate;',
    'const actual = read(".vibez-artifact/candidate.json");',
    'for (const key of ["package","version","file","sourceCommit","sha256","integrity"]) assert.equal(actual[key], expected[key]);',
    'const bytes = readFileSync(".vibez-artifact/" + actual.file);',
    'assert.equal(createHash("sha256").update(bytes).digest("hex"),expected.sha256);',
    'assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"),expected.integrity);',
    'if (process.argv[2] === "artifact") process.exit(0);',
    'const { resolveProjectConfig } = await import("@brain-crumbs/vibez/config");',
    'const { loadTaskRegistry } = await import("@brain-crumbs/vibez/registry");',
    'const config = resolveProjectConfig({projectRoot:process.cwd(),configPath:"vibez.config.json"});',
    'const registry = await loadTaskRegistry({repositoryRoot:process.cwd(),taskDirectory:config.paths.tasks});',
    'assert.equal(registry.size,2);',
    'const task = [...registry.values()].find(t => t.canonicalBranch === process.env.ACCEPTANCE_BRANCH);',
    'assert.ok(task,"Unknown acceptance task branch");',
    'const head = execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();',
    'assert.equal(head,process.env.ACCEPTANCE_HEAD);',
    'for (const n of [1,2]) assert.equal(readFileSync("marker-"+n+".txt","utf8"),n===1||task.taskId==="PROOF-002"?"status=ready\\n":"status=draft\\n");',
    'assert.equal(read("node_modules/@brain-crumbs/vibez/package.json").version,expected.version);',
    'assert.ok(!readdirSync(".").includes("src"),"Consumer must not contain embedded engine source");',
    'console.log(JSON.stringify({status:"PASS",head,taskId:task.taskId,packageSha256:expected.sha256,sourceCommit:expected.sourceCommit}));',
  ].join("\n") + "\n";
  files[".github/workflows/unattended-acceptance.yml"] = [
    "name: Unattended acceptance", "", "on:", "  pull_request:", "    branches: [" + JSON.stringify(options.integrationRef) + "]", "",
    "permissions:", "  contents: read", "  actions: read", "", "jobs:", "  acceptance:", "    name: Unattended acceptance",
    "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v4", "        with:",
    "          ref: ${{ github.event.pull_request.head.sha }}", "          fetch-depth: 0", "          persist-credentials: false",
    "      - uses: actions/setup-node@v4", "        with:", '          node-version: "24"',
    "      - uses: actions/download-artifact@v4", "        with:", "          artifact-ids: " + options.artifact.artifactId,
    "          run-id: " + options.artifact.runId, "          repository: " + options.repository,
    "          github-token: ${{ github.token }}", "          path: .vibez-artifact", "          merge-multiple: true",
    "      - run: node scripts/verify-acceptance.mjs artifact",
    "      - run: npm ci --offline --ignore-scripts --no-audit --no-fund",
    "      - run: node scripts/verify-acceptance.mjs", "        env:",
    "          ACCEPTANCE_BRANCH: ${{ github.event.pull_request.head.ref }}",
    "          ACCEPTANCE_HEAD: ${{ github.event.pull_request.head.sha }}", "",
  ].join("\n");
  return { files, config, tasks };
}

export async function prepare(options) {
  assert.equal(process.platform, "linux");
  const destination = resolve(options.destination);
  assert.ok(!existsSync(destination), "Use a new disposable destination and preserve earlier receipts.");
  pinnedFile(options.assets); pinnedFile(options.tokenIssuer); regular(realpathSync(options.npmCli));
  mkdirSync(destination, { mode: 0o700 });
  const projectRoot = join(destination, "consumer"), hostDirectory = join(destination, "host");
  mkdirSync(projectRoot, { mode: 0o700 }); mkdirSync(hostDirectory, { mode: 0o700 });
  const verified = verifyCandidate(options.candidateFile, options.installedDirectory, join(hostDirectory, "verified-package"));
  const candidate = verified.candidate;
  const { files, config: configuration, tasks } = consumerFiles(options, candidate,
    json(join(verified.installed, "examples/alpha/vibez.config.json")));
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  };
  for (const [path, content] of Object.entries(files)) put(join(projectRoot, path), content);
  mkdirSync(join(projectRoot, ".vibez-artifact"), { mode: 0o700 });
  for (const file of ["candidate.json", candidate.file])
    copyFileSync(join(dirname(options.candidateFile), file), join(projectRoot, ".vibez-artifact", file));
  put(join(hostDirectory, "npmrc-user"), ""); put(join(hostDirectory, "npmrc-global"), "");
  execFileSync(process.execPath, [options.npmCli, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: projectRoot, env: { ...safeEnvironment(), NPM_CONFIG_CACHE: join(hostDirectory, "npm-cache"),
      NPM_CONFIG_USERCONFIG: join(hostDirectory, "npmrc-user"), NPM_CONFIG_GLOBALCONFIG: join(hostDirectory, "npmrc-global") }, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  git(projectRoot, ["init", "-b", options.integrationRef]);
  git(projectRoot, ["config", "user.name", "Vibez acceptance setup"]);
  git(projectRoot, ["config", "user.email", "acceptance@example.invalid"]);
  git(projectRoot, ["remote", "add", "origin", "https://github.com/" + options.repository + ".git"]);
  git(projectRoot, ["add", "."]);
  assert.ok(Number.isFinite(Date.parse(options.seedTimestamp)));
  git(projectRoot, ["commit", "-m", "Prepare independent installed unattended acceptance consumer"],
    { env: { GIT_AUTHOR_DATE: options.seedTimestamp, GIT_COMMITTER_DATE: options.seedTimestamp } });
  const seedRevision = git(projectRoot, ["rev-parse", "HEAD"]);
  const installedDirectory = join(projectRoot, "node_modules/@brain-crumbs/vibez");
  const manifest = json(join(installedDirectory, "package.json"));
  const load = name => import(pathToFileURL(join(installedDirectory, manifest.exports[name].import.default)).href);
  const { resolveProjectConfig } = await load("./config");
  const { commandPolicyDigest } = await load("./integration");
  const config = resolveProjectConfig({ projectRoot, configPath: "vibez.config.json" });
  const assets = json(options.assets.path);
  assert.ok(Number.isSafeInteger(options.notBeforeMs) && Number.isSafeInteger(options.expiresAtMs) &&
    options.expiresAtMs > options.notBeforeMs && options.expiresAtMs - options.notBeforeMs <= 7200000);
  const command = { kind: "command", validatorId: "marker", required: true, category: "test",
    command: process.execPath, args: ["-e", markerValidatorCode], cwd: projectRoot, timeoutMs: 10000 };
  const grant = { schemaId: "vibez.host-grant", schemaVersion: "1.0.0", grantId: options.projectId + "-grant",
    projectIdentity: config.projectIdentity, configDigest: config.configDigest, repository: options.repository,
    integrationRef: options.integrationRef, notBeforeMs: options.notBeforeMs, expiresAtMs: options.expiresAtMs,
    tasks: tasks.map(task => ({ taskId: task.taskId, branch: task.canonicalBranch, paths: task.allowedPaths })),
    roles: ["Developer", "QA", "Architect", "UAT/Product"].map((role, index) => ({ role,
      principal: options.projectId + "-isolated-role-" + index, provider: "local-llama.cpp", model: assets.model,
      tools: role === "Developer" ? ["snapshot.read", "workspace.replace"] : ["snapshot.read"], network: "none" })),
    validators: [{ id: "marker", commandDigest: commandPolicyDigest(command) }],
    requiredChecks: configuration.policy.requiredChecks, requiredReviews: ["QA", "Architect", "UAT/Product"],
    actions: ["start", "agent", "validator", "review", "rework", "push", "publish", "ready", "merge"], humanOnly: [],
    budgets: { maxConcurrent: 1, maxAgentTurns: 24, maxCommands: 6, maxCostMicros: 0, maxRuntimeMs: 4500000, maxReworks: 2 } };
  const plan = { schemaId: "vibez.workflow-plan", schemaVersion: "1.0.0", planId: options.projectId + "-chain",
    tasks: tasks.map((task, index) => ({ taskId: task.taskId, issueNumber: options.issueNumbers[index], definitionSha256: digest(task) })),
    budgets: { maxPolls: 30, maxRetries: 2, maxReworks: 2, maxRuntimeMs: 2700000, initialDelayMs: 5000, maxDelayMs: 60000 } };
  put(join(hostDirectory, "grant.json"), grant); put(join(hostDirectory, "plan.json"), plan);
  put(join(hostDirectory, "controls.json"), { enabled: false, revoked: false, grantDigest: digest(grant) });
  const pin = path => ({ path, sha256: sha256(readFileSync(path)) });
  const settings = { schemaId: "vibez.unattended-host", schemaVersion: "1.0.0", repository: options.repository,
    integrationRef: options.integrationRef, seedRevision, operationId: randomUUID(), controllerAppId: options.controllerAppId,
    requiredChecks: options.requiredChecks, projectRoot, installedDirectory, candidateFile: realpathSync(options.candidateFile),
    hostDirectory, controlsFile: join(hostDirectory, "controls.json"), assets: options.assets, tokenIssuer: options.tokenIssuer,
    grant: pin(join(hostDirectory, "grant.json")), plan: pin(join(hostDirectory, "plan.json")) };
  put(join(hostDirectory, "settings.json"), settings);
  put(join(hostDirectory, "interventions.json"), { operationId: settings.operationId, entries: [] });
  put(join(hostDirectory, "operator-attestation.json"), { status: "PENDING", operationId: settings.operationId,
    grantDigest: digest(grant), initialSetupRef: options.initialSetupRef ?? "PENDING_OWNER_SETUP_DECISION",
    actor: null, occurredAt: null, throughCommandSha256: null, noRoutineHandoffs: null });
  put(join(hostDirectory, "setup.mjs"), 'import { openAcceptance as open } from ' +
    JSON.stringify(pathToFileURL(join(installedDirectory, "scripts/unattended-host.mjs")).href) + ';\n' +
    'export const openAcceptance = options => open(' + JSON.stringify(join(hostDirectory, "settings.json")) + ', options);\n');
  const administration = { authority: "PROPOSED_SETUP_ONLY", repository: options.repository, seedRevision,
    branch: options.integrationRef, projectRoot, grantDigest: digest(grant),
    issueNumbers: options.issueNumbers, taskBranches: options.branches,
    protectionRequests: protectionRequests(options.repository, options.integrationRef, options.requiredChecks, options.controllerAppId),
    note: "No remote operation was performed. Review and authorize the exact seed publication and branch-scoped rules separately. Enable this exact grant only after protection and isolated credentials are verified." };
  put(join(hostDirectory, "administration-proposal.json"), administration);
  return { destination, projectRoot, hostDirectory, seedRevision, setupFile: join(hostDirectory, "setup.mjs"),
    controlsEnabled: false, grantDigest: digest(grant), planHash: digest(plan) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, "Usage: node prepare-unattended-consumer.mjs <trusted-options.json>");
    console.log(JSON.stringify(await prepare(json(realpathSync(process.argv[2])))));
  } catch (error) { console.error(JSON.stringify({ outcome: "BLOCKED", code: error.code ?? error.name,
    remediation: "Inspect the retained disposable preparation inputs. No remote setup or execution grant was enabled." })); process.exitCode = 2; }
}
