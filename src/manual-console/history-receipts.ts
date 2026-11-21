import { hash, object, redact, stableId, validate } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { nativeObject, originalBytes } from "./artifacts.js";
import { isPacket, recordedTime, recordNames, safeText } from "./history-artifacts.js";
import { consoleRecordDirectory, replyBytes, requestIdPattern } from "./scope.js";

export interface Target { projectId: string; sessionId: string; attemptId: string }
type Disposition = "accepted" | "reused" | "rejected";
type Unavailable = "missing" | "redacted" | "unsupported" | "too-large";
export type ReplyBody = { availability: "available"; originalReply: string; encoding: "utf-8" } |
  { availability: "unavailable"; reason: Unavailable };

function replyBody(root: string, path: string, inputHash: string, legacy: boolean): ReplyBody {
  const bytes = originalBytes(root, path, legacy ? 6 * replyBytes + 1024 : replyBytes);
  if (typeof bytes === "string") return { availability: "unavailable", reason: bytes };
  try {
    let text: unknown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (legacy) text = (JSON.parse(text as string) as { original?: unknown }).original;
    if (typeof text !== "string") return { availability: "unavailable", reason: "unsupported" };
    if (new TextEncoder().encode(text).length > replyBytes) return { availability: "unavailable", reason: "too-large" };
    if (redact(text) !== text || /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/.test(text) ||
        (hash(text) !== inputHash && text.includes("[redacted]"))) return { availability: "unavailable", reason: "redacted" };
    return hash(text) === inputHash ? { availability: "available", originalReply: text, encoding: "utf-8" } :
      { availability: "unavailable", reason: "unsupported" };
  } catch { return { availability: "unavailable", reason: "unsupported" }; }
}

export function historicalReceipts(root: string, profile: DriverProfile, session: DriverSession, target: Target,
  packets: ReadonlyMap<string, { packet: { ref: { kind: "role" | "repair" }; expected: Record<string, unknown> | null } }>) {
  const records = [];
  function nativeReceipt(path: string) {
    const data = nativeObject(root, path + ".receipt.json");
    if (!data) return null;
    try { validate(root, "driver-receipt", data); } catch { return null; }
    const recordedAt = recordedTime(data.occurredAt);
    if (!recordedAt || !isPacket(data.inputHash) || typeof data.status !== "string" ||
        !["ACCEPTED", "REUSED", "REJECTED"].includes(data.status)) return null;
    return { data, recordedAt, inputHash: data.inputHash, disposition: data.status.toLowerCase() as Disposition };
  }
  function project(native: NonNullable<ReturnType<typeof nativeReceipt>>, receiptId: string, requestId: string | null,
    expectedPacketId: string | null, archive: string, legacy: boolean) {
    const { data, disposition, recordedAt, inputHash } = native;
    const rejected = disposition === "rejected";
    const repair = isPacket(data.diagnosticId) ? packets.get(data.diagnosticId) : undefined;
    const importedPacketId = !rejected && isPacket(data.packetId) ? data.packetId : null;
    if (!rejected && !importedPacketId) return null;
    return {
      receipt: { target, receiptId, requestId, expectedPacketId, importedPacketId, disposition, recordedAt,
        diagnostic: rejected ? { code: "REJECTED_INPUT", message: safeText(repair?.packet.expected?.message, root,
          "The reply did not match the bound handoff. Inspect the repair or retry with the current binding.") } : null,
        repairPacketId: rejected && repair?.packet.ref.kind === "repair" ? data.diagnosticId as string : null,
        nextAction: safeText(data.nextAction, root, "Inspect this run with Vibez.") },
      body: () => replyBody(root, archive + (legacy ? ".input.json" : ".input.txt"), inputHash, legacy),
    };
  }
  const consoleDir = consoleRecordDirectory(profile, target.projectId, target.sessionId);
  for (const name of recordNames(root, consoleDir, ".request.json")) {
    const requestId = name.slice(0, -".request.json".length);
    if (!requestIdPattern.test(requestId)) continue;
    const request = nativeObject(root, consoleDir + "/" + name);
    if (request?.action !== "submit-reply" || request.requestId !== requestId || !object(request.target) ||
        hash(request.target) !== hash(target) || !isPacket(request.expectedPacketId) || !isPacket(request.inputHash)) continue;
    const expected = request.expectedPacketId;
    const archive = profile.paths.archive + "/bound/" + hash({ profile: session.profileHash,
      attemptId: session.sessionId, packetId: expected, inputHash: request.inputHash });
    const native = nativeReceipt(archive);
    if (!native || native.inputHash !== request.inputHash ||
        (native.disposition !== "rejected" && native.data.packetId !== expected)) continue;
    const receiptId = stableId({ target, requestId, expected, input: request.inputHash });
    const item = project(native, receiptId, requestId, expected, archive, false);
    if (item) records.push(item);
  }
  for (const name of recordNames(root, profile.paths.archive, ".receipt.json")) {
    const id = name.slice(0, -".receipt.json".length);
    if (!isPacket(id)) continue;
    const archive = profile.paths.archive + "/" + id;
    const native = nativeReceipt(archive);
    if (!native || native.inputHash !== id) continue;
    const { packetId, diagnosticId } = native.data;
    let packet: string | null;
    if (native.disposition === "rejected") {
      // A reply's untrusted packet field alone cannot identify a CLI rejection.
      const repair = isPacket(diagnosticId) ? packets.get(diagnosticId)?.packet : undefined;
      if (repair?.ref.kind !== "repair" || !repair.expected) continue;
      const context = repair.expected.taskContext;
      packet = object(context) && isPacket(context.pendingPacket) ? context.pendingPacket : null;
    } else {
      if (!isPacket(packetId) || !packets.has(packetId)) continue;
      packet = packetId;
    }
    const item = project(native, stableId({ target, legacyInput: id }), null, packet, archive, true);
    if (item) records.push(item);
  }
  return records;
}
