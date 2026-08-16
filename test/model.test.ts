import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/commands.js";
import { createProject, hashJson, validateProject } from "../src/model.js";
import { validateAssetMap } from "../src/assets.js";

test("project normalizes to one primary video and audio track", () => {
  const project = createProject("test", "Proof");
  assert.equal(project.schemaVersion, 1);
  assert.equal(project.tracks.video.type, "video");
  assert.equal(project.tracks.audio.type, "audio");
  assert.deepEqual(validateProject(project), []);
});

test("typed command application has deterministic revision and history", () => {
  const project = createProject("test", "Proof");
  const imported = applyCommand(project, { schemaVersion: 1, id: "asset-1", type: "import_asset", payload: { assetId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", kind: "video", name: "source.mp4", localLocations: ["/tmp/source.mp4"] } }).project;
  const inserted = applyCommand(imported, { schemaVersion: 1, id: "clip-1", type: "insert_clip", payload: { track: "video", assetId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", clipId: "clip", sourceStartMs: 0, sourceEndMs: 1000, timelineStartMs: 0 } }).project;
  assert.equal(inserted.revision, 2);
  assert.equal("localLocations" in (inserted.assets[0] ?? {}), false, "host mappings stay in the sidecar");
  assert.equal(inserted.tracks.video.clips[0]?.timeline.endMs, 1000);
  assert.equal(hashJson(inserted), hashJson(JSON.parse(JSON.stringify(inserted))));
  const undone = applyCommand(inserted, { schemaVersion: 1, id: "undo-1", type: "undo", payload: {} }).project;
  assert.equal(undone.tracks.video.clips.length, 0);
  const redone = applyCommand(undone, { schemaVersion: 1, id: "redo-1", type: "redo", payload: {} }).project;
  assert.equal(redone.tracks.video.clips.length, 1);
});

test("validation reports malformed captions, overlaps, missing assets, and unsafe sidecars", () => {
  const project = createProject("invalid", "Invalid");
  project.durationMs = 1000;
  project.captionOverlays = [{ id: "caption", timeline: { startMs: 900, endMs: 1400 }, text: "bad", language: "" }];
  project.tracks.video.clips = [{ id: "missing", assetId: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", source: { startMs: 0, endMs: 1000 }, timeline: { startMs: 0, endMs: 700 }, order: 0, gainDb: 0, muted: false, fadeInMs: 0, fadeOutMs: 0, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } }, { id: "missing-2", assetId: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", source: { startMs: 0, endMs: 1000 }, timeline: { startMs: 500, endMs: 1000 }, order: 1, gainDb: 0, muted: false, fadeInMs: 0, fadeOutMs: 0, transitionIn: { kind: "cut", durationMs: 0 }, transitionOut: { kind: "cut", durationMs: 0 } }];
  const errors = validateProject(project);
  assert.match(errors.join(" "), /missing asset/);
  assert.match(errors.join(" "), /caption/);
  assert.match(errors.join(" "), /overlapping/);
  assert.match(validateAssetMap({ schemaVersion: 1, assets: { cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc: { locations: ["relative/..", "/tmp/../unsafe"], importedAt: "local" } } }).join(" "), /unsafe/);
});
