# Main-agent workflow

Only the controller writes `progress.json`. The CLI defaults to full JSON for compatibility. Use `--format compact` for routine commands; it returns `next_phase`, `next_action`, `artifact_directory` and the current `phase_token`. Follow `next_action`, and keep drafts and reports in `artifact_directory`. `--out` selects an existing ticket directory without Jira credentials.

Only the main agent runs `configure`, `start`, `handoff`, `block`, `present`, `complete`, `invalidate` and session reset.

## Command sequence

```sh
node "$SKILL_DIR/scripts/workflow.mjs" configure ABC-123 --out "$WORK_DIR" --input /path/request.json --format compact
node "$SKILL_DIR/scripts/workflow.mjs" status ABC-123 --out "$WORK_DIR" --format compact
node "$SKILL_DIR/scripts/workflow.mjs" start ABC-123 --out "$WORK_DIR" --phase evidence_review --format compact
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase evidence_review --input /path/evidence-result.json --format compact
```

Repeat `start` and `complete` for each returned next phase. `start` returns a `phase_token`; put it in the result. Repeating `start` on an in-progress phase returns the same token. Resuming a blocked phase returns a new token and keeps its unanswered questions. Stale tokens are rejected.

Exit 0 means the command succeeded, not that the task is complete. Exit 1 means it was rejected; the message says what to fix. Exit 3 with `LOCK_BUSY` means another command holds the lock; retry later. A rejected transition still persists any automatic invalidation found before it.

The phases are `evidence_review`, `investigation`, `clarification`, `implementation` and `verification`. Scope `review` ends after investigation, `clarify` ends after clarification, and `implement` requires all five. Later phases report `not_applicable_to_scope`. There is no skip or force-complete action.

Load only the sections for the current phase and request kind. The main agent passes `implementor.md` by path; it need not load the worker brief. Read `recovery.md` only when recovery is needed.

Every `complete` input needs the common fields below plus its phase fields. This is the main-agent entrypoint; worker instructions are supplied by the handoff.

## Common result fields

Every result needs a nonempty `summary` and `artifacts` referencing nonempty files. Relative artifact paths resolve against the active artifact directory. All references must resolve inside the ticket work directory, and at least one report must be in the active artifact directory; copy relevant logs or screenshots there if they were generated elsewhere. The controller hashes every referenced file on acceptance, so do not edit them afterwards. Do not put credentials in reports.

Optional `exceptions` are `{code, reason}` objects. They stay visible in status and in the final outcome. Never use an exception to relabel a failed criterion as passed.

```json
{
  "phase_token": "token-returned-by-start",
  "summary": "Reviewed the ticket and available evidence.",
  "artifacts": ["evidence-review.md"],
  "exceptions": []
}
```

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

## Draft reports

After `start`, run `workflow.mjs draft ABC-123 --out WORK_DIR --phase PHASE --format compact` to create a new report skeleton. The returned `drafts` maps phases to file paths; `draft_contents` contains the same skeletons, so a separate file read is unnecessary. Generate once per report, fill that file and submit its returned path; do not recreate it under a second filename. Early-phase drafts carry the current token; worker drafts require `--input BINDING_PATH`, carry the original binding, and omit the main agent’s token and review. Implementation produces both worker drafts unless a reproduction waiver defers verification.

Use the returned paths exactly; worker drafts are inside the assignment directory. Reuse an existing unsubmitted draft rather than generating another. Fill JSON with a file-edit tool or a script using JSON serialization. If using shell heredocs, quote the delimiter (`<<'EOF'`) so backticks and dollar signs remain data; never interpolate ticket text into shell commands. Parse the saved JSON before submitting it. Fill findings, evidence and actual responses, then use the normal `present`/`complete` procedure. Drafts cannot pass validation unchanged. They never supply approval, mark checks passed, refresh an old report or overwrite accepted files. A pending proposal must use its recorded draft. On stale tokens or bindings, follow recovery; do not copy a new token onto old evidence.

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

