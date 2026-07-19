// Read-only SQLite3 binary parser — leaf + interior B-tree pages, no overflow, UTF-8 only.
// Spec: https://www.sqlite.org/fileformat2.html

type SqliteValue = string | number | null;
export type SqliteRow = Record<string, SqliteValue>;

// Thrown for corruption confined to a single record (a truncated/malformed
// varint or payload). traverseTable catches only this type and skips the
// row — any other error indicates a real bug and is left to propagate.
export class CorruptedRecordError extends Error {}

function u16(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}

function u32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function varint(buf: Uint8Array, pos: number): [value: number, size: number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (pos + i >= buf.length) throw new CorruptedRecordError("Invalid varint: truncated buffer");
    const b = buf[pos + i];
    // Plain multiplication, not `v << 7` — `<<` coerces to a 32-bit SIGNED
    // int, so a corrupted multi-byte varint can wrap negative after just a
    // few iterations. Multiplication stays a non-negative, if imprecise
    // beyond 2^53, number for the full 8-byte range.
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return [v, i + 1];
  }
  if (pos + 8 >= buf.length) throw new CorruptedRecordError("Invalid varint: truncated buffer");
  return [v * 256 + buf[pos + 8], 9];
}

function serialTypeSize(t: number): number {
  if (t === 0 || t === 8 || t === 9 || t === 10 || t === 11) return 0;
  if (t === 1) return 1;
  if (t === 2) return 2;
  if (t === 3) return 3;
  if (t === 4) return 4;
  if (t === 5) return 6;
  if (t === 6 || t === 7) return 8;
  return Math.floor((t - 12) / 2); // t >= 12: blob (even) or text (odd) byte length
}

function readInt48(buf: Uint8Array, pos: number): number {
  const hi = (buf[pos] << 8) | buf[pos + 1];
  const lo =
    ((buf[pos + 2] << 24) | (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]) >>> 0;
  const v = hi * 2 ** 32 + lo;
  return v >= 2 ** 47 ? v - 2 ** 48 : v;
}

// Converts to a plain number, so magnitudes beyond Number.MAX_SAFE_INTEGER
// (2^53) lose precision — an inherent tradeoff of this lib's number-only
// SqliteValue type versus the full 64-bit range SQLite allows.
function readInt64(buf: Uint8Array, pos: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + pos, 8);
  return Number(view.getBigInt64(0, false));
}

function readFloat64(buf: Uint8Array, pos: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + pos, 8);
  return view.getFloat64(0, false);
}

function decodeRecord(payload: Uint8Array): SqliteValue[] {
  let pos = 0;
  const [hdrEnd, hs] = varint(payload, pos);
  pos += hs;

  const types: number[] = [];
  while (pos < hdrEnd) {
    const [t, ts] = varint(payload, pos);
    pos += ts;
    types.push(t);
  }

  pos = hdrEnd;
  const values: SqliteValue[] = [];
  const dec = new TextDecoder();

  for (const t of types) {
    // `size` is the single source of truth for this type's byte width —
    // every branch below reads exactly `size` bytes and `pos` only ever
    // advances by `size`, so the bounds check can never drift out of sync
    // with what's actually consumed.
    const size = serialTypeSize(t);
    if (pos + size > payload.length) {
      throw new CorruptedRecordError("Invalid record: payload too short for declared column type");
    }

    if (t === 0) {
      values.push(null);
    } else if (t === 1) {
      const v = payload[pos];
      values.push(v >= 0x80 ? v - 0x100 : v);
    } else if (t === 2) {
      const v = u16(payload, pos);
      values.push(v >= 0x8000 ? v - 0x10000 : v);
    } else if (t === 3) {
      const v = (payload[pos] << 16) | (payload[pos + 1] << 8) | payload[pos + 2];
      values.push(v >= 0x800000 ? v - 0x1000000 : v);
    } else if (t === 4) {
      const v = u32(payload, pos);
      values.push(v >= 0x80000000 ? v - 0x100000000 : v);
    } else if (t === 5) {
      values.push(readInt48(payload, pos));
    } else if (t === 6) {
      values.push(readInt64(payload, pos));
    } else if (t === 7) {
      values.push(readFloat64(payload, pos));
    } else if (t === 8) {
      values.push(0);
    } else if (t === 9) {
      values.push(1);
    } else if (t >= 12 && t % 2 === 0) {
      values.push(null); // blob — not supported
    } else if (t >= 13 && t % 2 === 1) {
      values.push(dec.decode(payload.subarray(pos, pos + size)));
      /* c8 ignore start */
    } else {
      values.push(null);
    } // serial types 10/11 reserved — never emitted by SQLite
    /* c8 ignore stop */

    pos += size;
  }

  return values;
}

