import type { ControlledMergeDependencies } from "../controlled-merge/index.js";
import type { ScopedHostPolicy } from "./index.js";

/** Composes with the native controller after its readiness and PR recheck. */
export function scopedMergeEffect(policy: ScopedHostPolicy): NonNullable<ControlledMergeDependencies["mergeEffect"]> {
  return (task, request, execute) => policy.execute({
    action: "merge", taskId: task.taskId, revision: request.expectedHeadSha, pullRequestNumber: request.number,
  }, ({ signal }) => {
    signal.throwIfAborted();
    return execute();
  });
}
