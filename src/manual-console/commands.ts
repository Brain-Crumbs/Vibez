import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { DriverRuntime } from "../workflow-driver/driver.js";
import { followSuccessors, scanBoundReply, type DriverReceipt } from "../workflow-driver/inbox.js";
import { loadSession } from "../workflow-driver/intake.js";
import { driverDirectory, DriverError, exclusive, hash, read, redact, safePath, stableId, write, writeText } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { ConsoleProblem } from "./problem.js";
import type { ManualConsoleReader } from "./reader.js";

const missing = () => new ConsoleProblem(404, "not-found", "The requested resource is unavailable.");
const stale = () => new ConsoleProblem(409, "stale-target", "Refresh this run and use its current attempt and pending packet.");
const busy = () => new ConsoleProblem(409, "writer-busy", "Another Vibez writer holds this checkout. Retry after it releases the lock.", 1000);
const unsupported = (message: string) => new ConsoleProblem(422, "unsupported-action", message);
const unavailable = () => new ConsoleProblem(503, "temporarily-unavailable", "Retry the original request ID after restoring project storage.", 1000);

export const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
export const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
export const replyBytes = 4 * 1024 * 1024;

type Action = "start" | "resume" | "submit-reply";
type Target = { projectId: string; sessionId: string; attemptId: string };
type Command =
  | { action: "start" | "resume"; target: Target; requestId: string }
  | { action: "submit-reply"; target: Target; requestId: string; expectedPacketId: string; inputHash: string };
type Problem = { code: ConsoleProblem["code"]; message: string; retryAfterMs: number | null };
type Operation =
  | { state: "pending" }
  | { state: "finished"; receiptId: string | null }
  | { state: "failed"; problem: Problem };

export class ManualConsoleCommands {
  readonly #active = new Map<string, string>();
  readonly #host: DriverRuntime;

  constructor(private readonly root: string, private readonly reader: ManualConsoleReader, host: DriverRuntime,
    private readonly runStep: (profile: DriverProfile, session: DriverSession) =>
      Promise<Pick<DriverSession, "pendingPacket" | "diagnosticId">>) {
    this.#host = { ...host, manualConsole: true };
  }

