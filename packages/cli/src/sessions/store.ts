// Session store — SQLite-backed session persistence via bun:sqlite

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "../providers/types.js";

export interface Session {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

const DATA_DIR = join(homedir(), ".cozyterm", "data");
const DB_PATH = join(DATA_DIR, "sessions.db");

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");

  // Create tables
  _db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  _db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id)
  `);

  return _db;
}

export function createSession(
  cwd: string,
  provider: string,
  model: string,
  title?: string,
): Session {
  const db = getDb();
  const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO sessions (id, title, cwd, provider, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, title || "New Session", cwd, provider, model, now, now],
  );

  return { id, title: title || "New Session", cwd, provider, model, createdAt: now, updatedAt: now };
}

export function saveMessage(sessionId: string, message: Message): void {
  const db = getDb();
  db.run(
    `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      message.role,
      message.content,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId || null,
      message.name || null,
    ],
  );

  db.run(
    `UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`,
    [sessionId],
  );
}

export function getSessionMessages(sessionId: string): Message[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT role, content, tool_calls, tool_call_id, name
       FROM messages WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId) as {
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    name: string | null;
  }[];

  return rows.map((r) => ({
    role: r.role as Message["role"],
    content: r.content,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    toolCallId: r.tool_call_id || undefined,
    name: r.name || undefined,
  }));
}

export function listSessions(limit = 20): Session[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, title, cwd, provider, model, created_at, updated_at
       FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as Session[];
}

export function updateSessionTitle(sessionId: string, title: string): void {
  const db = getDb();
  db.run(`UPDATE sessions SET title = ? WHERE id = ?`, [title, sessionId]);
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}
