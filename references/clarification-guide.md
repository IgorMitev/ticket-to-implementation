# Focused grilling

Keep answers, questions, updates and handoff summaries short, concise, meaningful and to the point. Lead with the finding, decision, blocker or question. Avoid long prose, filler and repeated context. Put detailed evidence in linked artifacts while preserving required findings and material limitations.

The main agent runs this conversation. Be constructively skeptical and specific; resolve important uncertainty without turning routine engineering choices into user homework.

1. Present the current understanding in a short brief: user goal, reported behavior, observed evidence, local findings, and material unknowns. Attribute claims to their sources.
2. Ask two to four consequential questions at a time (fewer when sufficient). Offer a recommended answer and its tradeoff when possible. Continue useful independent work while waiting.
3. Follow up where an answer contradicts the ticket, recording, repository behavior, or an earlier decision. Explain the concrete conflict. New user instructions can supersede old ticket text; record that decision.
4. When criteria are testable and material decisions are settled, record the proposal with `present`, show the implementation summary, and explicitly ask the user to approve it. Wait for that response before implementation. If changes are requested, groom them, present a revised proposal, and obtain new approval. Do not repeat answered questions; retain approval only for the same unchanged proposal.

## Feature prompts to select from

- Who needs this and what outcome should improve?
- What initiates the flow, what changes on screen, and what indicates success?
- What is explicitly excluded from this delivery?
- What happens for empty, loading, invalid, duplicate, interrupted, and failed states?
- Which roles can see or perform the action? What happens when access is denied?
- Does existing data need migration, and must old clients/flows keep working?
- Are there design references, accessibility requirements, localization needs, or measurable performance constraints?
- Which concrete examples would prove this is done?

Only ask about these when the task makes them relevant and evidence does not answer them.

## Bug prompts to select from

- What should happen instead, and is that a documented contract or a desired change?
- Which environment, account role, inputs, or sequence triggers it?
- Is it intermittent? Is there a known working version or affected scope?
- If local behavior differs, what missing condition would explain the difference?
- Does a proposed fix alter behavior other users rely on?

## Agreed brief format

Use concise sections: goal; current behavior/evidence; in scope; out of scope; decisions and their sources; numbered acceptance criteria; relevant edge cases; verification approach; unresolved questions. Criteria should describe observable outcomes, preferably with preconditions and expected results. Technical choices can remain agent-owned unless they affect product behavior, risk, or scope.

If no material questions remain, record and present the brief and still wait for explicit approval of that summary. If blocked, record the exact unanswered question and which work depends on it; never treat silence as agreement.
