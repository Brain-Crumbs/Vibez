import { readFileSync } from "node:fs";
import { canonicalJson, deepFreeze } from "../local-agent-adapter/json.js";
import { checkedProjectPath, ConfigError, digest, projectGit, type ResolvedProjectConfig } from "../project-config/index.js";
import { getAssetCatalog, readPackageJson } from "../project-assets/index.js";
import type { ContextArtifact } from "../context-compiler/index.js";
import type { RegisteredTask, TaskRegistry } from "../task-registry/index.js";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("CONFIG_INVALID", "Project context inputs must be JSON objects.");
  }
  return value as Record<string, unknown>;
}

export function trackedFiles(config: ResolvedProjectConfig, revision: string, path: string, suffix: string): readonly string[] {
  const listing = projectGit(config.projectRoot, ["ls-tree", "-r", "-z", revision, "--", path]);
  const files = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const file = entry.slice(tab + 1);
    if (!file.endsWith(suffix)) continue;
    if (!/^100(?:644|755) blob /.test(entry)) {
      throw new ConfigError("UNSAFE_PATH", `Expected a regular tracked input at '${file}'.`);
    }
    checkedProjectPath(config.projectRoot, file, "file");
    files.push(file);
  }
  return files.sort();
}

function trackedJson(config: ResolvedProjectConfig, revision: string, path: string): Record<string, unknown> {
  const file = checkedProjectPath(config.projectRoot, path, "file");
  const text = projectGit(config.projectRoot, ["show", `${revision}:${path}`]);
  const content = object(JSON.parse(text));
  if (canonicalJson(content) !== canonicalJson(JSON.parse(readFileSync(file, "utf8")))) {
    throw new ConfigError("IDENTITY_CONFLICT", `Project input '${path}' differs from its tracked revision.`);
  }
  return content;
}

interface Input {
  readonly sourcePath: string;
  readonly content: Record<string, unknown>;
}

function indexInputs(inputs: readonly Input[], field: string): Map<string, Input> {
  const index = new Map<string, Input>();
  for (const input of inputs) {
    const id = input.content[field];
    if (typeof id !== "string" || !id) {
      throw new ConfigError("CONFIG_INVALID", `Missing ${field} in '${input.sourcePath}'.`);
    }
    const prior = index.get(id);
    if (prior !== undefined && canonicalJson(prior.content) !== canonicalJson(input.content)) {
      throw new ConfigError("IDENTITY_CONFLICT", `Conflicting context inputs for '${id}'.`);
    }
    if (prior === undefined) index.set(id, input);
  }
  return index;
}

export function createProjectContext(config: ResolvedProjectConfig, catalog: ReturnType<typeof getAssetCatalog>) {
  const fromPackage = catalog.contracts.map(asset => {
    const input = readPackageJson(asset.path);
    if (input.sha256 !== asset.sha256) throw new ConfigError("IDENTITY_CONFLICT", "Package contract changed during setup.");
    return { sourcePath: `vibez-package:${asset.sha256}/${asset.path}`, content: input.document };
  });
  const paths = config.document.paths;

  function load(revision: string) {
    const read = (path: string, suffix: string) => trackedFiles(config, revision, path, suffix)
      .map(sourcePath => ({ sourcePath, content: trackedJson(config, revision, sourcePath) }));
    const requirements = indexInputs(read(paths.requirements, ".json"), "requirementId");
    const contracts = indexInputs([...fromPackage, ...read(paths.contracts, ".json")], "moduleId");
    const policyDigest = digest(trackedJson(config, revision, paths.contextPolicy));
    return { requirements, contracts, policyDigest };
  }

  function artifactsFor(task: RegisteredTask, registry: TaskRegistry, revision: string, architecture = false): readonly ContextArtifact[] {
    const { requirements, contracts, policyDigest } = load(revision);
    const contractIds = new Set(task.affectedContracts);
    for (const dependencyId of task.dependencies) {
      for (const id of registry.get(dependencyId)?.affectedContracts ?? []) contractIds.add(id);
    }
    if (architecture) {
      for (const id of task.affectedContracts) {
        const consumers = contracts.get(id)?.content.knownConsumers;
        if (!Array.isArray(consumers)) continue;
        for (const consumer of consumers) {
          if (typeof consumer?.consumerId === "string" && contracts.has(consumer.consumerId)) {
            contractIds.add(consumer.consumerId);
          }
        }
      }
    }
    const artifacts: ContextArtifact[] = [{
      artifactId: "policy:configured-project", kind: "policy", taskIds: [task.taskId], revision,
      sourcePath: paths.contextPolicy, content: { configDigest: config.configDigest, policyDigest, assetCatalogDigest: digest(catalog) },
    }];
    for (const [kind, ids, inputs] of [["requirement", task.requirements, requirements], ["contract", contractIds, contracts]] as const) {
      for (const id of ids) {
        const input = inputs.get(id);
        if (input === undefined) throw new ConfigError("INPUT_MISSING", `Required ${kind} '${id}' is missing at the selected revision.`);
        artifacts.push({
          artifactId: `${kind}:${id}`, kind, referenceId: id, taskIds: [task.taskId], revision, ...input,
        });
      }
    }
    return deepFreeze(artifacts.sort((a, b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
  }

  return { artifactsFor, load };
}
