import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertLiveChain, verifyCandidate, fileInventory, sha256, canonical, redactOperation } from "../scripts/unattended-acceptance.mjs";

import { readProviderSessions } from "../scripts/unattended-evidence.mjs";
const digest = value => sha256(canonical(value));

// These records exercise the verifier format only. They are never release acceptance evidence.
function fixture() {
  const report = { evidenceKind: "LIVE_GITHUB_INSTALLED_CHAIN", repository: "example/fixture",
    integrationRef: "proof", operation: { operationId: "00000000-0000-4000-8000-000000000000", status: "DONE", completed: ["DEMO-001", "DEMO-002"] },
    requiredChecks: [{ name: "installed", appId: 15368 }], interventions: [], tasks: [], sessions: [],
    replay: { noNewEffects: true, lifecycleBefore: "a".repeat(64), lifecycleAfter: "a".repeat(64), providerBefore: "b".repeat(64), providerAfter: "b".repeat(64),
      policyBefore: "c".repeat(64), policyAfter: "c".repeat(64) } };
  report.package = { package: "@brain-crumbs/vibez", sourceCommit: "1".repeat(40), sha256: "a".repeat(64), integrity: "sha512-" + Buffer.alloc(64).toString("base64") };
  for (const key of ["installedTreeSha256", "configurationDigest", "providerConfigurationDigest", "projectIdentity", "grantDigest", "planDigest", "setupSha256"]) report[key] = "a".repeat(64);
  report.requiredValidators = ["test"];
  report.operation.planHash=report.planDigest;report.operation.grantDigest=report.grantDigest;
  Object.assign(report.replay,{evidenceBefore:"e".repeat(64),evidenceAfter:"e".repeat(64),operationsBefore:"1".repeat(64),operationsAfter:"1".repeat(64),hostBefore:"2".repeat(64),hostAfter:"2".repeat(64)});
  for (const n of [1, 2]) {
    const taskId = "DEMO-00" + n, revision = String(n).repeat(40), merge = String(n+2).repeat(40);
    const reviews = ["QA", "Architect", "UAT/Product"].map((role, index) => ({
      role, runId: taskId + "-" + role, contextPackageId: "c".repeat(64), actorId: "principal-" + index, session: taskId + "-" + role, revision, outcome: "PASS", evidenceRef: taskId + role + "@1" }));
    report.tasks.push({ taskId, sourceRevision: revision, mergeCommitSha: merge, branch: "task-" + n, state: "DONE",
      dependencies: n === 2 ? ["DEMO-001"] : [], developerActorId: "developer", reviews,
      validators: [{ id: "test", outcome: "PASS", revision }],
      nativeAudit: {state:"DONE",findings:[]},nativeAuditSha256:digest({state:"DONE",findings:[]}),
      checks: [{ name: "installed", appId: 15368, headSha: revision, status: "completed", conclusion: "success" }],
      pr: { repository: report.repository, number: n, baseRef: "proof", headRef: "task-" + n, headSha: revision,
        mergeCommitSha: merge, merged: true, draft: false, mergedAt: "2026-11-17T02:0" + n + ":00Z" } });
    for (const role of ["Developer", "QA", "Architect", "UAT/Product"]) report.sessions.push({
      taskId, role, session: taskId + "-" + role, runId: taskId + "-" + role, provider:"local-llama.cpp", actorId: role==="Developer"?"developer":"principal-"+["QA","Architect","UAT/Product"].indexOf(role), contextPackageId:"c".repeat(64), outcome: "PASS", revision,
      startedAt: "2026-11-17T02:0" + (n-1) + ":30Z" });
  }
  const record = { sequence:1, operationId:report.operation.operationId, grantDigest:report.grantDigest,
    previousSha256:null, kind:"command", occurredAt:"2026-11-17T01:59:00Z", details:{command:"start",scenario:"live-chain"} };
  report.commandAudit=[{record,sha256:digest(record)}];
  report.operatorAttestation={status:"ATTESTED",operationId:report.operation.operationId,grantDigest:report.grantDigest,
    actor:"fixture-operator",initialSetupRef:"fixture-owner-grant",occurredAt:"2026-11-17T02:03:00Z",
    throughCommandSha256:report.commandAudit[0].sha256,noRoutineHandoffs:true};
  return report;
}

