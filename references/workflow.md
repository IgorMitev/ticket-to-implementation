# Validated workflow control

The controller validates declarations, artifacts, ordering and changes. It does not invoke an LLM, inspect the semantics of screenshots, prove that a quoted user answer is authentic, or sandbox Kiro's tools. The agent must use these commands and honor user authorization. A host-level tool policy or external orchestrator would be needed to prevent direct source edits or state tampering outside this protocol.

Only the controller writes `progress.json`. Keep drafts and reports in the `artifact_directory` returned by status. Commands use Node built-ins and run locally. `--out` selects an existing ticket directory without Jira credentials; otherwise the configured Jira endpoints select the default cache.

## Command sequence

```sh
node "$SKILL_DIR/scripts/workflow.mjs" configure ABC-123 --out "$WORK_DIR" --input /path/request.json
node "$SKILL_DIR/scripts/workflow.mjs" status ABC-123 --out "$WORK_DIR"
node "$SKILL_DIR/scripts/workflow.mjs" start ABC-123 --out "$WORK_DIR" --phase evidence_review
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase evidence_review --input /path/evidence-result.json
```

Repeat `start` and `complete` for the returned next phase. For clarification, use the mandatory presentation/approval sequence below before `complete`. `start` returns a `phase_token`; put it in the result. Repeating `start` on the same in-progress phase returns the same token. Resuming a blocked phase returns a new token and keeps its unanswered questions. Stale tokens are rejected.

Actions: `configure`, `status`, `start`, `assert`, `block`, `present`, `request-reproduction-waiver`, `handoff`, `check-worker`, `record-check`, `complete`, `invalidate`. Exit 0 means the command succeeded (not necessarily the task is complete); exit 1 means it failed. Workflow/session exit 3 with `LOCK_BUSY` means bounded lock retries were exhausted; retry later without resetting or replacing a worker. Stdout is a compact JSON status. A rejected transition still persists automatic invalidations found before that transition.

The phases are `evidence_review`, `investigation`, `clarification`, `implementation`, `verification`. Script-generated evidence preparation is the prerequisite represented by `manifest.json`; it is not an agent-set completion flag. Scope `review` ends after investigation; `clarify` ends after clarification; `implement` requires all five phases. Later phases are reported as `not_applicable_to_scope`. No generic skip/force-complete action exists.

Configuration (`request.json`):

```json
{
  "kind": "feature",
  "scope": "implement",
  "repository": "/absolute/path/to/repository",
  "user_request": "Implement ABC-123, including the requested empty state."
}
```

Kinds: `bug`, `feature`, `mixed`. Reclassifying bug/mixed to feature additionally requires `reclassification_reason`, recorded in the event log. Explain the genuine scope correction/user instruction; do not reclassify to avoid reproduction. A first configuration, including one after migrating a schema 4 or older session, has no prior kind to compare, so choosing `feature` for a defect is unchecked; base the kind on the ticket and user request. Preserve the user's actual request and restrictions in `user_request`. Approval of the specific presented summary is always required before completing clarification, and material unresolved questions require answers. The legacy `requires_user_confirmation` option can be omitted or true; false is rejected. Reconfiguring a changed kind/scope/repository/request invalidates the workflow from evidence review, so do not reconfigure merely to bypass a gate. Identical configuration is idempotent.

## Common result fields

Every phase result needs `phase_token`, non-empty `summary`, and `artifacts` referencing non-empty files. Relative artifact paths resolve against the active artifact directory. All references must resolve inside the ticket work directory, and at least one report must be in the active artifact directory. Copy relevant test logs or screenshots there if generated elsewhere. The input JSON itself is a draft; the controller saves an immutable-by-convention accepted copy and hashes every referenced file. Do not put credentials in reports.

Optional `exceptions` are objects with `code` and `reason`; they remain visible in status and final outcomes. Required exceptions are specified below. Do not use an exception to relabel a failed verification criterion as passed.

```json
{
  "phase_token": "token-returned-by-start",
  "summary": "Reviewed the ticket and available evidence.",
  "artifacts": ["evidence-review.md"],
  "exceptions": [],
  "attachments": [],
  "no_video_reason": "The ticket contains no video attachments."
}
```

## Evidence review

`attachments` must cover each manifest attachment ID exactly once. Each entry has `id` and `disposition`: `reviewed`, `not_relevant`, or `unavailable`. The latter two require `reason`. `unavailable`, an excluded video, or a partial preparation manifest requires a `missing_evidence` exception. A reasoned `not_relevant` disposition is not a claim that an attachment was reviewed; video exclusions must remain visible as exceptions.

For a reviewed video, the manifest must show downloaded/prepared evidence. Supply `inspected_files` with every overview contact sheet (absolute paths recommended), plus `observations`, each with `timestamp_seconds` and `observation`. Timestamps must be within the video's duration. The controller checks references, not whether images were actually opened or interpreted accurately. Follow the video review brief for dense follow-up and coverage limitations.

