import { access, mkdir, rename, rm } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { DEFAULT_DATABASE_PATH, PROJECT_ROOT, inspectDatabase, resolveDatabasePath } from "./sqlite.mjs";

export const DEFAULT_BACKUP_DIRECTORY = resolve(PROJECT_ROOT, "backups", "database");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertBackupSourcePath(value) {
  if (!value) throw new Error("復元元ファイルを--fileで明示してください。");
  const sourcePath = resolve(value);
  if (![".sqlite", ".sqlite3", ".db"].includes(extname(sourcePath).toLowerCase())) {
    throw new Error("復元元は.sqlite、.sqlite3、.dbのいずれかを指定してください。");
  }
  return sourcePath;
}

function fileTimestamp(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

function verifyOpenDatabase(database) {
  const report = inspectDatabase(database);
  if (!report.integrityOk || !report.foreignKeysOk || report.missingTables.length > 0) {
    throw new Error(`DB検証に失敗しました。不足テーブル: ${report.missingTables.join(", ") || "なし"}`);
  }
  return report;
}

export async function backupDatabase(options = {}) {
  const databasePath = resolveDatabasePath(options.databasePath || DEFAULT_DATABASE_PATH);
  if (!(await exists(databasePath))) throw new Error(`DBファイルが見つかりません: ${databasePath}`);
  const backupDirectory = resolve(options.backupDirectory || DEFAULT_BACKUP_DIRECTORY);
  await mkdir(backupDirectory, { recursive: true });
  const label = options.label || "manual-backup";
  const backupPath = resolve(backupDirectory, `${fileTimestamp(options.now)}_${label}.sqlite`);
  if (await exists(backupPath)) throw new Error(`同名バックアップが既に存在します: ${backupPath}`);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    verifyOpenDatabase(database);
    await backup(database, backupPath);
  } finally {
    database.close();
  }

  const verificationDatabase = new DatabaseSync(backupPath, { readOnly: true });
  try {
    verifyOpenDatabase(verificationDatabase);
  } finally {
    verificationDatabase.close();
  }
  return backupPath;
}

export async function restoreDatabase(options = {}) {
  const databasePath = resolveDatabasePath(options.databasePath || DEFAULT_DATABASE_PATH);
  const sourcePath = assertBackupSourcePath(options.sourcePath);
  if (sourcePath === databasePath) throw new Error("現在のDB自身を復元元には指定できません。");
  if (!(await exists(sourcePath))) throw new Error(`復元元ファイルが見つかりません: ${sourcePath}`);

  const sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    verifyOpenDatabase(sourceDatabase);
  } finally {
    sourceDatabase.close();
  }

  const preRestoreBackupPath = (await exists(databasePath))
    ? await backupDatabase({
        databasePath,
        backupDirectory: options.backupDirectory,
        label: "pre-restore",
        now: options.now,
      })
    : null;

  const temporaryPath = resolveDatabasePath(`${databasePath.replace(/\.(sqlite3?|db)$/i, "")}.restore-${process.pid}-${Date.now()}.sqlite`);
  const rollbackPath = resolveDatabasePath(`${databasePath.replace(/\.(sqlite3?|db)$/i, "")}.rollback-${process.pid}-${Date.now()}.sqlite`);
  let movedCurrent = false;

  try {
    const sourceForCopy = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(sourceForCopy, temporaryPath);
    } finally {
      sourceForCopy.close();
    }

    const temporaryDatabase = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      verifyOpenDatabase(temporaryDatabase);
    } finally {
      temporaryDatabase.close();
    }

    if (await exists(databasePath)) {
      await rename(databasePath, rollbackPath);
      movedCurrent = true;
    }
    await rename(temporaryPath, databasePath);

    const restoredDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      verifyOpenDatabase(restoredDatabase);
    } finally {
      restoredDatabase.close();
    }

    if (movedCurrent) await rm(rollbackPath, { force: true });
    return { databasePath, sourcePath, preRestoreBackupPath };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (movedCurrent && (await exists(rollbackPath))) {
      await rm(databasePath, { force: true });
      await rename(rollbackPath, databasePath);
    }
    throw error;
  }
}
