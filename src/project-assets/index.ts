import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export function packageSchemaPath(name: string): string {
  if (!/^[a-z0-9-]+\.schema\.json$/.test(name)) throw new Error("Invalid package schema name.");
  return join(packageRoot, "schemas", "v1", name);
}

export function readPackageJson(path: string): { document: Record<string, unknown>; sha256: string } {
  if (!/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.json$/.test(path) ||
    path.split("/").some(segment => segment === "." || segment === "..")) throw new Error("Invalid package asset path.");
  let content: string;
  try {
    content = readFileSync(join(packageRoot, path), "utf8");
  } catch {
    throw new Error(`Missing Vibez package asset '${path}'. Reinstall the complete package.`);
  }
  const document: unknown = JSON.parse(content);
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Vibez package asset '${path}' must be a JSON object.`);
  }
  return { document: document as Record<string, unknown>, sha256: createHash("sha256").update(content).digest("hex") };
}

export function getAssetCatalog() {
  const schemas = readdirSync(join(packageRoot, "schemas/v1")).filter(name => name.endsWith(".schema.json")).sort()
    .map(name => {
      const path = `schemas/v1/${name}`;
      const asset = readPackageJson(path);
      return Object.freeze({ id: String(asset.document.$id), path, sha256: asset.sha256 });
    });
  const contracts = readdirSync(join(packageRoot, "contracts"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "examples").map(entry => entry.name).sort()
    .map(name => {
      const path = `contracts/${name}/module-contract.json`;
      const asset = readPackageJson(path);
      return Object.freeze({ id: String(asset.document.moduleId), version: String(asset.document.moduleVersion), path, sha256: asset.sha256 });
    });
  const config = readPackageJson("docs/specs/project-config.schema.json");
  return Object.freeze({ schemas: Object.freeze(schemas), contracts: Object.freeze(contracts), configSchemaSha256: config.sha256 });
}

export function readSchema(id: string) {
  const asset = getAssetCatalog().schemas.find(entry => entry.id === id);
  if (asset === undefined) throw new Error(`Unsupported package schema '${id}'.`);
  return readPackageJson(asset.path);
}

export function readContract(id: string) {
  const asset = getAssetCatalog().contracts.find(entry => entry.id === id);
  if (asset === undefined) throw new Error(`Unsupported package contract '${id}'.`);
  return readPackageJson(asset.path);
}
