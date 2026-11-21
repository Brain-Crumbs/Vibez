import { driverDirectory, hash } from "../workflow-driver/io.js";
import type { DriverProfile } from "../workflow-driver/model.js";

export const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
export const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/;
export const replyBytes = 4 * 1024 * 1024;

export function consoleRecordDirectory(profile: DriverProfile, projectId: string, sessionId: string) {
  return driverDirectory(profile) + "/console/" + hash({ profile: hash(profile), projectId, sessionId });
}
