export const STAFF_SCHEDULE_DAY_TYPES = Object.freeze(["work", "day_off", "paid_leave", "other"]);
export const STAFF_SCHEDULE_ACTIVITY_TYPES = Object.freeze([
  "childcare",
  "break",
  "administration",
  "training",
  "meal_service",
  "other_work",
]);
export const STAFF_SCHEDULE_WEEK_STARTS_ON = 1;
export const FULL_TIME_REQUIRED_DAYS_OFF = 9;
export const FULL_TIME_DAILY_MINUTES = 8 * 60;
export const MAX_CONSECUTIVE_WORK_DAYS = 6;

const WORK_ACTIVITY_TYPES = new Set(STAFF_SCHEDULE_ACTIVITY_TYPES.filter((activityType) => activityType !== "break"));
const DAY_TYPE_SET = new Set(STAFF_SCHEDULE_DAY_TYPES);
const ACTIVITY_TYPE_SET = new Set(STAFF_SCHEDULE_ACTIVITY_TYPES);
const DEFAULT_START_MINUTES = 6 * 60 + 30;
const DEFAULT_END_MINUTES = 20 * 60 + 30;

export class StaffScheduleValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaffScheduleValidationError";
    this.code = code;
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function assertDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new StaffScheduleValidationError("INVALID_DATE", "日付はYYYY-MM-DD形式で指定してください。");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new StaffScheduleValidationError("INVALID_DATE", "実在する日付を指定してください。");
  }
  return value;
}

function assertTargetMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) {
    throw new StaffScheduleValidationError("INVALID_TARGET_MONTH", "対象月はYYYY-MM形式で指定してください。");
  }
  const [year, month] = value.split("-").map(Number);
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new StaffScheduleValidationError("INVALID_TARGET_MONTH", "対象月が正しくありません。");
  }
  return { year, month };
}

function timeToMinutes(value, label) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    throw new StaffScheduleValidationError("INVALID_TIME", `${label}はHH:mm形式で指定してください。`);
  }
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59 || minutes % 15 !== 0) {
    throw new StaffScheduleValidationError("INVALID_TIME", `${label}は15分単位で指定してください。`);
  }
  return hours * 60 + minutes;
}

