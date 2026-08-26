import { resolveRequiredBreakMinutes } from "./break-requirements.mjs";
import { FULL_TIME_DAILY_MINUTES, validateScheduleDay } from "./scheduled-work.mjs";

export const DAILY_WORK_LIMIT_REASON = "DAILY_WORK_LIMIT";
export const MONTHLY_WORK_LIMIT_REASON = "MONTHLY_WORK_LIMIT";

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label}は0以上の整数で指定してください。`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label}は1以上の整数で指定してください。`);
  }
  return value;
}

export function staffDateWorkKey(staffId, date) {
  return `${staffId}\u0000${date}`;
}

export function normalizeAutomaticWorkLimitProfiles(profiles, staffIds) {
  if (profiles === undefined) return new Map();
  if (!Array.isArray(profiles)) {
    throw new TypeError("自動勤務時間上限情報を配列で指定してください。");
  }
  const normalized = new Map();
  for (const profile of profiles) {
    if (!staffIds.has(profile?.staffId) || normalized.has(profile.staffId)) {
      throw new TypeError("自動勤務時間上限情報には重複しない職員IDを指定してください。");
    }
    const existingDays = new Map();
    for (const day of profile.existingDays ?? []) {
      validateScheduleDay({ date: day?.date, dayType: "work", segments: [] });
      if (existingDays.has(day.date)) {
        throw new TypeError("自動勤務時間上限情報の日付が重複しています。");
      }
      existingDays.set(day.date, {
        date: day.date,
        scheduledWorkMinutes: nonNegativeInteger(
          day.scheduledWorkMinutes,
          "既存の予定実労働時間",
        ),
        breakMinutes: nonNegativeInteger(day.breakMinutes ?? 0, "既存の休憩時間"),
      });
    }
    normalized.set(profile.staffId, {
      staffId: profile.staffId,
      dailyLimitMinutes: positiveInteger(
        profile.dailyLimitMinutes ?? FULL_TIME_DAILY_MINUTES,
        "日次予定実労働時間上限",
      ),
      monthlyLimitMinutes: profile.monthlyLimitMinutes === null
        || profile.monthlyLimitMinutes === undefined
        ? null
        : positiveInteger(profile.monthlyLimitMinutes, "月間予定実労働時間上限"),
      existingDays,
    });
  }
  return normalized;
}

export function serializeAutomaticWorkLimitProfiles(profiles) {
  return [...profiles.values()].map((profile) => ({
    staffId: profile.staffId,
    dailyLimitMinutes: profile.dailyLimitMinutes,
    monthlyLimitMinutes: profile.monthlyLimitMinutes,
    existingDays: [...profile.existingDays.values()].sort((left, right) => {
      return left.date.localeCompare(right.date);
    }),
  })).sort((left, right) => left.staffId.localeCompare(right.staffId));
}

function generatedMinutesForStaffDate(generatedMinutes, staffId, date) {
  return generatedMinutes.get(staffDateWorkKey(staffId, date)) ?? 0;
}

export function addGeneratedWorkMinutes(generatedMinutes, staffId, date, deltaMinutes) {
  if (!(generatedMinutes instanceof Map)) {
    throw new TypeError("自動生成勤務時間はMapで指定してください。");
  }
  if (!Number.isInteger(deltaMinutes)) {
    throw new TypeError("自動生成勤務時間の増減は整数分で指定してください。");
  }
  const key = staffDateWorkKey(staffId, date);
  const next = (generatedMinutes.get(key) ?? 0) + deltaMinutes;
  if (next < 0) throw new RangeError("自動生成勤務時間を0分未満にできません。");
  if (next === 0) generatedMinutes.delete(key);
  else generatedMinutes.set(key, next);
}

function anticipatedGeneratedBreakMinutes(profile, date, generatedMinutes, breakUnavailableStaffDates) {
  if (generatedMinutes === 0 || breakUnavailableStaffDates?.has(staffDateWorkKey(profile.staffId, date))) {
    return 0;
  }
  const existing = profile.existingDays.get(date) ?? {
    scheduledWorkMinutes: 0,
    breakMinutes: 0,
  };
  const requiredBreakMinutes = resolveRequiredBreakMinutes(
    existing.scheduledWorkMinutes + generatedMinutes,
  );
  // Existing breaks are preserved and remove their overlapping generated childcare slots.
  // An insufficient existing break is still not extended with a second split interval.
  if (existing.breakMinutes > 0) return Math.min(existing.breakMinutes, generatedMinutes);
  return requiredBreakMinutes;
}

export function projectedDailyAutomaticWorkMinutes(
  profile,
  generatedMinutes,
  date,
  options = {},
) {
  const generated = generatedMinutesForStaffDate(generatedMinutes, profile.staffId, date);
  const existing = profile.existingDays.get(date)?.scheduledWorkMinutes ?? 0;
  return existing + generated - anticipatedGeneratedBreakMinutes(
    profile,
    date,
    generated,
    options.breakUnavailableStaffDates,
  );
}

export function projectedMonthlyAutomaticWorkMinutes(profile, generatedMinutes, options = {}) {
  const dates = new Set(profile.existingDays.keys());
  for (const key of generatedMinutes.keys()) {
    const [staffId, date] = key.split("\u0000");
    if (staffId === profile.staffId) dates.add(date);
  }
  return [...dates].reduce((total, date) => {
    return total + projectedDailyAutomaticWorkMinutes(profile, generatedMinutes, date, options);
  }, 0);
}

export function evaluateAutomaticWorkLimitAssignment({
  profile,
  generatedMinutes,
  date,
  additionalMinutes = 15,
  breakUnavailableStaffDates,
}) {
  if (!profile) {
    return {
      eligible: true,
      exclusionReasons: [],
      projectedDailyScheduledWorkMinutes: null,
      projectedMonthlyScheduledWorkMinutes: null,
    };
  }
  nonNegativeInteger(additionalMinutes, "追加予定実労働時間");
  const proposed = new Map(generatedMinutes);
  addGeneratedWorkMinutes(proposed, profile.staffId, date, additionalMinutes);
  const options = { breakUnavailableStaffDates };
  const projectedDailyScheduledWorkMinutes = projectedDailyAutomaticWorkMinutes(
    profile,
    proposed,
    date,
    options,
  );
  const projectedMonthlyScheduledWorkMinutes = projectedMonthlyAutomaticWorkMinutes(
    profile,
    proposed,
    options,
  );
  const exclusionReasons = [];
  if (projectedDailyScheduledWorkMinutes > profile.dailyLimitMinutes) {
    exclusionReasons.push(DAILY_WORK_LIMIT_REASON);
  }
  if (profile.monthlyLimitMinutes !== null
    && projectedMonthlyScheduledWorkMinutes > profile.monthlyLimitMinutes) {
    exclusionReasons.push(MONTHLY_WORK_LIMIT_REASON);
  }
  return {
    eligible: exclusionReasons.length === 0,
    exclusionReasons,
    projectedDailyScheduledWorkMinutes,
    projectedMonthlyScheduledWorkMinutes,
    dailyLimitMinutes: profile.dailyLimitMinutes,
    monthlyLimitMinutes: profile.monthlyLimitMinutes,
  };
}
