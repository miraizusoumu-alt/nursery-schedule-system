import {
  automaticPreviewExclusionReasonLabel,
  buildAutomaticSchedulePreview,
} from "./automatic-draft.mjs";
import {
  evaluateAutomaticWorkLimitAssignment,
  normalizeAutomaticWorkLimitProfiles,
  staffDateWorkKey,
} from "./automatic-work-limits.mjs";
import { resolveRequiredBreakMinutes } from "./break-requirements.mjs";
import {
  availabilityCandidateCoversRange,
  availabilityCandidatesForDate,
} from "./availability-candidates.mjs";
import { evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot } from "./staff-eligibility.mjs";
import {
  evaluatePartTimeScheduleRules,
  PART_TIME_DAILY_MINIMUM_REASON,
  PART_TIME_DAILY_WORK_LIMIT_REASON,
  PART_TIME_RULE_LABELS,
  PART_TIME_WEEKLY_MINIMUM_DAYS_REASON,
  PART_TIME_WEEKLY_WORK_DAYS_LIMIT_REASON,
  PART_TIME_WEEKLY_WORK_LIMIT_REASON,
  WEEKLY_WORK_CONTEXT_INCOMPLETE_REASON,
} from "./part-time-work-rules.mjs";
import {
  calculateConsecutiveWorkWarnings,
  calculateFullTimeMonthlyBaseline,
  calculateMonthlyScheduledWorkMinutes,
  calculateScheduleDayWorkMinutes,
  evaluateMonthlyDaysOff,
  FULL_TIME_DAILY_MINUTES,
  validateScheduleDay,
  validateScheduleTimeRange,
} from "./scheduled-work.mjs";

const MANUAL_WORK_CONDITION_CODES = new Set([
  "NOT_EMPLOYED_ON_DATE",
  "INACTIVE",
  "NO_ACTIVE_WORK_CONDITION",
  "AMBIGUOUS_WORK_CONDITION",
  "PREFERENCE_DAY_OFF",
  "OUTSIDE_PREFERENCE_TIME",
  "WEEKDAY_NOT_AVAILABLE",
  "OUTSIDE_AVAILABLE_TIME",
  "MISSING_REQUIRED_ROLE",
  "MISSING_REQUIRED_QUALIFICATION",
]);

const REVIEW_REASON_LABELS = Object.freeze({
  ...Object.fromEntries([...MANUAL_WORK_CONDITION_CODES].map((code) => [
    code,
    automaticPreviewExclusionReasonLabel(code),
  ])),
  NO_VALID_CHILDCARE_CREDENTIAL: automaticPreviewExclusionReasonLabel("NO_VALID_CHILDCARE_CREDENTIAL"),
  PREFERRED_WORK_DAY_UNASSIGNED: "希望勤務時間が登録されていますが、勤務がありません",
  DAILY_WORK_LIMIT_EXCEEDED: "日次予定実労働時間が8時間を超えています",
  MONTHLY_WORK_LIMIT_EXCEEDED: "月間予定実労働時間が基本時間を超えています",
  CONSECUTIVE_WORK_LIMIT: "7日以上の連続勤務になっています",
  DAY_OFF_TARGET_UNRESOLVED: "常勤の公休が9日に達していません",
  BREAK_MINUTES_SHORTAGE: "必要な休憩時間を満たしていません",
  BREAK_CHILDCARE_COVERAGE_SHORTAGE: "休憩中の保育従事者が不足しています",
  BREAK_LICENSED_COVERAGE_SHORTAGE: "休憩中の保育士資格者が不足しています",
  MULTIPLE_AVAILABILITY_CANDIDATES_USED: "同じ日に複数の勤務可能時間候補へまたがっています",
  ...PART_TIME_RULE_LABELS,
});

