import { realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { json } from "./lib.mjs";
import { validateBinding } from "./handoff.mjs";

// Called under the workflow lock, after synchronization and phase checks.
// Always create new files; never repair, refresh or overwrite existing reports.
export async function createDrafts(progress, manifest, workDirectory, phase, input) {
  const worker = ["implementation", "verification"].includes(phase);
  const allowed = worker
    ? ["assignment_id", "proposal_id", "requirements_sha256", "implementation_sha256"]
    : [];
  if (Object.keys(input).some(k => !allowed.includes(k)))
    throw new Error("draft accepts only a worker binding, never an existing report");
  if (progress.phases[phase].proposal || progress.phases[phase].reproduction_request)
    throw new Error("A proposal is pending; use its recorded draft rather than generating another");
  const assignment = worker ? validateBinding(progress, input, phase) : null;
  const root = await realpath(workDirectory);
  const active = await realpath(progress.artifact_directory);
  const directory = assignment ? await realpath(assignment.directory) : active;
  if (!active.startsWith(root + sep) ||
      (directory !== active && !directory.startsWith(active + sep)))
    throw new Error("Draft directory must be inside the ticket work directory");
  const binding = assignment ? Object.fromEntries(
    allowed.filter(k => k in assignment).map(k => [k, assignment[k]]),
  ) : { phase_token: progress.phases[phase].token };
  const common = () => ({ ...binding, summary: "", artifacts: [], exceptions: [],
    resolved_questions: worker ? (assignment.resolved_questions ?? []) :
      progress.unresolved_questions.filter(q => q.phase === phase)
        .map(q => ({ id: q.id, answer: "", source: "", user_response: "" })) });
  const reports = {};
  if (phase === "evidence_review") {
    reports[phase] = { ...common(), attachments: (manifest.attachments ?? [])
      .map(a => ({ id: a.id, disposition: "", reason: "" })), no_video_reason: "" };
  } else if (phase === "investigation") {
    reports[phase] = { ...common(), current_behavior: "", relevant_files: [],
      ...(["feature", "mixed"].includes(progress.config.kind)
        ? { feature_analysis: "", constraints: [] } : {}),
      ...(["bug", "mixed"].includes(progress.config.kind)
        ? { reproduction: { status: "", attempted_locally: null, target: "",
          environment: "", steps: [], expected: "", actual: "", evidence: [] } } : {}) };
  } else if (phase === "clarification") {
    reports[phase] = { ...common(), implementation_context: "", acceptance_criteria: [], scope_exclusions: [],
      questions: [], exception_decisions: ["evidence_review", "investigation"]
        .flatMap(p => (progress.phases[p].exceptions ?? []).map(e =>
          ({ phase: p, code: e.code, resolution: "", reason: "" }))) };
  } else {
    const requirements = await json(progress.phases.clarification.result_file);
    const investigation = await json(progress.phases.investigation.result_file);
    const ids = requirements.acceptance_criteria.map(c => c.id);
    if (phase === "implementation")
      reports.implementation = { ...common(), addressed_criteria: ids, changed_files: [] };
    // A waiver requires fresh alternative evidence during verification, not earlier.
    if (phase === "verification" || !investigation.reproduction_waiver) {
      reports.verification = { ...common(), criteria: ids.map(id =>
        ({ id, status: "", result: "", evidence: [] })), checks: [], verification_receipts: [],
        ...(["bug", "mixed"].includes(progress.config.kind)
          ? { reproduction_recheck: { status: "", result: "",
            ...(investigation.reproduction_waiver ? { alternative_verification: {
              plan: investigation.reproduction.alternative_verification,
              performed: "", evidence: [],
            } } : {}) } } : {}) };
    }
  }
  const drafts = {};
  for (const [name, report] of Object.entries(reports)) {
    const path = join(directory, `${name}-draft-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    drafts[name] = path;
  }
  return { drafts, draft_contents: reports };
}
