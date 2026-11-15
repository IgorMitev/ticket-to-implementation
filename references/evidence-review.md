# Evidence review

Read the manifest’s `review_ticket` including inline comments, plus every `comment_pages` entry when paging is present, recording reviewed page paths and material decisions in `evidence-review.md`. Keep full `ticket.md` as a fallback, not a second mandatory read. For a video worker, supply the compact ticket view, relevant comment paths and user constraints; the main agent owns complete comment coverage.

`attachments` must cover each manifest attachment ID exactly once. Each entry has `id` and `disposition`: `reviewed`, `not_relevant` or `unavailable`. The latter two require `reason`. An `unavailable` attachment, an excluded video, or a partial preparation manifest requires a `missing_evidence` exception. `not_relevant` is not a claim that the attachment was reviewed.

A reviewed video must show as downloaded and prepared in the manifest. Supply `inspected_files` listing every overview contact sheet (absolute paths recommended) and `observations`, each with `timestamp_seconds` within the video's duration and an `observation`.

```json
{
  "id": "10042",
  "disposition": "reviewed",
  "inspected_files": ["/absolute/ticket/evidence/10042/contact-001.jpg"],
  "observations": [{"timestamp_seconds": 2.4, "observation": "The dialog remains visible after Save."}]
}
```

If the ticket has no video attachments, include `no_video_reason`.
