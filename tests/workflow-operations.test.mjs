import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { createProjectServices } from "../dist/public/index.js";
import { resolveProjectConfig } from "../dist/public/config.js";
import { ScopedHostPolicy, commandPolicyDigest } from "../dist/public/integration.js";
import { verifyHistoryBackup } from "../dist/public/diagnostics.js";

const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const digest=value=>createHash("sha256").update(canonical(value)).digest("hex");
const evidenceBytes=root=>{
  const directory=join(root,".vibez/evidence"),files={};
  const visit=(path,prefix="")=>{for(const item of readdirSync(path,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())visit(join(path,item.name),name+"/");else files[name]=readFileSync(join(path,item.name),"utf8");}};
  if(existsSync(directory))visit(directory);return files;
};

const roles=["Developer","QA","Architect","UAT/Product"];
async function fixture(t,options={}) {
  const lab=mkdtempSync(join(tmpdir(),"vibez operations ")), root=join(lab,"consumer");mkdirSync(root);
  const git=(...args)=>execFileSync("git",args,{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const put=(path,value)=>{mkdirSync(join(root,path,".."),{recursive:true});writeFileSync(join(root,path),typeof value==="string"?value:JSON.stringify(value,null,2)+"\n");};
  git("init","-b","main");git("config","user.name","Operation fixture");git("config","user.email","fixture@example.test");
  git("remote","add","origin","https://github.com/example/operations.git");
  const config=JSON.parse(readFileSync(process.env.VIBEZ_OPERATIONS_CONFIG??new URL("../examples/beta/vibez.config.json",import.meta.url)));
  config.project={id:"operations",repository:"example/operations"};config.providers={execution:"fixture-worker",credentials:[]};
  config.budgets={maxAttempts:2,retryDelayMs:1,providerTimeoutMs:10000,operationTimeoutMs:60000,maxReworkCycles:2};
  config.validators=["marker",...(options.secondValidator?["marker-second"]:[])].map(id=>({id,executorId:id,required:true}));config.policy.requiredChecks=["fixture-ci"];
  put("vibez.config.json",config);put(".gitignore",".vibez/\n");put("planning/policy.json",{description:"Independent fixture roles"});
  put("planning/contracts/product.json",{moduleId:"consumer.product",moduleVersion:"1.0.0"});mkdirSync(join(root,"planning/requirements"),{recursive:true});
  // A tracked placeholder makes the empty requirement directory durable.
  put("planning/requirements/.keep","");
  const tasks=[1,2].map(n=>({schemaId:"ipt.task",schemaVersion:"1.0.0",taskId:`DEMO-00${n}`,title:`Set marker ${n}`,
    objective:`Write ready into marker-${n}.txt`,inScope:[`Set marker ${n}`],outOfScope:["Other changes"],dependencies:n===1?[]:["DEMO-001"],
    canonicalBranch:`feature/marker-${n}`,allowedPaths:[`marker-${n}.txt`],requirements:[],acceptanceCriteria:["Marker is ready"],validationPlan:["Run marker check"],
    affectedContracts:["control-plane.dev-start","consumer.product"],requiredReviewRoles:["Developer",...roles.slice(1),"MergeController"]}));
  tasks.forEach((task,n)=>put(`planning/tasks/${n+1}.task.json`,task));git("add",".");git("commit","-m","Fixture plan");
  const location={projectRoot:root,configPath:"vibez.config.json",verifyLocalStorage:()=>true}, resolved=resolveProjectConfig(location);
  const command={kind:"command",validatorId:"marker",required:true,category:"test",command:process.execPath,args:["--version"],cwd:root,timeoutMs:options.validatorTimeoutMs??1000};
  let clock=Date.now(), revoked=false, drained=true, failValidator=options.validationFailure??false, lostCreate=options.lostCreate??false, lostMerge=options.lostMerge??false;
  const pulls=[],remote=new Map(),counts={create:0,merge:0,push:0,agent:[],validators:0}, provider={providerId:"fixture-worker",capabilities:()=>({providerId:"fixture-worker",supportedRoles:[...roles,"MergeController"],supportsCancellation:true,supportsTimeout:true})};
  const native=pr=>({number:pr.number,htmlUrl:`https://github.com/example/operations/pull/${pr.number}`,headRef:pr.head.ref,headSha:pr.head.sha,baseRef:pr.base.ref,title:pr.title,body:pr.body,state:pr.state,merged:pr.merged??false,mergeCommitSha:pr.mergeCommitSha??null});
  const response=value=>({ok:true,status:200,json:async()=>value});
  const fetchImpl=async(url,init)=>{
    const u=new URL(url);
    if(u.pathname==="/graphql") {const pr=pulls.find(p=>p.node_id===JSON.parse(init.body).variables.id);pr.draft=false;if(options.lostReady){options.lostReady=false;throw Object.assign(new Error("lost ready"),{code:"NETWORK_FAILED"});}return response({data:{}});}
    const number=/\/pulls\/(\d+)$/.exec(u.pathname)?.[1];
    if(!number&&u.pathname.endsWith("/pulls"))await options.onLookup?.();
    return response(number?pulls.find(p=>p.number===Number(number)):pulls.filter(p=>p.state==="open"&&(!u.searchParams.get("head")||u.searchParams.get("head").endsWith(":"+p.head.ref))));
  };
  const ledger=join(lab,"ledger");mkdirSync(ledger);
  const grant={schemaId:"vibez.host-grant",schemaVersion:"1.0.0",grantId:"fixture-approved-plan",projectIdentity:resolved.projectIdentity,configDigest:resolved.configDigest,
    repository:config.project.repository,integrationRef:"main",notBeforeMs:clock-1000,expiresAtMs:clock+1800000,
    tasks:tasks.map(task=>({taskId:task.taskId,branch:task.canonicalBranch,paths:task.allowedPaths})),
    roles:roles.map(role=>({role,principal:role.toLowerCase(),provider:provider.providerId,model:"fixture",tools:[],network:"none"})),
    validators:config.validators.map(({id})=>({id,commandDigest:commandPolicyDigest(command)})),requiredChecks:config.policy.requiredChecks,requiredReviews:roles.slice(1),
    actions:["start","agent","validator","review","rework","push","publish","ready","merge"],humanOnly:[],
    budgets:{maxConcurrent:1,maxAgentTurns:32,maxCommands:8,maxCostMicros:0,maxRuntimeMs:1000000,maxReworks:2}};
  const policyOptions={grant,ledgerDirectory:ledger,worktreeRoot:root,verifyDrained:()=>drained,now:()=>clock,observe:operation=>{
    const pr=pulls.find(p=>p.number===operation.pullRequestNumber);
    return {projectIdentity:resolved.projectIdentity,configDigest:resolved.configDigest,repository:config.project.repository,integrationRef:"main",
      revision:git("rev-parse","HEAD"),branch:git("branch","--show-current"),revoked,enabled:true,checks:grant.requiredChecks,validators:grant.validators,reviews:grant.requiredReviews,
      ...(pr?{pullRequest:{number:pr.number,revision:pr.head.sha,head:pr.head.ref,base:pr.base.ref,open:pr.state==="open",ready:!pr.draft,protectionsVerified:true}}:{})};}};
  let policy=new ScopedHostPolicy(policyOptions);
  t.after(()=>{policy.close();rmSync(lab,{recursive:true,force:true});});
  const plan={schemaId:"vibez.workflow-plan",schemaVersion:"1.0.0",planId:"two-markers",tasks:tasks.map((task,n)=>({taskId:task.taskId,issueNumber:n+101,definitionSha256:digest(task)})),
    budgets:{maxPolls:3,maxRetries:2,maxReworks:2,maxRuntimeMs:600000,initialDelayMs:1,maxDelayMs:4,...options.planBudgets}};
  const host={identity:"operations-fixture@1",actorIdFor:role=>role.toLowerCase(),toolPermissionPolicyFor:()=>({allowedTools:[],networkAccess:"none"}),requirePassingDeveloperResult:true,
    executors:new Map(config.validators.map(({id})=>[id,{command:command.command,args:command.args,category:command.category,timeoutMs:command.timeoutMs}])),
    authorizePublication:()=>true,authorizeMerge:()=>true,authorizeRecovery:()=>options.authorizeRecovery===true,
    integration:{repository:config.project.repository,
      publication:{findOpenPullRequests:async({head})=>pulls.filter(p=>p.state==="open"&&p.head.ref===head).map(native),
        createPullRequest:async input=>{counts.create++;const pr={number:pulls.length+1,node_id:`node-${pulls.length+1}`,title:input.title,body:input.body,draft:true,state:"open",
          head:{sha:remote.get(`refs/heads/${input.head}`),ref:input.head,repo:{full_name:config.project.repository}},base:{ref:input.base,repo:{full_name:config.project.repository}}};pulls.push(pr);
          await options.onCreate?.(pr);
          if(lostCreate){lostCreate=false;throw Object.assign(new Error("lost acknowledgement"),{code:"NETWORK_FAILED"});}return native(pr);},
        updatePullRequest:async input=>{const pr=pulls.find(p=>p.number===input.number);Object.assign(pr,{title:input.title,body:input.body});return native(pr);}},
      pullRequests:{findOpenPullRequests:async({head})=>pulls.filter(p=>p.state==="open"&&p.head.ref===head).map(native)},
      ci:{listCheckRuns:async()=>options.pendingCi?[]:[{name:"fixture-ci",status:"completed",conclusion:options.ciConclusion??"success",startedAt:new Date().toISOString()}]},
      merge:{findPullRequestsByHead:async head=>pulls.filter(p=>p.head.ref===head).map(native),getPullRequest:async number=>native(pulls.find(p=>p.number===number)),
        mergePullRequest:async({number,expectedHeadSha})=>{counts.merge++;const pr=pulls.find(p=>p.number===number);assert.equal(pr.head.sha,expectedHeadSha);pr.state="closed";pr.merged=true;pr.mergeCommitSha=expectedHeadSha;
          if(lostMerge){lostMerge=false;throw Object.assign(new Error("lost merge"),{code:"NETWORK_FAILED"});}return {merged:true,sha:expectedHeadSha,message:"fixture accepted"};}}},
    unattended:{policy,agentLimits:{maxTurns:1,maxCostMicros:0},plans:[plan],clock:()=>clock,verifyDrained:()=>drained,verifySupervisorStopped:()=>options.supervisorStopped===true,
      synchronize:async(_base,head)=>{git("switch","main");git("merge","--ff-only",head);},
      runtime:{fetchImpl,token:"fixture-token",remoteHead:(_url,ref)=>remote.get(ref)??"",pushBranch:(_url,ref,sha)=>{counts.push++;remote.set(ref,sha);if(options.lostPush){options.lostPush=false;throw Object.assign(new Error("lost push"),{code:"GIT_FAILED"});}}},
      worker:{provider,runAgent:async request=>{
        counts.agent.push({role:request.role,runId:request.runId,taskId:request.taskId,revision:request.revisionIdentity});
        await options.onAgent?.(request);
        if(request.role==="Developer") {const n=request.taskId.slice(-1);put(`marker-${n}.txt`,"ready\n");git("add",`marker-${n}.txt`);git("commit","--allow-empty","-m",`Implement ${request.taskId}`);}
        const details=request.role==="Developer"?{summary:"Marker written"}:request.role==="QA"?{acceptanceCriteriaScenarios:["Marker is ready"],regressionNegativeCaseCoverage:["Dependencies retained"]}:
          request.role==="Architect"?{affectedContractsModules:["consumer.product"],dependencyConsumerSurfaces:["consumer.product"],semanticCompatibilityAssessment:"Additive marker",invariantDependencyRuleAssessment:"Sequential dependencies"}:
          {intendedOutcomesScenarios:["Read marker"],observedBehavior:["Ready marker"]};
        const blocked=options.reviewFailure&&request.role==="QA";if(blocked)options.reviewFailure=false;
        return {runId:request.runId,providerId:provider.providerId,taskId:request.taskId,role:request.role,revisionIdentity:request.revisionIdentity,outcome:blocked?"BLOCKED":"PASS",details,findings:[],evidenceRefs:[],occurredAt:new Date().toISOString(),
          ...(blocked?{nonPass:{reason:"Marker needs a reviewed revision",remediation:"Address the recorded QA result in a linked attempt"}}:{})};},
        runValidator:async(command,capability)=>{counts.validators++;await options.onValidator?.(command,capability);if(failValidator){failValidator=false;return {status:"FAIL",details:"First marker check fails"};}return {status:"PASS",details:"Marker check passes"};}}}};
  const services=await createProjectServices(location,host);
  return {root,git,host,plan,get policy(){return policy;},counts,pulls,services,location,config,
    restart:async()=>{policy.close();policy=new ScopedHostPolicy(policyOptions);host.unattended.policy=policy;return createProjectServices(location,host);},
    advance:(ms=100)=>{clock+=ms;},revoke:()=>{revoked=true;},setDrained:value=>{drained=value;}};
}

test("one approved plan drives two dependent native tasks with one PR and merge per task",async t=>{
  const f=await fixture(t), operationId=randomUUID();
  const result=await f.services.operations.start(f.plan.planId,operationId);
  assert.equal(result.status,"DONE",JSON.stringify(result));
  assert.deepEqual(result.completed,["DEMO-001","DEMO-002"]);
  assert.deepEqual([f.counts.create,f.counts.merge,f.counts.push],[2,2,2]);
  assert.deepEqual(f.counts.agent.map(x=>x.role),[...roles,...roles]);
  assert.equal(f.git("branch","--show-current"),"main");
  const again=await f.services.operations.start(f.plan.planId,operationId);
  assert.deepEqual(again,result);assert.equal(f.counts.merge,2);
  assert.equal((await f.services.cli(["--json","orchestrate","operation","status",operationId])).exitCode,0);
  const current=await f.services.diagnostics.checkUpgrade({targetPackageVersion:"0.1.0-rc.4",quiescence:{localWritersDrained:true,externalSessionsDrained:true}});
  assert.equal(current.compatible,true,JSON.stringify(current));
  const prior=await f.services.diagnostics.checkUpgrade({targetPackageVersion:"0.1.0-rc.3",quiescence:{localWritersDrained:true,externalSessionsDrained:true}});
  assert.ok(prior.findings.includes("PRIOR_READER_DOES_NOT_SUPPORT_WORKFLOW_OPERATIONS"));
  const backup=mkdtempSync(join(tmpdir(),"vibez operation backup "));t.after(()=>rmSync(backup,{recursive:true,force:true}));
  const layout=Object.fromEntries(["state","evidence","exchange","intake","responses","outbox","operations"].map(key=>[key,f.config.paths[key]]));
  for(const path of Object.values(layout))if(existsSync(join(f.root,path))){mkdirSync(join(backup,path,".."),{recursive:true});cpSync(join(f.root,path),join(backup,path),{recursive:true});}
  assert.equal(verifyHistoryBackup(backup,layout,current.snapshotSha256).matches,true);
});

test("validation failure preserves evidence and original assignment while using a successor",async t=>{
  const f=await fixture(t,{validationFailure:true});
  const result=await f.services.operations.start(f.plan.planId,randomUUID());
  assert.equal(result.status,"DONE",JSON.stringify(result));assert.equal(result.reworks,1);
  assert.equal(result.sessions.length,3);assert.equal(f.counts.validators,3);
  const state=f.services.status.read(new Date().toISOString());assert.equal(state.tasks.filter(task=>task.state==="DONE").length,2);
  const developers=f.counts.agent.filter(a=>a.role==="Developer");assert.notEqual(developers[0].runId,developers[1].runId);
});

test("lost PR and merge responses reconcile original effects without duplicate writes",async t=>{
  const f=await fixture(t,{lostCreate:true,lostMerge:true}), operationId=randomUUID();
  let result=await f.services.operations.start(f.plan.planId,operationId,true);
  for(let n=0;n<12&&result.status!=="DONE";n++){f.advance();result=await (await f.restart()).operations.resume(operationId,true);}
  assert.equal(result.status,"DONE",JSON.stringify(result));assert.equal(f.counts.create,2);assert.equal(f.counts.merge,2);
});

test("poll budgets survive restart and duplicate starts cannot create another assignment",async t=>{
  const f=await fixture(t,{pendingCi:true}), operationId=randomUUID();
  let result=await f.services.operations.start(f.plan.planId,operationId,true);assert.equal(result.status,"WAITING",JSON.stringify(result));
  await assert.rejects(f.services.operations.start(f.plan.planId,randomUUID(),true),{code:"OPERATION_ACTIVE"});
  for(let n=0;n<4;n++){f.advance();result=await (await createProjectServices(f.location,f.host)).operations.resume(operationId,true);}
  assert.equal(result.status,"EXCEPTION");assert.equal(result.exception.code,"BUDGET_EXHAUSTED");assert.equal(result.polls,3);
  assert.equal(f.counts.agent.length,4);assert.equal(f.counts.create,1);assert.equal(f.counts.merge,0);
});

test("incomplete approval yields durable clarification and issue text cannot authorize tasks",async t=>{
  const f=await fixture(t,{pendingCi:true}), operationId=randomUUID();
  const result=await f.services.operations.start("not-approved",operationId,true);
  assert.equal(result.status,"EXCEPTION");assert.equal(result.exception.code,"CLARIFICATION_REQUIRED");assert.equal(f.counts.agent.length,0);
  assert.ok(f.services.operations.audit(operationId).length>=2);
  await f.services.operations.pause(operationId);
  const lock=join(f.root,".vibez/operations/driver/writer.lock");writeFileSync(lock,randomUUID(),{flag:"wx"});
  const pending=JSON.parse((await f.services.cli(["--json","orchestrate","operation","cancel",operationId])).stdout).data;
  assert.equal(pending.operation.status,"PAUSED");assert.equal(pending.acknowledged,false);
  assert.equal(f.services.operations.status(operationId).acknowledged,false);
  unlinkSync(lock);
  const cancelled=JSON.parse((await f.services.cli(["--json","orchestrate","operation","cancel",operationId])).stdout).data;
  assert.equal(cancelled.operation.status,"CANCELLED");assert.equal(cancelled.acknowledged,true);
  const next=await f.services.operations.start(f.plan.planId,randomUUID(),true);
  assert.equal(next.status,"WAITING",JSON.stringify(next));assert.equal(next.sessions.length,1);
  await assert.rejects(f.services.operations.resume(operationId,true),{code:"OPERATION_ACTIVE"});
  await assert.rejects(f.services.operations.start("not-approved",operationId,true),{code:"OPERATION_ACTIVE"});
  assert.equal(f.counts.agent.length,4);
});

test("lost push and ready acknowledgements reconcile exact remote identity",async t=>{
  const f=await fixture(t,{lostPush:true,lostReady:true}), operationId=randomUUID();
  let result=await f.services.operations.start(f.plan.planId,operationId,true);
  for(let n=0;n<10&&result.status!=="DONE";n++){f.advance();result=await f.services.operations.resume(operationId,true);}
  assert.equal(result.status,"DONE",JSON.stringify(result));assert.deepEqual([f.counts.push,f.counts.create,f.counts.merge],[2,2,2]);
});

test("review judgment rework creates a new attempt and respects the original cycle budget",async t=>{
  const f=await fixture(t,{reviewFailure:true});
  const result=await f.services.operations.start(f.plan.planId,randomUUID());
  assert.equal(result.status,"DONE",JSON.stringify(result));assert.equal(result.reworks,1);
  assert.equal(f.policy.decisions().filter(d=>d.decision==="allow"&&d.action==="rework").length,1);
  const qa=f.counts.agent.filter(a=>a.role==="QA");assert.notEqual(qa[0].runId,qa[1].runId);assert.notEqual(qa[0].revision,qa[1].revision);
});

test("idle pause, drain and cancellation acknowledge honestly and resume the original identity",async t=>{
  const options={pendingCi:true}, f=await fixture(t,options), operationId=randomUUID();
  const before=await f.services.operations.start(f.plan.planId,operationId,true);
  assert.equal((await f.services.operations.pause(operationId)).status,"PAUSED");
  assert.equal((await f.services.operations.drain(operationId)).status,"DRAINED");
  assert.equal((await f.services.operations.cancel(operationId)).status,"CANCELLED");
  assert.equal(f.services.operations.status(operationId).requestedControl,"cancel");
  options.pendingCi=false;f.advance();
  const result=await (await createProjectServices(f.location,f.host)).operations.resume(operationId);
  assert.equal(result.status,"DONE",JSON.stringify(result));assert.equal(result.sessions[0],before.sessions[0]);assert.equal(result.polls,before.polls);
});

test("active caller cancellation quarantines a hung worker and preserves the workspace claim",async t=>{
  let entered,release;
  const reached=new Promise(resolve=>{entered=resolve;}), blocked=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{onAgent:async request=>{if(request.role==="Developer"){f.setDrained(false);entered();await blocked;f.setDrained(true);request.signal.throwIfAborted();}}});
  const operationId=randomUUID(),controller=new AbortController(),run=f.services.operations.start(f.plan.planId,operationId,false,controller.signal);
  await reached;controller.abort();const result=await run;
  assert.equal(result.status,"QUARANTINED",JSON.stringify(result));
  await assert.rejects(f.services.operations.resume(operationId,true),{code:"WRITER_PENDING"});
  await assert.rejects(f.services.operations.start(f.plan.planId,randomUUID(),true),{code:"OPERATION_ACTIVE"});
  release();await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(f.counts.validators,0);assert.equal(f.counts.create,0);
});

test("cancel during an external validator cannot publish late evidence or reviews",async t=>{
  let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{onValidator:async(_command,capability)=>{f.setDrained(false);entered();await blocked;f.setDrained(true);capability.signal.throwIfAborted();}});
  const operationId=randomUUID(),controller=new AbortController(),run=f.services.operations.start(f.plan.planId,operationId,false,controller.signal);
  await reached;controller.abort();const result=await run;assert.equal(result.status,"QUARANTINED",JSON.stringify(result));
  release();await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(f.counts.agent.length,1);
  const state=f.services.status.read(new Date().toISOString()).tasks.find(task=>task.taskId==="DEMO-001");assert.equal(state.state,"IN_DEVELOPMENT");
});

