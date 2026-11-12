# Setup and command reference

## Kiro

Import this whole folder using Kiro's **Agent Steering & Skills → + → Import a skill → Local folder**, or copy it to `.kiro/skills/ticket-to-implementation/` in a repository or `~/.kiro/skills/ticket-to-implementation/` globally. Its present location is a reusable source folder, not an automatically discovered Kiro location. Invoke `/ticket-to-implementation ABC-123` and identify the repository when ambiguous.

Custom Kiro agents may need `skill://.kiro/skills/*/SKILL.md` or `skill://~/.kiro/skills/*/SKILL.md` in `resources`. A custom parent delegating work needs the `subagent` tool. The skill uses focused task briefs with built-in subagents, avoiding a separate custom-agent installation. Check that the selected reviewer can actually open images.

## Dependencies

Node.js 22+, FFmpeg 5.1+ (a numbered release build) and matching ffprobe on PATH. Extraction checks the FFmpeg version before processing. All JavaScript uses Node.js built-ins: there are no npm packages to install and no `node_modules` directory is needed. From the skill folder, run tests directly:

```sh
node --test tests/*.test.mjs
```

Install FFmpeg using your host's package manager if missing (macOS: `brew install ffmpeg`). FFmpeg creates contact sheets without font libraries or the optional `drawtext` filter. Sheets have no embedded labels; `contact-index.md` and the manifest map each row/column to its frame and timestamp. No Python runtime, model API, or Jira MCP server is required. Scripts execute locally; image review by Kiro still consumes model tokens. “Local extraction” does not mean Kiro's model inference is offline.

## Jira authentication

The downloader supports **Jira Cloud REST v3**. Supply these via your terminal/agent environment or secret manager, not CLI arguments, skill text, or source control:

- `JIRA_BASE_URL`: trusted site URL, e.g. `https://example.atlassian.net`.
- `JIRA_EMAIL` and `JIRA_API_TOKEN`: basic authentication.
- Optional `JIRA_API_BASE_URL`: gateway base, e.g. `https://api.atlassian.com/ex/jira/CLOUD_ID`, for scoped API-token routing.
- Alternatively `JIRA_BEARER_TOKEN`: an existing access token with its appropriate API base. The script does not implement login, OAuth refresh, or token acquisition.

Use exactly one authentication method. Existing MCP authentication is not automatically available to this script. Jira Data Center is not supported by this downloader; an authorized integration/manual export can supply local ticket text and attachments for the remaining workflow. Local video extraction works independently.

Only HTTPS endpoints are accepted. The script constructs attachment URLs from verified issue attachment IDs and does not trust content URLs in ticket text. Authenticated redirects are refused; if your deployment redirects despite `redirect=false`, use an existing authorized download mechanism. HTTP errors omit response bodies and secrets. Rate limits stop with retry guidance rather than silently looping.

API JSON requests have a 120-second total timeout. Attachment requests have a 120-second headers timeout, followed by a separate 120-second inactivity timeout that resets as body chunks arrive; a progressing large download is not limited to two minutes.

## Commands

```sh
node "$SKILL_DIR/scripts/prepare-ticket.mjs" ABC-123
node "$SKILL_DIR/scripts/prepare-ticket.mjs" ABC-123 --out "$WORK_DIR" --fields customfield_10001,customfield_10002
node "$SKILL_DIR/scripts/extract-video.mjs" /path/demo.mov --out /path/new-evidence
node "$SKILL_DIR/scripts/session.mjs" continue ABC-123
node "$SKILL_DIR/scripts/session.mjs" reset ABC-123
```

In Kiro, invoke `/ticket-to-implementation continue ABC-123` or `/ticket-to-implementation reset ABC-123`. `continue` validates saved artifacts, applies invalidations, and shows the next permitted phase for the agent to resume; it does not itself run an LLM or refresh Jira. `reset` archives progress in `history/` and switches `progress.json.artifact_directory` to a new `workflow/<id>/` directory. Previous findings/requirements remain in their original directory and are referenced by the archive; legacy root-level reports remain preserved but inactive. All phases become pending and evidence needs reconciliation again. Downloads, frames, source changes, controller configuration, and `user_scope` restrictions are preserved. Reset alone stops after resetting; use continue to restart work. Both commands accept `--out EXISTING_WORK_DIR`, allowing local operation without Jira environment variables. Without `--out`, `JIRA_BASE_URL` and any configured `JIRA_API_BASE_URL` locate the default directory, but tokens are not needed. A missing/invalid session fails instead of inventing or deleting state.

