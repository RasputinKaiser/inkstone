import { applyCommand, normalizeCommand } from "../src/commands.js";
import { createProject, hashJson, type AssetRecord, type CommandEnvelope, type ProjectDocumentV1 } from "../src/model.js";

const rootNode = document.querySelector<HTMLDivElement>("#app");
if (!rootNode) throw new Error("missing app root");
const root: HTMLDivElement = rootNode;

let project: ProjectDocumentV1 = createProject("browser-project", "Untitled cut");
let selectedClip = "";
let playing = false;
let currentTime = 0;
let previewUrl = "";
let receipt = "No render receipt yet.";
let statusText = "Local document ready";
let timelineZoom = 1;
let serverReady = false;
const localAssetIds = new Set<string>();
let syncQueue: Promise<void> = Promise.resolve();
let relinkAssetId = "";

function icon(name: "play" | "pause" | "step" | "undo" | "redo" | "plus"): string {
  const paths: Record<string, string> = { play: "M8 5v14l11-7z", pause: "M6 5h4v14H6zm8 0h4v14h-4z", step: "M6 5v14l8-7zm9 0h2v14h-2z", undo: "M9 7H4l3-3M4 7c7-4 13-1 13 5 0 3-2 5-6 5", redo: "M15 7h5l-3-3m3 3c-7-4-13-1-13 5 0 3 2 5 6 5", plus: "M12 5v14M5 12h14" };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/></svg>`;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 40)).padStart(2, "0")}`;
}

function command(type: CommandEnvelope["type"], payload: Record<string, unknown>): void {
  if (!serverReady) { statusText = "Waiting for the local service; edit was not sent"; renderStatus(); return; }
  const baseRevision = project.revision;
  const normalized = normalizeCommand({ schemaVersion: 1, id: `browser-${baseRevision + 1}-${type}`, type, payload, expectedRevision: baseRevision }, `browser-${baseRevision + 1}`);
  const result = applyCommand(project, normalized);
  project = result.project;
  statusText = `Revision ${project.revision} · local command applied`;
  render();
  const optimisticRevision = result.project.revision;
  syncQueue = syncQueue.then(() => syncCommand(normalized, optimisticRevision));
}

async function syncCommand(nextCommand: CommandEnvelope, optimisticRevision: number): Promise<void> {
  try {
    const response = await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(nextCommand) });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { project?: ProjectDocumentV1 };
    if (payload.project && project.revision === optimisticRevision) project = payload.project;
    statusText = `Revision ${project.revision} · synced to local service`;
  } catch (error) {
    statusText = `Sync error · ${error instanceof Error ? error.message.slice(0, 80) : "local service unavailable"}`;
  }
  render();
}

function renderStatus(): void {
  const node = document.querySelector<HTMLElement>("[data-status]");
  if (node) node.textContent = statusText;
}

function clipMarkup(track: "video" | "audio"): string {
  const clips = project.tracks[track].clips;
  if (!clips.length) return `<div class="empty">Drop a ${track} asset here.</div>`;
  const duration = Math.max(project.durationMs, 1);
  return clips.map((clip) => {
    const left = (clip.timeline.startMs / duration) * 100;
    const width = Math.max(5, ((clip.timeline.endMs - clip.timeline.startMs) / duration) * 100);
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    return `<button class="clip ${track} ${selectedClip === clip.id ? "selected" : ""}" draggable="true" data-clip="${clip.id}" style="left:${left * timelineZoom}%;width:${width * timelineZoom}%" title="Select ${asset?.name ?? clip.id}; drag to move">${asset?.name ?? clip.id}</button>`;
  }).join("");
}

