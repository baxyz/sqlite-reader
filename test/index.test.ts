import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { readTable } from "../src/index";

function makeDb(setup: (db: DatabaseSync) => void): Uint8Array {
  const path = join(
    tmpdir(),
    `sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  const db = new DatabaseSync(path);
  try {
    setup(db);
    db.close();
    return new Uint8Array(readFileSync(path));
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

describe("readTable", () => {
  it("returns empty array for unknown table", () => {
    const data = makeDb((db) => {
      db.exec("CREATE TABLE Foo (id INTEGER PRIMARY KEY, val TEXT)");
    });
    expect(readTable(data, "Bar")).toEqual([]);
  });

  it("reads rows with correct column names and values", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE Profiles (
          id   INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL
        );
        INSERT INTO Profiles VALUES (1, 'Profiles/abc1.default-release', 'Default');
        INSERT INTO Profiles VALUES (2, 'c7IZaLu7.Perso', 'Perso');
        INSERT INTO Profiles VALUES (3, 'q9RtZpLw.Boulot', 'Boulot');
      `);
    });

    const rows = readTable(data, "Profiles");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ path: "Profiles/abc1.default-release", name: "Default" });
    expect(rows[1]).toMatchObject({ path: "c7IZaLu7.Perso", name: "Perso" });
    expect(rows[2]).toMatchObject({ path: "q9RtZpLw.Boulot", name: "Boulot" });
  });

  it("handles unicode profile names", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE Profiles (id INTEGER PRIMARY KEY, path TEXT, name TEXT);
        INSERT INTO Profiles VALUES (1, 'abc.test', 'Profil Spécial émojis 🦊');
      `);
    });

    const rows = readTable(data, "Profiles");
    expect(rows[0]?.name).toBe("Profil Spécial émojis 🦊");
  });

  it("returns empty array on empty table", () => {
    const data = makeDb((db) => {
      db.exec("CREATE TABLE Profiles (id INTEGER PRIMARY KEY, path TEXT, name TEXT)");
    });
    expect(readTable(data, "Profiles")).toEqual([]);
  });

  it("throws on invalid magic bytes", () => {
    const bad = new Uint8Array(4096).fill(0);
    expect(() => readTable(bad, "Profiles")).toThrow("not a SQLite3 file");
  });

  it("decodes all integer/float sizes including 48/64-bit and float64, returns null for blobs", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE Types (
          id   INTEGER PRIMARY KEY,
          n1   INTEGER,
          p2   INTEGER,
          n2   INTEGER,
          p3   INTEGER,
          n3   INTEGER,
          p4   INTEGER,
          n4   INTEGER,
          big6 INTEGER,
          big8 INTEGER,
          flt  REAL,
          blb  BLOB,
          zero INTEGER,
          one  INTEGER
        );
        INSERT INTO Types VALUES (
          1,
          -1, 300, -300,
          40000, -40000,
          9000000, -9000000,
          2147483648, 140737488355328,
          3.14, X'DEADBEEF',
          0, 1
        );
      `);
    });
    const rows = readTable(data, "Types");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      n1: -1,
      p2: 300,
      n2: -300,
      p3: 40000,
      n3: -40000,
      p4: 9000000,
      n4: -9000000,
      big6: 2147483648,
      big8: 140737488355328,
      flt: 3.14,
      blb: null,
      zero: 0,
      one: 1,
    });
  });

  it("decodes negative 48-bit/64-bit integers and negative float64", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE Signed (
          id   INTEGER PRIMARY KEY,
          big6 INTEGER,
          big8 INTEGER,
          flt  REAL
        );
        INSERT INTO Signed VALUES (1, -140737488355328, -9223372036854775808, -3.14);
      `);
    });
    const rows = readTable(data, "Signed");
    expect(rows[0]).toMatchObject({
      big6: -140737488355328,
      big8: -9223372036854775808,
      flt: -3.14,
    });
  });

  it("throws when a corrupted payload length truncates a column's declared bytes", () => {
    const data = makeDb((db) => {
      db.exec("PRAGMA page_size=512");
      db.exec("CREATE TABLE Trunc (id INTEGER PRIMARY KEY, val TEXT)");
      db.exec(`INSERT INTO Trunc VALUES (1, '${"x".repeat(50)}')`);
    });

    const pageSize = 512;
    const totalPages = data.length / pageSize;
    let leafBase: number | null = null;
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const base = (pageNum - 1) * pageSize;
      if (data[base] === 13) {
        leafBase = base;
        break;
      }
    }
    expect(leafBase).not.toBeNull();

    const ptrBase = leafBase! + 8;
    const cellPos = leafBase! + ((data[ptrBase] << 8) | data[ptrBase + 1]);
    // First byte of the cell is the payload-length varint. Shrink it so the
    // payload slice handed to decodeRecord no longer covers the 50-byte
    // string that the record header still declares.
    data[cellPos] = 4;

    expect(() => readTable(data, "Trunc")).toThrow(/payload too short/);
  });

  it("throws when a record's header varint is truncated to nothing", () => {
    const data = makeDb((db) => {
      db.exec("PRAGMA page_size=512");
      db.exec("CREATE TABLE Empty (id INTEGER PRIMARY KEY, val TEXT)");
      db.exec("INSERT INTO Empty VALUES (1, 'x')");
    });

    const pageSize = 512;
    const totalPages = data.length / pageSize;
    let leafBase: number | null = null;
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const base = (pageNum - 1) * pageSize;
      if (data[base] === 13) {
        leafBase = base;
        break;
      }
    }
    expect(leafBase).not.toBeNull();

    const ptrBase = leafBase! + 8;
    const cellPos = leafBase! + ((data[ptrBase] << 8) | data[ptrBase + 1]);
    // Declare a zero-length payload — too short to contain even the header
    // varint decodeRecord reads first.
    data[cellPos] = 0;

    expect(() => readTable(data, "Empty")).toThrow(/truncated buffer/);
  });

  it("throws when a header-length varint never terminates within the payload", () => {
    const data = makeDb((db) => {
      db.exec("PRAGMA page_size=512");
      db.exec("CREATE TABLE NoTerm (id INTEGER PRIMARY KEY, val TEXT)");
      db.exec(`INSERT INTO NoTerm VALUES (1, '${"x".repeat(50)}')`);
    });

    const pageSize = 512;
    const totalPages = data.length / pageSize;
    let leafBase: number | null = null;
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      const base = (pageNum - 1) * pageSize;
      if (data[base] === 13) {
        leafBase = base;
        break;
      }
    }
    expect(leafBase).not.toBeNull();

    const ptrBase = leafBase! + 8;
    const cellPos = leafBase! + ((data[ptrBase] << 8) | data[ptrBase + 1]);
    data[cellPos] = 8; // declare an 8-byte payload (1-byte payload-length varint, 1-byte rowid)
    // Fill it with continuation-flagged bytes so the header-length varint
    // never terminates within those 8 bytes and runs off the end.
    for (let j = 0; j < 8; j++) data[cellPos + 2 + j] = 0xff;

    expect(() => readTable(data, "NoTerm")).toThrow(/truncated buffer/);
  });

  it("parses column names when schema has a comment containing an unbalanced paren/comma", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE Commented (
          -- unbalanced paren) in a comment, before the real columns
          id  INTEGER PRIMARY KEY,
          val TEXT
        );
        INSERT INTO Commented VALUES (1, 'hello');
      `);
    });
    const rows = readTable(data, "Commented");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ val: "hello" });
  });

  it("parses column names when schema has a /* block comment */ with an unbalanced paren/comma", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE BlockCommented (
          /* unbalanced paren) in a comment, before the real columns */
          id  INTEGER PRIMARY KEY,
          val TEXT
        );
        INSERT INTO BlockCommented VALUES (1, 'hello');
      `);
    });
    const rows = readTable(data, "BlockCommented");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ val: "hello" });
  });

  it("parses column names when schema has CHECK constraints and CONSTRAINT clauses", () => {
    const data = makeDb((db) => {
      db.exec(`
        CREATE TABLE Checked (
          id  INTEGER PRIMARY KEY,
          val INTEGER CHECK (val > 0),
          CONSTRAINT chk_unique UNIQUE (val)
        );
        INSERT INTO Checked VALUES (1, 42);
      `);
    });
    const rows = readTable(data, "Checked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ val: 42 });
    expect(rows[0]).not.toHaveProperty("CONSTRAINT");
  });

  it("handles 9-byte varint (max rowid)", () => {
    const data = makeDb((db) => {
      db.exec("CREATE TABLE MaxId (id INTEGER PRIMARY KEY, val TEXT)");
      db.exec("INSERT INTO MaxId VALUES (9223372036854775807, 'max')");
    });
    const rows = readTable(data, "MaxId");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ val: "max" });
  });

  it("traverses interior B-tree pages", () => {
    const data = makeDb((db) => {
      db.exec("PRAGMA page_size=512");
      db.exec("CREATE TABLE Big (id INTEGER PRIMARY KEY, val TEXT)");
      for (let i = 1; i <= 100; i++) {
        db.exec(`INSERT INTO Big VALUES (${i}, 'Row ${String(i).padStart(3, "0")}')`);
      }
    });
    const rows = readTable(data, "Big");
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({ val: "Row 001" });
    expect(rows[99]).toMatchObject({ val: "Row 100" });
  });

  it("stops instead of recursing forever when an interior page's child pointer cycles back", () => {
    const data = makeDb((db) => {
      db.exec("PRAGMA page_size=512");
      db.exec("CREATE TABLE Big (id INTEGER PRIMARY KEY, val TEXT)");
      for (let i = 1; i <= 100; i++) {
        db.exec(`INSERT INTO Big VALUES (${i}, 'Row ${String(i).padStart(3, "0")}')`);
      }
    });

    const pageSize = 512;
    const totalPages = data.length / pageSize;
    let interiorPageNum: number | null = null;
    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      if (data[(pageNum - 1) * pageSize] === 5) {
        interiorPageNum = pageNum;
        break;
      }
    }
    expect(interiorPageNum).not.toBeNull();

    // Corrupt: point the interior page's rightmost-child pointer back at itself.
    const base = (interiorPageNum! - 1) * pageSize;
    new DataView(data.buffer, data.byteOffset + base + 8, 4).setUint32(0, interiorPageNum!, false);

    expect(() => readTable(data, "Big")).not.toThrow();
  });

  it("returns rows without column names when schema uses bracket-quoted identifiers", () => {
    const data = makeDb((db) => {
      db.exec("CREATE TABLE Bracketed ([id] INTEGER PRIMARY KEY, [val] TEXT)");
      db.exec("INSERT INTO Bracketed VALUES (1, 'hello')");
    });
    const rows = readTable(data, "Bracketed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({});
  });

  it("handles page size 65536", () => {
    const data = makeDb((db) => {
      db.exec("PRAGMA page_size=65536");
      db.exec("CREATE TABLE PgTest (id INTEGER PRIMARY KEY, val TEXT)");
      db.exec("INSERT INTO PgTest VALUES (1, 'big page')");
    });
    const rows = readTable(data, "PgTest");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ val: "big page" });
  });
});
