# Clarification

The draft needs:

- `acceptance_criteria`: nonempty, each with a unique `id`, a `requirement` and a `verification`.
- `scope_exclusions`: array.
- `implementation_context`: concise goal, additional decisions and sources, assumptions, edge cases and material limitations not already captured in the structured fields. Include every implementation-relevant detail from the approved brief; use an explicit “No additional context” when there is none. This text is part of the frozen proposal and must be presented for approval. Older results without this field require workers to read the approved brief.
- `questions`: array of `{question, material}`. A material question needs a nonempty `answer` and `user_response`. An unanswered nonmaterial question needs an explicit `assumption`.
- `exception_decisions`: one entry per earlier evidence or investigation exception, with `phase`, `code`, `resolution` and `reason`. `resolved` requires nonempty `evidence` file paths, `not_material` requires a reasoned scope or evidence justification, and `accepted_by_user` requires `user_response`. Do not dismiss a material gap as immaterial to proceed. A `not_reproduced` exception from an unreproduced bug follows the stricter [waiver rules](reproduction-waiver.md#later-phases).

The summary and the referenced brief must describe the proposed goal, behavior and scope, decisions, assumptions and material limitations.

1. Prepare the brief and the draft result, without `alignment`. Compare the structured fields plus `implementation_context` against the brief to ensure no implementation-relevant decision or limitation exists only in the artifact.
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