test("immutable journal tail recovers a lost snapshot without reusing old allowance",async t=>{
  const f=await fixture(t,{pendingCi:true}), operationId=randomUUID();
  const first=await f.services.operations.start(f.plan.planId,operationId,true);
  const path=join(f.root,".vibez/operations/driver/operations",`${operationId}.json`);
  writeFileSync(path,"{}\n");
  assert.equal(f.services.operations.inspect(operationId).sequence,first.sequence);
  f.advance();const next=await f.services.operations.resume(operationId,true);
  assert.equal(next.polls,first.polls+1);assert.equal(f.counts.agent.length,4);
  const oldest=join(f.root,".vibez/operations/driver/operations",operationId,"audit/000000000001.json"),original=readFileSync(oldest,"utf8");
  const record=JSON.parse(original);
  writeFileSync(oldest,JSON.stringify({...record,startedAtMs:record.startedAtMs-1}));
  assert.throws(()=>f.services.operations.inspect(operationId),{code:"UNSAFE_RECOVERY"});
  await assert.rejects(f.services.operations.resume(operationId,true),{code:"UNSAFE_RECOVERY"});
  writeFileSync(oldest,JSON.stringify({...record,schemaVersion:"99.0.0"}));
  assert.throws(()=>f.services.operations.inspect(operationId));
  writeFileSync(oldest,original);
  await f.services.operations.pause(operationId);await f.services.operations.drain(operationId);
  const firstControl=join(f.root,".vibez/operations/driver/operations",operationId,"controls/000000000001.json");
  writeFileSync(firstControl,JSON.stringify({sequence:1,command:"unsupported"}));
  assert.throws(()=>f.services.operations.status(operationId),{code:"UNSAFE_RECOVERY"});
  assert.equal(f.counts.agent.length,4);
});

