import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { get, git, githubFixture, markdown, pause, put, response } from "./helpers/driver-fixture.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const conformance = process.env.VIBEZ_CONFORMANCE_INPUTS
  ? get(root, process.env.VIBEZ_CONFORMANCE_INPUTS) : undefined;
const manifest = conformance?.manifest ?? get(root, "package.json");
const tsc = conformance?.tsc ?? join(root, "node_modules/typescript/bin/tsc");
const npm = process.env.npm_execpath;
const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pack = (runNpm, temp) => conformance
  ? { receipt: conformance.receipt, archive: conformance.archive, paths: conformance.packagePaths }
  : (() => {
      const [receipt] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], root));
      return { receipt, archive: join(temp, receipt.filename), paths: receipt.files.map(file => file.path) };
    })();
const installedDocs = ["docs/INSTALL.md", "docs/PUBLIC_API.md", "docs/CLI.md", "docs/COMPATIBILITY.md",
  "docs/CONFIGURED_RUNTIME.md", "docs/UNATTENDED_HOST.md", "docs/SUPPORT.md", "docs/WORKFLOW_DRIVER.md",
  "docs/MIGRATION_CANDIDATE.md", "CHANGELOG.md"];

const publicApi = {
  "": "createProjectServices",
  "/config": "resolveProjectConfig",
  "/assets": "getAssetCatalog",
  "/registry": "selectNextEligibleTask",
  "/lifecycle": "createLifecycleRecord",
  "/context": "compileRoleContext",
  "/validation": "ValidationExecutor",
  "/evidence": "FileEvidenceStore",
  "/review": "QaReviewGate",
  "/workflow": "SequentialOrchestrationEngine",
  "/providers": "AgentRunner",
  "/integration": "ControlledMergeController",
  "/diagnostics": "ProjectStatusReporter",
  "/cli": "runCli",
};

function invokeAlias(directory, alias, args, cwd) {
  if (process.platform !== "win32") {
    return spawnSync(join(directory, alias), args, { cwd, encoding: "utf8" });
  }
  // All command arguments here are fixed fixture strings. Put the directory on
  // PATH so cmd can resolve npm's .cmd shim even if the prefix contains spaces.
  return spawnSync(process.env.ComSpec, ["/d", "/c", alias + ".cmd", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: directory + delimiter + process.env.PATH },
  });
}

