import { createDevelopmentAuthAccounts, resetDevelopmentAuthAccounts } from "./auth-dev-accounts.mjs";
import { applyMigrations, openDatabase, resolveDatabasePath } from "./sqlite.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
  const databasePath = resolveDatabasePath(optionValue("--db"));
  const database = openDatabase(databasePath);
  try {
    await applyMigrations(database);
    if (command === "create") return printResults(await createDevelopmentAuthAccounts(database));
    if (command === "reset") return printResults(await resetDevelopmentAuthAccounts(database));
    throw new Error("create または reset を指定してください。");
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "開発用アカウントを処理できませんでした。");
  process.exitCode = 1;
});
