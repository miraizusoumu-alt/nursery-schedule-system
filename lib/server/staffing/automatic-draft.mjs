import {
  calculateScheduleDayWorkMinutes,
  StaffScheduleValidationError,
  validateScheduleDay,
} from "./scheduled-work.mjs";

const AUTOMATIC_ACTIVITY_TYPES = new Set(["childcare", "break"]);
const DAY_OFF_STAFFING_ISSUE_CODES = new Set([
  "CHILDCARE_STAFF_SHORTAGE_AFTER_DAY_OFF_PLAN",
  "LICENSED_STAFF_SHORTAGE_AFTER_DAY_OFF_PLAN",
]);
const PREVIEW_EXCLUSION_REASON_LABELS = Object.freeze({
  NOT_EMPLOYED_ON_DATE: "在籍期間外です",
  INACTIVE: "在籍終了の職員です",
  NO_ACTIVE_WORK_CONDITION: "有効な勤務条件がありません",
  AMBIGUOUS_WORK_CONDITION: "勤務条件の有効期間が重複しています",
  PREFERENCE_DAY_OFF: "希望休です",
  OUTSIDE_PREFERENCE_TIME: "希望勤務時間外です",
  WEEKDAY_NOT_AVAILABLE: "この曜日は勤務不可です",
  OUTSIDE_AVAILABLE_TIME: "基本勤務可能時間外です",
  NO_VALID_CHILDCARE_CREDENTIAL: "保育に必要な資格・研修がありません",
  MISSING_REQUIRED_ROLE: "必要な担当区分を満たしていません",
  MISSING_REQUIRED_QUALIFICATION: "必要な資格・研修を満たしていません",
  EXISTING_DAY_OFF: "公休です",
  EXISTING_PAID_LEAVE: "有給です",
  EXISTING_NON_WORK_OTHER: "非勤務の「その他」です",
  EXISTING_NON_WORK_DAY: "既存の非勤務日です",
  CONSECUTIVE_WORK_LIMIT: "7連勤になるため配置できません",
  DAILY_WORK_LIMIT: "日次勤務時間の上限に達しています",
  MONTHLY_WORK_LIMIT: "月間勤務時間の上限に達しています",
  EXISTING_BREAK_SEGMENT: "この時間は休憩中です",
  EXISTING_OTHER_WORK_SEGMENT: "この時間は別の業務が登録されています",
  LICENSE_NOT_VALID: "有効な保育士資格がありません",
});
const PREVIEW_EXCLUSION_REASON_ORDER = Object.keys(PREVIEW_EXCLUSION_REASON_LABELS);
const BREAK_REASON_LABELS = Object.freeze({
  BREAK_COVERAGE_UNAVAILABLE: "一般の交代要員を確保できません",
  QUALIFIED_BREAK_COVERAGE_UNAVAILABLE: "保育士資格者の交代要員を確保できません",
  CONTIGUOUS_BREAK_UNAVAILABLE: "連続した休憩時間を確保できません",
});

export function automaticPreviewExclusionReasonLabel(code) {
  return PREVIEW_EXCLUSION_REASON_LABELS[code] ?? code;
}

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

