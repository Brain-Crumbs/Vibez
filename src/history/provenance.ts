import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../local-agent-adapter/json.js";
import { readPackageJson } from "../project-assets/index.js";
import { readPackageIdentity } from "../project-assets/identity.js";
import { digest, type ResolvedProjectConfig } from "../project-config/index.js";

export const isSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const identityDigest = (value: unknown): string | null => typeof value === "string" ? digest(value) : null;
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

export interface EngineProvenance {
  readonly packageVersion: string;
  readonly manifestSha256: string;
  readonly artifactSha256: string | null;
  readonly projectIdentity: string;
  readonly configDigest: string;
  readonly policyDigest: string;
  readonly executionBinding: string;
  readonly providerDigest: string;
}

export function provenanceFor(config: ResolvedProjectConfig, executionBinding: string,
  contextPolicyDigest: string, providerId: string, artifactSha256?: string): EngineProvenance {
  if (artifactSha256 !== undefined && !isSha(artifactSha256)) throw new Error("Expected a verified artifact SHA-256.");
  return Object.freeze({
    packageVersion: readPackageIdentity().version,
    manifestSha256: readPackageJson("package.json").sha256,
    artifactSha256: artifactSha256 ?? null,
    projectIdentity: config.projectIdentity,
    configDigest: config.configDigest,
    policyDigest: digest([config.document.policy, contextPolicyDigest]),
    executionBinding,
    providerDigest: digest(providerId),
  });
}

export function parseProvenance(text: string, file: string): EngineProvenance & { readonly subject: string } {
  const value: unknown = JSON.parse(text);
  if (!object(value) || Object.keys(value).length !== 4 || value.version !== 1 ||
    !isSha(value.subject) || !isSha(value.sha256) || !object(value.engine) ||
    digest({ version: value.version, subject: value.subject, engine: value.engine }) !== value.sha256 ||
    file !== `${value.sha256}.json`) throw new Error("Invalid audit provenance receipt.");
  const engine = value.engine;
  const { packageVersion, manifestSha256, artifactSha256, projectIdentity, configDigest, policyDigest, executionBinding, providerDigest } = engine;
  if (Object.keys(engine).length !== 8 || typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(packageVersion) ||
    !isSha(manifestSha256) || (artifactSha256 !== null && !isSha(artifactSha256)) || !isSha(projectIdentity) ||
    !isSha(configDigest) || !isSha(policyDigest) || !isSha(executionBinding) || !isSha(providerDigest)) {
    throw new Error("Unsupported audit provenance receipt.");
  }
  return { subject: value.subject, packageVersion, manifestSha256, artifactSha256, projectIdentity,
    configDigest, policyDigest, executionBinding, providerDigest };
}

/** Published before evidence append. An orphan receipt cannot establish that evidence exists. */
export function recordProvenance(directory: string, payload: unknown, engine: EngineProvenance, prepare: () => void): void {
  const receipt = { version: 1, subject: digest(payload), engine };
  const sha256 = digest(receipt);
  const bytes = canonicalJson({ ...receipt, sha256 }) + "\n";
  const path = join(directory, `${sha256}.json`);
  prepare();
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error: unknown) {
      if (!object(error) || error.code !== "EEXIST" || readFileSync(path, "utf8") !== bytes) throw error;
    }
    if (process.platform !== "win32") {
      const dir = openSync(directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* Unpublished debris is flagged by preflight. */ }
  }
}
