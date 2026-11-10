import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
const npm = process.env.npm_execpath;
if (!output || process.argv.length !== 3 || !npm) {
  throw new Error("Usage: npm run pack:candidate -- <new-output-directory>");
}
const destination = resolve(output);
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const sourceCommit = run("git", ["rev-parse", "HEAD"]);
if (run("git", ["status", "--porcelain"]) !== "") {
  throw new Error("Commit all source changes and use a clean checkout to build a Vibez candidate.");
}
const staging = mkdtempSync(join(tmpdir(), "vibez-candidate-"));
try {
  const archive = join(staging, "source.tar");
  const snapshot = join(staging, "source");
  mkdirSync(snapshot);
  run("git", ["archive", "--format=tar", "--output", archive, sourceCommit]);
  run("tar", ["-xf", archive, "-C", snapshot]);
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: snapshot, stdio: "inherit" });
  const [artifact] = JSON.parse(run(process.execPath,
    [npm, "--cache", join(staging, "npm-cache"), "pack", "--ignore-scripts", "--json", "--pack-destination", staging], snapshot));
  const manifest = JSON.parse(readFileSync(join(snapshot, "package.json"), "utf8"));
  if (manifest.private !== true || artifact.name !== manifest.name || artifact.version !== manifest.version) {
    throw new Error("Vibez candidate identity does not match the private source manifest.");
  }
  const tarball = join(staging, artifact.filename);
  const bytes = readFileSync(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  if (artifact.integrity !== integrity) throw new Error("npm pack reported a different tarball integrity.");
  const receipt = {
    package: artifact.name,
    version: artifact.version,
    file: artifact.filename,
    sourceCommit,
    sha256,
    integrity,
    node: process.version,
    npm: run(process.execPath, [npm, "--version"]),
  };
  // Reserve a new directory only after the build has succeeded.
  mkdirSync(destination);
  copyFileSync(tarball, join(destination, receipt.file));
  writeFileSync(join(destination, "candidate.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
