import { open, rm, stat, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  args,
  number,
  hashFile,
  hashObject,
  atomic,
  json,
  adf,
  privateDir,
  isMain,
} from "./lib.mjs";
import { extractVideo, isAnimatedGif } from "./extract-video.mjs";
import {
  acquireLock,
  defaultWorkDir,
  evidenceSnapshot,
} from "./state.mjs";
import { synchronize } from "./workflow-engine.mjs";

const DEFAULT_FIELDS = [
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
  "updated",
  "issuelinks",
  "attachment",
  "project",
  "environment",
  "parent",
  "subtasks",
  "duedate",
  "resolution",
];

function httpsBase(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Set ${name} to a valid HTTPS base URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${name} must be HTTPS without credentials, query, or fragment`,
    );
  return url.href.replace(/\/$/, "");
}
export function endpoints(env) {
  const site = httpsBase(env.JIRA_BASE_URL, "JIRA_BASE_URL");
  const api = env.JIRA_API_BASE_URL
    ? httpsBase(env.JIRA_API_BASE_URL, "JIRA_API_BASE_URL")
    : site;
  return { site, api };
}
export function configuration(env) {
  const { site, api } = endpoints(env);
  if (env.JIRA_BEARER_TOKEN && (env.JIRA_EMAIL || env.JIRA_API_TOKEN))
    throw new Error(
      "Configure either bearer authentication or email/API token, not both",
    );
  let authorization;
  if (env.JIRA_BEARER_TOKEN) authorization = `Bearer ${env.JIRA_BEARER_TOKEN}`;
  else if (env.JIRA_EMAIL && env.JIRA_API_TOKEN)
    authorization = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}`;
  else
    throw new Error(
      "Set JIRA_EMAIL and JIRA_API_TOKEN, or JIRA_BEARER_TOKEN, in the environment",
    );
  return { site, api, authorization };
}

export async function request(
  config,
  path,
  fetchImpl,
  { attachment = false, timeoutMs = 120000 } = {},
) {
  let response;
  const controller = new AbortController();
  const timer = attachment
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    response = await fetchImpl(`${config.api}/rest/api/3/${path}`, {
      headers: { Authorization: config.authorization, Accept: "*/*" },
      redirect: "manual",
      signal: attachment ? controller.signal : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(
      "Jira request failed (network error or timeout); check connection and configuration",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        "Jira returned a redirect; refused to forward credentials. Use an authorized download integration.",
      );
    if (response.status === 429)
      throw new Error(
        "Jira rate limit reached; retry later according to your Jira service limits",
      );
    throw new Error(
      `Jira HTTP ${response.status}; check credentials, issue access, and API base`,
    );
  }
  return response;
}

export async function download(
  response,
  file,
  maxBytes,
  expectedBytes,
  stallMs = 120000,
) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Attachment response exceeds size limit");
  }
  if (!response.body) throw new Error("Attachment response has no body");
  const temp = `${file}.${randomUUID()}.part`;
  const handle = await open(temp, "wx", 0o600);
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      let timer;
      let result;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Attachment download stalled; retry when the connection is available",
                  ),
                ),
              stallMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;
      const chunk = result.value;
      size += chunk.byteLength;
      if (size > maxBytes)
        throw new Error("Attachment stream exceeds size limit");
      await handle.writeFile(chunk);
    }
    if (expectedBytes !== undefined && size !== expectedBytes)
      throw new Error("Attachment size does not match Jira metadata");
    await handle.close();
    const { rename } = await import("node:fs/promises");
    await rename(temp, file);
  } catch (error) {
    void reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
  return { bytes: size, sha256: await hashFile(file) };
}

function safeName(value) {
  return (
    String(value ?? "attachment")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 140) || "attachment"
  );
}
function printable(value) {
  if (value == null) return "";
  if (value.type === "doc") return adf(value);
  if (Array.isArray(value)) return value.map(printable).join(", ");
  if (typeof value === "object") {
    if (value.key)
      return `${value.key}${value.fields?.summary ? ` — ${value.fields.summary}` : ""}`;
    if (value.value !== undefined && value.child)
      return `${value.value} → ${printable(value.child)}`;
    return (
      value.displayName ?? value.name ?? value.value ?? JSON.stringify(value)
    );
  }
  return String(value);
}

