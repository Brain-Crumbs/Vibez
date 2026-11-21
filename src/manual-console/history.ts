import { relative } from "node:path";
import { readProjectAudit } from "../history/index.js";
import type { ResolvedProjectConfig } from "../project-config/index.js";
import { stableId } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { historicalPackets, recordedTime } from "./history-artifacts.js";
import { historicalGates } from "./history-gates.js";
import { historicalReceipts } from "./history-receipts.js";

export interface OrderedEvent {
  eventId: string;
  attemptId: string;
  recordedAt: string | null;
  details: object;
  after: string[];
}
const handoffEvent = (attemptId: string, id: string) => stableId({ attemptId, handoff: id });
const receiptEvent = (attemptId: string, id: string) => stableId({ attemptId, receipt: id });
const transitions: Partial<Record<string, readonly [string, string]>> = { Developer: ["developer-start", "dev-validation"], QA: ["dev-validation", "qa-review"],
  Architect: ["qa-review", "architecture-review"], "UAT/Product": ["architecture-review", "uat-review"] } as const;

function timeOf(event: OrderedEvent) {
  return event.recordedAt === null ? Infinity : Date.parse(event.recordedAt);
}
function ordered(events: OrderedEvent[]) {
  const byId = new Map(events.map(event => [event.eventId, event]));
  const visited = new Set<string>();
  const sorted: Omit<OrderedEvent, "after">[] = [];
  const visit = (event: OrderedEvent) => {
    if (visited.has(event.eventId)) return;
    visited.add(event.eventId);
    for (const dependency of event.after) {
      const earlier = byId.get(dependency);
      if (earlier) visit(earlier);
    }
    const { after: _after, ...entry } = event;
    sorted.push(entry);
  };
  for (const event of events.sort((left, right) => (timeOf(left) - timeOf(right)) ||
    (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0))) visit(event);
  return sorted;
}

export function attemptCorrespondence(config: ResolvedProjectConfig, profile: DriverProfile, sessionId: string, session: DriverSession) {
  const target = { projectId: config.projectIdentity, sessionId, attemptId: session.sessionId };
  const packets = historicalPackets(config.projectRoot, profile, session);
  return { packets, target, receipts: () => historicalReceipts(config.projectRoot, profile, session, target, packets) };
}

export async function runHistory(config: ResolvedProjectConfig, profile: DriverProfile, lineage: DriverSession[]) {
  const first = lineage[0]!;
  const root = config.projectRoot;
  const audit = await readProjectAudit({ repositoryRoot: root,
    config: { configPath: relative(root, config.configPath), verifyLocalStorage: () => { config.assertStorage(); return true; } },
  }, first.taskId).catch(() => null);
  const events: OrderedEvent[] = [];
  for (const [index, session] of lineage.entries()) {
    const attemptId = session.sessionId;
    const reworkId = index === 0 ? null : stableId({ from: session.predecessor, to: attemptId });
    const { packets, receipts } = attemptCorrespondence(config, profile, first.sessionId, session);
    const gates = historicalGates(root, profile, session, audit?.projectIdentity === config.projectIdentity ? audit : null);
    const byGateId = new Map(gates.events.map(event => [event.eventId, event]));
    const handoffs = new Map<string, OrderedEvent>();
    for (const { packet, recordedAt } of packets.values()) {
      const id = packet.ref.packetId;
      const eventId = handoffEvent(attemptId, id);
      const entry = { eventId, attemptId, recordedAt, details: { kind: "handoff", packet: packet.ref }, after: [] as string[] };
      const transition = packet.ref.kind === "role" && packet.ref.role ? transitions[packet.ref.role] : null;
      const preceding = transition && gates.stageGates.get(transition[0]);
      if (preceding) entry.after.push(preceding);
      handoffs.set(id, entry);
      events.push(entry);
    }
    for (const item of receipts()) {
      const receipt = item.receipt;
      const replyId = stableId({ attemptId, reply: receipt.receiptId });
      const eventId = receiptEvent(attemptId, receipt.receiptId);
      const expected = receipt.expectedPacketId;
      events.push({ eventId: replyId, attemptId, recordedAt: receipt.recordedAt,
        after: expected ? [handoffEvent(attemptId, expected)] : [],
        details: { kind: "reply", expectedPacketId: expected, receiptId: receipt.receiptId, replyAvailability: item.body().availability } },
      { eventId, attemptId, recordedAt: receipt.recordedAt, after: [replyId], details: { kind: "receipt", receipt } });
      const repair = receipt.repairPacketId && handoffs.get(receipt.repairPacketId);
      if (repair) repair.after.push(eventId);
      const role = expected ? packets.get(expected)?.packet.ref.role : null;
      const gate = role ? gates.stageGates.get(transitions[role]?.[1] ?? "") : null;
      const gateEvent = gate && byGateId.get(gate);
      if (gateEvent && receipt.disposition === "accepted" && packets.get(expected!)?.packet.ref.kind === "role")
        gateEvent.after.push(eventId);
    }
    const ownEvents = [...events.filter(event => event.attemptId === attemptId), ...gates.events];
    if (reworkId && session.predecessor) {
      const predecessor = session.predecessor;
      events.push({ eventId: reworkId, attemptId, recordedAt: recordedTime(session.request.occurredAt),
        after: events.filter(event => event.attemptId === predecessor).map(event => event.eventId),
        details: { kind: "rework", fromAttemptId: predecessor, toAttemptId: attemptId } });
      for (const event of ownEvents) event.after.push(reworkId);
    }
    events.push(...gates.events);
  }
  return ordered(events);
}
