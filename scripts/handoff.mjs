import { repositorySnapshot } from "./repository.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, hashFile, json, privateDir } from "./lib.mjs";

export function validateAnswers(progress, phase, answers = []) {
  if (!Array.isArray(answers))
    throw new Error("resolved_questions must be an array");
  const pending = progress.unresolved_questions.filter(
    (q) => q.phase === phase,
  );
  if (new Set(answers.map((a) => a.id)).size !== answers.length)
    throw new Error("Duplicate resolved question ID");
  for (const q of pending) {
    const a = answers.find((a) => a.id === q.id);
    if (!a)
      throw new Error(
        `Recorded question ${q.id} must be answered before completing this phase`,
      );
    if (!nonempty(a.answer) || !nonempty(a.source))
      throw new Error("Question answer and source must be non-empty text");
    if (q.material && (a.source !== "user" || !nonempty(a.user_response)))
      throw new Error("Material questions require an actual user response");
  }
  return answers;
}
const nonempty = (v) => typeof v === "string" && Boolean(v.trim());
export function activeAssignment(progress, phase = "implementation") {
  if (phase === "verification") {
    const state = progress.phases.verification;
    return (
      state.assignment ??
      (state.assignment_revoked
        ? null
        : progress.phases.implementation.assignment)
    );
  }
  return progress.phases.implementation.assignment;
}

