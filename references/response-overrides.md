# Controlled response overrides

When live data cannot reliably trigger a data-driven UI bug, a scoped browser response override may reproduce the UI condition. Inspect the actual request and transport first. Angular HttpClient commonly uses XMLHttpRequest, but can use a fetch backend: patch the observed transport, not an assumed one. For XHR, patch `open` and `send` plus the `responseText` and `response` getters; a fetch-only patch will not intercept XHR.

For a successful JSON GET handled by XHR, the bundled `scripts/xhr-response-override.js` is a reusable helper:

1. Read that helper only for this case and evaluate its source in the inspected page's own JavaScript realm using the browser scripting tool. It installs nothing until `install` is called.
2. Call `globalThis.__ticketXHR.install({url: EXACT_OBSERVED_ABSOLUTE_URL, body: FIXTURE_OBJECT})` through the scripting tool. The helper matches the exact URL including query and method GET, and overrides only successful completed text/JSON responses. It leaves the real request in place; use a non-mutating endpoint. Install before triggering the application's next request.
3. Trigger the UI action, inspect the symptom with an accessibility snapshot or inline screenshot, and inspect `globalThis.__ticketXHR.status()`. Require a matched request AND an observed symptom; installation alone proves neither.
4. In cleanup, including after errors or a negative result, call `globalThis.__ticketXHR.remove()` and verify `active: false`. Then reload/retrigger the unmodified view to clear injected application state. Do not leave hooks active while awaiting a user answer. The helper restores the saved methods/getters and removes its global on removal. If navigation replaced the page realm, verify the helper is absent there and reload the view.

If the application uses a different transport, response type, method or realm, adapt the override narrowly to that observed request rather than broadening interception. Preserve native behavior for every other request; preserve originals and provide unconditional cleanup. Do not persist overrides into app source, backend data, storage or shared browser configuration.

Record the exact request, fixture source/content, transport, observed match, before/after UI evidence and cleanup outcome in `reproduction.md` (and post-fix evidence for rechecks). Label this as reproduction with injected data; it proves UI behavior under that condition, not that the backend naturally returned it. Reuse the same condition for post-fix verification, then remove it again.

