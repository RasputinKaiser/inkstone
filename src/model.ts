export type Rational = { numerator: number; denominator: number };
export type Dimensions = { width: number; height: number };
export type Range = { startMs: number; endMs: number };
export type AssetKind = "video" | "audio" | "image" | "unknown";

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  name: string;
  sizeBytes?: number;
  durationMs?: number;
  contentType?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type Transition = {
  kind: "cut" | "crossfade";
  durationMs: number;
};

export interface Clip {
  id: string;
  assetId: string;
  source: Range;
  timeline: Range;
  order: number;
  gainDb: number;
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  transitionIn: Transition;
  transitionOut: Transition;
}

export interface Track {
  id: string;
  type: "video" | "audio";
  clips: Clip[];
}

export interface TextOverlay {
  id: string;
  timeline: Range;
  text: string;
  style: { size: number; color: string; align: "left" | "center" | "right" };
}

export interface CaptionOverlay {
  id: string;
  timeline: Range;
  text: string;
  language: string;
}

export interface CommandPayload {
  [key: string]: unknown;
}

export type CommandType =
  | "import_asset"
  | "insert_clip"
  | "trim_clip"
  | "split_clip"
  | "move_clip"
  | "set_transition"
  | "set_text"
  | "set_caption"
  | "set_gain"
  | "delete_clip"
  | "replace_clip"
  | "undo"
  | "redo";

export interface CommandEnvelope {
  schemaVersion: 1;
  id: string;
  type: CommandType;
  payload: CommandPayload;
  expectedRevision?: number;
}

export interface CommandRecord {
  id: string;
  type: CommandType;
  payload: CommandPayload;
  before: EditableState;
  after: EditableState;
  undone: boolean;
}

export interface EditableState {
  title: string;
  durationMs: number;
  assets: AssetRecord[];
  tracks: { video: Track; audio: Track };
  textOverlays: TextOverlay[];
  captionOverlays: CaptionOverlay[];
}

export interface ProjectDocumentV1 extends EditableState {
  schemaVersion: 1;
  id: string;
  frameRate: Rational;
  dimensions: Dimensions;
  sampleRate: number;
  revision: number;
  commandHistory: CommandRecord[];
}

