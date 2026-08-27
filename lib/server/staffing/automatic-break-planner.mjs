import {
  compareScheduledWorkProgress,
  mergeChildcareAssignmentsIntoSegments,
  normalizeAutomaticShiftRequirementSlots,
} from "./automatic-shift-generator.mjs";
import {
  addGeneratedWorkMinutes,
  evaluateAutomaticWorkLimitAssignment,
  normalizeAutomaticWorkLimitProfiles,
  projectedDailyAutomaticWorkMinutes,
} from "./automatic-work-limits.mjs";
import {
  activePartTimeWorkCondition,
  partTimeDailyMinimumMinutes,
  workTimePreferenceForDate,
} from "./part-time-work-rules.mjs";
import { evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot } from "./staff-eligibility.mjs";
import { validateScheduleDay, validateScheduleTimeRange } from "./scheduled-work.mjs";

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function staffSortKey(staff) {
  return `${staff.staffCode ?? ""}\u0000${staff.id ?? staff.staffId ?? ""}`;
}

function intervalOverlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function cloneSetMap(source) {
  return new Map([...source].map(([key, values]) => [key, new Set(values)]));
}

function cloneWorkloads(source) {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function withoutInternalMinutes(value) {
  const result = { ...value };
  delete result.startMinutes;
  delete result.endMinutes;
  return result;
}

function normalizeBreakRequirements(requirements, staffIds) {
  if (!Array.isArray(requirements)) {
    throw new TypeError("休憩要件を配列で指定してください。");
  }
  const seen = new Set();
  return requirements.map((requirement) => {
    validateScheduleDay({ date: requirement?.date, dayType: "work", segments: [] });
    if (!staffIds.has(requirement?.staffId)) {
      throw new TypeError("休憩要件には存在する職員IDを指定してください。");
    }
    if (!Number.isInteger(requirement.requiredBreakMinutes)
      || requirement.requiredBreakMinutes < 0
      || requirement.requiredBreakMinutes % 15 !== 0) {
      throw new TypeError("必要休憩時間は0以上の15分単位で指定してください。");
    }
    const key = `${requirement.staffId}:${requirement.date}`;
    if (seen.has(key)) throw new TypeError("同じ職員・日付の休憩要件が重複しています。");
    seen.add(key);
    return { ...requirement, key };
  }).sort((left, right) => left.date.localeCompare(right.date)
    || left.staffId.localeCompare(right.staffId));
}

function normalizeReservedBreaks(reservations, staffIds) {
  if (!Array.isArray(reservations)) {
    throw new TypeError("休憩予約を配列で指定してください。");
  }
  const seen = new Set();
  return reservations.map((reservation) => {
    validateScheduleDay({ date: reservation?.date, dayType: "work", segments: [] });
    if (!staffIds.has(reservation?.staffId)) {
      throw new TypeError("休憩予約には存在する職員IDを指定してください。");
    }
    const range = validateScheduleTimeRange(reservation?.startTime, reservation?.endTime);
    const key = `${reservation.staffId}:${reservation.date}`;
    if (seen.has(key)) throw new TypeError("同じ職員・日付の休憩予約が重複しています。");
    seen.add(key);
    return {
      ...reservation,
      startMinutes: range.startMinutes,
      endMinutes: range.endMinutes,
      activityType: "break",
      source: "generated",
    };
  }).sort((left, right) => left.date.localeCompare(right.date)
    || left.startMinutes - right.startMinutes
    || staffSortKey(left).localeCompare(staffSortKey(right)));
}

function buildSlotStates(requirementSlots, placement) {
  const slots = normalizeAutomaticShiftRequirementSlots(requirementSlots);
  const placementByKey = new Map((placement?.slots ?? []).map((slot) => [
    `${slot.date}:${slot.startTime}`,
    slot,
  ]));
  if (placementByKey.size !== slots.length) {
    throw new TypeError("必要人数と自動配置結果の時間枠が一致しません。");
  }
  return slots.map((slot) => {
    const key = `${slot.date}:${slot.startTime}`;
    const placed = placementByKey.get(key);
    if (!placed) throw new TypeError("必要人数と自動配置結果の時間枠が一致しません。");
    const assignments = new Map();
    for (const assigned of placed.assignedStaff ?? []) {
      if (!assigned?.staffId || assignments.has(assigned.staffId)) {
        throw new TypeError("同じ時間枠へ同一職員を重複配置できません。");
      }
      assignments.set(assigned.staffId, { ...assigned, assignmentSource: assigned.assignmentSource ?? "automatic" });
    }
    return { ...slot, original: placed, assignments };
  });
}

function collectExistingSegments(staffProfiles, relevantDates) {
  const byStaffDate = new Map();
  const breaks = [];
  for (const profile of staffProfiles) {
    for (const rawDay of profile.scheduledDays ?? []) {
      if (!relevantDates.has(rawDay.date)) continue;
      const day = validateScheduleDay(rawDay);
      const key = `${profile.id}:${day.date}`;
      byStaffDate.set(key, day.segments.map((segment) => ({
        ...segment,
        startMinutes: timeToMinutes(segment.startTime),
        endMinutes: timeToMinutes(segment.endTime),
      })));
      for (const segment of day.segments.filter((entry) => entry.activityType === "break")) {
        breaks.push({
          staffId: profile.id,
          staffCode: profile.staffCode,
          staffName: profile.name,
          date: day.date,
          startTime: segment.startTime,
          endTime: segment.endTime,
          startMinutes: timeToMinutes(segment.startTime),
          endMinutes: timeToMinutes(segment.endTime),
          activityType: "break",
          source: "existing",
        });
      }
    }
  }
  breaks.sort((left, right) => left.date.localeCompare(right.date)
    || left.startMinutes - right.startMinutes
    || staffSortKey(left).localeCompare(staffSortKey(right)));
  return { byStaffDate, breaks };
}

function buildGeneratedDates(slotStates) {
  const result = new Map();
  for (const slot of slotStates) {
    for (const staffId of slot.assignments.keys()) {
      const dates = result.get(staffId) ?? new Set();
      dates.add(slot.date);
      result.set(staffId, dates);
    }
  }
  return result;
}

function buildGeneratedWorkMinutes(slotStates) {
  const result = new Map();
  for (const slot of slotStates) {
    for (const staffId of slot.assignments.keys()) {
      addGeneratedWorkMinutes(result, staffId, slot.date, 15);
    }
  }
  return result;
}

function selectedAvailabilityCandidateMap(placement) {
  return new Map((placement?.selectedAvailabilityCandidates ?? []).map((selection) => [
    `${selection.staffId}\u0000${selection.date}`,
    selection.candidateId,
  ]));
}

function windowsOverlap(left, right) {
  return left[0].date === right[0].date
    && left[0].startMinutes < right.at(-1).endMinutes
    && right[0].startMinutes < left.at(-1).endMinutes;
}

function replacementEvaluationsForWindow({
  targetStaffId,
  replacementProfile,
  window,
  generatedDates,
  existingSegments,
  breakIntervals,
  eligibilityCache,
  availabilitySelections,
}) {
  const replacement = profileWithGeneratedDates(replacementProfile, generatedDates);
  const evaluations = [];
  for (const slot of window) {
    if (!slot.assignments.has(targetStaffId) || slot.assignments.has(replacementProfile.id)) return null;
    if (hasExistingOccupation(replacementProfile, slot, existingSegments)) return null;
    if (hasBreakAtSlot(replacementProfile.id, slot, breakIntervals)) return null;
    const selectedAvailabilityCandidateId = availabilitySelections.get(
      `${replacementProfile.id}\u0000${slot.date}`,
    ) ?? null;
    const eligibilityKey = `${replacementProfile.id}\u0000${slot.date}\u0000${slot.startTime}\u0000${selectedAvailabilityCandidateId ?? "preference"}`;
    let evaluation = eligibilityCache.get(eligibilityKey);
    if (!evaluation) {
      evaluation = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(replacement, slot, {
        selectedAvailabilityCandidateId,
      });
      eligibilityCache.set(eligibilityKey, evaluation);
    }
    if (!evaluation.automaticPlacementEligible) return null;
    const assignments = new Map(slot.assignments);
    assignments.delete(targetStaffId);
    assignments.set(replacementProfile.id, evaluation);
    const before = slotShortages(slot, slot.assignments);
    const after = slotShortages(slot, assignments);
    if (after.childcareWorkerShortage > before.childcareWorkerShortage
      || after.licensedNurseryTeacherShortage > before.licensedNurseryTeacherShortage) return null;
    evaluations.push(evaluation);
  }
  return evaluations;
}

function reservableWindowsForReplacement({
  targetStaffId,
  replacementProfile,
  date,
  requiredSlots,
  slotStates,
  generatedDates,
  existingSegments,
  breakIntervals,
  eligibilityCache,
  availabilitySelections,
}) {
  const midpoint = targetWorkMidpoint(slotStates, targetStaffId, date);
  const assignedDaySlots = slotStates.filter((slot) => {
    return slot.date === date && slot.assignments.has(targetStaffId);
  }).sort((left, right) => left.startMinutes - right.startMinutes);
  return contiguousWindows(
    slotStates,
    targetStaffId,
    date,
    requiredSlots,
    existingSegments,
    breakIntervals,
  ).flatMap((window) => {
    const evaluations = replacementEvaluationsForWindow({
      targetStaffId,
      replacementProfile,
      window,
      generatedDates,
      existingSegments,
      breakIntervals,
      eligibilityCache,
      availabilitySelections,
    });
    if (!evaluations) return [];
    const windowStartIndex = assignedDaySlots.indexOf(window[0]);
    const windowEndIndex = assignedDaySlots.indexOf(window.at(-1));
    let runStartIndex = windowStartIndex;
    while (runStartIndex > 0
      && assignedDaySlots[runStartIndex - 1].endMinutes === assignedDaySlots[runStartIndex].startMinutes) {
      runStartIndex -= 1;
    }
    let runEndIndex = windowEndIndex;
    while (runEndIndex + 1 < assignedDaySlots.length
      && assignedDaySlots[runEndIndex].endMinutes === assignedDaySlots[runEndIndex + 1].startMinutes) {
      runEndIndex += 1;
    }
    const beforeSlots = windowStartIndex - runStartIndex;
    const afterSlots = runEndIndex - windowEndIndex;
    const fragmentPenalty = Number(beforeSlots > 0 && beforeSlots < requiredSlots)
      + Number(afterSlots > 0 && afterSlots < requiredSlots);
    return [{ window, evaluations, fragmentPenalty }];
  }).sort((left, right) => {
    const leftMidpoint = (left.window[0].startMinutes + left.window.at(-1).endMinutes) / 2;
    const rightMidpoint = (right.window[0].startMinutes + right.window.at(-1).endMinutes) / 2;
    const leftDistance = midpoint === null ? 0 : Math.abs(midpoint - leftMidpoint);
    const rightDistance = midpoint === null ? 0 : Math.abs(midpoint - rightMidpoint);
    return left.fragmentPenalty - right.fragmentPenalty
      || leftDistance - rightDistance
      || left.window[0].startMinutes - right.window[0].startMinutes;
  });
}

function findReservationCycle({
  orderedRequests,
  slotStates,
  staffById,
  generatedDates,
  existingSegments,
  breakIntervals,
  eligibilityCache,
  availabilitySelections,
}) {
  const candidatesByIndex = orderedRequests.map((request, index) => {
    const replacementRequest = orderedRequests[(index + 1) % orderedRequests.length];
    return reservableWindowsForReplacement({
      targetStaffId: request.staffId,
      replacementProfile: staffById.get(replacementRequest.staffId),
      date: request.date,
      requiredSlots: request.requiredBreakMinutes / 15,
      slotStates,
      generatedDates,
      existingSegments,
      breakIntervals,
      eligibilityCache,
      availabilitySelections,
    });
  });
  if (candidatesByIndex.some((candidates) => candidates.length === 0)) return null;
  const selections = [];
  function visit(index) {
    if (index === orderedRequests.length) return true;
    const request = orderedRequests[index];
    const replacementRequest = orderedRequests[(index + 1) % orderedRequests.length];
    for (const candidate of candidatesByIndex[index]) {
      if (selections.some((selection) => windowsOverlap(selection.window, candidate.window))) continue;
      selections.push({
        request,
        replacementStaffId: replacementRequest.staffId,
        ...candidate,
      });
      if (visit(index + 1)) return true;
      selections.pop();
    }
    return false;
  }
  return visit(0) ? selections : null;
}

function applyReservationCycle(selections, slotStates, staffById) {
  const reservations = [];
  const reassignments = [];
  for (const selection of selections) {
    const target = staffById.get(selection.request.staffId);
    const replacement = staffById.get(selection.replacementStaffId);
    for (let index = 0; index < selection.window.length; index += 1) {
      const slot = selection.window[index];
      slot.assignments.delete(target.id);
      slot.assignments.set(replacement.id, {
        ...selection.evaluations[index],
        assignmentSource: "break_reservation",
        reliefForStaffId: target.id,
      });
      reassignments.push({
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        relievedStaffId: target.id,
        replacementStaffId: replacement.id,
      });
    }
    reservations.push({
      staffId: target.id,
      staffCode: target.staffCode,
      staffName: target.name,
      date: selection.request.date,
      startTime: selection.window[0].startTime,
      endTime: selection.window.at(-1).endTime,
      startMinutes: selection.window[0].startMinutes,
      endMinutes: selection.window.at(-1).endMinutes,
      activityType: "break",
      source: "generated",
      replacementStaffId: replacement.id,
    });
  }
  return { reservations, reassignments };
}

export function reserveAutomaticBreakCoverage({
  requirementSlots = [],
  placement,
  staffProfiles = [],
  breakRequirements = [],
}) {
  if (!Array.isArray(staffProfiles)) throw new TypeError("職員候補を配列で指定してください。");
  const sortedStaff = [...staffProfiles].sort((left, right) => staffSortKey(left).localeCompare(staffSortKey(right)));
  const staffById = new Map(sortedStaff.map((profile) => [profile.id, profile]));
  if (staffById.size !== sortedStaff.length || sortedStaff.some((profile) => !profile?.id)) {
    throw new TypeError("職員IDは重複しない値を指定してください。");
  }
  const requests = normalizeBreakRequirements(breakRequirements, new Set(staffById.keys()));
  const slotStates = buildSlotStates(requirementSlots, placement);
  const relevantDates = new Set([
    ...slotStates.map((slot) => slot.date),
    ...requests.map((request) => request.date),
  ]);
  const existing = collectExistingSegments(sortedStaff, relevantDates);
  const breakIntervals = existing.breaks.map((segment) => ({ ...segment }));
  const generatedDates = buildGeneratedDates(slotStates);
  const eligibilityCache = new Map();
  const availabilitySelections = selectedAvailabilityCandidateMap(placement);
  const grouped = new Map();
  for (const request of requests) {
    if (request.requiredBreakMinutes === 0) continue;
    const existingBreakIsSufficient = existing.breaks.some((segment) => {
      return segment.staffId === request.staffId
        && segment.date === request.date
        && segment.endMinutes - segment.startMinutes >= request.requiredBreakMinutes;
    });
    if (existingBreakIsSufficient) continue;
    const key = `${request.date}\u0000${request.requiredBreakMinutes}`;
    const values = grouped.get(key) ?? [];
    values.push(request);
    grouped.set(key, values);
  }

  const reservations = [];
  const reassignments = [];
  for (const requestsForDuration of grouped.values()) {
    let remaining = [...requestsForDuration].sort((left, right) => {
      return staffSortKey(staffById.get(left.staffId)).localeCompare(staffSortKey(staffById.get(right.staffId)));
    });
    while (remaining.length >= 2) {
      let selectedCycle = null;
      for (let leftIndex = 0; leftIndex < remaining.length - 1 && !selectedCycle; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < remaining.length; rightIndex += 1) {
          const selectedRequests = [remaining[leftIndex], remaining[rightIndex]];
          const selections = findReservationCycle({
            orderedRequests: selectedRequests,
            slotStates,
            staffById,
            generatedDates,
            existingSegments: existing.byStaffDate,
            breakIntervals,
            eligibilityCache,
            availabilitySelections,
          });
          if (selections) {
            selectedCycle = { selectedRequests, selections };
            break;
          }
        }
      }
      if (!selectedCycle) break;
      const applied = applyReservationCycle(selectedCycle.selections, slotStates, staffById);
      reservations.push(...applied.reservations);
      reassignments.push(...applied.reassignments);
      breakIntervals.push(...applied.reservations);
      const selectedIds = new Set(selectedCycle.selectedRequests.map((request) => request.staffId));
      remaining = remaining.filter((request) => !selectedIds.has(request.staffId));
    }
  }

  reservations.sort((left, right) => left.date.localeCompare(right.date)
    || left.startTime.localeCompare(right.startTime)
    || staffSortKey(left).localeCompare(staffSortKey(right)));
  reassignments.sort((left, right) => left.date.localeCompare(right.date)
    || left.startTime.localeCompare(right.startTime)
    || left.relievedStaffId.localeCompare(right.relievedStaffId));
  return {
    placement: { ...placement, slots: finalizeSlots(slotStates) },
    reservations: reservations.map(withoutInternalMinutes),
    reassignments,
  };
}

