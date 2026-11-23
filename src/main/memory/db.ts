import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null

/**
 * One local SQLite file (built into Electron's Node, no native deps).
 * - memories: small curated facts about you (learned or manual), FTS + optional embedding
 * - sources/chunks: RAG over folders you add, FTS + optional embedding
 */
export function getDb(): DatabaseSync {
  if (db) return db
  // JARVIS_DB_DIR lets headless tests run without Electron.
  const dir = process.env.JARVIS_DB_DIR || app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(join(dir, 'jarvis.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      pinned INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      embed_model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize = 'porter unicode61');

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      files INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB,
      embed_model TEXT
    );
    CREATE INDEX IF NOT EXISTS chunks_by_path ON chunks(source_id, path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, path UNINDEXED, tokenize = 'porter unicode61');
  `)
  return db
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copy: the returned buffer may not be 4-byte aligned.
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return new Float32Array(copy.buffer)
}

/** Turn free text into a safe FTS5 OR-query of quoted terms. */
export function ftsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).filter((t) => !STOP.has(t)).slice(0, 24)
  if (!terms.length) return null
  return [...new Set(terms)].map((t) => `"${t}"`).join(' OR ')
}

const STOP = new Set(
  'the a an and or but if then of to in on at for with from by is are was were be been it this that these those i me my you your we our can could should would will do does did have has had not no so as what which who how why when where please just'.split(
    ' '
  )
)
