// Validation only. No selector/start/state/evidence construction.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2]);
const engine = resolve(process.argv[3]);
const { loadTaskRegistryFromPaths, resolveDependencyDag } = await import(
  pathToFileURL(join(engine, 'dist/task-registry/index.js')).href
);
const registry = await loadTaskRegistryFromPaths(
  [join(root, 'migration/tasks/mig-002.task.json')],
  { repositoryRoot: root, schemaPath: join(engine, 'schemas/v1/task.schema.json') }
);
const dag = resolveDependencyDag(registry);
if (dag.taskOrder.join(',') !== 'MIG-002') throw new Error('Unexpected staged graph');
console.log('PASS: pinned native registry/schema/DAG validation only; no task admitted');
