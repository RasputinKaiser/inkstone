import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "./commands.js";
import { createProject, hashJson, type ProjectDocumentV1 } from "./model.js";
import { hashPath, renderProject, runTool, verifyReceipt } from "./renderer.js";
import { emptyAssetMap, writeAssetMap, type LocalAssetMapV1 } from "./assets.js";

export async function createSyntheticFixture(root: string): Promise<ProjectDocumentV1> {
  const video = join(root, "fixture-video.mp4");
  const audio = join(root, "fixture-tone.wav");
  const videoResult = runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1f4036:s=320x180:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-threads", "1", "-c:a", "aac", "-b:a", "96k", "-metadata", "creation_time=0", video]);
  if (videoResult.status !== 0) throw new Error(videoResult.stderr.trim() || "could not create synthetic video");
  const audioResult = runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "2", "-c:a", "pcm_s16le", audio]);
  if (audioResult.status !== 0) throw new Error(audioResult.stderr.trim() || "could not create synthetic audio");
  const videoId = await hashPath(video);
  const audioId = await hashPath(audio);
  const project = createProject("fixture-project", "Synthetic proof cut");
  project.durationMs = 2000;
  project.assets = [
    { id: videoId, kind: "video", name: "fixture-video.mp4", durationMs: 2000 },
    { id: audioId, kind: "audio", name: "fixture-tone.wav", durationMs: 2000 }
  ];
  project.tracks.video.clips = [{ id: "video-clip-1", assetId: videoId, source: { startMs: 0, endMs: 2000 }, timeline: { startMs: 0, endMs: 2000 }, order: 0, gainDb: 0, muted: false, fadeInMs: 0, fadeOutMs: 0, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } }];
  project.tracks.audio.clips = [{ id: "audio-clip-1", assetId: audioId, source: { startMs: 0, endMs: 2000 }, timeline: { startMs: 0, endMs: 2000 }, order: 0, gainDb: -3, muted: false, fadeInMs: 40, fadeOutMs: 80, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } }];
  return project;
}

export async function verifySyntheticFixture(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "inkstone-fixture-"));
  try {
    const initial = await createSyntheticFixture(root);
    const map: LocalAssetMapV1 = emptyAssetMap();
    map.assets[initial.assets[0]?.id ?? ""] = { locations: [join(root, "fixture-video.mp4")], importedAt: "local" };
    map.assets[initial.assets[1]?.id ?? ""] = { locations: [join(root, "fixture-tone.wav")], importedAt: "local" };
    await writeAssetMap(join(root, "asset-map.json"), map);
    const captioned = applyCommand(initial, { schemaVersion: 1, id: "fixture-caption", type: "set_caption", payload: { id: "fixture-caption", startMs: 0, endMs: 1200, text: "Local proof", language: "en" } }).project;
    const output = join(root, "fixture-render.mp4");
    const receipt = await renderProject(captioned, output, map);
    const receiptPath = `${output}.receipt.json`;
    const verified = await verifyReceipt(captioned, receiptPath, map);
    if (!verified.valid || verified.stale) throw new Error(`fixture receipt failed: ${verified.reasons.join(", ")}`);
    return { ok: true, projectHash: hashJson(captioned), revision: captioned.revision, outputSha256: receipt.output.sha256, receipt: receiptPath, sources: captioned.assets.length };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifySyntheticFixture().then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 3; });
}
