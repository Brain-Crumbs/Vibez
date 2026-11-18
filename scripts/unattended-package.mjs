import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => sha256(canonical(value));
const json = path => JSON.parse(readFileSync(path, "utf8"));

export function fileInventory(root) {
  const rows = [];
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const entry = join(path, name), stat = lstatSync(entry);
      assert.ok(!stat.isSymbolicLink(), "Acceptance inventory cannot follow symbolic links.");
      if (stat.isDirectory()) visit(entry);
      else {
        assert.ok(stat.isFile() && stat.nlink === 1, "Acceptance inventory requires ordinary files.");
        rows.push({ path: relative(root, entry).replaceAll("\\", "/"), sha256: sha256(readFileSync(entry)) });
      }
    }
  }
  visit(root);
  return rows;
}

export function verifyCandidate(candidateFile, installedDirectory, verificationDirectory) {
  const candidate = json(candidateFile), installed = realpathSync(installedDirectory);
  assert.equal(candidate.package, "@brain-crumbs/vibez");
  assert.match(candidate.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(candidate.file, /^[A-Za-z0-9_.-]+[.]tgz$/);
  const tarball = join(dirname(candidateFile), candidate.file), bytes = readFileSync(tarball);
  assert.equal(sha256(bytes), candidate.sha256);
  assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), candidate.integrity);
  const manifest = json(join(installed, "package.json"));
  assert.equal(manifest.name, candidate.package);
  assert.equal(manifest.version, candidate.version);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  assert.ok(entries.every(path => path.startsWith("package/") && !path.split("/").includes("..")));
  const types = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" }).trim().split("\n");
  assert.ok(types.every(line => ["-", "d"].includes(line[0])), "Packed links and special files are unsupported.");
  mkdirSync(verificationDirectory, { mode: 0o700 });
  execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", verificationDirectory]);
  const files = fileInventory(installed);
  assert.deepEqual(files, fileInventory(verificationDirectory), "Installed bytes differ from the exact candidate.");
  return { candidate, installed, manifest, installedTreeSha256: digest(files) };
}