// Readable engineering projection only. Evidence hashing retains its separate policy.
const ENGINEERING_FIELDS = [
  ["Issue Type", ["issuetype"]], ["Status", ["status"]],
  ["Priority", ["priority"]], ["Severity", ["severity"]],
  ["Description", ["description"]],
  ["Acceptance Criteria", ["acceptancecriteria"]],
  ["Environment(s)", ["environment", "environments"]],
  ["Steps to Reproduce", ["stepstoreproduce"]],
  ["Expected Result", ["expectedresult"]], ["Actual Result", ["actualresult"]],
  ["Components", ["components"]], ["Labels", ["labels"]],
  ["Affects versions", ["versions", "affectsversions", "affectsversion"]],
  ["Fix versions", ["fixversions", "fixversion"]],
  ["Parent/Epic Link", ["parent", "epiclink", "parentepiclink"]],
  ["Sub-tasks", ["subtasks"]],
];
const fieldName = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
function populated(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(populated);
  if (value.type === "doc") return adf(value).trim().length > 0;
  if (typeof value === "object") return Object.values(value).some(populated);
  return true;
}

export function ticketMarkdown(issue, comments, attachments, fieldNames = {}, remoteLinks = []) {
  const f = issue.fields;
  const names = { ...issue.names, ...fieldNames };
  const rows = [`# ${issue.key}${populated(f.summary) ? `: ${f.summary}` : ""}`, ""];
  for (const [label, aliases] of ENGINEERING_FIELDS) {
    const values = Object.entries(f)
      .filter(([key, value]) =>
        aliases.includes(fieldName(key.startsWith("customfield_") ? names[key] ?? "" : key)) && populated(value))
      .map(([, value]) => printable(value).trim()).filter(Boolean);
    if (values.length) rows.push(`## ${label}`, [...new Set(values)].join("\n\n"), "");
  }
  const linked = (f.issuelinks ?? []).flatMap(link => {
    const other = link.outwardIssue ?? link.inwardIssue;
    return other?.key ? [`- ${link.outwardIssue ? link.type?.outward ?? "Related" : link.type?.inward ?? "Related"}: ${printable(other)}`] : [];
  });
  if (linked.length) rows.push("## Linked issues (references only)", ...linked, "");
  const links = remoteLinks.filter(link => populated(link.object?.url));
  if (links.length) rows.push("## External links (references only; linked content not fetched)",
    ...links.map(link => `- ${link.object?.title || "Untitled"}: ${link.object.url}${link.relationship ? ` — ${link.relationship}` : ""}`), "");
  const filledComments = comments.filter(c => populated(c.body));
  if (filledComments.length) {
    rows.push("## Comments");
    for (const c of filledComments) rows.push(
      `### ${c.author?.displayName ?? "Unknown author"} · ${c.created ?? ""} · ${c.id}`,
      adf(c.body), "");
  }
  if (attachments.length) rows.push("## Attachments", ...attachments.map(a =>
    `- ${a.id}: ${a.filename} (${a.mime_type}, ${a.size} bytes) — ${a.status}${a.path ? ` — ${a.path}` : ""}`));
  return rows.join("\n") + "\n";
}

