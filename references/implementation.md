# Implementation

The main agent owns user interaction, scope decisions, workflow transitions and review. One implementor owns source edits and checks. Scripts prepare and validate handoffs; the host launches workers.

### Assign an implementor

1. Read repository instructions and inspect the current diff. Establish existing user changes and make sure no other writer is active.
2. Start implementation and write a handoff input with its phase token: `{"phase_token":"...","mode":"subagent"}`.
3. Run `node "$SKILL_DIR/scripts/workflow.mjs" handoff ABC-123 --out "$WORK_DIR" --phase implementation --input /path/handoff-input.json --format compact`. The returned `assignment` gives the handoff path, binding path, assignment ID and output directory. The packet already contains the approved criteria, decisions, reproduction details and references to further evidence. For browser rechecks, ensure those references identify the Chrome MCP integration, intended session/page and page ownership; transfer browser control explicitly. The worker must confirm access in its own context.
4. Run `node "$SKILL_DIR/scripts/workflow.mjs" assert ABC-123 --out "$WORK_DIR" --phase implementation --format compact` before delegating.
5. Spawn one implementor with the prompt below, supplying only the packet, the returned `assignment.worker_brief` path and repository instructions. Do not open the worker brief in the main agent; the worker loads it. Prefer no inherited conversation; if the host forces inheritance, say that context isolation is limited. Record the host worker ID in a note in the assignment directory so the worker can be resumed.
6. While it works, handle user interaction and blockers, and do not edit the repository. Use completion notifications or a bounded wait consistent with host update requirements; avoid repeated short polling and redundant status nudges. Do not pull its exploration or logs into the main conversation. Scope questions go back to the user; a revised proposal needs new approval before coding resumes.

> Implement the approved ticket in HANDOFF_PATH. Follow WORKER_BRIEF_PATH and repository instructions. Complete every report named in the packet's `return_reports`, or return a bound blocker. Return their paths with a concise summary. The main agent owns user interaction and workflow transitions.

If subagents are unavailable or cannot access the repository, say so and generate the handoff with `mode: "main_agent"` and a nonempty `reason`, then follow the implementor brief yourself with the same binding checks, reports and verification. If the user requires delegation, block instead.

### Accept results

Use this checklist for normal acceptance; load the worker schema only when a validation error needs explanation:

- Compare the diff with approved criteria and baseline user edits; inspect relevant evidence and preserve unrelated changes.
- Require a nonempty summary and artifacts. Relative paths resolve against the active artifact directory, not the assignment directory; absolute evidence paths avoid ambiguity.
- Implementation must cover every agreed ID in `addressed_criteria` and every changed file in `changed_files`. No-change results require `no_change_reason` and a `no_code_change` exception.
- Verification must cover each agreed ID exactly once with a passed result and evidence, plus registered receipts for this assignment and unchanged code. Inspect check logs; failed or unverified criteria block completion. Bug/mixed work also needs its reproduction recheck; waiver cases follow [verification](verification.md).

For each accepted report, preserve its binding (`assignment_id`, `proposal_id`, `requirements_sha256`, any `implementation_sha256`) and `resolved_questions`. Add only the current `phase_token`, your actual `parent_review`, and for implementation `repository_review`. Never repair a stale binding. Submit implementation with `complete`, then start verification. Use [worker-reports.md](worker-reports.md) only to diagnose an unexpected report defect; controller validation remains authoritative.

For blockers, interrupted or lost workers, replacement, or scope changes, follow [worker problems](recovery.md#worker-problems).
