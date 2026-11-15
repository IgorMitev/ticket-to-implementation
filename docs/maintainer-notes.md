# Maintainer notes

Background for people maintaining the skill. Agents do not need this file at run time and nothing in `SKILL.md` or `references/` links to it: the controller reports these conditions through `next_action` and its rejection messages. Keep it that way so the agent's instructions stay small.

## What the controller does and does not guarantee

The controller validates declarations, artifacts, ordering and changes. It does not invoke an LLM, inspect the semantics of screenshots, prove that a quoted user answer is authentic, or sandbox the host's tools. A host-level tool policy or external orchestrator would be needed to prevent direct source edits or state tampering outside the protocol. Do not claim deterministic model behavior or an enforcement boundary over the whole agent session.

- Evidence review: the controller checks references, not whether images were actually opened or interpreted accurately.
- Reproduction and post-fix evidence: it checks the plan reference and evidence paths, not whether the agent's description is truthful. It cannot infer the provenance of edited or re-encoded bytes.
- Receipts: registration is a declaration, not a security boundary against state tampering. A manual receipt records the agent's observation; it does not prove that the inspection happened.
- `check-worker` does not cancel a running process or prevent edits outside the protocol.
- Repository snapshots cannot determine which writer caused a declared change, do not freeze the workspace, and do not detect an edit that occurs and is reverted between snapshots. Environment, services and ignored dependencies still need appropriate verification.
- Worker context isolation depends on the host. Do not claim measured or guaranteed token savings.

The scenario tests exercise controller behavior with fixture reports: phase ordering, scope, question and sign-off gates, artifact integrity, exceptions, stale results, invalidation, resume, reset and legacy migration. They are not proof that a live agent always follows the skill, that user responses are authentic, or that its interpretation is correct. Live Jira and Kiro integration have not been validated end to end.

## Validation details

### Configuration

- A first configuration, including one after migrating a schema 4 or older session, has no prior kind to compare, so choosing `feature` for a defect is unchecked. Reclassification from bug or mixed to feature is recorded in the event log with its reason.
- The legacy `requires_user_confirmation` option can be omitted or true; false is rejected.
- The `clear_from_existing_instructions` alignment status is no longer accepted.
- Script-generated evidence preparation is the prerequisite represented by `manifest.json`; it is not an agent-set completion flag. Completing `evidence_review` sets the evidence reconciliation marker.

### Local reproduction evidence

Reproduction evidence must resolve inside the active `artifact_directory`. The controller rejects:

- ticket text and manifests, attachment caches, extracted ticket frames and symlink aliases to them;
- known ticket-video directories, even inside active artifacts;
- byte-identical copies or hard links of ticket files, attachments and extracted ticket frames (files under 16 bytes, such as an empty `[]` list, are exempt because they are too common to identify a copy);
- frames in any directory whose `extract-video` manifest names a ticket attachment as its source.

Extracting a local reproduction recording is allowed. The controller hashes reproduction evidence along with report artifacts.

### Post-fix alternative evidence

With a reproduction waiver, `alternative_verification.evidence` must satisfy the same restrictions as reproduction evidence and must be new. Files recorded by earlier steps (baseline reproduction evidence, waiver requests, proposals, phase results, handoffs) are rejected, as are files last modified before implementation completed. Contents are not compared, because a genuine re-run of a deterministic check can reproduce earlier bytes exactly.

### Results and handoffs

The controller saves an immutable-by-convention accepted copy of each result and hashes every referenced file. Changed-file content hashes are recorded; a missing file is recorded as deleted. The handoff packet is generated from accepted results rather than a fresh model summary, and omits raw Jira responses, frames and conversation history. Progress includes revisioned events, accepted result paths and hashes.

## Verification runner

`verify.mjs` writes a log and receipt, hashes repository state before and after, and registers successful unchanged-code checks against the assignment through `record-check`.

- `--timeout` defaults to 600 seconds, maximum 86400. A timeout is recorded as exit code 124.
- On macOS and Linux the runner owns a process group and terminates background descendants when the check exits or times out, and on runner SIGINT/SIGTERM/SIGHUP or process exit. Windows uses direct-child termination.
- Uncatchable termination such as SIGKILL cannot run cleanup handlers; inspect the host's process state before assigning another writer after a forced kill.
- The manual checkpoint is single-use; a failed or completed finish consumes it.
- Workflow and session commands retry lock contention for up to three seconds before exiting 3 with `LOCK_BUSY`.

## Repository snapshots

