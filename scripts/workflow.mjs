import { join, resolve } from "node:path";
import { lstat, writeFile } from "node:fs/promises";
import { activeAssignment } from "./handoff.mjs";
import { args, atomic, json, isMain } from "./lib.mjs";
import { acquireLock, defaultWorkDir } from "./state.mjs";
import { endpoints } from "./prepare-ticket.mjs";
import { synchronize, transition, readInput } from "./workflow-engine.mjs";
import { presentStatus, validateFormat } from "./presentation.mjs";

export async function workflow(
  action,
  key,
  options = {},
  { env = process.env } = {},
) {
  if (
    ![
      "configure",
      "draft",
      "status",
      "start",
      "assert",
      "block",
      "present",
      "request-reproduction-waiver",
      "handoff",
      "check-worker",
      "record-check",
      "complete",
      "invalidate",
    ].includes(action)
  )
    throw new Error("Unknown workflow action");
  if (options.draft && (action !== "start" ||
      !["evidence_review", "investigation", "clarification"].includes(options.phase)))
    throw new Error("--draft is only supported with start for evidence_review, investigation or clarification");
  if (options.response && action !== "draft" && !(action === "start" && options.draft))
    throw new Error("--response requires draft or start --draft");
  const responseName = options.response?.replaceAll("{phase}", options.phase ?? "");
  if (responseName && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(responseName))
    throw new Error("--response must be a JSON filename, not a path");
  key = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))
    throw new Error("Use a Jira issue key such as ABC-123");
  const out = resolve(options.out ?? defaultWorkDir(endpoints(env), key));
  const release = await acquireLock(out, { timeoutMs: 3000 });
  try {
    if ((await json(join(out, "identity.json"))).key !== key)
      throw new Error("Work directory belongs to another ticket");
    const manifest = await json(join(out, "manifest.json"));
    const progressFile = join(out, "progress.json");
    const progress = await synchronize(out, manifest, await json(progressFile));
    // Persist invalidation even when the requested transition is then rejected.
    await atomic(progressFile, progress);
    const input = options.input ? await readInput(resolve(options.input)) : {};
    if (options.reason) input.reason = options.reason;
    const responseDirectory = ["implementation", "verification"].includes(options.phase)
      ? activeAssignment(progress, options.phase)?.directory : progress.artifact_directory;
    const responsePath = responseName && responseDirectory ? join(responseDirectory, responseName) : null;
    if (responsePath) {
      const existing = await lstat(responsePath).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) throw new Error("Draft response already exists; use its saved paths or choose a fresh response filename after recovery");
    }
    let status = await transition(
      progress,
      manifest,
      out,
      action,
      options.phase,
      input,
    );
    if (options.draft)
      status = await transition(progress, manifest, out, "draft", options.phase, input);
    if (responsePath) {
      await writeFile(responsePath, JSON.stringify({ drafts: status.drafts,
        draft_contents: status.draft_contents }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      status.draft_response = responsePath;
    }
    await atomic(progressFile, progress);
    return { ...status, work_directory: out, progress: progressFile };
  } finally {
    await release();
  }
}

if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = args({
      out: { type: "string" },
      phase: { type: "string" },
      input: { type: "string" },
      reason: { type: "string" },
      format: { type: "string", default: "full" },
      draft: { type: "boolean", default: false },
      response: { type: "string" },
    });
    if (values.help)
      console.log(
        "Usage: node workflow.mjs configure|status|start|draft|assert|block|present|request-reproduction-waiver|handoff|check-worker|record-check|complete|invalidate ABC-123 [--out WORK_DIR --phase PHASE --input JSON_FILE --reason TEXT --format compact|full --draft --response FILENAME]",
      );
    else {
      if (positionals.length !== 2)
        throw new Error("Provide an action and Jira issue key");
      validateFormat(values.format);
      console.log(
        JSON.stringify(presentStatus(await workflow(positionals[0], positionals[1], values), values.format)),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "LOCK_BUSY" ? 3 : 1;
  }
}