function render(): void {
  const selected = [...project.tracks.video.clips, ...project.tracks.audio.clips].find((clip) => clip.id === selectedClip);
  root.innerHTML = `<div class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">I</span><div><h1>Inkstone</h1><small>local edit desk · revision ${project.revision}</small></div></div>
      <div class="top-actions"><span class="status" data-status>${statusText}</span><button class="button dark" data-action="preview">Preview</button><button class="button primary" data-action="export">Final export</button></div>
    </header>
    <main class="workspace">
      <aside class="panel media-bin"><div class="panel-header"><h2>Media bin</h2><button class="button small" data-action="import" aria-label="Import local media">${icon("plus")} Add</button><input class="sr-only" type="file" accept="video/*,audio/*,image/*" data-file /></div>
        <div class="panel-body"><p class="empty">Assets stay on this machine. IDs are content-addressed; local paths are kept separate.</p><div data-assets>${project.assets.map(assetMarkup).join("") || `<div class="empty">No media yet. Import a local source to start.</div>`}</div></div>
      </aside>
      <section class="center">
        <section class="panel viewer"><div class="screen ${previewUrl ? "has-media" : ""}"><div class="screen-copy"><strong>A quiet place to cut.</strong><span>Import a source, then drag clips on the timeline. Every edit is a typed, reversible command.</span></div><video data-video controls preload="metadata" src="${previewUrl}"></video><div class="playhead" style="left:${project.durationMs ? `${(currentTime / project.durationMs) * 100}%` : "45%"}"></div></div><div class="transport"><button data-action="toggle-play" aria-label="${playing ? "Pause" : "Play"}">${icon(playing ? "pause" : "play")}</button><button data-action="step" aria-label="Step one frame">${icon("step")}</button><input data-seek type="range" min="0" max="${Math.max(project.durationMs, 1)}" value="${currentTime}" aria-label="Playhead position" /><span class="timecode">${formatTime(currentTime)} / ${formatTime(project.durationMs)}</span></div></section>
        <section class="panel timeline"><div class="timeline-tools"><strong>Timeline</strong><div class="tool-row"><button class="button small" data-action="undo" aria-label="Undo">${icon("undo")}</button><button class="button small" data-action="redo" aria-label="Redo">${icon("redo")}</button><button class="button small" data-action="split">Split</button><button class="button small" data-action="delete">Delete</button><button class="button small" data-action="add-text">Text</button><button class="button small" data-action="add-caption">Caption</button><button class="button small" data-action="zoom-out" aria-label="Zoom timeline out">−</button><span class="button small" aria-label="Timeline zoom">${timelineZoom.toFixed(1)}×</span><button class="button small" data-action="zoom-in" aria-label="Zoom timeline in">+</button></div></div><div class="tracks"><div class="ruler"><span>00:00</span><span>00:30</span><span>01:00</span><span>01:30</span><span>02:00</span></div><div class="track"><div class="track-label">Video</div><div class="track-lane" data-lane="video">${clipMarkup("video")}</div></div><div class="track"><div class="track-label">Audio</div><div class="track-lane" data-lane="audio">${clipMarkup("audio")}</div></div></div></section>
      </section>
      <aside class="side-stack"><section class="panel"><div class="panel-header"><h2>Cut brief</h2></div><div class="panel-body brief"><p><strong>${project.title}</strong></p><p>${project.assets.length ? `${project.assets.length} local source${project.assets.length === 1 ? "" : "s"} · ${project.tracks.video.clips.length + project.tracks.audio.clips.length} clips` : "A deterministic project document, ready for its first source."}</p><div class="receipt">project ${hashJson(project)}<br />revision ${project.revision}<br />${receipt}</div></div></section>
      <section class="panel"><div class="panel-header"><h2>Inspector</h2></div><div class="panel-body">${selected ? inspectorMarkup(selected.id) : `<div class="empty">Select a clip to edit timing, transitions, and gain.</div>`}</div></section></aside>
    </main>
  </div>`;
  bindEvents();
}

function assetMarkup(asset: AssetRecord): string {
  const missing = !localAssetIds.has(asset.id);
  return `<div class="asset"><span class="asset-dot">${asset.kind === "audio" ? "A" : "V"}</span><div class="asset-info"><div class="asset-name">${escapeHtml(asset.name)}</div><div class="asset-meta ${missing ? "asset-missing" : ""}">${missing ? "Missing · relink" : `${asset.kind} · host path private`}</div></div><button class="button small" data-probe="${asset.id}">Probe</button><button class="button small" data-relink="${asset.id}">Relink</button></div>`;
}