  #file(profile: DriverProfile, sessionId: string, name: string) {
    const scope = hash({ profile: hash(profile), projectId: this.reader.projectId, sessionId });
    return safePath(this.root, driverDirectory(profile) + "/console/" + scope + "/" + name);
  }

  #operation(profile: DriverProfile, command: Command): Operation {
    const path = this.#file(profile, command.target.sessionId, command.requestId + ".operation.json");
    return existsSync(path) ? read(path) as Operation : { state: "pending" };
  }

  #view(profile: DriverProfile, command: Command, replayed: boolean) {
    const { action, requestId, target } = command;
    return { action, requestId, target, replayed, operation: this.#operation(profile, command) };
  }

  #readCommand(profile: DriverProfile, sessionId: string, requestId: string): Command | null {
    const path = this.#file(profile, sessionId, requestId + ".request.json");
    return existsSync(path) ? read(path) as Command : null;
  }

  async submit(action: Action, target: Target, requestId: string, reply?: { text: string; expectedPacketId: string }) {
    const { profile } = this.reader.commandSession(target.sessionId);
    const command: Command = action === "submit-reply" && reply
      ? { action, target, requestId, expectedPacketId: reply.expectedPacketId, inputHash: hash(reply.text) }
      : { action: action as "start" | "resume", target, requestId };
    const saved = this.#readCommand(profile, target.sessionId, requestId);
    if (saved) {
      if (hash(saved) !== hash(command))
        throw new ConsoleProblem(409, "conflicting-request", "This request ID is already reserved for a different action, target or reply.");
      if (this.#operation(profile, saved).state === "pending") await this.#advance(profile, saved, true);
      return this.#view(profile, saved, true);
    }
    await this.#advance(profile, command, false, reply?.text);
    return this.#view(profile, command, false);
  }

  lookup(sessionId: string, requestId: string) {
    const { profile } = this.reader.commandSession(sessionId);
    const command = this.#readCommand(profile, sessionId, requestId);
    if (!command) throw missing();
    return this.#view(profile, command, true);
  }

  receipt(sessionId: string, receiptId: string) {
    const { profile } = this.reader.commandSession(sessionId);
    const path = this.#file(profile, sessionId, receiptId + ".receipt.json");
    if (!existsSync(path)) throw missing();
    return read(path);
  }

  async #advance(profile: DriverProfile, command: Command, replayed: boolean, text?: string) {
    const { target, requestId, action } = command;
    const key = target.sessionId + ":" + requestId;
    const fingerprint = hash(command);
    const active = this.#active.get(key);
    if (active) {
      if (active !== fingerprint)
        throw new ConsoleProblem(409, "conflicting-request", "This request ID is in progress for a different action, target or reply.");
      return;
    }
    this.#active.set(key, fingerprint);
    try {
      await exclusive(this.root, profile, async () => {
        const current = this.reader.commandSession(target.sessionId);
        const saved = this.#readCommand(profile, target.sessionId, requestId);
        if (saved && hash(saved) !== hash(command))
          throw new ConsoleProblem(409, "conflicting-request", "This request ID was already reserved for a different action, target or reply.");
        if (saved && this.#operation(profile, saved).state !== "pending") return;
        if (!saved) {
          if (target.attemptId !== current.session.sessionId) throw stale();
          const { phase } = current.detail.summary;
          if (action === "submit-reply") {
            if (command.expectedPacketId !== current.detail.pending.role?.packetId &&
                command.expectedPacketId !== current.detail.pending.repair?.replyToPacketId) throw stale();
            writeText(this.#file(profile, target.sessionId, command.inputHash + ".input.txt"), text!, true);
          } else if (action === "start") {
            if (phase !== "prepared" || current.session.predecessor)
              throw unsupported(current.detail.blocker?.message ?? "Start requires an eligible prepared session.");
          } else if (phase === "blocked" && current.detail.pending.role) {
            throw unsupported(current.detail.blocker?.message ?? "Restore the bound role's source revision before resuming.");
          } else if (phase === "completed" || phase === "active" || phase === "prepared" ||
              (phase === "rework" && current.detail.pending.repair)) {
            throw unsupported("Resume requires a stopped or waiting attempt. Use the offered repair for legal rework.");
          }
          write(this.#file(profile, target.sessionId, requestId + ".request.json"), command, true);
        }
        const finish = (operation: Operation) => write(this.#file(profile, target.sessionId, requestId + ".operation.json"), operation, true);
        const services = await this.#host.services?.();
        if (!services) throw unavailable();
        services.prepareWrite();
        if (action !== "submit-reply") {
          if (current.session.sessionId !== target.attemptId) {
            const problem = stale();
            finish({ state: "failed", problem: { code: problem.code, message: problem.message, retryAfterMs: problem.retryAfterMs } });
            return;
          }
          const native = action === "resume" && current.session.predecessor
            ? await followSuccessors(this.root, profile, loadSession(this.root, profile, target.sessionId), this.#host)
            : current.session;
          if (native.sessionId !== target.attemptId) throw stale();
          const result = await this.runStep(profile, native);
          const observed = this.reader.commandSession(target.sessionId).detail;
          if (result.diagnosticId && (!result.pendingPacket || observed.summary.phase === "blocked")) {
            const problem = unsupported(observed.blocker?.message ?? "Inspect the native run blocker before retrying.");
            finish({ state: "failed", problem: { code: problem.code, message: problem.message, retryAfterMs: problem.retryAfterMs } });
          } else finish({ state: "finished", receiptId: null });
          return;
        }

        const inputPath = this.#file(profile, target.sessionId, command.inputHash + ".input.txt");
        const attributes = lstatSync(inputPath) as ReturnType<typeof lstatSync> & { size: number };
        if (!attributes.isFile() || attributes.isSymbolicLink() || attributes.size > replyBytes) throw unavailable();
        const input = readFileSync(inputPath, "utf8");
        if (hash(input) !== command.inputHash || redact(input, this.#host.token) !== input) throw unavailable();
        const session = loadSession(this.root, profile, target.attemptId);
        const imported = await scanBoundReply(this.root, profile, session, this.#host, {
          attemptId: target.attemptId, expectedPacketId: command.expectedPacketId, text: input,
        });
        const { receipt } = imported;
        const receiptId = stableId({ target, requestId, expected: command.expectedPacketId, input: command.inputHash });
        const repairPacketId = this.#scopedDiagnostic(profile, target.attemptId, receipt.diagnosticId);
        this.#saveReceipt(profile, target, requestId, command.expectedPacketId, receiptId, receipt, repairPacketId);
        // A CLI writer may have completed this exact packet before recovery. Never
        // advance an unrelated or already replaced packet again on receipt replay.
        if (receipt.status !== "REJECTED") {
          const active = this.reader.commandSession(target.sessionId).session;
          const repair = this.#scopedDiagnostic(profile, target.attemptId, command.expectedPacketId);
          const originalStillPending = active.sessionId === target.attemptId &&
            (active.pendingPacket === command.expectedPacketId || (repair && !active.pendingPacket && !active.diagnosticId));
          const successorPrepared = repair && active.predecessor === target.attemptId && active.status === "PREPARED";
          if (originalStillPending || successorPrepared) await this.runStep(profile, active);
        }
        finish({ state: "finished", receiptId });
      });
    } catch (error) {
      if (error instanceof DriverError && error.code === "DRIVER_BUSY") {
        if (!replayed) throw busy();
        return;
      }
      if (!this.#readCommand(profile, target.sessionId, requestId)) throw error;
      // The operation is durable, but the importer or gate may have committed
      // before I/O failed. Keep it pending for reconciliation.
      if (error instanceof ConsoleProblem && error.code === "conflicting-request") throw error;
    } finally {
      this.#active.delete(key);
    }
  }

  #scopedDiagnostic(profile: DriverProfile, attemptId: string, id: string | null) {
    if (!id) return null;
    const path = safePath(this.root, profile.paths.outbound + "/" + id + ".diagnostic.json");
    if (!existsSync(path)) return null;
    const diagnostic = read(path) as { sessionId?: string };
    return diagnostic.sessionId === attemptId ? id : null;
  }

  #saveReceipt(profile: DriverProfile, target: Target, requestId: string, expectedPacketId: string,
    receiptId: string, receipt: DriverReceipt, repairPacketId: string | null) {
    const rejected = receipt.status === "REJECTED";
    write(this.#file(profile, target.sessionId, receiptId + ".receipt.json"), {
      target, receiptId, requestId, expectedPacketId,
      importedPacketId: rejected ? null : receipt.packetId, disposition: receipt.status.toLowerCase(),
      recordedAt: receipt.occurredAt,
      diagnostic: rejected ? { code: "REJECTED_INPUT", message: "The reply did not match the bound handoff. Check the repair correspondence and submit a correction with a new request ID." } : null,
      repairPacketId: rejected ? repairPacketId : null,
      nextAction: receipt.nextAction.slice(0, 2048),
    }, true);
  }
}
