import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ScopedHostPolicy, ScopedOperation } from "../host-policy/index.js";
import type { ScopedAgentLimits, ScopedWorkerRuntime } from "../host-policy/worker.js";
import type { ResolvedProjectConfig } from "../project-config/index.js";
import type { ConfiguredDriverServices } from "../project-services/index.js";
import { selectNextEligibleTask } from "../task-registry/index.js";
import { bindProfile, checkedProfile, loadSession, saveSession, selectRegistered } from "./intake.js";
import { publish, step, type DriverRuntime } from "./driver.js";
import { followSuccessors, successor } from "./inbox.js";
import { clean, driverDirectory, orchestrationDirectory, DriverError, exclusive, files, git, hash, id, now, object, read, recoverWriter, redact, requireValue, safePath, sleep, validate, write } from "./io.js";
import type { DriverProfile, DriverSession } from "./model.js";
import { AGENT_RUNNER_ROLES, type AgentRunnerRole, type AgentToolPermissionPolicy } from "../agent-provider/index.js";

export function unattendedProfile(config:ResolvedProjectConfig, actor:(role:AgentRunnerRole)=>string,
  tools:(role:AgentRunnerRole)=>AgentToolPermissionPolicy):DriverProfile {
  const {document:d}=config, driver=`${d.paths.operations}/driver`;
  return {schemaId:"ipt.driver-profile",schemaVersion:"1.0.0",configDigest:config.configDigest,configPath:config.configPath,
    repository:d.project.repository,integrationTarget:d.policy.integrationTarget,requiredCiChecks:[...d.policy.requiredChecks],
    storage:{driver,state:d.paths.state,evidence:d.paths.evidence,orchestration:`${d.paths.operations}/orchestration`,tasks:d.paths.tasks,remote:d.policy.remote},
    paths:{issues:d.paths.intake,responses:d.paths.responses,outbound:d.paths.outbox,archive:`${driver}/archive`,exchange:d.paths.exchange},
    roleActors:Object.fromEntries(AGENT_RUNNER_ROLES.map(role=>[role,actor(role)])) as DriverProfile["roleActors"],
    rolePolicies:Object.fromEntries(AGENT_RUNNER_ROLES.map(role=>[role,tools(role)])) as DriverProfile["rolePolicies"],
    manual:{maxAttempts:d.budgets.maxAttempts,retryDelayMs:d.budgets.retryDelayMs,roleTimeoutMs:d.budgets.providerTimeoutMs}};
}

export interface ApprovedWorkflowPlan {
  readonly schemaId: "vibez.workflow-plan";
  readonly schemaVersion: "1.0.0";
  readonly planId: string;
  readonly tasks: readonly { readonly taskId: string; readonly issueNumber: number; readonly definitionSha256: string }[];
  readonly budgets: { readonly maxPolls: number; readonly maxRetries: number; readonly maxReworks: number;
    readonly maxRuntimeMs: number; readonly initialDelayMs: number; readonly maxDelayMs: number };
}
export type OperationStatus = "RUNNING" | "WAITING" | "PAUSED" | "DRAINED" | "CANCELLED" | "QUARANTINED" | "EXCEPTION" | "DONE";
export interface WorkflowOperation {
  schemaId: "vibez.workflow-operation"; schemaVersion: "1.0.0";
  operationId: string; planId: string; planHash: string; grantDigest: string; binding: string;
  status: OperationStatus; startedAtMs: number; nextAtMs: number; sequence: number; controlSequence:number;
  polls: number; retries: number; reworks: number; sessions: string[]; current: string | null;
  completed: string[]; pending: string | null; exception: { code: string; message: string; remediation: string } | null;
}
/** Host-provided capabilities, never hydrated from issue text, a plan file or an HTTP request. */
export interface UnattendedHost {
  readonly policy: ScopedHostPolicy;
  readonly worker: ScopedWorkerRuntime;
  readonly agentLimits: ScopedAgentLimits;
  readonly plans: readonly ApprovedWorkflowPlan[];
  readonly runtime: Pick<DriverRuntime, "fetchImpl" | "token" | "remoteHead" | "pushBranch">;
  /** Verify all original external writers have drained; excludes this fenced caller. Never infer drain from elapsed time. */
  readonly verifyDrained: (operation: Readonly<WorkflowOperation>) => boolean;
  /** Additional proof that every other workspace supervisor is stopped before archiving an abandoned lock. */
  readonly verifySupervisorStopped?: (operation: Readonly<WorkflowOperation>) => boolean;
  /** Trusted host can implement fetching, but must retain the clean, fast-forward/ancestor checks. */
  readonly synchronize?: (integrationRef: string, acceptedHead: string) => Promise<void>;
  readonly clock?: () => number;
}
type Command = "run" | "pause" | "drain" | "cancel";
type Control = { sequence: number; command: Command };