function mergeContiguousShortages(entries, shortageKey) {
  const sorted = entries
    .filter((entry) => Number(entry[shortageKey]) > 0)
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.date.localeCompare(right.date)
      || left.startTime.localeCompare(right.startTime)
      || Number(left[shortageKey]) - Number(right[shortageKey]));
  const merged = [];
  for (const entry of sorted) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.date === entry.date
      && previous.endTime === entry.startTime
      && Number(previous[shortageKey]) === Number(entry[shortageKey])
    ) {
      previous.endTime = entry.endTime;
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

function normalizedPreviewReasonCode(evaluation, code) {
  if (code !== "EXISTING_NON_WORK_DAY") return code;
  if (evaluation.existingScheduleDayType === "day_off") return "EXISTING_DAY_OFF";
  if (evaluation.existingScheduleDayType === "paid_leave") return "EXISTING_PAID_LEAVE";
  if (evaluation.existingScheduleDayType === "other") return "EXISTING_NON_WORK_OTHER";
  return code;
}

function exclusionReasonCounts(slot, kind) {
  const assignedStaffIds = new Set((slot?.assignedStaff ?? []).map((entry) => entry.staffId));
  const counts = new Map();
  for (const evaluation of slot?.candidateEvaluations ?? []) {
    if (assignedStaffIds.has(evaluation.staffId)) continue;
    const codes = new Set((evaluation.exclusionReasons ?? []).map((code) => {
      return normalizedPreviewReasonCode(evaluation, code);
    }));
    if (kind === "licensed" && !evaluation.isLicensedNurseryTeacher) {
      codes.add("LICENSE_NOT_VALID");
    }
    for (const code of codes) {
      if (!PREVIEW_EXCLUSION_REASON_LABELS[code]) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return PREVIEW_EXCLUSION_REASON_ORDER.flatMap((code) => {
    const count = counts.get(code) ?? 0;
    return count > 0 ? [{ code, label: PREVIEW_EXCLUSION_REASON_LABELS[code], count }] : [];
  });
}

function detailedStaffingIssue(entry, slot, kind) {
  const requiredChildcareWorkers = Number(
    slot?.requiredChildcareWorkers
      ?? entry.requiredChildcareWorkers
      ?? (entry.assignedChildcareWorkerCount ?? 0) + (entry.childcareWorkerShortage ?? 0),
  );
  const assignedChildcareWorkerCount = Number(
    slot?.assignedChildcareWorkerCount
      ?? entry.assignedChildcareWorkerCount
      ?? requiredChildcareWorkers - Number(entry.childcareWorkerShortage ?? 0),
  );
  const requiredLicensedNurseryTeachers = Number(
    slot?.requiredLicensedNurseryTeachers
      ?? entry.requiredLicensedNurseryTeachers
      ?? (entry.assignedLicensedNurseryTeacherCount ?? 0)
        + (entry.licensedNurseryTeacherShortage ?? 0),
  );
  const assignedLicensedNurseryTeacherCount = Number(
    slot?.assignedLicensedNurseryTeacherCount
      ?? entry.assignedLicensedNurseryTeacherCount
      ?? requiredLicensedNurseryTeachers - Number(entry.licensedNurseryTeacherShortage ?? 0),
  );
  const evaluations = slot?.candidateEvaluations ?? [];
  return {
    ...entry,
    requiredChildcareWorkers,
    assignedChildcareWorkerCount,
    childcareWorkerShortage: Math.max(0, requiredChildcareWorkers - assignedChildcareWorkerCount),
    requiredLicensedNurseryTeachers,
    assignedLicensedNurseryTeacherCount,
    licensedNurseryTeacherShortage: Math.max(
      0,
      requiredLicensedNurseryTeachers - assignedLicensedNurseryTeacherCount,
    ),
    eligibleChildcareWorkerCandidateCount: evaluations.filter((evaluation) => {
      return evaluation.automaticPlacementEligible;
    }).length,
    eligibleLicensedNurseryTeacherCandidateCount: evaluations.filter((evaluation) => {
      return evaluation.automaticPlacementEligible && evaluation.isLicensedNurseryTeacher;
    }).length,
    candidateStaffCount: evaluations.length,
    exclusionReasons: exclusionReasonCounts(slot, kind),
  };
}

function comparableIssueDetails(issue) {
  const copy = { ...issue };
  delete copy.date;
  delete copy.startTime;
  delete copy.endTime;
  return JSON.stringify(copy);
}

function mergeDetailedStaffingIssues(entries, shortageKey) {
  const sorted = entries.sort((left, right) => left.date.localeCompare(right.date)
    || left.startTime.localeCompare(right.startTime));
  const merged = [];
  for (const entry of sorted) {
    const previous = merged.at(-1);
    if (previous
      && previous.date === entry.date
      && previous.endTime === entry.startTime
      && comparableIssueDetails(previous) === comparableIssueDetails(entry)) {
      previous.endTime = entry.endTime;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged.filter((entry) => Number(entry[shortageKey]) > 0);
}

function detailedStaffingIssues(generationResult, unresolved, shortageKey, kind) {
  const slots = generationResult?.placement?.slots ?? generationResult?.breakPlan?.placement?.slots ?? [];
  const slotByKey = new Map(slots.map((slot) => [`${slot.date}\u0000${slot.startTime}`, slot]));
  const detailed = unresolved.staffingShortages
    .filter((entry) => Number(entry[shortageKey]) > 0)
    .map((entry) => detailedStaffingIssue(
      entry,
      slotByKey.get(`${entry.date}\u0000${entry.startTime}`),
      kind,
    ));
  return mergeDetailedStaffingIssues(detailed, shortageKey);
}

function breakWorkWindow(generationResult, staffId, date) {
  const segments = (generationResult?.scheduleSegments ?? []).filter((segment) => {
    return segment.staffId === staffId && segment.date === date && segment.activityType !== "break";
  }).sort((left, right) => left.startTime.localeCompare(right.startTime));
  return segments.length > 0 ? {
    workStartTime: segments[0].startTime,
    workEndTime: segments.at(-1).endTime,
  } : { workStartTime: null, workEndTime: null };
}

function enrichBreakIssues(entries, profiles, generationResult) {
  const outcomes = new Map((generationResult?.breakPlan?.breakOutcomes ?? []).map((outcome) => [
    `${outcome.staffId}\u0000${outcome.date}`,
    outcome,
  ]));
  return enrichStaffIssues(entries, profiles).map((entry) => {
    const outcome = outcomes.get(`${entry.staffId}\u0000${entry.date}`);
    const code = outcome?.unresolvedReasonCode ?? entry.code;
    return {
      ...entry,
      requiredBreakMinutes: outcome?.requiredBreakMinutes ?? entry.requiredBreakMinutes ?? 0,
      ...breakWorkWindow(generationResult, entry.staffId, entry.date),
      unresolvedReasonLabel: BREAK_REASON_LABELS[code] ?? "休憩を安全に配置できません",
      generalReliefUnavailable: code === "BREAK_COVERAGE_UNAVAILABLE",
      qualifiedReliefUnavailable: code === "QUALIFIED_BREAK_COVERAGE_UNAVAILABLE",
    };
  });
}

function enrichStaffIssues(entries, profiles) {
  return entries.map((entry) => {
    const profile = entry.staffId ? profiles.get(entry.staffId) : null;
    return profile ? { ...entry, staffCode: profile.staffCode, staffName: profile.name } : entry;
  });
}

export function buildAutomaticSchedulePreview({
  targetMonth,
  days,
  staffProfiles,
  requirementSource,
  unresolved,
  generationResult = null,
}) {
  const month = assertTargetMonth(targetMonth);
  const profiles = staffMap(staffProfiles);
  const previewDays = days.map((day) => {
    const profile = profiles.get(day.staffId);
    const validated = validateScheduleDay(day);
    return {
      staffId: day.staffId,
      staffCode: profile.staffCode,
      staffName: profile.name,
      date: day.date,
      dayType: day.dayType,
      segments: validated.segments.map(({ startTime, endTime, activityType }) => ({
        startTime,
        endTime,
        activityType,
      })),
      scheduledWorkMinutes: calculateScheduleDayWorkMinutes(validated),
    };
  }).sort((left, right) => left.date.localeCompare(right.date)
    || left.staffCode.localeCompare(right.staffCode)
    || left.staffId.localeCompare(right.staffId));
  const consecutiveWork = enrichStaffIssues(
    unresolved.daysOff.filter((entry) => entry.code === "CONSECUTIVE_WORK_LIMIT_UNRESOLVED"),
    profiles,
  );
  const daysOff = enrichStaffIssues(
    unresolved.daysOff.filter((entry) => entry.code !== "CONSECUTIVE_WORK_LIMIT_UNRESOLVED"
      && !DAY_OFF_STAFFING_ISSUE_CODES.has(entry.code)),
    profiles,
  );
  const childcareStaffing = generationResult
    ? detailedStaffingIssues(
      generationResult,
      unresolved,
      "childcareWorkerShortage",
      "childcare",
    )
    : mergeContiguousShortages(unresolved.staffingShortages, "childcareWorkerShortage");
  const licensedStaffing = generationResult
    ? detailedStaffingIssues(
      generationResult,
      unresolved,
      "licensedNurseryTeacherShortage",
      "licensed",
    )
    : mergeContiguousShortages(unresolved.staffingShortages, "licensedNurseryTeacherShortage");
  const issues = {
    childcareStaffing,
    licensedStaffing,
    daysOff,
    consecutiveWork,
    breaks: generationResult
      ? enrichBreakIssues(unresolved.breaks, profiles, generationResult)
      : enrichStaffIssues(unresolved.breaks, profiles),
  };
  return {
    targetMonth: month,
    sourcePeriod: requirementSource.period,
    requirementSlotCount: requirementSource.slots.length,
    days: previewDays,
    issues,
    hasUnresolved: Object.values(issues).some((entries) => entries.length > 0),
  };
}
