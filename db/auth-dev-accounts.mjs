import { randomBytes, randomUUID } from "node:crypto";
import { generateFamilyPassword, generateLoginId, generateTemporaryPassword, hashPassword } from "../lib/server/auth/security.mjs";

const DEVELOPMENT_LABELS = Object.freeze({
  family: "架空 認証テスト家庭",
  normal: "架空 通常管理者",
  master: "架空 マスター管理者",
});

function operation(database, operationName, targetType, targetId, detail, timestamp) {
  database.prepare(
    `INSERT INTO operation_logs
     (id, actor_type, operation, target_type, target_id, detail_json, occurred_at)
     VALUES (?, 'system', ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), operationName, targetType, targetId, JSON.stringify(detail), timestamp);
}

async function createFamilyAccount(database, timestamp) {
  const existing = database.prepare(
    `SELECT fa.id AS account_id, fa.login_id, fa.password_hash
     FROM family_accounts fa JOIN families f ON f.id = fa.family_id WHERE f.display_name = ?`,
  ).get(DEVELOPMENT_LABELS.family);
  if (existing?.password_hash) return { type: "family", created: false, loginId: existing.login_id };

  const temporaryPassword = generateFamilyPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  if (existing) {
    database.prepare(
      `UPDATE family_accounts SET password_hash = ?, must_change_password = 0,
       temporary_password_issued_at = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?`,
    ).run(passwordHash, timestamp, timestamp, existing.account_id);
    operation(database, "development_account.initialized", "family_account", existing.account_id, { loginId: existing.login_id }, timestamp);
    return { type: "family", created: true, loginId: existing.login_id, temporaryPassword };
  }

  const familyId = randomUUID();
  const accountId = randomUUID();
  const loginId = generateLoginId("demo-family");
  const familyCode = `DEMO-AUTH-${randomBytes(4).toString("hex").toUpperCase()}`;
  database.prepare(
    `INSERT INTO families (id, family_code, display_name, status, issued_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  ).run(familyId, familyCode, DEVELOPMENT_LABELS.family, timestamp, timestamp, timestamp);
  database.prepare(
    `INSERT INTO family_accounts
     (id, family_id, login_id, password_hash, must_change_password, temporary_password_issued_at,
      credential_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)`,
  ).run(accountId, familyId, loginId, passwordHash, timestamp, timestamp, timestamp);
  operation(database, "development_account.created", "family_account", accountId, { familyId, familyCode, loginId }, timestamp);
  return { type: "family", created: true, loginId, temporaryPassword };
}

async function createAdministrator(database, role, displayName, timestamp) {
  const existing = database.prepare("SELECT id, login_id, password_hash FROM administrators WHERE display_name = ?").get(displayName);
  if (existing?.password_hash) return { type: role, created: false, loginId: existing.login_id };
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  if (existing) {
    database.prepare(
      `UPDATE administrators SET password_hash = ?, must_change_password = 0,
       temporary_password_issued_at = ?, credential_version = credential_version + 1,
       status = 'active', stopped_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(passwordHash, timestamp, timestamp, existing.id);
    operation(database, "development_account.initialized", "administrator", existing.id, { loginId: existing.login_id, role }, timestamp);
    return { type: role, created: true, loginId: existing.login_id, temporaryPassword };
  }
  const administratorId = randomUUID();
  const loginId = generateLoginId(role === "master" ? "demo-master" : "demo-admin");
  database.prepare(
    `INSERT INTO administrators
     (id, login_id, display_name, role, password_hash, must_change_password,
      temporary_password_issued_at, credential_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, 'active', ?, ?)`,
  ).run(administratorId, loginId, displayName, role, passwordHash, timestamp, timestamp, timestamp);
  operation(database, "development_account.created", "administrator", administratorId, { loginId, role }, timestamp);
  return { type: role, created: true, loginId, temporaryPassword };
}

export async function createDevelopmentAuthAccounts(database, currentTime = new Date()) {
  const timestamp = currentTime.toISOString();
  return [
    await createFamilyAccount(database, timestamp),
    await createAdministrator(database, "normal", DEVELOPMENT_LABELS.normal, timestamp),
    await createAdministrator(database, "master", DEVELOPMENT_LABELS.master, timestamp),
  ];
}

export async function resetDevelopmentAuthAccounts(database, currentTime = new Date()) {
  const timestamp = currentTime.toISOString();
  const targets = [
    { type: "family", table: "family_accounts", row: database.prepare(`SELECT fa.id, fa.login_id FROM family_accounts fa JOIN families f ON f.id = fa.family_id WHERE f.display_name = ?`).get(DEVELOPMENT_LABELS.family) },
    { type: "normal", table: "administrators", row: database.prepare("SELECT id, login_id FROM administrators WHERE display_name = ?").get(DEVELOPMENT_LABELS.normal) },
    { type: "master", table: "administrators", row: database.prepare("SELECT id, login_id FROM administrators WHERE display_name = ?").get(DEVELOPMENT_LABELS.master) },
  ];
  if (targets.some((target) => !target.row)) throw new Error("開発用アカウントが揃っていません。先に npm run auth:dev-accounts を実行してください。");
  const results = [];
  for (const target of targets) {
    const temporaryPassword = target.table === "family_accounts"
      ? generateFamilyPassword()
      : generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    if (target.table === "family_accounts") {
      database.prepare(
        `UPDATE family_accounts SET password_hash = ?, must_change_password = 0,
         temporary_password_issued_at = ?, credential_version = credential_version + 1,
         stopped_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(passwordHash, timestamp, timestamp, target.row.id);
      database.prepare("UPDATE auth_sessions SET invalidated_at = ?, invalidation_reason = 'development_reset' WHERE family_account_id = ? AND invalidated_at IS NULL").run(timestamp, target.row.id);
    } else {
      database.prepare(
        `UPDATE administrators SET password_hash = ?, must_change_password = 0,
         temporary_password_issued_at = ?, credential_version = credential_version + 1,
         status = 'active', stopped_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(passwordHash, timestamp, timestamp, target.row.id);
      database.prepare("UPDATE auth_sessions SET invalidated_at = ?, invalidation_reason = 'development_reset' WHERE administrator_id = ? AND invalidated_at IS NULL").run(timestamp, target.row.id);
    }
    operation(database, "development_account.reset", target.table === "family_accounts" ? "family_account" : "administrator", target.row.id, { loginId: target.row.login_id, role: target.type }, timestamp);
    results.push({ type: target.type, created: false, reset: true, loginId: target.row.login_id, temporaryPassword });
  }
  return results;
}
