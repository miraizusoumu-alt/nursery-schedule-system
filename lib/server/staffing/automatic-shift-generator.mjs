import { validateScheduleDay, validateScheduleTimeRange } from "./scheduled-work.mjs";
import { evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot } from "./staff-eligibility.mjs";
import {
  addGeneratedWorkMinutes,
  evaluateAutomaticWorkLimitAssignment,
  normalizeAutomaticWorkLimitProfiles,
  projectedDailyAutomaticWorkMinutes,
  serializeAutomaticWorkLimitProfiles,
  staffDateWorkKey,
} from "./automatic-work-limits.mjs";
import {
  activePartTimeWorkCondition,
  partTimeDailyMinimumMinutes,
  PART_TIME_DAILY_MINIMUM_REASON,
  workTimePreferenceForDate,
} from "./part-time-work-rules.mjs";

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label}は0以上の整数で指定してください。`);
  }
  return value;
}

function normalizeRequirementSlot(slot) {
  validateScheduleDay({ date: slot?.date, dayType: "work", segments: [] });
  const time = validateScheduleTimeRange(slot?.startTime, slot?.endTime);
  if (time.endMinutes - time.startMinutes !== 15) {
    throw new TypeError("自動配置の時間枠は15分単位で指定してください。");
  }
  const requiredChildcareWorkers = nonNegativeInteger(
    slot?.requiredChildcareWorkers,
    "必要保育従事者数",
  );
  const requiredLicensedNurseryTeachers = nonNegativeInteger(
    slot?.requiredLicensedNurseryTeachers,
    "必要保育士資格者数",
  );
  if (requiredLicensedNurseryTeachers > requiredChildcareWorkers) {
    throw new RangeError("必要保育士資格者数は必要保育従事者数を超えられません。");
  }
  return {
    ...slot,
    requiredChildcareWorkers,
    requiredLicensedNurseryTeachers,
    startMinutes: time.startMinutes,
    endMinutes: time.endMinutes,
  };
}

export function normalizeAutomaticShiftRequirementSlots(requirementSlots) {
  if (!Array.isArray(requirementSlots)) {
    throw new TypeError("必要人数を配列で指定してください。");
  }
  const seenSlots = new Set();
  const slots = requirementSlots.map(normalizeRequirementSlot).sort((left, right) => {
    return left.date.localeCompare(right.date) || left.startMinutes - right.startMinutes;
  });
  for (const slot of slots) {
    const key = `${slot.date}:${slot.startTime}`;
    if (seenSlots.has(key)) throw new TypeError(`${slot.date} ${slot.startTime}の必要人数が重複しています。`);
    seenSlots.add(key);
  }
  return slots;
}

function staffSortKey(staff) {
  return `${staff.staffCode ?? ""}\u0000${staff.id ?? staff.staffId ?? ""}`;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label}は1以上の整数で指定してください。`);
  }
  return value;
}

export function compareScheduledWorkProgress(left, right) {
  const leftMinutes = nonNegativeInteger(left?.scheduledWorkMinutes, "予定実労働時間");
  const rightMinutes = nonNegativeInteger(right?.scheduledWorkMinutes, "予定実労働時間");
  const leftBaseline = positiveInteger(left?.basicScheduledWorkMinutes, "基本勤務時間");
  const rightBaseline = positiveInteger(right?.basicScheduledWorkMinutes, "基本勤務時間");
  const leftProgress = leftMinutes * rightBaseline;
  const rightProgress = rightMinutes * leftBaseline;
  return leftProgress === rightProgress ? 0 : leftProgress < rightProgress ? -1 : 1;
}

function normalizeWorkloadFairnessProfiles(profiles, staffIds) {
  if (profiles === undefined) return new Map();
  if (!Array.isArray(profiles)) {
    throw new TypeError("勤務時間の公平性情報を配列で指定してください。");
  }
  const normalized = new Map();
  for (const profile of profiles) {
    if (!staffIds.has(profile?.staffId) || normalized.has(profile.staffId)) {
      throw new TypeError("勤務時間の公平性情報には重複しない職員IDを指定してください。");
    }
    normalized.set(profile.staffId, {
      staffId: profile.staffId,
      initialScheduledWorkMinutes: nonNegativeInteger(
        profile.scheduledWorkMinutes,
        "現在の予定実労働時間",
      ),
      basicScheduledWorkMinutes: positiveInteger(
        profile.basicScheduledWorkMinutes,
        "基本勤務時間",
      ),
    });
  }
  return normalized;
}

