import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolveAssetPaths, validateAssetMap, type LocalAssetMapV1 } from "./assets.js";
import { hashJson, type Clip, type ProjectDocumentV1, stableStringify } from "./model.js";

export interface ToolResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  code?: string;
}
export interface RenderReceiptV1 {
  schemaVersion: 1;
  revision: number;
  projectHash: string;
  sourceHashes: string[];
  toolchain: { ffmpeg: string; ffprobe: string; renderer: "inkstone-cpu-graph-v1" };
  output: { path: string; sha256: string; sizeBytes: number };
  ffprobe: Record<string, unknown>;
  stale: boolean;
  warnings: string[];
}
export interface PublicRenderReceiptV1 {
  schemaVersion: 1;
  revision: number;
  projectHash: string;
  sourceHashes: string[];
  toolchain: RenderReceiptV1["toolchain"];
  output: { sha256: string; sizeBytes: number };
  ffprobe: Record<string, unknown>;
  stale: boolean;
  warnings: string[];
}

const TOOL_TIMEOUT_MS = 20_000;

export function runTool(command: string, args: string[], timeoutMs = TOOL_TIMEOUT_MS): ToolResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errorCode === "ETIMEDOUT" || (result.signal === "SIGKILL" && result.status === null);
  if (timedOut) {
    return {
      status: 124,
      stdout: result.stdout ?? "",
      stderr: `INKSTONE_TOOL_TIMEOUT command=${command} timeoutMs=${timeoutMs}`,
      timedOut: true,
      code: "TOOL_TIMEOUT"
    };
  }
  return {
    status: result.status ?? 3,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error ?? "tool failed"),
    code: errorCode
  };
}
export async function sha256File(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
export function probeFile(path: string): Record<string, unknown> {
  const result = runTool("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `ffprobe failed for ${path}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function seconds(ms: number): string { return Math.max(0, ms / 1000).toFixed(3); }
function frameRate(project: ProjectDocumentV1): string { return `${project.frameRate.numerator}/${project.frameRate.denominator}`; }
function sanitizeProbe(probe: Record<string, unknown>): Record<string, unknown> {
  const safe = JSON.parse(JSON.stringify(probe)) as Record<string, unknown>;
  const format = safe.format;
  if (format && typeof format === "object") delete (format as Record<string, unknown>).filename;
  return safe;
}
function orderedClips(clips: Clip[]): Clip[] { return [...clips].sort((a, b) => a.timeline.startMs - b.timeline.startMs || a.order - b.order || a.id.localeCompare(b.id)); }

function overlaySpecs(project: ProjectDocumentV1, clip: Clip): Array<{ text: string; start: number; end: number; y: number; height: number }> {
  const specs: Array<{ text: string; start: number; end: number; y: number; height: number }> = [];
  for (const overlay of project.textOverlays) {
    if (overlay.timeline.endMs <= clip.timeline.startMs || overlay.timeline.startMs >= clip.timeline.endMs) continue;
    const start = Math.max(0, overlay.timeline.startMs - clip.timeline.startMs);
    const end = Math.min(clip.timeline.endMs, overlay.timeline.endMs) - clip.timeline.startMs;
    specs.push({ text: overlay.text, start, end, y: 16, height: Math.max(12, Math.min(44, Math.round(overlay.style.size / 2))) });
  }
  for (const overlay of project.captionOverlays) {
    if (overlay.timeline.endMs <= clip.timeline.startMs || overlay.timeline.startMs >= clip.timeline.endMs) continue;
    const start = Math.max(0, overlay.timeline.startMs - clip.timeline.startMs);
    const end = Math.min(clip.timeline.endMs, overlay.timeline.endMs) - clip.timeline.startMs;
    specs.push({ text: overlay.text, start, end, y: -40, height: 32 });
  }
  return specs;
}

const FONT: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"], C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"], D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"], E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"], G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"], I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"], J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"], K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"], L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"], M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"], O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"], Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"], R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"], S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"], U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"], W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"], X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"], Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"], "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"], "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"], "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"], "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"], "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"], "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"], ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"], ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"]
};
function textPpm(text: string, width: number, height: number, y: number): Buffer {
  const scale = Math.max(2, Math.min(6, Math.floor(width / 180)));
  const chars = [...text.slice(0, 64)].map((char) => FONT[char.toUpperCase()] ?? FONT[" "]);
  const glyphWidth = 6 * scale;
  const xStart = Math.max(0, Math.floor((width - chars.length * glyphWidth) / 2));
  const pixels = Buffer.alloc(width * height * 3);
  for (let character = 0; character < chars.length; character += 1) {
    const glyph = chars[character];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row += 1) for (let column = 0; column < (glyph[row]?.length ?? 0); column += 1) if (glyph[row]?.[column] === "1") for (let yy = 0; yy < scale; yy += 1) for (let xx = 0; xx < scale; xx += 1) {
      const px = xStart + character * glyphWidth + column * scale + xx;
      const py = y + row * scale + yy;
      if (px >= 0 && px < width && py >= 0 && py < height) { const offset = (py * width + px) * 3; pixels[offset] = 247; pixels[offset + 1] = 244; pixels[offset + 2] = 237; }
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

function audioFilters(project: ProjectDocumentV1, clip: Clip, durationMs: number): string[] {
  const filters = [`atrim=start=${seconds(clip.source.startMs)}:end=${seconds(clip.source.endMs)}`, "asetpts=PTS-STARTPTS", `aresample=${project.sampleRate}`];
  filters.push(clip.muted ? "volume=0" : `volume=${clip.gainDb.toFixed(2)}dB`);
  if (clip.fadeInMs > 0) filters.push(`afade=t=in:st=0:d=${seconds(clip.fadeInMs)}`);
  if (clip.fadeOutMs > 0) filters.push(`afade=t=out:st=${seconds(Math.max(0, durationMs - clip.fadeOutMs))}:d=${seconds(clip.fadeOutMs)}`);
  return filters;
}

function chainVideos(labels: string[], clips: Clip[], graph: string[]): { label: string; durationMs: number } {
  if (labels.length === 1) return { label: labels[0] ?? "", durationMs: clips[0] ? clips[0].timeline.endMs - clips[0].timeline.startMs : 0 };
  let current = labels[0] ?? "";
  let durationMs = clips[0] ? clips[0].timeline.endMs - clips[0].timeline.startMs : 0;
  for (let index = 1; index < labels.length; index += 1) {
    const incoming = labels[index];
    const previous = clips[index - 1];
    const nextClip = clips[index];
    const nextDuration = nextClip ? nextClip.timeline.endMs - nextClip.timeline.startMs : 0;
    const timelineOverlapMs = previous && nextClip ? Math.max(0, previous.timeline.endMs - nextClip.timeline.startMs) : 0;
    const fade = previous?.transitionOut.kind === "crossfade" ? Math.min(previous.transitionOut.durationMs, timelineOverlapMs, durationMs, nextDuration) : 0;
    const output = `vchain${index}`;
    if (fade > 0) { graph.push(`[${current}][${incoming}]xfade=transition=fade:duration=${seconds(fade)}:offset=${seconds(durationMs - fade)},setpts=PTS-STARTPTS,settb=AVTB[${output}]`); durationMs += nextDuration - fade; }
    else { graph.push(`[${current}][${incoming}]concat=n=2:v=1:a=0,setpts=PTS-STARTPTS,settb=AVTB[${output}]`); durationMs += nextDuration; }
    current = output;
  }
  return { label: current, durationMs };
}

function chainAudio(labels: string[], clips: Clip[], graph: string[]): string {
  if (labels.length === 0) { graph.push(`[silence]aresample=48000[aout]`); return "aout"; }
  if (labels.length === 1) return labels[0] ?? "";
  let current = labels[0] ?? "";
  for (let index = 1; index < labels.length; index += 1) {
    const incoming = labels[index];
    const previous = clips[index - 1];
    const nextClip = clips[index];
    const nextDuration = nextClip ? nextClip.timeline.endMs - nextClip.timeline.startMs : 0;
    const timelineOverlapMs = previous && nextClip ? Math.max(0, previous.timeline.endMs - nextClip.timeline.startMs) : 0;
    const fade = previous?.transitionOut.kind === "crossfade" ? Math.min(previous.transitionOut.durationMs, timelineOverlapMs, nextDuration) : 0;
    const output = `achain${index}`;
    if (fade > 0) graph.push(`[${current}][${incoming}]acrossfade=d=${seconds(fade)}[${output}]`);
    else graph.push(`[${current}][${incoming}]concat=n=2:v=0:a=1[${output}]`);
    current = output;
  }
  return current;
}

export async function renderProject(project: ProjectDocumentV1, outputPath: string, assetMap: LocalAssetMapV1, options: { timeoutMs?: number } = {}): Promise<RenderReceiptV1> {
  const mapErrors = validateAssetMap(assetMap);
  if (mapErrors.length > 0) throw new Error(`invalid local asset map: ${mapErrors.join("; ")}`);
  const sources = await resolveAssetPaths(project.assets, assetMap);
  const sourceByAsset = new Map(sources.map((source) => [source.asset.id, source]));
  const videoClips = orderedClips(project.tracks.video.clips);
  const audioClips = orderedClips(project.tracks.audio.clips);
  if (videoClips.length === 0) throw new Error("no video clips are present; insert a video clip before rendering");
  if (videoClips.some((clip) => !sourceByAsset.has(clip.assetId)) || audioClips.some((clip) => !sourceByAsset.has(clip.assetId))) throw new Error("a clip references a missing or unlinked asset; relink before rendering");
  const uniqueSources = [...sourceByAsset.values()].sort((a, b) => a.asset.id.localeCompare(b.asset.id));
  const inputIndex = new Map(uniqueSources.map((source, index) => [source.asset.id, index]));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const source of uniqueSources) args.push("-i", source.path);
  const graph: string[] = [];
  const overlayRoot = await mkdtemp(join(tmpdir(), "inkstone-overlays-"));
  let overlayInputIndex = uniqueSources.length;
  const videoLabels: string[] = [];
  const videoSequenceClips: Clip[] = [];
  let videoCursor = 0;
  for (const [index, clip] of videoClips.entries()) {
    const input = inputIndex.get(clip.assetId);
    if (input === undefined) throw new Error(`missing input for clip ${clip.id}`);
    if (clip.timeline.startMs > videoCursor) {
      const gap = clip.timeline.startMs - videoCursor;
      const gapLabel = `vgap-${index}`;
      graph.push(`color=c=black:s=${project.dimensions.width}x${project.dimensions.height}:d=${seconds(gap)},fps=${frameRate(project)},setpts=PTS-STARTPTS,settb=AVTB[${gapLabel}]`);
      videoLabels.push(gapLabel);
      videoSequenceClips.push({ ...clip, id: `${gapLabel}-virtual`, source: { startMs: 0, endMs: gap }, timeline: { startMs: videoCursor, endMs: clip.timeline.startMs }, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } });
    }
    let label = `vclip${index}`;
    const filters = [`trim=start=${seconds(clip.source.startMs)}:end=${seconds(clip.source.endMs)}`, "setpts=PTS-STARTPTS", `fps=${frameRate(project)}`, `scale=${project.dimensions.width}:${project.dimensions.height}:force_original_aspect_ratio=decrease`, `pad=${project.dimensions.width}:${project.dimensions.height}:(ow-iw)/2:(oh-ih)/2:color=black`, "setsar=1", "setpts=PTS-STARTPTS", "settb=AVTB"];
    graph.push(`[${input}:v]${filters.join(",")} [${label}]`);
    for (const [overlayIndex, spec] of overlaySpecs(project, clip).entries()) {
      const sourceLabel = `overlay-source-${index}-${overlayIndex}`;
      const outputLabel = `vclip-${index}-overlay-${overlayIndex}`;
      const textY = spec.y < 0 ? project.dimensions.height + spec.y : spec.y;
      const overlayPath = join(overlayRoot, `overlay-${index}-${overlayIndex}.ppm`);
      await writeFile(overlayPath, textPpm(spec.text, project.dimensions.width, project.dimensions.height, textY));
      const clipDurationMs = Math.max(1, clip.timeline.endMs - clip.timeline.startMs);
      args.push("-f", "image2", "-framerate", frameRate(project), "-loop", "1", "-t", seconds(clipDurationMs), "-i", overlayPath);
      graph.push(`[${overlayInputIndex}:v]fps=${frameRate(project)},setpts=PTS-STARTPTS,format=rgba,colorkey=black:0.02:0,settb=AVTB[${sourceLabel}]`);
      graph.push(`[${label}][${sourceLabel}]overlay=x=0:y=0:enable='between(t,${seconds(spec.start)},${seconds(spec.end)})':eof_action=repeat,setpts=PTS-STARTPTS,settb=AVTB[${outputLabel}]`);
      label = outputLabel;
      overlayInputIndex += 1;
    }
    videoLabels.push(label);
    videoSequenceClips.push(clip);
    videoCursor = Math.max(videoCursor, clip.timeline.endMs);
  }
  if (videoCursor < project.durationMs) {
    const gap = project.durationMs - videoCursor;
    const gapLabel = "vgap-tail";
    graph.push(`color=c=black:s=${project.dimensions.width}x${project.dimensions.height}:d=${seconds(gap)},fps=${frameRate(project)},setpts=PTS-STARTPTS,settb=AVTB[${gapLabel}]`);
    videoLabels.push(gapLabel);
    videoSequenceClips.push({ ...videoClips[videoClips.length - 1]!, id: `${gapLabel}-virtual`, source: { startMs: 0, endMs: gap }, timeline: { startMs: videoCursor, endMs: project.durationMs }, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } });
  }
  const videoChain = chainVideos(videoLabels, videoSequenceClips, graph);
  graph.push(`[${videoChain.label}]format=yuv420p[vout]`);
  const audioLabels: string[] = [];
  const audioSequenceClips: Clip[] = [];
  let audioCursor = 0;
  for (const [index, clip] of audioClips.entries()) {
    const input = inputIndex.get(clip.assetId);
    if (input === undefined) throw new Error(`missing input for clip ${clip.id}`);
    if (clip.timeline.startMs > audioCursor) {
      const gap = clip.timeline.startMs - audioCursor;
      const gapLabel = `agap-${index}`;
      graph.push(`anullsrc=r=${project.sampleRate}:cl=stereo,atrim=duration=${seconds(gap)}[${gapLabel}]`);
      audioLabels.push(gapLabel);
      audioSequenceClips.push({ ...clip, id: `${gapLabel}-virtual`, source: { startMs: 0, endMs: gap }, timeline: { startMs: audioCursor, endMs: clip.timeline.startMs }, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } });
    }
    const label = `aclip${index}`;
    graph.push(`[${input}:a]${audioFilters(project, clip, clip.source.endMs - clip.source.startMs).join(",")} [${label}]`);
    audioLabels.push(label);
    audioSequenceClips.push(clip);
    audioCursor = Math.max(audioCursor, clip.timeline.endMs);
  }
  if (audioClips.length > 0 && audioCursor < project.durationMs) {
    const gap = project.durationMs - audioCursor;
    const gapLabel = "agap-tail";
    graph.push(`anullsrc=r=${project.sampleRate}:cl=stereo,atrim=duration=${seconds(gap)}[${gapLabel}]`);
    audioLabels.push(gapLabel);
    audioSequenceClips.push({ ...audioClips[audioClips.length - 1]!, id: `${gapLabel}-virtual`, source: { startMs: 0, endMs: gap }, timeline: { startMs: audioCursor, endMs: project.durationMs }, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } });
  }
  let audioLabel: string;
  if (audioLabels.length === 0) { graph.push(`anullsrc=r=${project.sampleRate}:cl=stereo,atrim=duration=${seconds(project.durationMs)}[aout]`); audioLabel = "aout"; }
  else audioLabel = chainAudio(audioLabels, audioSequenceClips, graph);
  graph.push(`[${audioLabel}]aresample=${project.sampleRate}[aoutfinal]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "[aoutfinal]", "-t", seconds(project.durationMs), "-r", `${project.frameRate.numerator}/${project.frameRate.denominator}`, "-s", `${project.dimensions.width}x${project.dimensions.height}`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-threads", "1", "-c:a", "aac", "-b:a", "128k", "-ar", String(project.sampleRate), "-metadata", "creation_time=0", outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const result = runTool("ffmpeg", args, options.timeoutMs);
  if (result.status !== 0) { await rm(overlayRoot, { recursive: true, force: true }); throw new Error(result.stderr.trim() || "ffmpeg render failed"); }
  const outputStat = await stat(outputPath);
  const outputHash = await sha256File(outputPath);
  const ffprobe = sanitizeProbe(probeFile(outputPath));
  const receipt: RenderReceiptV1 = { schemaVersion: 1, revision: project.revision, projectHash: hashJson(project), sourceHashes: uniqueSources.map((source) => source.hash), toolchain: { ffmpeg: toolVersion("ffmpeg"), ffprobe: toolVersion("ffprobe"), renderer: "inkstone-cpu-graph-v1" }, output: { path: outputPath, sha256: outputHash, sizeBytes: outputStat.size }, ffprobe, stale: false, warnings: ["Graph is generated from typed project state; user-supplied shell commands and filter strings are not accepted."] };
  await writeFile(`${outputPath}.receipt.json`, `${stableStringify(receipt)}\n`, "utf8");
  await rm(overlayRoot, { recursive: true, force: true });
  return receipt;
}

function toolVersion(command: string): string { const result = runTool(command, ["-version"]); return result.stdout.split("\n")[0]?.trim() ?? "unavailable"; }
export function publicReceipt(receipt: RenderReceiptV1): PublicRenderReceiptV1 { const { path: _privatePath, ...output } = receipt.output; return { ...receipt, output, ffprobe: sanitizeProbe(receipt.ffprobe), warnings: [...receipt.warnings, "output path is intentionally private and stays in the local receipt sidecar"] }; }
export async function verifyReceipt(project: ProjectDocumentV1, receiptPath: string, assetMap: LocalAssetMapV1): Promise<{ valid: boolean; stale: boolean; reasons: string[]; receipt: RenderReceiptV1 }> {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as RenderReceiptV1;
  const reasons: string[] = [];
  reasons.push(...validateAssetMap(assetMap).map((reason) => `invalid local asset map: ${reason}`));
  if (receipt.schemaVersion !== 1) reasons.push("unsupported receipt schema");
  if (receipt.revision !== project.revision) reasons.push(`receipt revision ${receipt.revision} differs from project ${project.revision}`);
  if (receipt.projectHash !== hashJson(project)) reasons.push("project hash differs");
  try { if ((await sha256File(receipt.output.path)) !== receipt.output.sha256) reasons.push("output hash differs"); } catch { reasons.push("output file is missing"); }
  const sources = await resolveAssetPaths(project.assets, assetMap);
  const currentSourceHashes = sources.sort((a, b) => a.asset.id.localeCompare(b.asset.id)).map(({ hash }) => hash);
  if (stableStringify(currentSourceHashes) !== stableStringify(receipt.sourceHashes)) reasons.push("source bytes or relink map differ");
  receipt.stale = reasons.length > 0;
  return { valid: reasons.length === 0, stale: receipt.stale, reasons, receipt };
}
export async function hashPath(path: string): Promise<string> { return sha256File(path); }
