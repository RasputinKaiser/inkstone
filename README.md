# Inkstone

Inkstone is a local-first v1 video editor: the browser is the primary visual
workspace, while a small Node service and CLI provide the same typed command
model, deterministic snapshots, CPU FFmpeg renders, and verifiable receipts.

It is deliberately narrow. Inkstone handles one primary video track, one audio
track, source/timeline ranges, cuts and crossfades, text/captions, gain/mute,
and a reproducible command history. It does not upload originals or include
cloud collaboration, capture, multicam/nesting, arbitrary filters/plugins,
effects/color/advanced audio, generation providers, mobile, or publishing.

## Quick start

```sh
npm install
npm test
npm run verify:fixture
npm run build
npm start
# after npm link, the same CLI is available as:
inkstone inspect --project examples/fixture-project.json
```

Open `http://127.0.0.1:4318`. The service can be pointed at another project
document with `INKSTONE_PROJECT=/path/to/project.json`. By default it creates
and edits `.inkstone/project.json`; the tracked `examples/fixture-project.json`
is an immutable example document.

## CLI

Every command emits one JSON value on stdout and concise diagnostics on stderr;
exit `0` means success, `2` means a validation/user-input error, and `3` means
an external tool or stale-receipt error.

```sh
node dist/src/cli.js inspect --project examples/fixture-project.json
node dist/src/cli.js probe --input /path/to/source.mp4
node dist/src/cli.js validate --project examples/fixture-project.json
node dist/src/cli.js edit dry-run --project examples/fixture-project.json --command examples/add-caption.json
node dist/src/cli.js edit apply --project examples/fixture-project.json --command examples/add-caption.json
node dist/src/cli.js snapshot --project examples/fixture-project.json --out /tmp/inkstone-snapshot.json
node dist/src/cli.js render --project examples/fixture-project.json --out /tmp/inkstone-output.mp4
node dist/src/cli.js verify --project examples/fixture-project.json --receipt /tmp/inkstone-output.receipt.json
```

Commands are explicit typed operations: `import_asset`, `insert_clip`,
`trim_clip`, `split_clip`, `move_clip`, `set_transition`, `set_text`,
`set_caption`, `set_gain`, `undo`, and `redo`. The browser calls those same
normalization/apply functions, so a command has the same revision and summary
regardless of whether it came from the UI or CLI.

## Document and receipt

`schemas/project-document.v1.schema.json` defines rational frame rate,
dimensions, sample rate, duration, content-addressed assets with separate local
metadata, the two canonical tracks, overlays, and deterministic history. Host
paths are never written to the project document. The gitignored
`.inkstone/asset-map.json` sidecar maps an asset hash to local locations, and
`.inkstone/assets/` holds bounded loopback imports.
`schemas/receipt.v1.schema.json` defines the project/source/toolchain/output
hashes, ffprobe metadata, revision, and stale check.

The fixture verifier creates its own tiny color-and-tone sources with fixed
FFmpeg recipes. No third-party media is included. The renderer builds a fixed
FFmpeg graph from clip source/timeline ranges, ordering, transitions, overlays,
gain, mute, fades, project dimensions, frame rate, and sample rate. A receipt's
stored output path is local/private; public API projections omit it.

## Agent API

The HTTP service exposes `GET /api/health`, `GET /api/project`,
`PUT /api/project`, `POST /api/command`, `POST /api/preview`, and
`POST /api/export`. Request bodies are JSON and use the command schema. The
service is intentionally loopback-only and has no remote API or credentials.

See `examples/e2e.md` for a complete fixture workflow and `AGENTS.md` for
contributor boundaries.
