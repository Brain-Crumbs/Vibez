import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkedProjectPath, digest } from "../project-config/index.js";
import { object } from "./provenance.js";

export interface HistoryFile {
  readonly area: string;
  readonly name: string;
  readonly sha256: string;
}
declare module "node:fs" {
  function readFileSync(path: string): Uint8Array;
}

export function optionalStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (object(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export function inventory(root: string, areas: Readonly<Record<string, string>>) {
  const files: HistoryFile[] = [];
  let entries = 0;
  function visit(area: string, name: string, path: string, depth: number): void {
    if (++entries > 100000 || depth > 32) throw new Error("Runtime inspection limit exceeded.");
    const stat = optionalStat(path);
    if (stat === null) {
      if (depth === 0) return;
      throw new Error("Runtime changed during inspection.");
    }
    if (stat.isSymbolicLink()) throw new Error("Linked runtime file.");
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        if (child.toLowerCase() === ".git") throw new Error("Nested runtime checkout.");
        visit(area, name ? `${name}/${child}` : child, join(path, child), depth + 1);
      }
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || depth === 0) throw new Error("Unexpected runtime file type.");
      const bytes = readFileSync(path);
      files.push({ area, name, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  for (const [area, relative] of Object.entries(areas).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)) {
    visit(area, "", checkedProjectPath(root, relative, "directory"), 0);
  }
  return { files, snapshotSha256: digest(files) };
}

/** Compare runtime bytes in an offline, separately secured copy against an earlier report. */
export function verifyHistoryBackup(root: string, layout: Readonly<Record<string, string>>, expected: string) {
  const first = inventory(root, layout);
  const second = inventory(root, layout);
  return { snapshotSha256: second.snapshotSha256, fileCount: second.files.length,
    matches: first.snapshotSha256 === expected && second.snapshotSha256 === expected };
}