export interface ProjectSummary {
  revision: number;
  title: string;
  durationMs: number;
  assetCount: number;
  videoClipCount: number;
  audioClipCount: number;
  textCount: number;
  captionCount: number;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(",")}}`;
}

export function hashJson(value: unknown): string {
  // The project hash must be identical in Node and the browser. Asset IDs are
  // SHA-256 (the CLI's file hash), while this compact deterministic digest is
  // intentionally dependency-free for browser command parity.
  const input = stableStringify(value);
  let hash = 1469598103934665603n;
  for (const character of input) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyEditableState(title = "Untitled cut"): EditableState {
  return {
    title,
    durationMs: 0,
    assets: [],
    tracks: {
      video: { id: "track-video-primary", type: "video", clips: [] },
      audio: { id: "track-audio-primary", type: "audio", clips: [] }
    },
    textOverlays: [],
    captionOverlays: []
  };
}

export function createProject(id = "project-local", title = "Untitled cut"): ProjectDocumentV1 {
  return {
    schemaVersion: 1,
    id,
    frameRate: { numerator: 24, denominator: 1 },
    dimensions: { width: 1280, height: 720 },
    sampleRate: 48000,
    revision: 0,
    commandHistory: [],
    ...emptyEditableState(title)
  };
}

export function editableState(project: ProjectDocumentV1): EditableState {
  return clone({
    title: project.title,
    durationMs: project.durationMs,
    assets: project.assets,
    tracks: project.tracks,
    textOverlays: project.textOverlays,
    captionOverlays: project.captionOverlays
  });
}

export function withEditableState(project: ProjectDocumentV1, state: EditableState): ProjectDocumentV1 {
  return { ...project, ...clone(state) };
}

export function normalizeProject(input: Partial<ProjectDocumentV1>): ProjectDocumentV1 {
  const base = createProject(String(input.id ?? "project-local"), String(input.title ?? "Untitled cut"));
  const project: ProjectDocumentV1 = {
    ...base,
    ...clone(input as ProjectDocumentV1),
    schemaVersion: 1,
    frameRate: {
      numerator: Math.max(1, Math.round(input.frameRate?.numerator ?? base.frameRate.numerator)),
      denominator: Math.max(1, Math.round(input.frameRate?.denominator ?? base.frameRate.denominator))
    },
    dimensions: {
      width: Math.max(1, Math.round(input.dimensions?.width ?? base.dimensions.width)),
      height: Math.max(1, Math.round(input.dimensions?.height ?? base.dimensions.height))
    },
    sampleRate: Math.max(1, Math.round(input.sampleRate ?? base.sampleRate)),
    durationMs: Math.max(0, Math.round(input.durationMs ?? base.durationMs)),
    assets: clone((input.assets ?? base.assets).map((asset) => {
      const candidate = asset as AssetRecord & { localLocations?: unknown };
      const { localLocations: _privateLocations, ...publicAsset } = candidate;
      return publicAsset;
    })),
    tracks: clone(input.tracks ?? base.tracks),
    textOverlays: clone(input.textOverlays ?? base.textOverlays),
    captionOverlays: clone(input.captionOverlays ?? base.captionOverlays),
    revision: Math.max(0, Math.round(input.revision ?? base.revision)),
    commandHistory: clone(input.commandHistory ?? base.commandHistory)
  };
  return project;
}

export function summarize(project: ProjectDocumentV1): ProjectSummary {
  return {
    revision: project.revision,
    title: project.title,
    durationMs: project.durationMs,
    assetCount: project.assets.length,
    videoClipCount: project.tracks.video.clips.length,
    audioClipCount: project.tracks.audio.clips.length,
    textCount: project.textOverlays.length,
    captionCount: project.captionOverlays.length
  };
}

export function validateProject(project: ProjectDocumentV1): string[] {
  const errors: string[] = [];
  if (project.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!project.id) errors.push("id is required");
  if (project.frameRate.numerator <= 0 || project.frameRate.denominator <= 0) errors.push("frameRate must be positive");
  if (project.dimensions.width <= 0 || project.dimensions.height <= 0) errors.push("dimensions must be positive");
  if (project.sampleRate <= 0) errors.push("sampleRate must be positive");
  if (project.durationMs < 0) errors.push("durationMs cannot be negative");
  if (project.tracks.video.type !== "video" || project.tracks.audio.type !== "audio") errors.push("exactly one primary video and audio track are required");
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const seenAssetIds = new Set<string>();
  for (const asset of project.assets) {
    if (!/^[a-f0-9]{64}$/i.test(asset.id) && !asset.id.startsWith("fixture-")) errors.push(`asset ${asset.name} must use a SHA-256 content id`);
    if (!asset.name || /[\\/]/.test(asset.name)) errors.push(`asset ${asset.id} has an unsafe name`);
    if (seenAssetIds.has(asset.id)) errors.push(`duplicate asset id: ${asset.id}`);
    seenAssetIds.add(asset.id);
    if (!["video", "audio", "image", "unknown"].includes(asset.kind)) errors.push(`asset ${asset.id} has unsupported media kind`);
  }
  const seenClipIds = new Set<string>();
  for (const track of [project.tracks.video, project.tracks.audio]) {
    for (const clip of track.clips) {
      if (seenClipIds.has(clip.id)) errors.push(`duplicate clip id: ${clip.id}`);
      seenClipIds.add(clip.id);
      if (!assetIds.has(clip.assetId)) errors.push(`clip ${clip.id} references missing asset ${clip.assetId}`);
      if (clip.source.startMs < 0 || clip.source.endMs <= clip.source.startMs) errors.push(`clip ${clip.id} has invalid source range`);
      if (clip.timeline.startMs < 0 || clip.timeline.endMs <= clip.timeline.startMs) errors.push(`clip ${clip.id} has invalid timeline range`);
      if (clip.timeline.endMs > project.durationMs) errors.push(`clip ${clip.id} exceeds project duration`);
      if (clip.transitionIn.durationMs < 0 || clip.transitionOut.durationMs < 0) errors.push(`clip ${clip.id} has invalid transition duration`);
      if (clip.transitionIn.durationMs > clip.timeline.endMs - clip.timeline.startMs || clip.transitionOut.durationMs > clip.timeline.endMs - clip.timeline.startMs) errors.push(`clip ${clip.id} transition exceeds clip duration`);
    }
  }
  for (const overlay of project.textOverlays) {
    if (overlay.timeline.startMs < 0 || overlay.timeline.endMs <= overlay.timeline.startMs) errors.push(`text overlay ${overlay.id} has invalid timing`);
  }
  for (const overlay of project.captionOverlays) {
    if (!overlay.language || overlay.timeline.startMs < 0 || overlay.timeline.endMs <= overlay.timeline.startMs || overlay.timeline.endMs > project.durationMs) errors.push(`caption overlay ${overlay.id} has invalid timing or language`);
  }
  for (const track of [project.tracks.video, project.tracks.audio]) {
    const sorted = [...track.clips].sort((a, b) => a.timeline.startMs - b.timeline.startMs || a.order - b.order || a.id.localeCompare(b.id));
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.timeline.startMs < previous.timeline.endMs && previous.transitionOut.kind !== "crossfade" && current.transitionIn.kind !== "crossfade") errors.push(`overlapping clips ${previous.id} and ${current.id} require a crossfade`);
    }
  }
  return errors;
}
