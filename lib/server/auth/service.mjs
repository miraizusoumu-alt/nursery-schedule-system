import { randomUUID } from "node:crypto";
import { AuthError, requirePermission } from "./permissions.mjs";
import {
  PASSWORD_MIN_LENGTH,
  generateFamilyPassword,
  generateLoginId,
  generateSessionSecrets,
  generateTemporaryPassword,
  hashOpaqueValue,
  hashPassword,
  normalizeLoginId,
  validateNewPassword,
  verifyPassword,
} from "./security.mjs";
import { addMinutes, isIsoDate, isStartDateReached, isStopDateEffective, toIso } from "./time.mjs";

export const DEFAULT_AUTH_SETTINGS = Object.freeze({
  loginFailureLimit: 5,
  loginWindowMinutes: 15,
  loginLockMinutes: 15,
  familySessionMinutes: 30 * 24 * 60,
  administratorSessionMinutes: 8 * 60,
  passwordMinimumLength: PASSWORD_MIN_LENGTH,
  secureCookies: false,
});

const SETTING_RULES = Object.freeze({
  loginFailureLimit: (value) => Number.isInteger(value) && value >= 3 && value <= 5,
  loginWindowMinutes: (value) => Number.isInteger(value) && value >= 15 && value <= 60,
  loginLockMinutes: (value) => Number.isInteger(value) && value >= 15 && value <= 120,
  familySessionMinutes: (value) => Number.isInteger(value) && value >= 60 && value <= 30 * 24 * 60,
  administratorSessionMinutes: (value) => Number.isInteger(value) && value >= 15 && value <= 8 * 60,
  passwordMinimumLength: (value) => Number.isInteger(value) && value >= PASSWORD_MIN_LENGTH && value <= 64,
  secureCookies: (value) => typeof value === "boolean",
});

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function requiredText(value, label, maximum = 100) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new AuthError("INVALID_INPUT", `${label}を入力してください。`);
  if (normalized.length > maximum) throw new AuthError("INVALID_INPUT", `${label}が長すぎます。`);
  return normalized;
}

