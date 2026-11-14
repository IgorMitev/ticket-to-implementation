# Report contracts

Field contracts for phase results. A worker writes its reports without a phase token. The main agent reviews them, adds `phase_token`, `parent_review` and (for implementation) `repository_review`, and submits them with `complete`.

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

## Binding

Implementation and verification results need `assignment_id`, `proposal_id` and `requirements_sha256` exactly as in `binding.json`. A verification-only assignment also needs `implementation_sha256`. Include the handoff packet's `resolved_questions`. The main agent adds a nonempty `parent_review` describing the checks it actually performed.

## Implementation result

- `addressed_criteria`: exactly the agreed criterion IDs.
- `changed_files`: every changed repository file, including tests and deleted files. Paths must resolve inside the configured repository. A change to a covered file that is not listed is rejected; do not list unrelated files to satisfy the schema.
- If nothing changed: `no_change_reason` and a `no_code_change` exception.
- `repository_review` (main agent): its review of the baseline user edits and all resulting changes.

## Verification result

- `criteria`: each agreed ID exactly once as `{id, status: "passed", result, evidence: [paths]}`.
- `checks`: each check run as `{command, exit_code: 0, evidence: "/path/to/log"}`, using the log returned by `verify.mjs`. An empty array requires `no_tests_reason`; manual verification still needs criterion evidence.
- `verification_receipts`: nonempty list of receipt paths returned by `verify.mjs` for this assignment and the current code.
- Bug or mixed: `reproduction_recheck: {status: "passed", result: "..."}`. A previously reproduced bug requires `passed`. If the bug was never reproduced, `not_reproduced` is allowed only with a `runtime_unverified` exception, and the criteria must still be verified by the agreed alternative.

A failed or unverified criterion or check blocks verification. Never submit it as complete.

### With an approved reproduction waiver

Every recheck result, including `passed`, also carries this object under `reproduction_recheck`:

```json
{
  "alternative_verification": {
    "plan": "Exact alternative_verification text from the approved investigation",
    "performed": "Concrete post-fix actions actually carried out and observed results",
    "evidence": ["/absolute/path/active-artifacts/post-fix-report.md"]
  }
}
```

The evidence must be new files written in the active artifact directory during verification. Files recorded by earlier steps, or last modified before implementation completed, are rejected, so runs made during implementation do not count. Never copy earlier evidence to a new path. Ticket files and extracted ticket frames are rejected here as they are for reproduction evidence.

The usual receipts and criterion checks still apply; a `runtime_unverified` exception alone does not justify skipping verification. If the approved alternative cannot be carried out, block verification. Changing the plan requires reopening investigation, a new waiver and renewed requirements approval.