const BLOCKING_WORK_CONDITION_CODES = new Set([
  "NOT_EMPLOYED_ON_DATE",
  "INACTIVE",
  "NO_ACTIVE_WORK_CONDITION",
  "AMBIGUOUS_WORK_CONDITION",
  "MISSING_REQUIRED_ROLE",
  "MISSING_REQUIRED_QUALIFICATION",
  "NO_VALID_CHILDCARE_CREDENTIAL",
  "CONSECUTIVE_WORK_LIMIT",
  PART_TIME_WEEKLY_WORK_LIMIT_REASON,
  PART_TIME_WEEKLY_WORK_DAYS_LIMIT_REASON,
  PART_TIME_DAILY_WORK_LIMIT_REASON,
]);

const WARNING_WORK_CONDITION_CODES = new Set([
  "PREFERENCE_DAY_OFF",
  "OUTSIDE_PREFERENCE_TIME",
  "WEEKDAY_NOT_AVAILABLE",
  "OUTSIDE_AVAILABLE_TIME",
  "PREFERRED_WORK_DAY_UNASSIGNED",
  "DAILY_WORK_LIMIT_EXCEEDED",
  "MONTHLY_WORK_LIMIT_EXCEEDED",
  "DAY_OFF_TARGET_UNRESOLVED",
  "MULTIPLE_AVAILABILITY_CANDIDATES_USED",
  PART_TIME_WEEKLY_MINIMUM_DAYS_REASON,
  PART_TIME_DAILY_MINIMUM_REASON,
  WEEKLY_WORK_CONTEXT_INCOMPLETE_REASON,
]);

const CONFIRMATION_REASON_LABELS = Object.freeze({
  CHILDCARE_STAFFING_SHORTAGE: "保育従事者が不足しています",
  LICENSED_STAFFING_SHORTAGE: "保育士資格者が不足しています",
});

function confirmationIssue(kind, issue, code = issue.code, label = issue.label) {
  return {
    ...issue,
    kind,
    code,
    label: label ?? REVIEW_REASON_LABELS[code] ?? "確認が必要です",
  };
}

function summarizeConfirmationIssues(issues) {
  const byCode = new Map();
  for (const issue of issues) {
    const current = byCode.get(issue.code) ?? { code: issue.code, label: issue.label, count: 0 };
    current.count += 1;
    byCode.set(issue.code, current);
  }
  return [...byCode.values()].sort((left, right) => left.label.localeCompare(right.label, "ja"));
}

