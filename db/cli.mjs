import { access } from "node:fs/promises";
import { backupDatabase, restoreDatabase } from "./maintenance.mjs";
import { seedDevelopmentData } from "./seed.mjs";
import { applyMigrations, inspectDatabase, openDatabase, resolveRuntimeDatabasePath } from "./sqlite.mjs";

const COMMANDS = new Set(["migrate", "seed", "status", "backup", "restore"]);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name}の値を指定してください。`);
  return value;
}

function printUsage() {
  console.log("使用方法: node db/cli.mjs <migrate|seed|status|backup|restore> [--db <DBパス>]");
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") return printUsage();
  if (!COMMANDS.has(command)) {
    throw new Error("コマンドはmigrate、seed、status、backup、restoreのいずれかを指定してください。");
  }
  const databasePath = resolveRuntimeDatabasePath(optionValue("--db"));

  if (command === "migrate") {
    const database = openDatabase(databasePath);
    try {
      const result = await applyMigrations(database);
      console.log(`マイグレーション完了: 新規${result.applied.length}件 / 全${result.total}件`);
      console.log(databasePath);
    } finally {
      database.close();
    }
    return;
  }

  if (command === "seed") {
    const database = openDatabase(databasePath);
    try {
      await applyMigrations(database);
      const result = seedDevelopmentData(database);
      console.log(`架空seed完了: ${result.familyId} / 園児${result.childIds.length}名 / ${result.targetMonth}`);
      console.log(databasePath);
    } finally {
      database.close();
    }
    return;
  }

  if (command === "status") {
    if (!(await fileExists(databasePath))) {
      console.log(`DB未作成: ${databasePath}`);
      return;
    }
    const database = openDatabase(databasePath, { readOnly: true });
    try {
      const report = inspectDatabase(database);
      console.log(JSON.stringify(report, null, 2));
    } finally {
      database.close();
    }
    return;
  }

  if (command === "backup") {
    const backupPath = await backupDatabase({ databasePath });
    console.log(`バックアップ完了: ${backupPath}`);
    return;
  }

  if (command === "restore") {
    const sourcePath = optionValue("--file");
    const result = await restoreDatabase({ databasePath, sourcePath });
    console.log(`復元完了: ${result.databasePath}`);
    console.log(`復元元: ${result.sourcePath}`);
    console.log(`復元前バックアップ: ${result.preRestoreBackupPath || "元DBなし"}`);
    return;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