Before starting bug or mixed investigation, complete the [browser and server preflight](browser-reproduction.md#preflight). Bug and mixed require fresh local runtime reproduction before completing investigation or changing implementation. Read [local-reproduction.md](local-reproduction.md) for the result contract. If reproduction is blocked or unsuccessful, the specific limitation requires explicit user permission through [reproduction-waiver.md](reproduction-waiver.md).

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
node "$SKILL_DIR/scripts/workflow.mjs" present ABC-123 --out "$WORK_DIR" --phase clarification --input /path/clarification-draft.json --format compact
# Show the summary and wait for the user's approval before the next command.
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase clarification --input /path/clarification-approved.json --format compact
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
3. Run `node "$SKILL_DIR/scripts/workflow.mjs" handoff ABC-123 --out "$WORK_DIR" --phase implementation --input /path/handoff-input.json`. The returned `assignment` gives the handoff path, binding path, assignment ID and output directory. The packet already contains the approved criteria, decisions, reproduction details and references to further evidence. For browser rechecks, ensure those references identify the Chrome MCP integration, intended session/page and page ownership; transfer browser control explicitly. The worker must confirm access in its own context.
4. Run `node "$SKILL_DIR/scripts/workflow.mjs" assert ABC-123 --out "$WORK_DIR" --phase implementation` before delegating.
5. Spawn one implementor with the prompt below, supplying only the packet, the returned `assignment.worker_brief` path and repository instructions. Do not open the worker brief in the main agent; the worker loads it. Prefer no inherited conversation; if the host forces inheritance, say that context isolation is limited. Record the host worker ID in a note in the assignment directory so the worker can be resumed.
6. While it works, handle user interaction and blockers, and do not edit the repository. Use completion notifications or a bounded wait consistent with host update requirements; avoid repeated short polling and redundant status nudges. Do not pull its exploration or logs into the main conversation. Scope questions go back to the user; a revised proposal needs new approval before coding resumes.

> Implement the approved ticket in HANDOFF_PATH. Follow WORKER_BRIEF_PATH and repository instructions. Complete every report named in the packet's `return_reports`, or return a bound blocker. Return their paths with a concise summary. The main agent owns user interaction and workflow transitions.

If subagents are unavailable or cannot access the repository, say so and generate the handoff with `mode: "main_agent"` and a nonempty `reason`, then follow the implementor brief yourself with the same binding checks, reports and verification. If the user requires delegation, block instead.

### Accept results

Use this checklist for normal acceptance; load the worker schema only when a validation error needs explanation:

- Compare the diff with approved criteria and baseline user edits; inspect relevant evidence and preserve unrelated changes.
- Require a nonempty summary and artifacts. Relative paths resolve against the active artifact directory, not the assignment directory; absolute evidence paths avoid ambiguity.
- Implementation must cover every agreed ID in `addressed_criteria` and every changed file in `changed_files`. No-change results require `no_change_reason` and a `no_code_change` exception.
- Verification must cover each agreed ID exactly once with a passed result and evidence, plus registered receipts for this assignment and unchanged code. Inspect check logs; failed or unverified criteria block completion. Bug/mixed work also needs its reproduction recheck; waiver cases follow the verification section below.

For each accepted report, preserve its binding (`assignment_id`, `proposal_id`, `requirements_sha256`, any `implementation_sha256`) and `resolved_questions`. Add only the current `phase_token`, your actual `parent_review`, and for implementation `repository_review`. Never repair a stale binding. Submit implementation with `complete`, then start verification. Use [worker-reports.md](worker-reports.md) only to diagnose an unexpected report defect; controller validation remains authoritative.

For blockers, interrupted or lost workers, replacement, or scope changes, follow [worker problems](recovery.md#worker-problems).

## Verification

Submit the worker's prepared verification report when its evidence still matches the code. Rerun checks only when changes or unresolved concerns justify it. With a reproduction waiver, do not wait for that report before accepting implementation: resume the worker once verification has started so it can perform the approved alternative and produce fresh evidence.

For browser work, perform the [ownership and cleanup check](browser-reproduction.md#browser-ownership-and-cleanup) before final handback, and disclose any retained pages or cleanup limitations.

Add the phase token and `parent_review` and submit the unchanged worker verification findings. Add review fields to the returned unaccepted report itself; do not create a second copy solely for parent review. Never edit an accepted report or its hashed evidence. With no reproduction waiver, expect both reports from the initial worker return; do not request a second run solely because verification has now started. With a waiver, follow [the waiver requirements](reproduction-waiver.md#later-phases).

Completion returns `done: true` only within the configured scope, with `outcome` `complete` or `complete_with_exceptions`. Report the exceptions of the latter explicitly.

## Block and invalidate

```sh
node "$SKILL_DIR/scripts/workflow.mjs" block ABC-123 --out "$WORK_DIR" --phase clarification --input /path/blocker.json --format compact
node "$SKILL_DIR/scripts/workflow.mjs" invalidate ABC-123 --out "$WORK_DIR" --phase clarification --reason 'User changed the required empty state' --format compact
```

Block input: `{"reason": "Need role decision", "questions": [{"id": "Q1", "question": "Which roles can save?", "material": true}]}`. Question IDs must be unique. The phase stays blocked until it is started again; blocking also discards its pending proposal, waiver request or worker assignment.

After `start`, the result must answer every question recorded in that phase: `resolved_questions: [{id, answer, source: "user", user_response}]`. Material questions require an actual user response. `source` may name other evidence for a nonmaterial answer.

`invalidate` resets the phase and all later phases, keeps previously accepted reports, records the reason and reverts no code. Use it for new user requirements that are not in Jira, or for code changes beyond the recorded implementation files. Stop active workers before invalidating or resetting.

The controller also invalidates automatically when the ticket, accepted artifacts or recorded code change. For that, and for refresh failures or sessions saved by an older skill version, see [recovery.md](recovery.md).
