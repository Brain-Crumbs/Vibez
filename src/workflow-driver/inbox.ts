import { existsSync, lstatSync, readFileSync } from "node:fs";
import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { createLocalReviewReworkGate } from "../review-rework/index.js";
import { FileDeveloperStartStateStore, type DeveloperStartResult } from "../dev-start/index.js";
import { FileAssignmentLockStore, isAssignmentLockExpired } from "../assignment-lock/index.js";
import { FileOrchestrationRunStore } from "../orchestration-engine/index.js";
import { driverDirectory, stateDirectory, orchestrationDirectory, files, git, hash, id, now, object, read, redact, requireValue, safePath, stableId, validate, write, writeText, clean, DriverError } from "./io.js";
import { diagnostic, loadSession, mapMarkdown, prepare, register, saveSession, sessionPath } from "./intake.js";
import type { DriverRuntime } from "./driver.js";
import type { DriverProfile, DriverResponse, DriverSession, IntakeRecord } from "./model.js";

export const successorId = (sessionId:string):string => stableId(`${sessionId}:successor`);
export async function followSuccessors(root:string,p:DriverProfile,session:DriverSession, host?:DriverRuntime):Promise<DriverSession> {
  for(let depth=0;depth<10;depth++) {
    if(!existsSync(sessionPath(root,p,successorId(session.sessionId))))return session;
    session=await successor(root,p,session,host);
  }
  requireValue(!existsSync(sessionPath(root,p,successorId(session.sessionId))),"Linked rework chain exceeds the supported limit; inspect preserved records.");
  return session;
}
export async function successor(root: string, p: DriverProfile, s: DriverSession, host?: DriverRuntime): Promise<DriverSession> {
  const state = new FileDeveloperStartStateStore(safePath(root, `${stateDirectory(p)}/lifecycle`));
  const nextId = successorId(s.sessionId);
  const path = safePath(root, `${driverDirectory(p)}/sessions/${nextId}.json`);
  const existing = existsSync(path) ? loadSession(root,p,nextId) : null;
  requireValue(!existing||(existing.predecessor===s.sessionId&&existing.taskId===s.taskId&&existing.definitionHash===s.definitionHash&&existing.request.ownerId===s.request.ownerId&&
    existing.request.assignmentRunId===(s.request.assignmentRunId??s.request.runId)&&existing.request.assignmentKey===(s.request.assignmentKey??s.request.idempotencyKey)),"Saved successor has an invalid predecessor binding.");
  const lifecycle=state.get(s.taskId);
  if(existing && lifecycle?.history.some(e=>e.toState==="IN_DEVELOPMENT"&&e.runId===`${existing.request.runId}::resume-rework`))return existing;
  requireValue(lifecycle?.currentState === "REWORK_REQUIRED", "A new judgment needs legal rework. Administrative reset remains a separate quiescent host-authorized operation.");
  const head=clean(root);
  const journalStore=new FileOrchestrationRunStore(safePath(root,orchestrationDirectory(p)));
  const original=journalStore.get(s.request.assignmentKey??s.request.idempotencyKey!);
  const current=journalStore.get(s.request.idempotencyKey!);
  const start=original?.values.start as DeveloperStartResult|undefined;
  const predecessor=current?.values.start as DeveloperStartResult|undefined;
  const lock=new FileAssignmentLockStore(safePath(root,`${stateDirectory(p)}/assignments`)).get(s.taskId);
  requireValue(start&&predecessor&&original?.runId===(s.request.assignmentRunId??s.request.runId)&&current?.runId===s.request.runId&&
    start.taskId===s.taskId&&predecessor.taskId===s.taskId&&predecessor.assignment.lockId===start.assignment.lockId&&
    lock?.status==="ACTIVE"&&lock.ownerId===s.request.ownerId&&lock.lockId===start.assignment.lockId&&lock.runId===start.assignment.runId&&
    lock.canonicalBranch===start.canonicalBranch&&git(root,"branch","--show-current")===start.canonicalBranch&&!isAssignmentLockExpired(lock,now()),"Rework requires the predecessor's exact original active assignment.","ASSIGNMENT_MISMATCH");
  const reworkEntry=[...lifecycle.history].reverse().find(event=>event.toState==="REWORK_REQUIRED");
  requireValue(reworkEntry?.revisionIdentity===head&&reworkEntry.actorId===s.request.ownerId&&
    ([`${s.request.runId}::review-rework`,`${s.request.runId}::validation-rework`].includes(reworkEntry.runId??"")||(reworkEntry.runId?.startsWith("recovery:")&&reworkEntry.evidenceRef?.startsWith(`${stateDirectory(p)}/recovery/`))),"Rework does not belong to the current failed attempt or an authorized recovery.");
  const nextRun = id();
  const next: DriverSession = existing ?? { ...s, sessionId: nextId, predecessor: s.sessionId, pendingPacket: null, developerPacket:null,diagnosticId: null, result: null, status: "PREPARED",
    request: { ownerId: s.request.ownerId, runId: nextRun, idempotencyKey: nextRun, assignmentRunId: s.request.assignmentRunId ?? s.request.runId, assignmentKey:s.request.assignmentKey??s.request.idempotencyKey!,occurredAt: now() } };
  // Intent survives a crash before/after the owning transition. A saved successor
  // cannot execute until resumeDevelopment has actually entered IN_DEVELOPMENT.
  saveSession(root, p, next);
  const rework = (await host?.services?.())?.reviewRework ?? await createLocalReviewReworkGate(root);
  const resume = () => rework.resumeDevelopment({ taskId: s.taskId, actorId: p.roleActors.Developer, runId: `${next.request.runId}::resume-rework`, occurredAt: next.request.occurredAt });
  if(host?.unattended) {
    host.unattended.check();
    await host.unattended.effect({action:"start",taskId:s.taskId,revision:head},resume);
  } else resume();
  s.status = "STOPPED"; saveSession(root, p, s);
  return next;
}