function profileWithGeneratedDates(profile, generatedDates) {
  const existingDates = new Set((profile.scheduledDays ?? []).map((day) => day.date));
  const additions = [...(generatedDates.get(profile.id) ?? [])]
    .filter((date) => !existingDates.has(date))
    .map((date) => ({ staffId: profile.id, date, dayType: "work", segments: [] }));
  return { ...profile, scheduledDays: [...(profile.scheduledDays ?? []), ...additions] };
}

function buildWorkloads(placement) {
  return new Map((placement?.staffWorkloads ?? []).map((workload) => [workload.staffId, {
    ...workload,
    automaticBreakMinutes: 0,
    reliefChildcareMinutes: 0,
  }]));
}

function adjustWorkload(workloads, staffId, deltaMinutes, kind) {
  const workload = workloads.get(staffId);
  if (!workload) return;
  workload.generatedScheduledWorkMinutes += deltaMinutes;
  workload.scheduledWorkMinutes += deltaMinutes;
  if (kind === "break") workload.automaticBreakMinutes += Math.abs(deltaMinutes);
  if (kind === "relief") workload.reliefChildcareMinutes += deltaMinutes;
  workload.progressRatio = workload.scheduledWorkMinutes / workload.basicScheduledWorkMinutes;
}

function summarizeSlotAssignments(assignments) {
  const values = [...assignments.values()];
  return {
    assignedChildcareWorkerCount: values.length,
    assignedLicensedNurseryTeacherCount: values.filter((entry) => entry.isLicensedNurseryTeacher).length,
  };
}

