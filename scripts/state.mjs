import { open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hashObject, privateDir } from "./lib.mjs";

export const PHASES = [
  "evidence_review",
  "investigation",
  "clarification",
  "implementation",
  "verification",
];

export async function newProgress(key, workDirectory) {
  const artifactDirectory = join(workDirectory, "workflow", randomUUID());
  await privateDir(artifactDirectory);
  return {
    version: 7,
    issue_key: key,
    artifact_directory: artifactDirectory,
    reconciled_snapshot: null,
    user_scope: null,
    config: null,
    revision: 0,
    events: [],
    observed_evidence: null,
    phases: Object.fromEntries(
      PHASES.map((p) => [p, { status: "pending", artifacts: [] }]),
    ),
    unresolved_questions: [],
    next_action:
      "Read ticket.md and manifest.json; review relevant attachments.",
  };
}

const CORE = new Set([
  "summary",
  "description",
  "issuetype",
  "status",
  "priority",
  "labels",
  "components",
  "fixVersions",
  "versions",
  "assignee",
  "reporter",
  "project",
  "parent",
  "subtasks",
  "duedate",
  "environment",
  "resolution",
]);
export function relevantFields(issue) {
  return Object.fromEntries(
    Object.entries(issue.fields).filter(([key]) => {
      if (CORE.has(key)) return true;
      if (!/^customfield_\d+$/.test(key)) return false;
      // Exclude known computed system fields, retaining user-authored custom requirements.
      const computed =
        /gh-lexo-rank|servicedesk:sla-field|devsummarycf|charting|time-in-status|timeinstatus/i;
      return (
        !computed.test(issue.schema?.[key]?.custom ?? "") &&
        !/^rank$/i.test(issue.names?.[key] ?? "")
      );
    }),
  );
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  // Preserve ADF verbatim and remove only transport/presentation metadata elsewhere.
  if (value.type === "doc") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k]) =>
          !["self", "avatarUrls", "iconUrl", "expand", "lastViewed"].includes(
            k,
          ),
      )
      .map(([k, v]) => [k, compact(v)]),
  );
}
export function evidenceSnapshot(
  issue,
  comments,
  commentsComplete,
  remoteLinks = [],
  remoteLinksComplete = true,
) {
  return hashObject({
    version: 3,
    fields: compact(relevantFields(issue)),
    comments_complete: commentsComplete,
    remote_links_complete: remoteLinksComplete,
    remote_links: remoteLinks
      .map((l) => ({
        id: l.id,
        title: l.object?.title,
        url: l.object?.url,
        summary: l.object?.summary,
        relationship: l.relationship,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    comments: comments
      .map((c) => ({
        id: c.id,
        body: c.body,
        author: c.author?.accountId ?? c.author?.displayName,
        visibility: c.visibility,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    attachments: (issue.fields.attachment ?? [])
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mimeType: a.mimeType,
        created: a.created,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    links: (issue.fields.issuelinks ?? [])
      .map((l) => ({
        id: l.id,
        type: l.type?.name,
        inward: l.inwardIssue?.key,
        outward: l.outwardIssue?.key,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
}

export function defaultWorkDir(
  config,
  key,
  root = join(homedir(), ".cache", "ticket-to-implementation"),
) {
  return join(
    root,
    `${new URL(config.site).hostname}-${hashObject(config.api).slice(0, 8)}`,
    key,
  );
}

// Serialize stale-lock recovery so simultaneous starters cannot delete a new lock.
export async function acquireLock(directory, { timeoutMs = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await acquireLockOnce(directory);
    } catch (error) {
      if (error.code !== "LOCK_BUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
      );
    }
  }
}
function busy(message) {
  return Object.assign(new Error("LOCK_BUSY: " + message), {
    code: "LOCK_BUSY",
  });
}
async function acquireLockOnce(directory) {
  const file = join(directory, ".prepare.lock");
  async function create() {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(String(process.pid));
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      throw error;
    }
    return async () => {
      await handle.close();
      await rm(file, { force: true });
    };
  }
  try {
    return await create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let recovery;
  try {
    recovery = await open(`${file}.recovery`, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw busy(
        "Lock recovery already active; retry later. If interrupted, inspect .prepare.lock.recovery before removing it.",
      );
    throw error;
  }
  try {
    let pid;
    try {
      pid = Number(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return await create();
    }
    if (!Number.isInteger(pid) || pid <= 0)
      throw busy(
        "Work directory lock is initializing or incomplete; retry later. Only inspect/remove it if retries still fail and no preparation is active.",
      );
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH")
        throw busy(`Work directory is locked by process ${pid}`);
      await rm(file);
      return await create();
    }
    throw busy(`Work directory is locked by active process ${pid}`);
  } finally {
    await recovery.close();
    await rm(`${file}.recovery`, { force: true });
  }
}
