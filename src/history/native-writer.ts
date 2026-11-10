import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { FileEvidenceStore } from "../evidence-store/index.js";
import { readPackageJson } from "../project-assets/index.js";
import { readPackageIdentity } from "../project-assets/identity.js";
import { checkedProjectPath, digest } from "../project-config/index.js";
import { evidenceReceiptIdentity, recordProvenance } from "./provenance.js";

export function localHistoryIdentity(root: string): string {
  const gitDir = realpathSync(join(root, ".git"));
  return digest(["unconfigured-local", process.platform === "win32" ? gitDir.toLowerCase() : gitDir]);
}

export function recordLocalProvenance(root: string, subject: string, recordSha256: string | null, provider: string): void {
  const projectRoot = realpathSync(root);
  const receipts = checkedProjectPath(projectRoot, ".agent/state/audit-provenance", "directory");
  const projectIdentity = localHistoryIdentity(projectRoot);
  const manifestSha256 = readPackageJson("package.json").sha256;
  const configDigest = digest("unconfigured-local-v1");
  const policyDigest = digest(["native-local-v1", manifestSha256]);
  const engine = { packageVersion: readPackageIdentity().version, manifestSha256, artifactSha256: null,
    projectIdentity, configDigest, policyDigest, executionBinding: digest([projectIdentity, policyDigest]),
    providerDigest: digest(provider) };
  recordProvenance(receipts, subject, recordSha256, engine, () => mkdirSync(receipts, { recursive: true }));
}

/** Default native composition. Low-level injected stores remain host-owned. */
export function createLocalEvidenceWriter(root: string) {
  return new FileEvidenceStore(join(root, ".agent", "state", "evidence"), { afterAppend: record => {
    const { subject, recordSha256 } = evidenceReceiptIdentity(record);
    recordLocalProvenance(root, subject, recordSha256, "native-direct-gate");
  } });
}
