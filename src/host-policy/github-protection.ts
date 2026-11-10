import { HostPolicyError } from "./index.js";

export interface GitHubProtectionRequirements {
  readonly repository: string;
  readonly integrationRef: string;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly trustedCheckSources: Readonly<Record<string, number>>;
  readonly controllerAppId: number;
}

export interface GitHubProtectionObservation {
  readonly repository: string;
  readonly integrationRef: string;
  readonly observedAtMs: number;
  readonly rules: readonly unknown[];
  readonly rulesets: readonly unknown[];
  /** Actual narrowed GitHub App installation-token permissions from the trusted issuer. */
  readonly workerPermissions: readonly Readonly<Record<string, string>>[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
    value as Record<string, unknown> : undefined;
}

/**
 * Supported GitHub ruleset profile. Pass the rules applicable to the exact
 * integration branch and complete authenticated details for their rulesets,
 * including bypass actors. Missing or redacted fields fail closed.
 */
export function verifyGitHubProtection(observation: GitHubProtectionObservation, expected: GitHubProtectionRequirements): void {
  const fail = () => { throw new HostPolicyError("PROTECTION_REQUIRED"); };
  const { workerPermissions } = observation;
  const { controllerAppId, trustedCheckSources } = expected;
  if (observation.repository !== expected.repository || observation.integrationRef !== expected.integrationRef ||
    !Number.isSafeInteger(expected.nowMs) || !Number.isSafeInteger(observation.observedAtMs) ||
    !Number.isSafeInteger(expected.maxAgeMs) || expected.maxAgeMs <= 0 || expected.maxAgeMs > 30000 ||
    observation.observedAtMs < 0 || observation.observedAtMs > expected.nowMs ||
    expected.nowMs - observation.observedAtMs > expected.maxAgeMs) fail();
  if (workerPermissions.length === 0 || !Number.isSafeInteger(controllerAppId) || controllerAppId <= 0 ||
    workerPermissions.some(permissions => permissions.metadata !== "read" ||
      Object.entries(permissions).some(([scope, access]) => !["metadata", "contents", "pull_requests"].includes(scope) ||
        access !== "read"))) fail();

  const checkEntries = Object.entries(trustedCheckSources);
  if (checkEntries.length === 0 || checkEntries.some(([, id]) => !Number.isSafeInteger(id) || id <= 0)) fail();
  const rulesets = observation.rulesets.map(object);
  const rules = observation.rules.map(object);
  const noBypass = (rule: Record<string, unknown> | undefined) => {
    const ruleset = rulesets.find(candidate => candidate?.id === rule?.ruleset_id);
    return ruleset?.enforcement === "active" && Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0;
  };
  if (!rules.some(rule => rule?.type === "pull_request" && noBypass(rule))) fail();
  if (!rules.some(rule => rule?.type === "non_fast_forward" && noBypass(rule))) fail();
  if (!rules.some(rule => rule?.type === "deletion" && noBypass(rule))) fail();
  if (!rules.some(rule => {
    if (rule?.type !== "required_status_checks" || !noBypass(rule)) return false;
    const params = object(rule.parameters);
    if (!params || params.strict_required_status_checks_policy !== true ||
      !Array.isArray(params.required_status_checks)) return false;
    const checks = params.required_status_checks;
    return checkEntries.every(([name, appId]) => checks.some(
      (candidate: unknown) => object(candidate)?.context === name && object(candidate)?.integration_id === appId));
  })) fail();
  if (!rules.some(rule => {
    if (rule?.type !== "update") return false;
    const restriction = rulesets.find(candidate => candidate?.id === rule.ruleset_id);
    if (restriction?.enforcement !== "active" || !Array.isArray(restriction.bypass_actors)) return false;
    return restriction.bypass_actors.length === 1 && restriction.bypass_actors.some(actor => {
      const entry = object(actor);
      return entry?.actor_type === "Integration" && entry.actor_id === controllerAppId && entry.bypass_mode === "pull_request";
    });
  })) fail();
}
