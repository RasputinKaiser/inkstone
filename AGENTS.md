# Inkstone agent notes

Inkstone is a local-first public-repo candidate. Keep the browser editor, local
Node service, CLI, and verifier on the same typed model and command functions.

Use `RasputinKaiser` for the project maintainer identity. Do not add cloud
uploads, credentials, original media, or claims of remote publication. Generated
fixture media is disposable and must come from the fixed recipes in
`fixtures/fixture.json`.

The document is deterministic: command IDs, revisions, normalized JSON, and
receipts must not depend on wall-clock time. A dry run never writes. Local file
locations are metadata only; asset content is represented by a SHA-256 ID.