function inspectorMarkup(id: string): string {
  const clip = [...project.tracks.video.clips, ...project.tracks.audio.clips].find((item) => item.id === id);
  if (!clip) return `<div class="empty">Clip no longer exists.</div>`;
  return `<div class="field"><label for="gain">Gain (dB)</label><input id="gain" data-gain type="number" step="0.5" value="${clip.gainDb}" /></div><div class="field"><label for="fade-in">Fade in (ms)</label><input id="fade-in" data-fade-in type="number" min="0" step="10" value="${clip.fadeInMs}" /></div><div class="field"><label for="fade-out">Fade out (ms)</label><input id="fade-out" data-fade-out type="number" min="0" step="10" value="${clip.fadeOutMs}" /></div><div class="tool-row"><button class="button small" data-action="apply-gain">Apply gain/fades</button><button class="button small" data-action="mute">${clip.muted ? "Unmute" : "Mute"}</button><button class="button small" data-action="trim">Trim to playhead</button><button class="button small" data-action="nudge">Nudge +100ms</button><button class="button small" data-action="transition">Crossfade</button></div><p class="empty">${formatTime(clip.timeline.startMs)} → ${formatTime(clip.timeline.endMs)} · ${clip.transitionIn.kind}/${clip.transitionOut.kind}</p>`;
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character] ?? character); }

