# Verification

Submit the worker's prepared verification report when its evidence still matches the code. Rerun checks only when changes or unresolved concerns justify it. With a reproduction waiver, do not wait for that report before accepting implementation: resume the worker once verification has started so it can perform the approved alternative and produce fresh evidence.

For browser work, perform the [ownership and cleanup check](browser-reproduction.md#browser-ownership-and-cleanup) before final handback, and disclose any retained pages or cleanup limitations.

Add the phase token and `parent_review` and submit the unchanged worker verification findings. Add review fields to the returned unaccepted report itself; do not create a second copy solely for parent review. Never edit an accepted report or its hashed evidence. With no reproduction waiver, expect both reports from the initial worker return; do not request a second run solely because verification has now started. With a waiver, follow [the waiver requirements](reproduction-waiver.md#later-phases).

Completion returns `done: true` only within the configured scope, with `outcome` `complete` or `complete_with_exceptions`. Report the exceptions of the latter explicitly.