test("publication rechecks dirty and drifting source after remote discovery",async t=>{
  for(const change of ["dirty","commit"])await t.test(change,async t=>{
    const options={},f=await fixture(t,options),operationId=randomUUID();
    let reviewedEvidence,reviewedHead;
    options.onLookup=()=>{
      options.onLookup=undefined;
      reviewedEvidence=evidenceBytes(f.root);reviewedHead=f.git("rev-parse","HEAD");
      if(change==="dirty")writeFileSync(join(f.root,"marker-1.txt"),"unreviewed\n");
      else f.git("commit","--allow-empty","-m","Unreviewed source drift");
    };
    const result=await f.services.operations.start(f.plan.planId,operationId,true);
    assert.equal(result.status,"EXCEPTION",JSON.stringify(result));
    assert.equal(result.exception.code,change==="dirty"?"DIRTY_SOURCE":"HEAD_CHANGED");
    assert.deepEqual([f.counts.push,f.counts.create,f.counts.merge],[0,0,0]);
    assert.equal(f.counts.agent.length,4);assert.equal(result.sessions.length,1);
    assert.deepEqual(evidenceBytes(f.root),reviewedEvidence);assert.equal(f.counts.agent.at(-1).revision,reviewedHead);
    assert.match(result.exception.remediation,/same operation/);
  });
});