function bindEvents(): void {
  root.querySelectorAll<HTMLElement>("[data-clip]").forEach((node) => node.addEventListener("click", () => { selectedClip = node.dataset.clip ?? ""; render(); }));
  root.querySelector<HTMLElement>("[data-action=import]")?.addEventListener("click", () => root.querySelector<HTMLInputElement>("[data-file]")?.click());
  root.querySelector<HTMLInputElement>("[data-file]")?.addEventListener("change", (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void importFile(file); });
  root.querySelector<HTMLElement>("[data-action=toggle-play]")?.addEventListener("click", () => { const video = root.querySelector<HTMLVideoElement>("[data-video]"); if (video) { if (video.paused) void video.play(); else video.pause(); } else { playing = !playing; render(); } });
  root.querySelector<HTMLElement>("[data-action=step]")?.addEventListener("click", () => { currentTime = Math.min(project.durationMs, currentTime + 1000 / 24); render(); });
  root.querySelector<HTMLInputElement>("[data-seek]")?.addEventListener("input", (event) => { currentTime = Number((event.target as HTMLInputElement).value); const video = root.querySelector<HTMLVideoElement>("[data-video]"); if (video) video.currentTime = currentTime / 1000; renderStatus(); });
  root.querySelector<HTMLElement>("[data-action=undo]")?.addEventListener("click", () => command("undo", {}));
  root.querySelector<HTMLElement>("[data-action=redo]")?.addEventListener("click", () => command("redo", {}));
  root.querySelector<HTMLElement>("[data-action=split]")?.addEventListener("click", () => { const clip = selectedClip ? [...project.tracks.video.clips, ...project.tracks.audio.clips].find((item) => item.id === selectedClip) : undefined; if (clip) command("split_clip", { clipId: clip.id, splitMs: Math.round((clip.timeline.startMs + clip.timeline.endMs) / 2) }); });
  root.querySelector<HTMLElement>("[data-action=delete]")?.addEventListener("click", () => { if (selectedClip) command("delete_clip", { clipId: selectedClip }); });
  root.querySelector<HTMLElement>("[data-action=zoom-out]")?.addEventListener("click", () => { timelineZoom = Math.max(0.5, timelineZoom - 0.1); render(); });
  root.querySelector<HTMLElement>("[data-action=zoom-in]")?.addEventListener("click", () => { timelineZoom = Math.min(2, timelineZoom + 0.1); render(); });
  root.querySelector<HTMLElement>("[data-action=add-text]")?.addEventListener("click", () => command("set_text", { id: `title-${project.revision + 1}`, startMs: currentTime, endMs: Math.min(project.durationMs || currentTime + 1000, currentTime + 1000), text: "New title", size: 32, color: "#f7f4ed", align: "center" }));
  root.querySelector<HTMLElement>("[data-action=add-caption]")?.addEventListener("click", () => command("set_caption", { id: `caption-${project.revision + 1}`, startMs: currentTime, endMs: Math.min(project.durationMs || currentTime + 1000, currentTime + 1000), text: "New caption", language: "en" }));
  root.querySelector<HTMLElement>("[data-action=preview]")?.addEventListener("click", () => void renderRemote("/api/preview"));
  root.querySelector<HTMLElement>("[data-action=export]")?.addEventListener("click", () => void renderRemote("/api/export"));
  root.querySelector<HTMLElement>("[data-action=apply-gain]")?.addEventListener("click", () => { const input = root.querySelector<HTMLInputElement>("[data-gain]"); const fadeIn = root.querySelector<HTMLInputElement>("[data-fade-in]"); const fadeOut = root.querySelector<HTMLInputElement>("[data-fade-out]"); if (selectedClip && input) command("set_gain", { clipId: selectedClip, gainDb: Number(input.value), fadeInMs: Number(fadeIn?.value ?? 0), fadeOutMs: Number(fadeOut?.value ?? 0) }); });
  root.querySelector<HTMLElement>("[data-action=mute]")?.addEventListener("click", () => { const clip = [...project.tracks.video.clips, ...project.tracks.audio.clips].find((item) => item.id === selectedClip); if (clip) command("set_gain", { clipId: selectedClip, muted: !clip.muted }); });
  root.querySelector<HTMLElement>("[data-action=trim]")?.addEventListener("click", () => { const clip = [...project.tracks.video.clips, ...project.tracks.audio.clips].find((item) => item.id === selectedClip); if (clip) command("trim_clip", { clipId: selectedClip, sourceStartMs: clip.source.startMs, sourceEndMs: clip.source.startMs + Math.max(100, Math.round((currentTime || clip.timeline.endMs) - clip.timeline.startMs)), timelineStartMs: clip.timeline.startMs }); });
  root.querySelector<HTMLElement>("[data-action=nudge]")?.addEventListener("click", () => { const clip = [...project.tracks.video.clips, ...project.tracks.audio.clips].find((item) => item.id === selectedClip); if (clip) command("move_clip", { clipId: selectedClip, timelineStartMs: clip.timeline.startMs + 100, order: clip.order }); });
  root.querySelector<HTMLElement>("[data-action=transition]")?.addEventListener("click", () => { if (selectedClip) command("set_transition", { clipId: selectedClip, side: "out", kind: "crossfade", durationMs: 180 }); });
  root.querySelectorAll<HTMLElement>("[data-probe]").forEach((node) => node.addEventListener("click", () => { const asset = project.assets.find((candidate) => candidate.id === node.dataset.probe); if (asset) void probeAsset(asset); }));
  root.querySelectorAll<HTMLElement>("[data-relink]").forEach((node) => node.addEventListener("click", () => { relinkAssetId = node.dataset.relink ?? ""; statusText = `Choose the matching local file to relink ${relinkAssetId}`; renderStatus(); root.querySelector<HTMLInputElement>("[data-file]")?.click(); }));
  const video = root.querySelector<HTMLVideoElement>("[data-video]");
  video?.addEventListener("timeupdate", () => { currentTime = video.currentTime * 1000; playing = !video.paused; renderStatus(); });
  root.querySelectorAll<HTMLElement>("[data-clip]").forEach((node) => node.addEventListener("dragstart", (event) => { event.dataTransfer?.setData("text/plain", node.dataset.clip ?? ""); }));
  root.querySelectorAll<HTMLElement>("[data-lane]").forEach((lane) => { lane.addEventListener("dragover", (event) => event.preventDefault()); lane.addEventListener("drop", (event) => { event.preventDefault(); const clipId = event.dataTransfer?.getData("text/plain"); const clip = [...project.tracks.video.clips, ...project.tracks.audio.clips].find((item) => item.id === clipId); if (!clip) return; const rect = lane.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); const snapped = Math.round((ratio * Math.max(project.durationMs, 1)) / 100) * 100; command("move_clip", { clipId, timelineStartMs: snapped, order: clip.order }); }); });
}

