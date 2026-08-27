import { randomUUID } from "node:crypto";
import { AuthError, requirePermission } from "../auth/permissions.mjs";
import { toIso } from "../auth/time.mjs";
import {
  automaticGenerationUnresolved,
  buildAutomaticScheduleDraft,
  buildAutomaticSchedulePreview,
} from "../staffing/automatic-draft.mjs";
import { calculateIntegratedMonthlyAutomaticShift } from "../staffing/integrated-monthly-shift-generator.mjs";
import { loadStaffCandidateProfiles } from "../staffing/staff-candidate-repository.mjs";
import { evaluateCurrentDraftSchedule } from "../staffing/draft-schedule-review.mjs";
import { resolveStaffEffectiveAvailability } from "../staffing/staff-eligibility.mjs";
import {
  calculateConsecutiveWorkWarnings,
  calculateFullTimeMonthlyBaseline,
  calculateMonthlyScheduledWorkMinutes,
  calculateScheduleDayWorkMinutes,
  calculateWeeklyScheduledWorkMinutes,
  evaluateMonthlyDaysOff,
  STAFF_SCHEDULE_WEEK_STARTS_ON,
  validateScheduleDay,
  validateScheduleTimeRange,
} from "../staffing/scheduled-work.mjs";

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

function pad(value) {
  return String(value).padStart(2, "0");
}

function requiredTargetMonth(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw new AuthError("INVALID_TARGET_MONTH", "対象月はYYYY-MM形式で指定してください。");
  }
  const [year, month] = normalized.split("-").map(Number);
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new AuthError("INVALID_TARGET_MONTH", "対象月が正しくありません。");
  }
  return normalized;
}

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function requiredMonthDate(value, targetMonth) {
  const normalized = String(value ?? "").trim();
  if (!validDateKey(normalized) || !normalized.startsWith(`${targetMonth}-`)) {
    throw new AuthError("DATE_OUTSIDE_TARGET_MONTH", "対象月の日付を指定してください。");
  }
  return normalized;
}

