import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { driverDirectory, files, hash, object, redact, safePath, validate } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { nativeObject, originalBytes, packetId, revision, type BoundPacket } from "./artifacts.js";

export const recordedTime = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const isPacket = (value: unknown): value is string => typeof value === "string" && packetId.test(value);
export const safeText = (value: unknown, root: string, fallback: string) => typeof value === "string" ?
  redact(value).split(root).join("[checkout]").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .trim().slice(0, 2048) || fallback : fallback;

export function recordNames(root: string, directory: string, suffix: string) {
  try { return files(safePath(root, directory), suffix); }
  catch { return []; }
}

const roleRuns: Partial<Record<BoundPacket["ref"]["role"] & string, string>> = { Developer: "developer-agent", QA: "qa-agent", Architect: "architecture-agent", "UAT/Product": "uat-agent" };

export function historicalPackets(root: string, profile: DriverProfile, session: DriverSession) {
  const packets = new Map<string, { packet: BoundPacket; recordedAt: string | null }>();
  const reports = new Map<string, string>();
  const roleIds = new Set([session.pendingPacket, session.developerPacket].filter(isPacket));
  const repairIds = new Set([session.diagnosticId].filter(isPacket));
  const reportDir = driverDirectory(profile) + "/reports/" + session.sessionId;
  for (const name of recordNames(root, reportDir, ".json")) {
    const data = nativeObject(root, reportDir + "/" + name);
    if (!data) continue;
    const { observedAt, ...snapshot } = data;
    if (snapshot.sessionId !== session.sessionId || snapshot.taskId !== session.taskId ||
        snapshot.runId !== session.request.runId || hash(snapshot) + ".json" !== name) continue;
    for (const [id, known] of [[snapshot.pendingPacket, roleIds], [snapshot.diagnosticId, repairIds]] as const) {
      if (!isPacket(id)) continue;
      known.add(id);
      const at = recordedTime(observedAt);
      if (at && (!reports.has(id) || Date.parse(at) < Date.parse(reports.get(id)!))) reports.set(id, at);
    }
  }

  const put = (packet: BoundPacket) => packets.set(packet.ref.packetId, { packet, recordedAt: reports.get(packet.ref.packetId) ?? null });
  const roleNames = recordNames(root, profile.paths.outbound, ".handoff.json")
    .map(name => name.slice(0, -".handoff.json".length)).filter(isPacket);
  for (const id of new Set([...roleIds, ...roleNames])) {
    const path = profile.paths.outbound + "/" + id + ".handoff.json";
    const data = nativeObject(root, path);
    const bound = data?.schemaId === "ipt.driver-handoff" && data.schemaVersion === "1.0.0" &&
      data.projectRoot === root && data.repository === profile.repository && data.sessionId === session.sessionId;
    if (!bound && !roleIds.has(id)) continue;
    try {
      const exchangeDir = safePath(root, profile.paths.exchange);
      safePath(root, profile.paths.exchange + "/" + id + ".packet.json");
      const packet = new FileManualAgentProvider(exchangeDir, { configuredHost: true, deferDirectory: true }).readPacket(id);
      if (!Object.hasOwn(roleRuns, packet.role) || packet.runId !== session.request.runId + "::" + roleRuns[packet.role] ||
          packet.taskId !== session.taskId || packet.actorId !== profile.roleActors[packet.role]) continue;
      const expected = bound && hash(data.packet) === hash(packet) ? data : null;
      if (!expected && !roleIds.has(id)) continue;
      put({ ref: { packetId: id, kind: "role", role: packet.role, revision: revision(packet.revisionIdentity) },
        relativePath: path + ".md", expected });
    } catch {
      if (roleIds.has(id)) put({ ref: { packetId: id, kind: "role", role: null, revision: null },
        relativePath: path + ".md", expected: null });
    }
  }
  for (const name of recordNames(root, profile.paths.outbound, ".diagnostic.json")) {
    const id = name.slice(0, -".diagnostic.json".length);
    if (!isPacket(id)) continue;
    const path = profile.paths.outbound + "/" + name;
    const data = nativeObject(root, path);
    if (!data || data.sessionId !== session.sessionId) continue;
    try { validate(root, "driver-diagnostic", data); } catch { continue; }
    const { projectRoot, profileHash, sessionId, intakeId, revision: sha, code, message, taskContext, responseTemplate } = data;
    if (data.packetId !== id || projectRoot !== root || profileHash !== session.profileHash || intakeId !== null ||
        !object(taskContext) || taskContext.taskId !== session.taskId || taskContext.issueNumber !== session.issueNumber ||
        taskContext.runId !== session.request.runId || taskContext.definitionHash !== session.definitionHash ||
        hash({ projectRoot, profileHash, sessionId, intakeId, revision: sha, code, message, taskContext }) !== id ||
        !object(responseTemplate)) continue;
    const role = isPacket(taskContext.pendingPacket) ? packets.get(taskContext.pendingPacket)?.packet : undefined;
    const handoff = role?.expected;
    const correction = responseTemplate.schemaId === "ipt.local-agent-result";
    const expected = correction ?
      handoff && responseTemplate.packetId === role!.ref.packetId && hash(responseTemplate) === hash(handoff.responseTemplate) ? data : null :
      responseTemplate.schemaId === "ipt.driver-response" && responseTemplate.packetId === id &&
      responseTemplate.projectRoot === root && responseTemplate.profileHash === profileHash &&
      responseTemplate.sessionId === sessionId && ["recheck", "rework"].includes(String(responseTemplate.action)) ? data : null;
    put({ ref: { packetId: id, kind: "repair", role: correction ? role?.ref.role ?? null : null, revision: revision(sha) },
      relativePath: path + ".md", expected, ...(correction && expected && handoff ? { originalHandoff: handoff } : {}) });
  }
  for (const id of repairIds) {
    if (!packets.has(id)) put({ ref: { packetId: id, kind: "repair", role: null, revision: null },
      relativePath: profile.paths.outbound + "/" + id + ".diagnostic.json.md", expected: null });
  }
  return packets;
}