function dateFromKey(value) {
  assertDateKey(value);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(value) {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

export function countsAsScheduledWork(activityType) {
  if (!ACTIVITY_TYPE_SET.has(activityType)) {
    throw new StaffScheduleValidationError("INVALID_ACTIVITY_TYPE", "勤務区分が正しくありません。");
  }
  return WORK_ACTIVITY_TYPES.has(activityType);
}

export function validateScheduleTimeRange(startTime, endTime, options = {}) {
  const minimum = timeToMinutes(options.minimumTime ?? "06:30", "勤務可能開始時刻");
  const maximum = timeToMinutes(options.maximumTime ?? "20:30", "勤務可能終了時刻");
  if (minimum >= maximum) throw new StaffScheduleValidationError("INVALID_TIME_RANGE", "勤務可能時間の範囲が正しくありません。");
  const startMinutes = timeToMinutes(startTime, "開始時刻");
  const endMinutes = timeToMinutes(endTime, "終了時刻");
  if (startMinutes >= endMinutes) {
    throw new StaffScheduleValidationError("INVALID_TIME_RANGE", "開始時刻は終了時刻より前にしてください。");
  }
  if (startMinutes < minimum || endMinutes > maximum) {
    throw new StaffScheduleValidationError("OUTSIDE_SCHEDULE_RANGE", "勤務時間は06:30から20:30の範囲で指定してください。");
  }
  return { startTime, endTime, startMinutes, endMinutes };
}

export function validateScheduleSegments(segments, options = {}) {
  if (!Array.isArray(segments)) {
    throw new StaffScheduleValidationError("INVALID_SEGMENTS", "勤務区分を配列で指定してください。");
  }
  const normalized = segments.map((segment) => {
    if (!ACTIVITY_TYPE_SET.has(segment?.activityType)) {
      throw new StaffScheduleValidationError("INVALID_ACTIVITY_TYPE", "勤務区分が正しくありません。");
    }
    const { startMinutes, endMinutes } = validateScheduleTimeRange(segment.startTime, segment.endTime, options);
    return { ...segment, startMinutes, endMinutes };
  }).sort((left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes);

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startMinutes < normalized[index - 1].endMinutes) {
      throw new StaffScheduleValidationError("TIME_RANGE_OVERLAP", "同じ職員・日付の勤務区分が重複しています。");
    }
  }
  return normalized;
}

export function validateScheduleDay(day, options = {}) {
  assertDateKey(day?.date);
  if (!DAY_TYPE_SET.has(day?.dayType)) {
    throw new StaffScheduleValidationError("INVALID_DAY_TYPE", "日別シフト区分が正しくありません。");
  }
  const segments = validateScheduleSegments(day.segments ?? [], options);
  if ((day.dayType === "day_off" || day.dayType === "paid_leave") && segments.length > 0) {
    throw new StaffScheduleValidationError("NON_WORK_DAY_HAS_SEGMENTS", "公休・有給の日には勤務区分を登録できません。");
  }
  return { ...day, segments };
}

export function calculateDailyScheduledWorkMinutes(segments, options = {}) {
  return validateScheduleSegments(segments, options).reduce(
    (total, segment) => total + (countsAsScheduledWork(segment.activityType) ? segment.endMinutes - segment.startMinutes : 0),
    0,
  );
}

export function calculateScheduleDayWorkMinutes(day, options = {}) {
  const validated = validateScheduleDay(day, options);
  if (validated.dayType === "day_off" || validated.dayType === "paid_leave") return 0;
  return calculateDailyScheduledWorkMinutes(validated.segments, options);
}

export function calculateMonthlyScheduledWorkMinutes(days, options = {}) {
  if (!Array.isArray(days)) throw new StaffScheduleValidationError("INVALID_DAYS", "日別シフトを配列で指定してください。");
  return days
    .filter((day) => !options.staffId || day.staffId === options.staffId)
    .reduce((total, day) => {
      return total + calculateScheduleDayWorkMinutes(day, options);
    }, 0);
}

export function calculateWeeklyScheduledWorkMinutes(days, options = {}) {
  if (!Number.isInteger(options.weekStartsOn) || options.weekStartsOn < 0 || options.weekStartsOn > 6) {
    throw new StaffScheduleValidationError("WEEK_START_REQUIRED", "週の開始曜日を0（日曜）から6（土曜）で明示してください。");
  }
  if (!Array.isArray(days)) throw new StaffScheduleValidationError("INVALID_DAYS", "日別シフトを配列で指定してください。");
  const groups = new Map();
  for (const day of days.filter((entry) => !options.staffId || entry.staffId === options.staffId)) {
    const validated = validateScheduleDay(day, options);
    const date = dateFromKey(validated.date);
    const offset = (date.getUTCDay() - options.weekStartsOn + 7) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    const weekStart = dateKey(date);
    const scheduledWorkMinutes = calculateScheduleDayWorkMinutes(validated, options);
    groups.set(weekStart, (groups.get(weekStart) ?? 0) + scheduledWorkMinutes);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([weekStart, scheduledWorkMinutes]) => ({ weekStart, scheduledWorkMinutes }));
}

export function summarizeScheduleDays(days, options = {}) {
  const summary = { workDays: 0, dayOffDays: 0, paidLeaveDays: 0, otherDays: 0 };
  for (const day of days.filter((entry) => !options.staffId || entry.staffId === options.staffId)) {
    const validated = validateScheduleDay(day, options);
    if (validated.dayType === "work") summary.workDays += 1;
    else if (validated.dayType === "day_off") summary.dayOffDays += 1;
    else if (validated.dayType === "paid_leave") summary.paidLeaveDays += 1;
    else summary.otherDays += 1;
  }
  return summary;
}

export function calculateFullTimeMonthlyBaseline(targetMonth, options = {}) {
  const { year, month } = assertTargetMonth(targetMonth);
  const requiredDaysOff = options.requiredDaysOff ?? FULL_TIME_REQUIRED_DAYS_OFF;
  const dailyMinutes = options.dailyMinutes ?? FULL_TIME_DAILY_MINUTES;
  if (!Number.isInteger(requiredDaysOff) || requiredDaysOff < 0 || !Number.isInteger(dailyMinutes) || dailyMinutes < 0) {
    throw new StaffScheduleValidationError("INVALID_FULL_TIME_RULE", "常勤の月間勤務時間ルールが正しくありません。");
  }
  const calendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    calendarDays,
    requiredDaysOff,
    basicWorkDays: Math.max(0, calendarDays - requiredDaysOff),
    basicScheduledWorkMinutes: Math.max(0, calendarDays - requiredDaysOff) * dailyMinutes,
  };
}

