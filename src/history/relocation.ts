import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../local-agent-adapter/json.js";
import { digest, projectGit } from "../project-config/index.js";
import { isSha, object } from "./provenance.js";
import { optionalStat, type HistoryFile } from "./snapshot.js";

export const relocationReader = "0.1.0-rc.3";
const marker = "vibez-native-relocation";
const markerFile = "history.json";
const markerLimit = 32 * 1024 * 1024;
const revisionPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const nativeArea = /^(?:assignments\/\.history\/|audit-provenance\/|evidence\/|lifecycle\/|recovery\/)/;

export interface NativeHistoryRelocationManifest {
  readonly version: 1;
  readonly repository: string;
  readonly revision: string;
  readonly projectIdentity: string;
  readonly snapshotSha256: string;
  readonly files: readonly HistoryFile[];
}

export interface NativeHistoryRelocationRecord {
  readonly version: 1;
  readonly source: NativeHistoryRelocationManifest;
  readonly sourceManifestSha256: string;
  readonly destinationProjectIdentity: string;
  readonly destinationRevision: string;
  readonly destinationBaselineSha256: string | null;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && revisionPattern.test(value);
}

export function assertNativeRelocationFiles(files: readonly HistoryFile[]) {
  if (!files.length || files.length > 100000 ||
      !files.some(file => /^lifecycle\/[A-Z]+-[0-9]{3,}\.lifecycle\.json$/.test(file.name))) {
    throw new Error("A relocation requires a nonempty completed native history.");
  }
  const names = new Set<string>();
  for (const file of files) {
    const segments = file.name.split("/");
    if (file.area !== "state" || !nativeArea.test(file.name) || !isSha(file.sha256) ||
        segments.some(segment => !segment || segment === "." || segment === ".." ||
          /[\\:<>"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) ||
          [".git", "node_modules", ".claims"].includes(segment.toLowerCase())) ||
        /(?:\.lock(?:\.json)?|\.mutex|\.tmp)$/i.test(file.name) || names.has(file.name.toLowerCase())) {
      throw new Error("The snapshot contains unsupported or colliding native records.");
    }
    names.add(file.name.toLowerCase());
  }
}

export function nativeRelocationRepository(root: string): string {
  const repository = (direction: readonly string[]) => {
    const urls = projectGit(root, ["remote", "get-url", ...direction, "--all", "origin"]).trim().split(/\r?\n/);
    const name = urls[0]?.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)\/?$/i)?.[1]
      ?.replace(/\.git$/i, "").toLowerCase();
    if (urls.length !== 1 || name === undefined || !repositoryPattern.test(name)) throw new Error("Use a single canonical GitHub origin.");
    return name;
  };
  const origin = repository([]);
  if (repository(["--push"]) !== origin) throw new Error("The GitHub origin fetch and push targets disagree.");
  return origin;
}

export function assertRelocationCheckout(root: string) {
  const gitDir = join(root, ".git");
  const stat = lstatSync(gitDir);
  const fold = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const common = realpathSync(resolve(root, projectGit(root, ["rev-parse", "--git-common-dir"]).trim()));
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      fold(common) !== fold(realpathSync(gitDir)) ||
      projectGit(root, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter(line => line.startsWith("worktree ")).length !== 1) {
    throw new Error("Use a dedicated native Git checkout for history relocation.");
  }
}

export function readRelocationManifest(value: unknown, expectedDigest: string): NativeHistoryRelocationManifest {
  if (!object(value) || Object.keys(value).length !== 6 || value.version !== 1 ||
      typeof value.repository !== "string" || !repositoryPattern.test(value.repository) ||
      !isRevision(value.revision) || !isSha(value.projectIdentity) || !isSha(value.snapshotSha256) ||
      !Array.isArray(value.files) || value.files.length > 100000 ||
      value.files.some(file => !object(file) || Object.keys(file).length !== 3 ||
        file.area !== "state" || typeof file.name !== "string" || !isSha(file.sha256)) ||
      !isSha(expectedDigest) || digest(value) !== expectedDigest || digest(value.files) !== value.snapshotSha256) {
    throw new Error("The native relocation manifest does not match its pinned digest.");
  }
  const manifest: NativeHistoryRelocationManifest = {
    version: 1, repository: value.repository, revision: value.revision,
    projectIdentity: value.projectIdentity, snapshotSha256: value.snapshotSha256,
    files: value.files.map(file => ({ area: file.area, name: file.name, sha256: file.sha256 })),
  };
  assertNativeRelocationFiles(manifest.files);
  return manifest;
}

