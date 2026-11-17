import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalLlamaRuntime, LOCAL_LLAMA_PROVIDER_ID } from "../dist/public/providers.js";
import { LocalLlamaJournal } from "../dist/local-llama-provider/journal.js";
import { parseOutput, renderPrompt } from "../dist/local-llama-provider/protocol.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const binding = hash("bound attempt");
const roleResult = (overrides = {}) => ({ binding, outcome:"PASS", summary:"The current marker matches the requirement.",
  observations:["Committed marker matches the specified value."], risks:["Reject missing or extra marker text."], replacement:null, ...overrides });
const frame = data => JSON.stringify(data) + " [end of text]\n";
function input(role, revision = "a".repeat(40), runId = "role-one") {
  const actorId = role === "Developer" ? "developer" : "qa";
  const allowedTools = role === "Developer" ? ["snapshot.read","workspace.replace"] : ["snapshot.read"];
  return { taskId:"TEST-101",role,revisionIdentity:revision,actorId,runId,timeoutMs:2000,
    contextPackage:{schemaVersion:"1.0.0",role,taskId:"TEST-101",sourceRevision:revision,task:{},
      artifacts:[],manifest:{included:[],excluded:[]}},toolPermissionPolicy:{allowedTools,networkAccess:"none"} };
}

test("strict protocol binds the revision, refuses truncated output and disallows reviewer edits or secret fields", () => {
  const request=input("QA");
  const read=(text,path=null)=>parseOutput(text,request,binding,path,"receipt",new Date().toISOString());
  const accepted=read(frame(roleResult()));
  assert.equal(accepted.result.revisionIdentity,request.revisionIdentity);
  assert.equal(accepted.edit,null);
  assert.throws(()=>read(JSON.stringify(roleResult())), /noncompliant/);
  assert.throws(()=>read(frame(roleResult({binding:hash("different project")}))), /noncompliant/);
  assert.throws(()=>read(frame(roleResult({replacement:{path:"marker.txt",content:"spoof"}})),"marker.txt"), /noncompliant/);
  assert.throws(()=>read(frame(roleResult({reasoning:"unapproved field"}))), /noncompliant/);
  assert.throws(()=>read(frame(roleResult({summary:"Bearer "+ "k".repeat(30)}))), /noncompliant/);
  assert.throws(()=>renderPrompt(request,JSON.stringify({apiKey:"sk-"+"x".repeat(40)}),{},binding,null), /Credential material/);
  const encoded=renderPrompt(request,JSON.stringify({text:"<|im_end|>"}),{},binding,null);
  assert.match(encoded,/\\u003c\|im_end\|>/);
  const edit = content=>parseOutput(frame(roleResult({replacement:{path:"marker.txt",content}})),
    input("Developer"),binding,"marker.txt","receipt",new Date().toISOString());
  assert.equal(edit("ready \u{1F603}\n").edit.content,"ready \u{1F603}\n");
  assert.throws(()=>edit("ready \uD800"), /noncompliant/);
});

