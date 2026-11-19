/**
 * Finite-run adapter for an administrator-issued credential bundle.
 * Copy this module to the private host directory beside credentials.json, then
 * pin this module in prepare options. It never issues or refreshes a token.
 */
import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function issue(role) {
  assert.ok(["publisher", "controller", "worker"].includes(role), "Unknown credential role.");
  const directory = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const path = join(directory, "credentials.json"), stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && realpathSync(path) === path,
    "Credential bundle must be an ordinary private file.");
  assert.equal(stat.mode & 0o077, 0, "Credential bundle must be readable only by its owner.");
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(bundle.schemaId, "vibez.private-credential-bundle");
  assert.equal(bundle.schemaVersion, "1.0.0");
  const credential = bundle.credentials?.[role];
  assert.ok(credential && typeof credential.token === "string", "Missing administrator-issued credential.");
  assert.ok(Number.isFinite(Date.parse(credential.expiresAt)) && Date.parse(credential.expiresAt) > Date.now() + 30000,
    "Credential is expired or too close to expiry.");
  // The host additionally enforces repository, principal, App IDs, narrowed
  // permissions, distinct tokens, and live protection before effects.
  return structuredClone(credential);
}