export function assertRelocationBinding(root: string, projectIdentity: string, record: NativeHistoryRelocationRecord) {
  assertRelocationCheckout(root);
  if (record.destinationProjectIdentity !== projectIdentity || record.source.projectIdentity === projectIdentity ||
      nativeRelocationRepository(root) !== record.source.repository) {
    throw new Error("The relocation record belongs to a different checkout.");
  }
  for (const revision of [record.source.revision, record.destinationRevision]) {
    projectGit(root, ["merge-base", "--is-ancestor", revision, "HEAD"]);
  }
}

function readMarker(root: string) {
  const directory = join(root, ".git", marker);
  const parent = optionalStat(directory);
  if (parent === null) return null;
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe native relocation directory.");
  const path = join(directory, markerFile);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > markerLimit) {
    throw new Error("Unsafe native relocation record.");
  }
  return readFileSync(path, "utf8");
}

export function openNativeRelocation(root: string, projectIdentity: string) {
  const text = readMarker(root);
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  if (!object(value) || Object.keys(value).length !== 6 || value.version !== 1 ||
      !isSha(value.sourceManifestSha256) || !isSha(value.destinationProjectIdentity) ||
      !isRevision(value.destinationRevision) ||
      (value.destinationBaselineSha256 !== null && !isSha(value.destinationBaselineSha256))) {
    throw new Error("Unsupported native relocation record.");
  }
  const record: NativeHistoryRelocationRecord = {
    version: 1,
    source: readRelocationManifest(value.source, value.sourceManifestSha256),
    sourceManifestSha256: value.sourceManifestSha256,
    destinationProjectIdentity: value.destinationProjectIdentity,
    destinationRevision: value.destinationRevision,
    destinationBaselineSha256: value.destinationBaselineSha256,
  };
  assertRelocationBinding(root, projectIdentity, record);
  return {
    record,
    assertCurrent() {
      if (readMarker(root) !== text) throw new Error("Native relocation record changed during inspection.");
      assertRelocationBinding(root, projectIdentity, record);
    },
  };
}

export function assertNoNativeRelocation(root: string) {
  if (readMarker(root) !== null) throw new Error("This checkout already has native relocation history.");
}

export function verifyRelocationInventory(source: NativeHistoryRelocationManifest,
  baseline: NativeHistoryRelocationManifest | undefined, current: readonly HistoryFile[]) {
  const expected = [...source.files, ...(baseline?.files ?? [])];
  assertNativeRelocationFiles(expected);
  const hashes = new Map(expected.map(file => [file.name, file.sha256]));
  if (expected.length !== current.length || current.some(file => file.area !== "state" || hashes.get(file.name) !== file.sha256)) {
    throw new Error("The restored bytes differ from the pinned native snapshots.");
  }
}

export function assertImportedHistory(record: NativeHistoryRelocationRecord, files: readonly HistoryFile[]) {
  const current = new Map(files.filter(file => file.area === "state").map(file => [file.name, file.sha256]));
  const imported = new Map(record.source.files.map(file => [file.name, file.sha256]));
  for (const [name, sha256] of imported) {
    if (current.get(name) !== sha256) throw new Error("An imported native history record changed or is missing.");
  }
  return imported;
}

function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function publishNativeRelocation(root: string, record: NativeHistoryRelocationRecord): void {
  const gitDir = join(root, ".git");
  const destination = join(gitDir, marker);
  const staged = join(gitDir, ".vibez-native-relocation-" + randomUUID() + ".tmp");
  const file = join(staged, markerFile);
  const text = canonicalJson(record) + "\n";
  if (new TextEncoder().encode(text).byteLength > markerLimit) throw new Error("Native relocation record exceeds its size limit.");
  mkdirSync(staged, { mode: 0o700 });
  let published = false;
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, text, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(staged);
    // A published directory is nonempty, so concurrent publication cannot replace it.
    try {
      renameSync(staged, destination);
      published = true;
    } catch (error: unknown) {
      if (readMarker(root) !== text) throw error;
    }
    syncDirectory(gitDir);
  } finally {
    if (!published) {
      if (optionalStat(file) !== null) unlinkSync(file);
      rmdirSync(staged);
    }
  }
}