function slotShortages(slot, assignments) {
  const summary = summarizeSlotAssignments(assignments);
  return {
    ...summary,
    childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - summary.assignedChildcareWorkerCount),
    licensedNurseryTeacherShortage: Math.max(
      0,
      slot.requiredLicensedNurseryTeachers - summary.assignedLicensedNurseryTeacherCount,
    ),
  };
}

function hasExistingOccupation(profile, slot, existingSegments) {
  return (existingSegments.get(`${profile.id}:${slot.date}`) ?? []).some((segment) => {
    return intervalOverlaps(slot.startMinutes, slot.endMinutes, segment.startMinutes, segment.endMinutes);
  });
}

function hasBreakAtSlot(staffId, slot, breakIntervals) {
  return breakIntervals.some((segment) => segment.staffId === staffId
    && segment.date === slot.date
    && intervalOverlaps(slot.startMinutes, slot.endMinutes, segment.startMinutes, segment.endMinutes));
}

function naturalCoverageScore(staffId, date, window, slotStates) {
  const before = slotStates.find((slot) => slot.date === date && slot.endMinutes === window[0].startMinutes);
  const after = slotStates.find((slot) => slot.date === date && slot.startMinutes === window.at(-1).endMinutes);
  const adjacent = Number(Boolean(before?.assignments.has(staffId)))
    + Number(Boolean(after?.assignments.has(staffId)));
  const sameDaySlots = slotStates.filter((slot) => slot.date === date && slot.assignments.has(staffId)).length;
  return { adjacent, sameDaySlots };
}

