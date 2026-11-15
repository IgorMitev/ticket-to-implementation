# Main-agent workflow

Only the controller writes `progress.json`. The CLI defaults to full JSON for compatibility. Use `--format compact` for routine commands; it returns `next_phase`, `next_action`, `artifact_directory` and the current `phase_token`. Follow `next_action`, and keep drafts and reports in `artifact_directory`. `--out` selects an existing ticket directory without Jira credentials.

Only the main agent runs `configure`, `start`, `handoff`, `block`, `present`, `complete`, `invalidate` and session reset.

## Command sequence

```sh
node "$SKILL_DIR/scripts/workflow.mjs" configure ABC-123 --out "$WORK_DIR" --input /path/request.json --format compact
node "$SKILL_DIR/scripts/workflow.mjs" status ABC-123 --out "$WORK_DIR" --format compact
node "$SKILL_DIR/scripts/workflow.mjs" start ABC-123 --out "$WORK_DIR" --phase evidence_review --draft --response '{phase}-draft-response.json' --format compact
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase evidence_review --input /path/evidence-result.json --format compact
```

Repeat `start` and `complete` for each returned next phase. `start` returns a `phase_token`; put it in the result. Repeating `start` on an in-progress phase returns the same token. Resuming a blocked phase returns a new token and keeps its unanswered questions. Stale tokens are rejected.

Exit 0 means the command succeeded, not that the task is complete. Exit 1 means it was rejected; the message says what to fix. Exit 3 with `LOCK_BUSY` means another command holds the lock; retry later. A rejected transition still persists any automatic invalidation found before it.

The phases are `evidence_review`, `investigation`, `clarification`, `implementation` and `verification`. Scope `review` ends after investigation, `clarify` ends after clarification, and `implement` requires all five. Later phases report `not_applicable_to_scope`. There is no skip or force-complete action.

Load only the linked procedure for the current phase and request kind. Main agents load `implementation.md` for handoff and acceptance. Pass `implementor.md` by path without opening it; load it only when actually taking the documented main-agent implementation fallback. Read `recovery.md` only when recovery is needed.

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

For a new evidence-review, investigation or clarification report, use `start --phase PHASE --draft --response '{phase}-draft-response.json' --format compact`. It starts that phase and creates its draft under the same lock, with the normal phase-order and approval checks. Implementation and verification still use their handoff and worker drafts.

`draft_response` points to saved JSON containing `drafts` and `draft_contents`, also returned on stdout. Parse that file to select the report path and skeleton by phase; do not retype generated filenames or reread skeletons. Fill the report using JSON serialization and create its referenced evidence before submitting. The response file is a lookup, not evidence or approval. `--response` accepts only a filename, expands `{phase}`, and refuses overwrites. On resume, reuse the existing unsubmitted report; a pending proposal must use its recorded draft. After recovery, choose a fresh response filename and follow the new token/binding instead of relabelling old evidence.

Plain `start` remains available when no new draft is needed. `draft --phase PHASE --response FILENAME` creates one for an already-started phase; workers also supply `--input BINDING_PATH`. Drafts remain incomplete and cannot pass unchanged. They never grant approval, refresh bindings or overwrite accepted reports. Parse filled JSON before the normal `present`/`complete` procedure. If using shell heredocs, quote the delimiter (`<<'EOF'`) so ticket text stays data.

## Evidence review

Read [evidence-review.md](evidence-review.md) when this phase is active.

## Investigation

Read [investigation.md](investigation.md) when this phase is active.

## Clarification

Read [clarification.md](clarification.md) when this phase is active.

## Implementation

Read [implementation.md](implementation.md) when this phase is active.

## Verification

Read [verification.md](verification.md) when this phase is active.

## Block and invalidate

```sh
node "$SKILL_DIR/scripts/workflow.mjs" block ABC-123 --out "$WORK_DIR" --phase clarification --input /path/blocker.json --format compact
node "$SKILL_DIR/scripts/workflow.mjs" invalidate ABC-123 --out "$WORK_DIR" --phase clarification --reason 'User changed the required empty state' --format compact
```

Block input: `{"reason": "Need role decision", "questions": [{"id": "Q1", "question": "Which roles can save?", "material": true}]}`. Question IDs must be unique. The phase stays blocked until it is started again; blocking also discards its pending proposal, waiver request or worker assignment.

After `start`, the result must answer every question recorded in that phase: `resolved_questions: [{id, answer, source: "user", user_response}]`. Material questions require an actual user response. `source` may name other evidence for a nonmaterial answer.

`invalidate` resets the phase and all later phases, keeps previously accepted reports, records the reason and reverts no code. Use it for new user requirements that are not in Jira, or for code changes beyond the recorded implementation files. Stop active workers before invalidating or resetting.

The controller also invalidates automatically when the ticket, accepted artifacts or recorded code change. For that, and for refresh failures or sessions saved by an older skill version, see [recovery.md](recovery.md).
