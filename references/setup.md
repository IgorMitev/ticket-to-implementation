# Setup and command reference

## Dependencies

Node.js 22+ and FFmpeg 5.1+ (a numbered release build) with matching ffprobe on PATH. The scripts use only Node.js built-ins: there is nothing to `npm install`, and no Python runtime, model API or Jira MCP server is needed. Install FFmpeg with the host's package manager if it is missing (macOS: `brew install ffmpeg`).

## Chrome in Kiro

Issue reproduction and browser rechecks use Chrome through Chrome DevTools MCP. This integration needs Chrome, a supported Node.js LTS runtime and npm/npx separately from the bundled skill scripts. See the [Chrome DevTools MCP requirements and setup](https://github.com/ChromeDevTools/chrome-devtools-mcp#readme).

In Kiro, open the command palette and choose **Kiro: Open workspace MCP config (JSON)** or **Kiro: Open user MCP config (JSON)**. Merge this entry into the existing `mcpServers` object, preserving other servers:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "disabled": false
    }
  }
}
```

The workspace file is `.kiro/settings/mcp.json`; the user file is `~/.kiro/settings/mcp.json`. Enable Kiro's MCP support and save the configuration to reconnect. A `codex mcp add` command configures Codex, not Kiro. See [Kiro MCP configuration](https://kiro.dev/docs/mcp/configuration/) and the [Chrome DevTools Kiro setup guide](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md).

Confirm the main agent and any browser worker can call the connected server's `list_pages` tool. If Kiro uses different agent-specific MCP settings or tool permissions, make this integration available to that worker too; do not assume it inherited main-agent access.

The default MCP configuration may launch a separate Chrome session. If authenticated reproduction needs the user's existing session, arrange the intended connection/profile or have the user log into the inspected Chrome session. Never infer login from the MCP connection alone. For connection options, consult the [Chrome DevTools configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md). Launching Chrome through MCP does not authorize launching the application's dev server; the user supplies and runs that server.

## Jira authentication

The downloader supports **Jira Cloud REST v3**. Supply these through the terminal or agent environment or a secret manager, never as CLI arguments, skill text or source control:

- `JIRA_BASE_URL`: trusted site URL, e.g. `https://example.atlassian.net`.
- `JIRA_EMAIL` and `JIRA_API_TOKEN`: basic authentication.
- Optional `JIRA_API_BASE_URL`: gateway base, e.g. `https://api.atlassian.com/ex/jira/CLOUD_ID`, for scoped API-token routing.
- Alternatively `JIRA_BEARER_TOKEN`: an existing access token with its appropriate API base. The script does not log in, refresh OAuth or acquire tokens.

Use exactly one authentication method. Existing MCP authentication is not available to the script. Only HTTPS endpoints are accepted and authenticated redirects are refused; if the deployment redirects, use an existing authorized download mechanism. Rate limits stop with retry guidance.

Jira Data Center is not supported. An authorized integration or a manual export can supply local ticket text and attachments for the rest of the workflow, and local video extraction works independently.

## Commands

```sh
node "$SKILL_DIR/scripts/prepare-ticket.mjs" ABC-123
node "$SKILL_DIR/scripts/prepare-ticket.mjs" ABC-123 --out "$WORK_DIR" --fields customfield_10001,customfield_10002
node "$SKILL_DIR/scripts/extract-video.mjs" /path/demo.mov --out /path/new-evidence
node "$SKILL_DIR/scripts/session.mjs" continue ABC-123
node "$SKILL_DIR/scripts/session.mjs" reset ABC-123
```

Exit codes: 0 success; 1 fatal configuration, API or extraction error; 2 partial ticket preparation with errors recorded in `manifest.json`; 3 `LOCK_BUSY`. Stdout contains only artifact paths, counts and status. Do not paste raw JSON or attachment data into the conversation.

### prepare-ticket

- `--out`: use this work directory instead of the persistent default.
- `--fields`: comma-separated custom field IDs to fetch alongside core fields. By default all fields are fetched so custom acceptance criteria are preserved; narrow only when the relevant field IDs are known.
- `--max-mb` (per attachment, default 500), `--max-total-mb` (default 2000), `--max-frames` (per video, default 60).
- `--skip-video`: download only, without frame extraction.
- `--accept-partial`: see [refresh failures](recovery.md#refresh-failures).

Issue keys are case-insensitive. Description, comments, relevant fields and linked-issue references go to `ticket.md`; full responses stay in `issue.json`, `comments.json` and `remote-links.json`. Oversized and failed attachments are recorded in the manifest. Remote links are recorded as titles and URLs only, and related tickets are not fetched.

### extract-video

- `--out`: required, a new directory.
- `--start`, `--end`: seconds; default to the whole recording.
- `--interval`: default 2 seconds, widened to fit the frame budget. An explicit interval that exceeds the budget is refused, so split dense long recordings into ranges.
- `--max-frames`: default 60, maximum 300.
- `--width`: default 1280; 0 preserves resolution.
- `--audio`: also extract audio for the range.

The manifest records the actual first and last frame coverage and any limitations. No HDR tone mapping is applied, so colour-critical interpretation is unsupported.

### Workflow output and drafts

`workflow.mjs` and `session.mjs` accept `--format compact|full` (default `compact`). Compact CLI output preserves warnings, questions, exceptions, pending proposals/waivers and required artifact paths, while omitting null or empty fields, the full assignment/receipt registry and the phase table. Programmatic calls continue returning full state.

`workflow.mjs draft KEY --out WORK_DIR --phase PHASE` writes fresh incomplete report skeletons after the phase is started. Implementation/verification workers must add `--input BINDING_PATH`. It never reads an old report as input or overwrites it. See [draft reports](main-agent.md#draft-reports).

### session

`continue` validates saved artifacts, applies invalidations and returns the next permitted phase. It does not refresh Jira.

`reset` archives progress under `history/` and switches to a new `workflow/<id>/` artifact directory. All phases become pending and evidence must be reviewed again. Downloads, frames, source changes, the controller configuration and the recorded user scope are preserved, and earlier reports stay in their original directory. Reset does not restart work; use `continue` for that.

Both accept `--out EXISTING_WORK_DIR`, which needs no Jira environment variables. Without it, `JIRA_BASE_URL` and any `JIRA_API_BASE_URL` locate the default directory; tokens are not needed. A missing or invalid session fails rather than inventing or deleting state.

## Evidence and caching

The default work directory is `~/.cache/ticket-to-implementation/<site-host>-<api-hash>/<KEY>/`. Use one work directory per ticket, outside source control. If it must live in the repository, give it a dedicated subdirectory, never the repository root; the repository itself must not be inside the work directory.

The directory holds `ticket.md`, `issue.json`, `comments.json`, `remote-links.json`, `attachments/`, `evidence/`, `manifest.json` and the script-managed `progress.json`, plus accepted results and history. Never put credentials there. Raw ticket data can be private; retain and delete it according to the team's normal practice.

Every run fetches current ticket fields and comments. Unchanged attachments and frame extractions are reused. `snapshot_changed` stays true until the controller accepts an `evidence_review` result; fetching again never acknowledges a change. Only current manifest entries count as current evidence, even if older files remain on disk.

## Cache maintenance

Clean the cache only when the user asks, and stop active agents first. No cleanup happens during normal work.

```sh
node "$SKILL_DIR/scripts/cleanup.mjs" --out "$WORK_DIR"
```

This is a dry run that lists unreferenced evidence and refresh attempts older than 30 days (`--days N` to override). Add `--apply` to remove them. Attachments, workflow reports, approval and history records and referenced media are preserved. Cleanup is refused while a phase is active or blocked.