The handoff links `repository_baseline`: branch, commit, index digest and file hashes at assignment time. Snapshot comparison flags every content, mode or path change since handoff that is not listed in `changed_files`.

- Git repositories cover tracked and non-ignored untracked files; use the repository root. Ignored dependencies, build output and external symlink targets are not hashed.
- Non-Git directories use a filesystem snapshot excluding `.git`, `node_modules` and the dedicated ticket work directory.
- Registered Git submodules are recorded as pinned index commits (gitlinks), without traversing their contents. Changes to those indexed commits are tracked; edits, untracked files and checkout changes inside submodules are ignored and need separate verification.
- Untracked nested Git repositories still cause a clear refusal. Move unrelated clones outside the configured repository or add those untracked clones to `.gitignore`; do not ignore code needed by the task just to bypass coverage.
- Snapshots limit traversal to 20,000 files.
- The repository must not be inside the ticket work directory; configure and snapshots reject that layout.
- During active work, covered repository drift reopens implementation and verification. After the scoped workflow completes, staging or committing unchanged files preserves completion; actual covered file changes still reopen it.

## Ticket preparation

- API JSON requests have a 120-second total timeout. Attachment requests have a 120-second headers timeout, followed by a separate 120-second inactivity timeout that resets as body chunks arrive, so a progressing large download is not limited to two minutes.
- The script constructs attachment URLs from verified issue attachment IDs and does not trust content URLs in ticket text. Authenticated redirects are refused (`redirect=false`). HTTP errors omit response bodies and secrets. Rate limits stop with retry guidance rather than silently looping.
- Comments are paginated. Volatile and system fields such as last-viewed time, watches, worklogs, ordering rank and known computed SLA, development and charting fields remain in raw JSON but are excluded from the readable brief and the evidence-change hash. The evidence hash also excludes transport URLs.
- Remote-link fetch errors yield a partial result.
- The short API-base hash in the cache path keeps different gateway endpoints separate.
- Unchanged attachment IDs and metadata with verified SHA-256 hashes reuse downloads. Frame extraction is reused when the source hash, extractor version and overview frame budget match and all listed images and index files remain present. Failed extraction directories are ignored on a retry.
- Animated GIF attachments are detected and prepared as recordings; a static GIF remains an image. `--skip-video` also skips animated-GIF probing. Animated WebP and APNG are not expanded.
- A refresh that loses previously complete comments or remote links retains the prior snapshot, even when that snapshot was already partial because of attachment failures, and records the attempt under `refresh-attempts/`.

### Locks

A lock prevents concurrent preparation of a work directory. After interruption, a valid lock belonging to a dead process is recovered automatically. Live or uninspectable process locks are preserved. Malformed locks require manual inspection, as does `.prepare.lock.recovery` if a process dies during recovery. A reused process ID may conservatively require manual inspection.

## Video extraction

- Extraction checks the FFmpeg version before processing. FFmpeg creates contact sheets without font libraries or the optional `drawtext` filter, so sheets have no embedded labels; `contact-index.md` and the manifest map each row and column to its frame and timestamp.
- The default interval is 2 seconds, shorter for clips up to 2 seconds and widened to fit the frame budget. Maximum clip output is bounded.
- Detail passes seek before decoding and preserve original playback-relative timestamps. If seeking produces no frames or misses the start by more than one sampling interval plus a nominal frame period, extraction retries once from the beginning.
- Missing container duration is derived by scanning video packet timestamps (with nominal frame duration as fallback), recorded as `duration_source`.
- The decoding timeout is at least ten minutes, increasing to three times the decoded span for long ranges; packet scanning has a ten-minute timeout.
- `source_width`/`source_height` describe encoded dimensions; `extracted_width`/`extracted_height` describe the rotated and resized PNGs. PNGs use 8-bit RGB for image-tool compatibility, with no HDR tone mapping.
- `--audio` extracts mono 16 kHz WAV for the selected interval.

Scripts execute locally, but image review still consumes model tokens: "local extraction" does not mean model inference is offline.

## Session schemas

- Schema 6 bug and mixed sessions reopen investigation and downstream work for the mandatory local reproduction gate. Feature-only schema 6 sessions retain valid progress.
- Schema 5 sessions upgrade without losing valid user approval (missing proposal IDs reopen clarification), but implementation and verification reopen for a handoff.
- Older optional-approval sessions restart under the approval rules. Legacy states are archived and restarted under the validated schema; legacy root-level reports remain preserved but inactive.
- Existing assignments without a repository baseline require stopping or replacing the worker before completion. Previous verification results without receipts must be rerun.
- Versions newer than the supported schema are refused without replacing progress.
- Reset preserves configuration for schemas 6 and 7; older configurations require configuration again, while the original user scope remains recorded. Reset clears the pending question list along with other findings; ordinary invalidation and reconfiguration preserve it.

