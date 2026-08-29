import { validateScheduleDay, validateScheduleTimeRange } from "./scheduled-work.mjs";
import { evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot } from "./staff-eligibility.mjs";
import { availabilityCandidatesForDate } from "./availability-candidates.mjs";
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

const MAX_MINIMUM_BLOCK_WINDOWS_PER_STAFF_DATE = 32;

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

function activeWorkConditionForDate(profile, date) {
  const active = (profile.workConditions ?? []).filter((condition) => {
    return condition.validFrom <= date && (!condition.validTo || date <= condition.validTo);
  });
  return active.length === 1 ? active[0] : null;
}

function availabilitySelectionScore(
  profile,
  candidate,
  date,
  daySlots,
  staffProfiles,
  selectedAvailabilityByStaffDate,
) {
  const score = {
    licensedShortageReduction: 0,
    childcareShortageReduction: 0,
    licensedDemand: 0,
    childcareDemand: 0,
    coveredRequiredSlots: 0,
  };
  for (const slot of daySlots) {
    const evaluation = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(profile, slot, {
      selectedAvailabilityCandidateId: candidate.candidateId,
    });
    if (!evaluation.automaticPlacementEligible) continue;
    const others = staffProfiles
      .filter((entry) => entry.id !== profile.id)
      .map((entry) => evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(entry, slot, {
        selectedAvailabilityCandidateId: selectedAvailabilityByStaffDate.get(
          staffDateWorkKey(entry.id, date),
        )?.candidateId ?? null,
      }));
    const otherChildcare = others.filter((entry) => entry.automaticPlacementEligible).length;
    const otherLicensed = others.filter((entry) => entry.licensedEligible).length;
    const childcareShortageWithout = Math.max(0, slot.requiredChildcareWorkers - otherChildcare);
    const licensedShortageWithout = Math.max(0, slot.requiredLicensedNurseryTeachers - otherLicensed);
    score.childcareShortageReduction += Math.min(1, childcareShortageWithout);
    score.licensedShortageReduction += evaluation.licensedEligible
      ? Math.min(1, licensedShortageWithout)
      : 0;
    score.childcareDemand += slot.requiredChildcareWorkers;
    score.licensedDemand += evaluation.licensedEligible ? slot.requiredLicensedNurseryTeachers : 0;
    if (slot.requiredChildcareWorkers > 0) score.coveredRequiredSlots += 1;
  }
  return score;
}

function compareAvailabilitySelections(left, right) {
  for (const key of [
    "licensedShortageReduction",
    "childcareShortageReduction",
    "licensedDemand",
    "childcareDemand",
    "coveredRequiredSlots",
  ]) {
    if (left.score[key] !== right.score[key]) return right.score[key] - left.score[key];
  }
  return left.candidate.candidateOrder - right.candidate.candidateOrder
    || left.candidate.startMinutes - right.candidate.startMinutes
    || left.candidate.endMinutes - right.candidate.endMinutes
    || left.candidate.candidateId.localeCompare(right.candidate.candidateId);
}

