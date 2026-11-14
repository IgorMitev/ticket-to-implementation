# Workflow controller

Only the controller writes `progress.json`. Every command prints compact JSON status with `next_phase`, `next_action`, `artifact_directory` and the current `phase_token`. Follow `next_action`, and keep drafts and reports in `artifact_directory`. `--out` selects an existing ticket directory without Jira credentials.

Only the main agent runs `configure`, `start`, `handoff`, `block`, `present`, `complete`, `invalidate` and session reset.

## Command sequence

```sh
node "$SKILL_DIR/scripts/workflow.mjs" configure ABC-123 --out "$WORK_DIR" --input /path/request.json
node "$SKILL_DIR/scripts/workflow.mjs" status ABC-123 --out "$WORK_DIR"
node "$SKILL_DIR/scripts/workflow.mjs" start ABC-123 --out "$WORK_DIR" --phase evidence_review
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase evidence_review --input /path/evidence-result.json
```

Repeat `start` and `complete` for each returned next phase. `start` returns a `phase_token`; put it in the result. Repeating `start` on an in-progress phase returns the same token. Resuming a blocked phase returns a new token and keeps its unanswered questions. Stale tokens are rejected.

Exit 0 means the command succeeded, not that the task is complete. Exit 1 means it was rejected; the message says what to fix. Exit 3 with `LOCK_BUSY` means another command holds the lock; retry later. A rejected transition still persists any automatic invalidation found before it.

The phases are `evidence_review`, `investigation`, `clarification`, `implementation` and `verification`. Scope `review` ends after investigation, `clarify` ends after clarification, and `implement` requires all five. Later phases report `not_applicable_to_scope`. There is no skip or force-complete action.