## Kiro

Import the whole folder with **Agent Steering & Skills → + → Import a skill → Local folder**, or copy it to `.kiro/skills/ticket-to-implementation/` in a repository or `~/.kiro/skills/ticket-to-implementation/` globally. A checkout elsewhere is a reusable source folder, not a location Kiro discovers automatically.

Custom Kiro agents may need `skill://.kiro/skills/*/SKILL.md` or `skill://~/.kiro/skills/*/SKILL.md` in `resources`. A custom parent delegating work needs the `subagent` tool. The skill uses focused task briefs with built-in subagents, so no separate custom agent has to be installed. Check that the selected reviewer can actually open images.

`/ticket-to-implementation continue ABC-123` and `reset ABC-123` are skill arguments, not separately registered slash commands.

## Agent trial

Run `node tests/create-agent-trial.mjs` to create an isolated Git repository and a prepared offline ticket in the system temporary directory. It deliberately includes an unanswered punctuation decision and an existing user edit. Have a fresh main agent use the skill on those paths, obtain simulated-user answers and explicit approval from the evaluator, then delegate implementation and exercise interruption and reassignment. Verify the resulting code with receipts and confirm the user edit survives. Keep the trial's simulated approval separate from real user tasks. This tests agent behavior in the available host, not live Jira or Kiro integration.

## Sources