```json
{
  "id": "10042",
  "disposition": "reviewed",
  "inspected_files": ["/absolute/ticket/evidence/10042/contact-001.jpg"],
  "observations": [{"timestamp_seconds": 2.4, "observation": "The dialog remains visible after Save."}]
}
```

If there are no video attachments, include `no_video_reason`. After successful completion the controller sets the evidence reconciliation marker. Investigation and requirements alignment must still happen.

## Investigation

All kinds: `current_behavior` text and `relevant_files` array of repository-relative paths investigated (may be empty for a new project). For `feature` or `mixed`, also provide `feature_analysis` and `constraints` array.

For `bug` or `mixed`, `reproduction` must include:

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

Local runtime reproduction is mandatory for bug/mixed investigation. `attempted_locally` must be true for `reproduced` or `not_reproduced`; use `blocked` with false when unable to run a local attempt. All three statuses need the nonempty environment/target, actual steps or setup actions, expected/actual results, and nonempty evidence paths. Reproduction evidence must resolve inside the active `artifact_directory`. Ticket text/manifests, attachment caches, extracted ticket frames and symlink aliases to them are rejected; known ticket-video directories are rejected even inside active artifacts. Capture fresh local screenshots/logs or a report of the actual setup blocker there. Do not copy ticket evidence into that directory and relabel it as a local observation. The controller hashes reproduction evidence along with report artifacts. It also rejects byte-identical copies or hard links of ticket files, attachments and extracted ticket frames (files under 16 bytes, such as an empty `[]` list, are exempt because they are too common to identify a copy), and frames in any directory whose `extract-video` manifest names a ticket attachment as its source. Extracting a local reproduction recording is allowed. It cannot infer the provenance of edited or re-encoded bytes. A custom local hostname is valid; “local” describes the runtime being exercised, not a hostname pattern. Clearly name any authorized QA backend. Do not access production to satisfy this gate.

An unsuccessful or unavailable reproduction also needs `reason`, `alternative_verification`, and a `not_reproduced` exception. These fields alone cannot complete investigation.

### Explicit reproduction omission waiver

1. Prepare the full investigation draft (including common fields and feature analysis for mixed tickets), with reproduction evidence/limitation and alternative plan. Do not include `reproduction_waiver` yet. Resolve any recorded questions with actual answers.
2. Run `request-reproduction-waiver` with the current investigation phase token. It validates/freezes the draft, returns `reproduction_request.id` and path, and blocks investigation. It does not ask the user or grant consent.
3. Show the attempts/blocker and alternative, ask **“May I proceed without local reproduction for this ticket?”**, and wait for explicit permission. An original “implement this” request, generic approval of requirements or silence is insufficient.
4. Only after permission, run `start --phase investigation` and complete using the unchanged draft, new phase token and the following `reproduction_waiver` object:

```json
{
  "decision": "approved",
  "scope": "proceed_without_local_reproduction",
  "request_id": "id-returned-by-request-reproduction-waiver",
  "user_response": "Quote or reference the actual explicit permission to omit reproduction."
}
```

```sh
node "$SKILL_DIR/scripts/workflow.mjs" request-reproduction-waiver ABC-123 --out "$WORK_DIR" --phase investigation --input /path/investigation-draft.json
# Ask the user and wait; do not record an invented response.
node "$SKILL_DIR/scripts/workflow.mjs" start ABC-123 --out "$WORK_DIR" --phase investigation
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase investigation --input /path/investigation-with-waiver.json
```

The waiver is tied to the exact full draft and hashed artifacts; `status`/`continue` preserve a pending request. Revisions require `invalidate --phase investigation`, reassessment and a new request/permission. A pending request cannot be replaced by another request after `start` alone. A generic `block`, reset, changed ticket or changed evidence revokes a pending waiver. If local reproduction later succeeds, invalidate investigation, record the actual result and complete without a waiver. Changed circumstances after an accepted waiver also require invalidation and fresh assessment; external access changes must be reported by the main agent because the controller cannot observe them.

At clarification, carry `reproduction_waiver_id` in the summary JSON and show the omission/alternative to the user. Its `exception_decisions` entry must use `resolution: "accepted_by_user"`, `waiver_request_id`, and the same `user_response` as the accepted investigation. `not_material` and `resolved` cannot dismiss this omission; successful reproduction instead requires reopening investigation. Approval of the implementation summary remains a separate gate. Review-only requests also cannot complete bug investigation without reproduction or permission.

This records declarations and evidence, not proof that a runtime action or user response was authentic. The agent must never invent either.

## Clarification