export async function createHandoff(
  progress,
  workDirectory,
  input,
  phaseName = "implementation",
) {
  const mode = input.mode ?? "subagent";
  if (!["subagent", "main_agent"].includes(mode))
    throw new Error("handoff mode must be subagent or main_agent");
  if (
    mode === "main_agent" &&
    !(typeof input.reason === "string" && input.reason.trim())
  )
    throw new Error("Main-agent fallback requires a reason");
  const phase = progress.phases[phaseName];
  if (phase.assignment)
    throw new Error(
      "An assignment already exists; resume it or stop the worker and block/invalidate this phase before replacement",
    );
  const requirements = await json(progress.phases.clarification.result_file);
  const investigation = await json(progress.phases.investigation.result_file);
  const evidence = await json(progress.phases.evidence_review.result_file);
  const answers = validateAnswers(
    progress,
    phaseName,
    input.resolved_questions,
  );
  if (
    !nonempty(requirements.alignment?.proposal_id) ||
    !nonempty(progress.phases.clarification.result_sha256)
  )
    throw new Error(
      "Approved proposal binding is missing; reopen clarification",
    );
  const id = randomUUID(),
    directory = join(progress.artifact_directory, "implementor", id);
  await privateDir(directory);
  const binding = {
    assignment_id: id,
    proposal_id: requirements.alignment.proposal_id,
    requirements_sha256: progress.phases.clarification.result_sha256,
    ...(phaseName === "verification"
      ? { implementation_sha256: progress.phases.implementation.result_sha256 }
      : {}),
  };
  const bindingPath = join(directory, "binding.json");
  const skillDirectory = fileURLToPath(new URL("../", import.meta.url));
  const argv = [
    join(skillDirectory, "scripts/workflow.mjs"),
    "check-worker",
    progress.issue_key,
    "--out",
    workDirectory,
    "--phase",
    phaseName,
    "--input",
    bindingPath,
    "--format",
    "compact",
  ];
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const baseline = await repositorySnapshot(
    progress.config.repository,
    workDirectory,
  );
  const baselinePath = join(directory, "repository-baseline.json");
  await atomic(baselinePath, baseline);
  const draftArgs = [...argv];
  draftArgs[1] = "draft";
  draftArgs.push("--response", "{phase}-draft-response.json");
  const workerBrief = join(skillDirectory, "references", "implementor.md");
  const returnReports = phaseName === "verification"
    ? ["verification"]
    : investigation.reproduction_waiver
      ? ["implementation"]
      : ["implementation", "verification"];
  const packet = {
    version: 2,
    ...binding,
    issue_key: progress.issue_key,
    mode,
    phase: phaseName,
    skill_directory: skillDirectory,
    binding_path: bindingPath,
    worker_brief: workerBrief,
    return_reports: returnReports,
    draft_reports: {
      executable: "node",
      args: draftArgs,
      command: ["node", ...draftArgs].map(quote).join(" "),
    },
    check_worker: {
      executable: "node",
      args: argv,
      command: ["node", ...argv].map(quote).join(" "),
    },
    repository_baseline: baselinePath,
    repository_summary: {
      mode: baseline.mode,
      branch: baseline.branch,
      head: baseline.head,
      file_count: Object.keys(baseline.files).length,
      dirty_entry_count: baseline.working_tree?.length ?? null,
    },
    context_budget: {
      exploration_tool_calls: 15,
      handoff_summary_words: 250,
      checkpoint:
        "Before another large investigation, save findings, open questions and next steps to checkpoint.md; return its path to the main agent.",
    },
    resolved_questions: answers,
    implementation_result:
      phaseName === "verification"
        ? progress.phases.implementation.result_file
        : null,
    repository: progress.config.repository,
    user_request: progress.config.user_request,
    kind: progress.config.kind,
    work_directory: workDirectory,
    output_directory: directory,
    ownership:
      "One implementor owns repository edits for this assignment. Main agent owns user interaction and workflow mutations.",
    requirements: {
      summary: requirements.summary,
      ...(nonempty(requirements.implementation_context)
        ? { implementation_context: requirements.implementation_context } : {}),
      acceptance_criteria: requirements.acceptance_criteria,
      scope_exclusions: requirements.scope_exclusions,
      questions: requirements.questions,
      resolved_questions: requirements.resolved_questions ?? [],
      exception_decisions: requirements.exception_decisions ?? [],
    },
    investigation: {
      summary: investigation.summary,
      current_behavior: investigation.current_behavior,
      relevant_files: investigation.relevant_files,
      reproduction: investigation.reproduction,
      reproduction_waiver: investigation.reproduction_waiver ?? null,
      feature_analysis: investigation.feature_analysis,
      constraints: investigation.constraints,
    },
    evidence_summary: evidence.summary,
    limitations: ["evidence_review", "investigation", "clarification"].flatMap(
      (p) =>
        (progress.phases[p].exceptions ?? []).map((e) => ({ phase: p, ...e })),
    ),
    references: Object.fromEntries(
      ["evidence_review", "investigation", "clarification"].map((p) => [
        p,
        {
          result: progress.phases[p].result_file,
          artifacts: progress.phases[p].artifacts,
        },
      ]),
    ),
    outputs: {
      implementation: join(directory, "implementation.json"),
      verification: join(directory, "verification.json"),
      blocker: join(directory, "blocker.json"),
    },
    instructions: [
      "Fill and return the paths from draft_reports; outputs are fallback locations when drafts are unavailable. Follow references/implementor.md in skill_directory and repository instructions. The brief defines binding checks, evidence rules, report contracts and ownership boundaries.",
      phaseName === "verification"
        ? "Verification only: inspect and test the accepted implementation. Do not edit source; return required fixes to the main agent."
        : investigation.reproduction_waiver
          ? "Return implementation first. After the main agent starts verification, perform the approved alternative and return fresh verification evidence."
          : "Return BOTH implementation and verification reports before finishing, while implementation is active. Reuse valid unchanged-code receipts; do not wait for the main agent to start verification.",
    ],
  };
  const path = join(directory, "handoff.json");
  await atomic(path, packet);
  await atomic(bindingPath, binding);
  return {
    ...binding,
    repository_baseline: baselinePath,
    repository_baseline_sha256: await hashFile(baselinePath),
    phase: phaseName,
    resolved_questions: answers,
    mode,
    reason: input.reason ?? null,
    path,
    sha256: await hashFile(path),
    binding_path: bindingPath,
    worker_brief: workerBrief,
    binding_sha256: await hashFile(bindingPath),
    directory,
  };
}

export function validateBinding(progress, input, phase = "implementation") {
  const assignment = activeAssignment(progress, phase);
  if (!assignment)
    throw new Error(
      "Create an implementation handoff before editing or accepting results",
    );
  for (const field of ["assignment_id", "proposal_id", "requirements_sha256"]) {
    if (
      !nonempty(assignment[field]) ||
      !nonempty(input[field]) ||
      input[field] !== assignment[field]
    )
      throw new Error("Stale or missing worker binding: " + field);
  }
  if (
    !nonempty(assignment.repository_baseline) ||
    !nonempty(assignment.repository_baseline_sha256)
  )
    throw new Error(
      "Legacy handoff needs replacement to capture repository state",
    );
  if (
    assignment.requirements_sha256 !==
    progress.phases.clarification.result_sha256
  )
    throw new Error("Approved requirements changed; obtain a new handoff");
  if (
    assignment.phase === "verification" &&
    (!nonempty(assignment.implementation_sha256) ||
      input.implementation_sha256 !== assignment.implementation_sha256 ||
      assignment.implementation_sha256 !==
        progress.phases.implementation.result_sha256)
  )
    throw new Error("Stale verification implementation binding");
  return assignment;
}