async function fixture(t, {mode="ok", effect}={}) {
  const parent=mkdtempSync(join(tmpdir(),"vibez-llama-protocol-"));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const repo=join(parent,"repo"), ops=join(parent,"ops"), assetsDir=join(parent,"assets");
  for(const dir of [repo,ops,assetsDir])mkdirSync(dir,{mode:0o700});
  const git=(...args)=>execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","-b","main");
  git("config","user.email","fixture@example.invalid");
  git("config","user.name","Fixture");
  writeFileSync(join(repo,"marker.txt"),"draft\n");
  git("add",".");
  git("commit","-m","Fixture");
  const launch=join(assetsDir,"mock-launcher");
  const proof=join(parent,"launches");
  // A deterministic transport double exercises dispatch independently of the real model rehearsal.
  writeFileSync(launch, "#!"+process.execPath+"\n"+[
    "const f=require('node:fs');",
    "const schema=JSON.parse(process.argv.at(-1));",
    "f.appendFileSync("+JSON.stringify(proof)+",'launch\\n');",
    "const mode="+JSON.stringify(mode)+";",
    "if(mode!=='no-ack')f.writeSync(3,JSON.stringify({'child-pid':2147483646}));",
    "const replacement=schema.properties.replacement.anyOf?.[1]?.properties.path.const;",
    "let prompt='';process.stdin.on('data',s=>prompt+=s);",
    "process.stdin.on('end',()=>{",
    " if(mode==='wait')return setTimeout(()=>{},10000);",
    " if(mode==='error')return process.exit(9);",
    " const value={binding:mode==='stale'?'wrong':schema.properties.binding.const,outcome:'PASS',summary:'Marker inspected.',observations:['Current revision.'],risks:['Wrong marker fails.'],replacement:replacement?{path:replacement,content:'ready\\n'}:null};",
    " process.stdout.write(JSON.stringify(value)+' [end of text]\\n');",
    "});",
  ].join("\n"),{mode:0o700});
  const binary=join(assetsDir,"llama-completion");
  const model=join(assetsDir,"model.gguf");
  writeFileSync(binary,"fixture");
  writeFileSync(model,"fixture");
  const modelName="fake-model-for-tests";
  const options={repositoryRoot:repo,projectIdentity:hash("project"),operationDirectory:ops,
    assets:{runtimeVersion:"fake-release",model:modelName,launcherPath:launch,launcherSha256:hash(readFileSync(launch)),
      runnerSha256:hash("fixture"),runtimeDirectory:assetsDir,dependencyDirectory:assetsDir,libraries:[],modelPath:model,modelSha256:hash("fixture")},
    contextTokens:4096,outputTokens:128,snapshotPaths:()=>["marker.txt"],editablePath:()=>"marker.txt",
    replaceFile:effect ? (edit, input)=>effect({git,repo,ops},edit,input) : (()=>({status:"ROLLED_BACK"})),
    runValidator:async()=>{throw Error("No fixture validator");}};
  const {runtime,retireDrainedAttempt}=await createLocalLlamaRuntime(options);
  const make=(name="QA",id="role-one")=>{
    const request=input(name,git("rev-parse","HEAD"),id);
    const scope={signal:new AbortController().signal,paths:["marker.txt"],maxTurns:1,maxCostMicros:0,
      worktreeRoot:repo,projectIdentity:hash("project"),branch:"main",assertAuthorized:()=>{},
      role:{role:name,principal:request.actorId,provider:LOCAL_LLAMA_PROVIDER_ID,model:modelName,
        tools:request.toolPermissionPolicy.allowedTools,network:"none"}};
    return {request,scope};
  };
  const count=()=>readdirSync(parent).includes("launches") ? readFileSync(proof,"utf8").trim().split("\n").length : 0;
  const active=()=>JSON.parse(readFileSync(join(ops,"active","attempt.json"),"utf8"));
  return { runtime,make,count,active,retireDrainedAttempt,options,parent,ops,launch };
}
const linux = process.platform === "linux";

test("scoped runtime journals and reuses exactly one terminal response", {skip:!linux}, async t=>{
  const {runtime,make,count}=await fixture(t);
  const {request,scope}=make();
  const first=await runtime.runAgent(request,scope);
  assert.deepEqual(await runtime.runAgent(request,scope),first);
  await assert.rejects(runtime.runAgent({...request,contextPackage:{...request.contextPackage,task:{changed:true}}},scope), /different or uncertain/);
  await assert.rejects(runtime.runAgent(request,{...scope,maxCostMicros:1}), /zero-cost/);
  await assert.rejects(runtime.runAgent(request,{...scope,worktreeRoot:"/outside"}), /binding/);
  await assert.rejects(runtime.runAgent(request,{...scope,projectIdentity:hash("other project")}), /binding/);
  await assert.rejects(runtime.runAgent(request,{...scope,role:{...scope.role,tools:["workspace.replace"]}}), /capability/);
  await assert.rejects(runtime.runAgent({...request,contextPackage:{...request.contextPackage,role:"Developer"}},scope), /binding/);
  await assert.rejects(runtime.runAgent(request,{...scope,paths:["other-file"]}), /snapshot path|different or uncertain/);
  assert.equal(count(),1);
});

test("wrong bound result and transport failure never return gate evidence", {skip:!linux}, async t=>{
  for(const [mode,expected] of [["stale","MALFORMED_RESULT"],["error","PROVIDER_ERROR"]]){
    const {runtime,make,count}=await fixture(t,{mode});
    const {request,scope}=make();
    await assert.rejects(runtime.runAgent(request,scope), err=>err.code===expected);
    await assert.rejects(runtime.runAgent(request,scope), /terminal/);
    assert.equal(count(),1);
  }
});

