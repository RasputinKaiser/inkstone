import { createReadStream } from "node:fs";
import { readFile, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { applyCommand, normalizeCommand } from "./commands.js";
import { hashJson } from "./model.js";
import { ensureProject, writeProject } from "./project.js";
import { probeAsset, readAssetMap, writeAssetMap } from "./assets.js";
import { publicReceipt, renderProject } from "./renderer.js";

const port = Number(process.env.INKSTONE_PORT ?? 4318);
export const defaultProjectPath = resolve(process.env.INKSTONE_PROJECT ?? ".inkstone/project.json");
const projectPath = defaultProjectPath;
const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const localRoot = resolve(".inkstone");
const localAssetRoot = resolve(localRoot, "assets");
const assetMapPath = resolve(localRoot, "asset-map.json");

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(contentType.startsWith("application/json") ? `${JSON.stringify(body)}\n` : body);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function rawBody(request: IncomingMessage, limit = 50 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("asset exceeds the 50 MiB local import limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function importLocalAsset(request: IncomingMessage): Promise<Record<string, unknown>> {
  const filename = String(request.headers["x-inkstone-filename"] ?? "asset");
  const relinkId = typeof request.headers["x-inkstone-relink-id"] === "string" ? request.headers["x-inkstone-relink-id"] : "";
  if (!filename || filename.includes("..") || /[\\/\0]/.test(filename) || filename.length > 160) throw new Error("unsafe asset filename");
  const bytes = await rawBody(request);
  if (bytes.length === 0) throw new Error("empty media body");
  const tempPath = resolve(localAssetRoot, `.incoming-${process.pid}-${Date.now()}`);
  await mkdir(localAssetRoot, { recursive: true });
  await writeFile(tempPath, bytes);
  try {
    const probed = await probeAsset(tempPath);
    if (relinkId && relinkId !== probed.asset.id) throw new Error("relink rejected: file bytes do not match the existing content identity");
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : ".media";
    const storedPath = resolve(localAssetRoot, `${probed.hash}${extension}`);
    await writeFile(storedPath, bytes, { flag: "wx" }).catch(async (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const map = await readAssetMap(assetMapPath);
    map.assets[relinkId || probed.asset.id] = { locations: [storedPath], importedAt: "local" };
    await writeAssetMap(assetMapPath, map);
    return { asset: { ...probed.asset, id: relinkId || probed.asset.id, name: filename, contentType: String(request.headers["content-type"] ?? "application/octet-stream") }, probe: probed.probe, relinked: Boolean(relinkId), mediaUrl: `/api/media/asset/${relinkId || probed.asset.id}` };
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/api/health") {
    send(response, 200, { ok: true, service: "inkstone", maintainer: "RasputinKaiser", projectPath });
    return;
  }
  if (url.pathname === "/api/project" && method === "GET") {
    send(response, 200, await ensureProject(projectPath));
    return;
  }
  if (url.pathname === "/api/assets/status" && method === "GET") {
    const map = await readAssetMap(assetMapPath);
    const availableIds: string[] = [];
    for (const [id, entry] of Object.entries(map.assets)) {
      for (const location of entry.locations ?? []) {
        try { await stat(location); availableIds.push(id); break; } catch { /* missing relink remains unavailable */ }
      }
    }
    send(response, 200, { availableIds: availableIds.sort() });
    return;
  }
  if (url.pathname === "/api/project" && method === "PUT") {
    const project = await ensureProject(projectPath);
    const incoming = await body(request);
    if (!incoming || typeof incoming !== "object") throw new Error("project body must be an object");
    await writeProject(projectPath, { ...project, ...(incoming as Record<string, unknown>) } as never);
    send(response, 200, await ensureProject(projectPath));
    return;
  }
  if (url.pathname === "/api/assets/import" && method === "POST") {
    send(response, 201, await importLocalAsset(request));
    return;
  }
  if (url.pathname.startsWith("/api/assets/") && url.pathname.endsWith("/probe") && method === "GET") {
    const id = url.pathname.slice("/api/assets/".length, -"/probe".length);
    const map = await readAssetMap(assetMapPath);
    const path = map.assets[id]?.locations[0];
    if (!path || !path.startsWith(localAssetRoot)) { send(response, 404, { error: "asset not found" }); return; }
    const probed = await probeAsset(path);
    send(response, 200, { asset: { ...probed.asset, id }, probe: probed.probe });
    return;
  }
  if (url.pathname === "/api/command" && method === "POST") {
    const project = await ensureProject(projectPath);
    const command = normalizeCommand(await body(request), `service-command-${project.revision + 1}`);
    const result = applyCommand(project, command);
    if (result.changed) await writeProject(projectPath, result.project);
    send(response, 200, { ...result, hash: hashJson(result.project) });
    return;
  }
  if ((url.pathname === "/api/preview" || url.pathname === "/api/export") && method === "POST") {
    const project = await ensureProject(projectPath);
    const output = url.pathname === "/api/preview" ? resolve(".inkstone/preview.mp4") : resolve(".inkstone/exports/inkstone-export.mp4");
    const receipt = await renderProject(project, output, await readAssetMap(assetMapPath));
    send(response, 200, { ok: true, receipt: publicReceipt(receipt), mediaUrl: url.pathname === "/api/preview" ? "/api/media/preview" : "/api/media/export" });
    return;
  }
  if (url.pathname === "/api/media/preview" || url.pathname === "/api/media/export") {
    const path = url.pathname.endsWith("preview") ? resolve(".inkstone/preview.mp4") : resolve(".inkstone/exports/inkstone-export.mp4");
    await serveMedia(path, response);
    return;
  }
  if (url.pathname.startsWith("/api/media/asset/")) {
    const id = url.pathname.slice("/api/media/asset/".length);
    const map = await readAssetMap(assetMapPath);
    const path = map.assets[id]?.locations[0];
    if (!path || !path.startsWith(localAssetRoot)) { send(response, 404, { error: "asset not found" }); return; }
    await serveMedia(path, response);
    return;
  }
  await staticFile(url.pathname, response);
}

async function serveMedia(path: string, response: ServerResponse): Promise<void> {
  try {
    const info = await stat(path);
    response.writeHead(200, { "content-type": "video/mp4", "content-length": info.size, "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  } catch { send(response, 404, { error: "media not found" }); }
}

async function staticFile(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const fromSource = requested.startsWith("/src/");
  const baseRoot = fromSource ? sourceRoot : staticRoot;
  const candidate = normalize(join(baseRoot, fromSource ? requested.slice("/src/".length) : requested));
  if (!candidate.startsWith(baseRoot)) {
    send(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("not a file");
    const contentType = extname(candidate) === ".html" ? "text/html; charset=utf-8" : extname(candidate) === ".js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    createReadStream(candidate).pipe(response);
  } catch {
    send(response, 404, { error: "not found" });
  }
}

const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => send(response, 400, { error: error instanceof Error ? error.message : String(error) }));
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, "127.0.0.1", () => process.stdout.write(`Inkstone listening on http://127.0.0.1:${port}\n`));
}

export { server };