`prepare-ticket` flags: `--out` (optional override of the persistent default), `--fields` (optional comma-separated custom field selection, alongside core fields), `--max-mb` (per attachment, default 500), `--max-total-mb` (sum of selected attachment sizes, default 2000), `--max-frames` (per video, default 60), `--skip-video` (download only, also skips animated-GIF probing). Issue keys are case-insensitive. By default all issue fields are fetched so custom acceptance criteria are preserved; use `--fields` only when the relevant field IDs are known and a narrower snapshot is intended. Oversized/failed attachments are recorded, not silently omitted. Comments are paginated. Description, comments, relevant core/custom fields and linked-issue references are written to `ticket.md`; full responses stay in `issue.json`, `comments.json`, and `remote-links.json`. Jira remote-link titles/URLs are fetched as references only; target pages are not downloaded, and remote-link fetch errors yield a partial result. Volatile/system fields such as last-viewed time, watches, worklogs, ordering rank, and known computed SLA/development/charting fields remain in raw JSON but are excluded from the readable brief and evidence-change hash. Related tickets are not fetched recursively.

`extract-video` flags: `--out` (required, new directory), `--start` (seconds, default 0), `--end` (default duration), `--interval` (default 2 seconds, shorter for clips up to 2 seconds and widened to fit the frame budget), `--max-frames` (default 60, maximum 300), `--width` (default 1280; 0 preserves resolution), `--audio`. If an explicit interval exceeds the frame budget, the command refuses rather than silently undersampling. Maximum clip output is bounded; dense long recordings should be split into ranges. Detail passes seek before decoding and preserve original playback-relative timestamps. If seeking produces no frames or misses the start by more than one sampling interval plus a nominal frame period, extraction retries once from the beginning. The manifest records actual first/last frame coverage and any remaining boundary gaps. Missing container duration is derived by scanning video packet timestamps (with nominal frame duration as fallback), recorded as `duration_source`. The decoding timeout is at least ten minutes, increasing to three times the decoded span for long ranges; packet scanning has a ten-minute timeout. `source_width`/`source_height` describe encoded dimensions, while `extracted_width`/`extracted_height` describe the resulting rotated/resized PNGs. PNGs use 8-bit RGB for image-tool compatibility; no HDR tone mapping is applied, so colour-critical interpretation remains unsupported.

Exit codes: 0 success; 1 fatal configuration/API/extraction error; 2 partial ticket preparation with errors recorded in `manifest.json`. Standard output contains only artifact paths/counts. Do not paste full raw JSON or attachment data into the main agent's context.

## Evidence and caching

The deterministic default is `~/.cache/ticket-to-implementation/<site-host>-<api-hash>/<KEY>/`. The short API-base hash keeps different gateway endpoints separate. Use one work directory per ticket outside source control; `--out` preserves an existing custom location. A lock prevents concurrent preparation of that directory. It contains `ticket.md`, `issue.json`, `comments.json`, `remote-links.json`, `attachments/`, `evidence/`, `manifest.json`, and a script-managed `progress.json`. The controller also keeps accepted result JSON, hashes, phase tokens, pending questions and revisioned events. The main agent must never edit progress directly. Never put credentials there. Raw ticket data can be private; retain and delete it according to your team's normal practices.

Every run fetches current ticket fields and comments. Unchanged attachment IDs/metadata and verified SHA-256 hashes reuse downloads; frame extraction is reused when the source hash, extractor version, and overview frame budget match and all listed images/index files remain present. The manifest's evidence hash excludes transport URLs and volatile metadata. `snapshot_changed` stays true until the controller accepts a structured `evidence_review` result and sets its reconciliation marker. Initial and legacy progress files require validated review; repeated fetching never acknowledges it. Preparation invalidates all agent phases on changed ticket evidence or availability. Controller status/continue/transitions also invalidate phases whose accepted reports, referenced evidence, or recorded implementation files changed. Legacy states are archived before migration; old complete flags are not trusted. Old files may remain on disk but only current manifest entries count as current evidence. Failed extraction directories are ignored on a retry.

After interruption, a valid lock belonging to a dead process is recovered automatically. Live or uninspectable process locks are preserved. Malformed locks require manual inspection, as does `.prepare.lock.recovery` if a process dies during recovery; verify no preparation/recovery process is active before removing such a file. A reused process ID may conservatively require manual inspection.

Sources: [Kiro skills](https://kiro.dev/docs/skills/), [Kiro subagents](https://kiro.dev/docs/custom-agents/subagents/), [Jira issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Jira attachment API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/), [Jira remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html).

## Workflow controller

After preparing a ticket, follow [workflow.md](workflow.md) to configure its kind/scope and use `workflow.mjs start`, `complete`, `block`, `invalidate`, and `status`. Structured outputs and artifact hashes enforce phase ordering inside this protocol. The skill does not install Kiro hooks or restrict direct filesystem/tools access; its controller cannot make model behavior deterministic or prove semantic correctness. Tests include complete scripted workflow scenarios, not live-model compliance guarantees.

## Maintainer agent trial

Run `node "$SKILL_DIR/tests/create-agent-trial.mjs"` to create an isolated Git repository and prepared offline ticket in the system temporary directory. It deliberately includes an unanswered punctuation decision and an existing user edit. Have a fresh main agent use the skill on those paths, obtain simulated-user answers and explicit approval from the evaluator, then delegate implementation and exercise interruption/reassignment. Verify the resulting code with receipts and confirm the user edit survives. Keep the trial's simulated approval separate from real user tasks. This tests agent behavior in the available host, not live Jira or Kiro integration.
