# AGENTS.md — baxyz `sqlite-reader`

This repository inherits the [canonical workspace rules](https://github.com/baxyz/.dev/blob/main/AGENTS.md). Only project-specific details are documented here.

## Scope

Read-only SQLite3 binary parser — extracts rows from a table given a raw file buffer, without
shelling out to `sqlite3` or linking against a native SQLite build.

## License

**LGPL-3.0-or-later** — a deliberate exception to the workspace's AGPL-3.0-only default, since
this is a small library meant to be freely imported/embedded by other projects (including
proprietary ones), not a standalone application.

## Commit Scopes

Defined in `scopes.json`: `core`, `build`, `test`, `docs`, `deps`, `ci`.

## Structure

```text
sqlite-reader/
  src/          ← index.ts
  test/
  scripts/      ← pack.mjs (build post-processing)
```

## Commands

```bash
pnpm build           # vite build + type declarations + pack.mjs
pnpm typecheck
pnpm lint             # oxlint src test
pnpm format:check     # oxfmt --check src test
pnpm test             # vitest run --coverage
```

## Known gap

No `README.md` exists yet — worth adding before the next npm-facing change, but out of scope for
this AGENTS.md pass.
