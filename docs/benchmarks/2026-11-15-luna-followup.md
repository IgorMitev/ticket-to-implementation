# Luna follow-up: two matched feature trials

The follow-up did not meet the token/context reduction objective. All four workflows passed independent evaluation, but the candidate used more total tokens in both pairs. Across the two pairs, mean total usage was 20.1% higher and mean peak request input was 12.8% higher than main. Do not present this branch as a demonstrated efficiency improvement.

## What was tested

Baseline remained `9349dd21345695e6a0eb74ad932becb1805bae83`. The new candidate was `aaf2e59`, unchanged between the two pairs. It clarified parent-versus-worker reading, directed agents to save draft responses and select generated paths programmatically, limited routine worker binding checks to existing edit/return boundaries, encouraged safe batching, and kept short comment histories inline using the existing 12,000-character page budget.

Runs `main-2`/`candidate-2` and `main-3`/`candidate-3` used the same fixture and prompts as the original experiment, substituting only version and run paths. All eight provider sessions (four coordinators and four implementors) used `gpt-6-luna`, medium effort. Each coordinator received the same punctuation answer and a subsequent explicit approval of its actual proposal. Each delegated exactly one implementor with no inherited conversation.

Fixture preparation and evaluator work were outside measured sessions. Session totals include every coordinator turn and the worker. Cached input is included in cumulative input; reasoning output is included in output. Tool counts represent top-level provider calls, including orchestration and waits, rather than nested commands. Means below use the two follow-up pairs only; they do not pool the earlier candidate version. Peak is the mean of each run's largest single request, not a sum across agents.

The unchanged fixture has 24 comments, one text attachment, a material clarification, five workflow phases, a tiny Node feature, and an unrelated user edit. It does not test browser/video work, bug reproduction/waivers, live Jira, recovery or interrupted-worker behavior. These remain outside the result's scope.

## Measured results

| Metric (mean per run) | Main | Candidate | Change |
|---|---:|---:|---:|
| Cumulative input | 1,336,622.0 | 1,605,018.5 | +20.1% |
| Cached input, included above | 1,248,192.0 | 1,514,304.0 | +21.3% |
| Uncached input | 88,430.0 | 90,714.5 | +2.6% |
| Output | 13,746.0 | 16,924.0 | +23.1% |
| Total tokens | 1,350,368.0 | 1,621,942.5 | +20.1% |
| Peak request input | 49,031.0 | 55,329.5 | +12.8% |
| Top-level tool calls | 37.5 | 43.0 | +14.7% |

| Pair | Main total | Candidate total | Total change | Uncached input change |
|---|---:|---:|---:|---:|
| 2 | 1,232,127 | 1,708,742 | +38.7% | -1.2% |
| 3 | 1,468,609 | 1,535,143 | +4.5% | +6.4% |

The large variation matters: neither the two-pair mean nor a comparison with the original one-pair result establishes a causal effect for an individual edit. More cached cumulative input is not equivalent to the same increase in dollar spend. No pricing calculation was made.

## Workflow and observed instruction adherence

All four runs completed the five controller phases with `complete`, no recorded exceptions, a real mock-customer clarification and subsequent approval, one bound implementation worker, registered verification receipts, preserved user notes, and correct independent behavior checks. Repository tests passed in each run. The follow-up code suite also passed all 101 tests.

The intended parent loading changes were observed: neither candidate coordinator read raw `issue.json` or the worker-only `implementor.md`. All comments were retained inline and reviewed, with no paging overhead for the small fixture. Both candidate workers received the approved implementation context and avoided a second read of the Markdown requirements brief.

Draft handling was inconsistent. The pair-3 worker saved its draft response and selected report paths/content programmatically as instructed. Coordinators still retyped generated report paths; pair 3 reread an evidence draft. Pair 2's worker reconstructed a wrong skill path and initially tried editing from the wrong working directory, then recovered. Both candidate workers attempted to read a nonexistent `package.json`. Repeated reads, additional checks and report operations still contributed to request/context overhead. No source correction or evaluator coaching was introduced mid-trial.

The pair-3 implementor used fewer total tokens than its baseline counterpart (241,999 versus 294,005), but its coordinator consumed more (1,293,144 versus 1,174,604). Pair 2 regressed in both roles. This supports examining coordinator overhead rather than assuming worker isolation or file splitting guarantees overall savings.

## Assessment and next decision

The executable workflow and the tested approval/evidence/receipt safeguards were preserved. The context-efficiency goal was not achieved. The evidence-led maintenance goal was served by recording both failures and successful adherence without claiming cost savings.

Further prose additions are not justified by these results alone. A next experiment should reduce controller/report handling work deterministically, or selectively remove optimizations that add overhead on small full-workflow tasks, while retaining the same gates. Test one change at a time against fixed snapshots. Do not remove approvals, reproduction requirements or evidence validation to improve a token score. Do not merge the present branch on the claim that it reduces tokens; its routing/maintainability merits would need a separate rationale.

## Artifacts

- Aggregate and per-role numbers: `2026-11-15-luna-followup.json` alongside this report.
- Reusable setup and measurement tools: `tests/mock/`.
- Local fixture and full runs: `~/Work/Singular/skill-mock/runs/{main,candidate}-{2,3}`.
- Local provenance: `~/Work/Singular/skill-mock/experiment-followup-all.json` (exact prompts and delegated task/thread IDs).
- Local combined report/chart: `~/Work/Singular/skill-mock/report-followup/`.

Provider log paths and raw transcripts remain local; published aggregates omit session identifiers. Follow the original benchmark README to provision fresh runs without overwriting earlier evidence.
