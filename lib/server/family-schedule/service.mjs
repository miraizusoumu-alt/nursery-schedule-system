import { randomUUID } from "node:crypto";
import { AuthError, requirePermission } from "../auth/permissions.mjs";
import { isStopDateEffective, toIso } from "../auth/time.mjs";

const TOKYO_OFFSET_MINUTES = 9 * 60;
const VALID_USAGE_STATUSES = new Set(["using", "off"]);
const LOCKED_USAGE_STATUSES = new Set(["closed", "not_enrolled"]);

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

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function monthBounds(targetMonth) {
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) throw new AuthError("INVALID_PERIOD", "提出対象月が正しくありません。", 409);
  const [year, month] = targetMonth.split("-").map(Number);
  const first = `${targetMonth}-01`;
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first, last: `${targetMonth}-${pad(lastDate)}` };
}

function datesForMonth(targetMonth) {
  const [year, month] = targetMonth.split("-").map(Number);
  const dates = [];
  for (let day = 1; day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); day += 1) {
    dates.push(`${targetMonth}-${pad(day)}`);
  }
  return dates;
}

function weekdayNumber(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

function tokyoDeadlineInstant(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0", millisecond = "0"] = match;
  return new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute) - TOKYO_OFFSET_MINUTES,
    Number(second),
    Number(millisecond.padEnd(3, "0")),
  ));
}

function assertFamilyActor(actor) {
  if (!actor || actor.type !== "family" || !actor.familyId) {
    throw new AuthError("FORBIDDEN", "保護者画面を利用する権限がありません。", 403);
  }
}

function assertSubmissionAccess(access) {
  if (!access.editable || !access.submittable) {
    throw new AuthError("SUBMISSION_LOCKED", "提出期限を過ぎたため編集できません。変更が必要な場合は園へご連絡ください。", 409);
  }
}

function timeToMinutes(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || minutes % 5 !== 0) return null;
  return hours * 60 + minutes;
}

function validateTimePair(arrivalTime, departureTime) {
  const arrivalMinutes = timeToMinutes(arrivalTime);
  const departureMinutes = timeToMinutes(departureTime);
  if (arrivalMinutes === null || departureMinutes === null) {
    throw new AuthError("INVALID_TIME", "時刻はHH:mm形式の5分単位で入力してください。");
  }
  if (arrivalMinutes >= departureMinutes) {
    throw new AuthError("INVALID_TIME_RANGE", "登園時刻は降園時刻より前にしてください。");
  }
}

function normalizeRequestedDay(day, existing, targetMonth) {
  const date = String(day?.date ?? "");
  if (!date.startsWith(`${targetMonth}-`)) throw new AuthError("INVALID_DATE", "対象月以外の日付は変更できません。");
  if (!existing || existing.date !== date) throw new AuthError("INVALID_DATE", "変更対象の日付が見つかりません。");

  if (LOCKED_USAGE_STATUSES.has(existing.usage_status)) {
    const requestedStatus = day?.usageStatus ?? day?.usage_status ?? existing.usage_status;
    if (requestedStatus !== existing.usage_status) {
      throw new AuthError("LOCKED_DAY", "休園日または在園期間外の日付は変更できません。", 409);
    }
    return {
      date,
      usageStatus: existing.usage_status,
      arrivalTime: null,
      departureTime: null,
    };
  }

  const usageStatus = String(day?.usageStatus ?? day?.usage_status ?? "");
  if (!VALID_USAGE_STATUSES.has(usageStatus)) throw new AuthError("INVALID_USAGE_STATUS", "利用有無を正しく選択してください。");
  if (usageStatus === "off") {
    return { date, usageStatus, arrivalTime: null, departureTime: null };
  }

  const arrivalTime = String(day?.arrivalTime ?? day?.arrival_time ?? "");
  const departureTime = String(day?.departureTime ?? day?.departure_time ?? "");
  validateTimePair(arrivalTime, departureTime);
  return { date, usageStatus, arrivalTime, departureTime };
}

