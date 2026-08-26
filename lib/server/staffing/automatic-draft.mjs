import {
  calculateScheduleDayWorkMinutes,
  StaffScheduleValidationError,
  validateScheduleDay,
} from "./scheduled-work.mjs";

const AUTOMATIC_ACTIVITY_TYPES = new Set(["childcare", "break"]);

function assertTargetMonth(targetMonth) {
  if (typeof targetMonth !== "string" || !/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new StaffScheduleValidationError("INVALID_TARGET_MONTH", "対象月はYYYY-MM形式で指定してください。");
  }
  const month = Number(targetMonth.slice(5));
  if (month < 1 || month > 12) {
    throw new StaffScheduleValidationError("INVALID_TARGET_MONTH", "対象月が正しくありません。");
  }
  return targetMonth;
}

function normalizedDate(value, targetMonth) {
  validateScheduleDay({ date: value, dayType: "work", segments: [] });
  if (!value.startsWith(`${targetMonth}-`)) {
    throw new StaffScheduleValidationError("DATE_OUTSIDE_TARGET_MONTH", "対象月の日付を指定してください。");
  }
  return value;
}

function staffMap(staffProfiles) {
  if (!Array.isArray(staffProfiles)) {
    throw new StaffScheduleValidationError("INVALID_STAFF_PROFILES", "職員候補を配列で指定してください。");
  }
  const result = new Map();
  for (const profile of staffProfiles) {
    if (!profile?.id || result.has(profile.id)) {
      throw new StaffScheduleValidationError("INVALID_STAFF_PROFILES", "職員IDは重複しない値で指定してください。");
    }
    result.set(profile.id, profile);
  }
  return result;
}

function dayKey(staffId, date) {
  return `${staffId}:${date}`;
}

function setNonWorkDay(days, staffId, date, dayType) {
  const key = dayKey(staffId, date);
  const existing = days.get(key);
  if (existing && existing.dayType !== dayType) {
    throw new StaffScheduleValidationError(
      "AUTOMATIC_DAY_STATE_CONFLICT",
      "同じ職員・日付に矛盾する日別状態があります。",
    );
  }
  if (!existing) days.set(key, { staffId, date, dayType, segments: [] });
}

function addWorkSegment(days, staffId, date, segment) {
  const key = dayKey(staffId, date);
  const existing = days.get(key);
  if (existing && existing.dayType !== "work") {
    throw new StaffScheduleValidationError(
      "AUTOMATIC_NON_WORK_DAY_HAS_SEGMENTS",
      "公休・有給・非勤務日へ勤務区間を保存できません。",
    );
  }
  const day = existing ?? { staffId, date, dayType: "work", segments: [] };
  day.segments.push(segment);
  days.set(key, day);
}

function protectedDaysForTargetMonth(profiles, targetMonth, days) {
  for (const profile of profiles.values()) {
    for (const rawDay of profile.scheduledDays ?? []) {
      if (!rawDay?.date?.startsWith(`${targetMonth}-`)) continue;
      const day = validateScheduleDay(rawDay);
      const isProtectedOther = day.dayType === "other" && calculateScheduleDayWorkMinutes(day) === 0;
      if (day.dayType === "day_off" || day.dayType === "paid_leave" || isProtectedOther) {
        setNonWorkDay(days, profile.id, day.date, day.dayType);
      }
    }
  }
}

export function buildAutomaticScheduleDraft({ targetMonth, generationResult, staffProfiles }) {
  const month = assertTargetMonth(targetMonth);
  if (!generationResult || generationResult.targetMonth !== month) {
    throw new StaffScheduleValidationError(
      "AUTOMATIC_TARGET_MONTH_MISMATCH",
      "自動計算結果の対象月が一致しません。",
    );
  }
  const profiles = staffMap(staffProfiles);
  const days = new Map();
  protectedDaysForTargetMonth(profiles, month, days);

  const staffPlans = generationResult.daysOffPlan?.staffPlans;
  if (!Array.isArray(staffPlans)) {
    throw new StaffScheduleValidationError("INVALID_AUTOMATIC_RESULT", "自動公休計画が正しくありません。");
  }
  for (const plan of staffPlans) {
    if (!profiles.has(plan?.staffId) || !Array.isArray(plan.finalPlannedDaysOff)) {
      throw new StaffScheduleValidationError("INVALID_AUTOMATIC_RESULT", "自動公休計画の職員情報が正しくありません。");
    }
    for (const rawDate of plan.finalPlannedDaysOff) {
      setNonWorkDay(days, plan.staffId, normalizedDate(rawDate, month), "day_off");
    }
  }

  if (!Array.isArray(generationResult.scheduleSegments)) {
    throw new StaffScheduleValidationError("INVALID_AUTOMATIC_RESULT", "自動勤務区間が正しくありません。");
  }
  for (const rawSegment of generationResult.scheduleSegments) {
    if (!profiles.has(rawSegment?.staffId)) {
      throw new StaffScheduleValidationError("INVALID_AUTOMATIC_RESULT", "自動勤務区間の職員情報が正しくありません。");
    }
    if (!AUTOMATIC_ACTIVITY_TYPES.has(rawSegment.activityType)) {
      throw new StaffScheduleValidationError(
        "INVALID_AUTOMATIC_ACTIVITY_TYPE",
        "自動生成では保育・休憩以外の勤務区分を保存できません。",
      );
    }
    const date = normalizedDate(rawSegment.date, month);
    addWorkSegment(days, rawSegment.staffId, date, {
      startTime: rawSegment.startTime,
      endTime: rawSegment.endTime,
      activityType: rawSegment.activityType,
    });
  }

  return [...days.values()].map((rawDay) => {
    const day = validateScheduleDay(rawDay);
    return {
      staffId: day.staffId,
      date: day.date,
      dayType: day.dayType,
      segments: day.segments.map(({ startTime, endTime, activityType }) => ({
        startTime,
        endTime,
        activityType,
      })),
    };
  }).sort((left, right) => left.staffId.localeCompare(right.staffId)
    || left.date.localeCompare(right.date));
}

export function automaticGenerationUnresolved(generationResult) {
  const staffingShortages = Array.isArray(generationResult?.shortages) ? generationResult.shortages : [];
  const daysOff = Array.isArray(generationResult?.daysOffPlan?.unresolvedConstraints)
    ? generationResult.daysOffPlan.unresolvedConstraints
    : [];
  const breaks = Array.isArray(generationResult?.breakPlan?.unresolvedConstraints)
    ? generationResult.breakPlan.unresolvedConstraints
    : [];
  return {
    staffingShortages,
    daysOff,
    breaks,
    hasUnresolved: staffingShortages.length > 0 || daysOff.length > 0 || breaks.length > 0,
  };
}