test("failed CI remains actionable across restart without spending poll allowance",async t=>{
  const f=await fixture(t,{ciConclusion:"failure"}),operationId=randomUUID();
  const first=await f.services.operations.start(f.plan.planId,operationId,true);
  assert.equal(first.status,"EXCEPTION",JSON.stringify(first));assert.equal(first.exception.code,"READINESS_BLOCKED");
  const evidence=evidenceBytes(f.root);
  f.advance();const again=await (await f.restart()).operations.resume(operationId,true);
  assert.equal(again.status,"EXCEPTION",JSON.stringify(again));assert.equal(again.exception.code,"READINESS_BLOCKED");
  assert.equal(again.polls,0);assert.equal(again.retries,0);assert.deepEqual(again.sessions,first.sessions);
  assert.deepEqual(evidenceBytes(f.root),evidence);
  assert.equal(f.services.status.read(new Date().toISOString()).tasks.find(task=>task.taskId==="DEMO-001").state,"MERGE_READY");
  assert.deepEqual([f.counts.agent.length,f.counts.create,f.counts.merge],[4,1,0]);
});

test("competing same-ID callers cannot duplicate an active assignment or provider",{timeout:30000},async t=>{
  let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const options={pendingCi:true,onAgent:async request=>{if(request.role==="Developer"){f.setDrained(false);entered();await blocked;f.setDrained(true);}}};
  const f=await fixture(t,options),operationId=randomUUID(),run=f.services.operations.start(f.plan.planId,operationId,true);
  try {
    await reached;
    await assert.rejects(f.services.operations.start(f.plan.planId,operationId,true),{code:"DRIVER_BUSY"});
    await assert.rejects(f.services.operations.resume(operationId,true),{code:"WRITER_PENDING"});
    const other=await createProjectServices(f.location,f.host);
    await assert.rejects(other.operations.resume(operationId,true),{code:"WRITER_PENDING"});
    assert.equal(f.counts.agent.length,1);assert.equal(f.services.operations.inspect(operationId).sessions.length,1);
  } finally {release();}
  const result=await run;assert.equal(result.status,"WAITING",JSON.stringify(result));
  assert.equal(result.sessions.length,1);assert.equal(f.counts.agent.filter(a=>a.role==="Developer").length,1);
});

