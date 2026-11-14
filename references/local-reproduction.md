# Local reproduction result

Read this for bug or mixed investigation results; feature-only work does not need this reference.

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