export async function prepareTicket(
  key,
  options,
  { env = process.env, fetchImpl = fetch } = {},
) {
  key = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key))
    throw new Error("Use a Jira issue key such as ABC-123");
  const config = configuration(env),
    out = resolve(options.out ?? defaultWorkDir(config, key));
  const maxBytes = number(options.maxMb, 500, "max-mb", 0.001) * 1024 * 1024;
  const maxTotal =
    number(options.maxTotalMb, 2000, "max-total-mb", 0.001) * 1024 * 1024;
  const maxFrames = number(options.maxFrames, 60, "max-frames", 1, 300);
  if (!Number.isInteger(maxFrames))
    throw new Error("max-frames must be an integer");
  const extraFields = options.fields
    ? options.fields
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  if (extraFields.some((f) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f)))
    throw new Error("--fields must contain comma-separated field IDs");
  await privateDir(out);
  const releaseLock = await acquireLock(out, { timeoutMs: 3000 });
  try {
    const identity = { key, site: config.site, api: config.api };
    try {
      const existing = await json(join(out, "identity.json"));
      if (hashObject(existing) !== hashObject(identity))
        throw new Error(
          "Work directory belongs to another ticket or Jira endpoint; choose a new directory",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await atomic(join(out, "identity.json"), identity);
    }
    let previous = { attachments: [] };
    try {
      previous = await json(join(out, "manifest.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let progress = null;
    try {
      progress = await json(join(out, "progress.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (progress?.version > 7)
      throw new Error(
        "Saved workflow uses a newer schema; use a newer skill version",
      );
    await privateDir(join(out, "attachments"));
    await privateDir(join(out, "evidence"));
    // Include custom acceptance criteria by default; explicit fields narrow the snapshot.
    const query = new URLSearchParams({
      fields: options.fields
        ? [...new Set([...DEFAULT_FIELDS, ...extraFields])].join(",")
        : "*all",
      expand: "names,schema",
    });
    const issue = await (
      await request(config, `issue/${key}?${query}`, fetchImpl)
    ).json();
    if (!issue.fields || !issue.key)
      throw new Error("Jira returned an invalid issue response");
    const errors = [],
      comments = [];
    let startAt = 0,
      commentsComplete = false;
    try {
      for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
        const page = await (
          await request(
            config,
            `issue/${key}/comment?startAt=${startAt}&maxResults=100`,
            fetchImpl,
          )
        ).json();
        if (!Array.isArray(page.comments) || !Number.isInteger(page.total))
          throw new Error("Invalid Jira comment page");
        comments.push(...page.comments);
        startAt += page.comments.length;
        if (startAt >= page.total) {
          commentsComplete = true;
          break;
        }
        if (!page.comments.length)
          throw new Error(
            "Jira comment pagination stopped before all comments were returned",
          );
      }
      if (!commentsComplete)
        throw new Error("Comment pagination limit reached");
    } catch (error) {
      errors.push({ stage: "comments", error: error.message });
    }

    let remoteLinks = [],
      remoteLinksComplete = false;
    try {
      const result = await (
        await request(config, `issue/${key}/remotelink`, fetchImpl)
      ).json();
      if (!Array.isArray(result))
        throw new Error("Invalid Jira remote-link response");
      remoteLinks = result;
      remoteLinksComplete = true;
    } catch (error) {
      errors.push({ stage: "remote-links", error: error.message });
    }

    const attachments = [];
    let totalBytes = 0;
    for (const item of issue.fields.attachment ?? []) {
      const a = {
        id: String(item.id),
        filename: String(item.filename ?? "attachment"),
        mime_type: item.mimeType ?? "application/octet-stream",
        size: Number(item.size),
        created: item.created ?? null,
        status: "pending",
      };
      attachments.push(a);
      try {
        if (!/^\d+$/.test(a.id) || !Number.isSafeInteger(a.size) || a.size < 0)
          throw new Error("Invalid attachment metadata");
        if (a.size > maxBytes) throw new Error("Attachment exceeds --max-mb");
        if (totalBytes + a.size > maxTotal)
          throw new Error("Attachment exceeds --max-total-mb budget");
        totalBytes += a.size;
        a.path = join(out, "attachments", `${a.id}-${safeName(a.filename)}`);
        a.fingerprint = hashObject([
          a.id,
          a.filename,
          a.size,
          a.created,
          a.mime_type,
        ]);
        const cached = previous.attachments?.find(
          (p) => p.id === a.id && p.fingerprint === a.fingerprint && p.sha256,
        );
        let reuse = false;
        if (cached) {
          try {
            reuse =
              (await stat(a.path)).size === a.size &&
              (await hashFile(a.path)) === cached.sha256;
          } catch {
            /* Download missing/corrupt cache again. */
          }
        }
        if (reuse) {
          a.sha256 = cached.sha256;
          a.bytes = a.size;
          a.cached = true;
        } else
          Object.assign(
            a,
            await download(
              await request(
                config,
                `attachment/content/${a.id}?redirect=false`,
                fetchImpl,
                { attachment: true },
              ),
              a.path,
              maxBytes,
              a.size,
            ),
          );
        a.status = "downloaded";
        a.is_video =
          a.mime_type.startsWith("video/") ||
          /\.(mov|mp4|m4v|webm|mkv|avi|ts|mts|m2ts)$/i.test(a.filename);
        if (a.mime_type === "image/gif" || /\.gif$/i.test(a.filename)) {
          if (options.skipVideo) {
            a.video = {
              status: "skipped",
              reason: "--skip-video; GIF animation not inspected",
            };
          } else {
            try {
              a.is_video = await isAnimatedGif(a.path);
            } catch (error) {
              a.video = { status: "failed", error: error.message };
              errors.push({
                stage: "gif-probe",
                attachment_id: a.id,
                error: error.message,
              });
            }
          }
        }
        if (a.is_video && !options.skipVideo) {
          try {
            let evidence;
            if (reuse && cached.video?.status === "prepared") {
              try {
                const m = await json(
                  join(cached.video.directory, "manifest.json"),
                );
                if (
                  m.source_sha256 === a.sha256 &&
                  m.sampling.max_frames === maxFrames &&
                  m.version === 4
                ) {
                  await Promise.all(
                    [
                      ...m.frames.map((f) => f.file),
                      ...m.contact_sheets,
                      m.contact_index,
                    ].map((f) => access(join(cached.video.directory, f))),
                  );
                  evidence = { ...cached.video, cached: true };
                }
              } catch {
                /* Regenerate missing evidence. */
              }
            }
            if (!evidence) {
              const directory = join(
                out,
                "evidence",
                `${a.id}-${a.sha256.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
              );
              const m = await extractVideo(a.path, {
                out: directory,
                maxFrames,
              });
              evidence = {
                status: "prepared",
                directory,
                manifest: join(directory, "manifest.json"),
                frames: m.frames.length,
                contact_sheets: m.contact_sheets.map((f) => join(directory, f)),
                contact_index: join(directory, m.contact_index),
                has_audio: m.has_audio,
              };
            }
            a.video = evidence;
          } catch (error) {
            a.video = { status: "failed", error: error.message };
            errors.push({
              stage: "video",
              attachment_id: a.id,
              error: error.message,
            });
          }
        } else if (a.is_video)
          a.video = { status: "skipped", reason: "--skip-video" };
      } catch (error) {
        a.status = "failed";
        a.error = error.message;
        errors.push({
          stage: "attachment",
          attachment_id: a.id,
          error: error.message,
        });
      }
    }
    const snapshot = evidenceSnapshot(
      issue,
      comments,
      commentsComplete,
      remoteLinks,
      remoteLinksComplete,
    );
    const manifest = {
      version: 2,
      issue_key: issue.key,
      site: config.site,
      work_directory: out,
      fetched_at: new Date().toISOString(),
      ticket_updated: issue.fields.updated,
      snapshot_sha256: snapshot,
      snapshot_changed: progress?.reconciled_snapshot !== snapshot,
      status: errors.length ? "partial" : "complete",
      comments_complete: commentsComplete,
      remote_links_complete: remoteLinksComplete,
      ticket: join(out, "ticket.md"),
      attachments,
      errors,
    };
    const losesComments =
      previous.comments_complete === true && !commentsComplete;
    const losesRemoteLinks =
      previous.remote_links_complete === true && !remoteLinksComplete;
    if (!options.acceptPartial && (losesComments || losesRemoteLinks)) {
      // Preserve the prior snapshot when a previously complete content section becomes unavailable. Do not replace accepted
      // requirements with missing comments/links caused by a transient refresh.
      const attempt = join(out, "refresh-attempts", randomUUID());
      await privateDir(attempt);
      await atomic(join(attempt, "manifest.json"), manifest);
      await atomic(join(attempt, "issue.json"), issue);
      await atomic(join(attempt, "comments.json"), comments);
      await atomic(join(attempt, "remote-links.json"), remoteLinks);
      const retained = {
        ...previous,
        refresh_warning: {
          attempted_at: manifest.fetched_at,
          errors,
          attempt_directory: attempt,
          reason:
            "Previously complete comments or remote links became unavailable; retaining the prior snapshot, including any attachment limitations. Retry or use --accept-partial to adopt the new snapshot with explicit missing evidence.",
        },
      };
      await atomic(join(out, "manifest.json"), retained);
      progress = await synchronize(out, retained, progress);
      await atomic(join(out, "progress.json"), progress);
      return {
        ...retained,
        status: "partial",
        errors,
        snapshot_changed:
          progress.reconciled_snapshot !== retained.snapshot_sha256,
      };
    }
    await atomic(join(out, "issue.json"), issue);
    await atomic(join(out, "comments.json"), comments);
    await atomic(join(out, "remote-links.json"), remoteLinks);
    await atomic(
      join(out, "ticket.md"),
      ticketMarkdown(issue, comments, attachments, issue.names, remoteLinks),
    );
    await atomic(join(out, "manifest.json"), manifest);
    progress = await synchronize(out, manifest, progress);
    await atomic(join(out, "progress.json"), progress);
    return manifest;
  } finally {
    await releaseLock();
  }
}

if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = args({
      out: { type: "string" },
      fields: { type: "string" },
      "max-mb": { type: "string" },
      "max-total-mb": { type: "string" },
      "max-frames": { type: "string" },
      "skip-video": { type: "boolean" },
      "accept-partial": { type: "boolean" },
    });
    if (values.help)
      console.log(
        "Usage: node prepare-ticket.mjs ABC-123 [--accept-partial --out WORK_DIR --fields customfield_10001 --max-mb 500 --max-total-mb 2000 --max-frames 60 --skip-video]",
      );
    else {
      if (positionals.length !== 1)
        throw new Error("Provide one Jira issue key");
      const m = await prepareTicket(positionals[0], {
        ...values,
        maxMb: values["max-mb"],
        maxTotalMb: values["max-total-mb"],
        maxFrames: values["max-frames"],
        skipVideo: values["skip-video"],
        acceptPartial: values["accept-partial"],
      });
      console.log(
        JSON.stringify({
          status: m.status,
          ticket: m.ticket,
          manifest: join(m.work_directory, "manifest.json"),
          snapshot_changed: m.snapshot_changed,
          attachments: m.attachments.length,
          downloaded: m.attachments.filter((a) => a.status === "downloaded")
            .length,
          videos_prepared: m.attachments.filter(
            (a) => a.video?.status === "prepared",
          ).length,
          errors: m.errors.length,
          refresh_warning: m.refresh_warning ?? null,
        }),
      );
      if (m.status === "partial") process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "LOCK_BUSY" ? 3 : 1;
  }
}
