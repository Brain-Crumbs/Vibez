import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, deepFreeze } from "../local-agent-adapter/json.js";
import { assertSupportedSchema, schemaErrors } from "../local-agent-adapter/schema.js";
import { readPackageJson } from "../project-assets/index.js";
import { digest } from "../project-config/index.js";

export type ScopedAction = "start" | "agent" | "validator" | "review" | "rework" | "push" | "publish" | "ready" | "merge";
export type ScopedRole = "Developer" | "QA" | "Architect" | "UAT/Product";
type Budget = { maxConcurrent: number; maxAgentTurns: number; maxCommands: number; maxCostMicros: number;
  maxRuntimeMs: number; maxReworks: number };
export interface HostGrant {
  readonly schemaId: "vibez.host-grant";
  readonly schemaVersion: "1.0.0";
  readonly grantId: string;
  readonly projectIdentity: string;
  readonly configDigest: string;
  readonly repository: string;
  readonly integrationRef: string;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly tasks: readonly { readonly taskId: string; readonly branch: string; readonly paths: readonly string[] }[];
  readonly roles: readonly { readonly role: ScopedRole; readonly principal: string; readonly provider: string;
    readonly model: string; readonly tools: readonly string[]; readonly network: "none" | "restricted" }[];
  readonly validators: readonly { readonly id: string; readonly commandDigest: string }[];
  readonly requiredChecks: readonly string[];
  readonly requiredReviews: readonly Exclude<ScopedRole, "Developer">[];
  readonly actions: readonly ScopedAction[];
  readonly humanOnly: readonly ScopedAction[];
  readonly budgets: Readonly<Budget>;
}

export type ScopeDenial = "INACTIVE_GRANT" | "HUMAN_REQUIRED" | "OUT_OF_SCOPE" | "STALE_BINDING" |
  "STALE_HEAD" | "BUDGET_EXHAUSTED" | "WRITER_PENDING" | "PROTECTION_REQUIRED" | "STORAGE_UNAVAILABLE";
export class HostPolicyError extends Error {
  constructor(readonly code: ScopeDenial) {
    super(code);
    this.name = "HostPolicyError";
  }
}