test("revocation between reviewed work and publication prevents the next effect",async t=>{
  const options={},f=await fixture(t,options),operationId=randomUUID();
  options.onLookup=()=>{options.onLookup=undefined;f.revoke();};
  const result=await f.services.operations.start(f.plan.planId,operationId,true);
  assert.equal(result.status,"EXCEPTION",JSON.stringify(result));assert.equal(result.exception.code,"INACTIVE_GRANT");
  assert.deepEqual([f.counts.agent.length,f.counts.push,f.counts.create,f.counts.merge],[4,0,0,0]);
  f.advance();const again=await (await f.restart()).operations.resume(operationId,true);
  assert.equal(again.exception.code,"INACTIVE_GRANT");assert.deepEqual(again.sessions,result.sessions);
  assert.equal(f.counts.agent.length,4);assert.equal(f.counts.push,0);
});

test("cancelled uncertain publication stays quarantined until its original callback drains",{timeout:30000},async t=>{
  let entered,release,finished;
  const reached=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),drained=new Promise(resolve=>{finished=resolve;});
  const options={pendingCi:true,onCreate:async()=>{options.onCreate=undefined;f.setDrained(false);entered();await blocked;f.setDrained(true);finished();}};
  const f=await fixture(t,options),operationId=randomUUID(),controller=new AbortController();
  const run=f.services.operations.start(f.plan.planId,operationId,false,controller.signal);
  let cancelled;
  try {
    await reached;controller.abort();cancelled=await run;
    assert.equal(cancelled.status,"QUARANTINED",JSON.stringify(cancelled));
    await assert.rejects(f.services.operations.resume(operationId,true),{code:"WRITER_PENDING"});
    // Even an optimistic host observation cannot override this instance's
    // direct knowledge of the still-running original callback.
    f.setDrained(true);
    assert.equal((await f.services.operations.pause(operationId)).status,"QUARANTINED");
    assert.equal((await f.services.operations.cancel(operationId)).status,"QUARANTINED");
    await assert.rejects(f.services.operations.resume(operationId,true),{code:"WRITER_PENDING"});
    f.setDrained(false);cancelled=f.services.operations.inspect(operationId);
    assert.equal(f.counts.create,1);assert.equal(f.pulls[0].draft,true);assert.equal(f.counts.merge,0);
  } finally {release();}
  await drained;await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(f.services.operations.inspect(operationId).sequence,cancelled.sequence,"Late callback cannot rewrite the supervisor journal");
  f.advance();const resumed=await f.services.operations.resume(operationId,true);
  assert.equal(resumed.status,"WAITING",JSON.stringify(resumed));assert.deepEqual(resumed.sessions,cancelled.sessions);
  assert.deepEqual([f.counts.agent.length,f.counts.push,f.counts.create,f.counts.merge],[4,1,1,0]);
});

