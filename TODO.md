# TODO

Remaining points from `review.md` that were not applied, with priority and rationale.
Points 4, 5, and 8 from that review have already been fixed (bounds-checked
`decodeRecord`, comment-aware `parseColumnNames`, and full int48/int64/float64
decoding) — see `src/index.ts` and the corresponding tests.

## Low priority — worth doing eventually

### 1. Input validation in `readTable` (review point 1)
Check `db instanceof Uint8Array` and a minimum length (16 bytes) before reading,
so a bad caller gets a clear `TypeError`/`Error` instead of `undefined`-driven
garbage.

**Why low priority:** the only current consumer (`browser-hub`) already wraps
`readTable` in a try/catch and always passes a real file buffer. Still cheap
and worth adding since this is a published npm package with external
consumers.

### 7. Magic string comparison as `Uint8Array` (review point 7)
Replace the `MAGIC.charCodeAt(i)` string comparison with a precomputed
`Uint8Array` constant.

**Why low priority:** pure micro-optimization on a 16-byte comparison that
runs once per `readTable` call. No measurable impact.

## Rejected — do not apply

### 2. File-size limit (review point 2)
Reviewer proposed rejecting files above e.g. 100MB inside `readTable` to
prevent memory-exhaustion DoS.

**Why rejected:** by the time `readTable` receives `db`, the caller has
already read the entire file into memory (see `firefox-spaces.ts`). A check
inside `readTable` happens after the memory spike, so it doesn't prevent
anything — it would only add a check with no protective effect for the actual
call site.

### 3. Recursion depth limit in `traverseTable` (review point 3)
Reviewer's proposed fix re-adds a `visited` cycle guard.

**Why rejected:** this already exists (`src/index.ts`, `traverseTable`) and is
covered by a dedicated test ("stops instead of recursing forever..."). A
malicious *non-cyclic* chain of many unique interior pages could still exhaust
the call stack in theory, but that's bounded by the number of distinct pages
in the file, and isn't something the current threat model (local files
produced by Firefox itself) needs to defend against.

### 6. Varint > 8 bytes handling (review point 6)
Reviewer proposed throwing when a varint needs a 9th byte.

**Why rejected:** 9-byte varints are valid per the SQLite spec (the final
byte contributes all 8 bits instead of 7) and are exercised by an existing
test ("handles 9-byte varint (max rowid)"). Throwing on them would be a
regression, not a fix. The only real gap — precision loss for varint values
beyond `Number.MAX_SAFE_INTEGER` — is inherent to using plain JS `number`
throughout this lib and isn't worth a targeted fix on its own.