/** The one application-service supervisor. Native gates remain lifecycle/evidence authorities. */
export class WorkflowOperations {
  private readonly root: string;
  private readonly directory: string;
  private readonly binding: string;
  private readonly plans: readonly ApprovedWorkflowPlan[];
  private readonly clock: () => number;
  private readonly pendingEffects=new Set<Promise<unknown>>();
  constructor(private readonly config: ResolvedProjectConfig, private readonly profile: DriverProfile,
    private readonly host: UnattendedHost, private readonly services: () => Promise<ConfiguredDriverServices>, executionBinding: string) {
    this.root = config.projectRoot;
    this.directory = `${driverDirectory(profile)}/operations`;
    this.binding = hash({ executionBinding, profile, worktree: config.worktreeIdentity });
    this.plans = JSON.parse(JSON.stringify(host.plans)) as ApprovedWorkflowPlan[];
    this.clock = host.clock ?? Date.now;
  }
  private path(name: string): string { return safePath(this.root, `${this.directory}/${name}`); }
  private operationPath(operationId: string): string {
    requireValue(/^[a-f0-9-]{36}$/.test(operationId), "Supply the original operation UUID.");
    return this.path(`${operationId}.json`);
  }
  inspect(operationId: string): Readonly<WorkflowOperation> {
    this.operationPath(operationId);
    const history=files(this.path(`${operationId}/audit`),".json");
    requireValue(history.length>0&&history.every((name,index)=>name===`${String(index+1).padStart(12,"0")}.json`),"Operation journal is missing or incomplete.","UNSAFE_RECOVERY");
    const records=history.map(name=>{const record=read(this.path(`${operationId}/audit/${name}`));validate(this.root,"workflow-operation",record);return record as WorkflowOperation;});
    const value = records.at(-1)!;
    requireValue(records.every((record,index)=>record.sequence===index+1&&record.operationId === operationId && record.binding === this.binding && record.grantDigest === value.grantDigest),
      "Restore the original package, host, configuration and grant; never create a fresh operation to reset allowances.", "STALE_BINDING");
    for(const [index,record] of records.entries()) {
      requireValue(record.current===null||record.sessions.includes(record.current),"Current session is missing from original operation history.","UNSAFE_RECOVERY");
      if(index===0)continue;
      const previous=records[index-1]!;
      requireValue(["polls","retries","reworks","controlSequence"].every(key=>Number(record[key as keyof WorkflowOperation])>=Number(previous[key as keyof WorkflowOperation]))&&
        previous.sessions.every(session=>record.sessions.includes(session))&&previous.completed.every(task=>record.completed.includes(task))&&
        ["planId","planHash","startedAtMs"].every(key=>record[key as keyof WorkflowOperation]===previous[key as keyof WorkflowOperation]),
        "Operation identity, allowances or historical sessions changed.","UNSAFE_RECOVERY");
    }
    requireValue(value.controlSequence<=this.control(operationId).sequence,"Acknowledged control is missing from its original journal.","UNSAFE_RECOVERY");
    return value;
  }
  list(): readonly Readonly<WorkflowOperation>[] {
    return files(this.path("."), "").filter(name => /^[a-f0-9-]{36}$/.test(name)).map(name => this.inspect(name));
  }
  audit(operationId: string): readonly unknown[] {
    this.inspect(operationId);
    return files(this.path(`${operationId}/audit`), ".json").map(name => read(this.path(`${operationId}/audit/${name}`)));
  }
  status(operationId:string) {
    const operation=this.inspect(operationId),control=this.control(operationId);
    return {operation,requestedControl:control.command,requestedControlSequence:control.sequence,acknowledged:operation.controlSequence===control.sequence&&(control.command==="run"||operation.status===({pause:"PAUSED",drain:"DRAINED",cancel:"CANCELLED"} as const)[control.command])};
  }
  private claimsWorkspace(record:Readonly<WorkflowOperation>):boolean {
    return record.status!=="DONE"&&!(record.status==="CANCELLED"&&record.sessions.length===0&&record.pending===null&&record.polls===0&&record.retries===0&&record.reworks===0);
  }
  private assertGrant(record:Readonly<WorkflowOperation>):void {
    requireValue(record.grantDigest===this.host.policy.grantDigest,"Restore this operation's original grant before continuing or controlling it.","STALE_BINDING");
  }
  private save(record: WorkflowOperation): void {
    record.sequence += 1;
    validate(this.root, "workflow-operation", record);
    write(this.path(`${record.operationId}/audit/${String(record.sequence).padStart(12,"0")}.json`), record, true);
    write(this.operationPath(record.operationId), record);
  }
  private control(operationId: string): Control {
    const history=files(this.path(`${operationId}/controls`),".json");
    if (!history.length) return { sequence: 0, command: "run" };
    requireValue(history.every((name,index)=>name===`${String(index+1).padStart(12,"0")}.json`),"Control journal is incomplete.","UNSAFE_RECOVERY");
    const controls=history.map((name,index)=>{
      const value=read(this.path(`${operationId}/controls/${name}`));
      requireValue(object(value) && Object.keys(value).sort().join(",")==="command,sequence" && value.sequence===index+1 &&
        ["run","pause","drain","cancel"].includes(String(value.command)), "Operation control record is corrupt.", "UNSAFE_RECOVERY");
      return value as Control;
    });
    return controls.at(-1)!;
  }
  private command(operationId: string, command: Command): Readonly<WorkflowOperation> {
    const record = this.inspect(operationId);
    this.assertGrant(record);
    requireValue(record.status !== "DONE", "A completed operation is immutable.");
    const lock = this.path(`${operationId}/control.lock`);
    try { writeFileSync(lock, id(), {flag:"wx"}); } catch { throw new DriverError("CONTROL_BUSY", "Another control request is in progress; retry the same request."); }
    try {
      const next = { sequence: this.control(operationId).sequence + 1, command };
      write(this.path(`${operationId}/controls/${String(next.sequence).padStart(12,"0")}.json`), next, true);
      write(this.path(`${operationId}/control.json`), next);
    } finally { unlinkSync(lock); }
    // Requesting cancellation does not assert that an external writer has stopped.
    return record;
  }
  private async requestControl(operationId:string,command:Exclude<Command,"run">):Promise<Readonly<WorkflowOperation>> {
    const record=this.command(operationId,command);
    if(existsSync(safePath(this.root,`${driverDirectory(this.profile)}/writer.lock`)))return record;
    try {await exclusive(this.root,this.profile,async()=>{
      const current={...this.inspect(operationId)} as WorkflowOperation;
      const requested=this.control(operationId);
      if(requested.command!==command)return;
      current.status=this.pendingEffects.size===0&&this.host.verifyDrained(current)?command==="cancel"?"CANCELLED":command==="pause"?"PAUSED":"DRAINED":"QUARANTINED";
      if(current.status!=="QUARANTINED")current.controlSequence=requested.sequence;
      this.save(current);
    });}catch(error){if(!(error instanceof DriverError)||error.code!=="DRIVER_BUSY")throw error;}
    return this.inspect(operationId);
  }
  pause(operationId: string) { return this.requestControl(operationId, "pause"); }
  drain(operationId: string) { return this.requestControl(operationId, "drain"); }
  cancel(operationId: string) { return this.requestControl(operationId, "cancel"); }
  private plan(record: WorkflowOperation): ApprovedWorkflowPlan {
    const matches = this.plans.filter(plan => plan.planId === record.planId);
    requireValue(matches.length === 1, "The host must supply exactly one approved plan with this ID.", "CLARIFICATION_REQUIRED");
    const plan = matches[0]!;
    validate(this.root, "workflow-operation", plan);
    requireValue(plan.tasks.length<=100 && hash(plan) === record.planHash && new Set(plan.tasks.map(t=>t.taskId)).size === plan.tasks.length,
      "The approved task set is ambiguous or changed; preserve the operation and resolve the original plan.", "CLARIFICATION_REQUIRED");
    requireValue(plan.budgets.initialDelayMs <= plan.budgets.maxDelayMs, "Initial backoff exceeds its maximum.", "CLARIFICATION_REQUIRED");
    return plan;
  }
  async start(planId: string, operationId = id(), once = false, signal?:AbortSignal): Promise<Readonly<WorkflowOperation>> {
    const graph = await this.services(); graph.prepareWrite();
    checkedProfile(this.root,this.profile); bindProfile(this.profile,graph.config);
    await exclusive(this.root,this.profile,async()=>{
      this.operationPath(operationId);
      if (existsSync(this.path(`${operationId}/audit`))) { this.assertGrant(this.inspect(operationId)); requireValue(this.inspect(operationId).planId===planId,"Operation ID already belongs to a different plan.","IDENTITY_CONFLICT"); return; }
      const active = this.list().find(record=>this.claimsWorkspace(record));
      requireValue(!active, `Operation ${active?.operationId} still owns this workspace. Resume or drain its original identity.`, "OPERATION_ACTIVE");
      const plans=this.plans.filter(plan=>plan.planId===planId);
      const record: WorkflowOperation={schemaId:"vibez.workflow-operation",schemaVersion:"1.0.0",operationId,planId,
        planHash:hash(plans.length===1?plans[0]:null),grantDigest:this.host.policy.grantDigest,binding:this.binding,status:"RUNNING",
        startedAtMs:this.clock(),nextAtMs:0,sequence:0,controlSequence:0,polls:0,retries:0,reworks:0,sessions:[],current:null,completed:[],pending:null,exception:null};
      this.save(record);
      try { await this.admit(record,graph); } catch(error) { this.fail(record,error); }
    });
    return this.run(operationId,once,signal);
  }
  async resume(operationId: string, once = false, signal?:AbortSignal): Promise<Readonly<WorkflowOperation>> {
    const record=this.inspect(operationId);
    this.assertGrant(record);
    if(record.status==="DONE")return record;
    requireValue(this.pendingEffects.size===0&&this.host.verifyDrained(record),"The original external writers must be drained before resume.","WRITER_PENDING");
    await this.recoverLocks(record);
    this.command(operationId,"run");
    return this.run(operationId,once,signal);
  }
  private async recoverLocks(record:Readonly<WorkflowOperation>):Promise<void> {
    const writer=safePath(this.root,`${driverDirectory(this.profile)}/writer.lock`);
    const run=safePath(this.root,`${orchestrationDirectory(this.profile)}/.orchestration.lock`);
    const control=this.path(`${record.operationId}/control.lock`);
    if(![writer,run,control].some(existsSync))return;
    requireValue(this.host.verifySupervisorStopped?.(record)===true&&this.host.verifyDrained(record),
      "Verify every other workspace supervisor and original external writer is stopped before recovering its lock.","WRITER_PENDING");
    if(existsSync(writer))recoverWriter(this.root,this.profile,hash(readFileSync(writer,"utf8")),`Resume original operation ${record.operationId} after trusted host drain verification.`);
    await exclusive(this.root,this.profile,async()=>{
      if(existsSync(run)) {
        requireValue(record.current,"A run lock without its original session cannot be recovered automatically.","UNSAFE_RECOVERY");
        const session=loadSession(this.root,this.profile,record.current), graph=await this.services();
        await graph.recovery.apply({schemaVersion:"1.0.0",operationId:`supervisor-${hash({operationId:record.operationId,token:readFileSync(run,"utf8")}).slice(0,40)}`,
          operation:"release-run-lock",taskId:session.taskId,actorId:session.request.ownerId,reason:"Trusted host verified original workspace writers are stopped.",
          expectedRevision:clean(this.root),expectedTargetHash:hash(readFileSync(run,"utf8")),confirmedQuiescent:true,idempotencyKey:session.request.idempotencyKey});
      }
      if(existsSync(control)) {
        const token=readFileSync(control,"utf8"), receipt=this.path(`${record.operationId}/recovered-controls/${hash(token)}.json`);
        write(receipt,{operationId:record.operationId,lockHash:hash(token),confirmedQuiescent:true},true);
        requireValue(readFileSync(control,"utf8")===token,"Control writer changed during recovery.","WRITER_PENDING");
        renameSync(control,this.path(`${record.operationId}/recovered-controls/${hash(token)}.archived-lock`));
      }
    });
  }
  private async admit(record:WorkflowOperation,graph:ConfiguredDriverServices):Promise<ApprovedWorkflowPlan> {
    const plan=this.plan(record), grant=this.host.policy.grant;
    const approvedTasks=new Set(plan.tasks.map(task=>task.taskId));
    requireValue(record.completed.every(task=>approvedTasks.has(task))&&record.sessions.every(session=>approvedTasks.has(loadSession(this.root,this.profile,session).taskId)),
      "An operation session or completion escaped its approved task set.","OUT_OF_SCOPE");
    requireValue(["start","rework"].every(action=>grant.actions.includes(action as "start"|"rework")&&!grant.humanOnly.includes(action as "start"|"rework")),
      "The approved plan requires autonomous start and rework capabilities.","OUT_OF_SCOPE");
    requireValue(!graph.manual && grant.projectIdentity===this.config.projectIdentity && grant.configDigest===this.config.configDigest &&
      grant.repository===this.profile.repository && grant.integrationRef===this.profile.integrationTarget,"The host grant does not bind this configured project.","OUT_OF_SCOPE");
    for(const entry of plan.tasks) {
      const task=graph.registry.get(entry.taskId), scope=grant.tasks.find(t=>t.taskId===entry.taskId);
      requireValue(task && scope && scope.branch===task.canonicalBranch && hash(scope.paths)===hash(task.allowedPaths) &&
        hash(JSON.parse(git(this.root,"show",`HEAD:${task.sourcePath.replaceAll("\\","/")}`)))===entry.definitionSha256,
        `Approved definition or grant scope differs for ${entry.taskId}.`,"OUT_OF_SCOPE");
    }
    graph.scopedRegistry(plan.tasks.map(t=>t.taskId));
    write(this.path(`${record.operationId}/plan.json`),plan,true);
    return plan;
  }
  private fail(record: WorkflowOperation,error:unknown): void {
    const code=error instanceof Error && "code" in error ? String(error.code) : "HOST_FAILURE";
    record.status=this.pendingEffects.size===0&&this.host.verifyDrained(record)?"EXCEPTION":"QUARANTINED";
    record.exception={code,message:redact(error instanceof Error?error.message:"Host operation failed.",this.host.runtime.token).slice(0,2048),remediation:"Inspect the original operation audit, native run, grant decisions and external session identities. Resolve the named prerequisite, verify drain, then resume this same operation; allowances and historical judgments remain unchanged."};
    this.save(record);
  }
  private reconcile(record:WorkflowOperation):void {
    const decisions=this.host.policy.decisions();
    const settled=new Set(decisions.filter(d=>d.decision==="settled").map(d=>d.operationId));
    const pending=decisions.filter(d=>d.decision==="allow"&&!settled.has(d.operationId));
    if(pending.length || record.pending)requireValue(this.host.verifyDrained(record),"An original external writer or lost side effect is unresolved.","WRITER_PENDING");
    for(const decision of pending)this.host.policy.reconcileDrained(decision.operationId);
    // Native journals, publication discovery and controlled merge reconcile effects, not this record.
  }
  private async run(operationId:string,once:boolean,signal?:AbortSignal):Promise<Readonly<WorkflowOperation>> {
    requireValue(this.pendingEffects.size===0,"The original external operation remains unsettled; verify its drain before continuing.","WRITER_PENDING");
    let signalFailure:unknown;
    const abort=()=>{try{this.command(operationId,"cancel");}catch(error){signalFailure=error;}};
    signal?.addEventListener("abort",abort,{once:true});
    try {
    if(signal?.aborted)abort();
    do {
      const before=this.inspect(operationId);this.assertGrant(before);
      if(before.status==="DONE" || (before.status==="EXCEPTION" && this.control(operationId).sequence===0))return before;
      if(before.nextAtMs>this.clock()) {
        if(once)return before;
        await sleep(Math.min(250,before.nextAtMs-this.clock()));
        if(this.control(operationId).command==="run")continue;
      }
      await exclusive(this.root,this.profile,async()=>{
        const record={...this.inspect(operationId)} as WorkflowOperation;
        if(record.status==="DONE")return;
        requireValue(!this.list().some(other=>other.operationId!==operationId&&this.claimsWorkspace(other)),"Another original operation owns this workspace.","OPERATION_ACTIVE");
        const controller=new AbortController();
        let deadline:ReturnType<typeof setTimeout>|undefined;
        let controlFailure:unknown;
        const poll=setInterval(()=>{try{if(this.control(operationId).command==="cancel"||signal?.aborted)controller.abort();}catch(error){controlFailure=error;controller.abort(error);}},50);
        try {
          const graph=await this.services(), plan=await this.admit(record,graph);
          deadline=setTimeout(()=>controller.abort(new DriverError("BUDGET_EXHAUSTED","Operation wall-clock allowance is exhausted.")),Math.max(0,Math.min(2147483647,plan.budgets.maxRuntimeMs-(this.clock()-record.startedAtMs))));
          this.reconcile(record);
          const check=()=>{
            if(signalFailure)throw signalFailure;
            controller.signal.throwIfAborted();
            if(controlFailure)throw controlFailure;
            const control=this.control(operationId).command;
            if(control!=="run")throw new DriverError("CONTROL_REQUESTED",control);
            requireValue(this.clock()-record.startedAtMs<plan.budgets.maxRuntimeMs,"Operation wall-clock allowance is exhausted.","BUDGET_EXHAUSTED");
          };
          const acknowledged=this.control(operationId);check();
          record.status="RUNNING";record.exception=null;record.controlSequence=acknowledged.sequence;
          const runtime:DriverRuntime={...this.host.runtime,config:graph.config,services:this.services,signal:controller.signal,
            unattended:{taskIds:plan.tasks.map(t=>t.taskId),check,effect:async(operation,action)=>{
              check();
              requireValue(plan.tasks.some(task=>task.taskId===operation.taskId),"The effect is outside this approved plan.","OUT_OF_SCOPE");
              let authorized=operation;
              let chargeIndex:number|undefined;
              if(operation.action==="rework") {
                const reservation=this.reserveRework(record,plan);
                chargeIndex=this.reworkCharge(record,reservation);
                // Reobserve the live grant before replaying the owning gate.
                // Only this predecessor's exact recorded charge can be reused.
                if(chargeIndex===undefined)authorized={action:"start",taskId:operation.taskId,revision:operation.revision};
              }
              check();record.pending=operation.action;this.save(record);
              const result=await this.host.policy.execute(authorized,async capability=>{
                check();capability.assertAuthorized();
                if(chargeIndex!==undefined)this.recordReworkCharge(record,chargeIndex);
                return action();
              });
              controller.signal.throwIfAborted();
              record.pending=null;this.save(record);return result;
            }}};
          if(!record.current) {
            const selection=selectNextEligibleTask(graph.scopedRegistry(plan.tasks.map(t=>t.taskId)),{taskStates:graph.taskStates()});
            if(plan.tasks.every(task=>graph.taskStates().get(task.taskId)==="DONE")) {record.status="DONE";record.pending=null;this.save(record);return;}
            requireValue(selection.kind==="selected", "Approved tasks have unresolved dependencies or admission requirements.","DEPENDENCY_BLOCKED");
            const entry=plan.tasks.find(t=>t.taskId===selection.taskId);requireValue(entry,"Selection escaped the approved task set.","OUT_OF_SCOPE");
            const session=await selectRegistered(this.root,this.profile,entry.taskId,entry.issueNumber);
            record.current=session.sessionId;record.sessions.push(session.sessionId);record.pending="run";this.save(record);
          }
          let session=await followSuccessors(this.root,this.profile,loadSession(this.root,this.profile,record.current),runtime);
          if(session.sessionId!==record.current){record.current=session.sessionId;if(!record.sessions.includes(session.sessionId))record.sessions.push(session.sessionId);this.save(record);}
          if(session.status==="DONE") {
            await this.complete(record,session,runtime);return;
          }
          const state=graph.taskStates().get(session.taskId);
          if(state==="DEV_VALIDATION_FAILED"||state==="REWORK_REQUIRED") {
            this.reserveRework(record,plan);record.pending="successor";this.save(record);
            if(state==="DEV_VALIDATION_FAILED")await runtime.unattended!.effect({action:"rework",taskId:session.taskId,revision:clean(this.root)},()=>graph.developerValidation.enterRework({taskId:session.taskId,actorId:session.request.ownerId,
              runId:`${session.request.runId}::validation-rework`,failedRunId:`${session.request.runId}::dev-validation`,occurredAt:now()}));
            session=await successor(this.root,this.profile,session,runtime);
            record.current=session.sessionId;record.sessions.push(session.sessionId);record.pending=null;this.save(record);
          }
          if(state==="MERGE_READY"&&!existsSync(safePath(this.root,`${driverDirectory(this.profile)}/merge-intents/${session.sessionId}.json`))) {
            if(!await this.publication(record,plan,session,runtime))return;
          }
          check();record.pending="run";this.save(record);
          session=await this.awaitDrain(step(this.root,this.profile,session,runtime),controller.signal);
          record.pending=null;this.save(record);
          if(session.status==="DONE") {
            await this.complete(record,session,runtime);
          } else if(session.result?.finalLifecycleState==="MERGE_READY") {
            await this.publication(record,plan,session,runtime);
          } else if(!["DEV_VALIDATION_FAILED","REWORK_REQUIRED"].includes(session.result?.finalLifecycleState??"")) {
            throw new DriverError("JUDGMENT_BLOCKED","The native attempt has no supported automatic successor; inspect its preserved role judgment.");
          }
        } catch(error) {
          let requested:Control={command:"run",sequence:0};
          try {requested=this.control(operationId);}catch(controlError){this.fail(record,controlError);return;}
          const command=requested.command;
          if(command!=="run") {
            record.status=this.pendingEffects.size===0&&this.host.verifyDrained(record)?command==="cancel"?"CANCELLED":command==="pause"?"PAUSED":"DRAINED":"QUARANTINED";
            if(record.status!=="QUARANTINED")record.controlSequence=requested.sequence;
            record.exception=null;this.save(record);
          } else {
            const code=error instanceof Error&&"code" in error?String(error.code):"HOST_FAILURE";
            const plan=this.plans.find(p=>p.planId===record.planId);
            if(plan&&["GITHUB_UNAVAILABLE","TRANSPORT_ERROR","GIT_FAILED","NETWORK_FAILED","RATE_LIMITED"].includes(code)&&record.retries<plan.budgets.maxRetries&&this.host.verifyDrained(record)) {
              record.retries+=1;this.wait(record,plan,record.retries);this.save(record);
            } else this.fail(record,error);
          }
        } finally {clearInterval(poll);if(deadline!==undefined)clearTimeout(deadline);}
      });
      const result=this.inspect(operationId);
      if(once||!["RUNNING","WAITING"].includes(result.status))return result;
    }while(true);
    }finally{signal?.removeEventListener("abort",abort);}
  }
  private wait(record:WorkflowOperation,plan:ApprovedWorkflowPlan,attempt:number):void {
    record.status="WAITING";
    record.nextAtMs=this.clock()+Math.min(plan.budgets.maxDelayMs,plan.budgets.initialDelayMs*2**Math.min(20,attempt-1));
  }
  private async publication(record:WorkflowOperation,plan:ApprovedWorkflowPlan,session:DriverSession,runtime:DriverRuntime):Promise<boolean> {
    runtime.unattended!.check();record.pending="publication";this.save(record);
    await this.awaitDrain(publish(this.root,this.profile,session,runtime),runtime.signal!);
    await this.awaitDrain(publish(this.root,this.profile,session,runtime,true),runtime.signal!);
    const readiness=await this.awaitDrain((await this.services()).mergeReadiness.evaluate({taskId:session.taskId}),runtime.signal!);
    runtime.unattended!.check();
    if(!readiness.ready) {
      requireValue(readiness.reasons.every(reason=>reason.code==="CI_CHECK_NOT_SUCCESSFUL"&&reason.condition!=="failed"),"Merge readiness requires corrective action; see native exact-head diagnostics.","READINESS_BLOCKED");
      requireValue(record.polls<plan.budgets.maxPolls,"CI polling allowance is exhausted.","BUDGET_EXHAUSTED");
      record.polls+=1;this.wait(record,plan,record.polls);
    }
    record.pending=null;this.save(record);return readiness.ready;
  }
  private async awaitDrain<T>(pending:Promise<T>,signal:AbortSignal):Promise<T> {
    this.pendingEffects.add(pending);
    const settled=pending.finally(()=>this.pendingEffects.delete(pending));
    let listener:()=>void=()=>{};
    const interrupted=new Promise<never>((_resolve,reject)=>{listener=()=>reject(new DriverError("WRITER_PENDING","Cancellation or deadline reached while the original external operation may still be running. Verify its original identity has drained before resume."));signal.addEventListener("abort",listener,{once:true});if(signal.aborted)listener();});
    try{return await Promise.race([settled,interrupted]);}finally{signal.removeEventListener("abort",listener);}
  }
  private reserveRework(record:WorkflowOperation,plan:ApprovedWorkflowPlan):{hostDecisionOffset:number;revision:string} {
    requireValue(record.current,"Rework must belong to the original current session.","UNSAFE_RECOVERY");
    const session=loadSession(this.root,this.profile,record.current);
    const reservations=files(this.path(`${record.operationId}/reworks`),".json");
    const reservation=this.path(`${record.operationId}/reworks/${session.sessionId}.json`);
    if(!existsSync(reservation)) {
      requireValue(reservations.length<plan.budgets.maxReworks,"Operation rework allowance is exhausted.","BUDGET_EXHAUSTED");
      write(reservation,{predecessor:session.sessionId,taskId:session.taskId,runId:session.request.runId,grantDigest:record.grantDigest,
        hostDecisionOffset:this.host.policy.decisions().length,revision:clean(this.root)},true);
    }
    const saved=read(reservation);
    requireValue(object(saved)&&saved.predecessor===session.sessionId&&saved.taskId===session.taskId&&saved.runId===session.request.runId&&saved.grantDigest===record.grantDigest&&
      Number.isSafeInteger(saved.hostDecisionOffset)&&Number(saved.hostDecisionOffset)>=0&&saved.revision===clean(this.root),"Rework reservation differs from the original failed attempt.","UNSAFE_RECOVERY");
    record.reworks=files(this.path(`${record.operationId}/reworks`),".json").length;this.save(record);
    return {hostDecisionOffset:Number(saved.hostDecisionOffset),revision:String(saved.revision)};
  }
  private recordReworkCharge(record:WorkflowOperation,index:number):void {
    const session=loadSession(this.root,this.profile,record.current!);
    const decision=this.host.policy.decisions()[index];
    requireValue(decision?.decision==="allow"&&decision.action==="rework"&&decision.taskId===session.taskId&&decision.revision===clean(this.root)&&decision.grantDigest===record.grantDigest,
      "The original rework dispatch has no exact host charge.","UNSAFE_RECOVERY");
    write(this.path(`${record.operationId}/rework-charges/${session.sessionId}.json`),{predecessor:session.sessionId,runId:session.request.runId,taskId:session.taskId,
      grantDigest:record.grantDigest,revision:decision.revision,decisionIndex:index,hostOperationId:decision.operationId},true);
  }
  private reworkCharge(record:WorkflowOperation,reservation:{hostDecisionOffset:number;revision:string}):number|undefined {
    const session=loadSession(this.root,this.profile,record.current!), directory=`${record.operationId}/rework-dispatch/${session.sessionId}`;
    const intents=files(this.path(directory),".json"), decisions=this.host.policy.decisions();
    requireValue(intents.every((name,index)=>name===`${String(index+1).padStart(12,"0")}.json`),"Rework dispatch journal is incomplete.","UNSAFE_RECOVERY");
    let previousIndex=reservation.hostDecisionOffset-1;
    for(const [position,name] of intents.entries()) {
      const intent=read(this.path(`${directory}/${name}`));
      requireValue(object(intent)&&Object.keys(intent).sort().join(",")==="decisionIndex,grantDigest,predecessor,revision,runId,taskId"&&intent.predecessor===session.sessionId&&
        intent.runId===session.request.runId&&intent.taskId===session.taskId&&intent.grantDigest===record.grantDigest&&intent.revision===reservation.revision&&
        Number.isSafeInteger(intent.decisionIndex)&&Number(intent.decisionIndex)>previousIndex,"Rework dispatch binding changed.","UNSAFE_RECOVERY");
      const index=Number(intent.decisionIndex),decision=decisions[index];previousIndex=index;
      if(!decision){requireValue(position===intents.length-1&&index===decisions.length,"Rework host journal is incomplete.","UNSAFE_RECOVERY");return index;}
      requireValue(decision.action==="rework"&&decision.taskId===session.taskId&&decision.revision===reservation.revision&&decision.grantDigest===record.grantDigest&&["allow","deny"].includes(decision.decision),
        "Another host decision occupied the original rework dispatch; resolve the ambiguity without resetting allowance.","UNSAFE_RECOVERY");
      if(decision.decision==="allow") {requireValue(position===intents.length-1,"A charged rework has a later dispatch intent.","UNSAFE_RECOVERY");this.recordReworkCharge(record,index);return undefined;}
    }
    const index=decisions.length;
    write(this.path(`${directory}/${String(intents.length+1).padStart(12,"0")}.json`),{predecessor:session.sessionId,runId:session.request.runId,taskId:session.taskId,
      grantDigest:record.grantDigest,revision:reservation.revision,decisionIndex:index},true);
    return index;
  }
  private async complete(record:WorkflowOperation,session:DriverSession,runtime:DriverRuntime):Promise<void> {
    requireValue(session.result?.mergeCommitSha,"Native completion has no accepted merge identity.","UNSAFE_RECOVERY");
    record.pending="synchronize";this.save(record);
    await this.awaitDrain(this.synchronize(session.result.mergeCommitSha),runtime.signal!);
    runtime.unattended!.check();
    if(!record.completed.includes(session.taskId))record.completed.push(session.taskId);
    record.current=null;record.pending=null;record.nextAtMs=0;this.save(record);
  }
  private async synchronize(acceptedHead:string):Promise<void> {
    clean(this.root);
    if(this.host.synchronize)await this.host.synchronize(this.profile.integrationTarget,acceptedHead);
    else {
      git(this.root,"fetch",this.profile.storage!.remote,this.profile.integrationTarget);
      git(this.root,"merge-base","--is-ancestor",acceptedHead,"FETCH_HEAD");
      git(this.root,"switch",this.profile.integrationTarget);
      git(this.root,"merge","--ff-only","FETCH_HEAD");
    }
    requireValue(git(this.root,"branch","--show-current")===this.profile.integrationTarget,"Integration synchronization must end on the configured target.","UNSAFE_RECOVERY");
    git(this.root,"merge-base","--is-ancestor",acceptedHead,clean(this.root));
  }
}
