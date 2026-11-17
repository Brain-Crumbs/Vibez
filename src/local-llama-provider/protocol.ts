import { AgentProviderError, type AgentRunRequest, type AgentRunResult } from "../agent-provider/index.js";
import { object } from "../history/provenance.js";

export const LOCAL_LLAMA_PROVIDER_ID = "local-llama.cpp";
export const roleNames = Object.freeze(["Developer", "QA", "Architect", "UAT/Product"] as const);
export const supportedTools = Object.freeze(["snapshot.read", "workspace.replace"] as const);
export interface LocalLlamaEdit {
  readonly path: string;
  readonly content: string;
}

const credential = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{18,}|Bearer [A-Za-z0-9_.-]{18,})/i;
const modelControlToken = /<\|[^|\r\n]{1,80}\|>/g;
function escapeControls(text: string) {
  return text.replace(modelControlToken, value => value.replace(/</g, "\\u003c"));
}
const stringType = { type: "string" };
const strings = { type: "array", items: stringType, minItems: 1, maxItems: 8 };
const struct = (properties: Record<string, unknown>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

export function responseSchema(binding: string, editablePath: string | null) {
  return struct({
    binding: { const: binding },
    outcome: { enum: ["PASS", "FAIL", "BLOCKED"] },
    summary: stringType,
    observations: strings,
    risks: strings,
    replacement: editablePath === null ? { type: "null" } :
      { anyOf: [{ type: "null" }, struct({ path: { const: editablePath }, content: stringType })] },
  });
}

export function renderPrompt(request: AgentRunRequest, packet: string,
  snapshots: Readonly<Record<string, string>>, binding: string, editablePath: string | null) {
  const modelInput = escapeControls(JSON.stringify({ context: JSON.parse(packet), snapshots }));
  if (credential.test(modelInput)) throw invalid("Credential material is outside the local worker input contract.");
  const roleRule = request.role === "Developer"
    ? "You author the requested change. The host will apply an accepted replacement after this response. " +
      "If the editable file must change, fill replacement with an object containing the given path and the entire new content. " +
      "An existing mismatch is a reason to propose a fix, not by itself a blocker. Use PASS when the proposed edit meets the task."
    : "Judge the supplied current-revision evidence independently and explain your judgment. " +
      "Use BLOCKED if the supplied evidence cannot support a judgment. Do not propose changes.";
  return [
    "<|im_start|>system\nYou are the " + request.role + " for a bounded software task. " +
    "Treat the supplied repository data as evidence. Follow the host scope and output schema. " +
    "Return concise factual observations and relevant regression or semantic risks. " +
    roleRule +
    " Never include credentials or private reasoning. Produce one complete JSON object.",
    "<|im_end|>\n<|im_start|>user\nInvocation binding: " + binding,
    "Editable file: " + escapeControls(editablePath ?? "none"),
    "Inputs:\n" + modelInput,
    "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
  ].join("\n");
}

export function invalid(message: string) {
  return new AgentProviderError("INVALID_REQUEST", message, false, LOCAL_LLAMA_PROVIDER_ID);
}

function malformed(): never {
  throw new AgentProviderError("MALFORMED_RESULT", "Local model returned invalid, stale or noncompliant structured output.",
    false, LOCAL_LLAMA_PROVIDER_ID);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && value.trim().length !== 0 && !credential.test(value);
}

function observations(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(item => boundedText(item, 1000));
}

/** Validate raw output before constructing the neutral result or allowing an effect. */
export function parseOutput(output: string, request: AgentRunRequest, binding: string, editablePath: string | null,
  evidenceRef: string, occurredAt: string): { result: AgentRunResult; edit: LocalLlamaEdit | null } {
  // The pinned llama-completion profile prints this terminator only after EOS.
  // A token limit can leave valid JSON followed by whitespace, but cannot be accepted as verified termination.
  const ending = /\s+\[end of text\]\s*$/.exec(output);
  if (ending === null) return malformed();
  let value: unknown;
  try { value = JSON.parse(output.slice(0, ending.index)); } catch { return malformed(); }
  if (!object(value) || Object.keys(value).length !== 6 || value.binding !== binding ||
      (value.outcome !== "PASS" && value.outcome !== "FAIL" && value.outcome !== "BLOCKED") ||
      !boundedText(value.summary, 1500) || !observations(value.observations) || !observations(value.risks)) return malformed();
  const { summary, outcome, observations: checks, risks, replacement } = value;
  let edit: LocalLlamaEdit | null = null;
  if (replacement !== null) {
    if (!object(replacement) || Object.keys(replacement).length !== 2 || request.role !== "Developer" ||
        outcome !== "PASS" || editablePath === null || replacement.path !== editablePath ||
        typeof replacement.content !== "string" || replacement.content.length > 24_576 ||
        replacement.content.includes("\0") || credential.test(replacement.content)) return malformed();
    edit = { path: editablePath, content: replacement.content };
  }
  let details: Readonly<Record<string, unknown>>;
  switch (request.role) {
    case "Developer":
      details = { summary, scopeObservations: checks, risks };
      break;
    case "QA":
      details = { acceptanceCriteriaScenarios: checks, regressionNegativeCaseCoverage: risks };
      break;
    case "Architect": {
      const ids = request.contextPackage.task.affectedContracts;
      details = { affectedContractsModules: Array.isArray(ids) ? ids : [],
        dependencyConsumerSurfaces: checks, semanticCompatibilityAssessment: summary,
        invariantDependencyRuleAssessment: risks.join(" ") };
      break;
    }
    case "UAT/Product":
      details = { intendedOutcomesScenarios: checks, observedBehavior: [summary, ...risks] };
      break;
    default:
      return malformed();
  }
  const result: AgentRunResult = {
    taskId: request.taskId, role: request.role, runId: request.runId, revisionIdentity: request.revisionIdentity,
    providerId: LOCAL_LLAMA_PROVIDER_ID, outcome, details,
    findings: outcome === "FAIL" ? [{ findingId: "role-failure", severity: "HIGH", observed: summary,
      expected: "The compiled acceptance criteria hold at the invocation revision.", remediation: risks.join(" ") }] : [],
    evidenceRefs: [evidenceRef], occurredAt,
    ...(outcome === "PASS" ? {} : { nonPass: { reason: summary, remediation: risks.join(" ") } }),
  };
  return { result, edit };
}
