import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_DATABASE_PATH = resolve(PROJECT_ROOT, "local-data", "nursery-schedule.sqlite");
export const DEFAULT_MIGRATIONS_PATH = resolve(PROJECT_ROOT, "drizzle");
export const VERIFICATION_DATABASE_DIRECTORY = resolve(PROJECT_ROOT, ".verification");

export const REQUIRED_APPLICATION_TABLES_BY_MIGRATION = {
  "0000_condemned_exodus.sql": [
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
  ],
  "0001_lowly_mercury.sql": [],
  "0002_shallow_hex.sql": ["auth_login_attempts", "auth_sessions", "auth_settings"],
  "0003_loose_luckman.sql": [
    "basic_usage_pattern_histories",
    "family_deadline_extensions",
    "family_submission_version_children",
    "family_submission_version_days",
    "family_submission_versions",
  ],
  "0004_tired_pandemic.sql": [
    "staff_members",
    "staff_qualifications",
    "staff_weekly_availability",
    "staff_work_condition_versions",
  ],
  "0005_zippy_nehzno.sql": [],
  "0006_parallel_toro.sql": [],
  "0007_reflective_zombie.sql": ["staff_roles"],
  "0008_majestic_black_crow.sql": [
    "staff_schedule_days",
    "staff_schedule_months",
    "staff_schedule_segments",
    "staff_schedule_versions",
  ],
  "0009_exotic_skin.sql": ["staff_schedule_preferences"],
};

export const REQUIRED_APPLICATION_TABLES = [
  ...new Set(Object.values(REQUIRED_APPLICATION_TABLES_BY_MIGRATION).flat()),
];

export function resolveDatabasePath(value = process.env.NURSERY_DB_PATH || DEFAULT_DATABASE_PATH) {
  const databasePath = resolve(value);
  const extension = extname(databasePath).toLowerCase();
  if (![".sqlite", ".sqlite3", ".db"].includes(extension)) {
    throw new Error("DBファイルは.sqlite、.sqlite3、.dbのいずれかを指定してください。");
  }
  return databasePath;
}

export function resolveRuntimeDatabasePath(value, options = {}) {
  const verificationMode = options.verificationMode ?? process.env.NURSERY_VERIFICATION_MODE === "true";
  const environmentDatabasePath = Object.prototype.hasOwnProperty.call(options, "environmentDatabasePath")
    ? options.environmentDatabasePath
    : process.env.NURSERY_DB_PATH;
  const selectedPath = value || environmentDatabasePath;
  if (verificationMode && !selectedPath) {
    throw new Error("検証モードではNURSERY_DB_PATHで検証DBを明示してください。");
  }

  const databasePath = resolveDatabasePath(selectedPath || DEFAULT_DATABASE_PATH);
  if (verificationMode) {
    const relativePath = relative(VERIFICATION_DATABASE_DIRECTORY, databasePath);
    const outsideVerificationDirectory =
      !relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
    if (outsideVerificationDirectory) {
      throw new Error(`検証モードでは.verification配下のDBだけを使用できます: ${databasePath}`);
    }
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

function migrationManifest(migrationsPath = DEFAULT_MIGRATIONS_PATH) {
  return readdirSync(migrationsPath)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      checksum: migrationChecksum(readFileSync(resolve(migrationsPath, name), "utf8")),
    }));
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

export function inspectDatabase(database, migrationsPath = DEFAULT_MIGRATIONS_PATH) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const migrationErrors = [];
  const manifest = migrationManifest(migrationsPath);
  const appliedMigrations = tables.includes("_schema_migrations")
    ? database.prepare("SELECT name, checksum FROM _schema_migrations ORDER BY name").all()
    : [];

  if (!tables.includes("_schema_migrations")) {
    migrationErrors.push("migration履歴テーブルがありません。");
  } else if (appliedMigrations.length === 0) {
    migrationErrors.push("適用済みmigrationがありません。");
  }

  const expectedPrefix = manifest.slice(0, appliedMigrations.length);
  for (let index = 0; index < appliedMigrations.length; index += 1) {
    const applied = appliedMigrations[index];
    const expected = expectedPrefix[index];
    if (!expected || applied.name !== expected.name) {
      migrationErrors.push(`migration履歴が連続していません: ${applied.name}`);
      continue;
    }
    if (applied.checksum !== expected.checksum) {
      migrationErrors.push(`migrationのhashが一致しません: ${applied.name}`);
    }
    if (!Object.hasOwn(REQUIRED_APPLICATION_TABLES_BY_MIGRATION, applied.name)) {
      migrationErrors.push(`migrationの必須テーブル定義がありません: ${applied.name}`);
    }
  }

  const requiredTables = [
    ...new Set(appliedMigrations.flatMap(({ name }) => REQUIRED_APPLICATION_TABLES_BY_MIGRATION[name] || [])),
  ];
  const missingTables = requiredTables.filter((name) => !tables.includes(name));
  return {
    integrityOk: integrityRows.length === 1 && integrityRows[0].integrity_check === "ok",
    foreignKeysOk: foreignKeyErrors.length === 0,
    migrationsOk: migrationErrors.length === 0,
    appliedMigrations: appliedMigrations.map(({ name }) => name),
    migrationErrors,
    tables,
    requiredTables,
    missingTables,
  };
}