function compareReliefCandidates(left, right, context) {
  const leftContinues = context.continuingReliefIds.has(left.staffId);
  const rightContinues = context.continuingReliefIds.has(right.staffId);
  if (leftContinues !== rightContinues) return leftContinues ? -1 : 1;
  const leftNatural = naturalCoverageScore(left.staffId, context.date, context.window, context.slotStates);
  const rightNatural = naturalCoverageScore(right.staffId, context.date, context.window, context.slotStates);
  if (leftNatural.adjacent !== rightNatural.adjacent) return rightNatural.adjacent - leftNatural.adjacent;
  if (leftNatural.sameDaySlots !== rightNatural.sameDaySlots) {
    return rightNatural.sameDaySlots - leftNatural.sameDaySlots;
  }
  const leftWorkload = context.workloads.get(left.staffId);
  const rightWorkload = context.workloads.get(right.staffId);
  if (leftWorkload && rightWorkload) {
    const comparison = compareScheduledWorkProgress(leftWorkload, rightWorkload);
    if (comparison !== 0) return comparison;
  }
  return staffSortKey(left).localeCompare(staffSortKey(right));
}

function eligibleReliefCandidates({
  targetStaffId,
  slot,
  requireLicensed,
  assignments,
  staffProfiles,
  generatedDates,
  existingSegments,
  breakIntervals,
  workLimitProfiles,
  generatedWorkMinutes,
  breakUnavailableStaffDates,
  availabilitySelections,
}) {
  return staffProfiles.flatMap((profile) => {
    if (profile.id === targetStaffId || assignments.has(profile.id)) return [];
    if (hasExistingOccupation(profile, slot, existingSegments)) return [];
    if (hasBreakAtSlot(profile.id, slot, breakIntervals)) return [];
    const evaluation = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(
      profileWithGeneratedDates(profile, generatedDates),
      slot,
      {
        selectedAvailabilityCandidateId: availabilitySelections.get(
          `${profile.id}\u0000${slot.date}`,
        ) ?? null,
      },
    );
    const workLimit = evaluateAutomaticWorkLimitAssignment({
      profile: workLimitProfiles.get(profile.id),
      generatedMinutes: generatedWorkMinutes,
      date: slot.date,
      breakUnavailableStaffDates,
    });
    if (!evaluation.automaticPlacementEligible
      || !workLimit.eligible
      || (requireLicensed && !evaluation.licensedEligible)) return [];
    return [{ ...evaluation, workLimit }];
  });
}

