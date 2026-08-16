# OpenCrowder release-gate pilot

This document is the bounded, correctness-only change used to exercise the first OpenCrowder Bot and signed-runner lifecycle.

- The Bot may create this scoped branch and pull request, but it cannot merge.
- The official runner verifies only the pinned synthetic Inkstone fixture through `inkstone.verify.v1`.
- This receipt makes no render-speed or project-wide benchmark claim.
- Original media, credentials, private logs, prompts, and local paths are excluded.

Human review and a manual merge remain required before an explicit baseline promotion.
