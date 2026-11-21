import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { driverDirectory, files, hash, object, redact, safePath, validate } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { nativeObject, originalBytes, packetId, revision, type BoundPacket } from "./artifacts.js";

export function recordedTime(value: unknown) {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return null;
  const civil = parts[1] + "T" + parts[2];
  const candidate = new Date(civil + "Z");
  if (!Number.isFinite(candidate.getTime()) || candidate.toISOString().slice(0, 19) !== civil) return null;
  const utc = new Date(value).toISOString().slice(0, 19);
  return /^\d{4}-/.test(utc) ? utc + (parts[3] ?? "") + "Z" : null;
}
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
  const packets = new Map<string, { packet: BoundPacket; recordedAt: string | null; diagnostic?: Record<string, unknown> }>();
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
    if (isPacket(snapshot.diagnosticId)) repairIds.add(snapshot.diagnosticId);
    if (isPacket(snapshot.pendingPacket)) {
      roleIds.add(snapshot.pendingPacket);
      const at = snapshot.event === "manual-handoff" ? recordedTime(observedAt) : null;
      const prior = reports.get(snapshot.pendingPacket);
      if (at && (!prior || Date.parse(at) < Date.parse(prior))) reports.set(snapshot.pendingPacket, at);
    }
  }

  const put = (packet: BoundPacket, diagnostic?: Record<string, unknown>) => packets.set(packet.ref.packetId, {
    packet, recordedAt: reports.get(packet.ref.packetId) ?? null, ...(diagnostic ? { diagnostic } : {}),
  });
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
        hash({ projectRoot, profileHash, sessionId, intakeId, revision: sha, code, message, taskContext }) !== id) continue;
    if (!object(responseTemplate)) {
      put({ ref: { packetId: id, kind: "repair", role: null, revision: revision(sha) }, relativePath: path + ".md", expected: null }, data);
      continue;
    }
    const role = isPacket(taskContext.pendingPacket) ? packets.get(taskContext.pendingPacket)?.packet : undefined;
    const handoff = role?.expected;
    const correction = responseTemplate.schemaId === "ipt.local-agent-result";
    const expected = correction ?
      handoff && responseTemplate.packetId === role!.ref.packetId && hash(responseTemplate) === hash(handoff.responseTemplate) ? data : null :
      responseTemplate.schemaId === "ipt.driver-response" && responseTemplate.packetId === id &&
      responseTemplate.projectRoot === root && responseTemplate.profileHash === profileHash &&
      responseTemplate.sessionId === sessionId && ["recheck", "rework"].includes(String(responseTemplate.action)) ? data : null;
    put({ ref: { packetId: id, kind: "repair", role: correction ? role?.ref.role ?? null : null, revision: revision(sha) },
      relativePath: path + ".md", expected, ...(correction && expected && handoff ? { originalHandoff: handoff } : {}) }, data);
  }
  for (const id of repairIds) {
    if (!packets.has(id)) put({ ref: { packetId: id, kind: "repair", role: null, revision: null },
      relativePath: profile.paths.outbound + "/" + id + ".diagnostic.json.md", expected: null });
  }
  return packets;
}
