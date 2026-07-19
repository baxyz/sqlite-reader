# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-07-19

### Added

- `decodeRecord` now decodes 48-bit integers (serial type 5), 64-bit integers
  (serial type 6), and 64-bit floats (serial type 7) instead of returning
  `null` for those columns.

### Changed

- `CHANGELOG.md` is now included in the published npm package.
- `decodeRecord` computes each column's byte size once (via `serialTypeSize`)
  instead of maintaining that fact in two places — the bounds check and the
  per-branch `pos` advancement can no longer drift out of sync.

### Fixed

- `decodeRecord` bounds-checks each column against the record's payload and
  throws on a truncated or corrupted record instead of silently reading
  out-of-bounds data.
- `varint()` itself is now bounds-checked and no longer overflows into a
  negative 32-bit value on a crafted multi-byte input — both were previously
  unguarded and could let a corrupted length field bypass the bounds check
  above or spin through a header longer than the actual payload.
- A single corrupted/truncated row no longer aborts the whole `readTable`
  call — it's skipped, and the rest of the table's valid rows are still
  returned.
- `parseColumnNames` strips `--` and `/* */` SQL comments before splitting
  column definitions, fixing column misalignment when a `CREATE TABLE`
  statement contains a comment with an unbalanced paren or comma. Comments
  are stripped with a linear scan rather than a regex, avoiding a
  CodeQL-flagged ReDoS on adversarial input.
- Comment stripping and column splitting both now track single-quoted string
  literals, so a `DEFAULT` value containing `--`, `/*`, `,`, or `(` no longer
  corrupts or empties the parsed column list. Removing a `/* */` comment also
  now leaves a space behind, so an identifier directly adjacent to it (no
  whitespace) no longer merges with the next token.

## [0.2.1] - 2026-07-08

### Fixed

- Guard against cyclic B-tree page pointers in `traverseTable`, which
  otherwise caused unbounded recursion on a corrupted or malicious database
  file.

## [0.2.0] - 2026-06-28

### Changed

- Restructured `traverseTable` for full branch coverage and added a 100%
  coverage threshold to the test suite.
- Migrated the build script from `pack.ts` to `pack.mjs`, dropping the `tsx`
  dependency and fixing the `engines` field.
- Removed `DOM` from the TypeScript `lib` configuration (this package never
  touches the DOM).
- Added CI, CodeQL, and release GitHub Actions workflows.

## [0.1.0] - 2026-06-28

### Added

- Initial release: a dependency-free, read-only SQLite3 binary parser
  (`readTable(db, tableName)`) that walks leaf and interior B-tree pages and
  decodes rows into plain objects.

[Unreleased]: https://github.com/baxyz/sqlite-reader/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/baxyz/sqlite-reader/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/baxyz/sqlite-reader/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/baxyz/sqlite-reader/releases/tag/v0.1.0