test("live-chain verifier accepts a complete synthetic format and retains past rejected sessions", () => {
  const report = fixture();
  report.sessions.push({ taskId: "DEMO-001", role: "QA", session: "rejected-original",
    outcome: "FAIL", revision: "9".repeat(40), startedAt: "2026-11-17T02:00:01Z" });
  assert.doesNotThrow(() => assertLiveChain(report));
});
const mutations = [
  ["mismatched operation plan", report => { report.operation.planHash="b".repeat(64); }],
  ["mismatched operation grant", report => { report.operation.grantDigest="b".repeat(64); }],
  ["host replay mutation", report => { report.replay.hostAfter="changed"; }],

  ["unattested zero handoffs", report => { report.operatorAttestation.status="PENDING"; }],
  ["foreign handoff attestation", report => { report.operatorAttestation.operationId="foreign"; }],
  ["attestation before completion", report => { report.operatorAttestation.occurredAt="2026-11-17T01:59:30Z"; }],
  ["unknown command prefix", report => { report.operatorAttestation.throughCommandSha256="0".repeat(64); }],
  ["missing command audit", report => { report.commandAudit=[]; }],
  ["changed command journal", report => { report.commandAudit[0].record.details.command="resume"; }],
  ["routine resume command", report => { report.commandAudit[0].record.details.command="resume";
    report.commandAudit[0].sha256=digest(report.commandAudit[0].record);
    report.operatorAttestation.throughCommandSha256=report.commandAudit[0].sha256; }],

  ["missing package provenance", report => { delete report.package; }],
  ["missing grant", report => { delete report.grantDigest; }],
  ["different native context", report => { report.tasks[0].reviews[0].contextPackageId="d".repeat(64); }],
  ["different provider run", report => { report.sessions[1].runId="other-run"; }],
  ["evidence replay mutation", report => { report.replay.evidenceAfter="different"; }],
  ["operation journal replay mutation", report => { report.replay.operationsAfter="different"; }],
  ["missing configured validator", report => { report.requiredValidators.push("second"); }],
  ["unresolved native audit finding", report => { report.tasks[0].nativeAudit.findings.push("STALE_REVIEW"); }],
  ["simulated ports", report => { report.evidenceKind = "SIMULATED_REMOTE"; }],
  ["routine response import", report => { report.interventions.push({ action: "manual-import" }); }],
  ["unfinished native task", report => { report.tasks[1].state = "MERGE_READY"; }],
  ["unmerged remote PR", report => { report.tasks[1].pr.merged = false; }],
  ["head mismatch", report => { report.tasks[1].pr.headSha = "9".repeat(40); }],
  ["wrong remote repository", report => { report.tasks[0].pr.repository = "example/other"; }],
  ["wrong integration ref", report => { report.tasks[0].pr.baseRef = "main"; }],
  ["wrong canonical branch", report => { report.tasks[0].pr.headRef = "other"; }],
  ["missing dependent edge", report => { report.tasks[1].dependencies = []; }],
  ["out-of-order dependency", report => { report.tasks[0].dependencies = ["DEMO-002"]; }],
  ["duplicate PR", report => { report.tasks[1].pr.number = 1; }],
  ["missing review", report => { report.tasks[0].reviews.pop(); }],
  ["stale review", report => { report.tasks[0].reviews[0].revision = "9".repeat(40); }],
  ["developer self approval", report => { report.tasks[0].reviews[0].actorId = "developer"; }],
  ["shared reviewer identity", report => { report.tasks[0].reviews[1].actorId = "principal-0"; }],
  ["shared provider session", report => { report.sessions[1].session = report.sessions[0].session; }],
  ["missing actual review session", report => { report.tasks[0].reviews[0].session = "invented"; }],
  ["missing validation", report => { report.tasks[0].validators = []; }],
  ["failed validation", report => { report.tasks[0].validators[0].outcome = "FAIL"; }],
  ["stale validation", report => { report.tasks[0].validators[0].revision = "9".repeat(40); }],
  ["untrusted CI writer", report => { report.tasks[0].checks[0].appId = 99; }],
  ["stale CI", report => { report.tasks[0].checks[0].headSha = "9".repeat(40); }],
  ["skipped required CI", report => { report.tasks[0].checks[0].conclusion = "skipped"; }],
  ["failed optional relevant CI", report => { report.tasks[0].checks.push({ status: "completed", conclusion: "failure" }); }],
  ["child dispatched before merge", report => { report.sessions.find(x=>x.taskId==="DEMO-002").startedAt = "2026-11-17T01:00:00Z"; }],
  ["replay mutation", report => { report.replay.lifecycleAfter = "different"; }],
];
for (const [name, mutate] of mutations) test("release evidence rejects " + name, () => {
  const report = fixture(); mutate(report); assert.throws(() => assertLiveChain(report));
});