function simulateCoverage({
  targetStaffId,
  window,
  slotStates,
  staffProfiles,
  generatedDates,
  existingSegments,
  breakIntervals,
  workloads,
  workLimitProfiles,
  generatedWorkMinutes,
  breakUnavailableStaffDates,
  availabilitySelections,
}) {
  const simulatedAssignments = new Map(window.map((slot) => [slot, new Map(slot.assignments)]));
  const simulatedDates = cloneSetMap(generatedDates);
  const simulatedWorkloads = cloneWorkloads(workloads);
  const simulatedGeneratedWorkMinutes = new Map(generatedWorkMinutes);
  const actions = [];
  let continuingReliefIds = new Set();
  let failureReasonCode = null;

  for (const slot of window) {
    const assignments = simulatedAssignments.get(slot);
    const baselineShortage = slotShortages(slot, assignments);
    if (assignments.delete(targetStaffId)) {
      addGeneratedWorkMinutes(simulatedGeneratedWorkMinutes, targetStaffId, slot.date, -15);
    }
    const currentReliefIds = new Set();
    while (true) {
      const shortage = slotShortages(slot, assignments);
      const requireLicensed = shortage.licensedNurseryTeacherShortage
        > baselineShortage.licensedNurseryTeacherShortage;
      const requiresChildcareCoverage = shortage.childcareWorkerShortage
        > baselineShortage.childcareWorkerShortage;
      if (!requireLicensed && !requiresChildcareCoverage) break;
      const candidates = eligibleReliefCandidates({
        targetStaffId,
        slot,
        requireLicensed,
        assignments,
        staffProfiles,
        generatedDates: simulatedDates,
        existingSegments,
        breakIntervals,
        workLimitProfiles,
        generatedWorkMinutes: simulatedGeneratedWorkMinutes,
        breakUnavailableStaffDates,
        availabilitySelections,
      }).sort((left, right) => compareReliefCandidates(left, right, {
        continuingReliefIds,
        date: slot.date,
        window,
        slotStates,
        workloads: simulatedWorkloads,
      }));
      const selected = candidates[0];
      if (!selected) {
        failureReasonCode = requireLicensed
          ? "QUALIFIED_BREAK_COVERAGE_UNAVAILABLE"
          : "BREAK_COVERAGE_UNAVAILABLE";
        break;
      }
      assignments.set(selected.staffId, {
        ...selected,
        assignmentSource: "break_relief",
        reliefForStaffId: targetStaffId,
      });
      actions.push({ slot, staff: selected, reliefForStaffId: targetStaffId });
      currentReliefIds.add(selected.staffId);
      const dates = simulatedDates.get(selected.staffId) ?? new Set();
      dates.add(slot.date);
      simulatedDates.set(selected.staffId, dates);
      adjustWorkload(simulatedWorkloads, selected.staffId, 15, "relief");
      addGeneratedWorkMinutes(simulatedGeneratedWorkMinutes, selected.staffId, slot.date, 15);
    }
    if (failureReasonCode) break;
    continuingReliefIds = currentReliefIds;
  }

  const reliefBySlot = new Map();
  for (const action of actions) {
    const staffIds = reliefBySlot.get(action.slot) ?? [];
    staffIds.push(action.staff.staffId);
    reliefBySlot.set(action.slot, staffIds.sort());
  }
  let reliefChanges = 0;
  let previous = null;
  for (const slot of window) {
    const current = (reliefBySlot.get(slot) ?? []).join(",");
    if (previous !== null && current !== previous) reliefChanges += 1;
    previous = current;
  }
  const uniqueReliefStaffIds = [...new Set(actions.map((action) => action.staff.staffId))].sort();
  if (failureReasonCode === null) {
    for (const reliefStaffId of uniqueReliefStaffIds) {
      const workLimitProfile = workLimitProfiles.get(reliefStaffId);
      const date = window[0]?.date;
      const condition = activePartTimeWorkCondition(workLimitProfile?.workConditions, date);
      if (!condition) continue;
      const preference = workTimePreferenceForDate(workLimitProfile.schedulePreferences, date);
      const minimumMinutes = partTimeDailyMinimumMinutes(condition, preference);
      const projectedMinutes = projectedDailyAutomaticWorkMinutes(
        workLimitProfile,
        simulatedGeneratedWorkMinutes,
        date,
      );
      if (minimumMinutes !== null && projectedMinutes > 0 && projectedMinutes < minimumMinutes) {
        failureReasonCode = "BREAK_COVERAGE_UNAVAILABLE";
        break;
      }
    }
  }
  const naturalScore = actions.reduce((total, action) => {
    const score = naturalCoverageScore(action.staff.staffId, action.slot.date, window, slotStates);
    return total + score.adjacent * 100 + score.sameDaySlots;
  }, 0);
  return {
    valid: failureReasonCode === null,
    failureReasonCode,
    simulatedAssignments,
    actions,
    uniqueReliefStaffIds,
    reliefChanges,
    naturalScore,
  };
}

function contiguousWindows(slotStates, staffId, date, requiredSlots, existingSegments, breakIntervals) {
  const daySlots = slotStates.filter((slot) => slot.date === date).sort((left, right) => left.startMinutes - right.startMinutes);
  const windows = [];
  for (let index = 0; index + requiredSlots <= daySlots.length; index += 1) {
    const window = daySlots.slice(index, index + requiredSlots);
    const contiguous = window.every((slot, windowIndex) => windowIndex === 0
      || window[windowIndex - 1].endMinutes === slot.startMinutes);
    const assigned = window.every((slot) => slot.assignments.has(staffId));
    const occupied = window.some((slot) => {
      const profile = { id: staffId };
      return hasExistingOccupation(profile, slot, existingSegments)
        || hasBreakAtSlot(staffId, slot, breakIntervals);
    });
    if (contiguous && assigned && !occupied) windows.push(window);
  }
  return windows;
}

function concurrentBreakSlots(window, breakIntervals, targetStaffId) {
  return window.reduce((total, slot) => total + breakIntervals.filter((segment) => {
    return segment.staffId !== targetStaffId
      && segment.date === slot.date
      && intervalOverlaps(slot.startMinutes, slot.endMinutes, segment.startMinutes, segment.endMinutes);
  }).length, 0);
}

function targetWorkMidpoint(slotStates, staffId, date) {
  const assigned = slotStates.filter((slot) => slot.date === date && slot.assignments.has(staffId));
  if (assigned.length === 0) return null;
  return (assigned[0].startMinutes + assigned.at(-1).endMinutes) / 2;
}

