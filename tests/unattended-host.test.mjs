import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { appendHostJournal, hostDrained, markerValidatorCode, readHostJournal, pushAfterObservation, readAcceptanceChecks } from "../scripts/unattended-host.mjs";
import { consumerFiles, prepare, protectionRequests } from "../scripts/prepare-unattended-consumer.mjs";
import { digest, json, sha256, validateCredential, validateSettings } from "../scripts/unattended-host-io.mjs";
import { GitHubCiStatusOperations, verifyGitHubProtection } from "../dist/public/integration.js";
import { controlClient, publishControlRecord } from "../scripts/unattended-host-control.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = { package: "@brain-crumbs/vibez", version: "0.1.0-test", file: "fixture.tgz", sourceCommit: "a".repeat(40),
  sha256: "b".repeat(64), integrity: "sha512-fixture" };
const options = { projectId: "unattended-fixture", repository: "example/acceptance", integrationRef: "acceptance/aut004-base",
  branches: ["acceptance/aut004-task-1", "acceptance/aut004-task-2"], issueNumbers: [101, 102],
  requiredChecks: [{ name: "Unattended acceptance", appId: 15368 }], controllerAppId: 5704318,
  artifact: { repository: "example/acceptance", runId: 1, artifactId: 2, name: "vibez-candidate-" + candidate.sourceCommit } };
const template = json(join(repositoryRoot, "examples/alpha/vibez.config.json"));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "vibez-unattended-host-test-")), provider = join(root, "provider"), host = join(root, "host");
  mkdirSync(provider); mkdirSync(host); return { root, provider, host };
};

test("consumer preparation pins one dependency chain, one-file scopes and actual CI artifact identity", () => {
  const { files, tasks } = consumerFiles(options, candidate, template);
  assert.deepEqual(tasks.map(t => t.dependencies), [[], ["PROOF-001"]]);
  assert.deepEqual(tasks.map(t => t.allowedPaths), [["marker-1.txt"], ["marker-2.txt"]]);
  assert.equal(files["vibez.config.json"].policy.integrationTarget, options.integrationRef);
  const workflow = files[".github/workflows/unattended-acceptance.yml"];
  assert.match(workflow, /artifact-ids: 2/); assert.match(workflow, /run-id: 1/);
  assert.match(workflow, /pull_request.head.sha/); assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --offline --ignore-scripts/);
  assert.equal(files["engine-pin.json"].candidate.sha256, candidate.sha256);
  assert.ok(!Object.keys(files).some(path => path.startsWith("src/")));
  assert.throws(() => consumerFiles({ ...options, integrationRef: "main" }, candidate, template));
  assert.throws(() => consumerFiles({ ...options, issueNumbers: [12, 12] }, candidate, template));
  assert.throws(() => consumerFiles({ ...options, branches: ["acceptance/aut004-base", "acceptance/other"] }, candidate, template));
  assert.throws(() => consumerFiles({ ...options, artifact: { ...options.artifact, name: "latest" } }, candidate, template));
});

test("proposed rules preserve no-bypass evidence and exact controller-only update restriction", () => {
  const requests = protectionRequests(options.repository, options.integrationRef, options.requiredChecks, options.controllerAppId);
  assert.deepEqual(requests.map(r => r.body.conditions.ref_name.include), [
    ["refs/heads/acceptance/aut004-base"], ["refs/heads/acceptance/aut004-base"]]);
  const rulesets = requests.map((request, index) => ({ ...request.body, id: index + 1 }));
  const snapshot = { repository: options.repository, integrationRef: options.integrationRef, observedAtMs: 100,
    rulesets, rules: rulesets.flatMap(set => set.rules.map(rule => ({ ...rule, ruleset_id: set.id }))),
    workerPermissions: [{ metadata: "read", contents: "read", pull_requests: "read" }] };
  const expected = { repository: options.repository, integrationRef: options.integrationRef, nowMs: 101,
    maxAgeMs: 30000, trustedCheckSources: { "Unattended acceptance": 15368 }, controllerAppId: options.controllerAppId };
  verifyGitHubProtection(snapshot, expected);
  assert.throws(() => verifyGitHubProtection({ ...snapshot, rules: [] }, expected));
  assert.throws(() => verifyGitHubProtection({ ...snapshot, observedAtMs: -1 }, expected));
  assert.throws(() => verifyGitHubProtection({ ...snapshot, rulesets: [{ ...rulesets[0],
    bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }] }, rulesets[1]] }, expected));
});