Required draft fields: the common result fields, nonempty `acceptance_criteria` with unique `id`, `requirement`, and `verification`; `scope_exclusions` array; and `questions` array. Each question needs `question` and boolean `material`. Material questions need nonempty `answer` and `user_response`; an unanswered nonmaterial question needs an explicit `assumption`. The summary and referenced brief must describe the goal, behavior and scope being proposed, decisions, assumptions and material limitations.

Resolve every earlier evidence/investigation exception in `exception_decisions` with `phase`, `code`, `resolution` and `reason`. Resolution is `resolved` (requires nonempty `evidence` file paths), `not_material` (reasoned scope/evidence justification), or `accepted_by_user` (requires `user_response`). Material gaps cannot be dismissed as immaterial merely to proceed. For bug/mixed investigations whose reproduction did not succeed, the `not_reproduced` exception has the stricter waiver rules above; generic exception resolutions cannot override them.

1. Prepare the brief and draft result, without `alignment`.
2. Run `present` to validate and freeze the proposal. It returns `proposal.id`, its hash and saved JSON path. This records a proposal ready to show; it does not send a message to the user or grant approval.
3. Show its summary in the conversation: proposed behavior/scope, exclusions, acceptance criteria, verification and material limitations. Explicitly ask for approval and wait.
4. If the user requests changes, revise/groom and repeat `present` and the user-facing summary. Every presentation creates a new proposal ID, making previous approvals stale.
5. After an actual approving response, submit the exact draft to `complete`, adding the following `alignment` (and the current phase token). The controller requires the content to match the recorded proposal.

```sh
node "$SKILL_DIR/scripts/workflow.mjs" present ABC-123 --out "$WORK_DIR" --phase clarification --input /path/clarification-draft.json
# Show summary and wait for the user's approval before the next command.
node "$SKILL_DIR/scripts/workflow.mjs" complete ABC-123 --out "$WORK_DIR" --phase clarification --input /path/clarification-approved.json
```

```json
{
  "status": "confirmed_by_user",
  "proposal_id": "id-returned-by-present",
  "rationale": "User approved the presented scope and acceptance criteria.",
  "user_response": "Quote or reference the actual approving response here."
}
```

This object belongs in the result's `alignment` field. Never fabricate it or use an original implementation request as approval. `clear_from_existing_instructions` is no longer accepted. Approval of individual answers does not approve the full summary. A response requesting changes requires revision and a new approval. A bare skill invocation never skips this step, even for an unambiguous ticket. Review-only scope ends before clarification; clarify-only scope ends after approval without authorizing implementation.

Pending proposals remain in progress with a wait-for-approval next action. `status` and `session continue` return the proposal, so resuming does not require re-presentation when it is unchanged. Referenced artifacts and the frozen proposal are hashed; editing them invalidates clarification and downstream phases. Blocking or invalidating clarification discards its proposal. Completed approval is preserved only while its evidence and requirements remain valid. State schema 7 reopens investigation and downstream phases for schema 6 bug/mixed sessions, requiring fresh reproduction validation or omission permission; feature-only progress is retained. Schema 5 first receives the earlier handoff migration. Older sessions are archived and restart phase validation rather than trusting approvals made under the former optional gate.

## Implementation

Run `start implementation`, generate a bound handoff, then `assert implementation` before delegating source edits. Follow [implementor.md](implementor.md) for worker execution, report review, fallback and recovery. The assert command uses the same `--phase implementation` syntax and exits nonzero if the phase is not authorized by prior completions/scope.

Implementation additionally requires `repository_review`; verification requires nonempty `verification_receipts` produced by `verify.mjs`. See [implementor.md](implementor.md) for repository coverage, runner commands and recovery.

Implementation and verification results both require `assignment_id`, `proposal_id`, and `requirements_sha256` matching the active handoff, plus the main agent's nonempty `parent_review`. Only the main agent submits phase results. The worker supplies reports without phase tokens; the main agent adds its current token after reviewing the diff/evidence.

Result: `addressed_criteria` must contain exactly the agreed IDs; `changed_files` lists all changed repository files, including tests. Paths must resolve inside the configured repository. The controller records their content hashes (a missing file is recorded as deleted). If no files changed, provide `no_change_reason` and a `no_code_change` exception. Do not claim a change to an unrelated/missing file to satisfy the schema. The controller cannot discover omitted files automatically.

## Verification

`criteria` covers each agreed ID exactly once, with `status: "passed"`, a nonempty `result`, and nonempty `evidence` file paths. `checks` lists checks run as `{command, exit_code: 0, evidence: "/path/to/log"}`. An empty checks array requires `no_tests_reason`; manual verification still needs criterion evidence. Failed or unverified criteria/checks must block this phase instead of being submitted as complete.

Bug/mixed results also include `reproduction_recheck: {status: "passed", result: "..."}`. If the original bug could not be reproduced, `status: "not_reproduced"` is permitted only with a `runtime_unverified` exception, and the acceptance criteria must still be verified by the agreed alternative. A previously reproduced bug requires a passing recheck.

