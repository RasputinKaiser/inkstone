# Agent API

The loopback service is intentionally small and local. All request and response
bodies are JSON. The service binds to `127.0.0.1` only.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/health` | — | service identity and project path |
| GET | `/api/project` | — | canonical `project-document.v1` |
| PUT | `/api/project` | project fields | validated canonical document |
| POST | `/api/command` | `command.v1` | project, before/after summaries, hash |
| POST | `/api/assets/import` | raw media bytes plus `x-inkstone-filename` | safe asset identity, probe metadata, media URL |
| POST | `/api/preview` | — | CPU FFmpeg render receipt |
| POST | `/api/export` | — | CPU FFmpeg render receipt |

`GET /api/media/preview`, `/api/media/export`, and
`/api/media/asset/:sha256` serve only known local artifacts. Imported bytes are
bounded to 50 MiB, probed by FFprobe, and stored under the gitignored
`.inkstone/assets/` directory. The response contains the content identity but
not the host path.

The CLI and browser both send `command.v1` operations. `expectedRevision` is
optional but recommended for agents: a mismatch is a stable user-input error
and does not write the document. The command result includes `before`, `after`,
and the new revision. A dry-run is CLI-only and always reports `writes:false`.

No endpoint accepts a shell command or filtergraph. Asset bytes remain local;
the document contains content-addressed IDs and explicit local locations.
