import { existsSync, readFileSync } from "node:fs";
import { driverDirectory, hash, safePath } from "../workflow-driver/io.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";
import { nativeObject, revision } from "./artifacts.js";

const unknown = { state: "unknown" } as const;

function utc(input: unknown) {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) return null;
  const value = new Date(input).toISOString();
  return /^\d{4}-/.test(value) ? value : null;
}

interface MergeObservation {
  recordedAt: string;
  revisionIdentity: string;
  pullRequestNumber: number;
}

export function integrationObservations(root: string, profile: DriverProfile, session: DriverSession, merged: MergeObservation | null) {
  const pullUrl = (number: number) => `https://github.com/${profile.repository}/pull/${number}`;
  function read(kind: "pull-request" | "ci") {
    const stored = nativeObject(root, `${driverDirectory(profile)}/reports/${session.sessionId}/integration/${kind}.json`);
    if (!stored || stored.kind !== kind || stored.repository !== profile.repository || stored.profileHash !== session.profileHash ||
        stored.sessionId !== session.sessionId || stored.taskId !== session.taskId || stored.runId !== session.request.runId) return null;
    const observedAt = utc(stored.observedAt);
    const sha = revision(stored.revision);
    return observedAt && sha ? { state: "observed" as const, observedAt, revision: sha, number: stored.number, status: stored.status } : null;
  }

  const rawPr = read("pull-request");
  const mergedAt = utc(merged?.recordedAt);
  const pullRequest = merged && mergedAt ?
    { state: "observed", status: "merged", observedAt: mergedAt, revision: merged.revisionIdentity, url: pullUrl(merged.pullRequestNumber) } :
    rawPr && typeof rawPr.number === "number" && Number.isSafeInteger(rawPr.number) && rawPr.number > 0 &&
      (rawPr.status === "draft" || rawPr.status === "open") ?
      { state: rawPr.state, status: rawPr.status, observedAt: rawPr.observedAt, revision: rawPr.revision, url: pullUrl(rawPr.number) } : unknown;
  const rawCi = read("ci");
  const ci = rawCi && typeof rawCi.status === "string" && ["pending", "pass", "fail", "blocked"].includes(rawCi.status) ?
    { state: rawCi.state, status: rawCi.status, observedAt: rawCi.observedAt, revision: rawCi.revision, url: null } : unknown;
  return { pullRequest, ci };
}

export function validationIsActive(root: string, profile: DriverProfile, session: DriverSession) {
  const directory = driverDirectory(profile);
  const marker = nativeObject(root, `${directory}/reports/${session.sessionId}/integration/validation-heartbeat.json`);
  const time = Date.now();
  if (!marker || marker.sessionId !== session.sessionId || marker.taskId !== session.taskId ||
      marker.profileHash !== session.profileHash || marker.runId !== session.request.runId ||
      typeof marker.expiresMs !== "number" || marker.expiresMs <= time || marker.expiresMs > time + 4000) return false;
  try {
    if (existsSync(safePath(root, `${directory}/writer-recovery.lock`))) return false;
    return hash(readFileSync(safePath(root, `${directory}/writer.lock`), "utf8")) === marker.lockHash;
  } catch { return false; }
}