function monthBounds(targetMonth) {
  const [year, month] = targetMonth.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${targetMonth}-01`,
    endDate: `${targetMonth}-${pad(dayCount)}`,
    dayCount,
  };
}

function shiftedMonth(targetMonth, offset) {
  const [year, month] = targetMonth.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

function fiscalYearForMonth(targetMonth) {
  const [year, month] = targetMonth.split("-").map(Number);
  return month >= 4 ? year : year - 1;
}

function dateFromKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(value) {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

function weekBounds(selectedDate) {
  const start = dateFromKey(selectedDate);
  const offset = (start.getUTCDay() - STAFF_SCHEDULE_WEEK_STARTS_ON + 7) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 6);
  return { startDate: dateKey(start), endDate: dateKey(end) };
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

export function createStaffScheduleService({
  database,
  now = () => new Date(),
  automaticShiftCalculator = calculateIntegratedMonthlyAutomaticShift,
  automaticRequirementSlotsProvider = null,
}) {
  function timestamp() {
    return toIso(now());
  }

  function writeOperation(actor, operation, targetId, targetMonth, detail) {
    database.prepare(
      `INSERT INTO operation_logs
       (id, actor_type, actor_id, operation, target_type, target_id, target_month, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, 'staff_schedule_month', ?, ?, ?, ?)`,
    ).run(randomUUID(), actor.type, actor.id, operation, targetId, targetMonth, safeJson(detail), timestamp());
  }

  function writePreferenceOperation(actor, operation, staffId, targetMonth, detail) {
    database.prepare(
      `INSERT INTO operation_logs
       (id, actor_type, actor_id, operation, target_type, target_id, target_month, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, 'staff_schedule_preference', ?, ?, ?, ?)`,
    ).run(randomUUID(), actor.type, actor.id, operation, staffId, targetMonth, safeJson(detail), timestamp());
  }

  function findMonth(targetMonth) {
    return database.prepare(
      `SELECT id, target_month, status, current_version_id, confirmed_at, created_at, updated_at
       FROM staff_schedule_months WHERE target_month = ?`,
    ).get(targetMonth) ?? null;
  }

  function requireMonth(targetMonth) {
    const month = findMonth(targetMonth);
    if (!month) throw new AuthError("STAFF_SCHEDULE_NOT_FOUND", "この月のシフトはまだ作成されていません。", 404);
    return month;
  }

  function requireVersion(monthId, versionId) {
    const version = database.prepare(
      `SELECT id, schedule_month_id, version_number, source, status, source_version_id,
              created_by_administrator_id, confirmed_by_administrator_id, confirmed_at, created_at
       FROM staff_schedule_versions WHERE id = ? AND schedule_month_id = ?`,
    ).get(versionId, monthId);
    if (!version) throw new AuthError("STAFF_SCHEDULE_VERSION_NOT_FOUND", "シフトの保存版が見つかりません。", 404);
    return version;
  }

  function eligibleStaff(targetMonth) {
    const { startDate, endDate } = monthBounds(targetMonth);
    return database.prepare(
      `SELECT id, staff_code, name, employment_start_date, employment_end_date, status
       FROM staff_members
       WHERE employment_start_date <= ?
         AND (employment_end_date IS NULL OR employment_end_date >= ?)
         AND (status = 'active' OR employment_end_date IS NOT NULL)
       ORDER BY staff_code, id`,
    ).all(endDate, startDate);
  }

  function employmentTypeForMonth(staffId, targetMonth) {
    const { startDate, endDate } = monthBounds(targetMonth);
    const types = [...new Set(database.prepare(
      `SELECT employment_type FROM staff_work_condition_versions
       WHERE staff_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
       ORDER BY valid_from, created_at, id`,
    ).all(staffId, endDate, startDate).map((entry) => entry.employment_type))];
    if (types.length === 1) return types[0];
    if (types.length > 1) return "期間内変更";
    return null;
  }

  function weeklyAvailabilityForDate(staffId, date) {
    const weekday = dateFromKey(date).getUTCDay();
    const row = database.prepare(
      `SELECT wc.id AS condition_id, wa.available, wa.start_time, wa.end_time
       FROM staff_work_condition_versions wc
       LEFT JOIN staff_weekly_availability wa
         ON wa.work_condition_version_id = wc.id AND wa.weekday = ?
       WHERE wc.staff_id = ?
         AND wc.valid_from <= ?
         AND (wc.valid_to IS NULL OR wc.valid_to >= ?)
       ORDER BY wc.valid_from DESC, wc.created_at DESC, wc.id DESC
       LIMIT 1`,
    ).get(weekday, staffId, date, date);
    if (!row) return null;
    return {
      workConditionVersionId: row.condition_id,
      weekday,
      available: row.available === 1,
      startTime: row.start_time ?? null,
      endTime: row.end_time ?? null,
    };
  }

  function preferenceView(staffId, date, row = null) {
    const weeklyAvailability = weeklyAvailabilityForDate(staffId, date);
    const preference = row ? {
      preferenceType: row.preference_type,
      startTime: row.start_time,
      endTime: row.end_time,
    } : null;
    if (!row) {
      return {
        id: null,
        staffId,
        date,
        preferenceType: "none",
        startTime: null,
        endTime: null,
        requiresAdministratorReview: false,
        reviewMessage: null,
        weeklyAvailability,
        effectiveAvailability: resolveStaffEffectiveAvailability({ weeklyAvailability, preference }),
      };
    }
    return {
      id: row.id,
      staffId: row.staff_id,
      date: row.date,
      preferenceType: row.preference_type,
      startTime: row.start_time,
      endTime: row.end_time,
      requiresAdministratorReview: false,
      reviewMessage: null,
      weeklyAvailability,
      effectiveAvailability: resolveStaffEffectiveAvailability({ weeklyAvailability, preference }),
    };
  }

  function loadPreference(staffId, date) {
    const row = database.prepare(
      `SELECT id, staff_id, date, preference_type, start_time, end_time,
              created_by_administrator_id, updated_by_administrator_id, created_at, updated_at
       FROM staff_schedule_preferences WHERE staff_id = ? AND date = ?`,
    ).get(staffId, date) ?? null;
    return preferenceView(staffId, date, row);
  }

  function staffPreferencesForMonth(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const staffId = String(input.staffId ?? "").trim();
    const { startDate, endDate } = monthBounds(targetMonth);
    const rows = staffId
      ? database.prepare(
        `SELECT id, staff_id, date, preference_type, start_time, end_time,
                created_by_administrator_id, updated_by_administrator_id, created_at, updated_at
         FROM staff_schedule_preferences
         WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date`,
      ).all(staffId, startDate, endDate)
      : database.prepare(
        `SELECT id, staff_id, date, preference_type, start_time, end_time,
                created_by_administrator_id, updated_by_administrator_id, created_at, updated_at
         FROM staff_schedule_preferences
         WHERE date BETWEEN ? AND ? ORDER BY staff_id, date`,
      ).all(startDate, endDate);
    return {
      targetMonth,
      preferences: rows.map((row) => preferenceView(row.staff_id, row.date, row)),
    };
  }

  function loadDays(versionId, staffId = null) {
    if (!versionId) return [];
    const rows = staffId
      ? database.prepare(
        `SELECT id, version_id, staff_id, date, day_type, created_at, updated_at
         FROM staff_schedule_days WHERE version_id = ? AND staff_id = ? ORDER BY date, id`,
      ).all(versionId, staffId)
      : database.prepare(
        `SELECT id, version_id, staff_id, date, day_type, created_at, updated_at
         FROM staff_schedule_days WHERE version_id = ? ORDER BY staff_id, date, id`,
      ).all(versionId);
    const segments = database.prepare(
      `SELECT id, start_time, end_time, activity_type
       FROM staff_schedule_segments WHERE schedule_day_id = ? ORDER BY start_time, end_time, id`,
    );
    return rows.map((row) => ({
      id: row.id,
      versionId: row.version_id,
      staffId: row.staff_id,
      date: row.date,
      dayType: row.day_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      segments: segments.all(row.id).map((segment) => ({
        id: segment.id,
        startTime: segment.start_time,
        endTime: segment.end_time,
        activityType: segment.activity_type,
      })),
    }));
  }

  function loadCurrentMonthDays(targetMonth, staffId) {
    const month = findMonth(targetMonth);
    return month?.current_version_id ? loadDays(month.current_version_id, staffId) : [];
  }

  function versionList(monthId) {
    return database.prepare(
      `SELECT id, version_number, source, status, source_version_id,
              created_by_administrator_id, confirmed_by_administrator_id, confirmed_at, created_at
       FROM staff_schedule_versions WHERE schedule_month_id = ? ORDER BY version_number DESC`,
    ).all(monthId).map((version) => ({
      id: version.id,
      versionNumber: version.version_number,
      source: version.source,
      status: version.status,
      sourceVersionId: version.source_version_id,
      createdByAdministratorId: version.created_by_administrator_id,
      confirmedByAdministratorId: version.confirmed_by_administrator_id,
      confirmedAt: version.confirmed_at,
      createdAt: version.created_at,
    }));
  }

  function scheduleDashboard(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const { startDate, dayCount } = monthBounds(targetMonth);
    const selectedDate = input.selectedDate ? requiredMonthDate(input.selectedDate, targetMonth) : startDate;
    const month = findMonth(targetMonth);
    const versions = month ? versionList(month.id) : [];
    const requestedVersionId = String(input.versionId ?? "").trim();
    const viewedVersion = month && (requestedVersionId || month.current_version_id)
      ? requireVersion(month.id, requestedVersionId || month.current_version_id)
      : null;
    const viewedDays = viewedVersion ? loadDays(viewedVersion.id) : [];
    const daysByStaff = new Map();
    for (const day of viewedDays) {
      const entries = daysByStaff.get(day.staffId) ?? [];
      entries.push(day);
      daysByStaff.set(day.staffId, entries);
    }
    const week = weekBounds(selectedDate);
    const staff = eligibleStaff(targetMonth).map((entry) => {
      const days = daysByStaff.get(entry.id) ?? [];
      const adjacentDays = [shiftedMonth(targetMonth, -1), shiftedMonth(targetMonth, 1)]
        .flatMap((monthKey) => loadCurrentMonthDays(monthKey, entry.id));
      const weekDays = [...adjacentDays, ...days].filter((day) => day.date >= week.startDate && day.date <= week.endDate);
      const previousMonthDays = loadCurrentMonthDays(shiftedMonth(targetMonth, -1), entry.id);
      const employmentType = employmentTypeForMonth(entry.id, targetMonth);
      const daysOff = evaluateMonthlyDaysOff(days, { staffId: entry.id, employmentType });
      const baseline = calculateFullTimeMonthlyBaseline(targetMonth);
      const monthlyScheduledWorkMinutes = calculateMonthlyScheduledWorkMinutes(days, { staffId: entry.id });
      const weekly = calculateWeeklyScheduledWorkMinutes(weekDays, {
        staffId: entry.id,
        weekStartsOn: STAFF_SCHEDULE_WEEK_STARTS_ON,
      }).find((group) => group.weekStart === week.startDate);
      const selectedDay = days.find((day) => day.date === selectedDate) ?? null;
      return {
        id: entry.id,
        staffCode: entry.staff_code,
        name: entry.name,
        employmentStartDate: entry.employment_start_date,
        employmentEndDate: entry.employment_end_date,
        status: entry.status,
        employmentType,
        selectedPreference: loadPreference(entry.id, selectedDate),
        selectedDay,
        selectedDayScheduledWorkMinutes: selectedDay ? calculateScheduleDayWorkMinutes(selectedDay) : 0,
        selectedWeek: week,
        weeklyScheduledWorkMinutes: weekly?.scheduledWorkMinutes ?? 0,
        monthlyScheduledWorkMinutes,
        basicMonthlyScheduledWorkMinutes: employmentType === "常勤" ? baseline.basicScheduledWorkMinutes : null,
        monthlyScheduledWorkDifferenceMinutes: employmentType === "常勤"
          ? monthlyScheduledWorkMinutes - baseline.basicScheduledWorkMinutes
          : null,
        daysOff,
        consecutiveWorkWarnings: calculateConsecutiveWorkWarnings(days, {
          staffId: entry.id,
          priorDays: previousMonthDays,
        }),
      };
    });
    return {
      targetMonth,
      fiscalYear: fiscalYearForMonth(targetMonth),
      selectedDate,
      dayCount,
      weekStartsOn: STAFF_SCHEDULE_WEEK_STARTS_ON,
      month: month ? {
        id: month.id,
        status: month.status,
        currentVersionId: month.current_version_id,
        confirmedAt: month.confirmed_at,
        createdAt: month.created_at,
        updatedAt: month.updated_at,
      } : null,
      viewedVersion: viewedVersion ? {
        id: viewedVersion.id,
        versionNumber: viewedVersion.version_number,
        source: viewedVersion.source,
        status: viewedVersion.status,
        sourceVersionId: viewedVersion.source_version_id,
        confirmedAt: viewedVersion.confirmed_at,
        createdAt: viewedVersion.created_at,
        isCurrent: viewedVersion.id === month?.current_version_id,
        readOnly: viewedVersion.status === "confirmed" || viewedVersion.id !== month?.current_version_id,
      } : null,
      versions,
      availableMonths: database.prepare(
        "SELECT target_month, status, confirmed_at FROM staff_schedule_months ORDER BY target_month",
      ).all().map((entry) => ({
        targetMonth: entry.target_month,
        status: entry.status,
        confirmedAt: entry.confirmed_at,
      })),
      staff,
    };
  }

  function createMonthlySchedule(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const existing = findMonth(targetMonth);
    if (existing) return scheduleDashboard(actor, { targetMonth });
    const monthId = randomUUID();
    const versionId = randomUUID();
    const occurredAt = timestamp();
    transaction(database, () => {
      database.prepare(
        `INSERT INTO staff_schedule_months
         (id, target_month, status, current_version_id, confirmed_at, created_at, updated_at)
         VALUES (?, ?, 'draft', NULL, NULL, ?, ?)`,
      ).run(monthId, targetMonth, occurredAt, occurredAt);
      database.prepare(
        `INSERT INTO staff_schedule_versions
         (id, schedule_month_id, version_number, source, status, source_version_id,
          created_by_administrator_id, confirmed_by_administrator_id, confirmed_at, created_at)
         VALUES (?, ?, 1, 'manual', 'draft', NULL, ?, NULL, NULL, ?)`,
      ).run(versionId, monthId, actor.id, occurredAt);
      database.prepare(
        "UPDATE staff_schedule_months SET current_version_id = ?, updated_at = ? WHERE id = ?",
      ).run(versionId, occurredAt, monthId);
      writeOperation(actor, "staff_schedule_month.created", monthId, targetMonth, { versionId, occurredAt });
    });
    return scheduleDashboard(actor, { targetMonth });
  }

  function automaticDraftConflict(targetMonth) {
    const existing = findMonth(targetMonth);
    if (!existing) return null;
    if (existing.status === "draft") {
      throw new AuthError("DRAFT_ALREADY_EXISTS", "この月には作成中のシフトがあります。", 409);
    }
    if (existing.status === "confirmed") {
      throw new AuthError("CONFIRMED_SCHEDULE_EXISTS", "この月には確定済みのシフトがあります。", 409);
    }
    throw new AuthError("INVALID_STAFF_SCHEDULE_STATUS", "シフトの状態が正しくありません。", 409);
  }

  function loadAutomaticRequirementSource(actor, targetMonth) {
    if (typeof automaticRequirementSlotsProvider !== "function") {
      throw new AuthError(
        "AUTOMATIC_SHIFT_REQUIREMENTS_UNAVAILABLE",
        "シフト確認に必要な園児の利用予定を取得できません。",
        503,
      );
    }
    const requirementSource = automaticRequirementSlotsProvider(actor, { targetMonth });
    if (
      !requirementSource
      || requirementSource.period?.targetMonth !== targetMonth
      || !Array.isArray(requirementSource.slots)
    ) {
      throw new AuthError(
        "INVALID_AUTOMATIC_SHIFT_REQUIREMENTS",
        "対象月の必要人数データが正しくありません。",
        409,
      );
    }
    return requirementSource;
  }

  function calculateAutomaticMonthlyDraft(actor, targetMonth) {
    automaticDraftConflict(targetMonth);
    const requirementSource = loadAutomaticRequirementSource(actor, targetMonth);
    const staffProfiles = loadStaffCandidateProfiles(database);
    const { startDate, endDate } = monthBounds(targetMonth);
    const closureDates = database.prepare(
      `SELECT date FROM closure_days
       WHERE date BETWEEN ? AND ? AND type = 'closed' AND parent_input_allowed = 0
       ORDER BY date`,
    ).all(startDate, endDate).map((entry) => entry.date);
    let generationResult;
    let days;
    try {
      generationResult = automaticShiftCalculator({
        targetMonth,
        requirementSlots: requirementSource.slots,
        staffProfiles,
        closureDates,
      });
      days = buildAutomaticScheduleDraft({ targetMonth, generationResult, staffProfiles });
    } catch (error) {
      throw new AuthError(error.code ?? "INVALID_AUTOMATIC_SCHEDULE", error.message, 400);
    }

    const eligibleOnDate = database.prepare(
      `SELECT id FROM staff_members
       WHERE id = ? AND employment_start_date <= ? AND (employment_end_date IS NULL OR employment_end_date >= ?)`,
    );
    for (const day of days) {
      if (!eligibleOnDate.get(day.staffId, day.date, day.date)) {
        throw new AuthError("STAFF_NOT_ELIGIBLE", "対象外の職員・日付を自動シフトへ保存できません。", 409);
      }
    }

    const unresolved = automaticGenerationUnresolved(generationResult);
    return {
      days,
      unresolved,
      preview: buildAutomaticSchedulePreview({
        targetMonth,
        days,
        staffProfiles,
        requirementSource,
        unresolved,
        generationResult,
      }),
    };
  }

  function previewAutomaticMonthlyDraft(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    return calculateAutomaticMonthlyDraft(actor, targetMonth).preview;
  }

  function evaluateDraftVersion(actor, targetMonth, versionId) {
    const requirementSource = loadAutomaticRequirementSource(actor, targetMonth);
    let review;
    try {
      review = evaluateCurrentDraftSchedule({
        targetMonth,
        requirementSource,
        staffProfiles: loadStaffCandidateProfiles(database),
        currentDays: loadDays(versionId),
      });
    } catch (error) {
      throw new AuthError(error.code ?? "INVALID_STAFF_SCHEDULE_REVIEW", error.message, 400);
    }
    return {
      ...review,
      versionId,
      checkedAt: timestamp(),
    };
  }

  function recheckCurrentDraft(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const month = requireMonth(targetMonth);
    const versionId = String(input.versionId ?? "").trim();
    if (!versionId || month.current_version_id !== versionId) {
      throw new AuthError("STAFF_SCHEDULE_VERSION_CHANGED", "最新のシフトを読み直してから再チェックしてください。", 409);
    }
    const version = requireVersion(month.id, versionId);
    if (month.status !== "draft" || version.status !== "draft") {
      throw new AuthError("STAFF_SCHEDULE_NOT_DRAFT", "作成中のシフトだけを再チェックできます。", 409);
    }
    return evaluateDraftVersion(actor, targetMonth, versionId);
  }

  function createAutomaticMonthlyDraft(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const { days, unresolved } = calculateAutomaticMonthlyDraft(actor, targetMonth);

    const monthId = randomUUID();
    const versionId = randomUUID();
    const occurredAt = timestamp();
    transaction(database, () => {
      automaticDraftConflict(targetMonth);
      database.prepare(
        `INSERT INTO staff_schedule_months
         (id, target_month, status, current_version_id, confirmed_at, created_at, updated_at)
         VALUES (?, ?, 'draft', NULL, NULL, ?, ?)`,
      ).run(monthId, targetMonth, occurredAt, occurredAt);
      database.prepare(
        `INSERT INTO staff_schedule_versions
         (id, schedule_month_id, version_number, source, status, source_version_id,
          created_by_administrator_id, confirmed_by_administrator_id, confirmed_at, created_at)
         VALUES (?, ?, 1, 'auto_generated', 'draft', NULL, ?, NULL, NULL, ?)`,
      ).run(versionId, monthId, actor.id, occurredAt);
      const insertDay = database.prepare(
        `INSERT INTO staff_schedule_days
         (id, version_id, staff_id, date, day_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSegment = database.prepare(
        `INSERT INTO staff_schedule_segments
         (id, schedule_day_id, start_time, end_time, activity_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const day of days) {
        const dayId = randomUUID();
        insertDay.run(dayId, versionId, day.staffId, day.date, day.dayType, occurredAt, occurredAt);
        for (const segment of day.segments) {
          insertSegment.run(
            randomUUID(),
            dayId,
            segment.startTime,
            segment.endTime,
            segment.activityType,
            occurredAt,
            occurredAt,
          );
        }
      }
      database.prepare(
        "UPDATE staff_schedule_months SET current_version_id = ?, updated_at = ? WHERE id = ?",
      ).run(versionId, occurredAt, monthId);
      writeOperation(actor, "staff_schedule_month.auto_draft_created", monthId, targetMonth, {
        versionId,
        dayCount: days.length,
        segmentCount: days.reduce((total, day) => total + day.segments.length, 0),
        unresolvedCounts: {
          staffing: unresolved.staffingShortages.length,
          daysOff: unresolved.daysOff.length,
          breaks: unresolved.breaks.length,
        },
        occurredAt,
      });
    });
    return {
      schedule: scheduleDashboard(actor, { targetMonth }),
      unresolved,
    };
  }

  function saveScheduleDay(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const date = requiredMonthDate(input.date, targetMonth);
    const month = requireMonth(targetMonth);
    const versionId = String(input.versionId ?? "").trim();
    if (!versionId || month.current_version_id !== versionId) {
      throw new AuthError("STAFF_SCHEDULE_VERSION_CHANGED", "最新のシフトを読み直してから保存してください。", 409);
    }
    const version = requireVersion(month.id, versionId);
    if (version.status !== "draft" || month.status !== "draft") {
      throw new AuthError("STAFF_SCHEDULE_CONFIRMED", "確定済みシフトは直接編集できません。", 409);
    }
    const staffId = String(input.staffId ?? "").trim();
    const staff = database.prepare(
      `SELECT id FROM staff_members
       WHERE id = ? AND employment_start_date <= ? AND (employment_end_date IS NULL OR employment_end_date >= ?)`,
    ).get(staffId, date, date);
    if (!staff) throw new AuthError("STAFF_NOT_ELIGIBLE", "この日付では対象職員をシフトへ登録できません。", 409);
    let day;
    try {
      day = validateScheduleDay({
        staffId,
        date,
        dayType: input.dayType,
        segments: input.segments ?? [],
      });
    } catch (error) {
      throw new AuthError(error.code ?? "INVALID_STAFF_SCHEDULE", error.message, 400);
    }
    const occurredAt = timestamp();
    transaction(database, () => {
      let dayId = database.prepare(
        "SELECT id FROM staff_schedule_days WHERE version_id = ? AND staff_id = ? AND date = ?",
      ).get(versionId, staffId, date)?.id;
      if (dayId) {
        database.prepare("DELETE FROM staff_schedule_segments WHERE schedule_day_id = ?").run(dayId);
        database.prepare(
          "UPDATE staff_schedule_days SET day_type = ?, updated_at = ? WHERE id = ?",
        ).run(day.dayType, occurredAt, dayId);
      } else {
        dayId = randomUUID();
        database.prepare(
          `INSERT INTO staff_schedule_days
           (id, version_id, staff_id, date, day_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(dayId, versionId, staffId, date, day.dayType, occurredAt, occurredAt);
      }
      const insertSegment = database.prepare(
        `INSERT INTO staff_schedule_segments
         (id, schedule_day_id, start_time, end_time, activity_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const segment of day.segments) {
        insertSegment.run(randomUUID(), dayId, segment.startTime, segment.endTime, segment.activityType, occurredAt, occurredAt);
      }
      database.prepare("UPDATE staff_schedule_months SET updated_at = ? WHERE id = ?").run(occurredAt, month.id);
      writeOperation(actor, "staff_schedule_day.saved", month.id, targetMonth, {
        versionId,
        staffId,
        date,
        dayType: day.dayType,
        segments: day.segments.map(({ startTime, endTime, activityType }) => ({ startTime, endTime, activityType })),
        occurredAt,
      });
    });
    return scheduleDashboard(actor, { targetMonth, selectedDate: date });
  }

  function saveStaffPreference(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const date = requiredMonthDate(input.date, targetMonth);
    const staffId = String(input.staffId ?? "").trim();
    const staff = database.prepare(
      `SELECT id FROM staff_members
       WHERE id = ? AND employment_start_date <= ? AND (employment_end_date IS NULL OR employment_end_date >= ?)`,
    ).get(staffId, date, date);
    if (!staff) throw new AuthError("STAFF_NOT_ELIGIBLE", "この日付では対象職員の希望を登録できません。", 409);
    const preferenceType = String(input.preferenceType ?? "").trim();
    if (!new Set(["none", "day_off", "work_time"]).has(preferenceType)) {
      throw new AuthError("INVALID_STAFF_PREFERENCE", "希望内容が正しくありません。", 400);
    }
    let startTime = null;
    let endTime = null;
    if (preferenceType === "work_time") {
      try {
        ({ startTime, endTime } = validateScheduleTimeRange(input.startTime, input.endTime));
      } catch (error) {
        throw new AuthError(error.code ?? "INVALID_STAFF_PREFERENCE", error.message, 400);
      }
    }
    const existing = database.prepare(
      "SELECT id, preference_type, start_time, end_time FROM staff_schedule_preferences WHERE staff_id = ? AND date = ?",
    ).get(staffId, date) ?? null;
    const occurredAt = timestamp();
    transaction(database, () => {
      if (preferenceType === "none") {
        if (existing) {
          database.prepare("DELETE FROM staff_schedule_preferences WHERE id = ?").run(existing.id);
          writePreferenceOperation(actor, "staff_schedule_preference.cleared", staffId, targetMonth, {
            date,
            before: { preferenceType: existing.preference_type, startTime: existing.start_time, endTime: existing.end_time },
            occurredAt,
          });
        }
        return;
      }
      if (existing) {
        database.prepare(
          `UPDATE staff_schedule_preferences
           SET preference_type = ?, start_time = ?, end_time = ?, updated_by_administrator_id = ?, updated_at = ?
           WHERE id = ?`,
        ).run(preferenceType, startTime, endTime, actor.id, occurredAt, existing.id);
      } else {
        database.prepare(
          `INSERT INTO staff_schedule_preferences
           (id, staff_id, date, preference_type, start_time, end_time,
            created_by_administrator_id, updated_by_administrator_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), staffId, date, preferenceType, startTime, endTime, actor.id, actor.id, occurredAt, occurredAt);
      }
      writePreferenceOperation(actor, "staff_schedule_preference.saved", staffId, targetMonth, {
        date,
        preferenceType,
        startTime,
        endTime,
        occurredAt,
      });
    });
    return scheduleDashboard(actor, { targetMonth, selectedDate: date });
  }

  function confirmMonthlySchedule(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const versionId = String(input.versionId ?? "").trim();
    if (!versionId) throw new AuthError("STAFF_SCHEDULE_VERSION_CHANGED", "最新のシフトを読み直してから確定してください。", 409);
    const acknowledgeWarnings = input.acknowledgeWarnings === true;
    const occurredAt = timestamp();
    transaction(database, () => {
      const month = requireMonth(targetMonth);
      if (month.current_version_id !== versionId) {
        throw new AuthError("STAFF_SCHEDULE_VERSION_CHANGED", "最新のシフトを読み直してから確定してください。", 409);
      }
      const version = requireVersion(month.id, versionId);
      if (version.status === "confirmed" && month.status === "confirmed") return;
      if (version.status !== "draft" || month.status !== "draft") {
        throw new AuthError("INVALID_STAFF_SCHEDULE_STATUS", "シフトの状態が正しくありません。", 409);
      }
      const review = evaluateDraftVersion(actor, targetMonth, versionId);
      const { confirmation } = review;
      if (!confirmation.canConfirm) {
        throw new AuthError(
          "SCHEDULE_CONFIRMATION_BLOCKED",
          "このシフトはまだ確定できません。確定前に赤の問題を修正してください。",
          409,
          { review, confirmation },
        );
      }
      if (confirmation.requiresConfirmation && !acknowledgeWarnings) {
        throw new AuthError(
          "SCHEDULE_CONFIRMATION_REQUIRES_ACKNOWLEDGEMENT",
          "確認が必要な項目があります。内容を確認してから確定してください。",
          409,
          { review, confirmation },
        );
      }
      database.prepare(
        `UPDATE staff_schedule_versions
         SET status = 'confirmed', confirmed_by_administrator_id = ?, confirmed_at = ? WHERE id = ?`,
      ).run(actor.id, occurredAt, versionId);
      database.prepare(
        `UPDATE staff_schedule_months
         SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(occurredAt, occurredAt, month.id);
      writeOperation(actor, "staff_schedule_month.confirmed", month.id, targetMonth, {
        versionId,
        confirmation: {
          redCount: confirmation.redCount,
          yellowCount: confirmation.yellowCount,
          warningsAcknowledged: confirmation.yellowCount > 0 && acknowledgeWarnings,
        },
        occurredAt,
      });
    });
    return scheduleDashboard(actor, { targetMonth });
  }

  function createRevisionDraft(actor, input = {}) {
    requirePermission(actor, "staff-schedule:manage");
    const targetMonth = requiredTargetMonth(input.targetMonth);
    const month = requireMonth(targetMonth);
    if (!month.current_version_id) throw new AuthError("STAFF_SCHEDULE_VERSION_NOT_FOUND", "修正元のシフトがありません。", 404);
    const source = requireVersion(month.id, month.current_version_id);
    if (source.status !== "confirmed" || month.status !== "confirmed") {
      throw new AuthError("STAFF_SCHEDULE_DRAFT_EXISTS", "現在の作成中シフトを先に確認してください。", 409);
    }
    const nextVersionNumber = Number(database.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number FROM staff_schedule_versions WHERE schedule_month_id = ?",
    ).get(month.id).next_number);
    const versionId = randomUUID();
    const occurredAt = timestamp();
    transaction(database, () => {
      database.prepare(
        `INSERT INTO staff_schedule_versions
         (id, schedule_month_id, version_number, source, status, source_version_id,
          created_by_administrator_id, confirmed_by_administrator_id, confirmed_at, created_at)
         VALUES (?, ?, ?, 'manual', 'draft', ?, ?, NULL, NULL, ?)`,
      ).run(versionId, month.id, nextVersionNumber, source.id, actor.id, occurredAt);
      const sourceDays = loadDays(source.id);
      const insertDay = database.prepare(
        `INSERT INTO staff_schedule_days
         (id, version_id, staff_id, date, day_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSegment = database.prepare(
        `INSERT INTO staff_schedule_segments
         (id, schedule_day_id, start_time, end_time, activity_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const day of sourceDays) {
        const dayId = randomUUID();
        insertDay.run(dayId, versionId, day.staffId, day.date, day.dayType, occurredAt, occurredAt);
        for (const segment of day.segments) {
          insertSegment.run(randomUUID(), dayId, segment.startTime, segment.endTime, segment.activityType, occurredAt, occurredAt);
        }
      }
      database.prepare(
        `UPDATE staff_schedule_months
         SET status = 'draft', current_version_id = ?, confirmed_at = NULL, updated_at = ? WHERE id = ?`,
      ).run(versionId, occurredAt, month.id);
      writeOperation(actor, "staff_schedule_month.revision_started", month.id, targetMonth, {
        sourceVersionId: source.id,
        versionId,
        versionNumber: nextVersionNumber,
        occurredAt,
      });
    });
    return scheduleDashboard(actor, { targetMonth });
  }

  return {
    confirmMonthlySchedule,
    createAutomaticMonthlyDraft,
    createMonthlySchedule,
    createRevisionDraft,
    previewAutomaticMonthlyDraft,
    recheckCurrentDraft,
    saveScheduleDay,
    saveStaffPreference,
    scheduleDashboard,
    staffPreferencesForMonth,
  };
}