function traverseTable(
  db: Uint8Array,
  pageNum: number,
  pageSize: number,
  visited: Set<number> = new Set(),
  onSkippedRow?: (error: CorruptedRecordError) => void,
): SqliteValue[][] {
  // A well-formed B-tree never revisits a page — this only trips on a
  // corrupted/malicious child pointer, which would otherwise recurse until
  // the stack overflows. Every page belongs to exactly one traversal, so
  // this can never false-positive on a legitimate file.
  if (visited.has(pageNum)) return [];
  visited.add(pageNum);

  const base = (pageNum - 1) * pageSize;
  const hdr = pageNum === 1 ? 100 : 0; // page 1 has 100-byte db header before the btree header

  const pageType = db[base + hdr];
  const numCells = u16(db, base + hdr + 3);
  const rows: SqliteValue[][] = [];

  if (pageType === 5) {
    // Interior table page
    const rightmost = u32(db, base + hdr + 8);
    const ptrBase = base + hdr + 12;
    for (let i = 0; i < numCells; i++) {
      const cellPos = base + u16(db, ptrBase + i * 2);
      rows.push(...traverseTable(db, u32(db, cellPos), pageSize, visited, onSkippedRow));
    }
    rows.push(...traverseTable(db, rightmost, pageSize, visited, onSkippedRow));
  }

  if (pageType === 13) {
    // Leaf table page
    const ptrBase = base + hdr + 8;
    for (let i = 0; i < numCells; i++) {
      try {
        let pos = base + u16(db, ptrBase + i * 2);
        const [payloadLen, ps] = varint(db, pos);
        pos += ps;
        const [, rs] = varint(db, pos);
        pos += rs; // skip rowid
        rows.push(decodeRecord(db.subarray(pos, pos + payloadLen)));
      } catch (e) {
        // A single corrupted/truncated row shouldn't take down the whole
        // table scan — skip it and keep whatever other rows are still
        // valid. Only a recognized corruption error is swallowed; anything
        // else (a real bug) propagates instead of being silently absorbed.
        // Every throw site reachable from this block only ever raises
        // CorruptedRecordError today, so the rethrow is an untestable
        // safety net against a future regression, not dead code.
        /* c8 ignore next */ if (!(e instanceof CorruptedRecordError)) throw e;
        onSkippedRow?.(e);
      }
    }
  }

  return rows;
}

// SQLite recognizes four quoting styles: '...' and "..." (string literal or
// identifier, doubled-quote escape) and `...` and [...] (identifier only,
// MySQL/SQL-Server compat — [...] has no escape, it just ends at the first ]).
const QUOTE_CLOSE: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };

// Scans a quoted region starting at `start` (one of the four opening quote
// characters above) and returns the index just past its matching close.
// Throws on an unterminated quote instead of returning early — silently
// treating the rest of the input as still "inside" the quote would swallow
// every following structural character (comment markers, commas, parens)
// as string content, which only happens on a corrupted/malicious schema
// SQLite's own parser would never have produced.
function skipQuoted(s: string, start: number): number {
  const open = s[start];
  const close = QUOTE_CLOSE[open];
  const escapes = open !== "["; // [...] has no escape mechanism
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === close) {
      if (escapes && s[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  throw new Error(`Invalid SQL: unterminated ${open}${close} literal`);
}

// A regex-based `/\*...\*\/` strip can go quadratic on adversarial input
// (many "/*" with no closing "*/"), so this scans manually — indexOf is
// linear, unlike a backtracking match attempt restarted at every "/*".
//
// Skips over quoted regions so a "--"/"/*" inside one (e.g. `DEFAULT
// 'a--b'`) isn't mistaken for a real comment.
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (QUOTE_CLOSE[sql[i]]) {
      const end = skipQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      // stop before the newline so it's preserved below; unterminated "--"
      // only happens on invalid SQL that SQLite itself would never have
      // accepted for CREATE TABLE, so falling off the end here is defensive
      /* c8 ignore next */ i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      /* c8 ignore next */ i = close === -1 ? sql.length : close + 2; // unterminated "/*" — same reasoning as above
      out += " "; // a comment is whitespace-equivalent — don't merge the tokens on either side
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

function parseColumnNames(sql: string): string[] {
  // Strip comments first — otherwise a stray paren or comma inside one
  // throws off the depth-tracking split below.
  const clean = stripSqlComments(sql);

  const start = clean.indexOf("(");
  const end = clean.lastIndexOf(")");
  /* c8 ignore next */ if (start === -1 || end === -1) return []; // defensive: valid CREATE TABLE always has parens

  // Split by top-level commas (skip nested parentheses and quoted regions —
  // a default value like 'a,b' or 'a(b' must not affect the split)
  const body = clean.slice(start + 1, end);
  const defs: string[] = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (QUOTE_CLOSE[ch]) {
      const j = skipQuoted(body, i);
      cur += body.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      defs.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  /* c8 ignore next */ if (cur.trim()) defs.push(cur.trim());

  return defs
    .map((def) => def.match(/^["'`]?(\w+)["'`]?/)?.[1] /* c8 ignore next */ ?? "")
    .filter((name) => name && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)/i.test(name));
}

const MAGIC = "SQLite format 3\0";

/**
 * @param onSkippedRow Called once per row excluded because it was corrupted
 * (truncated payload, malformed varint). Without it, a corrupted row is
 * indistinguishable from the table simply having fewer rows — pass a
 * callback to detect or log data loss.
 */
export function readTable(
  db: Uint8Array,
  tableName: string,
  onSkippedRow?: (error: CorruptedRecordError) => void,
): SqliteRow[] {
  for (let i = 0; i < 16; i++) {
    if (db[i] !== MAGIC.charCodeAt(i)) throw new Error("not a SQLite3 file");
  }

  let pageSize = u16(db, 16);
  if (pageSize === 1) pageSize = 65536;

  // sqlite_master is always at root page 1; columns: type, name, tbl_name, rootpage, sql
  const master = traverseTable(db, 1, pageSize, undefined, onSkippedRow);

  let rootPage: number | null = null;
  let columnSql: string | null = null;

  for (const row of master) {
    if (row[0] === "table" && row[1] === tableName) {
      rootPage = typeof row[3] === "number" ? row[3] : /* c8 ignore next */ null;
      columnSql = typeof row[4] === "string" ? row[4] : /* c8 ignore next */ null;
      break;
    }
  }

  if (rootPage === null) return [];

  const columns = columnSql ? parseColumnNames(columnSql) : /* c8 ignore next */ [];
  return traverseTable(db, rootPage, pageSize, undefined, onSkippedRow).map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i] ?? null])),
  );
}
