#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createProjectServices } from "../dist/public/index.js";
import { resolveProjectConfig } from "../dist/public/config.js";
import { createLocalLlamaRuntime, LOCAL_LLAMA_PROVIDER_ID } from "../dist/public/providers.js";
import { ScopedHostPolicy, scopedAgentProvider } from "../dist/public/integration.js";

const assetsPath = process.argv[2];
if (!assetsPath || process.argv.length !== 3) throw Error("Pass the trusted LocalLlamaAssets JSON file.");
const assets = JSON.parse(readFileSync(resolve(assetsPath), "utf8"));
const lab = mkdtempSync(join(tmpdir(), "vibez-local-agent-"));
const root = join(lab, "consumer");
const ops = join(lab, "provider");
mkdirSync(root, {mode:0o700});
mkdirSync(ops, {mode:0o700});
mkdirSync(join(lab, "policy"), {mode:0o700});
const git = (...args) => execFileSync("git", args, { cwd:root, encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim();
const put = (name, data) => {
  const file = join(root, name);
  mkdirSync(dirname(file), {recursive:true});
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data,null,2)+"\n");
};
const configuration = JSON.parse(readFileSync(new URL("../examples/beta/vibez.config.json", import.meta.url), "utf8"));
const taskId = "DEMO-101";
const branch = "feature/local-marker";
const roleNames = ["Developer","QA","Architect","UAT/Product"];
configuration.project = {id:"local-llama-proof", repository:"example/vibez-local-provider-proof"};
configuration.providers = {execution:LOCAL_LLAMA_PROVIDER_ID, credentials:[]};
configuration.validators = [{id:"check-marker",executorId:"check-marker",required:true}];
configuration.budgets.providerTimeoutMs = 120_000;
const p = configuration.paths;
put("vibez.config.json", configuration);
put(".gitignore", ".vibez/\n");
put(p.contextPolicy, {description:"Offline disposable consumer. All requested behavior is shown by the one marker file."});
put("marker.txt", "status=draft\n");
put(p.tasks + "/marker.task.json", {
  schemaId:"ipt.task", schemaVersion:"1.0.0", taskId, title:"Make the release marker ready",
  objective:'Replace marker.txt with exactly status=ready followed by one newline. No other file changes.',
  inScope:["Rewrite marker.txt only."], outOfScope:["Other files and all remote operations."], dependencies:[],
  canonicalBranch:branch, allowedPaths:["marker.txt"], requirements:["DEMO-101-R1"],
  acceptanceCriteria:["The sole marker line is status=ready with one final LF."],
  validationPlan:["Run the marker validator and inspect current marker.txt."],
  affectedContracts:["consumer.marker"], requiredReviewRoles:[...roleNames,"MergeController"],
});
put(p.requirements + "/marker.json", {
  schemaId:"ipt.requirement",schemaVersion:"1.0.0",requirementId:"DEMO-101-R1",taskId,
  statement:"The operator reads status=ready on one line after the committed change.",
  acceptanceCriteria:["The marker is exactly status=ready plus one trailing newline."],sourceRefs:["offline rehearsal"],
});
put(p.contracts + "/marker.json", {moduleId:"consumer.marker",moduleVersion:"1.0.0",
  knownConsumers:[{consumerId:"operator",expects:["One status line. The approved change is draft to ready."]}]});
