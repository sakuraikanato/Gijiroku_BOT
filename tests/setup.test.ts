import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SQLite supports the development database settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-sqlite-"));
  try {
    const db = new Database(join(directory, "probe.sqlite"), { create: true });
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      expect(db.query("PRAGMA journal_mode = WAL").values()).toEqual([["wal"]]);
      expect(db.query("PRAGMA foreign_keys").values()).toEqual([[1]]);
      expect(db.query("PRAGMA busy_timeout").values()).toEqual([[5000]]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
