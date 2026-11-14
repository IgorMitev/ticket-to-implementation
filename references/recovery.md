# Recovery

Read the section that matches the situation. In every case, stop affected workers first, and never reset or discard code just to retry. `status` reports why a phase was reopened and what to do next.

## Worker problems

An assignment covers one execution attempt against one approved result hash. Replacement, blocking, scope changes, modified handoff files and reset revoke it. Do not attempt a second handoff on an existing assignment.

- **Worker returns a blocker:** check its binding against the active assignment, stop the worker, and pass its `reason` and `questions` to `block` for the active phase. Obtain answers in the main conversation. Then start the phase and create a new handoff whose input includes `resolved_questions: [{id, answer, source, user_response}]` for every pending question in that phase; material questions need an actual user response. Keep the same approval if requirements are unchanged, and retain the answers in the completed phase report.
- **Interrupted but still available:** inspect status and the host worker state, then resume the same worker with the saved assignment. Do not spawn a duplicate. An unchanged `continue` retains the assignment.
- **Worker stopped or lost:** confirm with the host tool that it has stopped, and after a forced kill that no stray process remains. Inspect partial changes, block implementation with the reason, start it and generate a new handoff.
- **Scope or behavior change:** stop the worker, invalidate clarification, groom, present the revised summary and obtain approval, then create a new handoff. Old results cannot be relabelled with the new binding; inspect and revalidate existing work.
- **Verification worker lost or replaced:** stop the old worker, `block --phase verification`, `start --phase verification`, then `handoff --phase verification` with the new phase token and any resolved questions. This creates a verification-only assignment tied to the accepted implementation, which stays complete. The new worker inspects and tests only.
- **Verification needs code fixes:** stop the worker, invalidate implementation, inspect the diff and create a new handoff. Do not edit code under a completed implementation record.
- **Switching to the main agent mid-assignment:** stop the worker, block the active phase, start it, and generate the replacement handoff with `mode: "main_agent"` and a reason. If the user requires delegation, stay blocked instead.

## Stale or invalidated state

The controller invalidates automatically on preparation, status, continue or any transition:

- Changed ticket content or availability reopens the workflow from evidence review.
- A modified or missing accepted artifact reopens its phase and all later phases.
- Changed recorded code reopens implementation and verification. During active work any drift in covered repository files does the same. After the scoped workflow completes, staging or committing unchanged files preserves completion.

A run in progress may become stale, and its token is then rejected. Reassess the reopened phase from `status` rather than resubmitting old results. Pending questions survive invalidation and reconfiguration; if a new user instruction makes one obsolete, cite that instruction as its resolution.

## Refresh failures

- **Partial preparation (exit 2):** errors are recorded in `manifest.json`. Attachment size, download or extraction failures still adopt fresh ticket content as partial; disclose the missing evidence.
- **Refresh lost comments or remote links that were previously complete:** the prior snapshot is kept, the attempt is saved under `refresh-attempts/`, and status and continue expose `refresh_warning`. Retry transient failures. If the failure persists, rerun preparation with `--accept-partial` to adopt the new snapshot with explicit missing evidence. Changed content invalidates affected phases, which must be reviewed and groomed again. The flag neither approves requirements nor permits claiming that missing evidence was reviewed.
- **Issue fetch failed:** fatal; the prior data is kept. Disclose cached age and continue only independent work.
- **`LOCK_BUSY` (exit 3):** another command holds the lock. Retry later without resetting or replacing a worker. A lock left by a dead process is recovered automatically. Before removing a malformed lock or `.prepare.lock.recovery` by hand, verify that no preparation process is active.

## Sessions saved by an older skill version

The controller migrates old state and reopens whatever the current rules require; follow `status`.

- Bug and mixed sessions may reopen investigation for the mandatory local reproduction gate. Feature sessions keep valid progress.
- Implementation and verification may reopen so that a handoff with a repository baseline exists. Inspect existing code and stop old workers before resuming.
- A missing proposal ID reopens clarification for fresh approval.
- Verification results without receipts must be rerun. Do not synthesize receipts from old logs.
- State from a newer skill version is refused without being replaced; use the newer skill.
- After a reset, configure again if the controller asks; the original user scope stays recorded.
