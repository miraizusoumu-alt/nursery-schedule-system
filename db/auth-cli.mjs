import { createDevelopmentAuthAccounts, resetDevelopmentAuthAccounts } from "./auth-dev-accounts.mjs";
import { applyMigrations, openDatabase, resolveRuntimeDatabasePath } from "./sqlite.mjs";

const COMMANDS = new Set(["create", "reset"]);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name}の値を指定してください。`);
  return value;
}

function printUsage() {
  console.log("使用方法: node db/auth-cli.mjs <create|reset> [--db <検証DBパス>]");
}

function printResults(results) {
  for (const result of results) {
    const label = result.type === "family" ? "架空家庭" : result.type === "master" ? "架空マスター管理者" : "架空通常管理者";
    console.log(`\n${label}`);
    console.log(`ログインID: ${result.loginId}`);
    if (result.temporaryPassword) console.log(`初期・仮パスワード（今回だけ表示）: ${result.temporaryPassword}`);
    else console.log("作成済みのため変更していません。パスワードは表示できません。");
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") return printUsage();
  if (!COMMANDS.has(command)) throw new Error("create または reset を指定してください。");

  const databasePath = resolveRuntimeDatabasePath(optionValue("--db"));
  console.log(`Using database: ${databasePath}`);
  const database = openDatabase(databasePath);
  try {
    await applyMigrations(database);
    if (command === "create") return printResults(await createDevelopmentAuthAccounts(database));
    return printResults(await resetDevelopmentAuthAccounts(database));
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "開発用アカウントを処理できませんでした。");
  process.exitCode = 1;
});
