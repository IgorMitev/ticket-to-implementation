import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, lstat, readlink, realpath } from "node:fs/promises";
import { resolve, relative, join, sep } from "node:path";
import { hashFile, hashObject } from "./lib.mjs";

const exec = promisify(execFile);
const inside = (root, path) => path === root || path.startsWith(root + sep);
export async function repositorySnapshot(repository, excludedDirectory) {
  const root = await realpath(repository);
  const excluded = excludedDirectory ? await realpath(excludedDirectory) : null;
  if (excluded && inside(excluded, root))
    throw new Error(
      "Repository must not equal or be inside the ticket work directory",
    );
  const git = async (args) =>
    (await exec("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 }))
      .stdout;
  let mode = "filesystem",
    branch = null,
    head = null,
    index = null,
    working_tree = null,
    submodules = new Map(),
    paths;
  try {
    const top = (await git(["rev-parse", "--show-toplevel"])).trim();
    if ((await realpath(top)) !== root)
      throw new Error("Configure the Git repository root, not a subdirectory");
    mode = "git";
    branch =
      (
        await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
          () => "",
        )
      ).trim() || null;
    head =
      (await git(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() ||
      null;
    const statusArgs = [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      ".",
    ];
    if (excluded && inside(root, excluded))
      statusArgs.push(":(exclude,literal)" + relative(root, excluded));
    working_tree = (await git(statusArgs)).split("\0").filter(Boolean);
    const stage = await git(["ls-files", "--stage", "-z"]);
    index = hashObject(stage);
    // Pin indexed gitlinks without descending into their working trees.
    for (const entry of stage.split("\0").filter(Boolean)) {
      const match = /^160000 ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(entry);
      if (match) submodules.set(match[2], match[1]);
    }
    paths = [
      ...new Set(
        (
          await git([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean),
      ),
    ];
  } catch (error) {
    if (
      mode === "git" ||
      (error.code !== "ENOENT" &&
        !/not a git repository/i.test(error.stderr ?? ""))
    )
      throw error;
    paths = [];
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if ([".git", "node_modules"].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (excluded && inside(excluded, path)) continue;
        if (entry.isDirectory()) await walk(path);
        else paths.push(relative(root, path));
        if (paths.length > 20000)
          throw new Error(
            "Repository snapshot exceeds 20000 files; use Git ignore rules or narrow the repository",
          );
      }
    }
    await walk(root);
  }
  if (paths.length > 20000)
    throw new Error("Repository snapshot exceeds 20000 files");
  const files = {};
  for (const name of paths.sort()) {
    const path = resolve(root, name);
    if (!inside(root, path)) throw new Error("Repository path escapes root");
    if (excluded && inside(excluded, path)) continue;
    if (submodules.has(name)) {
      files[name] = { submodule: submodules.get(name) };
      continue;
    }
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) files[name] = { link: await readlink(path) };
      else if (info.isFile())
        files[name] = {
          sha256: await hashFile(path),
          executable: Boolean(info.mode & 0o111),
        };
      else
        throw new Error(
          "Snapshot cannot cover nested Git repository or submodule: " +
            name +
            ". Move it outside this repository or, for an unrelated untracked clone, add it to .gitignore; verify submodules separately",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const state = { root, mode, branch, head, index, working_tree, files };
  return { ...state, sha256: hashObject(state) };
}
export function changedPaths(before, after) {
  return [
    ...new Set([...Object.keys(before.files), ...Object.keys(after.files)]),
  ]
    .filter(
      (p) =>
        hashObject(before.files[p] ?? null) !==
        hashObject(after.files[p] ?? null),
    )
    .sort();
}
export function validateRepositoryChanges(before, after, changedFiles, review) {
  if (
    before.root !== after.root ||
    before.branch !== after.branch ||
    before.head !== after.head
  )
    throw new Error(
      "Repository branch or HEAD changed during assignment; stop and create a reviewed replacement handoff",
    );
  const declared = new Set(
    changedFiles.map((p) => relative(after.root, resolve(after.root, p))),
  );
  const actual = changedPaths(before, after);
  const missing = actual.filter((p) => !declared.has(p));
  if (missing.length)
    throw new Error("Unreported repository changes: " + missing.join(", "));
  if (typeof review !== "string" || !review.trim())
    throw new Error(
      "repository_review must explain review of baseline user changes and all resulting changes",
    );
  return actual;
}
