import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import { type AssetRecord, stableStringify } from "./model.js";
import { hashPath, probeFile } from "./renderer.js";

export interface LocalAssetEntry { locations: string[]; importedAt: "local"; }
export interface LocalAssetMapV1 { schemaVersion: 1; assets: Record<string, LocalAssetEntry>; }

export function emptyAssetMap(): LocalAssetMapV1 { return { schemaVersion: 1, assets: {} }; }

export async function readAssetMap(path: string): Promise<LocalAssetMapV1> {
  try {
    const map = JSON.parse(await readFile(path, "utf8")) as Partial<LocalAssetMapV1>;
    return { schemaVersion: 1, assets: map.assets ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAssetMap();
    throw error;
  }
}

export async function writeAssetMap(path: string, map: LocalAssetMapV1): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${stableStringify(map)}\n`, "utf8");
}

export function validateLocalPath(path: string, root: string): string[] {
  const errors: string[] = [];
  if (!isAbsolute(path)) errors.push("asset location must be absolute");
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) errors.push("asset location escapes the local asset root");
  if (normalize(path) !== path && path.includes("..")) errors.push("asset location contains unsafe traversal");
  return errors;
}

export function validateAssetMap(map: LocalAssetMapV1): string[] {
  const errors: string[] = [];
  for (const [id, entry] of Object.entries(map.assets)) {
    if (!/^[a-f0-9]{64}$/i.test(id) && !id.startsWith("fixture-")) errors.push(`asset map key ${id} is not a content id`);
    for (const location of entry.locations ?? []) {
      if (!isAbsolute(location) || location.includes("\0") || /(^|[\\/])\.\.(?:[\\/]|$)/.test(location)) errors.push(`asset map location for ${id} is unsafe`);
    }
  }
  return errors;
}

export async function resolveAssetPaths(projectAssets: AssetRecord[], map: LocalAssetMapV1): Promise<{ asset: AssetRecord; path: string; hash: string }[]> {
  const result: { asset: AssetRecord; path: string; hash: string }[] = [];
  for (const asset of projectAssets) {
    const locations = map.assets[asset.id]?.locations ?? [];
    for (const location of locations) {
      try {
        await stat(location);
        result.push({ asset, path: location, hash: await hashPath(location) });
        break;
      } catch {
        // The validator/renderer reports the missing relink rather than falling back.
      }
    }
  }
  return result;
}

export async function probeAsset(path: string): Promise<{ asset: AssetRecord; hash: string; probe: Record<string, unknown> }> {
  const safeName = path.split(/[\\/]/).pop() ?? "asset";
  if (!safeName || safeName.includes("..") || /[\\/]/.test(safeName)) throw new Error("unsafe asset filename");
  const info = await stat(path);
  if (info.size > 50 * 1024 * 1024) throw new Error("asset exceeds the 50 MiB local import limit");
  const probe = probeFile(path);
  const streams = Array.isArray(probe.streams) ? probe.streams as Array<Record<string, unknown>> : [];
  const video = streams.some((stream) => stream.codec_type === "video");
  const audio = streams.some((stream) => stream.codec_type === "audio");
  if (!video && !audio) throw new Error("unsupported media: no audio or video stream");
  const format = probe.format as Record<string, unknown> | undefined;
  const duration = Number(format?.duration ?? 0);
  const safeProbe = JSON.parse(JSON.stringify(probe)) as Record<string, unknown>;
  if (safeProbe.format && typeof safeProbe.format === "object") delete (safeProbe.format as Record<string, unknown>).filename;
  return { asset: { id: await hashPath(path), kind: video ? "video" : "audio", name: safeName, sizeBytes: info.size, ...(Number.isFinite(duration) && duration > 0 ? { durationMs: Math.round(duration * 1000) } : {}), ...(typeof format?.format_name === "string" ? { metadata: { format: format.format_name } } : {}) }, hash: await hashPath(path), probe: safeProbe };
}
