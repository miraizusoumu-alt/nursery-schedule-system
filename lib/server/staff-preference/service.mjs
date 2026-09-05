import { createHash, randomUUID } from "node:crypto";
import { AuthError, requirePermission } from "../auth/permissions.mjs";
import { toIso } from "../auth/time.mjs";
import { validateScheduleTimeRange } from "../staffing/scheduled-work.mjs";

const PERIOD_STATUSES = new Set(["draft", "open", "closed"]);
const PREFERENCE_TYPES = new Set(["day_off", "work_time"]);

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

function requiredTargetMonth(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw new AuthError("INVALID_TARGET_MONTH", "対象月はYYYY-MM形式で指定してください。");
  }
  const month = Number(normalized.slice(5));
  if (month < 1 || month > 12) throw new AuthError("INVALID_TARGET_MONTH", "対象月が正しくありません。");
  return normalized;
}

function monthBounds(targetMonth) {
  const [year, month] = targetMonth.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${targetMonth}-01`,
    endDate: `${targetMonth}-${String(dayCount).padStart(2, "0")}`,
    dayCount,
  };
}

function requiredMonthDate(value, targetMonth) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !normalized.startsWith(`${targetMonth}-`)) {
    throw new AuthError("DATE_OUTSIDE_TARGET_MONTH", "対象月の日付を指定してください。");
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new AuthError("INVALID_DATE", "実在する日付を指定してください。");
  }
  return normalized;
}

function requiredRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new AuthError("INVALID_REVISION", "画面を読み直してから操作してください。", 409);
  }
  return revision;
}

function requiredPreferencesHash(value) {
  const hash = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new AuthError(
      "STAFF_PREFERENCE_HASH_REQUIRED",
      "画面を読み直してから操作してください。",
      409,
    );
  }
  return hash;
}

function preferenceConflict() {
  return new AuthError(
    "STAFF_PREFERENCE_REVISION_CONFLICT",
    "管理者または別の画面で希望が更新されています。読み直してください。",
    409,
  );
}

function normalizePreferences(entries, targetMonth) {
  if (!Array.isArray(entries)) throw new AuthError("INVALID_STAFF_PREFERENCES", "希望内容を確認してください。");
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const date = requiredMonthDate(entry?.date, targetMonth);
    if (seen.has(date)) throw new AuthError("DUPLICATE_STAFF_PREFERENCE", "同じ日付の希望が重複しています。");
    seen.add(date);
    const preferenceType = String(entry?.preferenceType ?? "none");
    if (preferenceType === "none") continue;
    if (!PREFERENCE_TYPES.has(preferenceType)) throw new AuthError("INVALID_STAFF_PREFERENCE", "希望内容が正しくありません。");
    let startTime = null;
    let endTime = null;
    if (preferenceType === "work_time") {
      try {
        ({ startTime, endTime } = validateScheduleTimeRange(entry?.startTime, entry?.endTime));
      } catch (error) {
        throw new AuthError(error.code ?? "INVALID_STAFF_PREFERENCE", error.message, 400);
      }
    }
    normalized.push({ date, preferenceType, startTime, endTime });
  }
  return normalized.sort((left, right) => left.date.localeCompare(right.date));
}

function canonicalPreferenceHash(database, staffId, targetMonth) {
  const { startDate, endDate } = monthBounds(targetMonth);
  const rows = database.prepare(
    `SELECT date, preference_type, start_time, end_time, updated_at
     FROM staff_schedule_preferences
     WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`,
  ).all(staffId, startDate, endDate);
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

function publicPeriod(period, now) {
  if (!period) return null;
  const deadlineAt = new Date(period.deadline_at);
  return {
    id: period.id,
    targetMonth: period.target_month,
    deadlineAt: period.deadline_at,
    status: period.status,
    writable: period.status === "open" && Number.isFinite(deadlineAt.getTime()) && now.getTime() <= deadlineAt.getTime(),
  };
}

export function createStaffPreferenceService({ database, now = () => new Date() }) {
  function currentDate() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  function timestamp() {
    return toIso(currentDate());
  }

  function writeOperation(actor, operation, targetType, targetId, targetMonth, detail) {
    database.prepare(
      `INSERT INTO operation_logs
       (id, actor_type, actor_id, operation, target_type, target_id, target_month, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), actor.type, actor.id, operation, targetType, targetId, targetMonth, JSON.stringify(detail ?? {}), timestamp());
  }

  function periodForMonth(targetMonth) {
    return database.prepare(
      `SELECT id, target_month, deadline_at, status, created_by_administrator_id, created_at, updated_at
       FROM staff_preference_submission_periods WHERE target_month = ?`,
    ).get(targetMonth) ?? null;
  }

  function requireWritablePeriod(targetMonth) {
    const period = periodForMonth(targetMonth);
    if (!period) throw new AuthError("STAFF_PREFERENCE_PERIOD_NOT_FOUND", "この月の職員希望提出期間は設定されていません。", 404);
    if (period.status !== "open") throw new AuthError("STAFF_PREFERENCE_PERIOD_CLOSED", "この月の職員希望は現在提出できません。", 409);
    const deadline = new Date(period.deadline_at);
    if (!Number.isFinite(deadline.getTime()) || currentDate().getTime() > deadline.getTime()) {
      throw new AuthError("STAFF_PREFERENCE_DEADLINE_PASSED", "職員希望の提出期限を過ぎています。", 409);
    }
    return period;
  }

  function requireStaffActor(actor, permission) {
    requirePermission(actor, permission);
    if (actor.type !== "staff" || !actor.staffId) throw new AuthError("FORBIDDEN", "職員本人だけが利用できます。", 403);
    return actor.staffId;
  }

  function submissionFor(periodId, staffId) {
    return database.prepare(
      `SELECT id, submission_period_id, staff_id, status, revision, base_preferences_hash,
              submitted_at, created_at, updated_at
       FROM staff_preference_submissions WHERE submission_period_id = ? AND staff_id = ?`,
    ).get(periodId, staffId) ?? null;
  }

  function preferenceRows(table, idColumn, id) {
    return database.prepare(
      `SELECT date, preference_type, start_time, end_time
       FROM ${table} WHERE ${idColumn} = ? ORDER BY date, id`,
    ).all(id).map((entry) => ({
      date: entry.date,
      preferenceType: entry.preference_type,
      startTime: entry.start_time,
      endTime: entry.end_time,
    }));
  }

  function canonicalPreferences(staffId, targetMonth) {
    const { startDate, endDate } = monthBounds(targetMonth);
    return database.prepare(
      `SELECT date, preference_type, start_time, end_time
       FROM staff_schedule_preferences
       WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`,
    ).all(staffId, startDate, endDate).map((entry) => ({
      date: entry.date,
      preferenceType: entry.preference_type,
      startTime: entry.start_time,
      endTime: entry.end_time,
    }));
  }

  function ownDashboard(actor, input = {}) {
    const staffId = requireStaffActor(actor, "staff-preference:read-own");
    const periods = database.prepare(
      `SELECT id, target_month, deadline_at, status, created_by_administrator_id, created_at, updated_at
       FROM staff_preference_submission_periods ORDER BY target_month DESC`,
    ).all();
    const requestedMonth = input.targetMonth ? requiredTargetMonth(input.targetMonth) : null;
    const selected = requestedMonth
      ? periods.find((period) => period.target_month === requestedMonth) ?? null
      : periods.find((period) => publicPeriod(period, currentDate()).writable) ?? periods[0] ?? null;
    const period = publicPeriod(selected, currentDate());
    if (!selected) return {
      actor: { staffId, displayName: actor.displayName },
      periods: [],
      period: null,
      submission: null,
      preferences: [],
      officialPreferencesHash: null,
    };
    const submission = submissionFor(selected.id, staffId);
    const officialPreferencesHash = canonicalPreferenceHash(database, staffId, selected.target_month);
    const hasConflict = submission?.status === "draft"
      && submission.base_preferences_hash !== officialPreferencesHash;
    const preferences = submission
      ? preferenceRows("staff_preference_draft_days", "submission_id", submission.id)
      : canonicalPreferences(staffId, selected.target_month);
    return {
      actor: { staffId, displayName: actor.displayName },
      periods: periods.map((entry) => publicPeriod(entry, currentDate())),
      period,
      submission: submission ? {
        id: submission.id,
        status: submission.status,
        revision: submission.revision,
        submittedAt: submission.submitted_at,
        basePreferencesHash: submission.base_preferences_hash,
        hasConflict,
      } : {
        id: null,
        status: "unentered",
        revision: 0,
        submittedAt: null,
        basePreferencesHash: officialPreferencesHash,
        hasConflict: false,
      },
      preferences,
      officialPreferencesHash,
      dayCount: monthBounds(selected.target_month).dayCount,
    };
  }

  function saveOwnDraft(actor, input = {}) {
    const staffId = requireStaffActor(actor, "staff-preference:write-own");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const expectedRevision = requiredRevision(input.revision);
    const expectedOfficialPreferencesHash = requiredPreferencesHash(input.expectedOfficialPreferencesHash);
    const preferences = normalizePreferences(input.preferences, targetMonth);
    return transaction(database, () => {
      const period = requireWritablePeriod(targetMonth);
      const currentHash = canonicalPreferenceHash(database, staffId, targetMonth);
      if (expectedOfficialPreferencesHash !== currentHash) throw preferenceConflict();
      let submission = submissionFor(period.id, staffId);
      if (submission?.status === "submitted") {
        throw new AuthError("STAFF_PREFERENCE_ALREADY_SUBMITTED", "提出済みの希望は職員本人から変更できません。管理者へご連絡ください。", 409);
      }
      if (!submission) {
        if (expectedRevision !== 0) throw preferenceConflict();
        const submissionId = randomUUID();
        const occurredAt = timestamp();
        database.prepare(
          `INSERT INTO staff_preference_submissions
           (id, submission_period_id, staff_id, status, revision, base_preferences_hash,
            submitted_at, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', 1, ?, NULL, ?, ?)`,
        ).run(submissionId, period.id, staffId, expectedOfficialPreferencesHash, occurredAt, occurredAt);
        submission = submissionFor(period.id, staffId);
      } else {
        if (submission.revision !== expectedRevision || submission.base_preferences_hash !== currentHash) {
          throw preferenceConflict();
        }
        database.prepare(
          "UPDATE staff_preference_submissions SET revision = revision + 1, updated_at = ? WHERE id = ?",
        ).run(timestamp(), submission.id);
        submission = submissionFor(period.id, staffId);
      }
      database.prepare("DELETE FROM staff_preference_draft_days WHERE submission_id = ?").run(submission.id);
      const occurredAt = timestamp();
      const insert = database.prepare(
        `INSERT INTO staff_preference_draft_days
         (id, submission_id, date, preference_type, start_time, end_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const preference of preferences) {
        insert.run(randomUUID(), submission.id, preference.date, preference.preferenceType, preference.startTime, preference.endTime, occurredAt, occurredAt);
      }
      writeOperation(actor, "staff_preference.draft_saved", "staff_preference_submission", submission.id, targetMonth, {
        revision: submission.revision,
        preferenceCount: preferences.length,
      });
      return ownDashboard(actor, { targetMonth });
    });
  }

  function submitOwnDraft(actor, input = {}) {
    const staffId = requireStaffActor(actor, "staff-preference:submit-own");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const expectedRevision = requiredRevision(input.revision);
    const expectedOfficialPreferencesHash = requiredPreferencesHash(input.expectedOfficialPreferencesHash);
    return transaction(database, () => {
      const period = requireWritablePeriod(targetMonth);
      const submission = submissionFor(period.id, staffId);
      if (!submission) throw new AuthError("STAFF_PREFERENCE_DRAFT_REQUIRED", "先に希望内容を保存してください。", 409);
      if (submission.status === "submitted") {
        throw new AuthError("STAFF_PREFERENCE_ALREADY_SUBMITTED", "この月の希望は提出済みです。", 409);
      }
      const currentHash = canonicalPreferenceHash(database, staffId, targetMonth);
      if (submission.revision !== expectedRevision
        || expectedOfficialPreferencesHash !== currentHash
        || submission.base_preferences_hash !== currentHash) throw preferenceConflict();
      const preferences = normalizePreferences(
        preferenceRows("staff_preference_draft_days", "submission_id", submission.id),
        targetMonth,
      );
      const { startDate, endDate } = monthBounds(targetMonth);
      const existing = database.prepare(
        `SELECT id, date FROM staff_schedule_preferences
         WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`,
      ).all(staffId, startDate, endDate);
      const existingByDate = new Map(existing.map((entry) => [entry.date, entry]));
      const submittedDates = new Set(preferences.map((preference) => preference.date));
      const occurredAt = timestamp();
      for (const row of existing) {
        if (!submittedDates.has(row.date)) database.prepare("DELETE FROM staff_schedule_preferences WHERE id = ?").run(row.id);
      }
      const update = database.prepare(
        `UPDATE staff_schedule_preferences
         SET preference_type = ?, start_time = ?, end_time = ?,
             updated_by_administrator_id = NULL, updated_by_staff_account_id = ?, updated_at = ?
         WHERE id = ?`,
      );
      const insert = database.prepare(
        `INSERT INTO staff_schedule_preferences
         (id, staff_id, date, preference_type, start_time, end_time,
          created_by_administrator_id, updated_by_administrator_id,
          created_by_staff_account_id, updated_by_staff_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      );
      for (const preference of preferences) {
        const previous = existingByDate.get(preference.date);
        if (previous) {
          update.run(preference.preferenceType, preference.startTime, preference.endTime, actor.id, occurredAt, previous.id);
        } else {
          insert.run(randomUUID(), staffId, preference.date, preference.preferenceType, preference.startTime, preference.endTime, actor.id, actor.id, occurredAt, occurredAt);
        }
      }
      database.prepare(
        `UPDATE staff_preference_submissions
         SET status = 'submitted', revision = revision + 1, submitted_at = ?, updated_at = ? WHERE id = ?`,
      ).run(occurredAt, occurredAt, submission.id);
      writeOperation(actor, "staff_preference.submitted", "staff_preference_submission", submission.id, targetMonth, {
        revision: submission.revision + 1,
        preferenceCount: preferences.length,
        submittedAt: occurredAt,
      });
      return ownDashboard(actor, { targetMonth });
    });
  }

  function resetOwnDraft(actor, input = {}) {
    const staffId = requireStaffActor(actor, "staff-preference:write-own");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const expectedRevision = requiredRevision(input.revision);
    const expectedOfficialPreferencesHash = requiredPreferencesHash(input.expectedOfficialPreferencesHash);
    return transaction(database, () => {
      const period = requireWritablePeriod(targetMonth);
      const submission = submissionFor(period.id, staffId);
      if (!submission) throw new AuthError("STAFF_PREFERENCE_DRAFT_REQUIRED", "読み込み直す下書きがありません。", 409);
      if (submission.status === "submitted") {
        throw new AuthError("STAFF_PREFERENCE_ALREADY_SUBMITTED", "提出済みの希望は職員本人から変更できません。管理者へご連絡ください。", 409);
      }
      const currentHash = canonicalPreferenceHash(database, staffId, targetMonth);
      if (submission.revision !== expectedRevision || expectedOfficialPreferencesHash !== currentHash) {
        throw preferenceConflict();
      }

      const officialPreferences = canonicalPreferences(staffId, targetMonth);
      database.prepare("DELETE FROM staff_preference_draft_days WHERE submission_id = ?").run(submission.id);
      const occurredAt = timestamp();
      const insert = database.prepare(
        `INSERT INTO staff_preference_draft_days
         (id, submission_id, date, preference_type, start_time, end_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const preference of officialPreferences) {
        insert.run(randomUUID(), submission.id, preference.date, preference.preferenceType, preference.startTime, preference.endTime, occurredAt, occurredAt);
      }
      database.prepare(
        `UPDATE staff_preference_submissions
         SET revision = revision + 1, base_preferences_hash = ?, updated_at = ? WHERE id = ?`,
      ).run(currentHash, occurredAt, submission.id);
      writeOperation(actor, "staff_preference.draft_reset_to_official", "staff_preference_submission", submission.id, targetMonth, {
        revision: submission.revision + 1,
        preferenceCount: officialPreferences.length,
      });
      return ownDashboard(actor, { targetMonth });
    });
  }

  function administratorOverview(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const period = periodForMonth(targetMonth);
    const { startDate, endDate } = monthBounds(targetMonth);
    const staff = database.prepare(
      `SELECT id, staff_code, name FROM staff_members
       WHERE employment_start_date <= ? AND (employment_end_date IS NULL OR employment_end_date >= ?)
       ORDER BY staff_code, id`,
    ).all(endDate, startDate);
    return {
      period: publicPeriod(period, currentDate()),
      staff: staff.map((entry) => {
        const submission = period ? submissionFor(period.id, entry.id) : null;
        let counts;
        if (submission?.status === "draft") {
          counts = database.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN preference_type = 'day_off' THEN 1 ELSE 0 END) AS day_off_count,
                    SUM(CASE WHEN preference_type = 'work_time' THEN 1 ELSE 0 END) AS work_time_count
             FROM staff_preference_draft_days WHERE submission_id = ?`,
          ).get(submission.id);
        } else {
          counts = database.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN preference_type = 'day_off' THEN 1 ELSE 0 END) AS day_off_count,
                    SUM(CASE WHEN preference_type = 'work_time' THEN 1 ELSE 0 END) AS work_time_count
             FROM staff_schedule_preferences WHERE staff_id = ? AND date BETWEEN ? AND ?`,
          ).get(entry.id, startDate, endDate);
        }
        const administratorInput = database.prepare(
          `SELECT 1 FROM staff_schedule_preferences
           WHERE staff_id = ? AND date BETWEEN ? AND ?
             AND (created_by_administrator_id IS NOT NULL OR updated_by_administrator_id IS NOT NULL)
           LIMIT 1`,
        ).get(entry.id, startDate, endDate) !== undefined;
        return {
          id: entry.id,
          staffCode: entry.staff_code,
          name: entry.name,
          submissionStatus: submission?.status ?? "unentered",
          submittedAt: submission?.submitted_at ?? null,
          revision: submission?.revision ?? 0,
          dayOffCount: Number(counts?.day_off_count ?? 0),
          hasWorkTimePreference: Number(counts?.work_time_count ?? 0) > 0,
          administratorInput,
        };
      }),
    };
  }

  function savePeriod(actor, input = {}) {
    requirePermission(actor, "staff-preference-period:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const status = String(input.status ?? "");
    if (!PERIOD_STATUSES.has(status)) throw new AuthError("INVALID_STATUS", "提出期間の状態を確認してください。");
    const deadline = new Date(String(input.deadlineAt ?? ""));
    if (!Number.isFinite(deadline.getTime())) throw new AuthError("INVALID_DEADLINE", "提出期限を正しい日時で入力してください。");
    const deadlineAt = deadline.toISOString();
    const occurredAt = timestamp();
    transaction(database, () => {
      const existing = periodForMonth(targetMonth);
      if (existing) {
        database.prepare(
          `UPDATE staff_preference_submission_periods
           SET deadline_at = ?, status = ?, updated_at = ? WHERE id = ?`,
        ).run(deadlineAt, status, occurredAt, existing.id);
        writeOperation(actor, "staff_preference_period.updated", "staff_preference_submission_period", existing.id, targetMonth, { deadlineAt, status });
      } else {
        const periodId = randomUUID();
        database.prepare(
          `INSERT INTO staff_preference_submission_periods
           (id, target_month, deadline_at, status, created_by_administrator_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(periodId, targetMonth, deadlineAt, status, actor.id, occurredAt, occurredAt);
        writeOperation(actor, "staff_preference_period.created", "staff_preference_submission_period", periodId, targetMonth, { deadlineAt, status });
      }
    });
    return administratorOverview(actor, { targetMonth });
  }

  return {
    administratorOverview,
    ownDashboard,
    resetOwnDraft,
    saveOwnDraft,
    savePeriod,
    submitOwnDraft,
  };
}