test("operation deadline quarantines a slow writer and remains spent after drain",{timeout:30000},async t=>{
  let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{planBudgets:{maxRuntimeMs:5000},onAgent:async request=>{if(request.role==="Developer"){f.setDrained(false);entered();await blocked;f.setDrained(true);request.signal.throwIfAborted();}}});
  const operationId=randomUUID(),run=f.services.operations.start(f.plan.planId,operationId,true);
  let result;
  try {
    await reached;result=await run;
    assert.equal(result.status,"QUARANTINED",JSON.stringify(result));assert.equal(result.exception.code,"WRITER_PENDING");
    await assert.rejects(f.services.operations.resume(operationId,true),{code:"WRITER_PENDING"});
  } finally {release();}
  await new Promise(resolve=>setTimeout(resolve,100));f.advance(5001);
  const resumed=await f.services.operations.resume(operationId,true);
  assert.equal(resumed.status,"EXCEPTION",JSON.stringify(resumed));assert.equal(resumed.exception.code,"BUDGET_EXHAUSTED");
  assert.deepEqual(resumed.sessions,result.sessions);assert.equal(f.counts.agent.length,1);assert.equal(f.counts.validators,0);
});

test("abandoned locks need host drain proof and native recovery authorization",async t=>{
  const options={pendingCi:true},f=await fixture(t,options),operationId=randomUUID();
  const first=await f.services.operations.start(f.plan.planId,operationId,true);
  const driver=join(f.root,".vibez/operations/driver"),runLock=join(f.root,".vibez/operations/orchestration/.orchestration.lock");
  const writerToken=randomUUID(),runToken=randomUUID();
  writeFileSync(join(driver,"writer.lock"),writerToken,{flag:"wx"});writeFileSync(runLock,runToken,{flag:"wx"});
  await assert.rejects(f.services.operations.resume(operationId,true),{code:"WRITER_PENDING"});
  assert.equal(readFileSync(join(driver,"writer.lock"),"utf8"),writerToken);assert.equal(readFileSync(runLock,"utf8"),runToken);
  options.supervisorStopped=true;
  await assert.rejects(f.services.operations.resume(operationId,true),{code:"IDENTITY_CONFLICT"});
  assert.equal(readFileSync(runLock,"utf8"),runToken,"Only the native recovery owner can release the run lock");
  assert.equal(f.counts.agent.length,4);
  options.authorizeRecovery=true;f.advance();const resumed=await f.services.operations.resume(operationId,true);
  assert.equal(resumed.status,"WAITING",JSON.stringify(resumed));assert.deepEqual(resumed.sessions,first.sessions);
  assert.equal(existsSync(runLock),false);assert.equal(f.counts.agent.length,4);assert.equal(f.counts.create,1);
  const archive=readdirSync(join(driver,"writer-recovery")).find(name=>name.endsWith(".archived-lock"));
  assert.equal(readFileSync(join(driver,"writer-recovery",archive),"utf8"),writerToken);
  const recoveryRoot=join(f.root,".vibez/state/recovery");
  const intent=JSON.parse(readFileSync(join(recoveryRoot,readdirSync(recoveryRoot).find(name=>name.endsWith(".intent.json"))),"utf8"));
  assert.equal(intent.request.operation,"release-run-lock");assert.equal(intent.priorState,runToken);
});

