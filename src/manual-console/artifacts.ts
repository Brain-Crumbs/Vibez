import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { type AgentRunnerRole } from "../agent-provider/index.js";
import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { driverDirectory, hash, object, read, safePath, validate } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";

const packetId = /^[a-f0-9]{64}$/;
export const revision = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value) ? value : null;

export interface PacketRef {
  packetId: string;
  kind: "role" | "repair";
  role: AgentRunnerRole | null;
  revision: string | null;
}
export interface BoundPacket {
  ref: PacketRef;
  relativePath: string;
  expected: Record<string, unknown> | null;
  originalHandoff?: Record<string, unknown>;
}
type Unavailable = "missing" | "redacted" | "unsupported" | "too-large";
const unavailable = (reason: Unavailable) => ({ availability: "unavailable" as const, reason });

export function nativeObject(root: string, path: string): Record<string, unknown> | null {
  try {
    const value = read(safePath(root, path));
    return object(value) ? value : null;
  } catch { return null; }
}

export function pendingPackets(root: string, profile: DriverProfile, session: DriverSession) {
  let role: BoundPacket | null = null;
  let repair: BoundPacket | null = null;
  let replyToPacketId: string | null = null;
  let diagnostic: Record<string, unknown> | null = null;
  const pending = session.pendingPacket;
  if (pending && packetId.test(pending)) {
    try {
      const exchange = new FileManualAgentProvider(safePath(root, profile.paths.exchange), { configuredHost: true, deferDirectory: true });
      safePath(root, `${profile.paths.exchange}/${pending}.packet.json`);
      safePath(root, `${profile.paths.exchange}/${pending}.result.json`);
      const { packet, result } = exchange.readExchange(pending);
      const fence = nativeObject(root, `${driverDirectory(profile)}/accepted/${pending}.json`);
      const expectedRun = packet.role === "Developer" ? "developer-agent" : packet.role === "QA" ? "qa-agent" :
        packet.role === "Architect" ? "architecture-agent" : packet.role === "UAT/Product" ? "uat-agent" : null;
      if (!result && !fence && expectedRun && packet.runId === `${session.request.runId}::${expectedRun}` &&
          packet.taskId === session.taskId && packet.actorId === profile.roleActors[packet.role] && revision(packet.revisionIdentity)) {
        const path = `${profile.paths.outbound}/${pending}.handoff.json`;
        const data = nativeObject(root, path);
        role = {
          ref: { kind: "role", packetId: pending, role: packet.role, revision: packet.revisionIdentity },
          relativePath: `${path}.md`,
          expected: data?.schemaId === "ipt.driver-handoff" && data.schemaVersion === "1.0.0" &&
            data.projectRoot === root && data.repository === profile.repository &&
            data.sessionId === session.sessionId && hash(data.packet) === hash(packet) ? data : null,
        };
      }
    } catch { /* Partial or unsafe evidence never proves a pending role. */ }
  }
  const repairId = session.diagnosticId;
  if (repairId && packetId.test(repairId)) {
    const path = `${profile.paths.outbound}/${repairId}.diagnostic.json`;
    try {
      const data = nativeObject(root, path);
      if (data) {
        validate(root, "driver-diagnostic", data);
        const { projectRoot, profileHash, sessionId, intakeId, revision: boundRevision, code, message, taskContext } = data;
        if (data.packetId === repairId && projectRoot === root && sessionId === session.sessionId &&
            profileHash === session.profileHash && intakeId === null && object(taskContext) &&
            taskContext.taskId === session.taskId && taskContext.issueNumber === session.issueNumber &&
            taskContext.runId === session.request.runId && taskContext.definitionHash === session.definitionHash &&
            hash({ projectRoot, profileHash, sessionId, intakeId, revision: boundRevision, code, message, taskContext }) === repairId) {
          diagnostic = data;
          const template = data.responseTemplate;
          if (object(template)) {
            const corrected = template.schemaId === "ipt.local-agent-result" &&
              role !== null && role.ref.packetId === template.packetId && role.expected !== null &&
              hash(role.expected.responseTemplate) === hash(template);
            const driverReply = template.schemaId === "ipt.driver-response" && template.packetId === repairId &&
              template.projectRoot === root && template.profileHash === session.profileHash &&
              template.sessionId === session.sessionId && (template.action === "recheck" || template.action === "rework");
            if (corrected || driverReply) {
              repair = { ref: { kind: "repair", packetId: repairId, role: corrected ? role!.ref.role : null,
                revision: revision(boundRevision) }, relativePath: `${path}.md`, expected: data,
                ...(corrected ? { originalHandoff: role!.expected! } : {}) };
              replyToPacketId = corrected ? role!.ref.packetId : repairId;
            }
          }
        }
      }
    } catch { /* Malformed historical diagnostics provide no bound correspondence. */ }
  }
  return { role, repair, replyToPacketId, diagnostic };
}

function originalBytes(root: string, path: string): Uint8Array | Unavailable {
  const limit = 8 * 1024 * 1024;
  type Identity = ReturnType<typeof fstatSync>;
  let fd: number | undefined;
  try {
    const file = safePath(root, path);
    const attributes = lstatSync(file) as ReturnType<typeof lstatSync> & Identity;
    if (!attributes.isFile() || attributes.isSymbolicLink()) return "unsupported";
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== attributes.ino || opened.dev !== attributes.dev) return "unsupported";
    if (opened.size > limit) return "too-large";
    const bytes = new Uint8Array(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const current = lstatSync(safePath(root, path)) as ReturnType<typeof lstatSync> & Identity;
    if (current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== opened.mtimeMs ||
        current.size !== opened.size || length !== opened.size) return length > limit ? "too-large" : "unsupported";
    return bytes.subarray(0, length);
  } catch (error) {
    return object(error) && error.code === "ENOENT" ? "missing" : "unsupported";
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readOriginal(root: string, packet: BoundPacket) {
  const bytes = originalBytes(root, packet.relativePath);
  if (typeof bytes === "string") return unavailable(bytes);
  if (packet.expected === null) return unavailable("unsupported");
  try {
    const originalMarkdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const fenced = /(?:^|\r?\n)\x60\x60\x60json\r?\n([\s\S]+)\r?\n\x60\x60\x60[ \t]*(?:\r?\n[ \t]*)*$/.exec(originalMarkdown);
    if (!fenced) return unavailable("unsupported");
    // A diagnostic narrative may include fences; use the last opening fence before the final close.
    const actual = JSON.parse(fenced[1]!.split(/\r?\n\x60\x60\x60json\r?\n/).at(-1)!) as unknown;
    if (!object(actual)) return unavailable("unsupported");
    if (packet.ref.kind === "repair") {
      const { originalHandoff, ...repair } = actual;
      if (hash(repair) !== hash(packet.expected) ||
          (packet.originalHandoff ? !object(originalHandoff) || hash(originalHandoff) !== hash(packet.originalHandoff) :
            originalHandoff !== undefined)) return unavailable("unsupported");
    } else if (hash(actual) !== hash(packet.expected)) return unavailable("unsupported");
    return { availability: "available" as const, originalMarkdown, encoding: "utf-8",
      sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return unavailable("unsupported"); }
}