function compareBreakCandidates(left, right) {
  if (left.requiresRelief !== right.requiresRelief) return left.requiresRelief ? 1 : -1;
  if (left.coverage.naturalScore !== right.coverage.naturalScore) {
    return right.coverage.naturalScore - left.coverage.naturalScore;
  }
  if (left.coverage.reliefChanges !== right.coverage.reliefChanges) {
    return left.coverage.reliefChanges - right.coverage.reliefChanges;
  }
  if (left.coverage.uniqueReliefStaffIds.length !== right.coverage.uniqueReliefStaffIds.length) {
    return left.coverage.uniqueReliefStaffIds.length - right.coverage.uniqueReliefStaffIds.length;
  }
  if (left.concurrentBreakSlots !== right.concurrentBreakSlots) {
    return left.concurrentBreakSlots - right.concurrentBreakSlots;
  }
  if (left.capacityMargin !== right.capacityMargin) return right.capacityMargin - left.capacityMargin;
  if (left.midpointDistance !== right.midpointDistance) return left.midpointDistance - right.midpointDistance;
  return left.window[0].startMinutes - right.window[0].startMinutes;
}

function evaluateBreakCandidate(context, window) {
  const coverage = simulateCoverage({ ...context, window });
  const capacityMargin = window.reduce((total, slot) => {
    const assignments = new Map(slot.assignments);
    assignments.delete(context.targetStaffId);
    const summary = summarizeSlotAssignments(assignments);
    return total
      + Math.max(0, summary.assignedChildcareWorkerCount - slot.requiredChildcareWorkers)
      + Math.max(0, summary.assignedLicensedNurseryTeacherCount - slot.requiredLicensedNurseryTeachers);
  }, 0);
  const midpoint = targetWorkMidpoint(context.slotStates, context.targetStaffId, window[0].date);
  const breakMidpoint = (window[0].startMinutes + window.at(-1).endMinutes) / 2;
  return {
    window,
    coverage,
    requiresRelief: coverage.actions.length > 0,
    concurrentBreakSlots: concurrentBreakSlots(window, context.breakIntervals, context.targetStaffId),
    capacityMargin,
    midpointDistance: midpoint === null ? 0 : Math.abs(midpoint - breakMidpoint),
  };
}

function applyBreak({
  targetStaffId,
  breakSegment,
  coverage,
  slotStates,
  generatedDates,
  workloads,
  breakIntervals,
  generatedWorkMinutes,
  allowPartialCoverage,
}) {
  const window = slotStates.filter((slot) => slot.date === breakSegment.date
    && intervalOverlaps(slot.startMinutes, slot.endMinutes, breakSegment.startMinutes, breakSegment.endMinutes));
  const removedSlots = window.filter((slot) => slot.assignments.has(targetStaffId));
  const statesToApply = coverage.valid || allowPartialCoverage
    ? [...coverage.simulatedAssignments.entries()]
    : [];
  for (const [slot, assignments] of statesToApply) slot.assignments = assignments;
  if (allowPartialCoverage) {
    for (const slot of window) slot.assignments.delete(targetStaffId);
  }
  if (coverage.valid || allowPartialCoverage) {
    adjustWorkload(workloads, targetStaffId, removedSlots.length * -15, "break");
    addGeneratedWorkMinutes(
      generatedWorkMinutes,
      targetStaffId,
      breakSegment.date,
      removedSlots.length * -15,
    );
    for (const action of coverage.actions) {
      adjustWorkload(workloads, action.staff.staffId, 15, "relief");
      addGeneratedWorkMinutes(generatedWorkMinutes, action.staff.staffId, action.slot.date, 15);
      const dates = generatedDates.get(action.staff.staffId) ?? new Set();
      dates.add(action.slot.date);
      generatedDates.set(action.staff.staffId, dates);
    }
    const stillAssignedOnDate = slotStates.some((slot) => {
      return slot.date === breakSegment.date && slot.assignments.has(targetStaffId);
    });
    if (!stillAssignedOnDate) generatedDates.get(targetStaffId)?.delete(breakSegment.date);
  }
  const alreadyRegistered = breakIntervals.some((segment) => segment.staffId === breakSegment.staffId
    && segment.date === breakSegment.date
    && segment.startTime === breakSegment.startTime
    && segment.endTime === breakSegment.endTime);
  if (!alreadyRegistered) {
    breakIntervals.push(breakSegment);
  }
  return coverage.actions;
}

function groupReliefActions(actions) {
  const sorted = actions.map((action) => ({
    staffId: action.staff.staffId,
    staffCode: action.staff.staffCode,
    staffName: action.staff.staffName,
    reliefForStaffId: action.reliefForStaffId,
    date: action.slot.date,
    startTime: action.slot.startTime,
    endTime: action.slot.endTime,
    startMinutes: action.slot.startMinutes,
    endMinutes: action.slot.endMinutes,
    activityType: "childcare",
    source: "break_relief",
  })).sort((left, right) => staffSortKey(left).localeCompare(staffSortKey(right))
    || left.date.localeCompare(right.date)
    || left.startMinutes - right.startMinutes);
  const segments = [];
  for (const action of sorted) {
    const previous = segments.at(-1);
    if (previous
      && previous.staffId === action.staffId
      && previous.reliefForStaffId === action.reliefForStaffId
      && previous.date === action.date
      && previous.endTime === action.startTime) {
      previous.endTime = action.endTime;
      previous.endMinutes = action.endMinutes;
    } else {
      segments.push({ ...action });
    }
  }
  return segments.map(withoutInternalMinutes);
}

function finalizeSlots(slotStates) {
  return slotStates.map((slot) => {
    const assignedStaff = [...slot.assignments.values()].sort((left, right) => {
      return staffSortKey(left).localeCompare(staffSortKey(right));
    });
    const shortage = slotShortages(slot, slot.assignments);
    const requirement = { ...slot };
    delete requirement.original;
    delete requirement.assignments;
    delete requirement.startMinutes;
    delete requirement.endMinutes;
    return { ...slot.original, ...requirement, ...shortage, assignedStaff };
  });
}

