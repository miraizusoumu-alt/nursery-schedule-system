import {
  calculateScheduleDayWorkMinutes,
  STAFF_SCHEDULE_WEEK_STARTS_ON,
  validateScheduleDay,
} from "./scheduled-work.mjs";

export const PART_TIME_WEEKLY_WORK_LIMIT_REASON = "PART_TIME_WEEKLY_WORK_LIMIT_EXCEEDED";
export const PART_TIME_WEEKLY_WORK_DAYS_LIMIT_REASON = "PART_TIME_WEEKLY_WORK_DAYS_EXCEEDED";
export const PART_TIME_DAILY_WORK_LIMIT_REASON = "PART_TIME_DAILY_WORK_MINUTES_EXCEEDED";
export const PART_TIME_WEEKLY_MINIMUM_DAYS_REASON = "PART_TIME_WEEKLY_MINIMUM_DAYS_UNMET";
export const PART_TIME_DAILY_MINIMUM_REASON = "PART_TIME_DAILY_MINIMUM_MINUTES_UNMET";
export const WEEKLY_WORK_CONTEXT_INCOMPLETE_REASON = "WEEKLY_WORK_CONTEXT_INCOMPLETE";

export const PART_TIME_RULE_LABELS = Object.freeze({
  [PART_TIME_WEEKLY_WORK_LIMIT_REASON]: "非常勤の週勤務時間上限を超えています",
  [PART_TIME_WEEKLY_WORK_DAYS_LIMIT_REASON]: "非常勤の週最大勤務日数を超えています",
  [PART_TIME_DAILY_WORK_LIMIT_REASON]: "非常勤の1日最大勤務時間を超えています",
  [PART_TIME_WEEKLY_MINIMUM_DAYS_REASON]: "非常勤の週希望最低勤務日数に達していません",
  [PART_TIME_DAILY_MINIMUM_REASON]: "非常勤の1日最低勤務時間に達していません",
  [WEEKLY_WORK_CONTEXT_INCOMPLETE_REASON]: "月またぎ週の勤務情報が不足しています",
});

function dateFromKey(value) {
  const validated = validateScheduleDay({ date: value, dayType: "work", segments: [] });
  const [year, month, day] = validated.date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(value) {
  return value.toISOString().slice(0, 10);
}

function monthKey(value) {
  return value.slice(0, 7);
}

export function scheduleWeekStart(date, weekStartsOn = STAFF_SCHEDULE_WEEK_STARTS_ON) {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new TypeError("週の開始曜日を0から6で指定してください。");
  }
  const parsed = dateFromKey(date);
  const offset = (parsed.getUTCDay() - weekStartsOn + 7) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - offset);
  return dateKey(parsed);
}

export function scheduleWeekEnd(date, weekStartsOn = STAFF_SCHEDULE_WEEK_STARTS_ON) {
  const parsed = dateFromKey(scheduleWeekStart(date, weekStartsOn));
  parsed.setUTCDate(parsed.getUTCDate() + 6);
  return dateKey(parsed);
}

export function effectiveWeeklyMinutesLimit(condition) {
  if (condition?.weeklyMinutesLimit === null || condition?.weeklyMinutesLimit === undefined) return null;
  return condition.weeklyMinutesLimitType === "exclusive"
    ? Math.max(0, condition.weeklyMinutesLimit - 15)
    : condition.weeklyMinutesLimit;
}

export function activePartTimeWorkCondition(workConditions, date) {
  const active = (workConditions ?? []).filter((condition) => {
    return condition.validFrom <= date && (!condition.validTo || date <= condition.validTo);
  });
  return active.length === 1 && active[0].employmentType === "非常勤" ? active[0] : null;
}

export function workTimePreferenceForDate(schedulePreferences, date) {
  return (schedulePreferences ?? []).find((preference) => {
    return preference.date === date && preference.preferenceType === "work_time";
  }) ?? null;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value ?? "").split(":").map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) ? hours * 60 + minutes : null;
}

export function partTimeDailyMinimumMinutes(condition, preference) {
  const configured = condition?.dailyWorkMinutesMin ?? null;
  if (configured === null) return null;
  if (preference?.preferenceType !== "work_time") return configured;
  const start = timeToMinutes(preference.startTime);
  const end = timeToMinutes(preference.endTime);
  if (start === null || end === null || start >= end) return configured;
  return Math.min(configured, end - start);
}