function unwrap(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const match = /^```json\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    requireValue(match, "Save exactly one fenced JSON block with no surrounding prose.");
    return JSON.parse(match[1]!) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}

interface BoundReply {
  attemptId: string;
  expectedPacketId: string;
  text: string;
}

export interface DriverReceipt {
  schemaId: "ipt.driver-receipt";
  schemaVersion: "1.0.0";
  inputHash: string;
  packetId: string | null;
  status: "ACCEPTED" | "REUSED" | "REJECTED";
  occurredAt: string;
  diagnosticId: string | null;
  nextAction: string;
}

function boundArchive(p: DriverProfile, bound: BoundReply) {
  const scope = hash({ profile: hash(p), attemptId: bound.attemptId,
    packetId: bound.expectedPacketId, inputHash: hash(bound.text) });
  return `${p.paths.archive}/bound/${scope}`;
}

/** Must be called under the same driver writer lock as CLI scan and step. */
export async function scanBoundReply(root: string, p: DriverProfile, session: DriverSession, host: DriverRuntime, bound: BoundReply) {
  requireValue(session.sessionId === bound.attemptId, "Wrong bound reply attempt.");
  const result = await scan(root, p, session, host, bound);
  return { session: result.session!, receipt: result.receipts[0] as DriverReceipt };
}

export async function scan(root: string, p: DriverProfile, session: DriverSession | null, host?: DriverRuntime, bound?: BoundReply): Promise<{session:DriverSession|null; receipts:unknown[]}> {
  const receipts: unknown[] = [];
  if (!bound) for (const name of files(safePath(root, p.paths.issues), ".md")) {
    try {
      const bytes=stable(root,p,safePath(root,`${p.paths.issues}/${name}`)); if(bytes===null)continue;
      const receipt=safePath(root,`${p.paths.archive}/${hash({issue:bytes,profile:hash(p)})}.issue.json`);
      if(existsSync(receipt))continue;
      const intake = await prepare(root,p,bytes); const captured={intakeId:intake.intakeId,sessionId:intake.diagnostics.length?null:intake.sessionId};
      if(intake.sessionId&&intake.diagnostics.length)continue;
      write(receipt,captured,true); receipts.push(captured);
    }
    catch (error) { receipts.push({ issueFile: name, diagnosticId: diagnostic(root, p, "INTAKE_ERROR", error instanceof Error ? error.message : "Cannot prepare issue.") }); }
  }
  const incoming = new Map<string,string>();
  if (bound) incoming.set(hash(bound.text), bound.text);
  if (!bound) for (const name of files(safePath(root, p.paths.responses), ".json").concat(files(safePath(root, p.paths.responses), ".md"))) {
    let bytes:string|null;
    try { bytes=stable(root,p,safePath(root,`${p.paths.responses}/${name}`)); }
    catch { diagnostic(root,p,"INBOX_UNREADABLE","An inbox entry is not a bounded regular file. Save a new regular file atomically.");continue; }
    if(bytes!==null)incoming.set(hash(bytes),bytes);
  }
  if (!bound) for (const name of files(safePath(root,p.paths.archive),".input.json")) {
    const inputHash=name.slice(0,-".input.json".length);
    if(incoming.has(inputHash)||existsSync(safePath(root,`${p.paths.archive}/${inputHash}.receipt.json`)))continue;
    const capture=read(safePath(root,`${p.paths.archive}/${name}`));
    if(object(capture)&&typeof capture.original==="string"&&hash(capture.original)===inputHash)incoming.set(inputHash,capture.original);
  }
  for (const [inputHash,bytes] of incoming) {
    const archive = bound ? boundArchive(p, bound) : `${p.paths.archive}/${inputHash}`;
    const receiptPath = safePath(root, archive + ".receipt.json");
    if (existsSync(receiptPath)) {
      if (bound) receipts.push(read(receiptPath));
      continue;
    }
    const capture = () => {
      if (bound) writeText(safePath(root, archive + ".input.txt"), redact(bytes, host?.token), true);
      else write(safePath(root, archive + ".input.json"), { original: redact(bytes) }, true);
    };
    let packetId: string | null = null, diagnosticId: string | null = null;
    let status: DriverReceipt["status"] = "ACCEPTED";
    let nextAction = "Continue the same driver session.";
    try {
      requireValue(redact(bytes, host?.token)===bytes,"Remove host credentials from the response before importing.");
      const input = unwrap(bytes); requireValue(object(input), "Response must be one JSON object.");
      requireValue(typeof input.packetId === "string" && /^[a-f0-9]{64}$/.test(input.packetId), "Response has no valid packet binding."); packetId = input.packetId;
      if (bound) requireValue(packetId === bound.expectedPacketId, "Reply names a different packet. Copy the handoff for this attempt.");

      if (input.schemaId === "ipt.local-agent-result") {
        if(!session)continue;
        if(!bound && session.pendingPacket!==packetId && files(safePath(root,`${driverDirectory(p)}/sessions`),".json").some(name=>{const record=read(safePath(root,`${driverDirectory(p)}/sessions/${name}`));return object(record)&&record.pendingPacket===packetId&&record.profileHash===hash(p)&&record.status==="WAITING";}))continue;
        const exchange = (await host?.services?.())?.manual ?? new FileManualAgentProvider(safePath(root, p.paths.exchange));
        const acceptedPath = safePath(root, `${driverDirectory(p)}/accepted/${packetId}.json`);
        if (bound && existsSync(acceptedPath) && existsSync(exchange.resultPath(packetId))) {
          const fence = read(acceptedPath);
          const original = exchange.readExchange(packetId);
          requireValue(object(fence) && fence.packetId === packetId && fence.sessionId === bound.attemptId &&
            original.result && fence.resultHash === hash(original.result) && fence.resultHash === hash(input),
            "A different result is already recorded for this packet.");
          capture();
          status = "REUSED";
        } else {
          requireValue(session && session.pendingPacket === packetId && session.status === "WAITING", "Result does not belong to this session's current pending packet.");
          const packet = exchange.readPacket(packetId);
          const head=clean(root,packet.role==="Developer"?undefined:packet.revisionIdentity);
          const definition=JSON.parse(git(root,"show",`${head}:${session.definitionPath}`)) as {canonicalBranch?:string};
          requireValue(hash(definition)===session.definitionHash&&git(root,"branch","--show-current")===definition.canonicalBranch&&packet.taskId===session.taskId&&packet.runId.startsWith(`${session.request.runId}::`),"Response belongs to a stale source or attempt.");
          if(packet.role==="Developer")git(root,"merge-base","--is-ancestor",packet.revisionIdentity,head);
          capture();
          const result = exchange.importResult(packetId, input, accepted=>{
            clean(root,head);
            requireValue(git(root,"branch","--show-current")===definition.canonicalBranch,"Source branch changed before publication.");
            write(safePath(root,`${driverDirectory(p)}/accepted/${packet.packetId}.json`),{sessionId:session!.sessionId,packetId:packet.packetId,head,role:packet.role,status:accepted.status,resultHash:hash(accepted)},true);
          });
          status = result.reused ? "REUSED" : "ACCEPTED";
        }
      } else {
        validate(root, "driver-response", input);
        const response = input as unknown as DriverResponse;
        requireValue(response.projectRoot === root && response.profileHash === hash(p), "Response belongs to another repository/profile.");
        const diagnosticPath = safePath(root, `${p.paths.outbound}/${packetId}.diagnostic.json`);
        if (bound) requireValue(response.action !== "clarify" && existsSync(diagnosticPath),
          "A typed diagnostic reply requires the offered repair handoff.");
        const packet = read(diagnosticPath);
        requireValue(object(packet) && packet.packetId === packetId && packet.profileHash === response.profileHash, "Unknown diagnostic binding.");
        if (bound) requireValue(packet.sessionId === bound.attemptId && object(packet.responseTemplate) &&
          packet.responseTemplate.schemaId === "ipt.driver-response" && packet.responseTemplate.action === response.action,
          "Reply does not match the offered diagnostic action.");
        if (response.action === "clarify") {
          requireValue(!bound, "New task admission requires the Vibez CLI.");
          requireValue(response.sessionId===undefined,"Intake clarification cannot include a session ID.");
          requireValue(response.intakeId === packet.intakeId && typeof response.intakeId === "string" && /^[a-f0-9]{64}$/.test(response.intakeId), "Clarification intake mismatch.");
          const intake = read(safePath(root, `${driverDirectory(p)}/intakes/${response.intakeId}.json`)) as unknown as IntakeRecord;
          requireValue(response.task && Number.isSafeInteger(response.issueNumber), "Clarification requires a proposed complete task and issue number.");
          requireValue(intake.issueNumber===null||response.issueNumber===intake.issueNumber,"Clarification cannot replace the operator-selected issue.");
          const mapped=mapMarkdown(intake.source);
          requireValue(!mapped.diagnostics.some(message=>message.startsWith("Duplicate or contradictory")),"Resolve contradictory issue fields in operator-selected Markdown before registration.");
          for(const [key,value] of Object.entries(mapped.known)) {
            const proposed=(response.task as unknown as Record<string,unknown>)[key];
            requireValue(proposed!==undefined&&hash(value)===hash(proposed),`Clarification cannot change the explicit '${key}' field.`);
          }
          write(safePath(root,`${p.paths.archive}/${inputHash}.input.json`),{original:bytes},true);
          let accepted: IntakeRecord;
          if(intake.sessionId) {
            requireValue(intake.task&&hash(intake.task)===hash(response.task)&&intake.issueNumber===response.issueNumber,"Existing clarification registration is immutable.");
            accepted=await prepare(root,p,intake.source);
            status="REUSED";
          } else accepted=await register(root,p,{...intake,task:response.task,issueNumber:response.issueNumber!});
          nextAction = `Prepared session ${accepted.sessionId}; explicitly select it with orchestrate run.`;
        } else {
          if(!session)continue;
          requireValue(response.task===undefined&&response.intakeId===undefined&&response.issueNumber===undefined,"Repair cannot change task or issue inputs.");
          const attempts = safePath(root, `${driverDirectory(p)}/repair-attempts/${packetId}`);
          const repairHash = bound ? hash(archive) : inputHash;
          const intent = safePath(root, `${driverDirectory(p)}/repair-attempts/${packetId}/${repairHash}.json`);
          requireValue(response.sessionId === session.sessionId, "Repair belongs to a different session.");
          const prior = bound && existsSync(intent);
          requireValue(prior || session.diagnosticId === packetId, "Repair is stale. Copy the current diagnostic handoff.");
          if (!prior) clean(root, typeof packet.revision === "string" ? packet.revision : undefined);
          requireValue(existsSync(intent) || files(attempts, ".json").length < p.manual.maxAttempts,
            "Repair proposal budget exhausted. Inspect preserved records in Vibez.");
          if (bound) capture();
          write(intent, { packetId, inputHash, action: response.action }, true);
          if (response.action === "rework") { session = await successor(root, p, session, host); nextAction = `Continue linked successor ${session.sessionId}.`; }
          else if (session.diagnosticId === packetId) { session.diagnosticId = null; saveSession(root, p, session); }
          if (prior) status = "REUSED";
        }
      }
    } catch (error) {
      // IO failures leave the durable submission pending for recovery.
      if (bound && object(error) && typeof error.code === "string" && /^E[A-Z]+$/.test(error.code)) throw error;
      status = "REJECTED"; nextAction = "Correct the unaccepted response and save it again; retain the original pending packet. Terminal outcomes require legal rework.";
      const detail = bound
        ? error instanceof SyntaxError ? "Paste one valid JSON object or a single fenced JSON block."
        : error instanceof DriverError && error.code !== "INVALID_INPUT" ? error.message
        : "Reply did not match the current handoff. Check its JSON, task, role, run and revision bindings."
        : error instanceof Error ? error.message : "Invalid response.";
      const pending=session?.pendingPacket;
      if(session&&pending&&(bound ? bound.expectedPacketId===pending : packetId===null||packetId===pending)&&!existsSync(safePath(root,`${p.paths.exchange}/${pending}.result.json`))) {
        let handoff:unknown;
        try{handoff=read(safePath(root,`${p.paths.outbound}/${pending}.handoff.json`));}catch{/* Retain the pending packet if the companion needs regeneration. */}
        diagnosticId=diagnostic(root,p,"REJECTED_INPUT",detail,session,null,object(handoff)?handoff:undefined);
      } else diagnosticId = diagnostic(root, p, "REJECTED_INPUT", detail);
    }
    // Captured original and receipt are append-only. Import-first ordering is safe:
    // if receipt writing crashes, the immutable adapter reports reused next scan.
    capture();
    const receipt: DriverReceipt = { schemaId: "ipt.driver-receipt", schemaVersion: "1.0.0", inputHash, packetId, status, occurredAt: now(), diagnosticId, nextAction };
    validate(root, "driver-receipt", receipt); write(receiptPath, receipt, true); receipts.push(receipt);
  }
  return { session, receipts };
}

function stable(root: string, p: DriverProfile, path: string): string|null {
  const stat = lstatSync(path) as ReturnType<typeof lstatSync> & {size:number};
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, "Inbox input must be a regular file at most 4 MiB.");
  const bytes=readFileSync(path,"utf8");
  const snapshot = { size: stat.size, content: hash(bytes) };
  const observed = safePath(root, `${driverDirectory(p)}/observations/${hash(path)}.json`);
  const previous = existsSync(observed) ? read(observed) as {size:number;content:string;at:number} : null;
  if (previous && previous.size === snapshot.size && previous.content === snapshot.content) return Date.now() - previous.at >= 500 ? bytes : null;
  write(observed, { ...snapshot, at: Date.now() }); return null;
}
