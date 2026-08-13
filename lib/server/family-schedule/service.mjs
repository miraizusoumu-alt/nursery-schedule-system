import { randomUUID } from "node:crypto";
import { AuthError } from "../auth/permissions.mjs";
import { toIso } from "../auth/time.mjs";

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

function isEditablePeriod(period, now) {
  const deadline = tokyoDeadlineInstant(period.deadline_at);
  return period.status === "open" && deadline !== null && now.getTime() <= deadline.getTime();
}

function assertFamilyActor(actor) {
  if (!actor || actor.type !== "family" || !actor.familyId) {
    throw new AuthError("FORBIDDEN", "保護者画面を利用する権限がありません。", 403);
  }
}

function assertEditablePeriod(period, now) {
  if (!isEditablePeriod(period, now)) {
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

function statusLabel(submission, period, now) {
  if (!isEditablePeriod(period, now)) return "期限超過";
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

  function familyChildren(familyId, targetMonth) {
    const { first, last } = monthBounds(targetMonth);
    return database.prepare(
      `SELECT c.id, c.child_code, c.name, c.kana, c.class_name, c.enrollment_date, c.withdrawal_date,
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
      `SELECT id, family_id, submission_period_id, status, submitted_at, last_updated_at, created_at
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
       VALUES (?, 'family', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), actor.id, operation, targetType, targetId, targetMonth, safeJson(detail), toIso(currentDate()));
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
    const ensured = ensureInitialRecords(actor.familyId, period);
    const submission = ensured.submission;
    const editable = isEditablePeriod(period, currentDate());
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
      serverNow: toIso(currentDate()),
      family: {
        id: actor.familyId,
        displayName: actor.displayName,
      },
      period: {
        id: period.id,
        targetMonth: period.target_month,
        deadlineAt: period.deadline_at,
        status: period.status,
        editable,
        lockMessage: editable ? null : "提出期限を過ぎたため読み取り専用です。変更が必要な場合は園へご連絡ください。",
      },
      submission: {
        id: submission.id,
        status: submission.status,
        displayStatus: statusLabel(submission, period, currentDate()),
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
    assertEditablePeriod(period, currentDate());
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

    const timestamp = toIso(currentDate());
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
    assertEditablePeriod(period, currentDate());
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

    const timestamp = toIso(currentDate());
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
    assertEditablePeriod(period, currentDate());
    ensureInitialRecords(actor.familyId, period);
    const children = validateFamilySchedules(actor.familyId, period);
    const before = familySubmission(actor.familyId, period.id);
    const timestamp = toIso(currentDate());
    const action = before.submitted_at ? "再提出" : "初回提出";

    transaction(database, () => {
      database.prepare(
        `UPDATE family_submissions
         SET status = 'submitted', submitted_at = ?, last_updated_at = ?
         WHERE id = ?`,
      ).run(timestamp, timestamp, before.id);
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
        after: { status: "submitted", submittedAt: timestamp, childIds: children.map((child) => child.id) },
        reason: action,
      });
      writeOperation({
        actor,
        operation: before.submitted_at ? "family_schedule.resubmitted" : "family_schedule.submitted",
        targetType: "family_submission",
        targetId: before.id,
        targetMonth: period.target_month,
        detail: { childIds: children.map((child) => child.id) },
      });
    });
    return dashboard(actor);
  }

  return {
    copyChildScheduleToSiblings,
    dashboard,
    submitFamilySchedules,
    updateChildSchedule,
  };
}