export function planAutomaticBreaks({
  requirementSlots = [],
  placement,
  staffProfiles = [],
  breakRequirements = [],
  reservedBreaks = [],
}) {
  if (!Array.isArray(staffProfiles)) throw new TypeError("職員候補を配列で指定してください。");
  const sortedStaff = [...staffProfiles].sort((left, right) => staffSortKey(left).localeCompare(staffSortKey(right)));
  const staffIds = new Set();
  for (const profile of sortedStaff) {
    if (!profile?.id || staffIds.has(profile.id)) throw new TypeError("職員IDは重複しない値を指定してください。");
    staffIds.add(profile.id);
  }
  const workLimitProfiles = normalizeAutomaticWorkLimitProfiles(
    placement?.automaticWorkLimitProfiles,
    staffIds,
  );
  const breakUnavailableStaffDates = new Set(placement?.breakUnavailableStaffDates ?? []);
  const availabilitySelections = selectedAvailabilityCandidateMap(placement);
  const requests = normalizeBreakRequirements(breakRequirements, staffIds);
  const reservations = normalizeReservedBreaks(reservedBreaks, staffIds);
  const slotStates = buildSlotStates(requirementSlots, placement);
  const relevantDates = new Set([
    ...slotStates.map((slot) => slot.date),
    ...requests.map((request) => request.date),
  ]);
  const existing = collectExistingSegments(sortedStaff, relevantDates);
  const coverageBreaks = [...existing.breaks, ...reservations];
  const breakIntervals = coverageBreaks.map((segment) => ({ ...segment }));
  const generatedDates = buildGeneratedDates(slotStates);
  const generatedWorkMinutes = buildGeneratedWorkMinutes(slotStates);
  const workloads = buildWorkloads(placement);
  const allReliefActions = [];
  const existingCoverageByKey = new Map();

  for (const segment of coverageBreaks) {
    const window = slotStates.filter((slot) => slot.date === segment.date
      && intervalOverlaps(slot.startMinutes, slot.endMinutes, segment.startMinutes, segment.endMinutes));
    const coverage = simulateCoverage({
      targetStaffId: segment.staffId,
      window,
      slotStates,
      staffProfiles: sortedStaff,
      generatedDates,
      existingSegments: existing.byStaffDate,
      breakIntervals,
      workloads,
      workLimitProfiles,
      generatedWorkMinutes,
      breakUnavailableStaffDates,
      availabilitySelections,
    });
    const actions = applyBreak({
      targetStaffId: segment.staffId,
      breakSegment: segment,
      coverage,
      slotStates,
      generatedDates,
      workloads,
      breakIntervals,
      generatedWorkMinutes,
      allowPartialCoverage: true,
    });
    allReliefActions.push(...actions);
    const key = `${segment.staffId}:${segment.date}`;
    const coverages = existingCoverageByKey.get(key) ?? [];
    coverages.push({ segment, coverage, actions });
    existingCoverageByKey.set(key, coverages);
  }

  const outcomes = [];
  const handledKeys = new Set();
  for (const request of requests) {
    handledKeys.add(request.key);
    const profile = sortedStaff.find((entry) => entry.id === request.staffId);
    const existingCoverages = existingCoverageByKey.get(request.key) ?? [];
    if (existingCoverages.length > 0) {
      const sufficient = existingCoverages.find(({ segment }) => {
        return segment.endMinutes - segment.startMinutes >= request.requiredBreakMinutes;
      });
      const coverageFailure = existingCoverages.find(({ coverage }) => !coverage.valid)?.coverage.failureReasonCode ?? null;
      const success = Boolean(sufficient) && coverageFailure === null;
      const breakSource = sufficient?.segment.source ?? existingCoverages[0].segment.source;
      const reservedReliefStaffIds = existingCoverages.flatMap(({ segment }) => {
        return segment.source === "generated" && segment.replacementStaffId
          ? [segment.replacementStaffId]
          : [];
      });
      const actionReliefStaffIds = existingCoverages.flatMap(({ actions }) => {
        return actions.map((action) => action.staff.staffId);
      });
      outcomes.push({
        staffId: request.staffId,
        staffCode: profile.staffCode,
        staffName: profile.name,
        date: request.date,
        requiredBreakMinutes: request.requiredBreakMinutes,
        placementStatus: success
          ? breakSource === "existing" ? "preserved_existing" : "placed"
          : "unresolved",
        placementSucceeded: success,
        breakStartTime: sufficient?.segment.startTime ?? null,
        breakEndTime: sufficient?.segment.endTime ?? null,
        breakSource,
        reliefRequired: reservedReliefStaffIds.length > 0
          || existingCoverages.some(({ actions }) => actions.length > 0),
        reliefStaffIds: [...new Set([...reservedReliefStaffIds, ...actionReliefStaffIds])].sort(),
        unresolvedReasonCode: coverageFailure
          ?? (sufficient ? null : "CONTIGUOUS_BREAK_UNAVAILABLE"),
      });
      continue;
    }
    if (request.requiredBreakMinutes === 0) {
      outcomes.push({
        staffId: request.staffId,
        staffCode: profile.staffCode,
        staffName: profile.name,
        date: request.date,
        requiredBreakMinutes: 0,
        placementStatus: "not_required",
        placementSucceeded: true,
        breakStartTime: null,
        breakEndTime: null,
        breakSource: null,
        reliefRequired: false,
        reliefStaffIds: [],
        unresolvedReasonCode: null,
      });
      continue;
    }
    const requiredSlots = request.requiredBreakMinutes / 15;
    const windows = contiguousWindows(
      slotStates,
      request.staffId,
      request.date,
      requiredSlots,
      existing.byStaffDate,
      breakIntervals,
    );
    const context = {
      targetStaffId: request.staffId,
      slotStates,
      staffProfiles: sortedStaff,
      generatedDates,
      existingSegments: existing.byStaffDate,
      breakIntervals,
      workloads,
      workLimitProfiles,
      generatedWorkMinutes,
      breakUnavailableStaffDates,
      availabilitySelections,
    };
    const candidates = windows.map((window) => evaluateBreakCandidate(context, window));
    const selected = candidates.filter((candidate) => candidate.coverage.valid).sort(compareBreakCandidates)[0];
    if (!selected) {
      const coverageFailure = candidates.find((candidate) => {
        return candidate.coverage.failureReasonCode === "QUALIFIED_BREAK_COVERAGE_UNAVAILABLE";
      })?.coverage.failureReasonCode
        ?? candidates.find((candidate) => candidate.coverage.failureReasonCode)?.coverage.failureReasonCode
        ?? "CONTIGUOUS_BREAK_UNAVAILABLE";
      outcomes.push({
        staffId: request.staffId,
        staffCode: profile.staffCode,
        staffName: profile.name,
        date: request.date,
        requiredBreakMinutes: request.requiredBreakMinutes,
        placementStatus: "unresolved",
        placementSucceeded: false,
        breakStartTime: null,
        breakEndTime: null,
        breakSource: null,
        reliefRequired: false,
        reliefStaffIds: [],
        unresolvedReasonCode: coverageFailure,
      });
      continue;
    }
    const breakSegment = {
      staffId: request.staffId,
      staffCode: profile.staffCode,
      staffName: profile.name,
      date: request.date,
      startTime: selected.window[0].startTime,
      endTime: selected.window.at(-1).endTime,
      startMinutes: selected.window[0].startMinutes,
      endMinutes: selected.window.at(-1).endMinutes,
      activityType: "break",
      source: "generated",
    };
    const actions = applyBreak({
      targetStaffId: request.staffId,
      breakSegment,
      coverage: selected.coverage,
      slotStates,
      generatedDates,
      workloads,
      breakIntervals,
      generatedWorkMinutes,
      allowPartialCoverage: false,
    });
    allReliefActions.push(...actions);
    outcomes.push({
      staffId: request.staffId,
      staffCode: profile.staffCode,
      staffName: profile.name,
      date: request.date,
      requiredBreakMinutes: request.requiredBreakMinutes,
      placementStatus: "placed",
      placementSucceeded: true,
      breakStartTime: breakSegment.startTime,
      breakEndTime: breakSegment.endTime,
      breakSource: "generated",
      reliefRequired: actions.length > 0,
      reliefStaffIds: [...new Set(actions.map((action) => action.staff.staffId))].sort(),
      unresolvedReasonCode: null,
    });
  }

  for (const [key, coverages] of existingCoverageByKey) {
    if (handledKeys.has(key)) continue;
    const segment = coverages[0].segment;
    const profile = sortedStaff.find((entry) => entry.id === segment.staffId);
    const coverageFailure = coverages.find(({ coverage }) => !coverage.valid)?.coverage.failureReasonCode ?? null;
    outcomes.push({
      staffId: segment.staffId,
      staffCode: profile.staffCode,
      staffName: profile.name,
      date: segment.date,
      requiredBreakMinutes: 0,
      placementStatus: coverageFailure ? "unresolved" : "preserved_existing",
      placementSucceeded: coverageFailure === null,
      breakStartTime: segment.startTime,
      breakEndTime: segment.endTime,
      breakSource: "existing",
      reliefRequired: coverages.some(({ actions }) => actions.length > 0),
      reliefStaffIds: [...new Set(coverages.flatMap(({ actions }) => {
        return actions.map((action) => action.staff.staffId);
      }))].sort(),
      unresolvedReasonCode: coverageFailure,
    });
  }

  outcomes.sort((left, right) => left.date.localeCompare(right.date)
    || staffSortKey(left).localeCompare(staffSortKey(right)));
  const finalSlots = finalizeSlots(slotStates);
  const breakSegments = breakIntervals.map(withoutInternalMinutes)
    .sort((left, right) => left.date.localeCompare(right.date)
      || left.startTime.localeCompare(right.startTime)
      || staffSortKey(left).localeCompare(staffSortKey(right)));
  const childcareSegments = mergeChildcareAssignmentsIntoSegments(finalSlots);
  const reliefAssignments = groupReliefActions(allReliefActions);
  const shortagesAfterBreaks = finalSlots.flatMap((slot) => {
    if (slot.childcareWorkerShortage === 0 && slot.licensedNurseryTeacherShortage === 0) return [];
    return [{
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      childcareWorkerShortage: slot.childcareWorkerShortage,
      licensedNurseryTeacherShortage: slot.licensedNurseryTeacherShortage,
    }];
  });
  const unresolvedConstraints = outcomes.flatMap((outcome) => outcome.unresolvedReasonCode ? [{
    code: outcome.unresolvedReasonCode,
    staffId: outcome.staffId,
    date: outcome.date,
    requiredBreakMinutes: outcome.requiredBreakMinutes,
  }] : []);

  return {
    placement: { ...placement, slots: finalSlots, staffWorkloads: [...workloads.values()] },
    breakOutcomes: outcomes,
    breakSegments,
    reliefAssignments,
    childcareSegments,
    scheduleSegments: [...childcareSegments, ...breakSegments].sort((left, right) => {
      return staffSortKey(left).localeCompare(staffSortKey(right))
        || left.date.localeCompare(right.date)
        || left.startTime.localeCompare(right.startTime);
    }),
    staffWorkloads: [...workloads.values()].sort((left, right) => left.staffId.localeCompare(right.staffId)),
    shortagesAfterBreaks,
    unplacedBreaks: outcomes.filter((outcome) => !outcome.placementSucceeded),
    unresolvedConstraints,
    reservedBreaks: reservations.map(withoutInternalMinutes),
  };
}