function selectAutomaticAvailabilityCandidatesForSlots(slots, staffProfiles) {
  const dates = [...new Set(slots.map((slot) => slot.date))].sort();
  const orderedStaff = [...staffProfiles].sort((left, right) => {
    const leftKey = staffSortKey(left);
    const rightKey = staffSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const selections = [];
  const selectedAvailabilityByStaffDate = new Map();
  for (const profile of orderedStaff) {
    for (const date of dates) {
      const preference = (profile.schedulePreferences ?? []).find((entry) => entry.date === date) ?? null;
      if (preference?.preferenceType === "day_off" || preference?.preferenceType === "work_time") continue;
      const condition = activeWorkConditionForDate(profile, date);
      if (!condition) continue;
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      const weeklyAvailability = condition.availability?.find((entry) => entry.weekday === weekday) ?? null;
      const candidates = availabilityCandidatesForDate(weeklyAvailability, date);
      if (candidates.length === 0) continue;
      const daySlots = slots.filter((slot) => slot.date === date);
      const ranked = candidates.map((candidate) => ({
        candidate,
        score: availabilitySelectionScore(
          profile,
          candidate,
          date,
          daySlots,
          orderedStaff,
          selectedAvailabilityByStaffDate,
        ),
      })).sort(compareAvailabilitySelections);
      const selected = ranked[0];
      const selection = {
        staffId: profile.id,
        date,
        candidateId: selected.candidate.candidateId,
        candidateOrder: selected.candidate.candidateOrder,
        startTime: selected.candidate.startTime,
        endTime: selected.candidate.endTime,
        weekOrdinals: selected.candidate.weekOrdinals,
        score: selected.score,
      };
      selections.push(selection);
      selectedAvailabilityByStaffDate.set(staffDateWorkKey(profile.id, date), selection);
    }
  }
  return selections.sort((left, right) => left.staffId.localeCompare(right.staffId)
    || left.date.localeCompare(right.date));
}

export function selectAutomaticAvailabilityCandidates(requirementSlots, staffProfiles) {
  if (!Array.isArray(staffProfiles)) throw new TypeError("職員候補を配列で指定してください。");
  return selectAutomaticAvailabilityCandidatesForSlots(
    normalizeAutomaticShiftRequirementSlots(requirementSlots),
    staffProfiles,
  );
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

function recalculateAssignedCounts(slot, assignedStaff = slot.assignedStaff ?? []) {
  const assignedLicensedNurseryTeacherCount = assignedStaff.filter((entry) => {
    return entry.isLicensedNurseryTeacher;
  }).length;
  return {
    ...slot,
    assignedStaff,
    assignedChildcareWorkerCount: assignedStaff.length,
    assignedLicensedNurseryTeacherCount,
    childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - assignedStaff.length),
    licensedNurseryTeacherShortage: Math.max(
      0,
      slot.requiredLicensedNurseryTeachers - assignedLicensedNurseryTeacherCount,
    ),
  };
}

function generatedAssignmentState(slots, workloadProfiles) {
  const generatedDates = new Map();
  const generatedMinutes = new Map();
  const generatedWorkMinutesByStaffDate = new Map();
  for (const slot of slots) {
    for (const assigned of slot.assignedStaff ?? []) {
      const dates = generatedDates.get(assigned.staffId) ?? new Set();
      dates.add(slot.date);
      generatedDates.set(assigned.staffId, dates);
      addGeneratedWorkMinutes(generatedWorkMinutesByStaffDate, assigned.staffId, slot.date, 15);
      if (workloadProfiles.has(assigned.staffId)) {
        generatedMinutes.set(assigned.staffId, (generatedMinutes.get(assigned.staffId) ?? 0) + 15);
      }
    }
  }
  return { generatedDates, generatedMinutes, generatedWorkMinutesByStaffDate };
}

function evaluateAutomaticCandidate({
  profile,
  slot,
  generatedDates,
  generatedWorkMinutesByStaffDate,
  workLimitProfiles,
  breakUnavailableStaffDates,
  selectedAvailabilityByStaffDate,
}) {
  const eligibility = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(
    withGeneratedWorkDays(profile, generatedDates),
    slot,
    {
      selectedAvailabilityCandidateId: selectedAvailabilityByStaffDate.get(
        staffDateWorkKey(profile.id, slot.date),
      )?.candidateId ?? null,
    },
  );
  const workLimit = evaluateAutomaticWorkLimitAssignment({
    profile: workLimitProfiles.get(profile.id),
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
}

function shortageTotals(slots) {
  return slots.reduce((totals, slot) => ({
    childcare: totals.childcare + slot.childcareWorkerShortage,
    licensed: totals.licensed + slot.licensedNurseryTeacherShortage,
  }), { childcare: 0, licensed: 0 });
}

function assignmentDisruption(slots, slotIndex, staffId) {
  const slot = slots[slotIndex];
  const previous = slots[slotIndex - 1];
  const next = slots[slotIndex + 1];
  const continuesBefore = previous?.date === slot.date
    && previous.endTime === slot.startTime
    && previous.assignedStaff.some((entry) => entry.staffId === staffId);
  const continuesAfter = next?.date === slot.date
    && slot.endTime === next.startTime
    && next.assignedStaff.some((entry) => entry.staffId === staffId);
  return Number(continuesBefore) + Number(continuesAfter);
}

function removableFullTimeAssignments(slots, slotIndex, incomingEvaluation, staffById) {
  const slot = slots[slotIndex];
  return (slot.assignedStaff ?? []).filter((assigned) => {
    if (assigned.staffId === incomingEvaluation.staffId || assigned.hasWorkTimePreference) return false;
    if (assigned.assignmentSource && assigned.assignmentSource !== "automatic_childcare") return false;
    return activeWorkConditionForDate(staffById.get(assigned.staffId), slot.date)?.employmentType === "常勤";
  }).filter((assigned) => {
    const remainingLicensed = slot.assignedStaff.filter((entry) => {
      return entry.staffId !== assigned.staffId && entry.isLicensedNurseryTeacher;
    }).length + Number(incomingEvaluation.isLicensedNurseryTeacher);
    return remainingLicensed >= slot.requiredLicensedNurseryTeachers;
  }).sort((left, right) => {
    return assignmentDisruption(slots, slotIndex, left.staffId)
      - assignmentDisruption(slots, slotIndex, right.staffId)
      || staffSortKey(staffById.get(left.staffId)).localeCompare(staffSortKey(staffById.get(right.staffId)));
  });
}

function removeStaffDateAssignments(slots, staffId, date) {
  return slots.map((slot) => {
    if (slot.date !== date || !(slot.assignedStaff ?? []).some((entry) => entry.staffId === staffId)) {
      return slot;
    }
    return recalculateAssignedCounts(
      slot,
      slot.assignedStaff.filter((entry) => entry.staffId !== staffId),
    );
  });
}

function contiguousMinimumBlockWindows(slots, date, minimumMinutes) {
  if (!Number.isInteger(minimumMinutes) || minimumMinutes <= 0 || minimumMinutes % 15 !== 0) return [];
  const requiredSlotCount = minimumMinutes / 15;
  const dayIndexes = slots.flatMap((slot, index) => slot.date === date ? [index] : []);
  const windows = [];
  for (let offset = 0; offset + requiredSlotCount <= dayIndexes.length; offset += 1) {
    const indexes = dayIndexes.slice(offset, offset + requiredSlotCount);
    const contiguous = indexes.every((slotIndex, index) => {
      const slot = slots[slotIndex];
      if (slot.requiredChildcareWorkers <= 0) return false;
      if (index === 0) return true;
      const previous = slots[indexes[index - 1]];
      return previous.endTime === slot.startTime;
    });
    if (contiguous) windows.push(indexes);
  }
  return windows.filter((indexes) => {
    return indexes.some((index) => slots[index].childcareWorkerShortage > 0);
  }).sort((left, right) => {
    const score = (indexes) => indexes.reduce((total, index) => ({
      childcareShortage: total.childcareShortage + slots[index].childcareWorkerShortage,
      licensedShortage: total.licensedShortage + slots[index].licensedNurseryTeacherShortage,
      replacementSlots: total.replacementSlots
        + Number(slots[index].assignedChildcareWorkerCount >= slots[index].requiredChildcareWorkers),
    }), { childcareShortage: 0, licensedShortage: 0, replacementSlots: 0 });
    const leftScore = score(left);
    const rightScore = score(right);
    return rightScore.licensedShortage - leftScore.licensedShortage
      || rightScore.childcareShortage - leftScore.childcareShortage
      || leftScore.replacementSlots - rightScore.replacementSlots
      || slots[left[0]].startTime.localeCompare(slots[right[0]].startTime);
  }).slice(0, MAX_MINIMUM_BLOCK_WINDOWS_PER_STAFF_DATE);
}

function simulatePartTimeMinimumBlock({
  currentSlots,
  profile,
  date,
  minimumMinutes,
  windowIndexes,
  staffById,
  workloadProfiles,
  workLimitProfiles,
  breakUnavailableStaffDates,
  selectedAvailabilityByStaffDate,
}) {
  if (!windowIndexes.some((index) => currentSlots[index].childcareWorkerShortage > 0)) return null;
  const initialMinutes = currentSlots.reduce((total, slot) => {
    return total + (slot.date === date && slot.assignedStaff.some((entry) => entry.staffId === profile.id) ? 15 : 0);
  }, 0);
  const trialSlots = [...removeStaffDateAssignments(currentSlots, profile.id, date)];
  let state = generatedAssignmentState(trialSlots, workloadProfiles);
  const replacements = [];
  let shortageAnchorReductions = 0;

  for (const slotIndex of windowIndexes) {
    const slot = trialSlots[slotIndex];
    const evaluation = evaluateAutomaticCandidate({
      profile,
      slot,
      ...state,
      workLimitProfiles,
      breakUnavailableStaffDates,
      selectedAvailabilityByStaffDate,
    });
    if (!evaluation.automaticPlacementEligible) return null;

    let assignedStaff = [...slot.assignedStaff];
    if (assignedStaff.length >= slot.requiredChildcareWorkers) {
      const replacement = removableFullTimeAssignments(
        trialSlots,
        slotIndex,
        evaluation,
        staffById,
      )[0];
      if (!replacement) return null;
      assignedStaff = assignedStaff.filter((entry) => entry.staffId !== replacement.staffId);
      addGeneratedWorkMinutes(
        state.generatedWorkMinutesByStaffDate,
        replacement.staffId,
        slot.date,
        -15,
      );
      if (workloadProfiles.has(replacement.staffId)) {
        const nextMinutes = (state.generatedMinutes.get(replacement.staffId) ?? 0) - 15;
        if (nextMinutes === 0) state.generatedMinutes.delete(replacement.staffId);
        else state.generatedMinutes.set(replacement.staffId, nextMinutes);
      }
      replacements.push({
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        replacedStaffId: replacement.staffId,
      });
    }
    assignedStaff.push({
      ...evaluation,
      assignmentSource: "part_time_minimum_block",
      continuedFromPreviousSlot: false,
      workloadBeforeSlot: workloadSnapshot(profile.id, workloadProfiles, state.generatedMinutes),
      workloadAfterSlot: null,
    });
    const updated = recalculateAssignedCounts(slot, assignedStaff);
    shortageAnchorReductions += Math.max(
      0,
      currentSlots[slotIndex].childcareWorkerShortage - updated.childcareWorkerShortage,
    );
    trialSlots[slotIndex] = updated;
    const dates = state.generatedDates.get(profile.id) ?? new Set();
    dates.add(slot.date);
    state.generatedDates.set(profile.id, dates);
    addGeneratedWorkMinutes(state.generatedWorkMinutesByStaffDate, profile.id, slot.date, 15);
    if (workloadProfiles.has(profile.id)) {
      state.generatedMinutes.set(profile.id, (state.generatedMinutes.get(profile.id) ?? 0) + 15);
    }
  }

  const workLimitProfile = workLimitProfiles.get(profile.id);
  const projectedMinutes = projectedDailyAutomaticWorkMinutes(
    workLimitProfile,
    state.generatedWorkMinutesByStaffDate,
    date,
    { breakUnavailableStaffDates },
  );
  if (projectedMinutes < minimumMinutes || shortageAnchorReductions === 0) return null;

  const beforeTotals = shortageTotals(currentSlots);
  const afterTotals = shortageTotals(trialSlots);
  if (afterTotals.childcare > beforeTotals.childcare || afterTotals.licensed > beforeTotals.licensed) return null;
  const preference = workTimePreferenceForDate(workLimitProfile.schedulePreferences, date);
  return {
    slots: trialSlots,
    staffId: profile.id,
    staffCode: profile.staffCode,
    date,
    startTime: trialSlots[windowIndexes[0]].startTime,
    endTime: trialSlots[windowIndexes.at(-1)].endTime,
    minimumMinutes,
    initialMinutes,
    projectedMinutes,
    hasWorkTimePreference: Boolean(preference),
    shortageAnchorReductions,
    childcareShortageReduction: beforeTotals.childcare - afterTotals.childcare,
    licensedShortageReduction: beforeTotals.licensed - afterTotals.licensed,
    replacements,
  };
}

function comparePartTimeMinimumBlockCandidates(left, right) {
  if (left.hasWorkTimePreference !== right.hasWorkTimePreference) {
    return left.hasWorkTimePreference ? -1 : 1;
  }
  return right.licensedShortageReduction - left.licensedShortageReduction
    || right.childcareShortageReduction - left.childcareShortageReduction
    || right.shortageAnchorReductions - left.shortageAnchorReductions
    || right.initialMinutes - left.initialMinutes
    || left.replacements.length - right.replacements.length
    || left.date.localeCompare(right.date)
    || left.startTime.localeCompare(right.startTime)
    || left.staffCode.localeCompare(right.staffCode)
    || left.staffId.localeCompare(right.staffId);
}

function partTimeMinimumBlockCandidatesForStaffDate({
  slots,
  profile,
  date,
  staffById,
  workloadProfiles,
  workLimitProfiles,
  breakUnavailableStaffDates,
  selectedAvailabilityByStaffDate,
}) {
  const workLimitProfile = workLimitProfiles.get(profile.id);
  const condition = activePartTimeWorkCondition(workLimitProfile?.workConditions, date);
  if (!condition) return [];
  const preference = workTimePreferenceForDate(workLimitProfile.schedulePreferences, date);
  const minimumMinutes = partTimeDailyMinimumMinutes(condition, preference);
  if (!minimumMinutes) return [];
  const state = generatedAssignmentState(slots, workloadProfiles);
  const currentMinutes = projectedDailyAutomaticWorkMinutes(
    workLimitProfile,
    state.generatedWorkMinutesByStaffDate,
    date,
    { breakUnavailableStaffDates },
  );
  if (currentMinutes >= minimumMinutes) return [];
  return contiguousMinimumBlockWindows(slots, date, minimumMinutes).flatMap((windowIndexes) => {
    const candidate = simulatePartTimeMinimumBlock({
      currentSlots: slots,
      profile,
      date,
      minimumMinutes,
      windowIndexes,
      staffById,
      workloadProfiles,
      workLimitProfiles,
      breakUnavailableStaffDates,
      selectedAvailabilityByStaffDate,
    });
    return candidate ? [candidate] : [];
  }).sort(comparePartTimeMinimumBlockCandidates);
}

function promotePartTimeMinimumBlocks({
  slots,
  staff,
  workloadProfiles,
  workLimitProfiles,
  breakUnavailableStaffDates,
  selectedAvailabilityByStaffDate,
}) {
  const staffById = new Map(staff.map((entry) => [entry.id, entry]));
  const dates = [...new Set(slots.map((slot) => slot.date))].sort();
  const promotions = [];
  let adjusted = slots;

  const seedCandidates = staff.flatMap((profile) => dates.flatMap((date) => {
    return partTimeMinimumBlockCandidatesForStaffDate({
      slots: adjusted,
      profile,
      date,
      staffById,
      workloadProfiles,
      workLimitProfiles,
      breakUnavailableStaffDates,
      selectedAvailabilityByStaffDate,
    }).slice(0, 1);
  })).sort(comparePartTimeMinimumBlockCandidates);

  for (const seed of seedCandidates) {
    const profile = staffById.get(seed.staffId);
    const selected = partTimeMinimumBlockCandidatesForStaffDate({
      slots: adjusted,
      profile,
      date: seed.date,
      staffById,
      workloadProfiles,
      workLimitProfiles,
      breakUnavailableStaffDates,
      selectedAvailabilityByStaffDate,
    })[0];
    if (!selected) continue;
    adjusted = selected.slots;
    const { slots: ignoredSlots, ...promotion } = selected;
    void ignoredSlots;
    promotions.push(promotion);
  }
  return { slots: adjusted, promotions };
}

function refillAutomaticShortages({
  slots,
  staff,
  workloadProfiles,
  workLimitProfiles,
  breakUnavailableStaffDates,
  selectedAvailabilityByStaffDate,
}) {
  let adjusted = slots;
  let state = generatedAssignmentState(adjusted, workloadProfiles);
  const refills = [];
  let previousSlot = null;

  for (let slotIndex = 0; slotIndex < adjusted.length; slotIndex += 1) {
    let slot = adjusted[slotIndex];
    if (slot.childcareWorkerShortage <= 0) {
      previousSlot = slot;
      continue;
    }
    const continuingStaffIds = previousSlot?.date === slot.date && previousSlot.endTime === slot.startTime
      ? new Set(previousSlot.assignedStaff.map((entry) => entry.staffId))
      : new Set();
    const assignedIds = new Set(slot.assignedStaff.map((entry) => entry.staffId));
    const evaluations = staff.filter((profile) => !assignedIds.has(profile.id)).map((profile) => {
      const evaluation = evaluateAutomaticCandidate({
        profile,
        slot,
        ...state,
        workLimitProfiles,
        breakUnavailableStaffDates,
        selectedAvailabilityByStaffDate,
      });
      const workLimitProfile = workLimitProfiles.get(profile.id);
      const condition = activePartTimeWorkCondition(workLimitProfile?.workConditions, slot.date);
      if (!condition) return evaluation;
      const preference = workTimePreferenceForDate(workLimitProfile.schedulePreferences, slot.date);
      const minimumMinutes = partTimeDailyMinimumMinutes(condition, preference);
      const currentMinutes = projectedDailyAutomaticWorkMinutes(
        workLimitProfile,
        state.generatedWorkMinutesByStaffDate,
        slot.date,
        { breakUnavailableStaffDates },
      );
      const proposedMinutes = evaluation.workLimit.projectedDailyScheduledWorkMinutes;
      if (currentMinutes < minimumMinutes || proposedMinutes < minimumMinutes) {
        return {
          ...evaluation,
          automaticPlacementEligible: false,
          exclusionReasons: [...new Set([...evaluation.exclusionReasons, PART_TIME_DAILY_MINIMUM_REASON])],
        };
      }
      return evaluation;
    });
    const selected = selectEvaluations(
      evaluations,
      slot.childcareWorkerShortage,
      slot.licensedNurseryTeacherShortage,
      { continuingStaffIds, workloadProfiles, generatedMinutes: state.generatedMinutes },
    );
    if (selected.length > 0) {
      const assignedStaff = [...slot.assignedStaff, ...selected.map((evaluation) => ({
        ...evaluation,
        assignmentSource: "phase1_shortage_refill",
        continuedFromPreviousSlot: continuingStaffIds.has(evaluation.staffId),
        workloadBeforeSlot: workloadSnapshot(evaluation.staffId, workloadProfiles, state.generatedMinutes),
        workloadAfterSlot: null,
      }))];
      slot = recalculateAssignedCounts({ ...slot, candidateEvaluations: evaluations }, assignedStaff);
      adjusted = adjusted.map((entry, index) => index === slotIndex ? slot : entry);
      state = generatedAssignmentState(adjusted, workloadProfiles);
      refills.push(...selected.map((entry) => ({
        staffId: entry.staffId,
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
      })));
    } else {
      adjusted = adjusted.map((entry, index) => index === slotIndex
        ? { ...entry, candidateEvaluations: evaluations }
        : entry);
      slot = adjusted[slotIndex];
    }
    previousSlot = slot;
  }
  return { slots: adjusted, refills };
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
  const selectedAvailabilityCandidates = selectAutomaticAvailabilityCandidatesForSlots(slots, staff);
  const selectedAvailabilityByStaffDate = new Map(selectedAvailabilityCandidates.map((selection) => [
    staffDateWorkKey(selection.staffId, selection.date),
    selection,
  ]));

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
        {
          selectedAvailabilityCandidateId: selectedAvailabilityByStaffDate.get(
            staffDateWorkKey(entry.id, slot.date),
          )?.candidateId ?? null,
        },
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

  const blockResult = promotePartTimeMinimumBlocks({
    slots: results,
    staff,
    workloadProfiles,
    workLimitProfiles,
    breakUnavailableStaffDates,
    selectedAvailabilityByStaffDate,
  });
  const firstBlockState = generatedAssignmentState(blockResult.slots, workloadProfiles);
  const firstMinimumResult = removePartTimeAssignmentsBelowDailyMinimum(
    blockResult.slots,
    workLimitProfiles,
    firstBlockState.generatedWorkMinutesByStaffDate,
  );
  const zeroMinuteBlockResult = promotePartTimeMinimumBlocks({
    slots: firstMinimumResult.slots,
    staff,
    workloadProfiles,
    workLimitProfiles,
    breakUnavailableStaffDates,
    selectedAvailabilityByStaffDate,
  });
  const finalBlockState = generatedAssignmentState(zeroMinuteBlockResult.slots, workloadProfiles);
  const minimumResult = removePartTimeAssignmentsBelowDailyMinimum(
    zeroMinuteBlockResult.slots,
    workLimitProfiles,
    finalBlockState.generatedWorkMinutesByStaffDate,
  );
  const refillResult = refillAutomaticShortages({
    slots: minimumResult.slots,
    staff,
    workloadProfiles,
    workLimitProfiles,
    breakUnavailableStaffDates,
    selectedAvailabilityByStaffDate,
  });
  const finalGeneratedMinutes = new Map();
  for (const slot of refillResult.slots) {
    for (const assigned of slot.assignedStaff ?? []) {
      if (workloadProfiles.has(assigned.staffId)) {
        finalGeneratedMinutes.set(assigned.staffId, (finalGeneratedMinutes.get(assigned.staffId) ?? 0) + 15);
      }
    }
  }
  return {
    slots: refillResult.slots,
    minimumWorkBlockPromotions: [...blockResult.promotions, ...zeroMinuteBlockResult.promotions],
    minimumWorkRemovals: [...firstMinimumResult.removals, ...minimumResult.removals].filter((removal) => {
      return !zeroMinuteBlockResult.promotions.some((promotion) => (
        promotion.staffId === removal.staffId && promotion.date === removal.date
      ));
    }),
    minimumWorkShortageRefills: refillResult.refills,
    automaticWorkLimitProfiles: serializeAutomaticWorkLimitProfiles(workLimitProfiles),
    selectedAvailabilityCandidates,
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