function distinct<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function portablePath(path: string): boolean {
  return path.split("/").every(part => part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
    part.toLowerCase() !== ".agent" && !part.endsWith(".") &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function parseHostGrant(input: unknown): HostGrant {
  const value: unknown = JSON.parse(canonicalJson(input));
  const { document } = readPackageJson("schemas/v1/host-grant.schema.json");
  assertSupportedSchema(document);
  if (schemaErrors(value, document).length) throw new HostPolicyError("OUT_OF_SCOPE");
  const grant = value as HostGrant;
  if (grant.expiresAtMs <= grant.notBeforeMs ||
    !distinct(grant.tasks.map(task => task.taskId)) || !distinct(grant.tasks.map(task => task.branch.toLowerCase())) ||
    !distinct(grant.roles.map(role => role.role)) || !distinct(grant.roles.map(role => role.principal.toLowerCase())) ||
    !distinct(grant.validators.map(validator => validator.id)) ||
    !grant.requiredReviews.every(role => grant.roles.some(candidate => candidate.role === role)) ||
    !grant.roles.some(role => role.role === "Developer") ||
    !portablePath(grant.integrationRef) ||
    grant.tasks.some(task => !portablePath(task.branch) || task.branch.toLowerCase() === grant.integrationRef.toLowerCase() ||
      task.paths.some(path => !portablePath(path) || /^(?:\.github|AGENTS\.md)(?:\/|$)/i.test(path)))) {
    throw new HostPolicyError("OUT_OF_SCOPE");
  }
  return deepFreeze(grant);
}

type ActionBase = { readonly taskId: string; readonly revision: string };
export type ScopedOperation = ActionBase & (
  | { readonly action: "start" | "rework" | "push" | "publish" }
  | { readonly action: "agent"; readonly role: ScopedRole; readonly principal: string;
      readonly maxTurns: number; readonly maxCostMicros: number; readonly timeoutMs: number;
      readonly provider: string; readonly tools: readonly string[]; readonly network: "none" | "restricted" | "full" }
  | { readonly action: "validator"; readonly validatorId: string; readonly commandDigest: string; readonly timeoutMs: number }
  | { readonly action: "review"; readonly role: Exclude<ScopedRole, "Developer">; readonly principal: string }
  | { readonly action: "ready" | "merge"; readonly pullRequestNumber: number }
);

export interface ScopedObservation {
  readonly projectIdentity: string;
  readonly configDigest: string;
  readonly repository: string;
  readonly integrationRef: string;
  readonly revision: string;
  readonly branch: string;
  readonly revoked: boolean;
  readonly enabled: boolean;
  readonly checks: readonly string[];
  readonly validators: readonly { readonly id: string; readonly commandDigest: string }[];
  readonly reviews: readonly string[];
  /** From the trusted integration observer, including exact head and current GitHub enforcement. */
  readonly pullRequest?: { readonly number: number; readonly revision: string; readonly head: string;
    readonly base: string; readonly open: boolean; readonly ready: boolean; readonly protectionsVerified: boolean };
}

export interface ScopedCapabilities {
  readonly signal: AbortSignal;
  readonly paths: readonly string[];
  readonly role?: HostGrant["roles"][number];
}

interface Charge { readonly turns: number; readonly commands: number; readonly cost: number; readonly ms: number; readonly reworks: number }
export interface HostDecision {
  readonly schemaVersion: "1.0.0";
  readonly grantDigest: string;
  readonly configDigest: string;
  readonly occurredAtMs: number;
  readonly decision: "allow" | "deny" | "settled";
  readonly action: ScopedAction | null;
  readonly taskId: string | null;
  readonly revision: string | null;
  readonly pullRequestNumber: number | null;
  readonly operationId: string;
  readonly role: ScopedRole | null;
  readonly principal: string | null;
  readonly validatorId: string | null;
  readonly commandDigest: string | null;
  readonly observedFactsDigest: string;
  readonly charge: Charge;
  readonly reason?: ScopeDenial;
}

const actions: readonly ScopedAction[] = ["start", "agent", "validator", "review", "rework", "push", "publish", "ready", "merge"];
const revisionPattern = /^[a-f0-9]{40}$/;
const zero: Charge = Object.freeze({ turns: 0, commands: 0, cost: 0, ms: 0, reworks: 0 });
const count = (value: number, minimum = 1) => Number.isSafeInteger(value) && value >= minimum;

export interface ScopedHostOptions {
  /** Precreated local directory per grant. Host ACLs exclude workers, worktrees, and validators. */
  readonly ledgerDirectory: string;
  readonly worktreeRoot: string;
  readonly grant: unknown;
  readonly observe: (operation: ScopedOperation) => ScopedObservation;
  /** Check host-side quiescence using the original isolation/operation identity. */
  readonly verifyDrained: (operationId: string) => boolean;
  readonly now?: () => number;
}

function below(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
}

function append(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, canonicalJson(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function read(path: string): string {
  const file = lstatSync(path);
  if (!file.isFile() || file.nlink !== 1 || file.isSymbolicLink()) throw new HostPolicyError("STORAGE_UNAVAILABLE");
  return readFileSync(path, "utf8");
}

/**
 * Trusted host boundary. The evaluator, callbacks and native gate credentials
 * must run outside the worker process, under different filesystem authority.
 */
export class ScopedHostPolicy {
  readonly grant: HostGrant;
  readonly grantDigest: string;
  readonly #root: string;
  readonly #lease: string;
  readonly #holder = randomUUID();
  readonly #now: () => number;
  readonly #observe: ScopedHostOptions["observe"];
  readonly #verifyDrained: ScopedHostOptions["verifyDrained"];
  readonly #running = new Set<string>();
  readonly #pending = new Map<string, HostDecision>();
  readonly #decisions: HostDecision[] = [];
  #sequence = 0;
  #closed = false;

  constructor(options: ScopedHostOptions) {
    this.grant = parseHostGrant(options.grant);
    this.grantDigest = digest(this.grant);
    this.#root = realpathSync(options.ledgerDirectory);
    const worktree = realpathSync(options.worktreeRoot);
    if (!lstatSync(this.#root).isDirectory() || below(worktree, this.#root) || below(this.#root, worktree)) {
      throw new HostPolicyError("STORAGE_UNAVAILABLE");
    }
    this.#lease = join(this.#root, "host.lease");
    this.#now = options.now ?? Date.now;
    this.#observe = options.observe;
    this.#verifyDrained = options.verifyDrained;
    try {
      append(this.#lease, this.#holder);
    } catch {
      throw new HostPolicyError("WRITER_PENDING");
    }
    try {
      const binding = join(this.#root, "grant.json");
      const files = readdirSync(this.#root).filter(name => name !== "host.lease");
      if (files.length === 0) append(binding, this.grantDigest);
      if (JSON.parse(read(binding)) !== this.grantDigest) throw new HostPolicyError("STALE_BINDING");
      for (const name of files.filter(name => name !== "grant.json").sort()) {
        this.#sequence += 1;
        if (name !== this.#filename()) throw new HostPolicyError("STORAGE_UNAVAILABLE");
        this.#restore(JSON.parse(read(join(this.#root, name))));
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #filename(): string {
    return "decision-" + String(this.#sequence).padStart(12, "0") + ".json";
  }

  #assertLease(): void {
    if (this.#closed || JSON.parse(read(this.#lease)) !== this.#holder) throw new HostPolicyError("STORAGE_UNAVAILABLE");
  }

  #restore(record: HostDecision): void {
    if (record.schemaVersion !== "1.0.0" || record.grantDigest !== this.grantDigest ||
      record.configDigest !== this.grant.configDigest || !count(record.occurredAtMs, 0) ||
      !["allow", "deny", "settled"].includes(record.decision) ||
      (record.action !== null && !actions.includes(record.action)) ||
      !/^[a-f0-9]{64}$/.test(record.observedFactsDigest) ||
      (record.role !== null && !this.grant.roles.some(role => role.role === record.role && role.principal === record.principal)) ||
      (record.role === null && record.principal !== null) ||
      (record.validatorId !== null && !this.grant.validators.some(validator => validator.id === record.validatorId &&
        validator.commandDigest === record.commandDigest)) ||
      !/^[a-f0-9-]{36}$/.test(record.operationId) ||
      !record.charge || Object.keys(zero).some(key => !count(record.charge[key as keyof Charge], 0))) {
      throw new HostPolicyError("STORAGE_UNAVAILABLE");
    }
    if (record.decision === "allow") {
      if (this.#pending.has(record.operationId)) throw new HostPolicyError("STORAGE_UNAVAILABLE");
      this.#pending.set(record.operationId, record);
    } else if (record.decision === "settled") {
      if (!this.#pending.delete(record.operationId)) throw new HostPolicyError("STORAGE_UNAVAILABLE");
    }
    this.#decisions.push(deepFreeze(record));
  }

  #record(record: HostDecision): void {
    this.#assertLease();
    this.#sequence += 1;
    append(join(this.#root, this.#filename()), record);
    this.#restore(record);
  }

  decisions(): readonly HostDecision[] {
    return Object.freeze([...this.#decisions]);
  }

  close(): void {
    if (this.#closed) return;
    if (this.#running.size) throw new HostPolicyError("WRITER_PENDING");
    this.#assertLease();
    unlinkSync(this.#lease);
    this.#closed = true;
  }

  /** Called by the trusted host after a failed launch or lost response. Never erases charges. */
  reconcileDrained(operationId: string): void {
    const pending = this.#pending.get(operationId);
    if (!pending || this.#running.has(operationId) || !this.#verifyDrained(operationId)) {
      throw new HostPolicyError("WRITER_PENDING");
    }
    this.#record({ ...pending, occurredAtMs: this.#now(), decision: "settled", charge: zero });
  }

  #denial(operation: ScopedOperation, observation: ScopedObservation, now: number): ScopeDenial | undefined {
    const { grant } = this;
    if (!observation.enabled || observation.revoked || !count(now, 0) ||
      now < grant.notBeforeMs || now >= grant.expiresAtMs) return "INACTIVE_GRANT";
    if (observation.repository !== grant.repository || observation.projectIdentity !== grant.projectIdentity ||
      observation.configDigest !== grant.configDigest || observation.integrationRef !== grant.integrationRef ||
      !grant.requiredChecks.every(check => observation.checks.includes(check)) ||
      !grant.requiredReviews.every(role => observation.reviews.includes(role)) ||
      !grant.validators.every(validator => observation.validators.some(candidate => candidate.id === validator.id &&
        candidate.commandDigest === validator.commandDigest))) return "STALE_BINDING";
    const task = grant.tasks.find(candidate => candidate.taskId === operation.taskId);
    if (!grant.actions.includes(operation.action) || !task || task.branch !== observation.branch) return "OUT_OF_SCOPE";
    if (grant.humanOnly.includes(operation.action)) return "HUMAN_REQUIRED";
    if (!revisionPattern.test(operation.revision) || observation.revision !== operation.revision) return "STALE_HEAD";
    if (operation.action === "agent" || operation.action === "review") {
      const role = grant.roles.find(role => role.role === operation.role && role.principal === operation.principal);
      if (!role || (operation.action === "review" && role.role === "Developer")) return "OUT_OF_SCOPE";
      if (operation.action === "agent" && (operation.provider !== role.provider ||
        !Array.isArray(operation.tools) || operation.tools.some(tool => !role.tools.includes(tool)) ||
        !["none", "restricted"].includes(operation.network) ||
        (role.network === "none" && operation.network !== "none"))) return "OUT_OF_SCOPE";
    }
    if (operation.action === "validator" && !grant.validators.some(validator => validator.id === operation.validatorId &&
      validator.commandDigest === operation.commandDigest)) return "OUT_OF_SCOPE";
    if (operation.action === "ready" || operation.action === "merge") {
      const pr = observation.pullRequest;
      if (!pr || !count(operation.pullRequestNumber) || pr.number !== operation.pullRequestNumber ||
        pr.revision !== operation.revision || pr.head !== task.branch || pr.base !== grant.integrationRef || !pr.open) return "STALE_HEAD";
      if (!pr.protectionsVerified || (operation.action === "merge" && !pr.ready)) return "PROTECTION_REQUIRED";
    }
    return undefined;
  }

  async execute<T>(operationInput: ScopedOperation, effect: (capabilities: ScopedCapabilities) => Promise<T>): Promise<T> {
    this.#assertLease();
    const operation = Object.freeze({ ...operationInput });
    const now = this.#now();
    const observation = this.#observe(operation);
    const task = this.grant.tasks.find(candidate => candidate.taskId === operation.taskId);
    const metered = operation.action === "agent" || operation.action === "validator";
    const charge: Charge = {
      turns: operation.action === "agent" ? operation.maxTurns : 0,
      cost: operation.action === "agent" ? operation.maxCostMicros : 0,
      ms: metered ? operation.timeoutMs : 0,
      commands: operation.action === "validator" ? 1 : 0,
      reworks: operation.action === "rework" ? 1 : 0,
    };
    let reason = this.#denial(operation, observation, now);
    if (!reason && ([...this.#pending.values()].some(record => record.taskId === operation.taskId) ||
      this.#pending.size >= this.grant.budgets.maxConcurrent)) reason = "WRITER_PENDING";
    const totals = { ...zero };
    for (const previous of this.#decisions) if (previous.decision === "allow") {
      for (const key of Object.keys(zero) as (keyof Charge)[]) totals[key] += previous.charge[key];
    }
    const { maxAgentTurns, maxCostMicros, maxCommands, maxRuntimeMs, maxReworks } = this.grant.budgets;
    if (!reason && ((!count(charge.turns, operation.action === "agent" ? 1 : 0)) || !count(charge.cost, 0) ||
      !count(charge.ms, metered ? 1 : 0) || charge.ms > 2_147_483_647 ||
      charge.ms > this.grant.expiresAtMs - now ||
      totals.turns + charge.turns > maxAgentTurns || totals.cost + charge.cost > maxCostMicros ||
      totals.commands + charge.commands > maxCommands || totals.ms + charge.ms > maxRuntimeMs ||
      totals.reworks + charge.reworks > maxReworks)) reason = "BUDGET_EXHAUSTED";
    const approvedRole = (operation.action === "agent" || operation.action === "review") ?
      this.grant.roles.find(role => role.role === operation.role && role.principal === operation.principal) : undefined;
    const approvedValidator = operation.action === "validator" ?
      this.grant.validators.find(validator => validator.id === operation.validatorId && validator.commandDigest === operation.commandDigest) : undefined;
    const record: HostDecision = {
      schemaVersion: "1.0.0", grantDigest: this.grantDigest, configDigest: this.grant.configDigest, occurredAtMs: now,
      decision: reason ? "deny" : "allow", action: actions.includes(operation.action) ? operation.action : null, taskId: task?.taskId ?? null,
      revision: revisionPattern.test(operation.revision) ? operation.revision : null,
      pullRequestNumber: (operation.action === "merge" || operation.action === "ready") && count(operation.pullRequestNumber) ?
        operation.pullRequestNumber : null, operationId: randomUUID(),
      role: approvedRole?.role ?? null, principal: approvedRole?.principal ?? null,
      validatorId: approvedValidator?.id ?? null, commandDigest: approvedValidator?.commandDigest ?? null,
      observedFactsDigest: digest(JSON.parse(JSON.stringify(observation))), charge: reason ? zero : charge,
      ...(reason ? { reason } : {}),
    };
    this.#record(record);
    if (reason) throw new HostPolicyError(reason);

    const controller = new AbortController();
    this.#running.add(record.operationId);
    const abort = (reason: ScopeDenial) => {
      if (controller.signal.aborted) return;
      try {
        this.#record({ ...record, decision: "deny", occurredAtMs: this.#now(), charge: zero, reason });
      } finally {
        controller.abort(new HostPolicyError(reason));
      }
    };
    const check = () => {
      try {
        this.#assertLease();
        const denial = this.#denial(operation, this.#observe(operation), this.#now());
        if (denial) abort(denial);
      } catch {
        abort("STORAGE_UNAVAILABLE");
      }
    };
    const deadline = metered ? Math.min(charge.ms, this.grant.expiresAtMs - now) : this.grant.expiresAtMs - now;
    const timer = setTimeout(() => abort("INACTIVE_GRANT"), Math.min(deadline, 2_147_483_647));
    const poll = setInterval(check, 100);
    try {
      check();
      controller.signal.throwIfAborted();
      const role = operation.action === "agent" || operation.action === "review" ?
        this.grant.roles.find(candidate => candidate.role === operation.role) : undefined;
      const result = await effect(Object.freeze({ signal: controller.signal, paths: task!.paths, ...(role ? { role } : {}) }));
      // A trusted adapter returns only after the operation is drained. A lost
      // response or thrown adapter leaves an unresolved reservation for recovery.
      this.#record({ ...record, occurredAtMs: this.#now(), decision: "settled", charge: zero });
      controller.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      this.#running.delete(record.operationId);
    }
  }
}