When investigation has an approved reproduction waiver, **every** recheck result (including `passed`) must also include:
```json
{
  "alternative_verification": {
    "plan": "Exact alternative_verification text from the approved investigation",
    "performed": "Concrete post-fix actions actually carried out and observed results",
    "evidence": ["/absolute/path/active-artifacts/post-fix-report.md"]
  }
}
```
This object belongs under `reproduction_recheck`. Evidence must be nonempty and satisfy the same active-session/source restrictions as reproduction evidence. It must also be new post-fix evidence: files recorded by earlier steps (baseline reproduction evidence, waiver requests, proposals, phase results, handoffs) are rejected, as are files last modified before implementation completed. Write this evidence during verification; runs made during implementation do not count. Contents are not compared, because a genuine re-run of a deterministic check can reproduce earlier bytes exactly; never copy earlier evidence to a new path to satisfy this rule. The usual code-bound receipts and acceptance-criterion checks still apply. A `runtime_unverified` exception alone cannot justify skipping verification. If the approved alternative cannot be carried out, block verification; changing that plan requires reopening investigation, a new waiver and renewed requirements approval. The controller checks the exact plan reference and evidence paths, not whether the agent's description is truthful.

## Block, resume, revise

```sh
node "$SKILL_DIR/scripts/workflow.mjs" block ABC-123 --out "$WORK_DIR" --phase clarification --input /path/blocker.json
node "$SKILL_DIR/scripts/workflow.mjs" invalidate ABC-123 --out "$WORK_DIR" --phase clarification --reason 'User changed the required empty state'
```

Block input: `{ "reason": "Need role decision", "questions": [{"id":"Q1","question":"Which roles can save?","material":true}] }`. Question IDs must be unique. The phase stays blocked on continuation until resumed. After `start`, complete the result with `resolved_questions: [{id, answer, source: "user", user_response}]`. Every recorded question in the phase must be answered; material questions require an actual user response. Source can identify other evidence for nonmaterial answers. Ordinary invalidation/configuration changes preserve pending questions, so they cannot bypass this gate. If a new user instruction makes a question obsolete, cite that instruction as its resolution. Explicit session reset clears the question list along with other findings.

Stop active workers before invalidating or resetting. Blocking implementation revokes its assignment. Blocking or invalidating verification revokes its verification binding; a verification-only handoff can replace it without reopening implementation; replacing a worker requires a new handoff.

`invalidate` resets that phase and all downstream phases, preserves previous accepted reports, and records the reason. Use it for new user requirements not yet present in Jira or for code changes beyond the recorded implementation files. No code is reverted. Ticket content/availability changes automatically invalidate from evidence review on preparation, status, continue, or transition. Modified/missing accepted artifacts invalidate their owning phase and later phases; changed recorded code invalidates implementation/verification. A run already in progress may become stale and its token will be rejected.

Completion produces `done: true` only within the configured scope, with `outcome` equal to `complete` or `complete_with_exceptions`. Report the latter's exceptions explicitly. Progress includes revisioned events, accepted result paths and hashes. Reset archives this state and starts a fresh artifact directory, preserving configuration/restrictions and downloaded evidence. Legacy states are archived and restarted under the validated schema.

## Validation limits

The scenario tests exercise controller behavior with fixture reports: phase ordering, scope, question/sign-off gates, artifact integrity, exceptions, stale results, invalidation, resume, reset and legacy migration. They are not proof that a live agent always follows the skill, that user responses are authentic, or that its interpretation is correct. Model outputs, external systems and runtime environments can still vary. Do not advertise reproducible model reasoning.

## Refresh and compatibility

A refresh that loses previously complete comments or remote links retains the prior snapshot, even when that snapshot was already partial because of attachment failures and records the attempt under `refresh-attempts/`. Preparation returns partial/exit 2; status and continue expose `refresh_warning`. Retry transient failures. For persistent failures, run preparation with `--accept-partial` to adopt the new snapshot with explicit missing evidence; changed content invalidates affected phases and must be reviewed/groomed again. This flag does not approve requirements or permit claiming missing evidence was reviewed. Attachment size/download/extraction failures alone do not retain stale ticket content: fresh requirements are adopted as partial automatically. A failed issue fetch remains fatal and retains prior data. All three CLIs (preparation, workflow, session) retry lock contention and use exit 3/`LOCK_BUSY`.

Once the scoped workflow is complete, staging or committing unchanged covered files preserves completion. Content/mode/path changes still reopen implementation. During active implementation/verification, branch/HEAD/index changes still require revalidation.

Versions newer than the supported schema are refused without replacing progress. Reset preserves configuration for schemas 6 and 7; older configs require configuration again, while original user scope remains recorded.