function validLoginId(value) {
  const normalized = normalizeLoginId(value);
  if (!/^[a-z0-9][a-z0-9._-]{3,79}$/.test(normalized)) {
    throw new AuthError("INVALID_LOGIN_ID", "ログインIDは半角英数字・ピリオド・ハイフン・アンダースコアで4〜80文字にしてください。");
  }
  return normalized;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function publicActor(actor) {
  if (!actor) return null;
  return {
    type: actor.type,
    id: actor.id,
    familyId: actor.familyId ?? null,
    role: actor.role ?? null,
    displayName: actor.displayName,
    loginId: actor.loginId,
    mustChangePassword: actor.mustChangePassword,
  };
}

export function createAuthService({ database, now = () => new Date() }) {
  function currentDate() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  function writeOperation({ actor, operation, targetType, targetId = null, detail = null }) {
    database.prepare(
      `INSERT INTO operation_logs
       (id, actor_type, actor_id, operation, target_type, target_id, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      actor?.type ?? "system",
      actor?.id ?? null,
      operation,
      targetType,
      targetId,
      detail === null ? null : safeJson(detail),
      toIso(currentDate()),
    );
  }

  function nextFamilyIdentifiers() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const loginId = generateLoginId("family");
      const familyCode = `FAMILY-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      const exists = database.prepare(
        `SELECT 1 FROM family_accounts WHERE login_id = ?
         UNION ALL SELECT 1 FROM families WHERE family_code = ? LIMIT 1`,
      ).get(loginId, familyCode);
      if (!exists) return { loginId, familyCode };
    }
    throw new AuthError("IDENTIFIER_GENERATION_FAILED", "ログイン情報を発行できませんでした。もう一度お試しください。", 503);
  }

  function childForFamilySetup(childId) {
    const child = database.prepare(
      `SELECT id, name, enrollment_date, withdrawal_date, status
       FROM children WHERE id = ?`,
    ).get(String(childId ?? "").trim());
    if (!child) throw new AuthError("NOT_FOUND", "園児が見つかりません。", 404);
    if (child.status !== "enrolled") {
      throw new AuthError("CHILD_UNAVAILABLE", "在籍中の園児だけ家庭アカウントへ登録できます。", 409);
    }
    return child;
  }

  function familyCredentialChildren(familyId) {
    return database.prepare(
      `SELECT c.name
       FROM family_children fc
       JOIN children c ON c.id = fc.child_id
       WHERE fc.family_id = ?
       ORDER BY fc.sort_order, c.name, c.id`,
    ).all(familyId).map((child) => child.name);
  }

  function getSettings() {
    const result = { ...DEFAULT_AUTH_SETTINGS };
    const rows = database.prepare("SELECT key, value_json FROM auth_settings").all();
    for (const row of rows) {
      if (!(row.key in SETTING_RULES)) continue;
      try {
        const value = JSON.parse(row.value_json);
        if (SETTING_RULES[row.key](value)) result[row.key] = value;
      } catch {
        // Invalid setting rows fail closed by falling back to secure defaults.
      }
    }
    return result;
  }

  function recordLoginAttempt(scope, loginIdHash, sourceHash, success, attemptedAt) {
    database.prepare(
      `INSERT INTO auth_login_attempts
       (id, login_scope, login_id_hash, source_hash, success, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), scope, loginIdHash, sourceHash, success ? 1 : 0, attemptedAt);
  }

  function dimensionIsLimited(rows, key, expected, settings, currentTime) {
    const relevant = rows.filter((row) => row[key] === expected);
    const latestSuccess = relevant
      .filter((row) => row.success === 1)
      .reduce((latest, row) => row.attempted_at > latest ? row.attempted_at : latest, "");
    const failures = relevant.filter((row) => row.success === 0 && row.attempted_at > latestSuccess);
    if (failures.length < settings.loginFailureLimit) return false;
    const latestFailure = failures.reduce((latest, row) => row.attempted_at > latest ? row.attempted_at : latest, "");
    return addMinutes(new Date(latestFailure), settings.loginLockMinutes).getTime() > currentTime.getTime();
  }

  function loginIsLimited(scope, loginIdHash, sourceHash, settings, currentTime) {
    const windowStart = toIso(addMinutes(currentTime, -settings.loginWindowMinutes));
    const rows = database.prepare(
      `SELECT login_id_hash, source_hash, success, attempted_at
       FROM auth_login_attempts
       WHERE login_scope = ? AND attempted_at >= ?
         AND (login_id_hash = ? OR source_hash = ?)
       ORDER BY attempted_at`,
    ).all(scope, windowStart, loginIdHash, sourceHash);
    return dimensionIsLimited(rows, "login_id_hash", loginIdHash, settings, currentTime)
      || dimensionIsLimited(rows, "source_hash", sourceHash, settings, currentTime);
  }

  function invalidateSessions(subjectType, subjectId, reason) {
    const timestamp = toIso(currentDate());
    const column = subjectType === "family" ? "family_account_id" : "administrator_id";
    database.prepare(
      `UPDATE auth_sessions
       SET invalidated_at = ?, invalidation_reason = ?
       WHERE ${column} = ? AND invalidated_at IS NULL`,
    ).run(timestamp, reason, subjectId);
  }

  function familyAccountByLogin(loginId) {
    return database.prepare(
      `SELECT fa.id AS account_id, fa.family_id, fa.login_id, fa.password_hash,
              fa.must_change_password, fa.credential_version, fa.stopped_at,
              f.display_name, f.status AS family_status, f.handed_over_at, f.stop_date
       FROM family_accounts fa
       JOIN families f ON f.id = fa.family_id
       WHERE fa.login_id = ?`,
    ).get(loginId);
  }

  function administratorByLogin(loginId) {
    return database.prepare(
      `SELECT id, login_id, display_name, role, password_hash, must_change_password,
              credential_version, status, stopped_at
       FROM administrators WHERE login_id = ?`,
    ).get(loginId);
  }

  function accountCanLogin(scope, account, currentTime) {
    if (!account?.password_hash) return false;
    if (scope === "family") {
      return account.stopped_at === null
        && account.family_status === "active"
        && isStartDateReached(account.handed_over_at, currentTime)
        && !isStopDateEffective(account.stop_date, currentTime);
    }
    return account.status === "active" && account.stopped_at === null;
  }

  function insertSession(scope, account, settings) {
    const currentTime = currentDate();
    const secrets = generateSessionSecrets();
    const duration = scope === "family" ? settings.familySessionMinutes : settings.administratorSessionMinutes;
    const sessionId = randomUUID();
    database.prepare(
      `INSERT INTO auth_sessions
       (id, subject_type, family_account_id, administrator_id, token_hash, csrf_token_hash,
        credential_version, issued_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      scope,
      scope === "family" ? account.account_id : null,
      scope === "administrator" ? account.id : null,
      secrets.tokenHash,
      secrets.csrfTokenHash,
      account.credential_version,
      toIso(currentTime),
      toIso(addMinutes(currentTime, duration)),
      toIso(currentTime),
    );
    return { sessionId, expiresAt: toIso(addMinutes(currentTime, duration)), ...secrets };
  }

  async function login({ scope, loginId, password, source = "unknown" }) {
    if (scope !== "family" && scope !== "administrator") {
      throw new AuthError("INVALID_SCOPE", "ログイン種別が正しくありません。");
    }
    const normalizedLoginId = normalizeLoginId(loginId);
    const loginIdHash = hashOpaqueValue(`${scope}:${normalizedLoginId}`);
    const sourceHash = hashOpaqueValue(source || "unknown");
    const currentTime = currentDate();
    const attemptedAt = toIso(currentTime);
    const settings = getSettings();

    if (loginIsLimited(scope, loginIdHash, sourceHash, settings, currentTime)) {
      await verifyPassword(password, null);
      throw new AuthError("LOGIN_RESTRICTED", "ログインできません。しばらく時間をおいてから再度お試しください。", 429);
    }

    const account = scope === "family" ? familyAccountByLogin(normalizedLoginId) : administratorByLogin(normalizedLoginId);
    const passwordMatches = await verifyPassword(password, account?.password_hash);
    if (!passwordMatches) {
      recordLoginAttempt(scope, loginIdHash, sourceHash, false, attemptedAt);
      throw new AuthError("INVALID_CREDENTIALS", "ログインIDまたはパスワードを確認してください。", 401);
    }
    if (!accountCanLogin(scope, account, currentTime)) {
      recordLoginAttempt(scope, loginIdHash, sourceHash, false, attemptedAt);
      if (scope === "family") {
        throw new AuthError("ACCOUNT_UNAVAILABLE", "このアカウントは現在利用できません。園へお問い合わせください。", 403);
      }
      throw new AuthError("INVALID_CREDENTIALS", "ログインIDまたはパスワードを確認してください。", 401);
    }

    recordLoginAttempt(scope, loginIdHash, sourceHash, true, attemptedAt);
    const session = insertSession(scope, account, settings);
    if (scope === "family") {
      database.prepare("UPDATE family_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?")
        .run(attemptedAt, attemptedAt, account.account_id);
      writeOperation({ actor: { type: "family", id: account.account_id }, operation: "auth.login", targetType: "family_account", targetId: account.account_id });
    } else {
      database.prepare("UPDATE administrators SET last_login_at = ?, updated_at = ? WHERE id = ?")
        .run(attemptedAt, attemptedAt, account.id);
      writeOperation({ actor: { type: "administrator", id: account.id }, operation: "auth.login", targetType: "administrator", targetId: account.id });
    }
    return {
      actor: scope === "family"
        ? { type: "family", id: account.account_id, familyId: account.family_id, loginId: account.login_id, displayName: account.display_name, mustChangePassword: false }
        : { type: "administrator", id: account.id, role: account.role, loginId: account.login_id, displayName: account.display_name, mustChangePassword: account.must_change_password === 1 },
      session,
      settings,
    };
  }

  function sessionByToken(token, { touch = true } = {}) {
    if (typeof token !== "string" || token.length < 32) return null;
    const tokenHash = hashOpaqueValue(token);
    const row = database.prepare(
      `SELECT s.*,
              fa.family_id, fa.login_id AS family_login_id, fa.must_change_password AS family_must_change,
              fa.credential_version AS family_credential_version, fa.stopped_at AS family_account_stopped_at,
              f.display_name AS family_display_name, f.status AS family_status, f.handed_over_at, f.stop_date,
              a.login_id AS administrator_login_id, a.display_name AS administrator_display_name,
              a.role AS administrator_role, a.must_change_password AS administrator_must_change,
              a.credential_version AS administrator_credential_version,
              a.status AS administrator_status, a.stopped_at AS administrator_stopped_at
       FROM auth_sessions s
       LEFT JOIN family_accounts fa ON fa.id = s.family_account_id
       LEFT JOIN families f ON f.id = fa.family_id
       LEFT JOIN administrators a ON a.id = s.administrator_id
       WHERE s.token_hash = ?`,
    ).get(tokenHash);
    if (!row || row.invalidated_at) return null;

    const currentTime = currentDate();
    let invalidReason = null;
    if (new Date(row.expires_at).getTime() <= currentTime.getTime()) invalidReason = "expired";
    if (row.subject_type === "family") {
      if (row.family_credential_version !== row.credential_version) invalidReason = "credential_changed";
      if (row.family_account_stopped_at || row.family_status !== "active"
        || !isStartDateReached(row.handed_over_at, currentTime) || isStopDateEffective(row.stop_date, currentTime)) invalidReason = "account_stopped";
    } else {
      if (row.administrator_credential_version !== row.credential_version) invalidReason = "credential_changed";
      if (row.administrator_status !== "active" || row.administrator_stopped_at) invalidReason = "account_stopped";
    }
    if (invalidReason) {
      database.prepare("UPDATE auth_sessions SET invalidated_at = ?, invalidation_reason = ? WHERE id = ?")
        .run(toIso(currentTime), invalidReason, row.id);
      return null;
    }

    if (touch) database.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(toIso(currentTime), row.id);
    const actor = row.subject_type === "family"
      ? {
          type: "family",
          id: row.family_account_id,
          familyId: row.family_id,
          loginId: row.family_login_id,
          displayName: row.family_display_name,
          mustChangePassword: false,
        }
      : {
          type: "administrator",
          id: row.administrator_id,
          role: row.administrator_role,
          loginId: row.administrator_login_id,
          displayName: row.administrator_display_name,
          mustChangePassword: row.administrator_must_change === 1,
        };
    return { id: row.id, actor, csrfTokenHash: row.csrf_token_hash, expiresAt: row.expires_at };
  }

  function logout(session) {
    if (!session) return;
    const timestamp = toIso(currentDate());
    database.prepare(
      "UPDATE auth_sessions SET invalidated_at = ?, invalidation_reason = 'logout' WHERE id = ? AND invalidated_at IS NULL",
    ).run(timestamp, session.id);
    writeOperation({ actor: session.actor, operation: "auth.logout", targetType: session.actor.type === "family" ? "family_account" : "administrator", targetId: session.actor.id });
  }

  async function changePassword({ session, currentPassword, newPassword }) {
    if (!session) throw new AuthError("UNAUTHENTICATED", "ログインが必要です。", 401);
    if (session.actor.type === "family") {
      throw new AuthError("PASSWORD_CHANGE_NOT_ALLOWED", "保護者用パスワードの変更は園へお問い合わせください。", 403);
    }
    const settings = getSettings();
    const validation = validateNewPassword(newPassword, settings.passwordMinimumLength);
    if (!validation.ok) throw new AuthError("INVALID_PASSWORD", validation.message);
    const table = "administrators";
    const account = database.prepare(`SELECT password_hash FROM ${table} WHERE id = ?`).get(session.actor.id);
    if (!await verifyPassword(currentPassword, account?.password_hash)) {
      throw new AuthError("CURRENT_PASSWORD_INVALID", "現在のパスワードが正しくありません。", 403);
    }
    const nextHash = await hashPassword(newPassword);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE ${table}
         SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
             credential_version = credential_version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(nextHash, timestamp, timestamp, session.actor.id);
      invalidateSessions("administrator", session.actor.id, "password_changed");
      writeOperation({ actor: session.actor, operation: "account.password_changed", targetType: "administrator", targetId: session.actor.id });
    });
    const refreshedAccount = administratorByLogin(session.actor.loginId);
    const refreshedSession = insertSession("administrator", refreshedAccount, settings);
    return { actor: { ...session.actor, mustChangePassword: false }, session: refreshedSession, settings };
  }

  async function reauthenticateAdministrator(actor, currentPassword) {
    if (!actor || actor.type !== "administrator") throw new AuthError("UNAUTHENTICATED", "管理者ログインが必要です。", 401);
    const account = database.prepare("SELECT password_hash, status, stopped_at FROM administrators WHERE id = ?").get(actor.id);
    if (!account || account.status !== "active" || account.stopped_at || !await verifyPassword(currentPassword, account.password_hash)) {
      throw new AuthError("REAUTHENTICATION_FAILED", "現在のパスワードを再確認できませんでした。", 403);
    }
  }

  async function issueFamilyAccount(actor, input) {
    requirePermission(actor, "family:issue-account");
    const familyCode = requiredText(input.familyCode, "家庭コード", 50).toUpperCase();
    const displayName = requiredText(input.displayName, "家庭表示名", 100);
    const loginId = validLoginId(input.loginId);
    const temporaryPassword = generateFamilyPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const timestamp = toIso(currentDate());
    const familyId = randomUUID();
    const accountId = randomUUID();
    try {
      transaction(database, () => {
        database.prepare(
          `INSERT INTO families
           (id, family_code, display_name, status, issued_at, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        ).run(familyId, familyCode, displayName, timestamp, timestamp, timestamp);
        database.prepare(
          `INSERT INTO family_accounts
           (id, family_id, login_id, password_hash, must_change_password,
            temporary_password_issued_at, credential_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)`,
        ).run(accountId, familyId, loginId, passwordHash, timestamp, timestamp, timestamp);
        writeOperation({ actor, operation: "family_account.issued", targetType: "family_account", targetId: accountId, detail: { familyId, familyCode, loginId, issuedAt: timestamp } });
      });
    } catch (error) {
      if (String(error?.message).includes("UNIQUE")) throw new AuthError("ACCOUNT_EXISTS", "同じ家庭コードまたはログインIDがすでに使用されています。", 409);
      throw error;
    }
    return { familyId, accountId, familyCode, loginId, temporaryPassword, issuedAt: timestamp };
  }

  async function issueFamilyAccountForChild(actor, input) {
    requirePermission(actor, "family:issue-account");
    requirePermission(actor, "child:manage");
    const child = childForFamilySetup(input?.childId);
    const existingMembership = database.prepare("SELECT 1 FROM family_children WHERE child_id = ? LIMIT 1").get(child.id);
    if (existingMembership) {
      throw new AuthError("CHILD_ALREADY_LINKED", "この園児はすでに家庭アカウントへ登録されています。", 409);
    }
    const startDate = String(input?.startDate ?? "").trim();
    if (!isIsoDate(startDate) || !startDate) throw new AuthError("INVALID_DATE", "使用開始日を正しい日付で入力してください。");
    const activeFrom = String(child.enrollment_date ?? "").trim();
    const activeTo = String(child.withdrawal_date ?? "").trim() || null;
    if (!isIsoDate(activeFrom) || !activeFrom) throw new AuthError("INVALID_DATE", "家庭所属の開始日を正しい日付で入力してください。");
    if (!isIsoDate(activeTo)) throw new AuthError("INVALID_DATE", "家庭所属の終了日を正しい日付で入力してください。");
    if ((child.enrollment_date && activeFrom < child.enrollment_date)
      || (child.withdrawal_date && (!activeTo || activeTo > child.withdrawal_date))
      || (activeTo && activeFrom > activeTo)) {
      throw new AuthError("MEMBERSHIP_OUTSIDE_ENROLLMENT", "家庭所属期間は園児の在籍期間内にしてください。", 409);
    }

    const { loginId, familyCode } = nextFamilyIdentifiers();
    const temporaryPassword = generateFamilyPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const timestamp = toIso(currentDate());
    const familyId = randomUUID();
    const accountId = randomUUID();
    transaction(database, () => {
      database.prepare(
        `INSERT INTO families
         (id, family_code, display_name, status, issued_at, handed_over_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(familyId, familyCode, `${child.name}家庭`, timestamp, startDate, timestamp, timestamp);
      database.prepare(
        `INSERT INTO family_accounts
         (id, family_id, login_id, password_hash, must_change_password,
          temporary_password_issued_at, credential_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)`,
      ).run(accountId, familyId, loginId, passwordHash, timestamp, timestamp, timestamp);
      database.prepare(
        `INSERT INTO family_children
         (family_id, child_id, relationship_label, is_primary, sort_order, active_from, active_to, created_at)
         VALUES (?, ?, '保護者', 1, 1, ?, ?, ?)`,
      ).run(familyId, child.id, activeFrom, activeTo, timestamp);
      writeOperation({
        actor,
        operation: "family_account.issued_for_child",
        targetType: "family_account",
        targetId: accountId,
        detail: { familyId, childId: child.id, loginId, startDate, activeFrom, activeTo, issuedAt: timestamp },
      });
    });
    return {
      familyId,
      accountId,
      loginId,
      temporaryPassword,
      issuedAt: timestamp,
      startDate,
      childNames: [child.name],
    };
  }

  function linkChildToFamilyAccount(actor, input) {
    requirePermission(actor, "family:issue-account");
    requirePermission(actor, "child:manage");
    const child = childForFamilySetup(input?.childId);
    const familyId = String(input?.familyId ?? "").trim();
    const family = database.prepare(
      `SELECT f.id, f.display_name
       FROM families f JOIN family_accounts fa ON fa.family_id = f.id
       WHERE f.id = ? AND f.status = 'active'`,
    ).get(familyId);
    if (!family) throw new AuthError("NOT_FOUND", "追加先の家庭アカウントが見つかりません。", 404);
    if (database.prepare("SELECT 1 FROM family_children WHERE child_id = ? LIMIT 1").get(child.id)) {
      throw new AuthError("CHILD_ALREADY_LINKED", "この園児はすでに家庭アカウントへ登録されています。", 409);
    }
    const activeFrom = String(child.enrollment_date ?? "").trim();
    const activeTo = String(child.withdrawal_date ?? "").trim() || null;
    if (!isIsoDate(activeFrom) || !activeFrom) throw new AuthError("INVALID_DATE", "家庭所属の開始日を正しい日付で入力してください。");
    if (!isIsoDate(activeTo)) throw new AuthError("INVALID_DATE", "家庭所属の終了日を正しい日付で入力してください。");
    if ((child.enrollment_date && activeFrom < child.enrollment_date)
      || (child.withdrawal_date && (!activeTo || activeTo > child.withdrawal_date))
      || (activeTo && activeFrom > activeTo)) {
      throw new AuthError("MEMBERSHIP_OUTSIDE_ENROLLMENT", "家庭所属期間は園児の在籍期間内にしてください。", 409);
    }
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      const sortOrder = database.prepare(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM family_children WHERE family_id = ?",
      ).get(familyId).value;
      database.prepare(
        `INSERT INTO family_children
         (family_id, child_id, relationship_label, is_primary, sort_order, active_from, active_to, created_at)
         VALUES (?, ?, '保護者', 1, ?, ?, ?, ?)`,
      ).run(familyId, child.id, sortOrder, activeFrom, activeTo, timestamp);
      writeOperation({
        actor,
        operation: "family_account.child_linked",
        targetType: "child",
        targetId: child.id,
        detail: { familyId, childId: child.id, activeFrom, activeTo, linkedAt: timestamp },
      });
    });
    return { familyId, familyName: family.display_name, childId: child.id, activeFrom, activeTo };
  }

  async function reissueFamilyPassword(actor, familyId) {
    requirePermission(actor, "family:reissue-password");
    const account = database.prepare("SELECT id, login_id FROM family_accounts WHERE family_id = ?").get(familyId);
    if (!account) throw new AuthError("NOT_FOUND", "家庭アカウントが見つかりません。", 404);
    const temporaryPassword = generateFamilyPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE family_accounts
         SET password_hash = ?, must_change_password = 0, temporary_password_issued_at = ?,
             credential_version = credential_version + 1, updated_at = ?
         WHERE id = ?`,
      ).run(passwordHash, timestamp, timestamp, account.id);
      invalidateSessions("family", account.id, "temporary_password_reissued");
      writeOperation({ actor, operation: "family_account.password_reissued", targetType: "family_account", targetId: account.id, detail: { familyId, loginId: account.login_id, reissuedAt: timestamp } });
    });
    const family = database.prepare("SELECT handed_over_at FROM families WHERE id = ?").get(familyId);
    return {
      familyId,
      accountId: account.id,
      loginId: account.login_id,
      temporaryPassword,
      issuedAt: timestamp,
      startDate: family?.handed_over_at ?? null,
      childNames: familyCredentialChildren(familyId),
    };
  }

  function recordFamilyHandover(actor, familyId, handedOverAt) {
    requirePermission(actor, "family:record-handover");
    if (!isIsoDate(handedOverAt) || !handedOverAt) throw new AuthError("INVALID_DATE", "使用開始日を正しい日付で入力してください。");
    const family = database.prepare(
      `SELECT f.handed_over_at, fa.id AS account_id
       FROM families f JOIN family_accounts fa ON fa.family_id = f.id
       WHERE f.id = ?`,
    ).get(familyId);
    if (!family) throw new AuthError("NOT_FOUND", "家庭が見つかりません。", 404);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare("UPDATE families SET handed_over_at = ?, updated_at = ? WHERE id = ?").run(handedOverAt, timestamp, familyId);
      if (!isStartDateReached(handedOverAt, currentDate())) invalidateSessions("family", family.account_id, "account_not_started");
      writeOperation({ actor, operation: "family_account.start_date_changed", targetType: "family", targetId: familyId, detail: { before: family.handed_over_at, after: handedOverAt } });
    });
    return { familyId, handedOverAt };
  }

  function setFamilyStopDate(actor, familyId, stopDate) {
    requirePermission(actor, "family:set-stop-date");
    const normalized = stopDate === "" || stopDate === undefined ? null : stopDate;
    if (!isIsoDate(normalized)) throw new AuthError("INVALID_DATE", "停止日を正しい日付で入力してください。");
    const family = database.prepare(
      `SELECT f.stop_date, fa.id AS account_id
       FROM families f JOIN family_accounts fa ON fa.family_id = f.id WHERE f.id = ?`,
    ).get(familyId);
    if (!family) throw new AuthError("NOT_FOUND", "家庭が見つかりません。", 404);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare("UPDATE families SET stop_date = ?, updated_at = ? WHERE id = ?").run(normalized, timestamp, familyId);
      if (isStopDateEffective(normalized, currentDate())) invalidateSessions("family", family.account_id, "account_stopped");
      writeOperation({ actor, operation: "family_account.stop_date_changed", targetType: "family", targetId: familyId, detail: { before: family.stop_date, after: normalized, timeZone: "Asia/Tokyo" } });
    });
    return { familyId, stopDate: normalized };
  }

  async function issueAdministrator(actor, input) {
    const role = input.role === "master" ? "master" : "normal";
    requirePermission(actor, role === "master" ? "administrator:issue-master" : "administrator:issue-normal");
    if (role === "master") await reauthenticateAdministrator(actor, input.currentPassword);
    const loginId = validLoginId(input.loginId);
    const displayName = requiredText(input.displayName, "管理者表示名", 100);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const timestamp = toIso(currentDate());
    const administratorId = randomUUID();
    try {
      transaction(database, () => {
        database.prepare(
          `INSERT INTO administrators
           (id, login_id, display_name, role, password_hash, must_change_password,
            temporary_password_issued_at, credential_version, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 1, 'active', ?, ?)`,
        ).run(administratorId, loginId, displayName, role, passwordHash, timestamp, timestamp, timestamp);
        writeOperation({ actor, operation: "administrator.issued", targetType: "administrator", targetId: administratorId, detail: { loginId, role, issuedAt: timestamp } });
      });
    } catch (error) {
      if (String(error?.message).includes("UNIQUE")) throw new AuthError("ACCOUNT_EXISTS", "同じ管理者ログインIDがすでに使用されています。", 409);
      throw error;
    }
    return { administratorId, loginId, role, temporaryPassword, issuedAt: timestamp };
  }

  function activeMasterCount() {
    return database.prepare("SELECT COUNT(*) AS count FROM administrators WHERE role = 'master' AND status = 'active' AND stopped_at IS NULL").get().count;
  }

  async function reissueAdministratorPassword(actor, administratorId, currentPassword) {
    requirePermission(actor, "administrator:reissue-password");
    await reauthenticateAdministrator(actor, currentPassword);
    const target = database.prepare("SELECT id, login_id FROM administrators WHERE id = ?").get(administratorId);
    if (!target) throw new AuthError("NOT_FOUND", "管理者アカウントが見つかりません。", 404);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE administrators
         SET password_hash = ?, must_change_password = 1, temporary_password_issued_at = ?,
             credential_version = credential_version + 1, updated_at = ? WHERE id = ?`,
      ).run(passwordHash, timestamp, timestamp, target.id);
      invalidateSessions("administrator", target.id, "temporary_password_reissued");
      writeOperation({ actor, operation: "administrator.password_reissued", targetType: "administrator", targetId: target.id, detail: { loginId: target.login_id, reissuedAt: timestamp } });
    });
    return { administratorId: target.id, loginId: target.login_id, temporaryPassword, issuedAt: timestamp };
  }

  async function stopAdministrator(actor, administratorId, currentPassword) {
    requirePermission(actor, "administrator:stop");
    await reauthenticateAdministrator(actor, currentPassword);
    if (actor.id === administratorId) throw new AuthError("SELF_STOP_FORBIDDEN", "自分自身の管理者アカウントは停止できません。", 409);
    const target = database.prepare("SELECT id, role, status FROM administrators WHERE id = ?").get(administratorId);
    if (!target) throw new AuthError("NOT_FOUND", "管理者アカウントが見つかりません。", 404);
    if (target.role === "master" && target.status === "active" && activeMasterCount() <= 1) {
      throw new AuthError("LAST_MASTER", "最後の有効なマスター管理者は停止できません。", 409);
    }
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE administrators SET status = 'stopped', stopped_at = ?,
         credential_version = credential_version + 1, updated_at = ? WHERE id = ?`,
      ).run(timestamp, timestamp, target.id);
      invalidateSessions("administrator", target.id, "account_stopped");
      writeOperation({ actor, operation: "administrator.stopped", targetType: "administrator", targetId: target.id, detail: { stoppedAt: timestamp } });
    });
    return { administratorId: target.id, stoppedAt: timestamp };
  }

  async function changeAdministratorRole(actor, administratorId, role, currentPassword) {
    requirePermission(actor, "administrator:change-role");
    await reauthenticateAdministrator(actor, currentPassword);
    if (role !== "normal" && role !== "master") throw new AuthError("INVALID_ROLE", "管理者権限が正しくありません。");
    const target = database.prepare("SELECT id, role, status FROM administrators WHERE id = ?").get(administratorId);
    if (!target) throw new AuthError("NOT_FOUND", "管理者アカウントが見つかりません。", 404);
    if (target.role === role) return { administratorId, role };
    if (target.role === "master" && role === "normal" && target.status === "active" && activeMasterCount() <= 1) {
      throw new AuthError("LAST_MASTER", "最後の有効なマスター管理者は降格できません。", 409);
    }
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        "UPDATE administrators SET role = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?",
      ).run(role, timestamp, target.id);
      invalidateSessions("administrator", target.id, "role_changed");
      writeOperation({ actor, operation: "administrator.role_changed", targetType: "administrator", targetId: target.id, detail: { before: target.role, after: role } });
    });
    return { administratorId: target.id, role };
  }

  async function updateAuthSettings(actor, updates, currentPassword, { isHttps = false } = {}) {
    requirePermission(actor, "auth-settings:manage");
    await reauthenticateAdministrator(actor, currentPassword);
    const before = getSettings();
    const nextEntries = Object.entries(updates ?? {});
    if (!nextEntries.length) throw new AuthError("INVALID_SETTINGS", "変更する認証設定がありません。");
    for (const [key, value] of nextEntries) {
      if (!SETTING_RULES[key] || !SETTING_RULES[key](value)) throw new AuthError("INVALID_SETTINGS", `認証設定 ${key} の値が安全な範囲ではありません。`);
      if (key === "secureCookies" && value === true && !isHttps) {
        throw new AuthError("HTTPS_REQUIRED", "Secure CookieはHTTPS接続時だけ有効化できます。", 409);
      }
    }
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      const statement = database.prepare(
        `INSERT INTO auth_settings (key, value_json, updated_by_administrator_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
           updated_by_administrator_id = excluded.updated_by_administrator_id, updated_at = excluded.updated_at`,
      );
      for (const [key, value] of nextEntries) statement.run(key, safeJson(value), actor.id, timestamp);
      writeOperation({ actor, operation: "auth_settings.changed", targetType: "auth_settings", detail: { before: Object.fromEntries(nextEntries.map(([key]) => [key, before[key]])), after: Object.fromEntries(nextEntries) } });
    });
    return getSettings();
  }

  function getFamilySummary(actor, requestedFamilyId = null) {
    if (!actor) throw new AuthError("UNAUTHENTICATED", "ログインが必要です。", 401);
    const familyId = requestedFamilyId ?? actor.familyId;
    if (actor.type === "family" && familyId !== actor.familyId) {
      throw new AuthError("FAMILY_SCOPE_VIOLATION", "他の家庭の情報にはアクセスできません。", 403);
    }
    if (actor.type === "administrator") requirePermission(actor, "administrator:list");
    const family = database.prepare(
      `SELECT f.id, f.family_code, f.display_name, f.issued_at, f.handed_over_at, f.stop_date,
              fa.id AS account_id, fa.login_id, fa.must_change_password, fa.last_login_at
       FROM families f JOIN family_accounts fa ON fa.family_id = f.id WHERE f.id = ?`,
    ).get(familyId);
    if (!family) throw new AuthError("NOT_FOUND", "家庭が見つかりません。", 404);
    const children = database.prepare(
      `SELECT c.id, c.child_code, c.name, c.class_name
       FROM children c JOIN family_children fc ON fc.child_id = c.id
       WHERE fc.family_id = ? ORDER BY fc.sort_order, c.name`,
    ).all(familyId);
    return { family, children };
  }

  function listAccounts(actor) {
    requirePermission(actor, "administrator:list");
    const families = database.prepare(
      `SELECT f.id, f.family_code, f.display_name, f.issued_at, f.handed_over_at, f.stop_date,
              fa.id AS account_id, fa.login_id, fa.must_change_password, fa.last_login_at
       FROM families f JOIN family_accounts fa ON fa.family_id = f.id
       ORDER BY f.family_code`,
    ).all();
    const administrators = database.prepare(
      `SELECT id, login_id, display_name, role, status, must_change_password,
              temporary_password_issued_at, last_login_at, created_at, stopped_at
       FROM administrators ORDER BY role DESC, login_id`,
    ).all();
    return { families, administrators, settings: getSettings() };
  }

  function listOperationLogs(actor, limit = 100) {
    requirePermission(actor, "operation-log:read");
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    return database.prepare(
      `SELECT id, actor_type, actor_id, operation, target_type, target_id, detail_json, occurred_at
       FROM operation_logs ORDER BY occurred_at DESC LIMIT ?`,
    ).all(safeLimit);
  }

  return {
    changeAdministratorRole,
    changePassword,
    getFamilySummary,
    getSettings,
    issueAdministrator,
    issueFamilyAccount,
    issueFamilyAccountForChild,
    linkChildToFamilyAccount,
    listAccounts,
    listOperationLogs,
    login,
    logout,
    publicActor,
    reissueAdministratorPassword,
    reissueFamilyPassword,
    recordFamilyHandover,
    sessionByToken,
    setFamilyStopDate,
    stopAdministrator,
    updateAuthSettings,
  };
}