export function requiredAdjacentScheduleMonths(targetMonth) {
  if (!/^\d{4}-\d{2}$/.test(targetMonth ?? "")) {
    throw new TypeError("対象月はYYYY-MM形式で指定してください。");
  }
  const [year, month] = targetMonth.split("-").map(Number);
  const firstDate = `${targetMonth}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDate = `${targetMonth}-${String(lastDay).padStart(2, "0")}`;
  const months = new Set();
  const firstWeekStart = scheduleWeekStart(firstDate);
  const lastWeekEnd = scheduleWeekEnd(lastDate);
  if (monthKey(firstWeekStart) !== targetMonth) months.add(monthKey(firstWeekStart));
  if (monthKey(lastWeekEnd) !== targetMonth) months.add(monthKey(lastWeekEnd));
  return [...months].sort();
}

function normalizedDayMinutes(days, summaries) {
  const result = new Map();
  for (const rawDay of days ?? []) {
    const day = validateScheduleDay(rawDay);
    result.set(day.date, (result.get(day.date) ?? 0) + calculateScheduleDayWorkMinutes(day));
  }
  for (const summary of summaries ?? []) {
    if (!Number.isInteger(summary?.scheduledWorkMinutes) || summary.scheduledWorkMinutes < 0) {
      throw new TypeError("日別予定実労働時間は0以上の整数で指定してください。");
    }
    dateFromKey(summary.date);
    result.set(summary.date, (result.get(summary.date) ?? 0) + summary.scheduledWorkMinutes);
  }
  return result;
}

function targetMonthDates(targetMonth) {
  const [year, month] = targetMonth.split("-").map(Number);
  if (!/^\d{4}-\d{2}$/.test(targetMonth ?? "") || month < 1 || month > 12) {
    throw new TypeError("対象月はYYYY-MM形式で指定してください。");
  }
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => {
    return `${targetMonth}-${String(index + 1).padStart(2, "0")}`;
  });
}

function issueBase(profile, code, date) {
  return {
    code,
    label: PART_TIME_RULE_LABELS[code],
    staffId: profile.id,
    staffCode: profile.staffCode,
    staffName: profile.name,
    date,
  };
}

export function evaluatePartTimeScheduleRules({ profile, days = [], dayWorkMinutes = [], targetMonth }) {
  const dayMinutes = normalizedDayMinutes(days, dayWorkMinutes);
  const issues = [];
  const weeklyChecks = new Map();
  const datesInMonth = targetMonthDates(targetMonth);
  for (const date of datesInMonth) {
    const condition = activePartTimeWorkCondition(profile.workConditions, date);
    if (!condition) continue;
    const actualMinutes = dayMinutes.get(date) ?? 0;
    const preference = workTimePreferenceForDate(profile.schedulePreferences, date);
    const minimumMinutes = partTimeDailyMinimumMinutes(condition, preference);
    if (condition.dailyWorkMinutesMax !== null
      && condition.dailyWorkMinutesMax !== undefined
      && actualMinutes > condition.dailyWorkMinutesMax) {
      issues.push({
        ...issueBase(profile, PART_TIME_DAILY_WORK_LIMIT_REASON, date),
        actualMinutes,
        limitMinutes: condition.dailyWorkMinutesMax,
      });
    }
    if (minimumMinutes !== null && actualMinutes > 0 && actualMinutes < minimumMinutes) {
      issues.push({
        ...issueBase(profile, PART_TIME_DAILY_MINIMUM_REASON, date),
        actualMinutes,
        limitMinutes: minimumMinutes,
        preferenceExceptionApplied: minimumMinutes !== condition.dailyWorkMinutesMin,
      });
    }
    const hasWeeklyRules = (condition.weeklyMinutesLimit !== null
      && condition.weeklyMinutesLimit !== undefined)
      || (condition.preferredWeeklyWorkDaysMin !== null
        && condition.preferredWeeklyWorkDaysMin !== undefined)
      || (condition.weeklyWorkDaysMax !== null
        && condition.weeklyWorkDaysMax !== undefined);
    if (!hasWeeklyRules) continue;
    const weekStart = scheduleWeekStart(date);
    const conditionKey = condition.id ?? `${condition.validFrom}:${condition.validTo ?? ""}`;
    weeklyChecks.set(`${weekStart}\u0000${conditionKey}`, { weekStart, condition });
  }

  const availableMonths = new Set(profile.availableScheduleMonths ?? []);
  for (const { weekStart, condition } of weeklyChecks.values()) {
    const weekEnd = scheduleWeekEnd(weekStart);
    const weekEntries = [...dayMinutes.entries()].filter(([date]) => date >= weekStart && date <= weekEnd);
    const actualMinutes = weekEntries.reduce((total, [, minutes]) => total + minutes, 0);
    const actualDays = weekEntries.filter(([, minutes]) => minutes > 0).length;
    const effectiveLimitMinutes = effectiveWeeklyMinutesLimit(condition);
    if (effectiveLimitMinutes !== null && actualMinutes > effectiveLimitMinutes) {
      issues.push({
        ...issueBase(profile, PART_TIME_WEEKLY_WORK_LIMIT_REASON, weekStart),
        weekStart,
        weekEnd,
        actualMinutes,
        limitMinutes: effectiveLimitMinutes,
        configuredLimitMinutes: condition.weeklyMinutesLimit,
        limitType: condition.weeklyMinutesLimitType,
      });
    }
    if (condition.weeklyWorkDaysMax !== null
      && condition.weeklyWorkDaysMax !== undefined
      && actualDays > condition.weeklyWorkDaysMax) {
      issues.push({
        ...issueBase(profile, PART_TIME_WEEKLY_WORK_DAYS_LIMIT_REASON, weekStart),
        weekStart,
        weekEnd,
        actualDays,
        limitDays: condition.weeklyWorkDaysMax,
      });
    }
    const requiredContextMonths = [monthKey(weekStart), monthKey(weekEnd)]
      .filter((month) => month !== targetMonth);
    const missingContextMonths = [...new Set(requiredContextMonths)]
      .filter((month) => !availableMonths.has(month));
    if (missingContextMonths.length > 0) {
      issues.push({
        ...issueBase(profile, WEEKLY_WORK_CONTEXT_INCOMPLETE_REASON, weekStart),
        weekStart,
        weekEnd,
        missingContextMonths,
      });
    } else if (condition.preferredWeeklyWorkDaysMin !== null
      && condition.preferredWeeklyWorkDaysMin !== undefined
      && actualDays < condition.preferredWeeklyWorkDaysMin) {
      issues.push({
        ...issueBase(profile, PART_TIME_WEEKLY_MINIMUM_DAYS_REASON, weekStart),
        weekStart,
        weekEnd,
        actualDays,
        minimumDays: condition.preferredWeeklyWorkDaysMin,
      });
    }
  }
  return issues.sort((left, right) => left.date.localeCompare(right.date)
    || left.code.localeCompare(right.code));
}