test("candidate verification compares actual installed bytes and both package digests", () => {
  const root = mkdtempSync(join(tmpdir(), "vibez-acceptance-artifact-"));
  try {
    const source = join(root, "source"), installed = join(root, "installed");
    mkdirSync(source); mkdirSync(join(source, "package")); mkdirSync(installed);
    const manifest = JSON.stringify({ name: "@brain-crumbs/vibez", version: "0.1.0-test" });
    for (const directory of [join(source, "package"), installed]) writeFileSync(join(directory, "package.json"), manifest);
    const tarball = join(root, "candidate.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", source, "package"]);
    const bytes = readFileSync(tarball), receipt = { package: "@brain-crumbs/vibez", version: "0.1.0-test",
      file: "candidate.tgz", sourceCommit: "1".repeat(40), sha256: sha256(bytes),
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
    const path = join(root, "candidate.json"); writeFileSync(path, JSON.stringify(receipt));
    assert.equal(verifyCandidate(path, installed, join(root, "verified")).candidate.sha256, receipt.sha256);
    writeFileSync(join(installed, "package.json"), manifest + "\n");
    assert.throws(() => verifyCandidate(path, installed, join(root, "changed")));
    writeFileSync(path, JSON.stringify({ ...receipt, integrity: "sha512-invalid" }));
    assert.throws(() => verifyCandidate(path, installed, join(root, "digest-mismatch")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("inventories refuse linked files", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "vibez-acceptance-link-"));
  try { symlinkSync(import.meta.filename, join(root, "link")); assert.throws(() => fileInventory(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
});


test("operation observations omit arbitrary exception text", () => {
  const value=redactOperation({operationId:"test",status:"EXCEPTION",exception:{code:"CUSTOM_SECRET",message:"PRIVATE_PROVIDER_RESPONSE",remediation:"PRIVATE_CREDENTIAL"}});
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|CUSTOM_SECRET/);
  assert.equal(value.exception.code,"UNCLASSIFIED_STOP");
  assert.match(value.exception.privateDetailSha256,/^[a-f0-9]{64}$/);
});
function providerFixture(t) {
  const root=mkdtempSync(join(tmpdir(),"vibez-provider-evidence-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const projectIdentity="a".repeat(64), role="QA", taskId="DEMO-001", run="original", runId=run+"::qa-agent";
  const attempt=digest([projectIdentity,taskId,role,runId]), directory=join(root,attempt);mkdirSync(directory);
  const intent={version:1,attempt,binding:"b".repeat(64),session:"independent-session",role,revision:"1".repeat(40),
    projectIdentity,configDigest:"c".repeat(64),provider:"local-llama.cpp",runtimeVersion:"b12477",model:"Qwen3",modelSha256:"d".repeat(64),occurredAt:"2026-11-17T00:00:00Z"};
  const result={runId,taskId,role,revisionIdentity:intent.revision,providerId:intent.provider,outcome:"PASS",details:{},findings:[],evidenceRefs:["local-llama:"+attempt]};
  const terminal={binding:intent.binding,status:"COMPLETED",result};
  const journal={runId:run,values:{start:{taskId},"qa-agent":{actorId:"reviewer",contextId:"e".repeat(64),result:structuredClone(result)}}};
  const setup={providerDirectory:root,config:{projectIdentity},expectedProviderConfigDigest:intent.configDigest,
    providerIdentity:{runtimeVersion:intent.runtimeVersion,model:intent.model,modelSha256:intent.modelSha256}};
  const save=(hash=digest(terminal))=>{writeFileSync(join(directory,"intent.json"),JSON.stringify(intent));writeFileSync(join(directory,"terminal.json"),JSON.stringify({terminal,sha256:hash}));};
  save(); return {intent,terminal,journal,setup,save,read:()=>readProviderSessions(setup,[journal],{sha256,digest})};
}
test("provider evidence binds original runtime receipt to native run and preserves cancellation history", t => {
  const f=providerFixture(t);assert.equal(f.read()[0].contextPackageId,"e".repeat(64));
  delete f.terminal.result;f.terminal.status="CANCELLED";delete f.journal.values["qa-agent"];f.save();
  const result=f.read()[0];assert.equal(result.status,"CANCELLED");assert.equal(result.outcome,null);assert.equal(result.taskId,"DEMO-001");
});
for(const [name,mutate] of [
  ["missing expected runtime identity",f=>{delete f.setup.providerIdentity;}],
  ["terminal checksum",f=>f.save("0".repeat(64))],
  ["foreign run",f=>{f.terminal.result.runId="foreign";f.save();}],
  ["substituted provider",f=>{f.intent.provider="fixture";f.terminal.result.providerId="fixture";f.save();}],
  ["different native response",f=>{f.journal.values["qa-agent"].result.outcome="FAIL";}],
  ["wrong runtime config",f=>{f.intent.configDigest="0".repeat(64);f.save();}],
  ["wrong model bytes",f=>{f.intent.modelSha256="0".repeat(64);f.save();}],
  ["attempt directory mismatch",f=>{f.intent.attempt="0".repeat(64);f.save();}],
]) test("provider evidence rejects "+name,t=>{const f=providerFixture(t);mutate(f);assert.throws(()=>f.read());});

test("runner closes its original host if candidate verification fails", async t => {
  const root=mkdtempSync(join(tmpdir(),"vibez-runner-close-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const setup=join(root,"setup.mjs"),closed=join(root,"closed");
  writeFileSync(setup, 'import {writeFileSync} from "node:fs";\nexport async function openAcceptance(options){' +
    'if(options.command!=="inspect")throw Error("wrong command");return {' +
    'operationId:"00000000-0000-4000-8000-000000000000",outputDirectory:'+JSON.stringify(join(root,"observations"))+',' +
    'candidateFile:'+JSON.stringify(join(root,"missing-candidate.json"))+',' +
    'installedDirectory:'+JSON.stringify(root)+',close(){writeFileSync('+JSON.stringify(closed)+',"closed")}};}');
  const {main}=await import("../scripts/unattended-acceptance.mjs");
  await assert.rejects(main([setup,"inspect"]));
  assert.equal(readFileSync(closed,"utf8"),"closed");
});
