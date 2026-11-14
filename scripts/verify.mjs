import { spawn } from "node:child_process";
import { readFile, realpath, open } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, hashFile, json, isMain, args } from "./lib.mjs";
import { repositorySnapshot } from "./repository.mjs";
import { workflow } from "./workflow.mjs";

// A check owns its process group. Do not wait forever for inherited daemon pipes.
export async function runCheck(command, cwd, stream, timeoutMs) {
  return new Promise((resolveResult) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command[0], command.slice(1), {
      cwd,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let finished = false,
      exited = false,
      timedOut = false,
      drainTimer,
      killTimer;
    const signalGroup = (signal) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH")
          stream.write("Process cleanup: " + error.message + "\n");
      }
    };
    const interruptions = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    const handlers = new Map();
    const onProcessExit = () => {
      // exit handlers cannot await; kill the owned group synchronously.
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const removeHandlers = () => {
      process.removeListener("exit", onProcessExit);
      for (const [signal, handler] of handlers)
        process.removeListener(signal, handler);
    };
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      removeHandlers();
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      signalGroup("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) stream.write(error + "\n");
      stream.end(() =>
        resolveResult({
          code: timedOut ? 124 : (code ?? 1),
          signal,
          timed_out: timedOut,
          error,
        }),
      );
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => finish(124, "SIGKILL"), 1000);
    }, timeoutMs);
    process.once("exit", onProcessExit);
    for (const [signal, code] of Object.entries(interruptions)) {
      const handler = () => {
        process.exitCode = code;
        finish(code, signal, "Verification interrupted by " + signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.once("error", (error) => finish(1, null, error.message));
    child.once("exit", (code, signal) => {
      exited = true;
      signalGroup("SIGTERM");
      // Allow queued output to drain, then detach inherited pipes even if still open.
      drainTimer = setTimeout(() => finish(code, signal), 100);
    });
    child.once("close", (code, signal) => {
      if (exited) finish(code, signal);
    });
  });
}

export async function verify(key, options, command) {
  if (!command.length && !options.manualStart && !options.manualFinish)
    throw new Error(
      "Supply an executable and arguments after --, or use a manual review checkpoint",
    );
  if (options.manualStart && options.manualFinish)
    throw new Error("Choose manual start or finish, not both");
  const timeoutSeconds = Number(options.timeout ?? 600);
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > 86400
  )
    throw new Error("--timeout must be between 0 and 86400 seconds");
  if (
    options.manualFinish &&
    (typeof options.report !== "string" || !options.report.trim())
  )
    throw new Error("--manual-finish requires --report");
  const out = resolve(options.out),
    binding = await json(resolve(options.binding));
  const phase = options.phase ?? "implementation";
  const status = await workflow("check-worker", key, {
    out,
    phase,
    input: options.binding,
  });
  const packet = await json(status.assignment.path),
    id = randomUUID();
  let before = await repositorySnapshot(packet.repository, out);
  if (options.manualStart) {
    const checkpoint = join(
      status.assignment.directory,
      "manual-" + id + "-start.json",
    );
    await atomic(checkpoint, {
      ...binding,
      kind: "manual-start",
      nonce: id,
      before,
    });
    return {
      checkpoint,
      next: "Inspect the code/UI, write the observed results to a report, then finish this checkpoint.",
    };
  }
  let manualText;
  if (options.manualFinish) {
    const root = await realpath(out);
    const contained = async (path) => {
      const actual = await realpath(resolve(path));
      if (!actual.startsWith(root + sep))
        throw new Error(
          "Manual checkpoint and report must be inside the ticket work directory",
        );
      return actual;
    };
    const checkpoint = await contained(options.manualFinish);
    const saved = await json(checkpoint);
    if (
      saved.kind !== "manual-start" ||
      typeof saved.nonce !== "string" ||
      !saved.nonce.trim() ||
      !saved.before ||
      typeof saved.before !== "object" ||
      !saved.before.files ||
      typeof saved.before.files !== "object" ||
      !/^[a-f0-9]{64}$/.test(saved.before.sha256 ?? "")
    )
      throw new Error("Invalid manual-start checkpoint");

    for (const key of Object.keys(binding))
      if (saved[key] !== binding[key])
        throw new Error("Stale manual review checkpoint");
    before = saved.before;
    const report = await contained(options.report);
    manualText = await readFile(report, "utf8");
    if (!manualText.trim())
      throw new Error("Manual review report must be nonempty");
    // Exclusive marker makes concurrent or repeated finishes fail deterministically.
    let marker;
    try {
      marker = await open(checkpoint + ".consumed", "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          "Manual checkpoint already consumed; start a new inspection",
        );
      throw error;
    }
    await marker.close();
    command = ["manual-review", report];
  }
  const log = join(status.assignment.directory, "check-" + id + ".log");
  const stream = createWriteStream(log, { mode: 0o600 });
  stream.write("Command: " + JSON.stringify(command) + "\n");
  const result =
    manualText !== undefined
      ? await new Promise((resolveResult) => {
          stream.end(manualText, () =>
            resolveResult({ code: 0, signal: null }),
          );
        })
      : await runCheck(
          command,
          packet.repository,
          stream,
          timeoutSeconds * 1000,
        );
  const after = await repositorySnapshot(packet.repository, out);
  const receipt = join(status.assignment.directory, "check-" + id + ".json");
  await atomic(receipt, {
    ...binding,
    command,
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timed_out ?? false,
    error: result.error,
    before,
    after,
    log,
    log_sha256: await hashFile(log),
  });
  const outcome = {
    receipt,
    log,
    exit_code: result.code,
    timed_out: result.timed_out ?? false,
    repository_sha256: after.sha256,
  };
  if (result.code !== 0) return outcome;
  const input = join(status.assignment.directory, "register-" + id + ".json");
  await atomic(input, { ...binding, receipt });
  await workflow("record-check", key, { out, phase, input });
  return outcome;
}
if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = args({
      out: { type: "string" },
      binding: { type: "string" },
      phase: { type: "string" },
      "manual-start": { type: "boolean" },
      "manual-finish": { type: "string" },
      report: { type: "string" },
      timeout: { type: "string" },
    });
    if (values.help)
      console.log(
        "Usage: node verify.mjs KEY --out WORK_DIR --binding BINDING_JSON [--phase implementation|verification --timeout SECONDS] -- EXECUTABLE ARGS...; manual review: --manual-start, then --manual-finish CHECKPOINT --report REPORT",
      );
    else {
      const result = await verify(
        positionals[0],
        {
          ...values,
          manualStart: values["manual-start"],
          manualFinish: values["manual-finish"],
        },
        positionals.slice(1),
      );
      console.log(JSON.stringify(result));
      if (result.exit_code !== undefined && result.exit_code !== 0)
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "LOCK_BUSY" ? 3 : 1;
  }
}
