import { readPackageJson } from "./index.js";

export function readPackageIdentity(): { name: string; version: string } {
  const { document } = readPackageJson("package.json");
  const { name, version } = document;
  if (typeof name !== "string" || !name || typeof version !== "string" || !version) {
    throw new Error("Invalid Vibez package identity. Reinstall the complete package.");
  }
  return { name, version };
}