test("issuer credential checks reject controller reuse, check-writer permissions, stale tokens and cross-repository authority", () => {
  const base = { repository: options.repository, token: "fixture-token-not-a-secret", expiresAt: new Date(100000).toISOString(),
    appId: options.controllerAppId, permissions: { metadata: "read", contents: "write", pull_requests: "write" } };
  validateCredential(base, "controller", options.repository, options.controllerAppId, 0);
  for (const bad of [{ ...base, repository: "example/wrong" }, { ...base, expiresAt: new Date(1).toISOString() },
    { ...base, permissions: { ...base.permissions, checks: "write" } }])
    assert.throws(() => validateCredential(bad, "controller", options.repository, options.controllerAppId, 0));
  assert.throws(() => validateCredential({ ...base, principal: "publisher" }, "publisher", options.repository, options.controllerAppId, 0));
  assert.throws(() => validateCredential(base, "worker", options.repository, options.controllerAppId, 0));
});

test("drain never treats active, mutating, uncertain host effects or incomplete provider attempts as settled", () => {
  const f = fixture();
  try {
    assert.equal(hostDrained(f.provider, f.host), true);
    for (const directory of ["active", "mutating"]) {
      mkdirSync(join(f.provider, directory)); assert.equal(hostDrained(f.provider, f.host), false);
      rmSync(join(f.provider, directory), { recursive: true });
    }
    for (const file of ["source-effect.lock", "source-index-original"]) {
      writeFileSync(join(f.host, file), "retained"); assert.equal(hostDrained(f.provider, f.host), false); rmSync(join(f.host, file));
    }
    mkdirSync(join(f.host, "pending-effects"));
    writeFileSync(join(f.host, "pending-effects", "original.json"), "{}");
    assert.equal(hostDrained(f.provider, f.host), false);
    rmSync(join(f.host, "pending-effects", "original.json"));
    const attempt = "e".repeat(64), directory = join(f.provider, attempt); mkdirSync(directory);
    writeFileSync(join(directory, "intent.json"), JSON.stringify({ version: 1, attempt, binding: "bound" }));
    assert.equal(hostDrained(f.provider, f.host), false);
    const terminal = { status: "CANCELLED", binding: "bound" };
    writeFileSync(join(directory, "terminal.json"), JSON.stringify({ terminal, sha256: digest(terminal) }));
    assert.equal(hostDrained(f.provider, f.host), true, "Confirmed historical cancellation is drained, not a PASS.");
    assert.equal(hostDrained(f.provider, f.host, 1), false);
    writeFileSync(join(directory, "terminal.json"), JSON.stringify({ terminal, sha256: "f".repeat(64) }));
    assert.equal(hostDrained(f.provider, f.host), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("immutable host audit binds commands to original operation and detects a modified or missing record", () => {
  const f = fixture();
  try {
    const first = appendHostJournal(f.host, "original-operation", "grant", "command", { command: "start" });
    appendHostJournal(f.host, "original-operation", "grant", "command", { command: "inspect" });
    const rows = readHostJournal(f.host, "original-operation", "grant");
    assert.equal(rows[1].record.previousSha256, first.sha256);
    assert.throws(() => readHostJournal(f.host, "replacement-operation", "grant"));
    const path = join(f.host, "000000000001.json");
    const edited = json(path); edited.record.details.command = "resume"; writeFileSync(path, JSON.stringify(edited));
    assert.throws(() => readHostJournal(f.host, "original-operation", "grant"));
    rmSync(path); assert.throws(() => readHostJournal(f.host, "original-operation", "grant"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a stale control owner cannot acknowledge drain, steal a lease or dispatch a second runner", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  try {
    const ledger = join(f.host, "ledger"), channel = join(f.host, "control-channel");
    mkdirSync(ledger); mkdirSync(channel); mkdirSync(join(channel, "requests")); mkdirSync(join(channel, "responses"));
    const lease = join(ledger, "host.lease"); writeFileSync(lease, '"original-holder"');
    const binding = { operationId: "original-operation", grantDigest: "original-grant", settingsSha256: "settings", packageSha256: "package" };
    const owner = { schemaId: "vibez.host-control-owner", schemaVersion: "1.0.0", ...binding, leaseSha256: sha256(readFileSync(lease)) };
    writeFileSync(join(channel, "owner.json"), JSON.stringify({ owner, sha256: digest(owner) }));
    const client = await controlClient({ hostDirectory: f.host, binding, timeoutMs: 100 });
    assert.equal(client.operations.start, undefined); assert.equal(client.operations.resume, undefined);
    await assert.rejects(() => client.operations.drain(binding.operationId), error => error.code === "CONTROL_UNACKNOWLEDGED");
    assert.equal(readFileSync(lease, "utf8"), '"original-holder"');
    assert.equal(readdirSync(join(channel, "requests")).length, 1);
    assert.equal(readdirSync(join(channel, "responses")).length, 0);
    await client.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("control publication is immutable and leaves only complete final bytes", { skip: process.platform !== "linux" }, () => {
  const f = fixture();
  try {
    const path = join(f.host, "receipt.json"), first = { original: "complete", payload: "x".repeat(32000) };
    publishControlRecord(path, first);
    assert.deepEqual(json(path), first);
    assert.throws(() => publishControlRecord(path, { replacement: true }), error => error.code === "EEXIST");
    assert.deepEqual(json(path), first);
    assert.deepEqual(readdirSync(f.host), ["receipt.json"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a separate control client waits for a staged response instead of parsing partial linked bytes", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  let clientProcess, exited;
  try {
    const ledger = join(f.host, "ledger"), channel = join(f.host, "control-channel");
    mkdirSync(ledger); mkdirSync(channel); mkdirSync(join(channel, "requests")); mkdirSync(join(channel, "responses"));
    const lease = join(ledger, "host.lease"); writeFileSync(lease, '"original-holder"');
    const binding = { operationId: "original-operation", grantDigest: "original-grant", settingsSha256: "settings", packageSha256: "package" };
    const owner = { schemaId: "vibez.host-control-owner", schemaVersion: "1.0.0", ...binding, leaseSha256: sha256(readFileSync(lease)) };
    const envelope = { owner, sha256: digest(owner) }; publishControlRecord(join(channel, "owner.json"), envelope);
    const output = join(f.host, "client-result.json"), script = join(f.host, "client.mjs");
    writeFileSync(script, 'import {writeFileSync} from "node:fs";\nimport {controlClient} from ' +
      JSON.stringify(new URL("../scripts/unattended-host-control.mjs", import.meta.url).href) + ';\n' +
      'const client=await controlClient(' + JSON.stringify({ hostDirectory: f.host, binding, timeoutMs: 5000 }) + ');\n' +
      'try {writeFileSync(' + JSON.stringify(output) + ',JSON.stringify(await client.operations.inspect("original-operation")));}' +
      'finally {await client.close();}\n');
    clientProcess = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let exitCode = null, errors = "";
    clientProcess.stderr.on("data", chunk => { errors += chunk; });
    exited = new Promise((accept, reject) => clientProcess.once("close", code => {
      exitCode = code; code === 0 ? accept() : reject(new Error("Control client failed: " + errors));
    }));
    exited.catch(() => {});
    const deadline = Date.now() + 5000;
    const finalRequests = () => readdirSync(join(channel, "requests")).filter(name => /^[0-9]+-[a-f0-9-]{36}[.]json$/.test(name));
    while (!finalRequests().length) {
      assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10));
    }
    const name = finalRequests()[0], raw = readFileSync(join(channel, "requests", name)), request = JSON.parse(raw);
    const staged = join(channel, "responses", ".vibez-control-publish-" + randomUUID() + ".tmp");
    const final = join(channel, "responses", name);
    writeFileSync(staged, '{"schemaId":'); linkSync(staged, final);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(exitCode, null); assert.equal(existsSync(output), false, "No partial response may become an acknowledgement.");
    const response = { schemaId: "vibez.host-control-response", schemaVersion: "1.0.0", ownerSha256: envelope.sha256,
      requestSha256: digest(request), requestBytesSha256: sha256(raw), operationId: binding.operationId,
      acknowledged: true, operation: { operationId: binding.operationId, status: "RUNNING" } };
    writeFileSync(staged, JSON.stringify(response));
    const fd = openSync(staged, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    unlinkSync(staged);
    await exited;
    assert.equal(json(output).status, "RUNNING");
    assert.equal(readFileSync(lease, "utf8"), '"original-holder"');
  } finally {
    if (clientProcess && clientProcess.exitCode === null) clientProcess.kill("SIGKILL");
    if (exited) await exited.catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("revocation or expiry during a synchronous protection observation denies the following push", () => {
  for (const failure of ["revoked", "expired"]) {
    let allowed = true, pushes = 0;
    assert.throws(() => pushAfterObservation(() => { allowed = false; }, () => {
      if (!allowed) throw Object.assign(new Error(failure), { code: "INACTIVE_GRANT" });
    }, () => { pushes++; }), error => error.code === "INACTIVE_GRANT");
    assert.equal(pushes, 0);
  }
});

test("GitHub missing-commit CI response permits only the scoped unpublished head to proceed to publication", async () => {
  const revision = "a".repeat(40), check = "Unattended acceptance";
  const options = { owner: "example", repo: "acceptance", token: "fixture-token" };
  const githubCi = (status, data) => new GitHubCiStatusOperations({ ...options, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, `/repos/example/acceptance/commits/${revision}/check-runs`);
    assert.equal(new URL(url).searchParams.get("check_name"), check);
    assert.equal(init.method, "GET");
    return { status, ok: status === 200, json: async () => data };
  } });
  const missing = githubCi(422, { message: "No commit found for SHA: " + revision });
  assert.deepEqual(await readAcceptanceChecks(missing, revision, check, (ref, name) => ref === revision && name === check), []);
  await assert.rejects(readAcceptanceChecks(missing, revision, check, () => false), { status: 422 });
  await assert.rejects(readAcceptanceChecks(missing, revision, check, () => { throw new Error("Remote lookup failed"); }), { status: 422 });
  for (const status of [401, 403, 404, 429, 500, 422]) {
    const wrong = githubCi(status, { message: "No commit found for SHA: " + "b".repeat(40) });
    await assert.rejects(readAcceptanceChecks(wrong, revision, check, () => true), { status });
  }
  const actual = githubCi(200, { check_runs: [{ name: check, status: "completed", conclusion: "success",
    started_at: "2026-11-18T00:00:00Z" }] });
  const checks = await readAcceptanceChecks(actual, revision, check, () => { throw new Error("Unexpected prepublication probe"); });
  assert.equal(checks[0].conclusion, "success");
});

test("pinned validator treats repository content as data and rejects changed or injected markers", () => {
  execFileSync(process.execPath, ["-e", markerValidatorCode], { input: JSON.stringify({ content: "status=ready\n" }) });
  for (const content of ["status=draft\n", "status=ready", "status=ready\nrequire('node:fs').writeFileSync('bad','bad')"])
    assert.throws(() => execFileSync(process.execPath, ["-e", markerValidatorCode], { input: JSON.stringify({ content }), stdio: "pipe" }));
});

test("local preparation uses the actual packed fixture without remote effects and leaves execution disabled", { skip: process.platform !== "linux", timeout: 120000 }, async () => {
  const f = fixture();
  try {
    const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    assert.ok(existsSync(npmCli));
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", f.host],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    const bytes = readFileSync(join(f.host, packed.filename));
    const receipt = { ...candidate, package: packed.name, version: packed.version, file: packed.filename,
      sha256: sha256(bytes), integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
    const candidateFile = join(f.host, "candidate.json"); writeFileSync(candidateFile, JSON.stringify(receipt));
    const installed = join(f.host, "installed"); mkdirSync(installed);
    execFileSync("tar", ["-xzf", join(f.host, receipt.file), "--strip-components=1", "-C", installed]);
    const assetsPath = join(f.host, "assets.json"), issuerPath = join(f.host, "issuer.mjs");
    const assetDirectory = join(f.host, "fixture-assets"); mkdirSync(assetDirectory);
    const launcher = join(assetDirectory, "launcher"), runner = join(assetDirectory, "llama-completion"), model = join(assetDirectory, "model.gguf");
    const launchObserved = join(f.host, "provider-launched");
    writeFileSync(launcher, "#!" + process.execPath + "\n" +
      "const fs=require('node:fs');fs.writeSync(3,JSON.stringify({'child-pid':2147483646}));" +
      "fs.writeFileSync(" + JSON.stringify(launchObserved) + ",'launched');process.stdin.resume();setTimeout(()=>process.exit(77),30000);\n",
      { mode: 0o700 });
    writeFileSync(runner, "fixture"); writeFileSync(model, "fixture");
    writeFileSync(assetsPath, JSON.stringify({ model: "fixture-model", runtimeVersion: "fixture-runtime", launcherPath: launcher,
      launcherSha256: sha256(readFileSync(launcher)), runtimeDirectory: assetDirectory, dependencyDirectory: assetDirectory, libraries: [],
      runnerSha256: sha256("fixture"), modelPath: model, modelSha256: sha256("fixture") }));
    const callsPath = join(f.host, "issuer-calls");
    writeFileSync(issuerPath, 'import { appendFileSync } from "node:fs";\nexport async function issue(role) {\n' +
      'appendFileSync(' + JSON.stringify(callsPath) + ',role+"\\n");\n' +
      'return { token: "fixture-only-credential-"+role, repository:"example/acceptance", principal:"fixture-publisher", ' +
      'expiresAt:new Date(Date.now()+3600000).toISOString(), appId:role==="controller"?5704318:role==="worker"?5704319:null, ' +
      'permissions:role==="worker"?{metadata:"read",contents:"read",pull_requests:"read"}:{metadata:"read",contents:"write",pull_requests:"write"} }; }\n');
    const pin = path => ({ path, sha256: sha256(readFileSync(path)) });
    const result = await prepare({ ...options, destination: join(f.root, "prepared"), candidateFile, installedDirectory: installed,
      assets: pin(assetsPath), tokenIssuer: pin(issuerPath), npmCli,
      seedTimestamp: "2026-01-01T00:00:00Z", notBeforeMs: Date.now() - 1000, expiresAtMs: Date.now() + 3600000 });
    assert.equal(existsSync(callsPath), false, "Preparation never invokes the credential issuer.");
    assert.equal(result.controlsEnabled, false);
    assert.equal(json(join(result.hostDirectory, "controls.json")).enabled, false);
    assert.equal(json(join(result.hostDirectory, "operator-attestation.json")).status, "PENDING");
    assert.equal(json(join(result.hostDirectory, "administration-proposal.json")).authority, "PROPOSED_SETUP_ONLY");
    assert.ok(existsSync(join(result.projectRoot, "node_modules/@brain-crumbs/vibez/package.json")));
    assert.ok(!existsSync(join(result.projectRoot, "src")));
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: result.projectRoot, encoding: "utf8" }), "");
    const { openAcceptance } = await import(pathToFileURL(result.setupFile).href);
    const opened = await openAcceptance();
    try {
      opened.recordCommand("start");
      const operation = await opened.services.operations.start(opened.plan.planId, opened.operationId);
      assert.equal(operation.status, "EXCEPTION");
      assert.equal(operation.exception.code, "INACTIVE_GRANT");
      assert.equal(opened.verifyDrained(), true);
      assert.deepEqual(readdirSync(opened.providerDirectory), [], "A disabled grant never launches a provider.");
      assert.equal(opened.commandLog().length, 1);
      assert.equal(opened.readOperatorAttestation().status, "PENDING");
    } finally { await opened.close(); }

    // Regression: a second installed process must control the original live writer
    // without opening a second policy evaluator or launching another provider.
    const controlsFile = join(result.hostDirectory, "controls.json"), controls = json(controlsFile);
    writeFileSync(controlsFile, JSON.stringify({ ...controls, enabled: true }));
    const ownerReady = join(f.host, "owner-ready"), ownerResult = join(f.host, "owner-result.json"), ownerStop = join(f.host, "owner-stop");
    const ownerScript = join(f.host, "owner.mjs"), clientScript = join(f.host, "client.mjs");
    writeFileSync(ownerScript, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      'const {openAcceptance}=await import(pathToFileURL(process.argv[2]).href);',
      'const setup=await openAcceptance({command:"resume"});',
      'try {',
      'setup.recordCommand("resume");',
      'writeFileSync(' + JSON.stringify(ownerReady) + ',"ready");',
      'const operation=await setup.services.operations.resume(setup.operationId);',
      'writeFileSync(' + JSON.stringify(ownerResult) + ',JSON.stringify(operation));',
      'const deadline=Date.now()+20000;',
      'while(!existsSync(' + JSON.stringify(ownerStop) + ')&&Date.now()<deadline) await new Promise(r=>setTimeout(r,25));',
      '} finally { await setup.close(); }',
    ].join("\n"));
    writeFileSync(clientScript, [
      'import {pathToFileURL} from "node:url";',
      'const {openAcceptance}=await import(pathToFileURL(process.argv[2]).href);',
      'const command=process.argv[3],setup=await openAcceptance({command});',
      'try { const operation=await setup.services.operations[command](setup.operationId);',
      'console.log(JSON.stringify({controlOnly:setup.controlOnly,hasPolicy:Boolean(setup.policy),operation}));',
      '} finally { await setup.close(); }',
    ].join("\n"));
    const ownerProcess = spawn(process.execPath, [ownerScript, result.setupFile], { stdio: ["ignore", "pipe", "pipe"] });
    let ownerErrors = ""; ownerProcess.stderr.on("data", chunk => { ownerErrors += chunk; });
    const ownerExit = new Promise((accept, reject) => {
      ownerProcess.on("error", reject);
      ownerProcess.on("close", code => code === 0 ? accept() : reject(new Error("Control owner failed: " + ownerErrors)));
    });
    const waitFor = async predicate => {
      const deadline = Date.now() + 15000;
      while (!predicate()) { assert.ok(Date.now() < deadline, "The original owner did not reach the expected native state."); await new Promise(r => setTimeout(r,25)); }
    };
    const client = command => JSON.parse(execFileSync(process.execPath, [clientScript, result.setupFile, command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }));
    try {
      await waitFor(() => existsSync(ownerReady) && existsSync(launchObserved));
      const leaseFile = join(result.hostDirectory, "ledger", "host.lease"), originalLease = readFileSync(leaseFile, "utf8");
      const issuerCalls = readFileSync(callsPath, "utf8");
      const channel = join(result.hostDirectory, "control-channel"), channelOwner = json(join(channel, "owner.json"));
      const stagedRequest = join(channel, "requests", ".vibez-control-publish-" + randomUUID() + ".tmp");
      const requestId = Date.now() + "-" + randomUUID(), requestName = requestId + ".json";
      const originalRequest = { schemaId: "vibez.host-control-request", schemaVersion: "1.0.0", requestId,
        ownerSha256: channelOwner.sha256, operationId: channelOwner.owner.operationId,
        grantDigest: channelOwner.owner.grantDigest, command: "inspect", requestedAt: new Date().toISOString() };
      // Widen both partial staging and the final nlink=2 interval across real owner polls.
      writeFileSync(stagedRequest, '{"schemaId":');
      await new Promise(r => setTimeout(r, 100));
      linkSync(stagedRequest, join(channel, "requests", requestName));
      const malformedName = Date.now() + "-" + randomUUID() + ".json", malformed = "{malformed final request";
      const malformedStaged = join(channel, "requests", ".vibez-control-publish-" + randomUUID() + ".tmp");
      writeFileSync(malformedStaged, malformed); linkSync(malformedStaged, join(channel, "requests", malformedName)); unlinkSync(malformedStaged);
      await waitFor(() => existsSync(join(channel, "responses", malformedName)));
      const rejected = json(join(channel, "responses", malformedName));
      assert.equal(rejected.acknowledged, false); assert.equal(rejected.errorCode, "CONTROL_REJECTED");
      assert.equal(rejected.requestBytesSha256, sha256(malformed));
      for (const command of ["inspect", "pause", "drain"]) {
        const response = client(command);
        assert.equal(response.controlOnly, true); assert.equal(response.hasPolicy, false);
        assert.equal(response.operation.operationId, json(join(result.hostDirectory, "settings.json")).operationId);
        assert.equal(response.operation.status, "RUNNING", "An active provider is not a confirmed drain.");
        assert.equal(readFileSync(leaseFile, "utf8"), originalLease);
      }
      writeFileSync(stagedRequest, JSON.stringify(originalRequest) + "\n");
      const stagedFd = openSync(stagedRequest, "r"); try { fsyncSync(stagedFd); } finally { closeSync(stagedFd); }
      unlinkSync(stagedRequest);
      await waitFor(() => existsSync(join(channel, "responses", requestName)));
      assert.equal(json(join(channel, "responses", requestName)).acknowledged, true);
      const cancelled = client("cancel");
      assert.equal(cancelled.controlOnly, true);
      await waitFor(() => existsSync(ownerResult) && hostDrained(join(result.hostDirectory, "provider"), result.hostDirectory));
      const drained = client("drain");
      assert.equal(drained.operation.status, "DRAINED");
      assert.equal(readFileSync(leaseFile, "utf8"), originalLease);
      assert.equal(readFileSync(callsPath, "utf8"), issuerCalls, "Control-only clients never obtain credentials.");
      assert.equal(readdirSync(join(result.hostDirectory, "provider")).length, 1, "Only the original provider attempt exists.");
      assert.equal(readdirSync(join(result.hostDirectory, "control-channel", "requests")).length, 7);
      assert.equal(readdirSync(join(result.hostDirectory, "control-channel", "responses")).length, 7);
    } finally { writeFileSync(ownerStop, "stop"); await ownerExit; }

    const git = (...args) => execFileSync("git", args, { cwd: result.projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("switch", options.branches[0]);
    writeFileSync(join(result.projectRoot, "marker-1.txt"), "status=ready\n");
    git("add", "marker-1.txt"); git("commit", "-m", "Deterministic consumer CI fixture only");
    const head = git("rev-parse", "HEAD"); git("checkout", "--detach", head);
    const verify = () => execFileSync(process.execPath, ["scripts/verify-acceptance.mjs"], {
      cwd: result.projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ACCEPTANCE_BRANCH: options.branches[0], ACCEPTANCE_HEAD: head } });
    assert.equal(JSON.parse(verify()).head, head);
    writeFileSync(join(result.projectRoot, "marker-2.txt"), "status=ready\n");
    assert.throws(verify, "The first task cannot silently advance its dependent marker.");
    await assert.rejects(() => prepare({ ...options, destination: join(f.root, "prepared") }));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
