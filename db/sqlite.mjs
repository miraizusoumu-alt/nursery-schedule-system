import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_DATABASE_PATH = resolve(PROJECT_ROOT, "local-data", "nursery-schedule.sqlite");
export const DEFAULT_MIGRATIONS_PATH = resolve(PROJECT_ROOT, "drizzle");

export const REQUIRED_APPLICATION_TABLES = [
  "administrators",
  "basic_usage_patterns",
  "change_histories",
  "change_history_reasons",
  "children",
  "closure_days",
  "daily_schedules",
  "families",
  "family_accounts",
  "family_children",
  "family_submissions",
  "monthly_schedules",
  "operation_logs",
  "standard_reason_histories",
  "standard_reasons",
  "submission_periods",
];

export function resolveDatabasePath(value = process.env.NURSERY_DB_PATH || DEFAULT_DATABASE_PATH) {
  const databasePath = resolve(value);
  const extension = extname(databasePath).toLowerCase();
  if (![".sqlite", ".sqlite3", ".db"].includes(extension)) {
    throw new Error("DBファイルは.sqlite、.sqlite3、.dbのいずれかを指定してください。");
  }
  return databasePath;
}

export function openDatabase(databasePath = resolveDatabasePath(), options = {}) {
  const resolvedPath = resolveDatabasePath(databasePath);
  const readOnly = options.readOnly === true;
  if (!readOnly) mkdirSync(dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath, { readOnly });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (!readOnly) database.exec("PRAGMA journal_mode = DELETE");
  return database;
}

function migrationChecksum(sqlText) {
  return createHash("sha256").update(sqlText, "utf8").digest("hex");
}

export async function applyMigrations(database, migrationsPath = DEFAULT_MIGRATIONS_PATH) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const fileNames = (await readdir(migrationsPath))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  const applied = database.prepare("SELECT name, checksum FROM _schema_migrations").all();
  const appliedByName = new Map(applied.map((entry) => [entry.name, entry.checksum]));
  const newlyApplied = [];

  for (const fileName of fileNames) {
    const sqlText = await readFile(resolve(migrationsPath, fileName), "utf8");
    const checksum = migrationChecksum(sqlText);
    const previousChecksum = appliedByName.get(fileName);
    if (previousChecksum && previousChecksum !== checksum) {
      throw new Error(`適用済みマイグレーションが変更されています: ${fileName}`);
    }
    if (previousChecksum) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sqlText);
      database
        .prepare("INSERT INTO _schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)")
        .run(fileName, checksum, new Date().toISOString());
      database.exec("COMMIT");
      newlyApplied.push(fileName);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  database.exec("PRAGMA optimize");
  return { applied: newlyApplied, total: fileNames.length };
}

export function inspectDatabase(database) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const missingTables = REQUIRED_APPLICATION_TABLES.filter((name) => !tables.includes(name));
  return {
    integrityOk: integrityRows.length === 1 && integrityRows[0].integrity_check === "ok",
    foreignKeysOk: foreignKeyErrors.length === 0,
    tables,
    missingTables,
  };
}
