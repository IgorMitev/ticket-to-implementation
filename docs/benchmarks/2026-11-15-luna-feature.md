# Luna feature workflow comparison, 2026-11-15

The candidate preserved the tested workflow but did not meet the context/token reduction objective in this paired trial. Total tokens increased 25.0%, uncached input increased 12.0%, and peak request input increased 12.5%. This is one exploratory pair, not a statistical estimate or a dollar-cost comparison.

## Reproduction and measurement

- Baseline: `9349dd21345695e6a0eb74ad932becb1805bae83` (`main`). Candidate skill: `9500643` (`optimize-agent-context`). Later report/tooling commits did not change either immutable trial snapshot.
- Reusable harness: `tests/mock/`; materialized at `~/Work/Singular/skill-mock`. The fixture uses a prepared offline Jira Story with 24 comments, one text attachment, an unresolved punctuation choice, and a tiny Node repository with an existing uncommitted user note.
- Both versions used their real preparation/controller scripts. The ticket snapshot hash was identical: `d83c02ae3ebd2275a2ac4ed869228b23fe8c49e562e1102331789ade05cf7109`.
- Each run used a fresh Luna coordinator and exactly one Luna implementor, medium effort. Both workers used no inherited conversation. Initial instructions were identical except variant/run paths. The evaluator supplied the same punctuation answer and approved each actual concrete proposal in a later message.
- Usage includes all three coordinator turns and its implementor session. Fixture preparation, evaluator work and independent post-run checks are excluded. Each provider session's last cumulative usage was read after completion; token events were not summed. Cached input is included in input. Reasoning output is included in output, not added again. Peak is the largest request input across the two sessions.
- Tool-call counts are top-level provider calls, including code-mode orchestration and native delegation/wait tools; they are not counts of every nested shell invocation. Usage-update counts are a request proxy, not an exact API request count.
- Aggregate evidence is in `2026-11-15-luna-feature.json`. Full fixture runs, accepted reports, session registrations, evaluation results and provider-log paths remain in the local mock directory. Raw host transcripts are not published.

## Results

| Metric | Main | Candidate | Change |
|---|---:|---:|---:|
| Cumulative input | 1,217,944 | 1,521,422 | +24.9% |
| Cached input, included above | 1,133,824 | 1,427,200 | +25.9% |
| Uncached input | 84,120 | 94,222 | +12.0% |
| Output | 12,223 | 16,447 | +34.6% |
| Total tokens | 1,230,167 | 1,537,869 | +25.0% |
| Peak request input | 48,257 | 54,293 | +12.5% |
| Top-level tool calls | 35 | 42 | +20.0% |

Both roles consumed more in the candidate: coordinator total tokens increased from 986,757 to 1,184,729; implementor total increased from 243,410 to 353,140. These cumulative inputs count reused context on successive requests and should not be mistaken for unique context size.

## Workflow evaluation

Both runs completed all five controller phases with outcome `complete`, no recorded exceptions, actual clarification and subsequent proposal approval, one bound implementation worker, valid verification receipts, and unchanged user notes. Independent evaluator checks passed for lowercase compatibility, outer whitespace, internal whitespace including tabs/newlines, empty input, punctuation/underscores and repository tests. Both implementations produced the same helper expression. Main wrote six tests; candidate wrote four tests with multiple assertions. Test count is not a quality score.

The candidate reviewed both comment pages and recorded their IDs and material decisions. It populated the new approved `implementation_context`; the worker relied on the packet without rereading the Markdown requirements brief. These changes preserved the tested behavior and the punctuation decision.

This scenario does not validate live Jira access, browser reproduction/waivers, browser ownership, video/image review, recovery, interruption or stale-worker replacement. Scripted regression coverage is separate from this behavioral trial.

## Trace observations and interpretation

1. The candidate loaded phase references when needed. In a full five-phase run, it still eventually loaded all phase procedures, so splitting alone did not demonstrate a cumulative saving. It may help narrower scopes, which were not measured here.
2. The candidate coordinator also loaded raw `issue.json` and the worker-only `implementor.md`, contrary to the intended loading policy. This added avoidable context. The baseline coordinator did not load that worker brief.
3. The candidate implementor avoided the second approved-brief read, as intended, but used more separate calls, repeated binding checks, attempted an unnecessary draft reread, and recovered from a malformed shell quote. The coordinator also recovered from a mistyped generated draft filename. Baseline had its own missing-artifact and missing-package-file retries. This pair cannot attribute the net difference to one optimization.
4. Both coordinators already used compact handoff/assert output; fixing the examples offered no observed advantage in this pair.
5. Candidate comment paging retained complete coverage but added index/path overhead and did not reduce the amount of comment text reviewed. It helps organize bounded reads; it does not evict previous context.
6. Baseline reran the unchanged test suite during parent review. Candidate reused the worker receipt. That intended saving was insufficient to offset its other overhead.

Against the maintenance goals: the tested executable workflow and script-based gates were preserved; context efficiency was not achieved in this run; the trial now supplies concrete evidence for narrowly targeted follow-up work. No safeguard should be removed to improve the score.

Before calling this a successful optimization, address the demonstrated unnecessary parent reads, generated-path mistakes and redundant draft/check operations, then run matched repeats. Test small review-only work separately from large-evidence work; consider enabling comment paging only above a justified size threshold. Keep the candidate and baseline prompts/settings fixed. Do not claim that each individual option failed or that this one-pair percentage will generalize.