test("zero rework allowance preserves the failed attempt across resume",async t=>{
  const f=await fixture(t,{validationFailure:true,planBudgets:{maxReworks:0}}),operationId=randomUUID();
  const first=await f.services.operations.start(f.plan.planId,operationId);
  assert.equal(first.status,"EXCEPTION",JSON.stringify(first));assert.equal(first.exception.code,"BUDGET_EXHAUSTED");
  assert.equal(first.reworks,0);assert.equal(first.sessions.length,1);
  f.advance();const again=await (await f.restart()).operations.resume(operationId,true);
  assert.equal(again.exception.code,"BUDGET_EXHAUSTED");assert.equal(again.reworks,0);assert.deepEqual(again.sessions,first.sessions);
  assert.deepEqual([f.counts.agent.length,f.counts.validators,f.counts.create],[1,1,0]);
  assert.equal(f.services.status.read(new Date().toISOString()).tasks.find(task=>task.taskId==="DEMO-001").state,"DEV_VALIDATION_FAILED");
});

test("concurrent validation cannot replace the active signal or launch a second validator after cancellation",{timeout:30000},async t=>{
  let entered,release,activeSignal;
  const reached=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),launched=[];
  const f=await fixture(t,{secondValidator:true,validatorTimeoutMs:10000,onValidator:async(command,capability)=>{
    launched.push(command.validatorId);
    if(command.validatorId==="marker"){activeSignal=capability.signal;entered();await blocked;}
    // Deliberately return PASS even after abort: the service must fence the
    // next dispatch and evidence independently of the worker's result.
  }});
  const started=await f.services.developerStart.start({ownerId:"developer",runId:"direct-validation",occurredAt:new Date().toISOString()});
  assert.equal(started.lifecycleState,"IN_DEVELOPMENT");
  const beforeEvidence=evidenceBytes(f.root),beforeState=f.services.status.read(new Date().toISOString()).tasks.find(task=>task.taskId==="DEMO-001");
  const controller=new AbortController(),replacement=new AbortController();
  const request={taskId:"DEMO-001",actorId:"developer",runId:"direct-validation-first",occurredAt:new Date().toISOString(),routeFirstReview:true};
  const first=f.services.developerValidation.validate({...request,signal:controller.signal});
  const rejected=assert.rejects(first,{name:"AbortError"});
  try {
    await reached;
    await assert.rejects(f.services.developerValidation.validate({...request,runId:"direct-validation-second",signal:replacement.signal}),{code:"TOOL_UNAVAILABLE"});
    controller.abort();assert.equal(activeSignal.aborted,true);assert.equal(replacement.signal.aborted,false);
  } finally {release();}
  await rejected;
  assert.deepEqual(launched,["marker"]);assert.equal(f.counts.validators,1);assert.equal(f.counts.agent.length,0);
  const charges=f.policy.decisions().filter(decision=>decision.decision==="allow"&&decision.action==="validator");
  assert.deepEqual(charges.map(charge=>charge.validatorId),["marker"]);assert.equal(charges.reduce((sum,charge)=>sum+charge.charge.commands,0),1);
  assert.deepEqual(evidenceBytes(f.root),beforeEvidence);
  assert.deepEqual(f.services.status.read(new Date().toISOString()).tasks.find(task=>task.taskId==="DEMO-001"),beforeState);
});
