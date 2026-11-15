import { spawn } from "node:child_process";
import { mkdir, readdir, stat, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { args, number, hashFile, atomic, isMain } from "./lib.mjs";

// A reviewer needs one timestamp mapping (contact-index.md), not two JSON copies.
export async function writeVideoReview(directory, manifest) {
  const { frames, contact_cells, ...review } = manifest;
  const path = join(directory, "review.json");
  await atomic(path, { ...review, frame_count: frames.length,
    manifest: join(directory, "manifest.json") });
  return path;
}

export function run(command, argv, timeoutMs = 600000, onStdout) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (data) => {
      if (onStdout) onStdout(data);
      else stdout = (stdout + data).slice(-8_000_000);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-8_000_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Cannot run ${command}: ${error.code}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`${command} exited ${code}: ${stderr.slice(-2500)}`));
      else resolveRun({ stdout, stderr });
    });
  });
}

let versionCheck;
export function checkFFmpegVersion(text) {
  const match = text.match(/ffmpeg version (?:n)?(\d+)\.(\d+)/);
  if (
    !match ||
    Number(match[1]) < 5 ||
    (Number(match[1]) === 5 && Number(match[2]) < 1)
  ) {
    throw new Error(
      "FFmpeg 5.1 or newer is required (a numbered release build); upgrade FFmpeg before extracting video.",
    );
  }
}
async function ensureFFmpeg() {
  versionCheck ??= run("ffmpeg", ["-version"], 30000)
    .then((r) => checkFFmpegVersion(r.stdout))
    .catch((error) => {
      versionCheck = undefined;
      throw error;
    });
  await versionCheck;
}
export async function isAnimatedGif(source) {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-read_intervals",
      "%+#2",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "json",
      resolve(source),
    ],
    60000,
  );
  const count = Number(JSON.parse(result.stdout).streams?.[0]?.nb_read_frames);
  if (!Number.isFinite(count) || count < 1)
    throw new Error("Cannot determine whether GIF is animated");
  return count > 1;
}

function framePeriod(stream) {
  const [n, d] = String(stream.avg_frame_rate ?? "")
    .split("/")
    .map(Number);
  return n > 0 && d > 0 ? d / n : 0.04;
}
async function deriveDuration(source, origin, period) {
  let pending = "",
    lastEnd = -Infinity;
  function line(text) {
    const values = Object.fromEntries(
      text.split("|").map((part) => part.split("=")),
    );
    const pts = Number(values.pts_time),
      length = Number(values.duration_time);
    if (Number.isFinite(pts))
      lastEnd = Math.max(
        lastEnd,
        pts + (Number.isFinite(length) && length > 0 ? length : period),
      );
  }
  await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-select_streams",
      "v:0",
      "-show_packets",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "compact=p=0:nk=0",
      source,
    ],
    600000,
    (data) => {
      pending += data.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const text of lines) line(text);
    },
  );
  if (pending) line(pending);
  const duration = lastEnd - origin;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(
      "Video has no usable duration, including after scanning packet timestamps",
    );
  return duration;
}