function workloadSnapshot(staffId, workloadProfiles, generatedMinutes) {
  const profile = workloadProfiles.get(staffId);
  if (!profile) return null;
  const generatedScheduledWorkMinutes = generatedMinutes.get(staffId) ?? 0;
  const scheduledWorkMinutes = profile.initialScheduledWorkMinutes + generatedScheduledWorkMinutes;
  return {
    ...profile,
    generatedScheduledWorkMinutes,
    scheduledWorkMinutes,
    progressRatio: scheduledWorkMinutes / profile.basicScheduledWorkMinutes,
  };
}

function compareBySelectionPriority(left, right, context) {
  const { continuingStaffIds, workloadProfiles, generatedMinutes } = context;
  if (left.hasWorkTimePreference !== right.hasWorkTimePreference) {
    return left.hasWorkTimePreference ? -1 : 1;
  }
  const leftContinues = continuingStaffIds.has(left.staffId);
  const rightContinues = continuingStaffIds.has(right.staffId);
  if (leftContinues !== rightContinues) return leftContinues ? -1 : 1;
  const leftWorkload = workloadSnapshot(left.staffId, workloadProfiles, generatedMinutes);
  const rightWorkload = workloadSnapshot(right.staffId, workloadProfiles, generatedMinutes);
  if (leftWorkload && rightWorkload) {
    const progressComparison = compareScheduledWorkProgress(leftWorkload, rightWorkload);
    if (progressComparison !== 0) return progressComparison;
  }
  const leftKey = staffSortKey(left);
  const rightKey = staffSortKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function withGeneratedWorkDays(staff, generatedDates) {
  const existingDates = new Set((staff.scheduledDays ?? []).map((day) => day.date));
  const additions = [...(generatedDates.get(staff.id) ?? [])]
    .filter((date) => !existingDates.has(date))
    .map((date) => ({ staffId: staff.id, date, dayType: "work", segments: [] }));
  return { ...staff, scheduledDays: [...(staff.scheduledDays ?? []), ...additions] };
}

function selectEvaluations(evaluations, requiredChildcareWorkers, requiredLicensedNurseryTeachers, context) {
  const eligible = evaluations.filter((entry) => entry.automaticPlacementEligible);
  const selected = [];
  const selectedIds = new Set();
  const licensed = eligible
    .filter((entry) => entry.licensedEligible)
    .sort((left, right) => compareBySelectionPriority(left, right, context));
  for (const evaluation of licensed.slice(0, requiredLicensedNurseryTeachers)) {
    selected.push(evaluation);
    selectedIds.add(evaluation.staffId);
  }
  const remainingCount = Math.max(0, requiredChildcareWorkers - selected.length);
  const remaining = eligible
    .filter((entry) => !selectedIds.has(entry.staffId))
    .sort((left, right) => compareBySelectionPriority(left, right, context));
  for (const evaluation of remaining.slice(0, remainingCount)) {
    selected.push(evaluation);
    selectedIds.add(evaluation.staffId);
  }
  return selected;
}

function removePartTimeAssignmentsBelowDailyMinimum(slots, workLimitProfiles, generatedWorkMinutes) {
  const removals = [];
  const removedKeys = new Set();
  for (const profile of workLimitProfiles.values()) {
    const assignedDates = new Set(slots.flatMap((slot) => {
      return (slot.assignedStaff ?? []).some((entry) => entry.staffId === profile.staffId) ? [slot.date] : [];
    }));
    for (const date of assignedDates) {
      const condition = activePartTimeWorkCondition(profile.workConditions, date);
      if (!condition) continue;
      const preference = workTimePreferenceForDate(profile.schedulePreferences, date);
      const minimumMinutes = partTimeDailyMinimumMinutes(condition, preference);
      if (minimumMinutes === null) continue;
      const actualMinutes = projectedDailyAutomaticWorkMinutes(profile, generatedWorkMinutes, date);
      if (actualMinutes > 0 && actualMinutes < minimumMinutes) {
        removedKeys.add(staffDateWorkKey(profile.staffId, date));
        removals.push({
          code: PART_TIME_DAILY_MINIMUM_REASON,
          staffId: profile.staffId,
          date,
          actualMinutes,
          minimumMinutes,
          preferenceExceptionApplied: minimumMinutes !== condition.dailyWorkMinutesMin,
        });
      }
    }
  }
  if (removedKeys.size === 0) return { slots, removals };
  const adjusted = slots.map((slot) => {
    const assignedStaff = (slot.assignedStaff ?? []).filter((entry) => {
      return !removedKeys.has(staffDateWorkKey(entry.staffId, slot.date));
    });
    const assignedLicensedNurseryTeacherCount = assignedStaff.filter((entry) => {
      return entry.isLicensedNurseryTeacher;
    }).length;
    return {
      ...slot,
      candidateEvaluations: (slot.candidateEvaluations ?? []).map((evaluation) => {
        if (!removedKeys.has(staffDateWorkKey(evaluation.staffId, slot.date))) return evaluation;
        return {
          ...evaluation,
          automaticPlacementEligible: false,
          exclusionReasons: [...new Set([
            ...(evaluation.exclusionReasons ?? []),
            PART_TIME_DAILY_MINIMUM_REASON,
          ])],
        };
      }),
      assignedStaff,
      assignedChildcareWorkerCount: assignedStaff.length,
      assignedLicensedNurseryTeacherCount,
      childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - assignedStaff.length),
      licensedNurseryTeacherShortage: Math.max(
        0,
        slot.requiredLicensedNurseryTeachers - assignedLicensedNurseryTeacherCount,
      ),
    };
  });
  return { slots: adjusted, removals };
}

