import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/commands.js";
import { createProject, stableStringify, type ProjectDocumentV1 } from "../src/model.js";
import { OptimisticCommandQueue } from "../src/sync-model.js";

test("back-to-back browser commands preserve base revisions and converge with service", async () => {
  let server: ProjectDocumentV1 = createProject("sync-project", "Sync proof");
  server.durationMs = 1000;
  const sent: number[] = [];
  const queue = new OptimisticCommandQueue(server, async (command) => {
    sent.push(command.expectedRevision ?? -1);
    const result = applyCommand(server, command);
    server = result.project;
    return server;
  });
  queue.dispatch("import_asset", { assetId: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", kind: "video", name: "source.mp4" });
  queue.dispatch("set_caption", { id: "caption", startMs: 0, endMs: 500, text: "Sync", language: "en" });
  const browser = await queue.idle();
  assert.deepEqual(sent, [0, 1]);
  assert.equal(browser.revision, 2);
  assert.equal(server.revision, 2);
  assert.equal(stableStringify(browser), stableStringify(server));
});
