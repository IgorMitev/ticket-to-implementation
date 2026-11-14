# Maintaining this skill

These instructions apply when modifying this skill, including its scripts, references and documentation. They are not required reading when using the skill to resolve a ticket.

## Goals and change criteria

Evaluate every change against all four goals. A change may improve one goal while preserving the others; it need not improve all four.

1. **Defined, executable workflow.** Maintain a clear ticket-resolution flow with explicit phase inputs, outputs, transitions and completion criteria. Keep instructions consistent with the implemented controller. Workflow optimizations may change the flow, but must preserve user scope, required evidence, approvals and honest completion reporting. Update affected contracts and tests together.
2. **Deterministic tools through code mode.** Prefer invoking existing scripts through the host's code or command execution tools for repeatable workflow operations. Extend a shared script when it removes repeated agent work or makes a meaningful invariant enforceable. Keep interpretation and user decisions with the agent; do not claim that structural validation proves evidence or reasoning correct. Avoid new scripts for one-off judgment tasks.
3. **Context efficiency.** Load instructions only where and when needed. Keep `SKILL.md` focused on shared rules and routing; put conditional procedures in the relevant references and maintenance details outside runtime instructions. Prefer compact script results, artifact paths and generated handoffs over raw payloads or repeated summaries. Execute scripts without requiring agents to read their source. Treat lower context and cost as goals to measure, not guaranteed consequences of smaller files.
4. **Evidence-led session fixes.** Address demonstrated problems from sessions using the skill. Record the triggering failure or limitation, identify its cause and make the smallest reusable correction. Check the correction against goals 1–3; avoid accumulating universal instructions for isolated incidents. Preserve working behavior and add regression coverage appropriate to the failure.

If goals conflict, make the tradeoff explicit and justify it with evidence. Do not silently remove a workflow safeguard to reduce context or add broad mandatory loading to fix a narrow issue. Follow explicit user instructions and disclose material compromises.

## Before completing a change

- Identify the goal improved and check for regressions against the other goals.
- Validate affected behavior: run relevant script tests for code or contract changes; check links, routing and consistency for documentation changes. The full suite is `node --test tests/*.test.mjs`.
- For changes to agent decisions or loading behavior, use a focused behavioral trial when needed. See [maintainer notes](maintainer-notes.md#agent-trial) and [context regression trials](maintainer-notes.md#context-regression-trials). Distinguish scripted checks from observed agent behavior; compare equivalent trials before claiming context or cost savings.
- In the change summary, state the problem, the resulting behavior, validation and any material tradeoff or unverified claim. Keep this proportional to the change rather than creating a separate report for every edit.
