// File edit history — tracks every change for undo capability
// Stores before/after snapshots in SQLite alongside sessions

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface FileChange {
  id: number;
  sessionId: string;
  filePath: string;
  operation: "edit" | "write" | "create" | "delete";
  beforeContent: string | null; // null if file didn't exist
  afterContent: string;
  toolCallId?: string;
  timestamp: string;
}

const DATA_DIR = join(homedir(), ".cozyterm", "data");
const DB_PATH = join(DATA_DIR, "history.db");

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.run("PRAGMA journal_mode = WAL");

  _db.run(`
    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      operation TEXT NOT NULL,
      before_content TEXT,
      after_content TEXT NOT NULL,
      tool_call_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  _db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_session
    ON file_changes(session_id)
  `);

  _db.run(`
    CREATE INDEX IF NOT EXISTS idx_changes_file
    ON file_changes(file_path)
  `);

  return _db;
}

export function recordChange(
  sessionId: string,
  filePath: string,
  operation: FileChange["operation"],
  beforeContent: string | null,
  afterContent: string,
  toolCallId?: string,
): void {
  const db = getDb();
  db.run(
    `INSERT INTO file_changes (session_id, file_path, operation, before_content, after_content, tool_call_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, filePath, operation, beforeContent, afterContent, toolCallId || null],
  );
}

export function getSessionChanges(sessionId: string): FileChange[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, session_id, file_path, operation, before_content, after_content, tool_call_id, timestamp
       FROM file_changes WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId) as FileChange[];
}

export function getFileChanges(filePath: string, limit = 20): FileChange[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, session_id, file_path, operation, before_content, after_content, tool_call_id, timestamp
       FROM file_changes WHERE file_path = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(filePath, limit) as FileChange[];
}

// Undo the last change to a specific file
export function undoLastChange(filePath: string): { success: boolean; message: string } {
  const changes = getFileChanges(filePath, 1);
  if (changes.length === 0) {
    return { success: false, message: `No changes recorded for ${filePath}` };
  }

  const lastChange = changes[0];

  if (lastChange.beforeContent === null) {
    // File was created — we'd need to delete it
    return {
      success: false,
      message: `Last change was file creation. Delete ${filePath} manually if needed.`,
    };
  }

  try {
    writeFileSync(filePath, lastChange.beforeContent, "utf-8");

    // Record the undo as its own change
    recordChange(
      lastChange.sessionId,
      filePath,
      "edit",
      lastChange.afterContent,
      lastChange.beforeContent,
      "undo",
    );

    return {
      success: true,
      message: `Restored ${filePath} to before "${lastChange.operation}" at ${lastChange.timestamp}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to undo: ${(err as Error).message}`,
    };
  }
}

// Undo ALL changes from a session (reverse order)
export function undoSession(sessionId: string): { undone: number; errors: string[] } {
  const changes = getSessionChanges(sessionId).reverse();
  let undone = 0;
  const errors: string[] = [];

  for (const change of changes) {
    if (change.beforeContent === null) {
      errors.push(`${change.filePath}: was created, skip`);
      continue;
    }
    if (change.toolCallId === "undo") continue; // Don't undo undos

    try {
      writeFileSync(change.filePath, change.beforeContent, "utf-8");
      undone++;
    } catch (err) {
      errors.push(`${change.filePath}: ${(err as Error).message}`);
    }
  }

  return { undone, errors };
}

// Get summary stats
export function historyStats(): { totalChanges: number; filesChanged: number; sessions: number } {
  const db = getDb();
  const row = db
    .query(
      `SELECT
         COUNT(*) as total,
         COUNT(DISTINCT file_path) as files,
         COUNT(DISTINCT session_id) as sessions
       FROM file_changes`,
    )
    .get() as { total: number; files: number; sessions: number };

  return {
    totalChanges: row.total,
    filesChanged: row.files,
    sessions: row.sessions,
  };
}
