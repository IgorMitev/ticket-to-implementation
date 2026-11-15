# Reproduction omission waiver

Read this only when a bug or mixed ticket could not be reproduced locally, or a local attempt was impossible. Investigation can then complete only with explicit user permission tied to the recorded limitation and alternative plan. The waiver does not replace requirements approval or post-fix verification.

## Procedure

1. Prepare the full investigation draft: common fields, feature analysis for mixed tickets, and `reproduction` with its evidence, `reason`, `alternative_verification` and a `not_reproduced` exception. Do not include `reproduction_waiver` yet. Resolve any recorded questions with actual answers.
2. Run `request-reproduction-waiver` with the current investigation phase token. It validates and freezes the draft, returns `reproduction_request.id` and its path, and blocks investigation. It does not ask the user or grant consent.
3. Show the user the attempts or blocker and the alternative, ask **"May I proceed without local reproduction for this ticket?"**, and wait for explicit permission. An original "implement this" request, generic approval of requirements, or silence is not permission.
4. Only after permission, run `start --phase investigation` and complete with the unchanged draft, the new phase token and this `reproduction_waiver` object:

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

## Changes after a request

The waiver is tied to the exact draft and its hashed artifacts. `status` and `continue` preserve a pending request.

- To revise the draft, run `invalidate --phase investigation`, reassess, and obtain a new request and permission. Running `start` alone does not allow a second request.
- A generic `block`, a reset, a changed ticket or changed evidence revokes a pending request.
- If local reproduction later succeeds, invalidate investigation, record the actual result and complete without a waiver.
- If circumstances change after an accepted waiver, invalidate and reassess. Report changes in external access yourself; the controller cannot observe them.

## Later phases

- **Clarification:** put `reproduction_waiver_id` in the result and show the omission and alternative in the summary presented to the user. The `not_reproduced` entry in `exception_decisions` must use `resolution: "accepted_by_user"`, `waiver_request_id`, and the same `user_response` as the accepted investigation. `resolved` and `not_material` are rejected for this exception. Approval of the implementation summary remains a separate gate.
- **Implementation:** the worker returns its implementation report first. After implementation completes and verification starts, it carries out the approved alternative and writes fresh evidence.
- **Verification:** include `alternative_verification` as described in the [verification result](worker-reports.md#with-an-approved-reproduction-waiver).

A review-only request also cannot complete bug investigation without reproduction or this permission.
