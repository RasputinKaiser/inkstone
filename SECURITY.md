# Security

Inkstone is intentionally local-first. The development service binds to
`127.0.0.1`, accepts no authentication, and is not a production network
service. Do not expose it to a network interface or put private source media
in a public repository.

The project document stores content-addressed asset IDs and local locations,
not media bytes. Browser imports stay in the browser's memory/object URLs until
the user explicitly relinks a local file. The CLI never downloads media or
executes a user-provided shell/filtergraph. Renderer arguments are built from
typed project fields and fixed recipes.

Report security issues privately to the repository maintainer before public
disclosure. Do not include original media, tokens, personal data, or machine
paths in a report or fixture.
