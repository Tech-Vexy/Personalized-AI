import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/**
 * One SQLite file is the whole store (spec.md > Data Model).
 * Importing this module opens (and if needed creates) `data/memory.db`,
 * so any process start — dev, build, probe — self-heals the file.
 */

const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "memory.db");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

/** Raw handle for the pieces Drizzle doesn't express — FTS5 match/snippet/bm25. */
export { sqlite };

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    content           TEXT    NOT NULL,
    source_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, id);
  CREATE INDEX IF NOT EXISTS memories_source_idx ON memories (source_session_id);

  -- Standalone FTS5 index over memories.content; rowid kept aligned with memories.id
  -- by the writer in memory.ts (spec.md > Data Model > memories_fts).
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content);

  CREATE TABLE IF NOT EXISTS profile (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const db = drizzle(sqlite, { schema });
