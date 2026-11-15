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

1. Before editing, make sure `baseline.json` matches the starting commit (`--compare` shows all zero deltas). For behavioral work, record a baseline once per model: `node bench/agent-trial.mjs run --label base-<sha> --runs 3`.
2. Make one change. Update `load-sets.json` if routing changed.
3. Run `node bench/context-bench.mjs --compare` and `node --test tests/*.test.mjs`. Missing safeguards fail the bench.
4. For changes to agent instructions or loading behavior, run the behavioral trial with the same model and run count, then `node bench/agent-trial.mjs compare base-<sha> <label>`.
5. Report the deltas in the change summary. Accept a saving only when gates are unchanged. Then refresh the baseline with `node bench/context-bench.mjs --save` and commit it with the change.

## Behavioral trial details

Each run creates the `tests/create-agent-trial.mjs` fixture, installs only the runtime files (`SKILL.md`, `references/`, `scripts/`) from `--skill-dir` as a project skill, and runs `claude -p` with stream JSON, a pinned `--model`, `--setting-sources project` and bypassed permissions inside the temporary fixture. A simulated user replies after each turn. It approves only while the controller has a pending proposal, answers the fixture's punctuation question, and otherwise tells the agent to proceed. The run stops when the controller reports `done` or after `--max-turns` user turns. `--max-budget-usd` caps each CLI invocation.

To measure an older commit, check it out in a separate worktree and pass it as `--skill-dir`. The fixture, simulated user and metrics come from this checkout, so variants stay comparable.

MCP servers are excluded with `--strict-mcp-config`, so account connectors do not add tool definitions to the measured context.

Recorded per run: total tokens from each invocation's result `usage` (per-message counts are partial streaming values), session cost (the largest `total_cost_usd`, which is cumulative across resumes), request count and peak context for the main agent and for workers (requests with a `parent_tool_use_id`), tool-call counts, handoff modes (whether implementation was delegated), final exception codes, skill files observed through Read or shell commands, controller completion, fixture tests, preservation of the user's draft edit, whether the punctuation decision was asked before approval, and whether approval was requested.

The default model is `claude-haiku-5-5` to keep routine comparisons cheap. Haiku results show relative changes between skill versions, not production behavior. Before accepting a change to agent decisions or loading behavior, confirm it with at least one run of the production model (`--model claude-opus-5-5 --effort low`). Compare token counts rather than dollars across models.

Limits:

- Feature path only. Bug and waiver paths need a live browser and server, so the deterministic layer covers their declared loads.
- Interruption and worker reassignment from the manual [agent trial](../docs/maintainer-notes.md#agent-trial) are not exercised.
- Model behavior varies between runs. Compare medians of at least three runs, treat small deltas as inconclusive, and never trade a gate failure for a smaller context.
- Measures Claude Code only. Kiro or another host needs its own trial.