export function evaluateMonthlyDaysOff(days, options = {}) {
  const summary = summarizeScheduleDays(days, options);
  const requiredDaysOff = options.requiredDaysOff ?? FULL_TIME_REQUIRED_DAYS_OFF;
  const applies = options.employmentType === "常勤";
  const shortageDays = applies ? Math.max(0, requiredDaysOff - summary.dayOffDays) : 0;
  return {
    applies,
    dayOffDays: summary.dayOffDays,
    paidLeaveDays: summary.paidLeaveDays,
    requiredDaysOff: applies ? requiredDaysOff : null,
    shortageDays,
    warning: shortageDays > 0 ? `公休が${shortageDays}日不足しています` : null,
  };
}

function isScheduledWorkDay(day, options = {}) {
  const validated = validateScheduleDay(day, options);
  if (validated.dayType === "work") return true;
  if (validated.dayType !== "other") return false;
  return calculateScheduleDayWorkMinutes(validated, options) > 0;
}

export function calculateConsecutiveWorkWarnings(days, options = {}) {
  if (!Array.isArray(days) || !Array.isArray(options.priorDays ?? [])) {
    throw new StaffScheduleValidationError("INVALID_DAYS", "日別シフトを配列で指定してください。");
  }
  const maxConsecutiveDays = options.maxConsecutiveDays ?? MAX_CONSECUTIVE_WORK_DAYS;
  if (!Number.isInteger(maxConsecutiveDays) || maxConsecutiveDays < 1) {
    throw new StaffScheduleValidationError("INVALID_CONSECUTIVE_RULE", "連続勤務日数のルールが正しくありません。");
  }
  const targetDates = new Set(days.map((day) => day.date));
  const byDate = new Map();
  for (const day of [...(options.priorDays ?? []), ...days]) {
    if (options.staffId && day.staffId !== options.staffId) continue;
    assertDateKey(day.date);
    byDate.set(day.date, day);
  }
  const sorted = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  const warnings = [];
  let streak = 0;
  let streakStart = null;
  let previous = null;
  for (const day of sorted) {
    const currentDate = dateFromKey(day.date);
    if (previous) {
      const expected = new Date(previous.getTime());
      expected.setUTCDate(expected.getUTCDate() + 1);
      if (dateKey(expected) !== day.date) {
        streak = 0;
        streakStart = null;
      }
    }
    if (isScheduledWorkDay(day, options)) {
      streak += 1;
      streakStart ??= day.date;
      if (streak > maxConsecutiveDays && targetDates.has(day.date)) {
        warnings.push({
          startDate: streakStart,
          endDate: day.date,
          consecutiveDays: streak,
          message: `${streak}日連続勤務になっています`,
        });
      }
    } else {
      streak = 0;
      streakStart = null;
    }
    previous = currentDate;
  }
  return warnings;
}

export const STAFF_SCHEDULE_TIME_RANGE = Object.freeze({
  startTime: "06:30",
  endTime: "20:30",
  slotMinutes: 15,
  startMinutes: DEFAULT_START_MINUTES,
  endMinutes: DEFAULT_END_MINUTES,
});
