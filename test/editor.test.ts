import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, normalizeCommand } from "../src/commands.js";
import { createProject } from "../src/model.js";

test("browser and CLI share the same normalized command shape", () => {
  const command = normalizeCommand({ type: "import_asset", payload: { assetId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "video", name: "camera.mp4", localLocations: ["browser://abc/camera.mp4"] } }, "ui-1");
  const fromCli = normalizeCommand(JSON.parse(JSON.stringify(command)), "cli-1");
  assert.deepEqual(fromCli, command);
  const result = applyCommand(createProject(), command);
  assert.equal(result.project.assets[0]?.id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(result.project.revision, 1);
});

test("all explicit editing operation names normalize without shell input", () => {
  const types = ["import_asset", "insert_clip", "trim_clip", "split_clip", "move_clip", "set_transition", "set_text", "set_caption", "set_gain", "delete_clip", "replace_clip", "undo", "redo"] as const;
  for (const type of types) assert.equal(normalizeCommand({ type, payload: {} }, type).type, type);
});