export async function extractVideo(input, options) {
  const source = resolve(input),
    out = resolve(options.out);
  const maxFrames = number(options.maxFrames, 60, "max-frames", 1, 300);
  const width = number(options.width, 1280, "width", 0, 7680);
  if (!Number.isInteger(maxFrames) || !Number.isInteger(width))
    throw new Error("max-frames and width must be integers");
  await ensureFFmpeg();
  await stat(source);
  const probe = JSON.parse(
    (
      await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          source,
        ],
        60000,
      )
    ).stdout,
  );
  const stream = probe.streams.find((s) => s.codec_type === "video");
  if (!stream) throw new Error("No video stream found");
  const period = framePeriod(stream);
  const origin = Number(probe.format?.start_time ?? stream.start_time) || 0;
  let duration = [probe.format?.duration, stream.duration]
    .map(Number)
    .find((d) => Number.isFinite(d) && d > 0);
  const durationSource =
    duration === undefined ? "video_packet_scan" : "metadata";
  duration ??= await deriveDuration(source, origin, period);
  const start = number(options.start, 0, "start", 0, duration);
  const end = number(options.end, duration, "end", 0, duration);
  if (end <= start) throw new Error("end must be after start");
  const span = end - start;
  const interval = number(
    options.interval,
    Math.max(span <= 2 ? span / 2 : 2, span / maxFrames),
    "interval",
    0.001,
  );
  if (
    options.interval !== undefined &&
    Math.ceil((end - start) / interval - 1e-9) > maxFrames
  ) {
    throw new Error(
      "Requested interval exceeds max-frames; narrow the range or increase the budget (maximum 300)",
    );
  }
  // Fail on an existing directory: never mix dense passes or incomplete outputs.
  await mkdir(out, { mode: 0o700 });
  const sourceHash = await hashFile(source);
  const filters = [
    `select=gte(t\\,${start})*lt(t\\,${end})*(isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval - 1e-7}))`,
    "showinfo",
  ];
  if (width) filters.push(`scale=w=min(${width}\\,iw):h=-2`);
  const timeoutMs = Math.max(600000, Math.ceil((end - start) * 3000));
  async function decode(seek) {
    const result = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-copyts",
        "-start_at_zero",
        "-protocol_whitelist",
        "file",
        ...(seek ? ["-ss", String(start)] : []),
        "-t",
        String(seek ? end - start : end),
        "-i",
        source,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        filters.join(","),
        "-fps_mode",
        "vfr",
        "-frames:v",
        String(maxFrames),
        "-pix_fmt",
        "rgb24",
        join(out, "frame-%04d.png"),
      ],
      seek ? timeoutMs : Math.max(600000, Math.ceil(end * 3000)),
    );
    const files = (await readdir(out))
      .filter((f) => /^frame-\d+\.png$/.test(f))
      .sort();
    const timestamps = [
      ...result.stderr.matchAll(
        /Parsed_showinfo[^\n]*\bn:\s*\d+[^\n]*\bpts_time:([\d.eE+-]+)/g,
      ),
    ].map((m) => Number(m[1]));
    if (timestamps.length < files.length)
      throw new Error("Insufficient decoded timestamp metadata");
    return files.map((file, i) => ({ file, timestamp_seconds: timestamps[i] }));
  }
  let frames,
    seekFallback = false;
  try {
    frames = await decode(start > 0);
  } catch (error) {
    if (start === 0) throw error;
    frames = [];
  }
  const coverageTolerance = interval + period + 1e-6;
  if (
    start > 0 &&
    (!frames.length || frames[0].timestamp_seconds - start > coverageTolerance)
  ) {
    // Some demuxers seek forward to the next keyframe. Retry from the beginning once.
    for (const file of await readdir(out))
      if (/^frame-\d+\.png$/.test(file)) await rm(join(out, file));
    frames = await decode(false);
    seekFallback = true;
  }
  if (!frames.length)
    throw new Error(
      `No decodable video frames in requested range ${start}–${end}s${seekFallback ? " after retrying without seek" : ""}`,
    );
  const coverage = {
    first_frame_seconds: frames[0].timestamp_seconds,
    last_frame_seconds: frames.at(-1).timestamp_seconds,
    seek_fallback: seekFallback,
    start_gap_exceeds_sampling:
      frames[0].timestamp_seconds - start > coverageTolerance,
    end_gap_exceeds_sampling:
      end - frames.at(-1).timestamp_seconds > coverageTolerance,
  };

  const sheets = [];
  const cells = [];
  const cellW = 320,
    imageH = 200,
    cols = 3,
    perSheet = 12;
  const index = [
    "# Contact-sheet index",
    "",
    "Read cells left to right, then top to bottom. Row and column numbers start at 1. Empty cells contain no sampled frame. Timestamps are playback-relative decoded video PTS in seconds.",
    "",
  ];
  for (let offset = 0; offset < frames.length; offset += perSheet) {
    const group = frames.slice(offset, offset + perSheet);
    const file = `contact-${String(sheets.length + 1).padStart(3, "0")}.jpg`;
    const remainder = group.length % cols;
    // Explicitly paint unused cells: some FFmpeg pixel formats leave tile padding green.
    const emptyCells = remainder
      ? `,drawbox=x=${remainder * cellW}:y=${Math.floor(group.length / cols) * imageH}:w=${(cols - remainder) * cellW}:h=${imageH}:color=0x171717:t=fill`
      : "";
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-start_number",
      String(offset + 1),
      "-i",
      join(out, "frame-%04d.png"),
      "-vf",
      `scale=${cellW}:${imageH}:force_original_aspect_ratio=decrease,pad=${cellW}:${imageH}:(ow-iw)/2:(oh-ih)/2:color=0x171717,setsar=1,tile=layout=${cols}x${Math.ceil(group.length / cols)}:nb_frames=${group.length}:color=0x171717${emptyCells}`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-update",
      "1",
      join(out, file),
    ]);
    index.push(
      `## ${file}`,
      "",
      "| Row | Column | Frame | Time (seconds) |",
      "| --- | --- | --- | --- |",
    );
    for (let i = 0; i < group.length; i++) {
      const frame = group[i],
        row = Math.floor(i / cols) + 1,
        column = (i % cols) + 1;
      cells.push({ sheet: file, row, column, ...frame });
      index.push(
        `| ${row} | ${column} | [${frame.file}](${frame.file}) | ${frame.timestamp_seconds.toFixed(3)} |`,
      );
    }
    index.push("");
    sheets.push(file);
  }
  await atomic(join(out, "contact-index.md"), index.join("\n"));
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  let audio = null;
  if (options.audio && hasAudio) {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-ss",
        String(start),
        "-t",
        String(end - start),
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        join(out, "audio.wav"),
      ],
      timeoutMs,
    );
    audio = "audio.wav";
  }
  const firstPng = await readFile(join(out, frames[0].file));
  const manifest = {
    version: 4,
    source,
    source_sha256: sourceHash,
    duration_seconds: duration,
    duration_source: durationSource,
    codec: stream.codec_name,
    source_width: stream.width,
    source_height: stream.height,
    extracted_width: firstPng.readUInt32BE(16),
    extracted_height: firstPng.readUInt32BE(20),
    color_transfer: stream.color_transfer ?? null,
    has_audio: hasAudio,
    audio_file: audio,
    audio_offset_seconds: audio ? start : null,
    sampling: { start, end, interval, max_frames: maxFrames, width },
    coverage,
    timestamp_basis:
      "decoded video PTS relative to container playback start, preserved across seeking; seconds",
    frames,
    contact_sheets: sheets,
    contact_index: "contact-index.md",
    contact_cells: cells,
    limitations: [
      "Sparse stills do not establish continuous behavior.",
      ...(durationSource === "video_packet_scan"
        ? [
            "Duration derived from video packets; missing packet durations use the nominal frame period.",
          ]
        : []),
      ...(coverage.start_gap_exceeds_sampling ||
      coverage.end_gap_exceeds_sampling
        ? [
            "Decoded frames do not cover the requested boundaries within the sampling tolerance; inspect actual coverage.",
          ]
        : []),
      ...(hasAudio && !audio
        ? ["Audio is present but not extracted or reviewed."]
        : []),
    ],
  };
  await atomic(join(out, "manifest.json"), manifest);
  await writeVideoReview(out, manifest);
  return manifest;
}

if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = args({
      out: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      interval: { type: "string" },
      "max-frames": { type: "string" },
      width: { type: "string" },
      audio: { type: "boolean" },
    });
    if (values.help)
      console.log(
        "Usage: node extract-video.mjs FILE --out NEW_DIR [--start SEC --end SEC --interval SEC --max-frames 60 --width 1280 --audio]",
      );
    else {
      if (positionals.length !== 1 || !values.out)
        throw new Error("Provide one video file and --out NEW_DIR");
      const result = await extractVideo(positionals[0], {
        ...values,
        maxFrames: values["max-frames"],
      });
      console.log(
        JSON.stringify({
          manifest: join(resolve(values.out), "manifest.json"),
          review: join(resolve(values.out), "review.json"),
          frames: result.frames.length,
          contact_sheets: result.contact_sheets,
          has_audio: result.has_audio,
        }),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
