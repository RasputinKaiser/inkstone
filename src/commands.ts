import {
  type AssetRecord,
  type CaptionOverlay,
  type Clip,
  clone,
  editableState,
  type CommandEnvelope,
  type CommandPayload,
  type CommandRecord,
  type CommandType,
  type EditableState,
  type ProjectDocumentV1,
  type TextOverlay,
  validateProject,
  withEditableState
} from "./model.js";

export interface ApplyResult {
  project: ProjectDocumentV1;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: boolean;
}

function requiredString(payload: CommandPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function numberValue(payload: CommandPayload, key: string, fallback?: number): number {
  const value = payload[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function range(payload: CommandPayload, startKey = "startMs", endKey = "endMs") {
  const startMs = numberValue(payload, startKey);
  const endMs = numberValue(payload, endKey);
  if (startMs < 0 || endMs <= startMs) throw new Error("range must have endMs greater than startMs");
  return { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

function clipById(state: EditableState, id: string): { clip: Clip; track: "video" | "audio" } {
  for (const trackName of ["video", "audio"] as const) {
    const clip = state.tracks[trackName].clips.find((candidate) => candidate.id === id);
    if (clip) return { clip, track: trackName };
  }
  throw new Error(`unknown clip: ${id}`);
}

function applyEditable(state: EditableState, command: CommandEnvelope): EditableState {
  const next = clone(state);
  switch (command.type) {
    case "import_asset": {
      const asset: AssetRecord = {
        id: requiredString(command.payload, "assetId"),
        kind: (command.payload.kind as AssetRecord["kind"]) ?? "unknown",
        name: String(command.payload.name ?? "Untitled asset"),
        ...(typeof command.payload.sizeBytes === "number" ? { sizeBytes: command.payload.sizeBytes } : {}),
        ...(typeof command.payload.durationMs === "number" ? { durationMs: command.payload.durationMs } : {}),
        ...(typeof command.payload.contentType === "string" ? { contentType: command.payload.contentType } : {}),
        ...(typeof command.payload.metadata === "object" && command.payload.metadata !== null ? { metadata: clone(command.payload.metadata as Record<string, string | number | boolean>) } : {})
      };
      const existing = next.assets.findIndex((candidate) => candidate.id === asset.id);
      if (existing >= 0) next.assets[existing] = asset;
      else next.assets.push(asset);
      return next;
    }
    case "insert_clip": {
      const trackName = command.payload.track === "audio" ? "audio" : "video";
      const assetId = requiredString(command.payload, "assetId");
      if (!next.assets.some((asset) => asset.id === assetId)) throw new Error(`unknown asset: ${assetId}`);
      const source = range(command.payload, "sourceStartMs", "sourceEndMs");
      const startMs = numberValue(command.payload, "timelineStartMs");
      const clip: Clip = {
        id: requiredString(command.payload, "clipId"),
        assetId,
        source,
        timeline: { startMs: Math.round(startMs), endMs: Math.round(startMs + (source.endMs - source.startMs)) },
        order: Math.max(0, Math.round(numberValue(command.payload, "order", next.tracks[trackName].clips.length))),
        gainDb: numberValue(command.payload, "gainDb", 0),
        muted: command.payload.muted === true,
        fadeInMs: Math.max(0, Math.round(numberValue(command.payload, "fadeInMs", 0))),
        fadeOutMs: Math.max(0, Math.round(numberValue(command.payload, "fadeOutMs", 0))),
        transitionIn: { kind: "cut", durationMs: 0 },
        transitionOut: { kind: "cut", durationMs: 0 }
      };
      if (next.tracks[trackName].clips.some((candidate) => candidate.id === clip.id)) throw new Error(`duplicate clip: ${clip.id}`);
      next.tracks[trackName].clips.push(clip);
      next.tracks[trackName].clips.sort((a, b) => a.timeline.startMs - b.timeline.startMs || a.order - b.order || a.id.localeCompare(b.id));
      next.durationMs = Math.max(next.durationMs, clip.timeline.endMs);
      return next;
    }
    case "trim_clip": {
      const id = requiredString(command.payload, "clipId");
      const { clip } = clipById(next, id);
      const source = range(command.payload, "sourceStartMs", "sourceEndMs");
      const timelineStartMs = Math.round(numberValue(command.payload, "timelineStartMs", clip.timeline.startMs));
      clip.source = source;
      clip.timeline = { startMs: timelineStartMs, endMs: timelineStartMs + source.endMs - source.startMs };
      next.durationMs = Math.max(0, ...[...next.tracks.video.clips, ...next.tracks.audio.clips].map((item) => item.timeline.endMs));
      return next;
    }
    case "split_clip": {
      const id = requiredString(command.payload, "clipId");
      const splitMs = Math.round(numberValue(command.payload, "splitMs"));
      const found = clipById(next, id);
      if (splitMs <= found.clip.timeline.startMs || splitMs >= found.clip.timeline.endMs) throw new Error("splitMs must be inside the clip");
      const firstDuration = splitMs - found.clip.timeline.startMs;
      const sourceSplit = found.clip.source.startMs + firstDuration;
      const second: Clip = clone(found.clip);
      second.id = String(command.payload.secondClipId ?? `${id}-split`);
      second.source = { startMs: sourceSplit, endMs: found.clip.source.endMs };
      second.timeline = { startMs: splitMs, endMs: found.clip.timeline.endMs };
      found.clip.source.endMs = sourceSplit;
      found.clip.timeline.endMs = splitMs;
      second.order += 1;
      next.tracks[found.track].clips.push(second);
      next.tracks[found.track].clips.sort((a, b) => a.timeline.startMs - b.timeline.startMs || a.order - b.order || a.id.localeCompare(b.id));
      return next;
    }
    case "move_clip": {
      const id = requiredString(command.payload, "clipId");
      const { clip, track } = clipById(next, id);
      const startMs = Math.max(0, Math.round(numberValue(command.payload, "timelineStartMs")));
      clip.timeline.endMs = startMs + clip.timeline.endMs - clip.timeline.startMs;
      clip.timeline.startMs = startMs;
      clip.order = Math.max(0, Math.round(numberValue(command.payload, "order", clip.order)));
      next.tracks[track].clips.sort((a, b) => a.timeline.startMs - b.timeline.startMs || a.order - b.order || a.id.localeCompare(b.id));
      next.durationMs = Math.max(0, ...[...next.tracks.video.clips, ...next.tracks.audio.clips].map((item) => item.timeline.endMs));
      return next;
    }
    case "set_transition": {
      const id = requiredString(command.payload, "clipId");
      const side = command.payload.side === "in" ? "transitionIn" : "transitionOut";
      const { clip } = clipById(next, id);
      const kind = command.payload.kind === "crossfade" ? "crossfade" : "cut";
      clip[side] = { kind, durationMs: Math.max(0, Math.round(numberValue(command.payload, "durationMs", 0))) };
      return next;
    }
    case "set_text": {
      const id = requiredString(command.payload, "id");
      const overlay: TextOverlay = {
        id,
        timeline: range(command.payload),
        text: String(command.payload.text ?? ""),
        style: {
          size: Math.max(8, Math.round(numberValue(command.payload, "size", 32))),
          color: String(command.payload.color ?? "#f7f4ed"),
          align: command.payload.align === "left" || command.payload.align === "right" ? command.payload.align : "center"
        }
      };
      const index = next.textOverlays.findIndex((candidate) => candidate.id === id);
      if (index >= 0) next.textOverlays[index] = overlay;
      else next.textOverlays.push(overlay);
      return next;
    }
    case "set_caption": {
      const id = requiredString(command.payload, "id");
      const overlay: CaptionOverlay = { id, timeline: range(command.payload), text: String(command.payload.text ?? ""), language: String(command.payload.language ?? "en") };
      const index = next.captionOverlays.findIndex((candidate) => candidate.id === id);
      if (index >= 0) next.captionOverlays[index] = overlay;
      else next.captionOverlays.push(overlay);
      return next;
    }
    case "set_gain": {
      const id = requiredString(command.payload, "clipId");
      const { clip } = clipById(next, id);
      clip.gainDb = numberValue(command.payload, "gainDb", clip.gainDb);
      clip.muted = command.payload.muted === true ? true : command.payload.muted === false ? false : clip.muted;
      clip.fadeInMs = Math.max(0, Math.round(numberValue(command.payload, "fadeInMs", clip.fadeInMs)));
      clip.fadeOutMs = Math.max(0, Math.round(numberValue(command.payload, "fadeOutMs", clip.fadeOutMs)));
      return next;
    }
    case "delete_clip": {
      const id = requiredString(command.payload, "clipId");
      const found = clipById(next, id);
      next.tracks[found.track].clips = next.tracks[found.track].clips.filter((clip) => clip.id !== id);
      next.durationMs = Math.max(0, ...[...next.tracks.video.clips, ...next.tracks.audio.clips].map((item) => item.timeline.endMs));
      return next;
    }
    case "replace_clip": {
      const id = requiredString(command.payload, "clipId");
      const assetId = requiredString(command.payload, "assetId");
      if (!next.assets.some((asset) => asset.id === assetId)) throw new Error(`unknown asset: ${assetId}`);
      const found = clipById(next, id);
      found.clip.assetId = assetId;
      if (typeof command.payload.sourceStartMs === "number" && typeof command.payload.sourceEndMs === "number") found.clip.source = range(command.payload, "sourceStartMs", "sourceEndMs");
      return next;
    }
    case "undo":
    case "redo":
      return next;
  }
}

export function applyCommand(project: ProjectDocumentV1, command: CommandEnvelope): ApplyResult {
  if (command.schemaVersion !== 1) throw new Error("unsupported command schema");
  if (command.expectedRevision !== undefined && command.expectedRevision !== project.revision) throw new Error(`revision mismatch: expected ${command.expectedRevision}, got ${project.revision}`);
  const before = editableState(project);
  let next: ProjectDocumentV1;
  if (command.type === "undo" || command.type === "redo") {
    const index = command.type === "undo" ? [...project.commandHistory].reverse().findIndex((record) => !record.undone) : [...project.commandHistory].reverse().findIndex((record) => record.undone);
    if (index < 0) return { project, before: summary(project), after: summary(project), changed: false };
    const recordIndex = project.commandHistory.length - 1 - index;
    const record = project.commandHistory[recordIndex];
    if (!record) throw new Error("history index error");
    next = withEditableState(project, command.type === "undo" ? record.before : record.after);
    next.commandHistory = clone(project.commandHistory);
    const target = next.commandHistory[recordIndex];
    if (target) target.undone = command.type === "undo";
  } else {
    const state = applyEditable(before, command);
    next = withEditableState(project, state);
    const record: CommandRecord = { id: command.id, type: command.type, payload: clone(command.payload), before, after: clone(state), undone: false };
    next.commandHistory = [...clone(project.commandHistory), record];
  }
  next.revision = project.revision + (next === project ? 0 : 1);
  const errors = validateProject(next);
  if (errors.length > 0) throw new Error(`invalid project after ${command.type}: ${errors.join("; ")}`);
  return { project: next, before: summary(project), after: summary(next), changed: next.revision !== project.revision };
}

function summary(project: ProjectDocumentV1): Record<string, unknown> {
  return { revision: project.revision, durationMs: project.durationMs, assets: project.assets.length, videoClips: project.tracks.video.clips.length, audioClips: project.tracks.audio.clips.length, text: project.textOverlays.length, captions: project.captionOverlays.length };
}

export function normalizeCommand(value: unknown, fallbackId = "command-1"): CommandEnvelope {
  if (!value || typeof value !== "object") throw new Error("command must be an object");
  const candidate = value as Partial<CommandEnvelope>;
  const allowed: CommandType[] = ["import_asset", "insert_clip", "trim_clip", "split_clip", "move_clip", "set_transition", "set_text", "set_caption", "set_gain", "delete_clip", "replace_clip", "undo", "redo"];
  if (!candidate.type || !allowed.includes(candidate.type)) throw new Error("unknown command type");
  return { schemaVersion: 1, id: typeof candidate.id === "string" && candidate.id ? candidate.id : fallbackId, type: candidate.type, payload: typeof candidate.payload === "object" && candidate.payload !== null ? clone(candidate.payload) : {}, ...(typeof candidate.expectedRevision === "number" ? { expectedRevision: candidate.expectedRevision } : {}) };
}
