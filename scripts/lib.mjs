import { createHash, randomUUID } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(url))
    );
  } catch {
    return false;
  }
}
export function args(options) {
  return parseArgs({
    options: { help: { type: "boolean" }, ...options },
    allowPositionals: true,
  });
}
export function number(value, fallback, name, min = 0, max = Infinity) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const hashObject = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
export async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(
    temp,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rename(temp, file);
}
export async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

// Readable ADF conversion; the original JSON is retained for unsupported formatting.
export function adf(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adf).join("");
  if (node.type === "text") {
    const link = node.marks?.find((m) => m.type === "link");
    return link
      ? `${node.text} (${link.attrs?.href ?? ""})`
      : (node.text ?? "");
  }
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text ?? "[mention]";
  if (node.type === "inlineCard" || node.type === "blockCard")
    return node.attrs?.url ?? "";
  if (node.type === "media")
    return `[attachment ${node.attrs?.alt ?? node.attrs?.filename ?? node.attrs?.id ?? ""}]`;
  if (node.type === "emoji")
    return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "status") return `[${node.attrs?.text ?? "status"}]`;
  if (node.type === "date") {
    const date = new Date(Number(node.attrs?.timestamp));
    return Number.isNaN(date.getTime())
      ? "[unknown date]"
      : date.toISOString().slice(0, 10);
  }
  if (node.type === "orderedList" || node.type === "bulletList") {
    const start = Number.isInteger(node.attrs?.order) ? node.attrs.order : 1;
    return (
      (node.content ?? [])
        .map((item, i) => {
          const text = (item.content ?? []).map(adf).join("").trim();
          const marker = node.type === "orderedList" ? `${start + i}. ` : "- ";
          return marker + text.replace(/\n/g, "\n  ") + "\n";
        })
        .join("") + "\n"
    );
  }
  const body = (node.content ?? []).map(adf).join("");
  if (node.type === "taskItem")
    return `- [${node.attrs?.state === "DONE" ? "x" : " "}] ${body.trim()}\n`;
  if (node.type === "decisionItem")
    return `- Decision (${node.attrs?.state ?? "unknown"}): ${body.trim()}\n`;
  if (node.type === "taskList" || node.type === "decisionList")
    return body + "\n";
  if (node.type === "expand" || node.type === "nestedExpand")
    return `${node.attrs?.title ?? "Details"}\n${body}\n`;
  if (node.type === "listItem") return `- ${body.trim()}\n`;
  if (node.type === "heading")
    return `${"#".repeat(Math.min(6, node.attrs?.level ?? 2))} ${body}\n\n`;
  if (node.type === "tableCell" || node.type === "tableHeader")
    return `${body.trim()} | `;
  return (
    body +
    ([
      "paragraph",
      "codeBlock",
      "blockquote",
      "tableRow",
      "bulletList",
      "orderedList",
    ].includes(node.type)
      ? "\n"
      : "")
  );
}
