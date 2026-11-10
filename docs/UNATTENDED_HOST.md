# Unattended host policy

Unattended work is opt-in. The existing manual workflow and explicit
repository/PR/head grant still apply to manual operation. A maintainer can
authorize a trusted host to exercise that same scoped authority in advance.
An issue, branch, agent result or role label cannot provide authority.

## Prepare the trusted host

1. Pin the installed Vibez artifact and host implementation. Run the policy
   evaluator, validator and provider launchers, GitHub integration, review
   ingress and native controller under the trusted host identity. Give each
   role a distinct host-authenticated principal and fresh external worker.
2. Place the grant, enable/revoke controls, and one ledger directory per grant
   on a supported local filesystem. Restrict the directories to the trusted
   identity. Use a separate OS account, VM or equivalent isolation boundary
   for every untrusted process. Keep controller and check-writer credentials,
   policy files, the ledger, Git metadata and authoritative workflow state
   outside worker mounts and environment. In particular, a repo validator
   can execute arbitrary repo code and needs the same isolation.
3. Bind the versioned grant to the resolved project identity, project config
   digest, repository and target ref. Enumerate task IDs and their canonical
   refs, worker-relative path scopes, roles with principals, provider/model,
   tool and network limits, pinned commands, required checks and reviews, and
   permitted actions. Use exact non-force task ref pushes and a trusted
   transport that compares the observed task head. Grant time fields are UTC
   epoch milliseconds, cost is in micro-units of the currency the host enforces.
4. Supply a live observation of the pinned configuration and current local and
   remote source before each effect. The observer must obtain facts from trusted
   integration and state readers. It must never copy authorization fields from
   a worker result. Recheck protected paths including CI workflows, operating
   policy and workflow configuration from the exact candidate diff before push,
   publication or merge. Handle policy changes under a separate owner grant.

The public host composition lives in the integration entry point.
ScopedHostPolicy checks and journals effects. scopedAgentProvider and
scopedValidator narrow and reserve the provider and command budgets.
scopedMergeEffect is called by the native controlled merge controller after
its real readiness and exact PR recheck. Keep the controller's existing
readiness, CI and review adapters. Invoke other host effects using
ScopedHostPolicy.execute around the owning gate or exact source-control
operation. Only the trusted host may call that interface. Passing a callback
that can execute unscoped work bypasses the host contract.

ScopedWorkerRuntime is the trusted launcher interface. A conforming runtime
must apply role, model, path, tool, network, cost, turn and timeout limits
outside the worker. It must prohibit symlink/junction and parent traversal,
prevent inherited credentials, enforce command argv/cwd, cap child processes
and return only after the worker and children have stopped. Workers have
access only to their stage's input and scoped outputs. Validate result/context
bindings through the existing AgentRunner and native review gates.
A launcher that cannot enforce a cost limit must reject the invocation.
AUT-002 owns the concrete headless provider. AUT-003 owns unattended queue
dispatch and lifecycle supervision.

## GitHub deployment gate

Configure protection only under a separate repository administration decision.
The supported ruleset profile has two parts.

- An active, no-bypass ruleset requires PRs, current-base checks from the
  approved GitHub App IDs, and blocks force pushes and deletion of the
  integration branch.
- An active update-restriction ruleset allows only the isolated controller
  App to bypass that restriction, and only in a PR. The controller stays
  subject to the first ruleset. Ordinary worker and reviewer App installation
  tokens have only read access to contents and PRs. Only the host publishes
  or changes readiness. Trusted CI reports its own check results.

Use the authenticated GitHub rules-for-branch endpoint and complete ruleset
details, including bypass actors, to verify the active configuration.
Pass the results and the permissions from the trusted installation-token
issuer to verifyGitHubProtection. Fail closed if observations are missing,
expired, incomplete, or from another repository or branch. Read-only token
permissions must correspond to the credentials actually present in each
role environment. Verify that workers cannot reach the controller's
credentials. Rehearse rejection of a protected-ref push, PR merge and
check update with an actual worker credential in an approved test repository.
Verify a controlled PR merge after the trusted checks pass. Preserve redacted
evidence and record the effective repository, branch, ruleset and app IDs.
The default unprotected repository configuration cannot pass this gate.

## Decisions, restart and rollback

An allow record reserves the full upper bound before calling a provider or
command. It remains charged after restart, including an unsuccessful launch.
Run and rework reservations are scoped to a single grant ledger. An unresolved
reservation prevents overlapping work for that task and consumes a concurrency
slot. A second evaluator cannot take the writer lease. A graceful close leaves
the decisions and unresolved reservations intact. A crashed writer leaves its
lease intact. An administrator can archive the lease only after verifying the
old host and external sessions have drained. Retain the original ledger, then
reconcile unresolved reservations with verifyDrained and the native owning gate.
Never replay an uncertain merge without verifying its actual result in GitHub.

Disable new grants and revoke active grants before rollback. Drain or quarantine
every external worker and reconcile pending effects before enabling another
engine. Preserve decisions, leases archived during recovery, original task
history and evidence. Follow the [compatibility and rollback procedure](COMPATIBILITY.md)
before switching artifacts. Resume manual mode only with an authorized,
compatible binding. Human-only actions report HUMAN_REQUIRED and require an
explicit operator decision through the ordinary manual boundary.

Records expose grant/config digests, task/revision and exact PR number where
applicable, decision and fixed reason, charge and operation ID. Keep commands,
model output, credentials and hidden reasoning outside the policy ledger.
Policy decisions supplement native evidence and do not confer a review or
record DONE.