git("init","-b","main");
git("config","user.name","Local provider rehearsal");
git("config","user.email","proof@example.invalid");
git("remote","add","origin","https://github.com/"+configuration.project.repository+".git");
git("add",".");
git("commit","-m","Seed offline marker consumer");
const source = git("rev-parse","HEAD");
const location = {projectRoot:root,configPath:"vibez.config.json"};
const config = resolveProjectConfig(location);
const refuseRemote = () => { throw Error("No outbound integration exists for this rehearsal."); };
const roles = roleNames.map((role,index) => ({
  role, principal:"offline-principal-" + index, provider:LOCAL_LLAMA_PROVIDER_ID, model:assets.model,
  tools:role === "Developer" ? ["snapshot.read","workspace.replace"] : ["snapshot.read"], network:"none",
}));
const { runtime } = await createLocalLlamaRuntime({
  repositoryRoot:root, projectIdentity:config.projectIdentity, operationDirectory:ops, assets,
  contextTokens:16384, outputTokens:768,
  snapshotPaths:()=>["marker.txt"], editablePath:()=>"marker.txt",
  replaceFile(edit, {expectedRevision,expectedBranch,signal}) {
    assert.equal(edit.path,"marker.txt");
    assert.equal(git("rev-parse","HEAD"),expectedRevision);
    assert.equal(git("branch","--show-current"),expectedBranch);
    assert.equal(git("status","--porcelain"),"");
    signal.throwIfAborted();
    put(edit.path,edit.content);
    git("add","--","marker.txt");
    git("commit","-m","Set the release marker","--","marker.txt");
    return {status:"COMMITTED",revision:git("rev-parse","HEAD")};
  },
  runValidator:refuseRemote,
});
const now = Date.now();
const checks = configuration.policy.requiredChecks;
const validators = [{id:"check-marker",commandDigest:createHash("sha256").update("offline marker check").digest("hex")}];
const grant = {
  schemaId:"vibez.host-grant",schemaVersion:"1.0.0",grantId:"offline-role-proof",
  projectIdentity:config.projectIdentity,configDigest:config.configDigest,repository:configuration.project.repository,
  integrationRef:"main",notBeforeMs:now-1000,expiresAtMs:now+900_000,
  tasks:[{taskId,branch,paths:["marker.txt"]}],roles,validators,requiredChecks:checks,requiredReviews:roleNames.slice(1),
  actions:["agent"],humanOnly:[],budgets:{maxConcurrent:1,maxAgentTurns:4,maxCommands:1,maxCostMicros:0,maxRuntimeMs:480_000,maxReworks:0},
};
const policy = new ScopedHostPolicy({
  grant,ledgerDirectory:join(lab,"policy"),worktreeRoot:root,verifyDrained:()=>false,
  observe:()=>({projectIdentity:config.projectIdentity,configDigest:config.configDigest,repository:configuration.project.repository,
    integrationRef:"main",revision:git("rev-parse","HEAD"),branch:git("branch","--show-current"),revoked:false,enabled:true,
    checks,validators,reviews:roleNames.slice(1)}),
});
const provider = scopedAgentProvider(policy,runtime,{maxTurns:1,maxCostMicros:0});
const services = await createProjectServices(location,{
  identity:"offline-llama-proof@2",
  actorIdFor:(role,owner)=>roles.find(entry=>entry.role===role)?.principal ?? owner+"::controller",
  toolPermissionPolicyFor:role=>({allowedTools:roles.find(entry=>entry.role===role)?.tools ?? [],networkAccess:"none"}),
  providers:new Map([[provider.providerId,provider]]),
  executors:new Map([["check-marker",{command:process.execPath,args:["-e",
    "if (require('node:fs').readFileSync('marker.txt','utf8') !== 'status=ready\\n') process.exit(1)"],
    category:"test"}]]),
  integration:{repository:configuration.project.repository,
    publication:{findOpenPullRequests:refuseRemote,createPullRequest:refuseRemote,updatePullRequest:refuseRemote},
    pullRequests:{findPullRequestsByHead:async()=>[]},ci:{listCheckRuns:refuseRemote},
    merge:{findPullRequestsByHead:refuseRemote,getPullRequest:refuseRemote,mergePullRequest:refuseRemote}},
});
try {
  const run = await services.orchestration.run({ownerId:roles[0].principal,
    runId:"offline-proof",occurredAt:new Date().toISOString(),timeoutMs:480_000});
  assert.equal(run.finalLifecycleState,"MERGE_READY",JSON.stringify({state:run.finalLifecycleState,stopped:run.stopped}));
  assert.equal(run.status,"STOPPED");
  assert.equal(run.stopped.stage,"merge-readiness");
  assert.deepEqual(run.stages.filter(stage=>stage.role!==null).map(stage=>[stage.stage,stage.outcome]),[
    ["developer-agent","PASS"],["qa-agent","PASS"],["qa-review","PASS"],
    ["architecture-agent","PASS"],["architecture-review","PASS"],["uat-agent","PASS"],["uat-review","PASS"],
  ]);
  const implemented=git("rev-parse","HEAD");
  assert.notEqual(implemented,source);
  assert.equal(readFileSync(join(root,"marker.txt"),"utf8"),"status=ready\\n");
  const sessions=readdirSync(ops).map(attempt=>{
    const dir=join(ops,attempt);
    const intent=JSON.parse(readFileSync(join(dir,"intent.json"),"utf8"));
    const terminal=JSON.parse(readFileSync(join(dir,"terminal.json"),"utf8")).terminal;
    assert.equal(terminal.status,"COMPLETED");
    assert.equal(intent.revision,intent.role==="Developer"?source:implemented);
    assert.equal(terminal.result.revisionIdentity,intent.revision);
    if(intent.role==="Developer")assert.equal(terminal.workspaceRevision,implemented);
    return {role:intent.role,runId:terminal.result.runId,revision:intent.revision,session:intent.session,
      provider:intent.provider,configDigest:intent.configDigest,refs:terminal.result.evidenceRefs};
  });
  assert.equal(new Set(sessions.map(entry=>entry.session)).size,4);
  assert.equal(policy.decisions().filter(record=>record.decision==="settled").length,4);
  console.log(JSON.stringify({source,implemented,state:run.finalLifecycleState,sessions,fixture:lab,
    providerVersion:assets.runtimeVersion,modelSha256:assets.modelSha256}));
} finally {
  policy.close();
}
