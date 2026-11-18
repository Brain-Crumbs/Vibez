import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => sha256(canonical(value));
export const json = path => JSON.parse(readFileSync(path, "utf8"));
export const safeEnvironment = () => ({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
export function below(root, path) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
}
export function regular(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Expected an ordinary, unlinked file.");
  assert.equal(realpathSync(path), path, "Trusted paths must be canonical and contain no symbolic links.");
  return path;
}
export function pinnedFile(pin) {
  assert.ok(pin && isAbsolute(pin.path));
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  regular(pin.path);
  assert.equal(sha256(readFileSync(pin.path)), pin.sha256, "A pinned host input changed.");
  return pin.path;
}
export function validateSettings(s) {
  assert.equal(s.schemaId, "vibez.unattended-host");
  assert.equal(s.schemaVersion, "1.0.0");
  assert.match(s.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(s.integrationRef, /^acceptance\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.match(s.seedRevision, /^[a-f0-9]{40}$/);
  assert.match(s.operationId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isSafeInteger(s.controllerAppId) && s.controllerAppId > 0);
  assert.ok(Array.isArray(s.requiredChecks) && s.requiredChecks.length > 0);
  assert.equal(new Set(s.requiredChecks.map(c => c.name)).size, s.requiredChecks.length);
  for (const check of s.requiredChecks) {
    assert.ok(typeof check.name === "string" && check.name.length > 0);
    assert.ok(Number.isSafeInteger(check.appId) && check.appId > 0);
  }
  for (const field of ["projectRoot", "installedDirectory", "candidateFile", "hostDirectory", "controlsFile"])
    assert.ok(isAbsolute(s[field]), "Host paths must be absolute.");
  for (const pin of [s.assets, s.grant, s.plan, s.tokenIssuer]) {
    assert.ok(pin && isAbsolute(pin.path));
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  }
  return s;
}
export function validateCredential(credential, role, repository, controllerAppId, nowMs = Date.now()) {
  assert.ok(credential && typeof credential.token === "string" && credential.token.length > 10);
  assert.equal(credential.repository, repository);
  assert.ok(Number.isFinite(Date.parse(credential.expiresAt)) && Date.parse(credential.expiresAt) > nowMs + 30000,
    "Credential is expired or too close to expiry; refresh the original host and resume.");
  assert.ok(credential.permissions && typeof credential.permissions === "object");
  if (role === "controller") {
    assert.equal(credential.appId, controllerAppId);
    assert.equal(credential.permissions.contents, "write");
    assert.equal(credential.permissions.pull_requests, "write");
    assert.ok(Object.entries(credential.permissions).every(([k, v]) =>
      ["metadata", "contents", "pull_requests"].includes(k) && v === (k === "metadata" ? "read" : "write")));
  } else if (role === "worker") {
    assert.ok(Number.isSafeInteger(credential.appId) && credential.appId !== controllerAppId);
    assert.equal(credential.permissions.metadata, "read");
    assert.ok(Object.entries(credential.permissions).every(([k, v]) =>
      ["metadata", "contents", "pull_requests"].includes(k) && v === "read"));
  } else {
    assert.equal(role, "publisher");
    assert.notEqual(credential.appId, controllerAppId);
    assert.ok(typeof credential.principal === "string" && credential.principal.length > 0);
    assert.equal(credential.permissions.contents, "write");
    assert.equal(credential.permissions.pull_requests, "write");
  }
  return credential;
}
export function git(root, args, { token, input, env = {}, raw = false } = {}) {
  const environment = { ...safeEnvironment(), ...env };
  if (token) Object.assign(environment, { GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64"),
    GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "" });
  try {
    const output = execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
      { cwd: root, env: environment, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return raw ? output : output.trim();
  } catch {
    const error = new Error("The bounded Git operation failed. Inspect the original repository without replaying uncertain effects.");
    error.code = "GIT_FAILED"; throw error;
  }
}
export function githubObservation(request) {
  try {
    return JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "github-observe"],
      { input: JSON.stringify(request), encoding: "utf8", env: safeEnvironment(), timeout: 60000,
        maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));
  } catch { const error = new Error("Fresh GitHub protection/source observation is unavailable."); error.code = "PROTECTION_REQUIRED"; throw error; }
}
async function observe(input) {
  assert.match(input.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(input.integrationRef, /^acceptance\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const prefix = "https://api.github.com/repos/" + input.repository;
  const get = async suffix => {
    const response = await fetch(prefix + suffix, { redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + input.token, "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) throw Error("GitHub observation failed.");
    return response.json();
  };
  const rules = [];
  for (let page = 1; page <= 20; page++) {
    const result = await get("/rules/branches/" + encodeURIComponent(input.integrationRef) + "?per_page=100&page=" + page);
    assert.ok(Array.isArray(result));
    rules.push(...result);
    if (result.length < 100) break;
    assert.ok(page < 20, "Unbounded branch rules.");
  }
  const ids = [...new Set(rules.map(rule => rule.ruleset_id))];
  assert.ok(ids.length > 0 && ids.every(Number.isSafeInteger));
  const rulesets = await Promise.all(ids.map(id => get("/rulesets/" + id)));
  let pullRequest;
  if (input.pullRequestNumber !== undefined) {
    assert.ok(Number.isSafeInteger(input.pullRequestNumber) && input.pullRequestNumber > 0);
    pullRequest = await get("/pulls/" + input.pullRequestNumber);
  }
  const branch = await get("/git/ref/heads/" + encodeURIComponent(input.integrationRef));
  return { repository: input.repository, integrationRef: input.integrationRef, observedAtMs: Date.now(),
    rules, rulesets, branch, ...(pullRequest ? { pullRequest } : {}) };
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "github-observe") {
  try {
    let input = ""; for await (const chunk of process.stdin) { input += chunk; assert.ok(input.length <= 128000); }
    process.stdout.write(JSON.stringify(await observe(JSON.parse(input))));
  } catch { process.stderr.write("GITHUB_OBSERVATION_UNAVAILABLE\n"); process.exitCode = 2; }
}
