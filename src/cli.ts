import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyCommand, normalizeCommand } from "./commands.js";
import { hashJson, summarize, validateProject } from "./model.js";
import { readProject, writeProject } from "./project.js";
import { readAssetMap, validateAssetMap, writeAssetMap } from "./assets.js";
import { hashPath, probeFile, publicReceipt, renderProject, verifyReceipt } from "./renderer.js";

const args = process.argv.slice(2);
const command = args[0];

function value(flag: string, fallback?: string): string {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] as string : fallback ?? "";
}

function print(valueToPrint: unknown): void {
  process.stdout.write(`${JSON.stringify(valueToPrint)}\n`);
}

class CliError extends Error { constructor(message: string, public readonly code = 2) { super(message); } }
function fail(message: string, code = 2): never { throw new CliError(message, code); }

async function main(): Promise<void> {
  if (!command) fail("usage: inkstone <inspect|probe|validate|edit|snapshot|render|verify>");
  if (command === "probe") {
    const input = value("--input");
    if (!input) fail("probe requires --input");
    print({ ok: true, input: resolve(input), sha256: await hashPath(resolve(input)), ffprobe: probeFile(resolve(input)) });
    return;
  }
  const projectPath = value("--project", "examples/fixture-project.json");
  if (command === "inspect") {
    const project = await readProject(projectPath);
    print({ ok: true, project: summarize(project), hash: hashJson(project) });
    return;
  }
  if (command === "validate") {
    const project = await readProject(projectPath);
    const mapPath = value("--asset-map", process.env.INKSTONE_ASSET_MAP ?? resolve(".inkstone/asset-map.json"));
    const map = await readAssetMap(mapPath);
    const errors = [...validateProject(project), ...validateAssetMap(map)];
    for (const asset of project.assets) {
      const locations = map.assets[asset.id]?.locations ?? [];
      if (locations.length === 0) errors.push(`asset ${asset.name} is missing a local mapping; relink before render`);
    }
    print({ ok: errors.length === 0, revision: project.revision, errors });
    if (errors.length) process.exitCode = 2;
    return;
  }
  if (command === "snapshot") {
    const project = await readProject(projectPath);
    const output = value("--out", `${projectPath}.snapshot.json`);
    await writeFile(output, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    print({ ok: true, writes: true, path: output, revision: project.revision, hash: hashJson(project) });
    return;
  }
  if (command === "render") {
    const project = await readProject(projectPath);
    const output = value("--out", "inkstone-render.mp4");
    const mapPath = value("--asset-map", process.env.INKSTONE_ASSET_MAP ?? resolve(".inkstone/asset-map.json"));
    const receipt = await renderProject(project, output, await readAssetMap(mapPath));
    print({ ok: true, receipt: publicReceipt(receipt) });
    return;
  }
  if (command === "verify") {
    const project = await readProject(projectPath);
    const receiptPath = value("--receipt", `${value("--out", "inkstone-render.mp4")}.receipt.json`);
    const mapPath = value("--asset-map", process.env.INKSTONE_ASSET_MAP ?? resolve(".inkstone/asset-map.json"));
    const result = await verifyReceipt(project, receiptPath, await readAssetMap(mapPath));
    print({ ok: result.valid, stale: result.stale, reasons: result.reasons, receipt: publicReceipt(result.receipt) });
    if (!result.valid) process.exitCode = 3;
    return;
  }
  if (command === "edit") {
    const mode = args[1];
    if (mode !== "dry-run" && mode !== "apply") fail("edit requires dry-run or apply");
    const project = await readProject(projectPath);
    const commandPath = value("--command");
    if (!commandPath) fail("edit requires --command");
    const commandValue = normalizeCommand(JSON.parse(await readFile(commandPath, "utf8")), `cli-command-${project.revision + 1}`);
    const result = applyCommand(project, commandValue);
    if (mode === "apply") {
      await writeProject(projectPath, result.project);
      const localPath = typeof commandValue.payload.localPath === "string" ? commandValue.payload.localPath : "";
      if (localPath) {
        const mapPath = value("--asset-map", process.env.INKSTONE_ASSET_MAP ?? resolve(".inkstone/asset-map.json"));
        const map = await readAssetMap(mapPath);
        map.assets[commandValue.payload.assetId as string] = { locations: [localPath], importedAt: "local" };
        await writeAssetMap(mapPath, map);
      }
    }
    print({ ok: true, dryRun: mode === "dry-run", writes: mode === "apply", command: commandValue, before: result.before, after: result.after, revision: result.project.revision, projectHash: hashJson(result.project) });
    return;
  }
  fail(`unknown command: ${command}`);
}

main().catch((error: unknown) => { process.exitCode = error instanceof CliError ? error.code : 3; process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); });
