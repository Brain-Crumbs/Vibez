import { readPackageIdentity } from "../project-assets/identity.js";
import { ALL_COMMANDS } from "../cli/commands.js";
import { OUTPUT_SCHEMA_VERSION } from "../cli/contracts.js";

export { createProjectServices, doctorProject, npmValidatorCommands,
  type ProjectHost, type ProjectIntegration, type ProjectValidatorCommand,
  type RetryBudgetGrant } from "../project-services/index.js";

export type ProjectServices = Awaited<ReturnType<typeof import("../project-services/index.js").createProjectServices>>;

export interface CapabilityRequirements {
  readonly apiVersion?: string;
  readonly packageVersion?: string;
}

const apiVersion = "1.0.0";

export function describeCapabilities(expected: CapabilityRequirements = {}) {
  const installed = readPackageIdentity();
  if (expected.packageVersion !== undefined && expected.packageVersion !== installed.version) {
    throw new Error(`Vibez package version ${expected.packageVersion} is required, but ${installed.version} is installed. Install the pinned Vibez tarball.`);
  }
  if (expected.apiVersion !== undefined && expected.apiVersion !== apiVersion) {
    throw new Error(`Vibez API version ${expected.apiVersion} is unsupported. This package provides ${apiVersion}. Use a compatible Vibez package or update the caller.`);
  }
  return {
    packageName: installed.name,
    packageVersion: installed.version,
    apiVersion,
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    commands: ALL_COMMANDS,
  } as const;
}