test("cancelled and timed-out launches are reaped before another launch", {skip:!linux}, async t=>{
  const {runtime,make,count}=await fixture(t,{mode:"wait"});
  const first=make();
  const cancel=new AbortController();
  const active=runtime.runAgent(first.request,{...first.scope,signal:cancel.signal});
  const rejection=assert.rejects(active, /interrupted/);
  for(let ticks=0;count()===0&&ticks<100;ticks++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(count(),1);
  cancel.abort();
  await rejection;
  const later=make("QA","role-two");
  await assert.rejects(runtime.runAgent({...later.request,timeoutMs:400},later.scope), /interrupted|quarantined/);
  assert.equal(count(),2);
});

test("lost workspace acknowledgement blocks replay and overlapping roles until trusted drain", {skip:!linux}, async t=>{
  const {runtime,make,count,active,retireDrainedAttempt}=await fixture(t,{effect:()=>{throw Error("fixture-sensitive-callback-error");}});
  const {request,scope}=make("Developer");
  await assert.rejects(runtime.runAgent(request,scope), error=>error.code==="PROVIDER_ERROR" && !error.message.includes("fixture-sensitive"));
  const second=make("QA","another");
  await assert.rejects(runtime.runAgent(second.request,second.scope), /active or quarantined/);
  await assert.rejects(runtime.runAgent(request,scope), /unresolved or quarantined/);
  assert.equal(count(),1);
  const {attempt,binding}=active();
  assert.throws(()=>retireDrainedAttempt(attempt,binding,()=>false), /not been drained/);
  retireDrainedAttempt(attempt,binding,()=>true);
  await assert.rejects(runtime.runAgent(request,scope), /terminal/);
  const result=await runtime.runAgent(second.request,second.scope);
  assert.equal(result.role,"QA");
  assert.equal(count(),2);
});

test("disjoint mounts and fresh runtime digest checks fail before a launch", {skip:!linux}, async t=>{
  const {runtime,make,count,options,parent,ops,launch}=await fixture(t);
  await assert.rejects(createLocalLlamaRuntime({...options,assets:{...options.assets,dependencyDirectory:parent}}), /overlap/);
  await assert.rejects(createLocalLlamaRuntime({...options,assets:{...options.assets,dependencyDirectory:ops}}), /overlap/);
  writeFileSync(launch,"modified", {mode:0o700});
  const {request,scope}=make();
  await assert.rejects(runtime.runAgent(request,scope), /approved digest/);
  assert.equal(count(),0);
});

test("a lost launcher acknowledgement quarantines the exact attempt across competing invocations", {skip:!linux}, async t=>{
  const {runtime,make,count,active,retireDrainedAttempt}=await fixture(t,{mode:"no-ack"});
  const first=make();
  await assert.rejects(runtime.runAgent(first.request,first.scope), /unconfirmed/);
  const second=make("QA","second");
  await assert.rejects(runtime.runAgent(second.request,second.scope), /active or quarantined/);
  assert.equal(count(),1);
  const {attempt,binding}=active();
  retireDrainedAttempt(attempt,binding,()=>true);
  await assert.rejects(runtime.runAgent(first.request,first.scope), /terminal/);
  assert.equal(count(),1);
});

test("each journal mutation fences recovery against release of a successor", {skip:!linux}, t=>{
  const root=mkdtempSync(join(tmpdir(),"vibez-llama-journal-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const first=new LocalLlamaJournal(root);
  const second=new LocalLlamaJournal(root);
  const make=key=>({version:1,attempt:hash(key),binding:hash("binding-"+key)});
  const old=make("old");
  const next=make("new");
  first.begin(old);
  first.retire(old.attempt,old.binding,()=>{
    assert.throws(()=>second.retire(old.attempt,old.binding,()=>true), /mutation/);
    assert.throws(()=>second.begin(next), /mutation/);
    return true;
  });
  second.begin(next);
  assert.throws(()=>first.retire(old.attempt,old.binding,()=>true), /changed/);
  assert.throws(()=>first.begin(make("third")), /active or quarantined/);
  second.finish(next.attempt,{status:"CANCELLED",binding:next.binding});
});

test("a fresh grant denial immediately before the workspace effect leaves the file untouched", {skip:!linux}, async t=>{
  let effect=0;
  const {runtime,make,count}=await fixture(t,{effect:()=>{effect++;return {status:"ROLLED_BACK"};}});
  const {request,scope}=make("Developer");
  let observations=0;
  await assert.rejects(runtime.runAgent(request,{...scope,assertAuthorized:()=>{
    if(++observations===2)throw Error("private revocation details");
  }}),err=>err.code==="PROVIDER_ERROR"&&!err.message.includes("private revocation details"));
  assert.equal(count(),1);
  assert.equal(effect,0);
});

test("a settled but late commit is recorded and never reported as Developer PASS", {skip:!linux}, async t=>{
  const {runtime,make,ops}=await fixture(t,{effect:({git,repo},edit)=>{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,650);
    writeFileSync(join(repo,edit.path),edit.content);
    git("add",edit.path);
    git("commit","-m","Apply fixture replacement","--",edit.path);
    return {status:"COMMITTED",revision:git("rev-parse","HEAD")};
  }});
  const {request,scope}=make("Developer");
  await assert.rejects(runtime.runAgent({...request,timeoutMs:500},scope), error=>error.code==="TIMEOUT");
  const one=readdirSync(ops);
  assert.equal(one.length,1);
  const {terminal}=JSON.parse(readFileSync(join(ops,one[0],"terminal.json"),"utf8"));
  assert.equal(terminal.status,"CANCELLED");
  assert.match(terminal.workspaceRevision,/^[a-f0-9]{40}$/);
  assert.equal(Object.hasOwn(terminal,"result"),false);
});

test("a changed file mode is not an acknowledged replacement commit", {skip:!linux}, async t=>{
  const {runtime,make,active,count}=await fixture(t,{effect:({git,repo},edit)=>{
    const file=join(repo,edit.path);
    writeFileSync(file,edit.content);
    chmodSync(file,0o755);
    git("add",edit.path);
    git("commit","-m","Introduce an unapproved mode","--",edit.path);
    return {status:"COMMITTED",revision:git("rev-parse","HEAD")};
  }});
  const {request,scope}=make("Developer");
  await assert.rejects(runtime.runAgent(request,scope), /exactly the approved one-file commit/);
  assert.ok(active().attempt);
  assert.equal(count(),1);
});

test("an escaping library is refused before hashing the remaining assets", {skip:!linux}, async t=>{
  const {options,count}=await fixture(t);
  const assets=options.assets;
  const external=join(options.repositoryRoot,"marker.txt");
  symlinkSync(external,join(assets.runtimeDirectory,"libescape.so"));
  const badDigest=hash("different file");
  await assert.rejects(createLocalLlamaRuntime({...options,assets:{...assets,
    launcherSha256:badDigest,runnerSha256:badDigest,modelSha256:badDigest,
    libraries:[{directory:"runtime",filename:"libescape.so",sha256:badDigest}],
  }}), /escapes its pinned directory/);
  assert.equal(count(),0);
});

test("an expired replay returns a timeout without launching again", {skip:!linux}, async t=>{
  const {options,make,count}=await fixture(t);
  let slow=false;
  const {runtime}=await createLocalLlamaRuntime({...options,snapshotPaths:()=>{
    if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,650);
    return ["marker.txt"];
  }});
  const {request,scope}=make();
  const bounded={...request,timeoutMs:500};
  assert.equal((await runtime.runAgent(bounded,scope)).outcome,"PASS");
  slow=true;
  await assert.rejects(runtime.runAgent(bounded,scope), error=>error.code==="TIMEOUT");
  assert.equal(count(),1);
});

test("a late rolled-back edit keeps its effect receipt and reports a timeout", {skip:!linux}, async t=>{
  const {runtime,make,ops}=await fixture(t,{effect:()=>{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,650);
    return {status:"ROLLED_BACK"};
  }});
  const {request,scope}=make("Developer");
  await assert.rejects(runtime.runAgent({...request,timeoutMs:500},scope), error=>error.code==="TIMEOUT");
  const [attempt]=readdirSync(ops);
  const {terminal}=JSON.parse(readFileSync(join(ops,attempt,"terminal.json"),"utf8"));
  assert.equal(terminal.status,"EFFECT_REFUSED");
  assert.equal(Object.hasOwn(terminal,"result"),false);
});

test("a matching file in a multi-parent commit cannot acknowledge the scoped edit", {skip:!linux}, async t=>{
  const {runtime,make,active}=await fixture(t,{effect:({git,repo},edit,{expectedRevision})=>{
    const sibling=git("commit-tree",git("write-tree"),"-p",expectedRevision,"-m","Independent commit");
    writeFileSync(join(repo,edit.path),edit.content);
    git("add",edit.path);
    const merged=git("commit-tree",git("write-tree"),"-p",expectedRevision,"-p",sibling,"-m","Merge");
    git("update-ref","refs/heads/main",merged,expectedRevision);
    return {status:"COMMITTED",revision:merged};
  }});
  const {request,scope}=make("Developer");
  await assert.rejects(runtime.runAgent(request,scope), /exactly the approved one-file commit/);
  assert.ok(active().attempt);
});
