# Browser reproduction and rechecks

Read for bug/mixed preflight and browser reproduction or post-fix rechecks. These rules also apply to delegated workers. The main agent owns user questions; workers return blockers to it.

## Preflight

Use Chrome through Chrome DevTools MCP (`chrome-devtools`) for issue reproduction and browser rechecks. Do not silently substitute another browser integration; a different integration requires an explicit user instruction. Use the tools and schemas advertised by the connected server, allowing for host-specific name prefixes.

Before starting bug or mixed investigation, confirm the MCP tools are exposed and call the page-listing tool (`list_pages`). A successful response confirms callable browser access; a configured server name alone does not. An empty page list or another integration's empty browser inventory does not establish that Chrome DevTools MCP is disabled. Select the intended Chrome page/session or create a temporary page at the supplied app URL with `new_page` once the server details below are known. If the tools are absent, disabled or fail to connect, ask the user to enable/connect Chrome DevTools MCP and pause dependent investigation. Read [Kiro Chrome setup](setup.md#chrome-in-kiro) only when configuration is needed.

The main agent and any worker performing browser checks must each confirm access to this MCP integration in their own tool context. Main-agent access does not establish worker access. A worker that cannot connect returns the exact missing capability or tool error to the main agent; it must not silently switch browsers or replace runtime verification with code inspection. Browser access and app authentication are separate: use the intended Chrome profile/session, and do not assume a newly launched Chrome session shares the user's login.

If reproduction needs a dev server, obtain from the user:

- The complete base URL: explicit scheme, host and port. Never infer these or default to localhost.
- A known-good route on that origin.
- Whether the browser session is already logged in, and any required account/role context without credentials.

The user must start and keep the server running for the entire task. Agents must never start or restart it, including through setup, test scripts, workers or alternate ports. Check repository commands before running them if they might launch a dev server. If details are missing, ask for them; do not probe guessed endpoints. Reuse the supplied browser session, without assuming a command-line request shares its login.

Only check reachability, for example:

```sh
node "$SKILL_DIR/scripts/check-dev-server.mjs" --base-url "$USER_BASE_URL" --route "$KNOWN_GOOD_ROUTE" --insecure
```

The helper makes a bounded GET, expects HTTP 200, returns compact JSON and does not follow redirects or save response bodies. `--insecure` disables certificate verification only for that request; never disable TLS checks globally. Save the result with the agent's file tools in the active artifact directory. HTTP 200 does not prove login or application health. If the route requires authentication and the check fails, ask for a reachable route rather than extracting browser credentials.

If the server becomes unavailable at any point, pause dependent work and ask the user to restart it at the supplied URL. Workers return a blocker to the main agent. Recheck reachability before resuming. A missing server does not authorize an agent to start one or bypass the reproduction/verification gates.

Record the supplied details, login state, MCP integration, intended Chrome session/page and actual preflight results in `reproduction.md`. Include those references in browser-worker handoffs; do not copy cookies or credentials. Existing blocked-result and user-waiver rules still apply; a waiver never authorizes starting a server.

## Inline evidence and rendered UI

Prefer Chrome DevTools MCP's accessibility snapshot (`take_snapshot`) to read rendered UI, using snapshot identifiers for interactions. Light-DOM `document.querySelector` does not pierce shadow DOM. If scripting is necessary, explicitly traverse each relevant `shadowRoot` boundary; document inaccessible closed roots instead of claiming their contents were inspected.

Do not use browser MCP `filePath` options to save screenshots, snapshots or responses: its filesystem root may differ from the agent's. Request inline results instead. Persist returned text/JSON with the agent's own file tools in the active ticket artifact directory; decode returned image bytes/base64 through the agent's code tools and save the original image format. Save actual tool output, not a fabricated screenshot or a description substituted for image data.

For scripted inspection, return bounded serializable values from `evaluate_script`, then persist those values with the agent's file tools. Avoid entire DOMs and unbounded network payloads. If inline image data is unavailable, record that limitation and use other genuine evidence; do not fall back to the browser's file-writing option or claim a screenshot was saved.

## Controlled response overrides

When live data cannot reliably trigger a data-driven UI bug, a scoped browser response override may reproduce the UI condition. Inspect the actual request and transport first. Angular HttpClient commonly uses XMLHttpRequest, but can use a fetch backend: patch the observed transport, not an assumed one. For XHR, patch `open` and `send` plus the `responseText` and `response` getters; a fetch-only patch will not intercept XHR.

For a successful JSON GET handled by XHR, the bundled `scripts/xhr-response-override.js` is a reusable helper:

1. Read that helper only for this case and evaluate its source in the inspected page's own JavaScript realm using the browser scripting tool. It installs nothing until `install` is called.
2. Call `globalThis.__ticketXHR.install({url: EXACT_OBSERVED_ABSOLUTE_URL, body: FIXTURE_OBJECT})` through the scripting tool. The helper matches the exact URL including query and method GET, and overrides only successful completed text/JSON responses. It leaves the real request in place; use a non-mutating endpoint. Install before triggering the application's next request.
3. Trigger the UI action, inspect the symptom with an accessibility snapshot or inline screenshot, and inspect `globalThis.__ticketXHR.status()`. Require a matched request AND an observed symptom; installation alone proves neither.
4. In cleanup, including after errors or a negative result, call `globalThis.__ticketXHR.remove()` and verify `active: false`. Then reload/retrigger the unmodified view to clear injected application state. Do not leave hooks active while awaiting a user answer. The helper restores the saved methods/getters and removes its global on removal. If navigation replaced the page realm, verify the helper is absent there and reload the view.

If the application uses a different transport, response type, method or realm, adapt the override narrowly to that observed request rather than broadening interception. Preserve native behavior for every other request; preserve originals and provide unconditional cleanup. Do not persist overrides into app source, backend data, storage or shared browser configuration.

Record the exact request, fixture source/content, transport, observed match, before/after UI evidence and cleanup outcome in `reproduction.md` (and post-fix evidence for rechecks). Label this as reproduction with injected data; it proves UI behavior under that condition, not that the backend naturally returned it. Reuse the same condition for post-fix verification, then remove it again.

## Browser ownership and cleanup

List existing Chrome pages before creating temporary pages; treat existing pages as user-owned unless ownership is explicitly known. Record IDs of agent-created pages and their current owner in the current phase evidence. Give one agent exclusive control of browser automation at a time. When handing browser work to another agent, pass the intended Chrome session/page, whether it is user-owned or temporary, and who must clean it up. The worker verifies its own MCP access before browser checks.

On success, a blocker, failure or cancellation, remove any installed response override and clear injected UI effects before leaving the page. Close agent-created temporary pages with `close_page` when finished, unless the user asked to retain them; the main agent is responsible for any pages it created or took over. Do not close the user's pre-existing pages, terminate their Chrome process, log them out or clear their profile to perform cleanup.

Before the final handback, the main agent calls `list_pages` and checks that all temporary pages created by its workers or itself are closed or intentionally retained. Some Chrome DevTools MCP versions cannot close the last page: leave it clean and disclose that limitation instead of closing a user page or claiming full cleanup. If a lost worker or unavailable MCP prevents cleanup, report the affected page IDs and remaining state. Record actual cleanup outcomes in current phase evidence; never edit an already accepted report in place.