export function calculateAutomaticChildcareShift(requirementSlots, staffProfiles, options = {}) {
  if (!Array.isArray(requirementSlots) || !Array.isArray(staffProfiles)) {
    throw new TypeError("必要人数と職員候補を配列で指定してください。");
  }
  const staffIds = new Set();
  const staff = [...staffProfiles].sort((left, right) => {
    const leftKey = staffSortKey(left);
    const rightKey = staffSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (const entry of staff) {
    if (!entry?.id || staffIds.has(entry.id)) throw new TypeError("職員IDは重複しない値を指定してください。");
    staffIds.add(entry.id);
  }
  const workloadProfiles = normalizeWorkloadFairnessProfiles(
    options.workloadFairnessProfiles,
    staffIds,
  );
  const workLimitProfiles = normalizeAutomaticWorkLimitProfiles(
    options.workLimitProfiles,
    staffIds,
  );
  const breakUnavailableStaffDates = new Set(options.breakUnavailableStaffDates ?? []);

  const slots = normalizeAutomaticShiftRequirementSlots(requirementSlots);

  const generatedDates = new Map();
  const generatedMinutes = new Map();
  const generatedWorkMinutesByStaffDate = new Map();
  let previousSlot = null;
  let previousAssignedStaffIds = new Set();
  const results = slots.map((slot) => {
    const isAdjacent = previousSlot?.date === slot.date && previousSlot.endTime === slot.startTime;
    const continuingStaffIds = isAdjacent ? previousAssignedStaffIds : new Set();
    const evaluations = staff.map((entry) => {
      const eligibility = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(
        withGeneratedWorkDays(entry, generatedDates),
        slot,
      );
      const workLimit = evaluateAutomaticWorkLimitAssignment({
        profile: workLimitProfiles.get(entry.id),
        generatedMinutes: generatedWorkMinutesByStaffDate,
        date: slot.date,
        breakUnavailableStaffDates,
      });
      return {
        ...eligibility,
        automaticPlacementEligible: eligibility.automaticPlacementEligible && workLimit.eligible,
        exclusionReasons: [...eligibility.exclusionReasons, ...workLimit.exclusionReasons],
        workLimit,
      };
    });
    const selected = selectEvaluations(
      evaluations,
      slot.requiredChildcareWorkers,
      slot.requiredLicensedNurseryTeachers,
      { continuingStaffIds, workloadProfiles, generatedMinutes },
    );
    const workloadBeforeSlot = new Map(selected.map((entry) => [
      entry.staffId,
      workloadSnapshot(entry.staffId, workloadProfiles, generatedMinutes),
    ]));
    for (const evaluation of selected) {
      const dates = generatedDates.get(evaluation.staffId) ?? new Set();
      dates.add(slot.date);
      generatedDates.set(evaluation.staffId, dates);
      addGeneratedWorkMinutes(
        generatedWorkMinutesByStaffDate,
        evaluation.staffId,
        slot.date,
        15,
      );
      if (workloadProfiles.has(evaluation.staffId)) {
        generatedMinutes.set(
          evaluation.staffId,
          (generatedMinutes.get(evaluation.staffId) ?? 0) + 15,
        );
      }
    }
    const assignedLicensedNurseryTeacherCount = selected.filter((entry) => entry.isLicensedNurseryTeacher).length;
    const requirement = { ...slot };
    delete requirement.startMinutes;
    delete requirement.endMinutes;
    const result = {
      ...requirement,
      assignedChildcareWorkerCount: selected.length,
      assignedLicensedNurseryTeacherCount,
      assignedStaff: selected.map((entry) => ({
        ...entry,
        continuedFromPreviousSlot: continuingStaffIds.has(entry.staffId),
        workloadBeforeSlot: workloadBeforeSlot.get(entry.staffId),
        workloadAfterSlot: workloadSnapshot(entry.staffId, workloadProfiles, generatedMinutes),
      })),
      childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - selected.length),
      licensedNurseryTeacherShortage: Math.max(
        0,
        slot.requiredLicensedNurseryTeachers - assignedLicensedNurseryTeacherCount,
      ),
      candidateEvaluations: evaluations,
    };
    previousSlot = slot;
    previousAssignedStaffIds = new Set(selected.map((entry) => entry.staffId));
    return result;
  });

  const minimumResult = removePartTimeAssignmentsBelowDailyMinimum(
    results,
    workLimitProfiles,
    generatedWorkMinutesByStaffDate,
  );
  const finalGeneratedMinutes = new Map();
  for (const slot of minimumResult.slots) {
    for (const assigned of slot.assignedStaff ?? []) {
      if (workloadProfiles.has(assigned.staffId)) {
        finalGeneratedMinutes.set(assigned.staffId, (finalGeneratedMinutes.get(assigned.staffId) ?? 0) + 15);
      }
    }
  }
  return {
    slots: minimumResult.slots,
    minimumWorkRemovals: minimumResult.removals,
    automaticWorkLimitProfiles: serializeAutomaticWorkLimitProfiles(workLimitProfiles),
    breakUnavailableStaffDates: [...breakUnavailableStaffDates].sort(),
    staffWorkloads: [...workloadProfiles.keys()]
      .map((staffId) => workloadSnapshot(staffId, workloadProfiles, finalGeneratedMinutes))
      .sort((left, right) => left.staffId.localeCompare(right.staffId)),
  };
}

export function mergeChildcareAssignmentsIntoSegments(slotResults) {
  if (!Array.isArray(slotResults)) throw new TypeError("15分枠の配置結果を配列で指定してください。");
  const assignments = [];
  for (const slot of slotResults.map(normalizeRequirementSlot)) {
    const seenStaff = new Set();
    for (const staff of slot.assignedStaff ?? []) {
      if (!staff?.staffId || seenStaff.has(staff.staffId)) {
        throw new TypeError("同じ15分枠へ同一職員を重複配置できません。");
      }
      seenStaff.add(staff.staffId);
      assignments.push({
        staffId: staff.staffId,
        staffCode: staff.staffCode,
        staffName: staff.staffName,
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    }
  }
  assignments.sort((left, right) => {
    return staffSortKey(left).localeCompare(staffSortKey(right))
      || left.date.localeCompare(right.date)
      || left.startTime.localeCompare(right.startTime);
  });

  const segments = [];
  for (const assignment of assignments) {
    const previous = segments.at(-1);
    if (previous
      && previous.staffId === assignment.staffId
      && previous.date === assignment.date
      && previous.endTime === assignment.startTime) {
      previous.endTime = assignment.endTime;
    } else {
      segments.push({ ...assignment, activityType: "childcare" });
    }
  }
  return segments;
}
