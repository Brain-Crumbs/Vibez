import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "../local-agent-adapter/json.js";
import type { OrchestrationRunJournal, OrchestrationRunStore } from "../orchestration-engine/index.js";
import { ConfigError, digest } from "../project-config/index.js";

export interface RetryBudgetGrant {
  readonly taskId: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly executionBinding: string;
  readonly previousMaxAttempts: number;
  readonly maxAttempts: number;
  readonly observedAttempts: Readonly<Record<string, number>>;
  readonly actor: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly authorizationRef: string;
}

export function createRetryBudget(root: string, runStore: OrchestrationRunStore, executionBinding: string, baseline: number,
  prepareWrite: () => void, authorize: ((grant: RetryBudgetGrant) => boolean) | undefined) {
  const pathFor = (key: string, previous: number) => join(root, `${digest(key)}.${previous}.json`);
  const reject = () => new ConfigError("IDENTITY_CONFLICT", "Retry budget grant is unauthorized, stale, invalid, or bound to another run.");

  function verify(grant: RetryBudgetGrant, journal: OrchestrationRunJournal, previous: number, exactAttempts: boolean): void {
    if (grant === null || typeof grant !== "object" || grant.previousMaxAttempts !== previous ||
      !Number.isInteger(grant.maxAttempts) || grant.maxAttempts <= previous || grant.maxAttempts > 10 ||
      grant.executionBinding !== executionBinding || grant.ownerId !== journal.ownerId || grant.runId !== journal.runId ||
      grant.idempotencyKey !== journal.idempotencyKey || grant.taskId !== (journal.values.start as { taskId?: string } | undefined)?.taskId ||
      typeof grant.actor !== "string" || !grant.actor.trim() || typeof grant.reason !== "string" || !grant.reason.trim() ||
      typeof grant.authorizationRef !== "string" || !grant.authorizationRef.trim() || !Number.isFinite(Date.parse(grant.occurredAt)) ||
      grant.observedAttempts === null || typeof grant.observedAttempts !== "object" ||
      Object.entries(grant.observedAttempts).some(([stage, count]) => !Number.isInteger(count) || count < 1 || count > (journal.attempts[stage] ?? 0)) ||
      (exactAttempts && canonicalJson(grant.observedAttempts) !== canonicalJson(journal.attempts)) ||
      authorize?.(grant) !== true) throw reject();
  }

  function effective(journal: OrchestrationRunJournal): number {
    let allowance = baseline;
    while (allowance < 10) {
      let bytes: string;
      try {
        bytes = readFileSync(pathFor(journal.idempotencyKey, allowance), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return allowance;
        throw error;
      }
      const { grant, sha256 } = JSON.parse(bytes) as { grant: RetryBudgetGrant; sha256: string };
      if (digest(grant) !== sha256) throw reject();
      verify(grant, journal, allowance, false);
      allowance = grant.maxAttempts;
    }
    return allowance;
  }

  async function increase(input: RetryBudgetGrant): Promise<{ sha256: string; maxAttempts: number }> {
    const grant = JSON.parse(canonicalJson(input)) as RetryBudgetGrant;
    if (grant === null || typeof grant !== "object" || typeof grant.idempotencyKey !== "string" || authorize?.(grant) !== true || runStore.get(grant.idempotencyKey) === null) throw reject();
    return runStore.withLock(async () => {
      const journal = runStore.get(grant.idempotencyKey);
      if (journal === null || journal.values.result !== undefined || journal.lastFailure?.kind !== "INFRASTRUCTURE" ||
        !["PROVIDER_ERROR", "TIMEOUT", "RETRY_EXHAUSTED"].includes(journal.lastFailure.code)) throw reject();
      const previous = effective(journal);
      verify(grant, journal, previous, true);
      if (!Object.values(journal.attempts).includes(previous)) throw reject();
      const sha256 = digest(grant);
      const target = pathFor(grant.idempotencyKey, previous);
      const temporary = `${target}.${randomUUID()}.tmp`;
      prepareWrite();
      try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, `${canonicalJson({ grant, sha256 })}\n`, { encoding: "utf8" });
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        linkSync(temporary, target);
        if (process.platform !== "win32") {
          const directory = openSync(root, "r");
          try { fsyncSync(directory); } finally { closeSync(directory); }
        }
      } finally {
        try { unlinkSync(temporary); } catch { /* Interrupted publication may retain an unpublished temp file. */ }
      }
      return { sha256, maxAttempts: grant.maxAttempts };
    });
  }

  return { effective, increase };
}
