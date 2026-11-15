import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { args, atomic, json, privateDir, isMain } from "./lib.mjs";
import { acquireLock, defaultWorkDir, newProgress } from "./state.mjs";
import { endpoints } from "./prepare-ticket.mjs";
import { synchronize, workflowStatus } from "./workflow-engine.mjs";
import { presentStatus, validateFormat } from "./presentation.mjs";

export async function session(
  action,
  key,
  options = {},
  { env = process.env } = {},
) {
  if (!["continue", "reset"].includes(action))
    throw new Error("Choose continue or reset");
  key = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))
    throw new Error("Use a Jira issue key such as ABC-123");
  const out = resolve(options.out ?? defaultWorkDir(endpoints(env), key));
  let release;
  try {
    release = await acquireLock(out, { timeoutMs: 3000 });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "No saved session at this path; run prepare-ticket.mjs first or supply the existing --out directory",
      );
    throw error;
  }
  try {
    const identity = await json(join(out, "identity.json"));
    if (identity.key !== key)
      throw new Error("Work directory belongs to another ticket");
    const manifest = await json(join(out, "manifest.json"));
    let progress = await json(join(out, "progress.json"));
    if (progress.issue_key !== manifest.issue_key || !progress.phases)
      throw new Error(
        "Saved progress is invalid or belongs to another ticket; inspect it before continuing",
      );
    if (progress.version > 7)
      throw new Error(
        "Saved workflow uses a newer schema; use a newer skill version",
      );
    let archive = null;
    if (action === "reset") {
      // Preserve the prior artifact directory and archive its state before atomically
      // switching to a new directory. No source code or evidence is modified.
      await privateDir(join(out, "history"));
      archive = join(out, "history", `${Date.now()}-${randomUUID()}.json`);
      await atomic(archive, {
        archived_at: new Date().toISOString(),
        reason: "user-requested workflow reset",
        artifact_directory: progress.artifact_directory ?? out,
        progress,
        evidence_snapshot_at_reset: manifest.snapshot_sha256,
      });
      const userScope = progress.user_scope ?? null;
      const config = [6, 7].includes(progress.version)
        ? (progress.config ?? null)
        : null;
      progress = await newProgress(manifest.issue_key, out);
      progress.user_scope = userScope;
      progress.config = config;
      progress.previous_session = archive;
      progress.next_action =
        "Refresh ticket evidence, then review and clarify requirements from the beginning. Existing code changes remain; inspect them before implementation.";
      await atomic(join(out, "progress.json"), progress);
    }
    progress = await synchronize(out, manifest, progress);
    await atomic(join(out, "progress.json"), progress);
    const status = workflowStatus(progress, manifest);
    return {
      action,
      issue_key: manifest.issue_key,
      work_directory: out,
      progress: join(out, "progress.json"),
      artifact_directory: progress.artifact_directory ?? out,
      manifest: join(out, "manifest.json"),
      ticket: join(out, "ticket.md"),
      evidence_fetched_at: manifest.fetched_at,
      evidence_status: manifest.status,
      refresh_warning: manifest.refresh_warning ?? null,
      snapshot_changed:
        progress.reconciled_snapshot !== manifest.snapshot_sha256,
      phases: status.phases,
      next_phase: status.next_phase,
      done: status.done,
      outcome: status.outcome,
      exceptions: status.exceptions,
      questions: status.questions,
      reproduction_request: status.reproduction_request,
      assignment: status.assignment,
      proposal: status.proposal,
      phase_token: status.phase_token,
      next_action: status.next_action,
      archive,
    };
  } finally {
    await release();
  }
}

if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = args({ out: { type: "string" }, format: { type: "string", default: "compact" } });
    if (values.help)
      console.log(
        "Usage: node session.mjs continue|reset ABC-123 [--out EXISTING_WORK_DIR --format compact|full]",
      );
    else {
      if (positionals.length !== 2)
        throw new Error("Provide continue|reset and a Jira issue key");
      validateFormat(values.format);
      console.log(
        JSON.stringify(presentStatus(await session(positionals[0], positionals[1], values), values.format)),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "LOCK_BUSY" ? 3 : 1;
  }
}
