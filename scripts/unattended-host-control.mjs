import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest, json, regular, sha256 } from "./unattended-host-io.mjs";

const commands = ["inspect", "pause", "drain", "cancel"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(new Error("The original live host did not acknowledge this bound control. Preserve its leases and control receipts."), { code });
const write = (path, value) => {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
};
function directory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path); assert.ok(stat.isDirectory() && (stat.mode & 0o077) === 0);
  return path;
}
export function readControlOwner(hostDirectory, binding) {
  const path = join(hostDirectory, "control-channel", "owner.json");
  const envelope = json(regular(path));
  assert.equal(envelope.sha256, digest(envelope.owner));
  const owner = envelope.owner;
  assert.equal(owner.schemaId, "vibez.host-control-owner"); assert.equal(owner.schemaVersion, "1.0.0");
  for (const field of ["operationId", "grantDigest", "settingsSha256", "packageSha256"]) assert.equal(owner[field], binding[field]);
  assert.equal(owner.leaseSha256, sha256(readFileSync(regular(join(hostDirectory, "ledger", "host.lease")))),
    "The channel belongs to another original policy writer.");
  return envelope;
}
/** The existing policy writer alone calls native controls and appends the command audit. */
export function ownControlChannel({ hostDirectory, binding, operations, recordCommand }) {
  const channel = directory(join(hostDirectory, "control-channel"));
  const requests = directory(join(channel, "requests")), responses = directory(join(channel, "responses")), owners = directory(join(channel, "owners"));
  const lease = join(hostDirectory, "ledger", "host.lease");
  const owner = { schemaId: "vibez.host-control-owner", schemaVersion: "1.0.0", ...binding, nonce: randomUUID(),
    pid: process.pid, startedAt: new Date().toISOString(), leaseSha256: sha256(readFileSync(regular(lease))) };
  const envelope = { owner, sha256: digest(owner) }, ownerFile = join(channel, "owner.json");
  // An abandoned pointer is evidence, never permission to replace an owner by age or PID.
  if (existsSync(ownerFile)) throw fail("WRITER_PENDING");
  write(join(owners, owner.nonce + ".json"), envelope); write(ownerFile, envelope);
  let closing = false, active = null;
  async function consume() {
    assert.equal(readControlOwner(hostDirectory, binding).sha256, envelope.sha256);
    for (const name of readdirSync(requests).sort()) {
      if (!/^[0-9]+-[a-f0-9-]{36}[.]json$/.test(name)) throw fail("UNSAFE_RECOVERY");
      const responseFile = join(responses, name);
      if (existsSync(responseFile)) continue;
      const request = json(regular(join(requests, name)));
      // Requests to an older preserved owner remain untouched; no implicit replay.
      if (request.ownerSha256 !== envelope.sha256) continue;
      let result;
      try {
        assert.equal(request.schemaId, "vibez.host-control-request"); assert.equal(request.schemaVersion, "1.0.0");
        assert.equal(request.operationId, binding.operationId); assert.equal(request.grantDigest, binding.grantDigest);
        assert.ok(commands.includes(request.command));
        assert.equal(name, request.requestId + ".json");
        const commandReceipt = recordCommand(request.command);
        const operation = await operations[request.command](binding.operationId);
        result = { acknowledged: true, operation, commandSha256: commandReceipt.sha256 };
      } catch (error) {
        result = { acknowledged: false, errorCode: ["WRITER_PENDING", "DRIVER_BUSY", "CONTROL_BUSY", "UNSAFE_RECOVERY", "STALE_BINDING"].includes(error.code)
          ? error.code : "CONTROL_REJECTED" };
      }
      write(responseFile, { schemaId: "vibez.host-control-response", schemaVersion: "1.0.0",
        ownerSha256: envelope.sha256, requestSha256: digest(request), operationId: binding.operationId,
        respondedAt: new Date().toISOString(), ...result });
    }
  }
  const interval = setInterval(() => {
    if (closing || active) return;
    active = consume().catch(() => { closing = true; clearInterval(interval); }).finally(() => { active = null; });
  }, 25);
  interval.unref();
  return {
    async close(closePolicy) {
      closing = true; clearInterval(interval); if (active) await active;
      assert.equal(readControlOwner(hostDirectory, binding).sha256, envelope.sha256);
      // A failed policy close retains the channel owner and original policy lease.
      closePolicy();
      assert.equal(json(regular(ownerFile)).sha256, envelope.sha256);
      unlinkSync(ownerFile);
    },
  };
}
/** No credentials, policy evaluator, native writer or lifecycle/effect port is constructed here. */
export function controlClient({ hostDirectory, binding, timeoutMs = 30000 }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000);
  const envelope = readControlOwner(hostDirectory, binding), channel = join(hostDirectory, "control-channel");
  let closed = false;
  const dispatch = async (command, operationId) => {
    assert.ok(!closed && commands.includes(command)); assert.equal(operationId, binding.operationId);
    assert.equal(readControlOwner(hostDirectory, binding).sha256, envelope.sha256);
    const requestId = Date.now() + "-" + randomUUID(), name = requestId + ".json";
    const request = { schemaId: "vibez.host-control-request", schemaVersion: "1.0.0", requestId,
      ownerSha256: envelope.sha256, operationId, grantDigest: binding.grantDigest, command, requestedAt: new Date().toISOString() };
    write(join(channel, "requests", name), request);
    const responseFile = join(channel, "responses", name), deadline = Date.now() + timeoutMs;
    while (!existsSync(responseFile)) {
      if (closed || Date.now() >= deadline) throw fail("CONTROL_UNACKNOWLEDGED");
      await pause(25);
    }
    const response = json(regular(responseFile));
    assert.equal(response.schemaId, "vibez.host-control-response"); assert.equal(response.schemaVersion, "1.0.0");
    assert.equal(response.ownerSha256, envelope.sha256); assert.equal(response.requestSha256, digest(request));
    assert.equal(response.operationId, operationId);
    if (!response.acknowledged) throw fail(response.errorCode);
    assert.equal(response.operation.operationId, operationId);
    // RUNNING/QUARANTINED remains exactly that until the native owner proves drain.
    return response.operation;
  };
  return { operations: Object.fromEntries(commands.map(command => [command, operationId => dispatch(command, operationId)])),
    close: async () => { closed = true; } };
}
