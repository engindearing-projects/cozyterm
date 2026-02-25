// Forge DB reader — queries the engie trainer SQLite DB directly
// Read-only access to training runs, model versions, evaluations

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FORGE_DB = join(homedir(), "engie", "trainer", "db", "forge.db");

function openDb(): Database | null {
  if (!existsSync(FORGE_DB)) return null;
  try {
    return new Database(FORGE_DB, { readonly: true });
  } catch {
    return null;
  }
}

export interface ForgeStats {
  totalPairs: number;
  unusedPairs: number;
  totalRuns: number;
  totalVersions: number;
  activeVersion: string | null;
  lastRunVersion: string | null;
  lastRunStatus: string | null;
  taskTypeCounts: Record<string, number>;
}

export interface ModelVersion {
  version: string;
  createdAt: string;
  benchmarkScore: number | null;
  ollamaTag: string | null;
  deployed: boolean;
  active: boolean;
  notes: string | null;
}

export interface TrainingRun {
  version: string;
  startedAt: string;
  completedAt: string | null;
  trainLoss: number | null;
  validLoss: number | null;
  trainExamples: number | null;
  validExamples: number | null;
  iterations: number | null;
  durationSeconds: number | null;
  status: string;
}

export interface Evaluation {
  version: string;
  evaluatedAt: string;
  overallScore: number | null;
  syntaxScore: number | null;
  testScore: number | null;
  similarityScore: number | null;
  completenessScore: number | null;
  tasksEvaluated: number | null;
}

export function getForgeStats(): ForgeStats | null {
  const db = openDb();
  if (!db) return null;

  try {
    const totalPairs = (db.query("SELECT COUNT(*) as c FROM training_pairs").get() as { c: number }).c;
    const unusedPairs = (db.query("SELECT COUNT(*) as c FROM training_pairs WHERE used_in_training = 0").get() as { c: number }).c;
    const totalRuns = (db.query("SELECT COUNT(*) as c FROM training_runs").get() as { c: number }).c;
    const totalVersions = (db.query("SELECT COUNT(*) as c FROM model_versions").get() as { c: number }).c;

    const activeRow = db.query("SELECT version FROM model_versions WHERE active = 1 LIMIT 1").get() as { version: string } | null;
    const lastRun = db.query("SELECT version, status FROM training_runs ORDER BY id DESC LIMIT 1").get() as { version: string; status: string } | null;

    // Task type distribution
    const taskTypes = db.query("SELECT task_type, COUNT(*) as c FROM training_pairs WHERE task_type IS NOT NULL GROUP BY task_type").all() as { task_type: string; c: number }[];
    const taskTypeCounts: Record<string, number> = {};
    for (const row of taskTypes) {
      taskTypeCounts[row.task_type] = row.c;
    }

    db.close();

    return {
      totalPairs,
      unusedPairs,
      totalRuns,
      totalVersions,
      activeVersion: activeRow?.version || null,
      lastRunVersion: lastRun?.version || null,
      lastRunStatus: lastRun?.status || null,
      taskTypeCounts,
    };
  } catch {
    db.close();
    return null;
  }
}

export function getModelVersions(): ModelVersion[] {
  const db = openDb();
  if (!db) return [];

  try {
    const rows = db.query(
      `SELECT version, created_at, benchmark_score, ollama_tag, deployed, active, notes
       FROM model_versions ORDER BY created_at DESC`,
    ).all() as {
      version: string;
      created_at: string;
      benchmark_score: number | null;
      ollama_tag: string | null;
      deployed: number;
      active: number;
      notes: string | null;
    }[];

    db.close();

    return rows.map((r) => ({
      version: r.version,
      createdAt: r.created_at,
      benchmarkScore: r.benchmark_score,
      ollamaTag: r.ollama_tag,
      deployed: r.deployed === 1,
      active: r.active === 1,
      notes: r.notes,
    }));
  } catch {
    db.close();
    return [];
  }
}

export function getTrainingRuns(limit = 10): TrainingRun[] {
  const db = openDb();
  if (!db) return [];

  try {
    const rows = db.query(
      `SELECT version, started_at, completed_at, train_loss, valid_loss,
              train_examples, valid_examples, iterations, duration_seconds, status
       FROM training_runs ORDER BY id DESC LIMIT ?`,
    ).all(limit) as {
      version: string;
      started_at: string;
      completed_at: string | null;
      train_loss: number | null;
      valid_loss: number | null;
      train_examples: number | null;
      valid_examples: number | null;
      iterations: number | null;
      duration_seconds: number | null;
      status: string;
    }[];

    db.close();

    return rows.map((r) => ({
      version: r.version,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      trainLoss: r.train_loss,
      validLoss: r.valid_loss,
      trainExamples: r.train_examples,
      validExamples: r.valid_examples,
      iterations: r.iterations,
      durationSeconds: r.duration_seconds,
      status: r.status,
    }));
  } catch {
    db.close();
    return [];
  }
}

export function getLatestEvaluation(version?: string): Evaluation | null {
  const db = openDb();
  if (!db) return null;

  try {
    const query = version
      ? "SELECT * FROM evaluations WHERE version = ? ORDER BY id DESC LIMIT 1"
      : "SELECT * FROM evaluations ORDER BY id DESC LIMIT 1";
    const row = (version ? db.query(query).get(version) : db.query(query).get()) as {
      version: string;
      evaluated_at: string;
      overall_score: number | null;
      syntax_score: number | null;
      test_score: number | null;
      similarity_score: number | null;
      completeness_score: number | null;
      tasks_evaluated: number | null;
    } | null;

    db.close();
    if (!row) return null;

    return {
      version: row.version,
      evaluatedAt: row.evaluated_at,
      overallScore: row.overall_score,
      syntaxScore: row.syntax_score,
      testScore: row.test_score,
      similarityScore: row.similarity_score,
      completenessScore: row.completeness_score,
      tasksEvaluated: row.tasks_evaluated,
    };
  } catch {
    db.close();
    return null;
  }
}

export const TRAINER_DIR = join(homedir(), "engie", "trainer");
export const PYTHON = join(TRAINER_DIR, ".venv", "bin", "python");
export const FORGE_DB_PATH = FORGE_DB;
