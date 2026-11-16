# Context benchmark

Maintainer tooling for measuring context and cost changes. Agents resolving a ticket never load this folder.

Two layers, used together:

| Layer | Command | Cost | Measures |
|---|---|---|---|
| Deterministic | `node bench/context-bench.mjs --compare` | Free, about 2 s | Declared instruction loads per role, CLI output for a feature and a bug run, handoff packet and worker draft sizes, safeguard reachability |
| Behavioral | `node bench/agent-trial.mjs run --label NAME` | Real model usage | Peak context, cached and uncached input, output, requests, cost, observed file loads and gate outcomes of a headless agent on the offline fixture |

Byte counts are exact. The deterministic `tokens_est` values are bytes/4 estimates; only behavioral runs report real tokens.

## Files

- `load-sets.json`: the files (or `file.md#section`) each role is instructed to load per scenario. Edit it in the same change that alters routing, so the measured load matches the instructions.
- `safeguards.json`: rules that must stay reachable for each role, as case-insensitive regexes. `node --test tests/*.test.mjs` fails when one disappears. Reword a pattern only together with the rule it guards.
- `baseline.json`: committed deterministic metrics of the accepted state.
- `results/`: behavioral run records and raw event streams (ignored by Git).

## Workflow for each change

1. Before editing, make sure `baseline.json` matches the starting commit (`--compare` shows all zero deltas). For behavioral work, record a baseline once: `node bench/agent-trial.mjs run --label base-<sha> --runs 3`.
2. Make one change. Update `load-sets.json` if routing changed.
3. Run `node bench/context-bench.mjs --compare` and `node --test tests/*.test.mjs`. Missing safeguards fail the bench.
4. For changes to agent instructions or loading behavior, run the behavioral trial with the same model and run count, then `node bench/agent-trial.mjs compare base-<sha> <label>`.
5. Report the deltas in the change summary. Accept a saving only when gates are unchanged. Then refresh the baseline with `node bench/context-bench.mjs --save` and commit it with the change.

## Behavioral trial details

Each run creates the `tests/create-agent-trial.mjs` fixture, installs only the runtime files (`SKILL.md`, `references/`, `scripts/`) from `--skill-dir` as a project skill, and runs `claude -p` with stream JSON, a pinned `--model`, `--setting-sources project` and bypassed permissions inside the temporary fixture. A simulated user replies after each turn. It approves only while the controller has a pending proposal, answers the fixture's punctuation question, and otherwise gives a neutral reply that cannot be read as approval. The run stops when the controller reports `done` or after `--max-turns` user turns. `--max-budget-usd` caps each CLI invocation, but avoid it for baselines and comparisons: in one Opus run the agent cited a budget-constrained run as its reason to skip delegation.

To measure an older commit, check it out in a separate worktree and pass it as `--skill-dir`. The fixture, simulated user and metrics come from this checkout, so variants stay comparable.

MCP servers are excluded with `--strict-mcp-config`, so account connectors do not add tool definitions to the measured context.

Recorded per run: total tokens from each invocation's result `usage` (per-message counts are partial streaming values), session cost (the largest `total_cost_usd`, which is cumulative across resumes), request count and peak context for the main agent and for workers (requests with a `parent_tool_use_id`), tool-call counts, handoff modes (whether implementation was delegated), final exception codes, skill files observed through Read or shell commands, controller completion, fixture tests, preservation of the user's draft edit, whether the punctuation decision was asked before approval, and whether approval was requested.

The default is `claude-opus-5-5` with `--effort low`, the production configuration. A Haiku baseline was rejected: in three runs it never delegated implementation, so worker-side changes were unmeasurable, and one run abandoned the workflow and edited code without approval. Usage medians cover completed runs only; gates count every run. Compare token counts rather than dollars if the model changes.

Limits:

- Feature path only. Bug and waiver paths need a live browser and server, so the deterministic layer covers their declared loads.
- Interruption and worker reassignment from the manual [agent trial](../docs/maintainer-notes.md#agent-trial) are not exercised.
- Model behavior varies between runs. Compare medians of at least three runs, treat small deltas as inconclusive, and never trade a gate failure for a smaller context.
- `agent-trial.mjs` drives Claude Code only. Other hosts need their own trial; see below for Cursor.

## Cursor, Codex and other host trials

There is no automated driver for other hosts. To compare skill versions on a model such as Grok 4.7 (Cursor) or Luna and Sol (Codex):

1. Build one fixture per variant with `createAgentTrial()` from `tests/create-agent-trial.mjs`, copying `SKILL.md`, `references/` and `scripts/` from each variant into `<root>/skill/ticket-to-implementation`.
2. Start each agent with the same neutral prompt naming that skill directory, the `/ticket-to-implementation TRIAL-1 --out <root>/ticket` command and the repository. Do not frame the agent as an implementation worker or subagent: in one Grok run that framing led the main agent to skip delegation because it considered itself the worker.
3. Answer as the simulated user does: the punctuation decision when asked, approval only for a pending proposal, otherwise a neutral reply.
4. Check gates in `<root>/ticket` (`progress.json`, receipts, handoff mode) and the repository (`node --test`, `notes.txt`), and review the transcript for skill-file and script-source reads.
5. Read usage with `node bench/cursor-usage.mjs AGENT_ID_PREFIX...` for Cursor, or `node bench/codex-usage.mjs FIXTURE_ROOT_NAME...` for Codex models such as Luna and Sol. Codex records every spawned worker as its own session, so its worker usage is complete. Cursor records usage for main-agent turns only; subagent transcripts carry no token counts, so compare delegated runs on turns before implementation, and report the implementation turn as a lower bound.
