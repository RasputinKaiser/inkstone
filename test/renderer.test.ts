import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyCommand } from "../src/commands.js";
import { createSyntheticFixture } from "../src/fixtures.js";
import { clone, type ProjectDocumentV1 } from "../src/model.js";
import { hashPath, renderProject, runTool, verifyReceipt } from "../src/renderer.js";
import { emptyAssetMap, writeAssetMap, type LocalAssetMapV1 } from "../src/assets.js";

async function renderVariant(root: string, project: ProjectDocumentV1, map: LocalAssetMapV1, name: string, timeoutMs?: number) {
  return renderProject(project, join(root, `${name}.mp4`), map, timeoutMs === undefined ? {} : { timeoutMs });
}

test("typed trim, split/order, overlays, and gain alter rendered output", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkstone-render-test-"));
  try {
    const project = await createSyntheticFixture(root);
    const secondSource = join(root, "second.mp4");
    const generated = runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x9a5b35:s=320x180:r=24", "-t", "2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-threads", "1", secondSource]);
    assert.equal(generated.status, 0, generated.stderr);
    const secondId = await hashPath(secondSource);
    project.assets.push({ id: secondId, kind: "video", name: "second.mp4", durationMs: 2000 });
    const map = emptyAssetMap();
    map.assets[project.assets[0]?.id ?? ""] = { locations: [join(root, "fixture-video.mp4")], importedAt: "local" };
    map.assets[project.assets[1]?.id ?? ""] = { locations: [join(root, "fixture-tone.wav")], importedAt: "local" };
    map.assets[secondId] = { locations: [secondSource], importedAt: "local" };
    await writeAssetMap(join(root, "asset-map.json"), map);
    project.tracks.video.clips = [
      { id: "v-one", assetId: project.assets[0]?.id ?? "", source: { startMs: 0, endMs: 1000 }, timeline: { startMs: 0, endMs: 1000 }, order: 0, gainDb: 0, muted: false, fadeInMs: 0, fadeOutMs: 0, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } },
      { id: "v-two", assetId: secondId, source: { startMs: 0, endMs: 1000 }, timeline: { startMs: 1000, endMs: 2000 }, order: 1, gainDb: 0, muted: false, fadeInMs: 0, fadeOutMs: 0, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } }
    ];
    const base = await renderVariant(root, project, map, "base");
    assert.equal((base.ffprobe.format as Record<string, unknown> | undefined)?.filename, undefined, "receipt probe must not expose host paths");
    const splitQa = applyCommand(project, { schemaVersion: 1, id: "qa-split", type: "split_clip", payload: { clipId: "v-one", splitMs: 500, secondClipId: "v-one-b" } }).project;
    const qa = applyCommand(splitQa, { schemaVersion: 1, id: "qa-transition", type: "set_transition", payload: { clipId: "v-one", side: "out", kind: "crossfade", durationMs: 180 } }).project;
    const movedQa = applyCommand(qa, { schemaVersion: 1, id: "qa-move", type: "move_clip", payload: { clipId: "v-one", timelineStartMs: 100, order: 0 } }).project;
    const overlaidQa = applyCommand(movedQa, { schemaVersion: 1, id: "qa-title", type: "set_text", payload: { id: "qa-title", startMs: 0, endMs: 800, text: "QA title", size: 32, color: "#f7f4ed", align: "center" } }).project;
    const qaWithCaption = applyCommand(overlaidQa, { schemaVersion: 1, id: "qa-caption", type: "set_caption", payload: { id: "qa-caption", startMs: 0, endMs: 900, text: "QA caption", language: "en" } }).project;
    const qaStarted = Date.now();
    const qaRender = await renderVariant(root, qaWithCaption, map, "qa-transition-overlays", 10_000);
    const qaElapsedMs = Date.now() - qaStarted;
    assert.ok(qaElapsedMs < 10_000, `renderer regression exceeded bounded timeout: ${qaElapsedMs}ms`);
    assert.ok(qaRender.output.sizeBytes > 0, "split/move/overlap/crossfade/overlay render should produce media");
    const qaVerified = await verifyReceipt(qaWithCaption, join(root, "qa-transition-overlays.mp4.receipt.json"), map);
    assert.equal(qaVerified.valid, true, qaVerified.reasons.join("; "));

    const overlapQa = clone(project);
    overlapQa.durationMs = 3000;
    const overlapVideoOne = overlapQa.tracks.video.clips[0];
    const overlapVideoTwo = overlapQa.tracks.video.clips[1];
    assert.ok(overlapVideoOne && overlapVideoTwo);
    overlapVideoOne.source = { startMs: 0, endMs: 1500 };
    overlapVideoOne.timeline = { startMs: 100, endMs: 1600 };
    overlapVideoOne.transitionOut = { kind: "crossfade", durationMs: 180 };
    overlapVideoTwo.source = { startMs: 0, endMs: 1500 };
    overlapVideoTwo.timeline = { startMs: 1500, endMs: 3000 };
    overlapVideoTwo.transitionIn = { kind: "cut", durationMs: 0 };
    overlapQa.tracks.audio.clips = overlapQa.tracks.audio.clips.slice(0, 1).map((clip) => ({ ...clip, id: "a-overlap-one", source: { startMs: 0, endMs: 1500 }, timeline: { startMs: 100, endMs: 1600 }, transitionOut: { kind: "crossfade", durationMs: 180 } }));
    const overlapAudioSource = overlapQa.tracks.audio.clips[0];
    assert.ok(overlapAudioSource);
    overlapQa.tracks.audio.clips.push({ ...overlapAudioSource, id: "a-overlap-two", timeline: { startMs: 1500, endMs: 3000 }, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } });
    const overlapStarted = Date.now();
    const overlapRender = await renderVariant(root, overlapQa, map, "timeline-overlap", 10_000);
    assert.ok(Date.now() - overlapStarted < 10_000, "100ms-overlap renderer regression must remain bounded");
    const overlapStreams = overlapRender.ffprobe.streams as Array<Record<string, unknown>>;
    const overlapVideo = overlapStreams.find((stream) => stream.codec_type === "video");
    const overlapAudio = overlapStreams.find((stream) => stream.codec_type === "audio");
    const expectedFrames = Math.round(overlapQa.durationMs / 1000 * project.frameRate.numerator / project.frameRate.denominator);
    const videoDuration = Number(overlapVideo?.duration ?? 0);
    const audioDuration = Number(overlapAudio?.duration ?? 0);
    assert.equal(Number(overlapVideo?.nb_frames), expectedFrames, "100ms timeline overlap must preserve the full decoded video frame count");
    assert.ok(Math.abs(videoDuration - overlapQa.durationMs / 1000) <= 1 / project.frameRate.numerator + 0.01, `video duration ${videoDuration} should match 3s timeline`);
    assert.ok(Math.abs(videoDuration - audioDuration) <= 1 / project.frameRate.numerator + 0.01, `A/V duration drift exceeds one frame: video=${videoDuration}, audio=${audioDuration}`);
    const swapped = clone(project);
    const first = swapped.tracks.video.clips[0];
    const second = swapped.tracks.video.clips[1];
    assert.ok(first && second);
    [first.timeline, second.timeline] = [second.timeline, first.timeline];
    const reordered = await renderVariant(root, swapped, map, "reordered");
    assert.notEqual(reordered.output.sha256, base.output.sha256, "move/order must alter decoded render");

    let split = applyCommand(project, { schemaVersion: 1, id: "split", type: "split_clip", payload: { clipId: "v-one", splitMs: 500, secondClipId: "v-one-b" } }).project;
    split = applyCommand(split, { schemaVersion: 1, id: "split-transition", type: "set_transition", payload: { clipId: "v-one", side: "out", kind: "crossfade", durationMs: 120 } }).project;
    split = applyCommand(split, { schemaVersion: 1, id: "split-overlap", type: "move_clip", payload: { clipId: "v-one-b", timelineStartMs: 450, order: 1 } }).project;
    const splitRender = await renderVariant(root, split, map, "split");
    assert.notEqual(splitRender.output.sha256, base.output.sha256, "split/crossfade must alter render");

    const trimmed = applyCommand(project, { schemaVersion: 1, id: "trim", type: "trim_clip", payload: { clipId: "v-one", sourceStartMs: 0, sourceEndMs: 500, timelineStartMs: 0 } }).project;
    trimmed.tracks.video.clips = trimmed.tracks.video.clips.filter((clip) => clip.id !== "v-two");
    trimmed.tracks.audio.clips = [];
    trimmed.durationMs = 500;
    const trimmedRender = await renderVariant(root, trimmed, map, "trimmed");
    const trimmedVideo = (trimmedRender.ffprobe.streams as Array<Record<string, unknown>>).find((stream) => stream.codec_type === "video");
    assert.ok(Number(trimmedVideo?.duration ?? 0) < 0.8, "trimmed render duration should be shorter");

    const captioned = applyCommand(project, { schemaVersion: 1, id: "caption", type: "set_caption", payload: { id: "caption", startMs: 0, endMs: 800, text: "Caption proof", language: "en" } }).project;
    const captionRender = await renderVariant(root, captioned, map, "caption");
    const titled = applyCommand(captioned, { schemaVersion: 1, id: "title", type: "set_text", payload: { id: "title", startMs: 0, endMs: 800, text: "Title proof", size: 36, color: "#f7f4ed", align: "center" } }).project;
    const titleRender = await renderVariant(root, titled, map, "title");
    assert.notEqual(captionRender.output.sha256, base.output.sha256, "caption must alter decoded pixels");
    assert.notEqual(titleRender.output.sha256, captionRender.output.sha256, "text must alter decoded pixels");

    const gained = applyCommand(project, { schemaVersion: 1, id: "gain", type: "set_gain", payload: { clipId: "audio-clip-1", gainDb: -18, fadeInMs: 200, fadeOutMs: 200 } }).project;
    const gainRender = await renderVariant(root, gained, map, "gain");
    assert.notEqual(gainRender.output.sha256, base.output.sha256, "gain/fades must alter encoded audio");
    await writeFile(join(root, "fixture-tone.wav"), Buffer.concat([await readFile(join(root, "fixture-tone.wav")), Buffer.from([0]) ]));
    const stale = await verifyReceipt(project, join(root, "base.mp4.receipt.json"), map);
    assert.equal(stale.valid, false);
    assert.equal(stale.stale, true);
    assert.match(stale.reasons.join(" "), /source bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI dry-run never writes the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkstone-cli-test-"));
  try {
    const projectPath = join(root, "project.json");
    const commandPath = join(root, "command.json");
    await writeFile(projectPath, JSON.stringify({ schemaVersion: 1, id: "dry", title: "Dry", frameRate: { numerator: 24, denominator: 1 }, dimensions: { width: 320, height: 180 }, sampleRate: 48000, durationMs: 1000, assets: [], tracks: { video: { id: "v", type: "video", clips: [] }, audio: { id: "a", type: "audio", clips: [] } }, textOverlays: [], captionOverlays: [], revision: 0, commandHistory: [] }));
    await writeFile(commandPath, JSON.stringify({ schemaVersion: 1, id: "caption", type: "set_caption", payload: { id: "c", startMs: 0, endMs: 500, text: "dry", language: "en" } }));
    const before = await hashPath(projectPath);
    const output = execFileSync(process.execPath, ["dist/src/cli.js", "edit", "dry-run", "--project", projectPath, "--command", commandPath], { encoding: "utf8" });
    assert.equal(JSON.parse(output).writes, false);
    assert.equal(await hashPath(projectPath), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("renderer tool timeout fails closed with a structured diagnostic", () => {
  const started = Date.now();
  const result = runTool(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], 50);
  const elapsedMs = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 124);
  assert.equal(result.code, "TOOL_TIMEOUT");
  assert.match(result.stderr, /INKSTONE_TOOL_TIMEOUT/);
  assert.ok(elapsedMs < 1000, `tool timeout should fail closed promptly: ${elapsedMs}ms`);
});
