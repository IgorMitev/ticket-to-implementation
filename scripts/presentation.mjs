// Presentation only: never filter the state used by validation or persistence.
export function validateFormat(format = "full") {
  if (!["full", "compact"].includes(format))
    throw new Error("format must be full or compact");
  return format;
}

export function presentStatus(status, format = "full") {
  validateFormat(format);
  if (format === "full") return status;
  const { phases, work_directory, ...compact } = status;
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