[Kiro skills](https://kiro.dev/docs/skills/), [Kiro subagents](https://kiro.dev/docs/custom-agents/subagents/), [Jira issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Jira attachment API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/), [Jira remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html).

## Context regression trials

Use completion notifications or longer bounded waits within host communication limits; avoid repeated short waits and progress nudges. Pin the model, host instructions, fixture, simulated responses, negative probes and interruption policy across repeated trials. Report peak input context separately from cumulative cached/uncached input and output. Record controller payload size and model requests alongside gate outcomes. Checkpoints preserve recovery state but do not remove old context. Measure large-video review separately from extraction.

Compact output is a CLI presentation projection; engine state and validators remain complete. Drafts are newly created incomplete files, not submissions or automatic approval. Test stale bindings/tokens, pending proposals, waiver timing and path confinement whenever draft generation changes.

A focused waiver-workflow reproduction found that the instruction to run the generated draft command verbatim failed after implementation completed: the retained packet still named the implementation phase. The worker brief now specifies changing only the phase to verification on that resume. The regression test executes the generated arguments before and after the transition, checks premature verification is rejected, and preserves the original binding and approved alternative plan. This is scripted validation, not a full agent behavioral trial.


## Browser reproduction session fixes

Sessions exposed agents starting their own dev servers, discovering disabled browser tools late, browser artifact writes failing across workspace roots, fetch overrides missing XHR traffic, light-DOM queries missing shadow content, and unrelated Jira custom fields inflating ticket context. The corrections live in the conditional browser reference, parent/worker routing and the readable engineering projection; detailed browser recipes are not added to the shared entrypoint.

`check-dev-server.mjs` checks only the explicit user-supplied origin/route and HTTP status. It does not launch services, establish browser login or prove application health. Its certificate bypass is local to the request. The browser reference prohibits server startup even through workers or test commands. These remain agent instructions, not a host-level execution sandbox or new controller-enforced preflight gate.

`xhr-response-override.js` is evaluated in the page realm only when needed. It substitutes successful JSON/text GET response bodies for an exact URL, including query, and preserves other requests. It does not mock network failures, change status/headers or suppress the real request. The fixture tests exercise descriptors, getters, matching and removal; they do not establish behavior in a live browser MCP or application framework.

`ticket.md` includes only populated engineering allowlist fields. Custom engineering fields are resolved from Jira display names, without instance-specific IDs; unidentified custom fields are omitted from the readable projection. Raw issue data and the separate evidence hash policy are preserved, so a non-allowlisted custom-field change can still invalidate saved evidence. Narrowing serialization does not silently narrow change detection.

For a host-level behavioral trial, use a user-managed disposable app/session and confirm:

- Disabled browser MCP: the agent asks for enablement before investigation and starts no server.
- Missing URL details or server loss: it asks for the missing details/restart, never guesses an origin or launches a server; workers return blockers.
- Browser file-writing rejected by a different workspace root: the agent still saves genuine inline screenshot/JSON results using its own file tools.
- A shadow-root UI: the agent reads the accessibility snapshot, or explicitly traverses shadow roots if scripting is needed.
- A successful XHR GET carrying a rare data condition: only the exact request receives the fixture, the symptom is observed, and methods/getters plus application state are restored after success and failure. Repeat the condition after the fix.

Keep these live trial outcomes distinct from unit tests. No live browser/MCP trial or measured cost reduction is implied by the fixtures.


## Chrome integration follow-up

The full Luna mock trial completed all five phases in T3, but its worker initially checked an unrelated empty browser inventory, and two agent-owned pages remained open after the agent returned. The parent corrected tool discovery and closed the pages. These observations do not establish a Kiro or Chrome DevTools MCP failure: the trial used T3's shared browser, and agent-managed server startup was a mock-only exception.

Runtime browser guidance now names Chrome DevTools MCP, checks callable page-listing access separately for the main agent and browser workers, and records session/page ownership for handoff and final cleanup. Existing user pages and authenticated sessions are preserved. Kiro configuration is conditional setup guidance; T3-specific discovery commands are not part of the skill.

Documentation/link checks and scripted controller tests cannot validate the Kiro connection. A Kiro + Chrome DevTools MCP trial is still required to verify tool access in delegated workers, inline artifacts and ownership-based cleanup in the intended host. The workflow schema and completion guarantees are unchanged; browser ownership/cleanup remain declared agent behavior rather than controller-enforced facts.

## Context loading follow-up

Static review found that current-phase guidance shared one large file, two routine command examples omitted compact output, browser readers loaded the exceptional override recipe, and workers reread approved narrative alongside generated requirements. Phase procedures and response overrides now have separate routes; delegation explicitly prefers isolated context.

New clarification drafts include `implementation_context` for approved narrative details not already expressed in structured fields. It is frozen with the proposal and copied into the handoff; workers retain the approved-brief fallback for older results. The controller checks nonempty text when present, not semantic completeness. Main agents must keep it consistent with the presented brief and include every relevant decision.

Preparation preserves full `ticket.md`, raw comments and evidence hashing. `ticket-review.md` points to ordered comment pages (up to 20 comments or approximately 12,000 characters; a single oversized comment remains intact). All pages still require main-agent review. This bounds ordinary read batches, not total comment-review tokens. A refreshed snapshot gets a separate page directory, and retained failed-refresh snapshots keep their old views. Video `review.json` omits duplicate frame mappings; `contact-index.md` remains the complete timestamp mapping. Cache reuse regenerates missing review views without re-extracting footage.

Regression fixtures cover projection completeness, refresh behavior and approved-context integrity. No live host trial or measured token/cost reduction is implied. Compare equivalent feature, bug/waiver and large-evidence trials before claiming savings; especially verify that workers preserve narrative-only decisions and that main agents review every comment page.

The first paired Luna feature trial preserved all tested workflow gates but increased total tokens by 25.0%; see [the measured results and trace observations](benchmarks/2026-11-15-luna-feature.md). This single pair does not establish general savings or regressions for every optimization.


## Follow-up to the first measured trial

The first pair exposed raw Jira and worker-only reads by the coordinator, a retyped draft filename error, an unnecessary draft reread with a shell-quoting error, and redundant worker binding checks. Runtime guidance now distinguishes parent/worker reads, requests specific raw fields only for an unresolved question, captures draft stdout for programmatic path selection, and keeps checks at the existing edit/return boundaries. Sequential controller calls can share one code-mode call only when no decision intervenes and failures stop the sequence. No gate, receipt or stale-binding validator changed.

The small fixture's 24 short comments previously forced two pages despite fitting comfortably in one bounded read. Histories of at most 12,000 rendered comment characters now remain inline; larger histories retain complete paged coverage. This uses the existing page budget as a conservative threshold, not a measured universal optimum. Tests cover both projections and refresh preservation. Subsequent matched behavioral runs are needed to assess whether agents follow the guidance and whether savings result.

Two matched follow-up pairs against `aaf2e59` preserved the tested workflow but still increased mean total tokens by 20.1% and mean peak request input by 12.8%. See [follow-up measurements and adherence findings](benchmarks/2026-11-15-luna-followup.md). Parent loading improved; report/path handling remained inconsistent. Further prose-only changes are not supported as an efficiency solution.
