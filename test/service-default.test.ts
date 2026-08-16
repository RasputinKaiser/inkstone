import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultProjectPath } from "../src/service.js";
import { ensureProject } from "../src/project.js";

test("service default project is private and does not edit the tracked example", async () => {
  const examplePath = "examples/fixture-project.json";
  const before = await readFile(examplePath, "utf8");
  assert.match(defaultProjectPath, /[\\/]\.inkstone[\\/]project\.json$/);
  await ensureProject(defaultProjectPath, "private-default");
  assert.equal(await readFile(examplePath, "utf8"), before);
});