async function probeAsset(asset: AssetRecord): Promise<void> {
  statusText = `Probing ${asset.name} locally…`;
  renderStatus();
  try {
    const response = await fetch(`/api/assets/${asset.id}/probe`, { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { asset?: AssetRecord };
    statusText = `${asset.name} · ${payload.asset?.durationMs ? `${(payload.asset.durationMs / 1000).toFixed(2)}s` : "metadata ready"} · probed locally`;
  } catch (error) { statusText = `Probe error · ${error instanceof Error ? error.message.slice(0, 80) : "relink asset"}`; }
  renderStatus();
}

async function importFile(file: File): Promise<void> {
  statusText = `Importing ${file.name} to the loopback service…`;
  renderStatus();
  try {
    const headers: Record<string, string> = { "x-inkstone-filename": file.name, "content-type": file.type || "application/octet-stream" };
    if (relinkAssetId) headers["x-inkstone-relink-id"] = relinkAssetId;
    const response = await fetch("/api/assets/import", { method: "POST", headers, body: file });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { asset: AssetRecord; mediaUrl?: string; relinked?: boolean };
    const asset = payload.asset;
    localAssetIds.add(asset.id);
    if (payload.relinked) { statusText = `${file.name} relinked to ${asset.id.slice(0, 10)}…`; relinkAssetId = ""; render(); return; }
    command("import_asset", { assetId: asset.id, kind: asset.kind, name: asset.name, sizeBytes: asset.sizeBytes, durationMs: asset.durationMs, contentType: asset.contentType });
    if (asset.kind === "video" || asset.kind === "audio") command("insert_clip", { track: asset.kind, assetId: asset.id, clipId: `${asset.kind}-${asset.id.slice(0, 8)}`, sourceStartMs: 0, sourceEndMs: asset.durationMs ?? 2000, timelineStartMs: 0 });
    previewUrl = payload.mediaUrl ?? "";
    statusText = `${file.name} imported and synced · ${asset.id.slice(0, 10)}…`;
    render();
  } catch (error) {
    statusText = `Import error · ${error instanceof Error ? error.message.slice(0, 100) : "unsupported media"}`;
    renderStatus();
  }
}

async function renderRemote(path: string): Promise<void> {
  statusText = "Rendering…";
  renderStatus();
  try {
    const response = await fetch(path, { method: "POST" });
    const payload = await response.json() as { receipt?: { output?: { sha256?: string }; revision?: number }; mediaUrl?: string; error?: string };
    const error = payload.error ? payload.error.replace(/(?:[A-Za-z]:)?[\\/]?(?:Users|private|tmp|var)[^\s;:]*/g, "local path").slice(0, 140) : "unknown render error";
    receipt = response.ok ? `render ${payload.receipt?.revision ?? project.revision} · ${payload.receipt?.output?.sha256?.slice(0, 12) ?? "complete"}…` : `render error · ${error}`;
    if (response.ok && payload.mediaUrl) previewUrl = payload.mediaUrl;
    statusText = response.ok ? "Render receipt fresh" : `Render error · ${error}`;
  } catch (error) {
    statusText = `Render request failed · ${error instanceof Error ? error.message.slice(0, 100) : "local service unavailable"}`;
  }
  render();
}

async function hydrate(): Promise<void> {
  statusText = "Loading local project…";
  render();
  try {
    const [projectResponse, assetStatusResponse] = await Promise.all([fetch("/api/project", { cache: "no-store" }), fetch("/api/assets/status", { cache: "no-store" })]);
    if (!projectResponse.ok) throw new Error(await projectResponse.text());
    if (!assetStatusResponse.ok) throw new Error(await assetStatusResponse.text());
    project = await projectResponse.json() as ProjectDocumentV1;
    const assetStatus = await assetStatusResponse.json() as { availableIds?: string[] };
    localAssetIds.clear();
    for (const id of assetStatus.availableIds ?? []) localAssetIds.add(id);
    serverReady = true;
    statusText = `Revision ${project.revision} · local project hydrated`;
  } catch (error) {
    serverReady = false;
    statusText = `Local service unavailable · ${error instanceof Error ? error.message.slice(0, 80) : "start Inkstone"}`;
  }
  render();
}
void hydrate();
