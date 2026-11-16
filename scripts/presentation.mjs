// Presentation only: never filter the state used by validation or persistence.
export function validateFormat(format = "full") {
  if (!["full", "compact"].includes(format))
    throw new Error("format must be full or compact");
  return format;
}

export function presentStatus(status, format = "full") {
  validateFormat(format);
  if (format === "full") return status;
  // Draft output is consumed right after start: the paths and skeletons are all that is new.
  if (status.drafts) return { drafts: status.drafts, draft_contents: status.draft_contents };
  if (status.report_check) return { report_check: status.report_check };
  const { phases, work_directory, revision, ...rest } = status;
  // Absent means none: omit null values and empty lists so routine calls stay short.
  const compact = Object.fromEntries(Object.entries(rest).filter(([, v]) =>
    v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
  if (status.next_phase && phases)
    compact.phase_status = phases[status.next_phase];
  if (status.assignment) {
    compact.assignment = Object.fromEntries(
      ["assignment_id", "proposal_id", "requirements_sha256", "implementation_sha256", "phase", "mode", "reason", "path",
        "binding_path", "worker_brief", "directory"].filter(k => k in status.assignment)
        .map(k => [k, status.assignment[k]]),
    );
  }
  return compact;
}
