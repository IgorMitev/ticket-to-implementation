# Offline workflow benchmark

Copy this folder into `~/Work/Singular/skill-mock`. Keep immutable copies of the candidate and baseline skill under `skills/`. No Jira account, browser, dev server, package install or network API is needed. `jira.json` is the Jira API fixture; `requirements.txt` is its attachment.

Provision a fresh run with `node setup.mjs SKILL_DIRECTORY NEW_RUN_DIRECTORY`. This uses that skill version's real ticket-preparation code with an in-memory Jira transport. Every run gets the same ticket, a fresh Git repo and one unrelated uncommitted user edit. Existing runs are never overwritten. To repeat, use a new run directory.

Give a fresh Luna main agent the run paths and `SKILL.md`. Direct it to use the prepared offline ticket without a live refresh. It must ask the evaluator about punctuation and then present concrete requirements for approval. The evaluator answers: “Preserve punctuation and underscores exactly; only normalize whitespace and lowercase.” Only after inspecting the actual proposal does the evaluator say: “I approve this summary; proceed.” These are simulated-user responses for this fixture, never real approval for another task.

Use the same model, effort, host, prompts, evaluator responses and worker policy for both versions. Permit one Luna implementation worker. Each main and worker agent first runs `python3 usage.py register RUN_DIRECTORY ROLE`. Do not let agents inspect the other variant or evaluator code. Record thread/task IDs outside agent context. Keep fixture preparation and evaluation outside measured agent sessions.

After all agents have finished, run `python3 usage.py collect RUN_DIRECTORY`. It reads each registered Codex session's last cumulative total, counts cached input as part of input, and reports peak per-request input separately. Record all sessions if the host resets one; do not mistake a T3 thread for a single provider session. Usage updates are a proxy for requests, not a guaranteed API-request count. No dollar estimate is made.

Run `node evaluate.mjs RUN_DIRECTORY` for independent checks, then inspect saved artifacts and conversation for actual approval, delegation, evidence coverage and honest completion. A passed structural check does not prove the agent followed every instruction.

This feature scenario exercises all five workflow phases, comment review, a text attachment, an unresolved decision, explicit approval, delegated implementation, receipts, existing-user-edit preservation and independent behavior checks. It does not measure bug reproduction/waivers, browser ownership, video/image tokens, recovery or interruption. Run matched repeats before treating one pair's token differences as reliable savings.
