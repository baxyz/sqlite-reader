// Read-only SQLite3 binary parser — leaf + interior B-tree pages, no overflow, UTF-8 only.
// Spec: https://www.sqlite.org/fileformat2.html

type SqliteValue = string | number | null;
export type SqliteRow = Record<string, SqliteValue>;

function u16(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}

function u32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function varint(buf: Uint8Array, pos: number): [value: number, size: number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[pos + i];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [v, i + 1];
  }
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
  const lo = ((buf[pos + 2] << 24) | (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]) >>> 0;
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
    if (pos + serialTypeSize(t) > payload.length) {
      throw new Error("Invalid record: payload too short for declared column type");
    }

    if (t === 0) {
      values.push(null);
    } else if (t === 1) {
      const v = payload[pos++];
      values.push(v >= 0x80 ? v - 0x100 : v);
    } else if (t === 2) {
      const v = u16(payload, pos);
      pos += 2;
      values.push(v >= 0x8000 ? v - 0x10000 : v);
    } else if (t === 3) {
      const v = (payload[pos] << 16) | (payload[pos + 1] << 8) | payload[pos + 2];
      pos += 3;
      values.push(v >= 0x800000 ? v - 0x1000000 : v);
    } else if (t === 4) {
      const v = u32(payload, pos);
      pos += 4;
      values.push(v >= 0x80000000 ? v - 0x100000000 : v);
    } else if (t === 5) {
      values.push(readInt48(payload, pos));
      pos += 6;
    } else if (t === 6) {
      values.push(readInt64(payload, pos));
      pos += 8;
    } else if (t === 7) {
      values.push(readFloat64(payload, pos));
      pos += 8;
    } else if (t === 8) {
      values.push(0);
    } else if (t === 9) {
      values.push(1);
    } else if (t >= 12 && t % 2 === 0) {
      pos += (t - 12) / 2;
      values.push(null); // blob — not supported
    } else if (t >= 13 && t % 2 === 1) {
      const len = (t - 13) / 2;
      values.push(dec.decode(payload.subarray(pos, pos + len)));
      pos += len;
      /* c8 ignore start */
    } else {
      values.push(null);
    } // serial types 10/11 reserved — never emitted by SQLite
    /* c8 ignore stop */
  }

  return values;
}

function traverseTable(
  db: Uint8Array,
  pageNum: number,
  pageSize: number,
  visited: Set<number> = new Set(),
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
      rows.push(...traverseTable(db, u32(db, cellPos), pageSize, visited));
    }
    rows.push(...traverseTable(db, rightmost, pageSize, visited));
  }

  if (pageType === 13) {
    // Leaf table page
    const ptrBase = base + hdr + 8;
    for (let i = 0; i < numCells; i++) {
      let pos = base + u16(db, ptrBase + i * 2);
      const [payloadLen, ps] = varint(db, pos);
      pos += ps;
      const [, rs] = varint(db, pos);
      pos += rs; // skip rowid
      rows.push(decodeRecord(db.subarray(pos, pos + payloadLen)));
    }
  }

  return rows;
}

function parseColumnNames(sql: string): string[] {
  // Strip comments first — otherwise a stray paren or comma inside one
  // throws off the depth-tracking split below.
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  const start = clean.indexOf("(");
  const end = clean.lastIndexOf(")");
  /* c8 ignore next */ if (start === -1 || end === -1) return []; // defensive: valid CREATE TABLE always has parens

  // Split by top-level commas (skip nested parentheses)
  const defs: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of clean.slice(start + 1, end)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      defs.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  /* c8 ignore next */ if (cur.trim()) defs.push(cur.trim());

  return defs
    .map((def) => def.match(/^["'`]?(\w+)["'`]?/)?.[1] /* c8 ignore next */ ?? "")
    .filter((name) => name && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)/i.test(name));
}

const MAGIC = "SQLite format 3\0";

export function readTable(db: Uint8Array, tableName: string): SqliteRow[] {
  for (let i = 0; i < 16; i++) {
    if (db[i] !== MAGIC.charCodeAt(i)) throw new Error("not a SQLite3 file");
  }

  let pageSize = u16(db, 16);
  if (pageSize === 1) pageSize = 65536;

  // sqlite_master is always at root page 1; columns: type, name, tbl_name, rootpage, sql
  const master = traverseTable(db, 1, pageSize);

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
  return traverseTable(db, rootPage, pageSize).map((row) =>
    Object.fromEntries(columns.map((col, i) => [col, row[i] ?? null])),
  );
}