Every `complete` input needs the [common result fields](report-contracts.md#common-result-fields) plus the phase fields below.

## Configuration

```json
{
  "kind": "feature",
  "scope": "implement",
  "repository": "/absolute/path/to/repository",
  "user_request": "Implement ABC-123, including the requested empty state."
}
```

Kinds are `bug`, `feature` and `mixed`; base the kind on the ticket and the user request. Changing bug or mixed to feature also requires `reclassification_reason` explaining the genuine scope correction or user instruction. Do not reclassify to avoid reproduction. Preserve the user's actual request and restrictions in `user_request`.

Reconfiguring with a changed kind, scope, repository or request invalidates the workflow from evidence review, so do not reconfigure to bypass a gate. Identical configuration is idempotent.

## Evidence review

`attachments` must cover each manifest attachment ID exactly once. Each entry has `id` and `disposition`: `reviewed`, `not_relevant` or `unavailable`. The latter two require `reason`. An `unavailable` attachment, an excluded video, or a partial preparation manifest requires a `missing_evidence` exception. `not_relevant` is not a claim that the attachment was reviewed.

A reviewed video must show as downloaded and prepared in the manifest. Supply `inspected_files` listing every overview contact sheet (absolute paths recommended) and `observations`, each with `timestamp_seconds` within the video's duration and an `observation`.

```json
{
  "id": "10042",
  "disposition": "reviewed",
  "inspected_files": ["/absolute/ticket/evidence/10042/contact-001.jpg"],
  "observations": [{"timestamp_seconds": 2.4, "observation": "The dialog remains visible after Save."}]
}
```

If the ticket has no video attachments, include `no_video_reason`.

## Investigation

All kinds need `current_behavior` text and `relevant_files`, an array of repository-relative paths investigated (it may be empty for a new project). Feature and mixed also need `feature_analysis` and a `constraints` array.

Bug and mixed need `reproduction`:

```json
{
  "status": "reproduced",
  "attempted_locally": true,
  "target": "http://localhost:4200/editor",
  "evidence": ["/absolute/ticket/workflow/current/reproduction.md", "/absolute/ticket/workflow/current/local-run.log"],
  "environment": "Local development server, test account with editor role",
  "steps": ["Open the editor", "Change the title", "Save"],
  "expected": "Dialog closes and title is saved",
  "actual": "Dialog remains open"
}
```

- `status` is `reproduced`, `not_reproduced` or `blocked`. `attempted_locally` must be true for the first two; use `blocked` with false when no local attempt was possible.
- Every status needs the environment, target, the steps or setup actions actually performed, expected and actual results, and nonempty evidence paths.
- Evidence must be fresh local screenshots, logs, or a report of the actual setup blocker, written in the active `artifact_directory`. Ticket text, attachments, extracted ticket frames and copies of them are rejected. Never relabel ticket evidence as a local observation. Frames extracted from your own local reproduction recording are allowed.
- "Local" describes the runtime being exercised, so a custom local hostname is valid. Name any authorized QA backend.

A `not_reproduced` or `blocked` result also needs `reason`, `alternative_verification` and a `not_reproduced` exception, and cannot complete investigation without explicit user permission. Follow [reproduction-waiver.md](reproduction-waiver.md).

## Clarification

The draft needs:

- `acceptance_criteria`: nonempty, each with a unique `id`, a `requirement` and a `verification`.
- `scope_exclusions`: array.
- `questions`: array of `{question, material}`. A material question needs a nonempty `answer` and `user_response`. An unanswered nonmaterial question needs an explicit `assumption`.
- `exception_decisions`: one entry per earlier evidence or investigation exception, with `phase`, `code`, `resolution` and `reason`. `resolved` requires nonempty `evidence` file paths, `not_material` requires a reasoned scope or evidence justification, and `accepted_by_user` requires `user_response`. Do not dismiss a material gap as immaterial to proceed. A `not_reproduced` exception from an unreproduced bug follows the stricter [waiver rules](reproduction-waiver.md#later-phases).

The summary and the referenced brief must describe the proposed goal, behavior and scope, decisions, assumptions and material limitations.

1. Prepare the brief and the draft result, without `alignment`.
2. Run `present`. It validates and freezes the proposal and returns `proposal.id`, its hash and the saved JSON path. It does not message the user or grant approval.
3. Show the summary in the conversation: proposed behavior and scope, exclusions, acceptance criteria, verification and material limitations. Ask explicitly for approval and wait.
4. If the user requests changes, revise and repeat `present` and the summary. Each presentation creates a new proposal ID, which makes earlier approvals stale.
5. After an actual approving response, submit the exact draft to `complete` with the current phase token and the `alignment` object below. The content must match the recorded proposal.

```sh
node "$SKILL_DIR/scripts/workflow.mjs" present ABC-123 --out "$WORK_DIR" --phase clarification --input /path/clarification-draft.json
# Show the summary and wait for the user's approval before the next command.
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase clarification --input /path/clarification-approved.json
```

```json
{
  "alignment": {
    "status": "confirmed_by_user",
    "proposal_id": "id-returned-by-present",
    "rationale": "User approved the presented scope and acceptance criteria.",
    "user_response": "Quote or reference the actual approving response here."
  }
}
```

The original request to implement is not approval, and approval of individual answers does not approve the full summary. Clarify-only scope ends after approval without authorizing implementation.

A pending proposal is returned by `status` and `session continue`, so an unchanged proposal need not be presented again on resume. Editing the frozen proposal or its artifacts invalidates clarification and later phases. Blocking or invalidating clarification discards the proposal. A completed approval stays valid while its evidence and requirements are unchanged.

## Implementation

The main agent owns user interaction, scope decisions, workflow transitions and review. One implementor owns source edits and checks. Scripts prepare and validate handoffs; the host launches workers.

### Assign an implementor

1. Read repository instructions and inspect the current diff. Establish existing user changes and make sure no other writer is active.
2. Start implementation and write a handoff input with its phase token: `{"phase_token":"...","mode":"subagent"}`.
3. Run `node "$SKILL_DIR/scripts/workflow.mjs" handoff ABC-123 --out "$WORK_DIR" --phase implementation --input /path/handoff-input.json`. The returned `assignment` gives the handoff path, binding path, assignment ID and output directory. The packet already contains the approved criteria, decisions, reproduction details and references to further evidence.
4. Run `node "$SKILL_DIR/scripts/workflow.mjs" assert ABC-123 --out "$WORK_DIR" --phase implementation` before delegating.
5. Spawn one implementor with the prompt below, supplying only the packet, [implementor.md](implementor.md) and repository instructions. Prefer no inherited conversation; if the host forces inheritance, say that context isolation is limited. Record the host worker ID in a note in the assignment directory so the worker can be resumed.
6. While it works, handle user interaction and blockers, and do not edit the repository. Do not pull its exploration or logs into the main conversation. Scope questions go back to the user; a revised proposal needs new approval before coding resumes.

> Implement the approved ticket in HANDOFF_PATH. Follow SKILL_DIR/references/implementor.md and repository instructions, including the linked report contracts and phase timing. Write reports or a bound blocker to the packet's output paths and return their paths with a concise summary. The main agent owns user interaction and workflow transitions.

If subagents are unavailable or cannot access the repository, say so and generate the handoff with `mode: "main_agent"` and a nonempty `reason`, then follow the implementor brief yourself with the same binding checks, reports and verification. If the user requires delegation, block instead.

### Accept results

Read the concise reports, inspect the diff and the relevant test evidence, and compare the result with the approved criteria. A worker's completion message is not proof. For each accepted report, keep its binding and add the current phase token, `parent_review`, and for implementation `repository_review`, as described in [report contracts](report-contracts.md). Submit implementation with `complete`, then start verification.

For blockers, interrupted or lost workers, replacement, or scope changes, follow [worker problems](recovery.md#worker-problems).

## Verification

Submit the worker's prepared verification report when its evidence still matches the code. Rerun checks only when changes or unresolved concerns justify it. With a reproduction waiver, do not wait for that report before accepting implementation: resume the worker once verification has started so it can perform the approved alternative and produce fresh evidence.

Add the phase token and `parent_review` and submit the [verification result](report-contracts.md#verification-result).

Completion returns `done: true` only within the configured scope, with `outcome` `complete` or `complete_with_exceptions`. Report the exceptions of the latter explicitly.

## Block and invalidate

```sh
node "$SKILL_DIR/scripts/workflow.mjs" block ABC-123 --out "$WORK_DIR" --phase clarification --input /path/blocker.json
node "$SKILL_DIR/scripts/workflow.mjs" invalidate ABC-123 --out "$WORK_DIR" --phase clarification --reason 'User changed the required empty state'
```

Block input: `{"reason": "Need role decision", "questions": [{"id": "Q1", "question": "Which roles can save?", "material": true}]}`. Question IDs must be unique. The phase stays blocked until it is started again; blocking also discards its pending proposal, waiver request or worker assignment.

After `start`, the result must answer every question recorded in that phase: `resolved_questions: [{id, answer, source: "user", user_response}]`. Material questions require an actual user response. `source` may name other evidence for a nonmaterial answer.

`invalidate` resets the phase and all later phases, keeps previously accepted reports, records the reason and reverts no code. Use it for new user requirements that are not in Jira, or for code changes beyond the recorded implementation files. Stop active workers before invalidating or resetting.

The controller also invalidates automatically when the ticket, accepted artifacts or recorded code change. For that, and for refresh failures or sessions saved by an older skill version, see [recovery.md](recovery.md).