test("actual npm tarball serves independent JS, TypeScript and standalone CLI consumers", t => {
  assert.ok(npm, "Run via npm test or npm run test:package.");
  const temp = mkdtempSync(join(tmpdir(), "vibez pack "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runNpm = (args, cwd) => run(process.execPath, [npm, "--cache", join(temp, "npm-cache"), ...args], cwd);
  const { receipt: packReceipt, archive, paths: packedPaths } = pack(runNpm, temp);
  assert.equal(packReceipt.name ?? packReceipt.package, manifest.name);
  assert.equal(packReceipt.version, manifest.version);
  assert.equal(packReceipt.integrity, "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64"));

  const paths = new Set(packedPaths);
  const assets = conformance?.assets ?? [
    ...readdirSync(join(root, "schemas/v1")).map(name => "schemas/v1/" + name),
    ...readdirSync(join(root, "contracts"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== "examples")
      .map(entry => "contracts/" + entry.name + "/module-contract.json"),
    "docs/specs/project-config.schema.json", "examples/alpha/vibez.config.json", "examples/beta/vibez.config.json",
  ];
  const included = new Set([...assets, "package.json", "NOTICE.md", "README.md", ...installedDocs]);
  for (const path of included) assert.ok(paths.has(path), path);
  for (const path of paths) assert.ok(included.has(path) || /^dist\/.+\.(js|d\.ts)$/.test(path), "Unexpected packaged file " + path);
  assert.deepEqual(Object.keys(manifest.exports), Object.keys(publicApi).map(path => "." + path));
  for (const { import: entry } of Object.values(manifest.exports)) {
    assert.ok(paths.has(entry.types.slice(2)));
    assert.ok(paths.has(entry.default.slice(2)));
  }

  const project = join(temp, "consumer");
  const unrelated = join(temp, "other working directory");
  mkdirSync(project);
  mkdirSync(unrelated);
  writeFileSync(join(project, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(join(project, "sentinel.txt"), "unchanged\n");
  runNpm(["install", "--offline", "--no-audit", "--no-fund", "--save-exact", archive], project);
  assert.deepEqual(readdirSync(project).sort(), ["node_modules", "package-lock.json", "package.json", "sentinel.txt"]);
  assert.equal(readFileSync(join(project, "sentinel.txt"), "utf8"), "unchanged\n");
  const installed = join(project, "node_modules", manifest.name);
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(installedManifest.dependencies ?? {}, {});
  assert.ok(!existsSync(join(project, "node_modules/typescript")));
  for (const event of ["preinstall", "install", "postinstall"]) assert.equal(installedManifest.scripts?.[event], undefined);
  assert.equal(JSON.parse(readFileSync(join(project, "package-lock.json"), "utf8"))
    .packages["node_modules/" + manifest.name].integrity, packReceipt.integrity);

  const imports = Object.entries(publicApi).map(([path, name]) =>
    'import { ' + name + ' } from "' + manifest.name + path + '";').join("\n");
  const useValues = "if (![" + Object.values(publicApi).join(", ") + "].every(value => typeof value === \"function\")) throw new Error(\"Invalid API export\");\n";
  const consumer = join(project, "consumer.ts");
  writeFileSync(consumer, imports + "\n" +
    'import type { ProjectHost } from "' + manifest.name + '";\n' +
    'import type { ProjectConfigV1 } from "' + manifest.name + '/config";\n' +
    'import type { AgentProvider, LocalAgentPacket } from "' + manifest.name + '/providers";\n' +
    'import type { MergeReadinessCiPort, HostGrant, ScopedWorkerRuntime } from "' + manifest.name + '/integration";\n' +
    'export type Ports = [ProjectHost, ProjectConfigV1, AgentProvider, LocalAgentPacket, MergeReadinessCiPort, HostGrant, ScopedWorkerRuntime];\n' +
    useValues);
  run(process.execPath, [tsc, "--strict", "--target", "ES2022", "--module", "NodeNext", consumer], unrelated);

  const module = join(project, "consumer.mjs");
  run(process.execPath, [join(project, "consumer.js")], unrelated);
  writeFileSync(module, readFileSync(join(root, "tests/helpers/packed-consumer.mjs"), "utf8"));
  run(process.execPath, [module, packReceipt.version], unrelated);

  const localBin = join(project, "node_modules", ".bin");
  for (const alias of ["agent", "vibez"]) {
    const help = invokeAlias(localBin, alias, ["--help"], unrelated);
    assert.equal(help.status, 0, help.error?.message || help.stderr);
    assert.match(help.stdout, /Usage:/);
    const version = invokeAlias(localBin, alias, ["--json", "--version"], unrelated);
    assert.equal(version.status, 0, version.error?.message || version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), { schemaVersion: "1.0.0", ok: true, command: "version",
      data: { cliVersion: packReceipt.version, outputSchemaVersion: "1.0.0" }, error: null });
    const reserved = invokeAlias(localBin, alias, ["--json", "review"], unrelated);
    assert.equal(reserved.status, 3, reserved.error?.message || reserved.stderr);
    assert.equal(JSON.parse(reserved.stdout).error.code, "COMMAND_NOT_IMPLEMENTED");
  }

  const prefix = join(temp, "global prefix");
  runNpm(["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", archive], unrelated);
  const global = invokeAlias(process.platform === "win32" ? prefix : join(prefix, "bin"), "vibez", ["--json", "--version"], unrelated);
  assert.equal(global.status, 0, global.error?.message || global.stderr);
  assert.equal(JSON.parse(global.stdout).data.cliVersion, packReceipt.version);
  assert.deepEqual(readdirSync(unrelated), []);
});

test("installed manual driver uses committed consumer inputs and recovers the bound packet", async t => {
  assert.ok(npm, "Run via npm test or npm run test:package.");
  const temp = mkdtempSync(join(tmpdir(), "vibez driver package "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runNpm = (args, cwd) => run(process.execPath, [npm, "--cache", join(temp, "npm-cache"), ...args], cwd);
  const { archive } = pack(runNpm, temp);
  const tools = join(temp, "tools");
  const project = join(temp, "consumer with spaces");
  mkdirSync(tools);
  mkdirSync(project);
  put(tools, "package.json", { private: true });
  runNpm(["install", "--offline", "--no-audit", "--no-fund", archive], tools);
  const executable = join(tools, "node_modules", manifest.name, "dist", "cli", "cli.js");
  const call = (args, input) => {
    const result = spawnSync(process.execPath, [executable, "--json", "orchestrate", ...args,
      "--project", project, "--config", "workflow.json", "--npm-cli", npm, "--local-ntfs"],
      { cwd: tools, input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout || result.stderr || result.error?.message);
    return JSON.parse(result.stdout).data;
  };
  const config = get(tools, `node_modules/${manifest.name}/examples/alpha/vibez.config.json`);
  config.policy.reviewRoles = ["UAT/Product"];
  config.project.repository = "fixture-owner/fixture-repo";
  config.policy.remote = "upstream";
  config.policy.integrationTarget = "trunk";
  config.providers.credentials = [];
  put(project, "workflow.json", config);
  put(project, "work/tasks/.gitkeep", "");
  put(project, "work/contracts/.gitkeep", "");
  put(project, "work/policy.json", {});
  put(project, "work/requirements/marker.json", {
    schemaId: "ipt.requirement", schemaVersion: "1.0.0", requirementId: "DEMO-001-R1", taskId: "DEMO-001",
    statement: "Deliver the marker.", acceptanceCriteria: ["Marker has the expected text."], sourceRefs: ["fixture"],
  });
  put(project, "work/requirements/dependent.json", {
    schemaId: "ipt.requirement", schemaVersion: "1.0.0", requirementId: "DEMO-002-R1", taskId: "DEMO-002",
    statement: "Verify the predecessor marker.", acceptanceCriteria: ["Predecessor marker remains."], sourceRefs: ["fixture"],
  });
  put(project, "package.json", { private: true, scripts: { build: "node --check verify.mjs", test: "node verify.mjs" } });
  put(project, "verify.mjs", "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('marker.txt','utf8'), 'done');");
  put(project, ".gitignore", ".vibez/\n");
  git(project, "init", "-b", "trunk");
  git(project, "config", "user.name", "Installed fixture");
  git(project, "config", "user.email", "driver@example.invalid");
  git(project, "remote", "add", "upstream", "https://github.com/fixture-owner/fixture-repo.git");
  git(project, "add", ".");
  git(project, "commit", "-m", "Configure isolated consumer");

  const setup = call(["init", "--actor-prefix", "operator", "--developer-tools", "read_file,write_file,git_commit",
    "--review-tools", "read_file,run_test", "--enforce-policies", "externally"]);
  assert.equal(setup.profile.integrationTarget, "trunk");
  assert.equal(setup.profile.paths.outbound, ".vibez/outbox");
  const intake = call(["prepare", "--stdin"], markdown());
  assert.ok(intake.sessionId && intake.diagnostics.length === 0, JSON.stringify(intake));
  const sessionFile = `.vibez/operations/driver/sessions/${intake.sessionId}.json`;
  const interrupted = get(project, sessionFile);
  const registration = get(project, `.vibez/operations/driver/staged/${intake.intakeId}/registration.json`);
  const intakeFile = `.vibez/operations/driver/intakes/${intake.intakeId}.json`;
  git(project, "restore", `--source=${registration.base}`, "--staged", "--worktree", "--", interrupted.definitionPath);
  put(project, sessionFile, { ...interrupted, registrationRevision: registration.base });
  put(project, intakeFile, { ...intake, diagnostics: ["Registration commit pending."] });
  const replayed = call(["prepare", "--stdin"], markdown());
  assert.equal(replayed.sessionId, intake.sessionId);
  assert.deepEqual(get(project, sessionFile).request, interrupted.request);
  assert.equal(git(project, "rev-parse", "HEAD"), registration.commit);
  const dependent = call(["prepare", "--stdin"], markdown("DEMO-002", ["DEMO-001"], []));
  assert.ok(dependent.sessionId && dependent.diagnostics.length === 0, JSON.stringify(dependent));
  assert.equal(call(["prepare", "--stdin"], markdown("DEMO-002", ["DEMO-001"], [])).sessionId, dependent.sessionId);
  assert.equal(call(["next"]).taskId, "DEMO-001");
  const first = call(["run", intake.sessionId]).session;
  assert.ok(first.pendingPacket, first.diagnosticId ? get(project, `.vibez/outbox/${first.diagnosticId}.diagnostic.json`).message : JSON.stringify(first));
  const handoff = get(project, `.vibez/outbox/${first.pendingPacket}.handoff.json`);
  assert.equal(handoff.packet.role, "Developer");
  assert.ok(handoff.packet.contextPackage.artifacts.some(item => item.kind === "requirement"));
  assert.ok(handoff.packet.contextPackage.artifacts.some(item => item.kind === "contract" && item.sourcePath.startsWith("vibez-package:")));
  assert.ok(!existsSync(join(project, "schemas")));
  assert.ok(!existsSync(join(project, ".agent")));
  assert.equal(call(["resume", intake.sessionId]).session.pendingPacket, first.pendingPacket);

  put(project, ".vibez/inbox/responses/reply.json", "{");
  call(["watch", intake.sessionId, "--once"]);
  await pause();
  const waiting = call(["watch", intake.sessionId, "--once"]).session;
  assert.equal(waiting.pendingPacket, first.pendingPacket);
  assert.ok(waiting.diagnosticId);
  put(project, "marker.txt", "done");
  git(project, "add", "marker.txt");
  git(project, "commit", "-m", "Deliver marker");
  put(project, ".vibez/inbox/responses/reply.json", response(handoff.packet));
  call(["watch", intake.sessionId, "--once"]);
  await pause();
  let stage = call(["watch", intake.sessionId, "--once"]).session;
  assert.equal(get(project, `.vibez/outbox/${stage.pendingPacket}.handoff.json`).packet.role, "QA");
  const rejected = get(project, `.vibez/outbox/${stage.pendingPacket}.handoff.json`).packet;
  const rejectedPath = `.vibez/inbox/responses/${rejected.packetId}.json`;
  put(project, rejectedPath, response(rejected, "FAIL"));
  call(["watch", intake.sessionId, "--once"]);
  await pause();
  call(["watch", intake.sessionId, "--once"]);
  assert.equal(get(project, ".vibez/state/lifecycle/DEMO-001.lifecycle.json").currentState, "REWORK_REQUIRED");
  const rejectedResult = readFileSync(join(project, config.paths.exchange, rejected.packetId + ".result.json"));
  const successor = call(["rework", intake.sessionId]);
  assert.equal(successor.predecessor, intake.sessionId);
  const sessionId = successor.sessionId;
  const rework = call(["run", sessionId]).session;
  const newDeveloper = get(project, `.vibez/outbox/${rework.pendingPacket}.handoff.json`).packet;
  assert.equal(newDeveloper.role, "Developer");
  assert.notEqual(newDeveloper.runId, handoff.packet.runId);
  put(project, "marker.txt", "done");
  git(project, "commit", "--allow-empty", "-m", "Address the review on a fresh revision");
  put(project, `.vibez/inbox/responses/${newDeveloper.packetId}.json`, response(newDeveloper));
  call(["watch", sessionId, "--once"]);
  await pause();
  stage = call(["watch", sessionId, "--once"]).session;
  assert.deepEqual(readFileSync(join(project, config.paths.exchange, rejected.packetId + ".result.json")), rejectedResult);
  for (const role of ["QA", "Architect", "UAT/Product"]) {
    assert.deepEqual(stage.request, rework.request);
    assert.ok(stage.pendingPacket, JSON.stringify(stage));
    const packet = get(project, `.vibez/outbox/${stage.pendingPacket}.handoff.json`).packet;
    assert.equal(packet.role, role);
    put(project, `.vibez/inbox/responses/${packet.packetId}.json`, response(packet));
    call(["watch", sessionId, "--once"]);
    await pause();
    stage = call(["watch", sessionId, "--once"]).session;
  }
  assert.equal(get(project, ".vibez/state/lifecycle/DEMO-001.lifecycle.json").currentState, "MERGE_READY");
  const bare = join(temp, "fixture bare.git");
  mkdirSync(bare);
  git(bare, "init", "--bare");
  const bareUrl = pathToFileURL(bare).href;
  const repository = config.project.repository;
  const githubUrl = `https://github.com/${repository}.git`;
  const { remote, fetchImpl } = githubFixture(project, "trunk");
  const installedEntrypoint = pathToFileURL(join(tools, "host.mjs")).href;
  put(tools, "host.mjs", `
    export { createProjectServices, npmValidatorCommands } from "${manifest.name}";
    export { GitHubControlledMergePullRequestOperations, GitHubCiStatusOperations,
      GitHubMergeReadinessPullRequestOperations, GitHubPullRequestOperations } from "${manifest.name}/integration";
  `);
  const api = await import(installedEntrypoint);
  const token = "fixture-token";
  const options = { owner: "fixture-owner", repo: "fixture-repo", token, fetchImpl };
  let writeAllowed = false;
  let mergeAuthorization;
  let returnWrongMergeRecord = false;
  const githubMerge = new api.GitHubControlledMergePullRequestOperations(options);
  const host = {
    identity: "vibez-standalone-manual-npm@1", executors: api.npmValidatorCommands(npm),
    integration: {
      repository,
      publication: new api.GitHubPullRequestOperations({ ...options, fetchImpl: (url, init) => {
        const body = init.method === "POST" && url.endsWith("/pulls") ? JSON.stringify({ ...JSON.parse(init.body ?? "{}"), draft: true }) : init.body;
        return fetchImpl(url, { ...init, ...(body === undefined ? {} : { body }) });
      } }),
      pullRequests: new api.GitHubMergeReadinessPullRequestOperations(options),
      ci: new api.GitHubCiStatusOperations(options),
      merge: {
        findPullRequestsByHead: githubMerge.findPullRequestsByHead.bind(githubMerge),
        mergePullRequest: githubMerge.mergePullRequest.bind(githubMerge),
        getPullRequest: async number => {
          const record = await githubMerge.getPullRequest(number);
          return returnWrongMergeRecord && record ? { ...record, number: number + 1 } : record;
        },
      },
    },
    authorizePublication: () => writeAllowed,
    authorizeMerge: input => mergeAuthorization === `${input.repository}#${input.number}@${input.expectedHeadSha}`,
  };
  const runHost = async operation => {
    const graph = await api.createProjectServices({ projectRoot: project, configPath: "workflow.json", verifyLocalStorage: () => true }, host);
    const result = await graph.cli(["--json", "orchestrate", operation, sessionId], undefined, {
      token, fetchImpl, mergeAuthorization,
      remoteHead: (url, ref) => {
        assert.equal(url, githubUrl);
        return git(project, "ls-remote", bareUrl, ref).split(/\s/)[0];
      },
      pushBranch: (url, ref, head) => {
        assert.equal(url, githubUrl);
        git(project, "push", bareUrl, `${head}:${ref}`);
      },
    });
    return JSON.parse(result.stdout);
  };
  assert.equal((await runHost("publish")).ok, false);
  assert.equal(remote.pr, null);
  writeAllowed = true;
  const publication = await runHost("publish");
  assert.equal(publication.ok, true, JSON.stringify(publication));
  assert.equal(remote.pr.draft, true);
  const ready = await runHost("ready");
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(remote.pr.draft, false);
  const actualHead = git(project, "rev-parse", "HEAD");
  assert.notEqual((await runHost("resume")).data.session.status, "DONE");
  assert.equal(remote.merges, 0, "Withheld merge authority must block the effect");
  mergeAuthorization = `${repository}#1@${actualHead}`;
  remote.pr.originalHead = "a".repeat(40);
  assert.notEqual((await runHost("resume")).data?.session.status, "DONE");
  assert.equal(remote.merges, 0);
  delete remote.pr.originalHead;
  remote.ci = "pending";
  assert.notEqual((await runHost("resume")).data.session.status, "DONE");
  assert.equal(remote.merges, 0);
  remote.ci = "missing";
  assert.notEqual((await runHost("resume")).data.session.status, "DONE");
  assert.equal(remote.merges, 0);
  remote.ci = "failure";
  assert.notEqual((await runHost("resume")).data.session.status, "DONE");
  assert.equal(remote.merges, 0);
  remote.ci = "success";
  remote.loseMergeResponse = true;
  const firstMerge = await runHost("resume");
  assert.ok(firstMerge.ok, JSON.stringify(firstMerge));
  assert.equal(remote.merges, 1);
  remote.loseMergeResponse = false;
  returnWrongMergeRecord = true;
  const rejectedReconciliation = await runHost("resume");
  assert.notEqual(rejectedReconciliation.data?.session.status, "DONE");
  assert.equal(remote.merges, 1);
  returnWrongMergeRecord = false;
  const completion = await runHost("resume");
  assert.equal(completion.data?.session.status, "DONE", JSON.stringify(completion));
  assert.equal(remote.merges, 1);
  assert.equal((await runHost("resume")).data?.session.status, "DONE");
  assert.equal(remote.merges, 1);
  assert.equal(call(["next"]).taskId, "DEMO-002");
  git(project, "switch", "trunk");
  const dependentRun = call(["run", dependent.sessionId]).session;
  assert.ok(dependentRun.pendingPacket, JSON.stringify(dependentRun));
  const dependentPacket = get(project, `.vibez/outbox/${dependentRun.pendingPacket}.handoff.json`).packet;
  assert.equal(dependentPacket.taskId, "DEMO-002");
  assert.ok(dependentPacket.contextPackage.artifacts.some(item =>
    item.kind === "contract" && item.sourcePath.startsWith("vibez-package:")));
  assert.ok(!existsSync(join(project, ".agent")));
  if (!conformance && process.env.VIBEZ_TEST_INHERITED_PACKED === "1") {
    const publicCli = join(tools, "public-cli.mjs");
    put(tools, "public-cli.mjs", `export { runCli } from "${manifest.name}/cli";`);
    const inherited = spawnSync(process.execPath, ["--test", join(root, "tests", "workflow-driver.test.mjs")], {
      cwd: tools, encoding: "utf8", env: {
        ...process.env, VIBEZ_DRIVER_TEST_BIN: executable, VIBEZ_DRIVER_TEST_CLI_EXPORT: pathToFileURL(publicCli).href,
      },
    });
    assert.equal(inherited.status, 0, inherited.stdout + inherited.stderr);
  }
});
test("non-npm consumer uses only its configured validator; same task ID stays isolated", async t => {
  const temp = mkdtempSync(join(tmpdir(), "vibez non-npm "));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runNpm = (args, cwd) => run(process.execPath, [npm, "--cache", join(temp, "npm-cache"), ...args], cwd);
  const { archive } = pack(runNpm, temp);
  const tools = join(temp, "independent host");
  const projects = ["alpha", "beta"].map(name => join(temp, name + " checkout"));
  mkdirSync(tools);
  put(tools, "package.json", { private: true });
  runNpm(["install", "--offline", "--no-audit", "--no-fund", "--engine-strict", archive], tools);
  put(tools, "api.mjs", `
    export { createProjectServices, doctorProject } from "@brain-crumbs/vibez";
    export { checkProjectUpgrade, readProjectAudit, verifyHistoryBackup } from "@brain-crumbs/vibez/diagnostics";
  `);
  const api = await import(pathToFileURL(join(tools, "api.mjs")).href);
  const task = "DEMO-001";
  const contract = "control-plane.cli-shell";
  const python = process.env.VIBEZ_TEST_PYTHON ||
    run("python", ["-c", "import sys; print(sys.executable)"], tools).trim();
  const [alpha, beta] = projects.map((project, index) => {
    const config = get(tools, `node_modules/${manifest.name}/examples/beta/vibez.config.json`);
    const name = index === 0 ? "alpha" : "beta";
    const repository = `example/${name}`;
    config.project = { id: name, repository };
    config.providers.credentials = [];
    config.policy.reviewRoles = index === 0 ? ["UAT/Product"] : ["QA", "Architect"];
    put(project, "workflow.json", config);
    put(project, "planning/contracts/.gitkeep", "");
    put(project, "planning/policy.json", {});
    put(project, "planning/tasks/demo.task.json", {
      schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: task, title: "Write a marker",
      objective: "Produce the checkout-specific marker.", inScope: ["marker.txt"], outOfScope: ["Other files"],
      dependencies: [], canonicalBranch: "feature/demo-001", allowedPaths: ["marker.txt"],
      requirements: [task + "-R1"], acceptanceCriteria: [`Marker says ${name}.`],
      validationPlan: ["Run the configured Python validator"], affectedContracts: [contract],
      requiredReviewRoles: ["Developer", "MergeController"],
    });
    put(project, "planning/requirements/demo.json", {
      schemaId: "ipt.requirement", schemaVersion: "1.0.0", requirementId: task + "-R1", taskId: task,
      statement: `Marker belongs only to ${name}.`, acceptanceCriteria: [`Marker says ${name}.`], sourceRefs: ["fixture"],
    });
    put(project, "verify.py", `from pathlib import Path\nassert Path("marker.txt").read_text() == "${name}"\nprint("validator-${name}")\n`);
    put(project, ".gitignore", ".vibez/\n");
    git(project, "init", "-b", "main");
    git(project, "config", "user.name", "Conformance fixture");
    git(project, "config", "user.email", "fixture@example.invalid");
    git(project, "remote", "add", "origin", `https://github.com/${repository}.git`);
    git(project, "add", ".");
    git(project, "commit", "-m", "Configure project inputs");
    const unavailable = () => { throw new Error("Diagnostic or local operation reached GitHub"); };
    const location = { projectRoot: project, configPath: "workflow.json", verifyLocalStorage: () => true };
    const host = {
      identity: "offline-conformance@1",
      executors: new Map([["python-test", {
        command: python, args: ["verify.py"], category: "test",
      }]]),
      integration: {
        repository,
        publication: { findOpenPullRequests: unavailable, createPullRequest: unavailable, updatePullRequest: unavailable },
        pullRequests: { findPullRequestsByHead: unavailable },
        ci: { listCheckRuns: unavailable },
        merge: { findPullRequestsByHead: unavailable, getPullRequest: unavailable, mergePullRequest: unavailable },
      },
    };
    return { project, name, location, host };
  });
  const connect = async fixture => {
    const graph = await api.createProjectServices(fixture.location, fixture.host);
    return async (...args) => {
      const result = await graph.cli(["--json", ...args]);
      assert.equal(result.exitCode, 0, result.stdout || result.stderr);
      return JSON.parse(result.stdout).data;
    };
  };

  for (const fixture of [alpha, beta]) {
    const doctor = await api.doctorProject(fixture.location, fixture.host);
    assert.ok(doctor.ok, doctor.message);
  }
  const a = async (...args) => (await connect(alpha))(...args);
  const b = await connect(beta);
  assert.equal((await a("next")).taskId, task);
  assert.equal((await b("next")).taskId, task);
  assert.equal((await b("status")).progress.total, 1);
  assert.equal((await b("explain", "task", task)).taskId, task);
  assert.ok(!existsSync(join(beta.project, ".vibez")));
  await a("orchestrate", "init", "--actor-prefix", "alpha", "--developer-tools", "read_file,write_file,git_commit",
    "--review-tools", "read_file,run_test", "--enforce-policies", "externally");
  const selected = await a("orchestrate", "select", task, "--issue-number", "101");
  const started = (await a("orchestrate", "run", selected.sessionId)).session;
  const outbound = (project, session) => get(project, `.vibez/outbox/${session.pendingPacket}.handoff.json`).packet;
  const developer = outbound(alpha.project, started);
  assert.equal(developer.role, "Developer");
  assert.match(JSON.stringify(developer.contextPackage), /Marker belongs only to alpha/);
  assert.doesNotMatch(JSON.stringify(developer.contextPackage), /Marker belongs only to beta/);
  assert.equal((await (await connect(alpha))("orchestrate", "resume", selected.sessionId)).session.pendingPacket, started.pendingPacket);
  put(alpha.project, "marker.txt", "alpha");
  git(alpha.project, "add", "marker.txt");
  git(alpha.project, "commit", "-m", "Deliver the configured marker");
  const inbox = ".vibez/inbox/responses/response.json";
  const scan = async () => {
    const cli = await connect(alpha);
    await cli("orchestrate", "watch", selected.sessionId, "--once");
    await pause();
    return (await cli("orchestrate", "watch", selected.sessionId, "--once")).session;
  };
  const answer = response(developer);
  put(alpha.project, inbox, { ...answer, revisionIdentity: "wrong-revision" });
  assert.equal((await scan()).pendingPacket, developer.packetId);
  put(alpha.project, inbox, { ...answer, role: "QA" });
  assert.equal((await scan()).pendingPacket, developer.packetId);
  put(alpha.project, inbox, answer);
  const review = outbound(alpha.project, await scan());
  assert.equal(review.role, "UAT/Product");
  put(alpha.project, inbox, response(review));
  await scan();
  const state = get(alpha.project, ".vibez/state/lifecycle/DEMO-001.lifecycle.json");
  assert.equal(state.currentState, "MERGE_READY");
  const recovery = await a("recovery", "check");
  assert.equal(recovery.consistent, false);
  assert.deepEqual(recovery.findings.map(finding => finding.code), ["ORCHESTRATION_RUN_INCOMPLETE"]);
  const historyLocation = { repositoryRoot: alpha.project,
    config: { configPath: "workflow.json", verifyLocalStorage: () => true } };
  const audit = await api.readProjectAudit(historyLocation, task);
  const preflight = targetPackageVersion => api.checkProjectUpgrade({ ...historyLocation, targetPackageVersion,
    quiescence: { localWritersDrained: true, externalSessionsDrained: true } });
  const current = await preflight(manifest.version);
  const rollback = await preflight("0.1.0-mig006.0");
  assert.equal(current.target, manifest.version);
  assert.equal(current.compatible, false, "An active workflow cannot switch readers");
  assert.ok(current.findings.includes("UNSETTLED_LIFECYCLE"), JSON.stringify(current));
  assert.ok(!current.findings.includes("PRIOR_READER_DOES_NOT_SUPPORT_DRIVER_HISTORY"));
  assert.equal(rollback.snapshotSha256, current.snapshotSha256);
  const config = get(alpha.project, "workflow.json");
  const layout = Object.fromEntries(["state", "evidence", "exchange", "intake", "responses", "outbox", "operations"]
    .map(name => [name, config.paths[name]]));
  const backup = join(temp, "verified history backup");
  const restore = join(temp, "staged history restore");
  mkdirSync(backup);
  for (const path of Object.values(layout)) {
    const source = join(alpha.project, path);
    if (existsSync(source)) cpSync(source, join(backup, path), { recursive: true });
  }
  cpSync(backup, restore, { recursive: true });
  assert.equal(api.verifyHistoryBackup(backup, layout, current.snapshotSha256).matches, true);
  assert.equal(api.verifyHistoryBackup(restore, layout, current.snapshotSha256).matches, true);
  assert.ok(!rollback.findings.includes("PRIOR_READER_DOES_NOT_SUPPORT_DRIVER_HISTORY"));
  assert.ok((await preflight("99.0.0")).findings.includes("UNSUPPORTED_READER"));
  const validation = await a("explain", "validation", task);
  assert.match(JSON.stringify(validation), /python-test/);
  assert.doesNotMatch(JSON.stringify(validation), /repository:build|repository:test/);
  assert.equal(audit.evidence.filter(record => record.schemaId === "ipt.validation-evidence").length, 1);
  assert.equal((await b("next")).state, "PLANNED");
  assert.ok(!existsSync(join(beta.project, ".vibez")));
  assert.ok(!existsSync(join(beta.project, "marker.txt")));
  assert.ok(!existsSync(join(alpha.project, "package.json")));
});
