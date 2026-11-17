import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentProviderError, type AgentRunResult } from "../agent-provider/index.js";
import { digest } from "../project-config/index.js";
import { isSha, object } from "../history/provenance.js";
import { optionalStat } from "../history/snapshot.js";
import { LOCAL_LLAMA_PROVIDER_ID } from "./protocol.js";

export function unavailable(message: string) {
  return new AgentProviderError("PROVIDER_ERROR", message, false, LOCAL_LLAMA_PROVIDER_ID);
}

export interface LocalLlamaIntent {
  readonly version: 1;
  readonly attempt: string;
  readonly binding: string;
  readonly session: string;
  readonly role: string;
  readonly revision: string;
  readonly projectIdentity: string;
  readonly configDigest: string;
  readonly provider: string;
  readonly runtimeVersion: string;
  readonly model: string;
  readonly modelSha256: string;
  readonly occurredAt: string;
}

type Outcome = "COMPLETED" | "TRANSPORT_FAILED" | "CANCELLED" | "MALFORMED" | "RETIRED";
type Terminal = { readonly status: Outcome; readonly binding: string; readonly result?: AgentRunResult };

function sync(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeRecord(file: string, value: object) {
  const staged = join(dirname(file), "." + randomUUID() + ".tmp");
  const fd = openSync(staged, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value) + "\n", { encoding: "utf8" });
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (optionalStat(file) !== null) throw unavailable("A session record already exists.");
    renameSync(staged, file);
    sync(dirname(file));
  } finally {
    if (optionalStat(staged) !== null) unlinkSync(staged);
  }
}

function readRecord(file: string): unknown {
  const stat = optionalStat(file);
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) {
    throw unavailable("Unsafe local session record.");
  }
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

export class LocalLlamaJournal {
  private readonly lease: string;
  constructor(private readonly root: string) {
    this.lease = join(root, "active");
  }

  private attemptPath(attempt: string) {
    if (!isSha(attempt)) throw unavailable("Invalid local attempt identity.");
    const path = join(this.root, attempt);
    const type = optionalStat(path);
    if (type !== null && (!type.isDirectory() || type.isSymbolicLink())) throw unavailable("Unsafe local attempt directory.");
    return path;
  }

  find(attempt: string, binding: string): Terminal | null {
    const path = this.attemptPath(attempt);
    if (optionalStat(path) === null) return null;
    const intent = readRecord(join(path, "intent.json"));
    if (!object(intent) || intent.version !== 1 || intent.attempt !== attempt || intent.binding !== binding) {
      throw unavailable("The existing attempt has different or uncertain launch identity.");
    }
    const record = readRecord(join(path, "terminal.json"));
    if (!object(record) || !object(record.terminal) || digest(record.terminal) !== record.sha256 ||
        record.terminal.binding !== binding || typeof record.terminal.status !== "string" ||
        !["COMPLETED", "TRANSPORT_FAILED", "CANCELLED", "MALFORMED", "RETIRED"].includes(record.terminal.status) ||
        (record.terminal.status === "COMPLETED") !== object(record.terminal.result)) {
      throw unavailable("The original local worker outcome is unresolved or quarantined. A second launch is blocked.");
    }
    return record.terminal as unknown as Terminal;
  }

  begin(intent: LocalLlamaIntent) {
    if (optionalStat(this.lease) !== null) throw unavailable("A local worker is active or quarantined.");
    // A competing, crashed or interrupted reservation is never stolen by age or PID.
    try { mkdirSync(this.lease, { mode: 0o700 }); } catch { throw unavailable("Could not reserve the local worker."); }
    sync(this.root);
    const path = this.attemptPath(intent.attempt);
    if (optionalStat(path) !== null) {
      this.release();
      throw unavailable("The original attempt already holds the invocation identity.");
    }
    writeRecord(join(this.lease, "attempt.json"), { attempt: intent.attempt, binding: intent.binding });
    mkdirSync(path, { mode: 0o700 });
    sync(this.root);
    writeRecord(join(path, "intent.json"), intent);
  }

  finish(attempt: string, terminal: Terminal) {
    const path = this.attemptPath(attempt);
    const holder = this.holder(attempt, terminal.binding);
    writeRecord(join(path, "terminal.json"), { terminal, sha256: digest(terminal) });
    this.release(holder);
  }

  private holder(attempt: string, binding: string) {
    const stat = lstatSync(this.lease);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("Unsafe local worker reservation.");
    const file = join(this.lease, "attempt.json");
    const holder = readRecord(file);
    if (!object(holder) || holder.attempt !== attempt || holder.binding !== binding) {
      throw unavailable("Local worker reservation changed.");
    }
    return file;
  }

  private release(holder?: string) {
    if (holder !== undefined) unlinkSync(holder);
    rmdirSync(this.lease);
    sync(this.root);
  }

  /** An explicit trusted recovery. Leave old intents and terminal records intact. */
  retire(attempt: string, binding: string, verifyDrained: () => boolean) {
    const path = this.attemptPath(attempt);
    this.holder(attempt, binding);
    if (verifyDrained() !== true) throw unavailable("The underlying local worker or workspace effect has not been drained.");
    let terminal: Terminal | null;
    try { terminal = this.find(attempt, binding); } catch { terminal = null; }
    if (terminal === null) {
      this.finish(attempt, { status: "RETIRED", binding });
    } else {
      this.release(this.holder(attempt, binding));
    }
  }
}