export function classifyDraftScheduleConfirmation(review) {
  const redIssues = [
    ...(review.issues?.childcareStaffing ?? []).map((issue) => confirmationIssue(
      "childcareStaffing",
      issue,
      "CHILDCARE_STAFFING_SHORTAGE",
      CONFIRMATION_REASON_LABELS.CHILDCARE_STAFFING_SHORTAGE,
    )),
    ...(review.issues?.licensedStaffing ?? []).map((issue) => confirmationIssue(
      "licensedStaffing",
      issue,
      "LICENSED_STAFFING_SHORTAGE",
      CONFIRMATION_REASON_LABELS.LICENSED_STAFFING_SHORTAGE,
    )),
  ];
  const yellowIssues = [];
  for (const issue of review.issues?.workConditions ?? []) {
    const entry = confirmationIssue("workConditions", issue);
    if (BLOCKING_WORK_CONDITION_CODES.has(issue.code)) redIssues.push(entry);
    else if (WARNING_WORK_CONDITION_CODES.has(issue.code)) yellowIssues.push(entry);
    else yellowIssues.push(entry);
  }
  for (const issue of review.issues?.breaks ?? []) {
    redIssues.push(confirmationIssue("breaks", issue));
  }
  return {
    status: redIssues.length > 0 ? "blocked" : yellowIssues.length > 0 ? "warning" : "ready",
    canConfirm: redIssues.length === 0,
    requiresConfirmation: yellowIssues.length > 0,
    redCount: redIssues.length,
    yellowCount: yellowIssues.length,
    redSummary: summarizeConfirmationIssues(redIssues),
    yellowSummary: summarizeConfirmationIssues(yellowIssues),
    redIssues,
    yellowIssues,
  };
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function durationMinutes(segment) {
  return timeToMinutes(segment.endTime) - timeToMinutes(segment.startTime);
}

function slotKey(date, startTime) {
  return `${date}\u0000${startTime}`;
}

function dayKey(staffId, date) {
  return `${staffId}\u0000${date}`;
}

function segmentCoversSlot(segment, slot) {
  return segment.startTime <= slot.startTime && segment.endTime >= slot.endTime;
}

function employmentTypeForMonth(profile, targetMonth) {
  const [year, month] = targetMonth.split("-").map(Number);
  const endDate = `${targetMonth}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  const startDate = `${targetMonth}-01`;
  const types = [...new Set((profile.workConditions ?? [])
    .filter((condition) => condition.validFrom <= endDate && (!condition.validTo || condition.validTo >= startDate))
    .map((condition) => condition.employmentType))];
  return types.length === 1 ? types[0] : null;
}

function validateRequirementSlot(slot, targetMonth) {
  if (!slot?.date?.startsWith(`${targetMonth}-`)) {
    throw new TypeError("再チェックする必要人数の日付が対象月と一致しません。");
  }
  const range = validateScheduleTimeRange(slot.startTime, slot.endTime);
  if (range.endMinutes - range.startMinutes !== 15) {
    throw new TypeError("再チェックする必要人数は15分単位で指定してください。");
  }
  return {
    ...slot,
    requiredChildcareWorkers: Number(slot.requiredChildcareWorkers ?? 0),
    requiredLicensedNurseryTeachers: Number(slot.requiredLicensedNurseryTeachers ?? 0),
  };
}

function replaceTargetMonthDays(profile, targetMonth, currentDays) {
  return {
    ...profile,
    scheduledDays: [
      ...(profile.scheduledDays ?? []).filter((day) => !day.date.startsWith(`${targetMonth}-`)),
      ...currentDays.filter((day) => day.staffId === profile.id),
    ],
  };
}

function breakMinutes(day) {
  return day.segments
    .filter((segment) => segment.activityType === "break")
    .reduce((total, segment) => total + durationMinutes(segment), 0);
}

function createWorkLimitProfiles(profiles, targetMonth) {
  const staffIds = new Set(profiles.map((profile) => profile.id));
  const baseline = calculateFullTimeMonthlyBaseline(targetMonth).basicScheduledWorkMinutes;
  return normalizeAutomaticWorkLimitProfiles(profiles.map((profile) => ({
    staffId: profile.id,
    targetMonth,
    dailyLimitMinutes: FULL_TIME_DAILY_MINUTES,
    monthlyLimitMinutes: employmentTypeForMonth(profile, targetMonth) === "常勤" ? baseline : null,
    workConditions: profile.workConditions ?? [],
    schedulePreferences: profile.schedulePreferences ?? [],
    availableScheduleMonths: profile.availableScheduleMonths ?? [],
    existingDays: (profile.scheduledDays ?? []).map((day) => ({
      date: day.date,
      scheduledWorkMinutes: calculateScheduleDayWorkMinutes(day),
      breakMinutes: breakMinutes(day),
    })),
  })), staffIds);
}

function occupiedActivity(day, slot) {
  return day?.segments.find((segment) => segmentCoversSlot(segment, slot))?.activityType ?? null;
}

function candidateEvaluation(profile, slot, day, workLimitProfile) {
  const evaluation = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(profile, slot);
  const exclusionReasons = [...evaluation.exclusionReasons];
  const occupied = occupiedActivity(day, slot);
  if (occupied === "break") exclusionReasons.push("EXISTING_BREAK_SEGMENT");
  else if (occupied && occupied !== "childcare") exclusionReasons.push("EXISTING_OTHER_WORK_SEGMENT");
  const limit = evaluateAutomaticWorkLimitAssignment({
    profile: workLimitProfile,
    generatedMinutes: new Map(),
    date: slot.date,
    additionalMinutes: 15,
    breakUnavailableStaffDates: new Set([staffDateWorkKey(profile.id, slot.date)]),
  });
  exclusionReasons.push(...limit.exclusionReasons);
  return {
    ...evaluation,
    exclusionReasons: [...new Set(exclusionReasons)],
    automaticPlacementEligible: evaluation.automaticPlacementEligible
      && !occupied
      && limit.eligible,
  };
}

function assignedCounts(candidateEvaluations, assignedStaffIds) {
  const assigned = candidateEvaluations.filter((evaluation) => assignedStaffIds.has(evaluation.staffId));
  const childcare = assigned.filter((evaluation) => evaluation.isActiveOnDate
    && evaluation.isEligibleChildcareWorker
    && evaluation.meetsRequiredRoleConditions
    && evaluation.meetsRequiredQualificationConditions);
  return {
    assignedChildcareWorkerCount: childcare.length,
    assignedLicensedNurseryTeacherCount: childcare.filter((evaluation) => {
      return evaluation.isLicensedNurseryTeacher;
    }).length,
  };
}

function reviewRequirementSlots({ targetMonth, requirementSlots, profiles, daysByStaffDate, workLimits }) {
  return requirementSlots.map((rawSlot) => {
    const slot = validateRequirementSlot(rawSlot, targetMonth);
    const candidateEvaluations = profiles.map((profile) => candidateEvaluation(
      profile,
      slot,
      daysByStaffDate.get(dayKey(profile.id, slot.date)),
      workLimits.get(profile.id),
    ));
    const assignedStaff = profiles.flatMap((profile) => {
      const day = daysByStaffDate.get(dayKey(profile.id, slot.date));
      return day?.segments.some((segment) => segment.activityType === "childcare" && segmentCoversSlot(segment, slot))
        ? [{ staffId: profile.id }]
        : [];
    });
    const counts = assignedCounts(candidateEvaluations, new Set(assignedStaff.map((entry) => entry.staffId)));
    return {
      ...slot,
      ...counts,
      assignedStaff,
      candidateEvaluations,
      childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - counts.assignedChildcareWorkerCount),
      licensedNurseryTeacherShortage: Math.max(
        0,
        slot.requiredLicensedNurseryTeachers - counts.assignedLicensedNurseryTeacherCount,
      ),
    };
  });
}

function comparableIssue(issue) {
  const copy = { ...issue };
  delete copy.startTime;
  delete copy.endTime;
  return JSON.stringify(copy);
}

function mergeContiguousIssues(issues) {
  const sorted = issues.slice().sort((left, right) => left.date.localeCompare(right.date)
    || (left.staffCode ?? left.staffId ?? "").localeCompare(right.staffCode ?? right.staffId ?? "")
    || left.code.localeCompare(right.code)
    || (left.startTime ?? "").localeCompare(right.startTime ?? ""));
  const merged = [];
  for (const issue of sorted) {
    const previous = merged.at(-1);
    if (previous
      && previous.date === issue.date
      && previous.staffId === issue.staffId
      && previous.code === issue.code
      && previous.endTime === issue.startTime
      && comparableIssue(previous) === comparableIssue(issue)) {
      previous.endTime = issue.endTime;
    } else {
      merged.push({ ...issue });
    }
  }
  return merged;
}

function manualWorkConditionIssues(profiles, currentDays, requirementSlotsByKey, targetMonth) {
  const issues = [];
  for (const profile of profiles) {
    const days = currentDays.filter((day) => day.staffId === profile.id);
    for (const day of days) {
      for (const segment of day.segments.filter((entry) => entry.activityType !== "break")) {
        for (let start = timeToMinutes(segment.startTime); start < timeToMinutes(segment.endTime); start += 15) {
          const startTime = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
          const end = start + 15;
          const endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
          const requirement = requirementSlotsByKey.get(slotKey(day.date, startTime)) ?? {};
          const evaluation = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(profile, {
            date: day.date,
            startTime,
            endTime,
            requiredRoleTypes: requirement.requiredRoleTypes ?? [],
            requiredQualificationTypes: requirement.requiredQualificationTypes ?? [],
          });
          const codes = evaluation.exclusionReasons.filter((code) => {
            return MANUAL_WORK_CONDITION_CODES.has(code)
              || (segment.activityType === "childcare" && code === "NO_VALID_CHILDCARE_CREDENTIAL");
          });
          for (const code of new Set(codes)) {
            issues.push({
              code,
              label: REVIEW_REASON_LABELS[code],
              staffId: profile.id,
              staffCode: profile.staffCode,
              staffName: profile.name,
              date: day.date,
              startTime,
              endTime,
              activityType: segment.activityType,
            });
          }
        }
      }
      const preference = (profile.schedulePreferences ?? []).find((entry) => entry.date === day.date) ?? null;
      if (preference?.preferenceType !== "work_time") {
        const activeConditions = (profile.workConditions ?? []).filter((condition) => {
          return condition.validFrom <= day.date && (!condition.validTo || day.date <= condition.validTo);
        });
        const weekday = new Date(`${day.date}T00:00:00.000Z`).getUTCDay();
        const weeklyAvailability = activeConditions.length === 1
          ? activeConditions[0].availability?.find((entry) => entry.weekday === weekday) ?? null
          : null;
        const candidates = availabilityCandidatesForDate(weeklyAvailability, day.date);
        const workSegments = day.segments.filter((segment) => segment.activityType !== "break");
        const oneCandidateCoversAll = candidates.some((candidate) => workSegments.every((segment) => {
          return availabilityCandidateCoversRange(candidate, segment.startTime, segment.endTime);
        }));
        const everySegmentHasCandidate = workSegments.length > 0 && workSegments.every((segment) => {
          return candidates.some((candidate) => availabilityCandidateCoversRange(
            candidate,
            segment.startTime,
            segment.endTime,
          ));
        });
        if (candidates.length > 1 && everySegmentHasCandidate && !oneCandidateCoversAll) {
          issues.push({
            code: "MULTIPLE_AVAILABILITY_CANDIDATES_USED",
            label: REVIEW_REASON_LABELS.MULTIPLE_AVAILABILITY_CANDIDATES_USED,
            staffId: profile.id,
            staffCode: profile.staffCode,
            staffName: profile.name,
            date: day.date,
            candidateCount: candidates.length,
          });
        }
      }
    }
    for (const preference of profile.schedulePreferences ?? []) {
      if (!preference.date.startsWith(`${targetMonth}-`)
        || preference.preferenceType !== "work_time") continue;
      const day = days.find((entry) => entry.date === preference.date);
      if (!day || calculateScheduleDayWorkMinutes(day) === 0) {
        issues.push({
          code: "PREFERRED_WORK_DAY_UNASSIGNED",
          label: REVIEW_REASON_LABELS.PREFERRED_WORK_DAY_UNASSIGNED,
          staffId: profile.id,
          staffCode: profile.staffCode,
          staffName: profile.name,
          date: preference.date,
          startTime: preference.startTime,
          endTime: preference.endTime,
        });
      }
    }
  }
  return mergeContiguousIssues(issues);
}

function aggregateScheduleRuleIssues(profiles, currentDays, targetMonth) {
  const issues = [];
  const baseline = calculateFullTimeMonthlyBaseline(targetMonth).basicScheduledWorkMinutes;
  for (const profile of profiles) {
    const days = currentDays.filter((day) => day.staffId === profile.id);
    for (const day of days) {
      const scheduledWorkMinutes = calculateScheduleDayWorkMinutes(day);
      if (scheduledWorkMinutes > FULL_TIME_DAILY_MINUTES) {
        issues.push({
          code: "DAILY_WORK_LIMIT_EXCEEDED",
          label: REVIEW_REASON_LABELS.DAILY_WORK_LIMIT_EXCEEDED,
          staffId: profile.id,
          staffCode: profile.staffCode,
          staffName: profile.name,
          date: day.date,
          actualMinutes: scheduledWorkMinutes,
          limitMinutes: FULL_TIME_DAILY_MINUTES,
        });
      }
    }
    const employmentType = employmentTypeForMonth(profile, targetMonth);
    const monthlyMinutes = calculateMonthlyScheduledWorkMinutes(days, { staffId: profile.id });
    if (employmentType === "常勤" && monthlyMinutes > baseline) {
      issues.push({
        code: "MONTHLY_WORK_LIMIT_EXCEEDED",
        label: REVIEW_REASON_LABELS.MONTHLY_WORK_LIMIT_EXCEEDED,
        staffId: profile.id,
        staffCode: profile.staffCode,
        staffName: profile.name,
        date: `${targetMonth}-01`,
        actualMinutes: monthlyMinutes,
        limitMinutes: baseline,
      });
    }
    for (const warning of calculateConsecutiveWorkWarnings(days, {
      staffId: profile.id,
      priorDays: (profile.scheduledDays ?? []).filter((day) => day.date < `${targetMonth}-01`),
    })) {
      issues.push({
        code: "CONSECUTIVE_WORK_LIMIT",
        label: REVIEW_REASON_LABELS.CONSECUTIVE_WORK_LIMIT,
        staffId: profile.id,
        staffCode: profile.staffCode,
        staffName: profile.name,
        date: warning.endDate,
        startDate: warning.startDate,
        consecutiveDays: warning.consecutiveDays,
      });
    }
    const daysOff = evaluateMonthlyDaysOff(days, { staffId: profile.id, employmentType });
    if (daysOff.shortageDays > 0) {
      issues.push({
        code: "DAY_OFF_TARGET_UNRESOLVED",
        label: REVIEW_REASON_LABELS.DAY_OFF_TARGET_UNRESOLVED,
        staffId: profile.id,
        staffCode: profile.staffCode,
        staffName: profile.name,
        date: `${targetMonth}-01`,
        dayOffDays: daysOff.dayOffDays,
        requiredDaysOff: daysOff.requiredDaysOff,
        shortageDays: daysOff.shortageDays,
      });
    }
    issues.push(...evaluatePartTimeScheduleRules({
      profile,
      days: profile.scheduledDays ?? [],
      targetMonth,
    }));
  }
  return issues.sort((left, right) => left.date.localeCompare(right.date)
    || left.staffCode.localeCompare(right.staffCode)
    || left.code.localeCompare(right.code));
}

function workWindow(day) {
  const work = day.segments.filter((segment) => segment.activityType !== "break");
  return work.length ? { workStartTime: work[0].startTime, workEndTime: work.at(-1).endTime } : {
    workStartTime: null,
    workEndTime: null,
  };
}

function breakIssues(profiles, currentDays, reviewedSlots) {
  const slotByKey = new Map(reviewedSlots.map((slot) => [slotKey(slot.date, slot.startTime), slot]));
  const issues = [];
  for (const profile of profiles) {
    for (const day of currentDays.filter((entry) => entry.staffId === profile.id)) {
      const scheduledWorkMinutes = calculateScheduleDayWorkMinutes(day);
      const requiredBreakMinutes = resolveRequiredBreakMinutes(scheduledWorkMinutes);
      const actualBreakMinutes = breakMinutes(day);
      const window = workWindow(day);
      if (actualBreakMinutes < requiredBreakMinutes) {
        issues.push({
          code: "BREAK_MINUTES_SHORTAGE",
          label: REVIEW_REASON_LABELS.BREAK_MINUTES_SHORTAGE,
          staffId: profile.id,
          staffCode: profile.staffCode,
          staffName: profile.name,
          date: day.date,
          requiredBreakMinutes,
          actualBreakMinutes,
          scheduledWorkMinutes,
          ...window,
        });
      }
      for (const segment of day.segments.filter((entry) => entry.activityType === "break")) {
        for (let start = timeToMinutes(segment.startTime); start < timeToMinutes(segment.endTime); start += 15) {
          const startTime = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
          const end = start + 15;
          const endTime = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
          const slot = slotByKey.get(slotKey(day.date, startTime));
          if (!slot) continue;
          if (slot.childcareWorkerShortage > 0) {
            issues.push({
              code: "BREAK_CHILDCARE_COVERAGE_SHORTAGE",
              label: REVIEW_REASON_LABELS.BREAK_CHILDCARE_COVERAGE_SHORTAGE,
              staffId: profile.id,
              staffCode: profile.staffCode,
              staffName: profile.name,
              date: day.date,
              startTime,
              endTime,
              requiredBreakMinutes,
              actualBreakMinutes,
              requiredChildcareWorkers: slot.requiredChildcareWorkers,
              assignedChildcareWorkerCount: slot.assignedChildcareWorkerCount,
              shortage: slot.childcareWorkerShortage,
              ...window,
            });
          }
          if (slot.licensedNurseryTeacherShortage > 0) {
            issues.push({
              code: "BREAK_LICENSED_COVERAGE_SHORTAGE",
              label: REVIEW_REASON_LABELS.BREAK_LICENSED_COVERAGE_SHORTAGE,
              staffId: profile.id,
              staffCode: profile.staffCode,
              staffName: profile.name,
              date: day.date,
              startTime,
              endTime,
              requiredBreakMinutes,
              actualBreakMinutes,
              requiredLicensedNurseryTeachers: slot.requiredLicensedNurseryTeachers,
              assignedLicensedNurseryTeacherCount: slot.assignedLicensedNurseryTeacherCount,
              shortage: slot.licensedNurseryTeacherShortage,
              ...window,
            });
          }
        }
      }
    }
  }
  return mergeContiguousIssues(issues);
}

export function evaluateCurrentDraftSchedule({
  targetMonth,
  requirementSource,
  staffProfiles,
  currentDays,
}) {
  if (!requirementSource || !Array.isArray(requirementSource.slots)) {
    throw new TypeError("再チェックする必要人数データが正しくありません。");
  }
  const days = currentDays.map((day) => validateScheduleDay(day));
  const profiles = staffProfiles.map((profile) => replaceTargetMonthDays(profile, targetMonth, days));
  const daysByStaffDate = new Map(days.map((day) => [dayKey(day.staffId, day.date), day]));
  const workLimits = createWorkLimitProfiles(profiles, targetMonth);
  const reviewedSlots = reviewRequirementSlots({
    targetMonth,
    requirementSlots: requirementSource.slots,
    profiles,
    daysByStaffDate,
    workLimits,
  });
  const staffingShortages = reviewedSlots.filter((slot) => {
    return slot.childcareWorkerShortage > 0 || slot.licensedNurseryTeacherShortage > 0;
  }).map((slot) => ({
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    requiredChildcareWorkers: slot.requiredChildcareWorkers,
    assignedChildcareWorkerCount: slot.assignedChildcareWorkerCount,
    childcareWorkerShortage: slot.childcareWorkerShortage,
    requiredLicensedNurseryTeachers: slot.requiredLicensedNurseryTeachers,
    assignedLicensedNurseryTeacherCount: slot.assignedLicensedNurseryTeacherCount,
    licensedNurseryTeacherShortage: slot.licensedNurseryTeacherShortage,
  }));
  const preview = buildAutomaticSchedulePreview({
    targetMonth,
    days,
    staffProfiles: profiles,
    requirementSource,
    unresolved: { staffingShortages, daysOff: [], breaks: [], hasUnresolved: staffingShortages.length > 0 },
    generationResult: {
      placement: { slots: reviewedSlots },
      scheduleSegments: days.flatMap((day) => day.segments.map((segment) => ({
        staffId: day.staffId,
        date: day.date,
        ...segment,
      }))),
      breakPlan: { breakOutcomes: [] },
    },
  });
  const requirementSlotsByKey = new Map(reviewedSlots.map((slot) => [slotKey(slot.date, slot.startTime), slot]));
  const workConditions = [
    ...manualWorkConditionIssues(profiles, days, requirementSlotsByKey, targetMonth),
    ...aggregateScheduleRuleIssues(profiles, days, targetMonth),
  ];
  const breaks = breakIssues(profiles, days, reviewedSlots);
  const issues = {
    childcareStaffing: preview.issues.childcareStaffing,
    licensedStaffing: preview.issues.licensedStaffing,
    workConditions,
    breaks,
  };
  const review = {
    targetMonth,
    sourcePeriod: requirementSource.period,
    requirementSlotCount: reviewedSlots.length,
    issues,
    summary: {
      childcareStaffing: issues.childcareStaffing.length,
      licensedStaffing: issues.licensedStaffing.length,
      workConditions: issues.workConditions.length,
      breaks: issues.breaks.length,
    },
    hasIssues: Object.values(issues).some((entries) => entries.length > 0),
  };
  return {
    ...review,
    confirmation: classifyDraftScheduleConfirmation(review),
  };
}