function normalizeDatabaseDay(row) {
  return {
    id: row.id,
    date: row.date,
    usageStatus: row.usage_status,
    arrivalTime: row.arrival_time,
    departureTime: row.departure_time,
    source: row.source,
    changed: Boolean(row.changed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    locked: LOCKED_USAGE_STATUSES.has(row.usage_status),
  };
}

function dayPublicValue(row) {
  return {
    date: row.date,
    usageStatus: row.usage_status,
    arrivalTime: row.arrival_time,
    departureTime: row.departure_time,
  };
}

function rowChanged(existing, next) {
  return existing.usage_status !== next.usageStatus
    || (existing.arrival_time ?? null) !== (next.arrivalTime ?? null)
    || (existing.departure_time ?? null) !== (next.departureTime ?? null);
}

function childInEnrollmentOnDate(child, dateKey) {
  return (!child.enrollment_date || child.enrollment_date <= dateKey)
    && (!child.withdrawal_date || child.withdrawal_date >= dateKey);
}

function makeInitialDay({ dateKey, child, closuresByDate, patternsByWeekday, timestamp }) {
  const closure = closuresByDate.get(dateKey);
  if (weekdayNumber(dateKey) === 0 || closure) {
    return {
      id: randomUUID(),
      monthlyScheduleId: null,
      date: dateKey,
      usageStatus: "closed",
      arrivalTime: null,
      departureTime: null,
      source: "base",
      changed: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
  if (!childInEnrollmentOnDate(child, dateKey)) {
    return {
      id: randomUUID(),
      monthlyScheduleId: null,
      date: dateKey,
      usageStatus: "not_enrolled",
      arrivalTime: null,
      departureTime: null,
      source: "base",
      changed: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
  const pattern = patternsByWeekday.get(weekdayNumber(dateKey));
  if (!pattern?.enabled) {
    return {
      id: randomUUID(),
      monthlyScheduleId: null,
      date: dateKey,
      usageStatus: "off",
      arrivalTime: null,
      departureTime: null,
      source: "base",
      changed: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
  validateTimePair(pattern.arrival_time, pattern.departure_time);
  return {
    id: randomUUID(),
    monthlyScheduleId: null,
    date: dateKey,
    usageStatus: "using",
    arrivalTime: pattern.arrival_time,
    departureTime: pattern.departure_time,
    source: "base",
    changed: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function statusLabel(submission, access) {
  if (!access.editable) return "期限超過";
  if (submission?.status === "submitted") return "提出済み";
  if (submission?.submitted_at) return "修正中・再提出が必要";
  return "未提出";
}

export function createFamilyScheduleService({ database, now = () => new Date() }) {
  function currentDate() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  function activePeriods() {
    return database.prepare(
      `SELECT id, target_month, deadline_at, status, updated_at
       FROM submission_periods
       WHERE status in ('open', 'closed')
       ORDER BY target_month`,
    ).all();
  }

  function targetPeriodOrUnavailable() {
    const periods = activePeriods();
    if (periods.length !== 1) {
      return {
        unavailable: true,
        periodCount: periods.length,
        periods,
        message: periods.length === 0
          ? "現在、保護者が入力できる提出対象月が設定されていません。園の管理者へご確認ください。"
          : "提出対象月が複数設定されています。安全のため月を選ばず、園の管理者へご確認ください。",
      };
    }
    return { unavailable: false, period: periods[0] };
  }

  function familyDeadlineExtension(familyId, periodId) {
    return database.prepare(
      `SELECT id, family_id, submission_period_id, extended_deadline_at, reason,
              administrator_id, created_at, updated_at
       FROM family_deadline_extensions
       WHERE family_id = ? AND submission_period_id = ?`,
    ).get(familyId, periodId);
  }

  function familySubmissionAccess(familyId, period, at = currentDate()) {
    const family = database.prepare("SELECT status, stop_date FROM families WHERE id = ?").get(familyId);
    const periodDeadline = tokyoDeadlineInstant(period.deadline_at);
    const extension = familyDeadlineExtension(familyId, period.id);
    const extensionDeadline = tokyoDeadlineInstant(extension?.extended_deadline_at);
    const extensionIsValid = periodDeadline !== null
      && extensionDeadline !== null
      && extensionDeadline.getTime() > periodDeadline.getTime();
    const effectiveDeadline = extensionIsValid ? extensionDeadline : periodDeadline;
    const familyAvailable = family?.status === "active" && !isStopDateEffective(family.stop_date, at);
    const periodOpen = period.status === "open";
    const withinDeadline = effectiveDeadline !== null && at.getTime() <= effectiveDeadline.getTime();
    const allowed = familyAvailable && periodOpen && withinDeadline;

    return {
      editable: allowed,
      submittable: allowed,
      readOnly: !allowed,
      effectiveDeadlineAt: effectiveDeadline ? toIso(effectiveDeadline) : null,
      deadlineSource: extensionIsValid ? "family_extension" : "submission_period",
      extension: extensionIsValid ? extension : null,
    };
  }

  function assertFamilySubmissionAccess(familyId, period, at = currentDate()) {
    const access = familySubmissionAccess(familyId, period, at);
    assertSubmissionAccess(access);
    return access;
  }

  function familyChildren(familyId, targetMonth) {
    const { first, last } = monthBounds(targetMonth);
    return database.prepare(
      `SELECT c.id, c.child_code, c.name, c.kana,
              c.last_name, c.first_name, c.last_name_kana, c.first_name_kana,
              c.class_name, c.birth_date, c.enrollment_date, c.withdrawal_date,
              fc.sort_order
       FROM children c
       JOIN family_children fc ON fc.child_id = c.id
       WHERE fc.family_id = ?
         AND c.status = 'enrolled'
         AND (fc.active_from IS NULL OR fc.active_from <= ?)
         AND (fc.active_to IS NULL OR fc.active_to >= ?)
         AND (c.enrollment_date IS NULL OR c.enrollment_date <= ?)
         AND (c.withdrawal_date IS NULL OR c.withdrawal_date >= ?)
       ORDER BY fc.sort_order, c.kana, c.name`,
    ).all(familyId, last, first, last, first);
  }

  function assertOwnedChild(familyId, childId, targetMonth) {
    const child = familyChildren(familyId, targetMonth).find((entry) => entry.id === childId);
    if (!child) throw new AuthError("CHILD_SCOPE_VIOLATION", "この家庭に紐づく園児だけを変更できます。", 403);
    return child;
  }

  function familySubmission(familyId, periodId) {
    return database.prepare(
      `SELECT id, family_id, submission_period_id, status, submitted_at,
              latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id,
              last_updated_at, created_at
       FROM family_submissions
       WHERE family_id = ? AND submission_period_id = ?`,
    ).get(familyId, periodId);
  }

  function patternsForChild(childId) {
    return database.prepare(
      `SELECT weekday, enabled, arrival_time, departure_time, valid_from, valid_to
       FROM basic_usage_patterns
       WHERE child_id = ?
       ORDER BY weekday`,
    ).all(childId);
  }

  function closuresForPeriod(periodId) {
    return database.prepare(
      `SELECT date, name, type, parent_input_allowed, note
       FROM closure_days
       WHERE submission_period_id = ?
       ORDER BY date`,
    ).all(periodId);
  }

  function monthlySchedule(childId, periodId) {
    return database.prepare(
      `SELECT id, child_id, submission_period_id, family_submission_id, status,
              base_pattern_snapshot_json, confirmed_at, created_at, updated_at
       FROM monthly_schedules
       WHERE child_id = ? AND submission_period_id = ?`,
    ).get(childId, periodId);
  }

  function dailyRows(monthlyScheduleId) {
    return database.prepare(
      `SELECT id, monthly_schedule_id, date, usage_status, arrival_time, departure_time,
              source, changed, created_at, updated_at
       FROM daily_schedules
       WHERE monthly_schedule_id = ?
       ORDER BY date`,
    ).all(monthlyScheduleId);
  }

  function nextSubmissionVersionSequence(familySubmissionId) {
    return database.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
       FROM family_submission_versions
       WHERE family_submission_id = ?`,
    ).get(familySubmissionId).next_sequence;
  }

  function createParentSubmissionVersion({ actor, submission, period, children, timestamp }) {
    const sequenceNumber = nextSubmissionVersionSequence(submission.id);
    const versionId = randomUUID();
    const sourceVersionId = submission.latest_submitted_version_id ?? null;

    database.prepare(
      `INSERT INTO family_submission_versions
       (id, family_submission_id, family_id, submission_period_id, sequence_number,
        version_type, review_status, source_version_id, submitted_at,
        created_by_family_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'parent_submission', 'pending', ?, ?, ?, ?)`,
    ).run(
      versionId,
      submission.id,
      submission.family_id,
      period.id,
      sequenceNumber,
      sourceVersionId,
      timestamp,
      actor.id,
      timestamp,
    );

    for (const child of children) {
      const versionChildId = randomUUID();
      database.prepare(
        `INSERT INTO family_submission_version_children
         (id, version_id, child_id, child_code_snapshot, name_snapshot, kana_snapshot,
          last_name_snapshot, first_name_snapshot, last_name_kana_snapshot, first_name_kana_snapshot,
          class_name_snapshot, birth_date_snapshot, enrollment_date_snapshot, withdrawal_date_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionChildId,
        versionId,
        child.id,
        child.child_code,
        child.name,
        child.kana,
        child.last_name,
        child.first_name,
        child.last_name_kana,
        child.first_name_kana,
        child.class_name,
        child.birth_date,
        child.enrollment_date,
        child.withdrawal_date,
        timestamp,
      );

      const monthly = monthlySchedule(child.id, period.id);
      for (const day of dailyRows(monthly.id)) {
        database.prepare(
          `INSERT INTO family_submission_version_days
           (id, version_child_id, date, usage_status, arrival_time, departure_time,
            source, changed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          versionChildId,
          day.date,
          day.usage_status,
          day.arrival_time,
          day.departure_time,
          day.source,
          day.changed,
          timestamp,
        );
      }
    }

    return { id: versionId, sequenceNumber, sourceVersionId };
  }

  function copySubmissionVersionSnapshot(sourceVersionId, targetVersionId, timestamp, dayOverrides = new Map()) {
    const sourceChildren = database.prepare(
      `SELECT id, child_id, child_code_snapshot, name_snapshot, kana_snapshot,
              last_name_snapshot, first_name_snapshot, last_name_kana_snapshot, first_name_kana_snapshot,
              class_name_snapshot, birth_date_snapshot, enrollment_date_snapshot, withdrawal_date_snapshot
       FROM family_submission_version_children
       WHERE version_id = ?
       ORDER BY child_code_snapshot, id`,
    ).all(sourceVersionId);
    let dayCount = 0;
    const appliedOverrides = new Set();

    for (const child of sourceChildren) {
      const targetChildId = randomUUID();
      database.prepare(
        `INSERT INTO family_submission_version_children
         (id, version_id, child_id, child_code_snapshot, name_snapshot, kana_snapshot,
          last_name_snapshot, first_name_snapshot, last_name_kana_snapshot, first_name_kana_snapshot,
          class_name_snapshot, birth_date_snapshot, enrollment_date_snapshot, withdrawal_date_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        targetChildId,
        targetVersionId,
        child.child_id,
        child.child_code_snapshot,
        child.name_snapshot,
        child.kana_snapshot,
        child.last_name_snapshot,
        child.first_name_snapshot,
        child.last_name_kana_snapshot,
        child.first_name_kana_snapshot,
        child.class_name_snapshot,
        child.birth_date_snapshot,
        child.enrollment_date_snapshot,
        child.withdrawal_date_snapshot,
        timestamp,
      );

      const sourceDays = database.prepare(
        `SELECT date, usage_status, arrival_time, departure_time, source, changed
         FROM family_submission_version_days
         WHERE version_child_id = ?
         ORDER BY date`,
      ).all(child.id);
      for (const day of sourceDays) {
        const overrideKey = `${child.child_id}\u0000${day.date}`;
        const override = dayOverrides.get(overrideKey);
        database.prepare(
          `INSERT INTO family_submission_version_days
           (id, version_child_id, date, usage_status, arrival_time, departure_time,
            source, changed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          targetChildId,
          day.date,
          override?.usageStatus ?? day.usage_status,
          override ? override.arrivalTime : day.arrival_time,
          override ? override.departureTime : day.departure_time,
          override ? "admin" : day.source,
          override ? 1 : day.changed,
          timestamp,
        );
        if (override) appliedOverrides.add(overrideKey);
        dayCount += 1;
      }
    }

    if (appliedOverrides.size !== dayOverrides.size) {
      throw new AuthError("SUBMISSION_VERSION_INCONSISTENT", "修正対象の日別予定を提出版から特定できません。", 409);
    }

    return { childCount: sourceChildren.length, dayCount };
  }

  function submissionVersion(versionId, submission) {
    const version = database.prepare(
      `SELECT id, family_submission_id, family_id, submission_period_id, sequence_number,
              version_type, review_status, source_version_id, submitted_at,
              created_by_family_account_id, created_by_administrator_id,
              reason_text, change_summary_json, confirmed_at, confirmed_by_administrator_id, created_at
       FROM family_submission_versions
       WHERE id = ? AND family_submission_id = ? AND family_id = ? AND submission_period_id = ?`,
    ).get(versionId, submission.id, submission.family_id, submission.submission_period_id);
    if (!version) {
      throw new AuthError("SUBMISSION_VERSION_INCONSISTENT", "提出版の参照が正しくありません。", 409);
    }

    const children = database.prepare(
      `SELECT id, child_id, child_code_snapshot, name_snapshot, kana_snapshot,
              last_name_snapshot, first_name_snapshot, last_name_kana_snapshot, first_name_kana_snapshot,
              class_name_snapshot, birth_date_snapshot, enrollment_date_snapshot, withdrawal_date_snapshot, created_at
       FROM family_submission_version_children
       WHERE version_id = ?
       ORDER BY child_code_snapshot, id`,
    ).all(version.id).map((child) => ({
      id: child.id,
      childId: child.child_id,
      childCode: child.child_code_snapshot,
      name: child.name_snapshot,
      kana: child.kana_snapshot,
      lastName: child.last_name_snapshot,
      firstName: child.first_name_snapshot,
      lastNameKana: child.last_name_kana_snapshot,
      firstNameKana: child.first_name_kana_snapshot,
      className: child.class_name_snapshot,
      birthDate: child.birth_date_snapshot,
      enrollmentDate: child.enrollment_date_snapshot,
      withdrawalDate: child.withdrawal_date_snapshot,
      createdAt: child.created_at,
      days: database.prepare(
        `SELECT id, date, usage_status, arrival_time, departure_time, source, changed, created_at
         FROM family_submission_version_days
         WHERE version_child_id = ?
         ORDER BY date`,
      ).all(child.id).map((day) => ({
        id: day.id,
        date: day.date,
        usageStatus: day.usage_status,
        arrivalTime: day.arrival_time,
        departureTime: day.departure_time,
        source: day.source,
        changed: Boolean(day.changed),
        createdAt: day.created_at,
      })),
    }));

    return {
      id: version.id,
      familySubmissionId: version.family_submission_id,
      familyId: version.family_id,
      submissionPeriodId: version.submission_period_id,
      sequenceNumber: version.sequence_number,
      versionType: version.version_type,
      reviewStatus: version.review_status,
      sourceVersionId: version.source_version_id,
      submittedAt: version.submitted_at,
      createdByFamilyAccountId: version.created_by_family_account_id,
      createdByAdministratorId: version.created_by_administrator_id,
      reason: version.reason_text,
      changeSummary: parseJson(version.change_summary_json, null),
      confirmedAt: version.confirmed_at,
      confirmedByAdministratorId: version.confirmed_by_administrator_id,
      createdAt: version.created_at,
      children,
    };
  }

  function latestSubmittedVersion(actor) {
    assertFamilyActor(actor);
    const periodResult = targetPeriodOrUnavailable();
    if (periodResult.unavailable) throw new AuthError("TARGET_PERIOD_UNAVAILABLE", periodResult.message, 409);
    const submission = familySubmission(actor.familyId, periodResult.period.id);
    if (!submission?.latest_submitted_version_id) return null;
    return submissionVersion(submission.latest_submitted_version_id, submission);
  }

  function writeHistory({ actor, entityType, entityId, familyId, childId = null, targetMonth, targetDate = null, fieldName, before = null, after = null, reason }) {
    database.prepare(
      `INSERT INTO change_histories
       (id, entity_type, entity_id, family_id, child_id, target_month, target_date, field_name,
        actor_type, actor_id, before_json, after_json, reason_text, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'family', ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      entityType,
      entityId,
      familyId,
      childId,
      targetMonth,
      targetDate,
      fieldName,
      actor.id,
      before === null ? null : safeJson(before),
      after === null ? null : safeJson(after),
      reason,
      toIso(currentDate()),
    );
  }

  function writeOperation({ actor, operation, targetType, targetId, targetMonth, detail }) {
    database.prepare(
      `INSERT INTO operation_logs
       (id, actor_type, actor_id, operation, target_type, target_id, target_month, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), actor.type, actor.id, operation, targetType, targetId, targetMonth, safeJson(detail), toIso(currentDate()));
  }

  function setFamilyDeadlineExtension(actor, input) {
    requirePermission(actor, "submission-period:extend-family-deadline");
    const familyId = String(input?.familyId ?? "").trim();
    const submissionPeriodId = String(input?.submissionPeriodId ?? "").trim();
    const reason = String(input?.reason ?? "").trim();
    if (!familyId || !submissionPeriodId) throw new AuthError("INVALID_INPUT", "家庭と提出対象期間を指定してください。");
    if (!reason) throw new AuthError("INVALID_REASON", "期限延長の理由を入力してください。");

    const family = database.prepare("SELECT id FROM families WHERE id = ?").get(familyId);
    if (!family) throw new AuthError("NOT_FOUND", "家庭が見つかりません。", 404);
    const period = database.prepare(
      "SELECT id, target_month, deadline_at, status FROM submission_periods WHERE id = ?",
    ).get(submissionPeriodId);
    if (!period) throw new AuthError("NOT_FOUND", "提出対象期間が見つかりません。", 404);

    const periodDeadline = tokyoDeadlineInstant(period.deadline_at);
    const extendedDeadline = tokyoDeadlineInstant(input?.extendedDeadlineAt);
    if (!periodDeadline || !extendedDeadline) {
      throw new AuthError("INVALID_DEADLINE", "延長期限を正しい日時で入力してください。");
    }
    if (extendedDeadline.getTime() <= periodDeadline.getTime()) {
      throw new AuthError("INVALID_DEADLINE_EXTENSION", "個別延長期限は全体期限より後にしてください。", 409);
    }

    const timestamp = toIso(currentDate());
    const extendedDeadlineAt = toIso(extendedDeadline);
    const existing = familyDeadlineExtension(familyId, period.id);
    const extensionId = existing?.id ?? randomUUID();
    transaction(database, () => {
      if (existing) {
        database.prepare(
          `UPDATE family_deadline_extensions
           SET extended_deadline_at = ?, reason = ?, administrator_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(extendedDeadlineAt, reason, actor.id, timestamp, existing.id);
      } else {
        database.prepare(
          `INSERT INTO family_deadline_extensions
           (id, family_id, submission_period_id, extended_deadline_at, reason,
            administrator_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(extensionId, familyId, period.id, extendedDeadlineAt, reason, actor.id, timestamp, timestamp);
      }
      writeOperation({
        actor,
        operation: existing ? "family_deadline_extension.updated" : "family_deadline_extension.created",
        targetType: "family_deadline_extension",
        targetId: extensionId,
        targetMonth: period.target_month,
        detail: {
          familyId,
          submissionPeriodId: period.id,
          before: existing ? { extendedDeadlineAt: existing.extended_deadline_at, reason: existing.reason } : null,
          after: { extendedDeadlineAt, reason },
        },
      });
    });

    const saved = familyDeadlineExtension(familyId, period.id);
    return {
      id: saved.id,
      familyId: saved.family_id,
      submissionPeriodId: saved.submission_period_id,
      extendedDeadlineAt: saved.extended_deadline_at,
      reason: saved.reason,
      administratorId: saved.administrator_id,
      createdAt: saved.created_at,
      updatedAt: saved.updated_at,
    };
  }

  function confirmLatestFamilySubmission(actor, input) {
    requirePermission(actor, "family-submission:confirm");
    const familyId = String(input?.familyId ?? "").trim();
    const submissionPeriodId = String(input?.submissionPeriodId ?? "").trim();
    if (!familyId || !submissionPeriodId) throw new AuthError("INVALID_INPUT", "家庭と提出対象期間を指定してください。");
    const timestamp = toIso(currentDate());

    const result = transaction(database, () => {
      const family = database.prepare("SELECT id FROM families WHERE id = ?").get(familyId);
      if (!family) throw new AuthError("NOT_FOUND", "家庭が見つかりません。", 404);
      const period = database.prepare(
        "SELECT id, target_month, status FROM submission_periods WHERE id = ?",
      ).get(submissionPeriodId);
      if (!period) throw new AuthError("NOT_FOUND", "提出対象期間が見つかりません。", 404);
      if (period.status !== "open" && period.status !== "closed") {
        throw new AuthError("PERIOD_NOT_REVIEWABLE", "未開始の提出対象期間は確認できません。", 409);
      }

      const submission = familySubmission(familyId, period.id);
      if (!submission?.latest_submitted_version_id) {
        throw new AuthError("SUBMITTED_VERSION_REQUIRED", "確認できる保護者提出版がありません。", 409);
      }
      const sourceVersion = submissionVersion(submission.latest_submitted_version_id, submission);
      if (sourceVersion.versionType !== "parent_submission") {
        throw new AuthError("SUBMISSION_VERSION_INCONSISTENT", "最新の保護者提出版の参照が正しくありません。", 409);
      }

      if (submission.latest_confirmed_version_id) {
        const confirmedVersion = submissionVersion(submission.latest_confirmed_version_id, submission);
        if (confirmedVersion.sourceVersionId === sourceVersion.id) {
          if (confirmedVersion.versionType !== "administrator_revision"
            || confirmedVersion.reviewStatus !== "confirmed"
            || submission.latest_effective_version_id !== confirmedVersion.id) {
            throw new AuthError("SUBMISSION_VERSION_INCONSISTENT", "管理者確認版の参照が正しくありません。", 409);
          }
          return { versionId: confirmedVersion.id, idempotent: true };
        }
      }

      const versionId = randomUUID();
      const sequenceNumber = nextSubmissionVersionSequence(submission.id);
      database.prepare(
        `INSERT INTO family_submission_versions
         (id, family_submission_id, family_id, submission_period_id, sequence_number,
          version_type, review_status, source_version_id, submitted_at,
          created_by_administrator_id, reason_text, change_summary_json,
          confirmed_at, confirmed_by_administrator_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'administrator_revision', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        submission.id,
        familyId,
        period.id,
        sequenceNumber,
        sourceVersion.id,
        timestamp,
        actor.id,
        "管理者による提出内容の確認",
        safeJson({ kind: "confirmation", changed: false, sourceVersionId: sourceVersion.id }),
        timestamp,
        actor.id,
        timestamp,
      );
      const copied = copySubmissionVersionSnapshot(sourceVersion.id, versionId, timestamp);
      const pointerUpdate = database.prepare(
        `UPDATE family_submissions
         SET latest_confirmed_version_id = ?, latest_effective_version_id = ?, last_updated_at = ?
         WHERE id = ? AND latest_submitted_version_id = ?`,
      ).run(versionId, versionId, timestamp, submission.id, sourceVersion.id);
      if (pointerUpdate.changes !== 1) {
        throw new AuthError("SUBMISSION_VERSION_INCONSISTENT", "確認中に最新の保護者提出版が変更されました。", 409);
      }
      writeOperation({
        actor,
        operation: "family_submission.confirmed",
        targetType: "family_submission",
        targetId: submission.id,
        targetMonth: period.target_month,
        detail: {
          familyId,
          submissionPeriodId: period.id,
          sourceVersionId: sourceVersion.id,
          confirmedVersionId: versionId,
          sequenceNumber,
          childCount: copied.childCount,
          dayCount: copied.dayCount,
        },
      });
      return { versionId, idempotent: false };
    });

    const submission = familySubmission(familyId, submissionPeriodId);
    return { ...submissionVersion(result.versionId, submission), idempotent: result.idempotent };
  }

  function prepareAdministratorRevision(actor, input, { requireExpectedSource }) {
    requirePermission(actor, "family-submission:revise");
    const familyId = String(input?.familyId ?? "").trim();
    const submissionPeriodId = String(input?.submissionPeriodId ?? "").trim();
    const reason = String(input?.reason ?? "").trim();
    const expectedSourceVersionId = String(input?.sourceVersionId ?? "").trim();
    if (!familyId || !submissionPeriodId) {
      throw new AuthError("INVALID_INPUT", "家庭と提出対象期間を指定してください。");
    }
    if (!reason) throw new AuthError("INVALID_REASON", "修正理由を入力してください。");
    if (requireExpectedSource && !expectedSourceVersionId) {
      throw new AuthError("SOURCE_VERSION_REQUIRED", "確認した修正元版を指定してください。", 409);
    }

    const family = database.prepare("SELECT id FROM families WHERE id = ?").get(familyId);
    if (!family) throw new AuthError("NOT_FOUND", "家庭が見つかりません。", 404);
    const period = database.prepare(
      "SELECT id, target_month, status FROM submission_periods WHERE id = ?",
    ).get(submissionPeriodId);
    if (!period) throw new AuthError("NOT_FOUND", "提出対象期間が見つかりません。", 404);
    if (period.status !== "open" && period.status !== "closed") {
      throw new AuthError("PERIOD_NOT_REVIEWABLE", "未開始の提出対象期間は管理者修正できません。", 409);
    }

    const submission = familySubmission(familyId, period.id);
    if (!submission?.latest_effective_version_id) {
      throw new AuthError("EFFECTIVE_VERSION_REQUIRED", "修正できる採用版がありません。", 409);
    }
    if (requireExpectedSource && expectedSourceVersionId !== submission.latest_effective_version_id) {
      throw new AuthError("EFFECTIVE_VERSION_CHANGED", "最新状態を読み直して再確認してください。", 409);
    }
    const sourceVersion = submissionVersion(submission.latest_effective_version_id, submission);
    const requestedChanges = Array.isArray(input?.changes) ? input.changes : [];
    if (!requestedChanges.length) throw new AuthError("INVALID_INPUT", "修正する日別予定を指定してください。");

    const childrenById = new Map(sourceVersion.children.map((child) => [child.childId, child]));
    const duplicateCheck = new Set();
    const changes = [];
    const dayOverrides = new Map();
    for (const requested of requestedChanges) {
      const childId = String(requested?.childId ?? "").trim();
      const child = childrenById.get(childId);
      if (!child) throw new AuthError("CHILD_SCOPE_VIOLATION", "対象家庭の採用版に含まれない園児は修正できません。", 403);
      const date = String(requested?.date ?? "");
      const key = `${childId}\u0000${date}`;
      if (duplicateCheck.has(key)) throw new AuthError("INVALID_INPUT", "同じ園児・日付が重複しています。");
      duplicateCheck.add(key);

      const sourceDay = child.days.find((day) => day.date === date);
      const existing = sourceDay ? {
        date: sourceDay.date,
        usage_status: sourceDay.usageStatus,
        arrival_time: sourceDay.arrivalTime,
        departure_time: sourceDay.departureTime,
      } : null;
      const next = normalizeRequestedDay(requested, existing, period.target_month);
      if (!rowChanged(existing, next)) continue;
      const change = {
        child: {
          id: child.childId,
          childCode: child.childCode,
          name: child.name,
        },
        childId: child.childId,
        date,
        before: dayPublicValue(existing),
        after: { ...next },
      };
      changes.push(change);
      dayOverrides.set(key, next);
    }

    return {
      familyId,
      submissionPeriodId: period.id,
      reason,
      period,
      submission,
      sourceVersion,
      changedDateCount: changes.length,
      changes,
      dayOverrides,
    };
  }

  function previewAdministratorRevision(actor, input) {
    const prepared = prepareAdministratorRevision(actor, input, { requireExpectedSource: false });
    return {
      familyId: prepared.familyId,
      submissionPeriodId: prepared.submissionPeriodId,
      sourceVersionId: prepared.sourceVersion.id,
      reason: prepared.reason,
      changedDateCount: prepared.changedDateCount,
      changes: prepared.changes,
    };
  }

  function createAdministratorRevision(actor, input) {
    requirePermission(actor, "family-submission:revise");
    const timestamp = toIso(currentDate());
    const result = transaction(database, () => {
      const prepared = prepareAdministratorRevision(actor, input, { requireExpectedSource: true });
      if (!prepared.changedDateCount) {
        throw new AuthError("NO_CHANGES", "実際に変更される日別予定がありません。", 409);
      }

      const versionId = randomUUID();
      const sequenceNumber = nextSubmissionVersionSequence(prepared.submission.id);
      const summary = {
        kind: "administrator_revision",
        administratorId: actor.id,
        familyId: prepared.familyId,
        submissionPeriodId: prepared.submissionPeriodId,
        sourceVersionId: prepared.sourceVersion.id,
        revisionVersionId: versionId,
        reason: prepared.reason,
        changedDateCount: prepared.changedDateCount,
        changes: prepared.changes,
        performedAt: timestamp,
      };
      database.prepare(
        `INSERT INTO family_submission_versions
         (id, family_submission_id, family_id, submission_period_id, sequence_number,
          version_type, review_status, source_version_id, submitted_at,
          created_by_administrator_id, reason_text, change_summary_json,
          confirmed_at, confirmed_by_administrator_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'administrator_revision', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        prepared.submission.id,
        prepared.familyId,
        prepared.submissionPeriodId,
        sequenceNumber,
        prepared.sourceVersion.id,
        timestamp,
        actor.id,
        prepared.reason,
        safeJson(summary),
        timestamp,
        actor.id,
        timestamp,
      );
      const copied = copySubmissionVersionSnapshot(
        prepared.sourceVersion.id,
        versionId,
        timestamp,
        prepared.dayOverrides,
      );
      const pointerUpdate = database.prepare(
        `UPDATE family_submissions
         SET latest_confirmed_version_id = ?, latest_effective_version_id = ?, last_updated_at = ?
         WHERE id = ? AND latest_effective_version_id = ?`,
      ).run(versionId, versionId, timestamp, prepared.submission.id, prepared.sourceVersion.id);
      if (pointerUpdate.changes !== 1) {
        throw new AuthError("EFFECTIVE_VERSION_CHANGED", "最新状態を読み直して再確認してください。", 409);
      }
      writeOperation({
        actor,
        operation: "family_submission.revised",
        targetType: "family_submission",
        targetId: prepared.submission.id,
        targetMonth: prepared.period.target_month,
        detail: summary,
      });
      return { versionId, copied };
    });

    const familyId = String(input?.familyId ?? "").trim();
    const submissionPeriodId = String(input?.submissionPeriodId ?? "").trim();
    const submission = familySubmission(familyId, submissionPeriodId);
    return { ...submissionVersion(result.versionId, submission), copied: result.copied };
  }

  function ensureInitialRecords(familyId, period) {
    const timestamp = toIso(currentDate());
    const children = familyChildren(familyId, period.target_month);
    const closures = closuresForPeriod(period.id);
    const closuresByDate = new Map(closures.map((closure) => [closure.date, closure]));
    const dates = datesForMonth(period.target_month);

    return transaction(database, () => {
      let submission = familySubmission(familyId, period.id);
      if (!submission) {
        submission = {
          id: randomUUID(),
          family_id: familyId,
          submission_period_id: period.id,
          status: "draft",
          submitted_at: null,
          last_updated_at: timestamp,
          created_at: timestamp,
        };
        database.prepare(
          `INSERT INTO family_submissions
           (id, family_id, submission_period_id, status, submitted_at, last_updated_at, created_at)
           VALUES (?, ?, ?, 'draft', NULL, ?, ?)`,
        ).run(submission.id, familyId, period.id, timestamp, timestamp);
      }

      for (const child of children) {
        const patternRows = patternsForChild(child.id);
        const patternsByWeekday = new Map(patternRows.map((row) => [row.weekday, row]));
        let monthly = monthlySchedule(child.id, period.id);
        if (!monthly) {
          monthly = {
            id: randomUUID(),
            child_id: child.id,
            submission_period_id: period.id,
            family_submission_id: submission.id,
            status: submission.status === "submitted" ? "submitted" : "draft",
            base_pattern_snapshot_json: safeJson(patternRows),
            confirmed_at: null,
            created_at: timestamp,
            updated_at: timestamp,
          };
          database.prepare(
            `INSERT INTO monthly_schedules
             (id, child_id, submission_period_id, family_submission_id, status,
              base_pattern_snapshot_json, confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          ).run(monthly.id, child.id, period.id, submission.id, monthly.status, monthly.base_pattern_snapshot_json, timestamp, timestamp);
        } else if (!monthly.family_submission_id) {
          database.prepare("UPDATE monthly_schedules SET family_submission_id = ?, updated_at = ? WHERE id = ?")
            .run(submission.id, timestamp, monthly.id);
        }

        const existingDates = new Set(dailyRows(monthly.id).map((row) => row.date));
        for (const dateKey of dates) {
          if (existingDates.has(dateKey)) continue;
          const day = makeInitialDay({ dateKey, child, closuresByDate, patternsByWeekday, timestamp });
          database.prepare(
            `INSERT INTO daily_schedules
             (id, monthly_schedule_id, date, usage_status, arrival_time, departure_time, source, changed, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(day.id, monthly.id, day.date, day.usageStatus, day.arrivalTime, day.departureTime, day.source, day.changed, day.createdAt, day.updatedAt);
        }
      }
      return { children, submission: familySubmission(familyId, period.id), closures };
    });
  }

  function dashboard(actor) {
    assertFamilyActor(actor);
    const periodResult = targetPeriodOrUnavailable();
    if (periodResult.unavailable) {
      return {
        available: false,
        message: periodResult.message,
        periodCount: periodResult.periodCount,
        periods: periodResult.periods.map((period) => ({ targetMonth: period.target_month, status: period.status })),
      };
    }

    const period = periodResult.period;
    const dashboardTime = currentDate();
    const ensured = ensureInitialRecords(actor.familyId, period);
    const submission = ensured.submission;
    const access = familySubmissionAccess(actor.familyId, period, dashboardTime);
    const closuresByDate = new Map(ensured.closures.map((closure) => [closure.date, closure]));
    const children = ensured.children.map((child) => {
      const monthly = monthlySchedule(child.id, period.id);
      const days = dailyRows(monthly.id).map((row) => {
        const normalized = normalizeDatabaseDay(row);
        return {
          ...normalized,
          weekday: weekdayNumber(row.date),
          closureName: closuresByDate.get(row.date)?.name ?? null,
        };
      });
      return {
        id: child.id,
        childCode: child.child_code,
        name: child.name,
        kana: child.kana,
        className: child.class_name,
        schedule: {
          id: monthly.id,
          status: monthly.status,
          basePatternSnapshot: parseJson(monthly.base_pattern_snapshot_json, []),
          updatedAt: monthly.updated_at,
          days,
        },
      };
    });
    const history = database.prepare(
      `SELECT h.id, h.entity_type, h.entity_id, h.child_id, h.target_date, h.field_name,
              h.before_json, h.after_json, h.reason_text, h.changed_at, c.name AS child_name
       FROM change_histories h
       LEFT JOIN children c ON c.id = h.child_id
       WHERE h.family_id = ? AND h.target_month = ?
       ORDER BY h.changed_at DESC
       LIMIT 40`,
    ).all(actor.familyId, period.target_month).map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      childId: row.child_id,
      childName: row.child_name,
      targetDate: row.target_date,
      fieldName: row.field_name,
      before: parseJson(row.before_json, null),
      after: parseJson(row.after_json, null),
      reason: row.reason_text,
      changedAt: row.changed_at,
    }));

    return {
      available: true,
      serverNow: toIso(dashboardTime),
      family: {
        id: actor.familyId,
        displayName: actor.displayName,
      },
      period: {
        id: period.id,
        targetMonth: period.target_month,
        deadlineAt: period.deadline_at,
        status: period.status,
        editable: access.editable,
        lockMessage: access.editable ? null : "提出期限を過ぎたため読み取り専用です。変更が必要な場合は園へご連絡ください。",
      },
      submission: {
        id: submission.id,
        status: submission.status,
        displayStatus: statusLabel(submission, access),
        submittedAt: submission.submitted_at,
        lastUpdatedAt: submission.last_updated_at,
        revisionRequired: submission.status === "draft" && Boolean(submission.submitted_at),
      },
      children,
      history,
    };
  }

  function updateChildSchedule(actor, childId, body) {
    assertFamilyActor(actor);
    const periodResult = targetPeriodOrUnavailable();
    if (periodResult.unavailable) throw new AuthError("TARGET_PERIOD_UNAVAILABLE", periodResult.message, 409);
    const period = periodResult.period;
    const operationTime = currentDate();
    assertFamilySubmissionAccess(actor.familyId, period, operationTime);
    assertOwnedChild(actor.familyId, childId, period.target_month);
    ensureInitialRecords(actor.familyId, period);

    const monthly = monthlySchedule(childId, period.id);
    const existingRows = dailyRows(monthly.id);
    const existingByDate = new Map(existingRows.map((row) => [row.date, row]));
    const requestedDays = Array.isArray(body?.days) ? body.days : [];
    if (!requestedDays.length) throw new AuthError("INVALID_INPUT", "保存する予定がありません。");

    const normalizedDays = requestedDays.map((day) => normalizeRequestedDay(day, existingByDate.get(String(day?.date ?? "")), period.target_month));
    const duplicateCheck = new Set();
    for (const day of normalizedDays) {
      if (duplicateCheck.has(day.date)) throw new AuthError("INVALID_INPUT", "同じ日付が重複しています。");
      duplicateCheck.add(day.date);
    }
    const changes = normalizedDays
      .map((day) => ({ existing: existingByDate.get(day.date), next: day }))
      .filter(({ existing, next }) => rowChanged(existing, next));
    if (!changes.length) return dashboard(actor);

    const timestamp = toIso(operationTime);
    transaction(database, () => {
      const submission = familySubmission(actor.familyId, period.id);
      for (const { existing, next } of changes) {
        database.prepare(
          `UPDATE daily_schedules
           SET usage_status = ?, arrival_time = ?, departure_time = ?, source = 'parent', changed = 1, updated_at = ?
           WHERE id = ?`,
        ).run(next.usageStatus, next.arrivalTime, next.departureTime, timestamp, existing.id);
        writeHistory({
          actor,
          entityType: "daily_schedule",
          entityId: existing.id,
          familyId: actor.familyId,
          childId,
          targetMonth: period.target_month,
          targetDate: next.date,
          fieldName: "daily_schedule",
          before: dayPublicValue(existing),
          after: next,
          reason: "保護者による下書き保存",
        });
      }
      database.prepare("UPDATE monthly_schedules SET status = 'draft', updated_at = ? WHERE id = ?").run(timestamp, monthly.id);
      database.prepare("UPDATE family_submissions SET status = 'draft', last_updated_at = ? WHERE id = ?").run(timestamp, submission.id);
      writeOperation({
        actor,
        operation: "family_schedule.saved",
        targetType: "monthly_schedule",
        targetId: monthly.id,
        targetMonth: period.target_month,
        detail: { childId, changedDates: changes.map(({ next }) => next.date) },
      });
    });
    return dashboard(actor);
  }

  function copyChildScheduleToSiblings(actor, sourceChildId) {
    assertFamilyActor(actor);
    const periodResult = targetPeriodOrUnavailable();
    if (periodResult.unavailable) throw new AuthError("TARGET_PERIOD_UNAVAILABLE", periodResult.message, 409);
    const period = periodResult.period;
    const operationTime = currentDate();
    assertFamilySubmissionAccess(actor.familyId, period, operationTime);
    const sourceChild = assertOwnedChild(actor.familyId, sourceChildId, period.target_month);
    const ensured = ensureInitialRecords(actor.familyId, period);
    const siblingChildren = ensured.children.filter((child) => child.id !== sourceChildId);
    if (!siblingChildren.length) throw new AuthError("NO_SIBLINGS", "反映できる兄弟姉妹がいません。", 409);

    const sourceMonthly = monthlySchedule(sourceChildId, period.id);
    const sourceRows = dailyRows(sourceMonthly.id);
    const sourceByDate = new Map(sourceRows.map((row) => [row.date, row]));
    for (const row of sourceRows) {
      if (row.usage_status === "using") validateTimePair(row.arrival_time, row.departure_time);
    }

    const timestamp = toIso(operationTime);
    transaction(database, () => {
      const submission = familySubmission(actor.familyId, period.id);
      const affectedChildren = [];
      for (const child of siblingChildren) {
        const monthly = monthlySchedule(child.id, period.id);
        const targetRows = dailyRows(monthly.id);
        const changedDates = [];
        for (const target of targetRows) {
          if (LOCKED_USAGE_STATUSES.has(target.usage_status)) continue;
          const source = sourceByDate.get(target.date);
          if (!source) continue;
          const next = source.usage_status === "using"
            ? { usageStatus: "using", arrivalTime: source.arrival_time, departureTime: source.departure_time }
            : { usageStatus: "off", arrivalTime: null, departureTime: null };
          if (next.usageStatus === "using") validateTimePair(next.arrivalTime, next.departureTime);
          if (!rowChanged(target, { date: target.date, ...next })) continue;
          database.prepare(
            `UPDATE daily_schedules
             SET usage_status = ?, arrival_time = ?, departure_time = ?, source = 'parent', changed = 1, updated_at = ?
             WHERE id = ?`,
          ).run(next.usageStatus, next.arrivalTime, next.departureTime, timestamp, target.id);
          changedDates.push(target.date);
        }
        if (changedDates.length) {
          database.prepare("UPDATE monthly_schedules SET status = 'draft', updated_at = ? WHERE id = ?").run(timestamp, monthly.id);
          writeHistory({
            actor,
            entityType: "monthly_schedule",
            entityId: monthly.id,
            familyId: actor.familyId,
            childId: child.id,
            targetMonth: period.target_month,
            fieldName: "copy_from_sibling",
            before: { sourceChildId, changedDates },
            after: { sourceChildId, sourceChildName: sourceChild.name, changedDates },
            reason: "この子の予定を兄弟姉妹にも反映",
          });
          affectedChildren.push({ childId: child.id, changedDates });
        }
      }
      if (!affectedChildren.length) throw new AuthError("NO_CHANGES", "反映する変更はありません。", 409);
      database.prepare("UPDATE family_submissions SET status = 'draft', last_updated_at = ? WHERE id = ?").run(timestamp, submission.id);
      writeOperation({
        actor,
        operation: "family_schedule.copied_to_siblings",
        targetType: "family_submission",
        targetId: submission.id,
        targetMonth: period.target_month,
        detail: { sourceChildId, affectedChildren },
      });
    });
    return dashboard(actor);
  }

  function validateFamilySchedules(familyId, period) {
    const children = familyChildren(familyId, period.target_month);
    const dates = datesForMonth(period.target_month);
    for (const child of children) {
      const monthly = monthlySchedule(child.id, period.id);
      if (!monthly) throw new AuthError("SCHEDULE_NOT_READY", "提出対象の予定を作成できていません。", 409);
      const rows = dailyRows(monthly.id);
      if (rows.length !== dates.length) throw new AuthError("SCHEDULE_NOT_READY", "月間予定の日数が不足しています。", 409);
      for (const row of rows) {
        if (row.usage_status === "using") validateTimePair(row.arrival_time, row.departure_time);
        if (row.usage_status === "off" && (row.arrival_time || row.departure_time)) {
          throw new AuthError("INVALID_TIME", "休みの日には時刻を保存できません。");
        }
        if (row.usage_status === "closed" && (row.arrival_time || row.departure_time)) {
          throw new AuthError("LOCKED_DAY", "休園日は利用予定にできません。", 409);
        }
      }
    }
    return children;
  }

  function submitFamilySchedules(actor) {
    assertFamilyActor(actor);
    const periodResult = targetPeriodOrUnavailable();
    if (periodResult.unavailable) throw new AuthError("TARGET_PERIOD_UNAVAILABLE", periodResult.message, 409);
    const period = periodResult.period;
    const operationTime = currentDate();
    assertFamilySubmissionAccess(actor.familyId, period, operationTime);
    ensureInitialRecords(actor.familyId, period);
    const timestamp = toIso(operationTime);

    transaction(database, () => {
      const children = validateFamilySchedules(actor.familyId, period);
      const before = familySubmission(actor.familyId, period.id);
      const action = before.submitted_at ? "再提出" : "初回提出";
      const version = createParentSubmissionVersion({ actor, submission: before, period, children, timestamp });
      database.prepare(
        `UPDATE family_submissions
         SET status = 'submitted', submitted_at = ?,
             latest_submitted_version_id = ?, latest_effective_version_id = ?,
             last_updated_at = ?
         WHERE id = ?`,
      ).run(timestamp, version.id, version.id, timestamp, before.id);
      for (const child of children) {
        const monthly = monthlySchedule(child.id, period.id);
        database.prepare("UPDATE monthly_schedules SET status = 'submitted', updated_at = ? WHERE id = ?").run(timestamp, monthly.id);
      }
      writeHistory({
        actor,
        entityType: "family_submission",
        entityId: before.id,
        familyId: actor.familyId,
        targetMonth: period.target_month,
        fieldName: before.submitted_at ? "resubmit" : "submit",
        before,
        after: {
          status: "submitted",
          submittedAt: timestamp,
          versionId: version.id,
          sequenceNumber: version.sequenceNumber,
          childIds: children.map((child) => child.id),
        },
        reason: action,
      });
      writeOperation({
        actor,
        operation: before.submitted_at ? "family_schedule.resubmitted" : "family_schedule.submitted",
        targetType: "family_submission",
        targetId: before.id,
        targetMonth: period.target_month,
        detail: { versionId: version.id, sequenceNumber: version.sequenceNumber, childIds: children.map((child) => child.id) },
      });
    });
    return dashboard(actor);
  }

  return {
    copyChildScheduleToSiblings,
    confirmLatestFamilySubmission,
    createAdministratorRevision,
    dashboard,
    latestSubmittedVersion,
    previewAdministratorRevision,
    setFamilyDeadlineExtension,
    submitFamilySchedules,
    updateChildSchedule,
  };
}
