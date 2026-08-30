import { planFullTimeMonthlyDaysOff } from "./automatic-days-off-planner.mjs";
import {
  planAutomaticBreaks,
  reserveAutomaticBreakCoverage,
} from "./automatic-break-planner.mjs";
import { resolveDailyBreakRequirements } from "./break-requirements.mjs";
import {
  calculateAutomaticChildcareShift,
  enumerateAutomaticCapacityTransferCandidates,
  mergeChildcareAssignmentsIntoSegments,
} from "./automatic-shift-generator.mjs";
import { buildAutomaticScheduleDraft } from "./automatic-draft.mjs";
import { evaluateCurrentDraftSchedule } from "./draft-schedule-review.mjs";
import { staffDateWorkKey } from "./automatic-work-limits.mjs";
import { evaluatePartTimeScheduleRules } from "./part-time-work-rules.mjs";
import {
  calculateMonthlyScheduledWorkMinutes,
  calculateScheduleDayWorkMinutes,
  FULL_TIME_DAILY_MINUTES,
  validateScheduleDay,
} from "./scheduled-work.mjs";

function profileWithPlannedDaysOff(profile, plan) {
  const existingDates = new Set((profile.scheduledDays ?? []).map((day) => day.date));
  const additions = (plan?.finalPlannedDaysOff ?? [])
    .filter((date) => !existingDates.has(date))
    .map((date) => ({ staffId: profile.id, date, dayType: "day_off", segments: [] }));
  return {
    ...profile,
    scheduledDays: [...(profile.scheduledDays ?? []), ...additions],
  };
}

function existingScheduledWorkMinutes(profile, targetMonth) {
  const monthlyDays = (profile.scheduledDays ?? []).filter((day) => day.date.startsWith(`${targetMonth}-`));
  return calculateMonthlyScheduledWorkMinutes(monthlyDays, { staffId: profile.id });
}

function buildWorkLimitProfiles(staffProfiles, planByStaffId, targetMonth) {
  return staffProfiles.map((profile) => {
    const plan = planByStaffId.get(profile.id);
    const existingDays = (profile.scheduledDays ?? [])
      .map((rawDay) => {
        const day = validateScheduleDay(rawDay);
        return {
          date: day.date,
          scheduledWorkMinutes: calculateScheduleDayWorkMinutes(day),
          breakMinutes: day.segments
            .filter((segment) => segment.activityType === "break")
            .reduce((total, segment) => total + segment.endMinutes - segment.startMinutes, 0),
        };
      });
    return {
      staffId: profile.id,
      targetMonth,
      dailyLimitMinutes: FULL_TIME_DAILY_MINUTES,
      monthlyLimitMinutes: plan?.monthlyBaseline?.basicScheduledWorkMinutes ?? null,
      workConditions: profile.workConditions ?? [],
      schedulePreferences: profile.schedulePreferences ?? [],
      availableScheduleMonths: profile.availableScheduleMonths ?? [],
      existingDays,
    };
  });
}

function finalGeneratedMinutesByStaffDate(slots) {
  const generated = new Map();
  for (const slot of slots) {
    for (const assigned of slot.assignedStaff ?? []) {
      const key = staffDateWorkKey(assigned.staffId, slot.date);
      generated.set(key, (generated.get(key) ?? 0) + 15);
    }
  }
  return generated;
}

function finalWorkLimitViolations(workLimitProfiles, slots) {
  const generated = finalGeneratedMinutesByStaffDate(slots);
  const violations = [];
  for (const profile of workLimitProfiles) {
    const existing = new Map(profile.existingDays.map((day) => [day.date, day.scheduledWorkMinutes]));
    const dates = new Set(existing.keys());
    for (const key of generated.keys()) {
      const [staffId, date] = key.split("\u0000");
      if (staffId === profile.staffId) dates.add(date);
    }
    let monthlyScheduledWorkMinutes = 0;
    for (const date of dates) {
      const generatedScheduledWorkMinutes = generated.get(staffDateWorkKey(profile.staffId, date)) ?? 0;
      const scheduledWorkMinutes = (existing.get(date) ?? 0) + generatedScheduledWorkMinutes;
      if (date.startsWith(`${profile.targetMonth}-`)) monthlyScheduledWorkMinutes += scheduledWorkMinutes;
      if (date.startsWith(`${profile.targetMonth}-`) && scheduledWorkMinutes > profile.dailyLimitMinutes) {
        violations.push({
          code: "DAILY_WORK_LIMIT_UNRESOLVED",
          staffId: profile.staffId,
          date,
          scheduledWorkMinutes,
          limitMinutes: profile.dailyLimitMinutes,
          generatedScheduledWorkMinutes,
        });
      }
    }
    if (profile.monthlyLimitMinutes !== null
      && monthlyScheduledWorkMinutes > profile.monthlyLimitMinutes) {
      violations.push({
        code: "MONTHLY_WORK_LIMIT_UNRESOLVED",
        staffId: profile.staffId,
        scheduledWorkMinutes: monthlyScheduledWorkMinutes,
        limitMinutes: profile.monthlyLimitMinutes,
        generatedScheduledWorkMinutes: [...generated.entries()].reduce((total, [key, minutes]) => {
          return key.startsWith(`${profile.staffId}\u0000`) ? total + minutes : total;
        }, 0),
      });
    }
  }
  return violations;
}

function fixedWorkLimitConstraints(workLimitProfiles) {
  const constraints = [];
  for (const profile of workLimitProfiles) {
    const monthlyScheduledWorkMinutes = profile.existingDays.reduce((total, day) => {
      if (!day.date.startsWith(`${profile.targetMonth}-`)) return total;
      if (day.scheduledWorkMinutes > profile.dailyLimitMinutes) {
        constraints.push({
          code: "DAILY_WORK_LIMIT_UNRESOLVED",
          staffId: profile.staffId,
          date: day.date,
          scheduledWorkMinutes: day.scheduledWorkMinutes,
          limitMinutes: profile.dailyLimitMinutes,
          message: "既存勤務が日次予定実労働時間の上限を超えています。自動配置では変更しません。",
        });
      }
      return total + day.scheduledWorkMinutes;
    }, 0);
    if (profile.monthlyLimitMinutes !== null
      && monthlyScheduledWorkMinutes > profile.monthlyLimitMinutes) {
      constraints.push({
        code: "MONTHLY_WORK_LIMIT_UNRESOLVED",
        staffId: profile.staffId,
        scheduledWorkMinutes: monthlyScheduledWorkMinutes,
        limitMinutes: profile.monthlyLimitMinutes,
        message: "既存勤務が月間予定実労働時間の上限を超えています。自動配置では変更しません。",
      });
    }
  }
  return constraints;
}

function partTimeScheduleConstraints(staffProfiles, targetMonth, slots) {
  const generated = finalGeneratedMinutesByStaffDate(slots);
  return staffProfiles.flatMap((profile) => {
    const dayWorkMinutes = [...generated.entries()].flatMap(([key, scheduledWorkMinutes]) => {
      const [staffId, date] = key.split("\u0000");
      return staffId === profile.id ? [{ date, scheduledWorkMinutes }] : [];
    });
    return evaluatePartTimeScheduleRules({
      profile,
      days: profile.scheduledDays ?? [],
      dayWorkMinutes,
      targetMonth,
    }).map((issue) => ({
      ...issue,
      message: issue.label,
    }));
  });
}

function preferredWorkDayConstraints(staffProfiles, targetMonth, slots) {
  const generated = finalGeneratedMinutesByStaffDate(slots);
  return staffProfiles.flatMap((profile) => {
    return (profile.schedulePreferences ?? []).flatMap((preference) => {
      if (preference.preferenceType !== "work_time" || !preference.date.startsWith(`${targetMonth}-`)) return [];
      const existing = (profile.scheduledDays ?? []).find((day) => day.date === preference.date);
      const assigned = (generated.get(staffDateWorkKey(profile.id, preference.date)) ?? 0) > 0
        || (existing ? calculateScheduleDayWorkMinutes(existing) > 0 : false);
      if (assigned) return [];
      return [{
        code: "PREFERRED_WORK_DAY_UNASSIGNED",
        staffId: profile.id,
        date: preference.date,
        startTime: preference.startTime,
        endTime: preference.endTime,
        message: "勤務希望日に自動配置できなかったため、管理者確認が必要です。",
      }];
    });
  });
}

function appendStaffConstraints(daysOffPlan, constraints) {
  const byStaffId = new Map();
  for (const constraint of constraints) {
    const values = byStaffId.get(constraint.staffId) ?? [];
    values.push(constraint);
    byStaffId.set(constraint.staffId, values);
  }
  return {
    ...daysOffPlan,
    staffPlans: daysOffPlan.staffPlans.map((plan) => ({
      ...plan,
      unresolvedConstraints: [
        ...plan.unresolvedConstraints,
        ...(byStaffId.get(plan.staffId) ?? []).map((entry) => {
          const constraint = { ...entry };
          delete constraint.staffId;
          return constraint;
        }),
      ],
    })),
    unresolvedConstraints: [...daysOffPlan.unresolvedConstraints, ...constraints],
  };
}

const BREAK_DERIVED_ASSIGNMENT_SOURCES = new Set(["break_reservation", "break_relief"]);

function staffDateKey(staffId, date) {
  return `${staffId}\u0000${date}`;
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function segmentMinutes(segment) {
  return timeToMinutes(segment.endTime) - timeToMinutes(segment.startTime);
}

function segmentOverlapsSlot(segment, slot) {
  return segment.date === slot.date
    && segment.startTime < slot.endTime
    && slot.startTime < segment.endTime;
}

function assignmentSortKey(assignment) {
  return `${assignment.staffCode ?? ""}\u0000${assignment.staffId}`;
}

function recalculatePlacementSlot(slot, assignments) {
  const assignedStaff = [...assignments.values()].sort((left, right) => {
    return assignmentSortKey(left).localeCompare(assignmentSortKey(right));
  });
  const licensed = assignedStaff.filter((entry) => entry.isLicensedNurseryTeacher).length;
  return {
    ...slot,
    assignedStaff,
    assignedChildcareWorkerCount: assignedStaff.length,
    assignedLicensedNurseryTeacherCount: licensed,
    childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - assignedStaff.length),
    licensedNurseryTeacherShortage: Math.max(0, slot.requiredLicensedNurseryTeachers - licensed),
  };
}

function placementWithRecalculatedWorkloads(placement, slots) {
  const generatedMinutes = new Map();
  for (const slot of slots) {
    for (const assigned of slot.assignedStaff ?? []) {
      generatedMinutes.set(assigned.staffId, (generatedMinutes.get(assigned.staffId) ?? 0) + 15);
    }
  }
  const staffWorkloads = (placement.staffWorkloads ?? []).map((workload) => {
    const generatedScheduledWorkMinutes = generatedMinutes.get(workload.staffId) ?? 0;
    const scheduledWorkMinutes = workload.initialScheduledWorkMinutes + generatedScheduledWorkMinutes;
    return {
      ...workload,
      generatedScheduledWorkMinutes,
      scheduledWorkMinutes,
      progressRatio: scheduledWorkMinutes / workload.basicScheduledWorkMinutes,
    };
  }).sort((left, right) => left.staffId.localeCompare(right.staffId));
  return { ...placement, slots, staffWorkloads };
}

function shortageEntries(slots) {
  return slots.flatMap((slot) => {
    if (slot.childcareWorkerShortage === 0 && slot.licensedNurseryTeacherShortage === 0) return [];
    return [{
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      childcareWorkerShortage: slot.childcareWorkerShortage,
      licensedNurseryTeacherShortage: slot.licensedNurseryTeacherShortage,
    }];
  });
}

function finalizeGenerationResult({
  targetMonth,
  baseDaysOffPlan,
  fixedLimitConstraints,
  staffProfiles,
  breakPlan,
  breakCoveragePreparation,
  phase2Repair = null,
}) {
  const preferredWorkConstraints = preferredWorkDayConstraints(
    staffProfiles,
    targetMonth,
    breakPlan.placement.slots,
  );
  const partTimeConstraints = partTimeScheduleConstraints(
    staffProfiles,
    targetMonth,
    breakPlan.placement.slots,
  );
  const daysOffPlan = appendStaffConstraints(
    baseDaysOffPlan,
    [...fixedLimitConstraints, ...preferredWorkConstraints, ...partTimeConstraints],
  );
  const childcareSegments = mergeChildcareAssignmentsIntoSegments(breakPlan.placement.slots);
  return {
    targetMonth,
    daysOffPlan,
    placement: breakPlan.placement,
    breakPlan,
    breakCoveragePreparation,
    childcareSegments,
    breakSegments: breakPlan.breakSegments,
    scheduleSegments: breakPlan.scheduleSegments,
    staffWorkloads: breakPlan.staffWorkloads,
    shortages: shortageEntries(breakPlan.placement.slots),
    phase2Repair,
  };
}

function validateGenerationStructure(result) {
  const grouped = new Map();
  for (const segment of result.scheduleSegments ?? []) {
    const key = staffDateKey(segment.staffId, segment.date);
    const values = grouped.get(key) ?? [];
    values.push(segment);
    grouped.set(key, values);
  }
  for (const [key, segments] of grouped) {
    const [, date] = key.split("\u0000");
    validateScheduleDay({ date, dayType: "work", segments });
  }
}

function reviewGenerationResult({ targetMonth, requirementSlots, staffProfiles, result }) {
  validateGenerationStructure(result);
  const currentDays = buildAutomaticScheduleDraft({
    targetMonth,
    generationResult: result,
    staffProfiles,
  });
  const review = evaluateCurrentDraftSchedule({
    targetMonth,
    requirementSource: { period: { targetMonth }, slots: requirementSlots },
    staffProfiles,
    currentDays,
  });
  return { review, currentDays };
}

function reviewCounts(review) {
  const redIssues = review.confirmation.redIssues;
  return {
    red: review.confirmation.redCount,
    yellow: review.confirmation.yellowCount,
    childcare: redIssues.filter((issue) => issue.kind === "childcareStaffing").length,
    licensed: redIssues.filter((issue) => issue.kind === "licensedStaffing").length,
    breaks: redIssues.filter((issue) => issue.kind === "breaks").length,
    workConditions: redIssues.filter((issue) => issue.kind === "workConditions").length,
  };
}

function redIssueSignature(issue) {
  return JSON.stringify({
    kind: issue.kind ?? null,
    code: issue.code ?? null,
    staffId: issue.staffId ?? null,
    date: issue.date ?? null,
    startTime: issue.startTime ?? null,
    endTime: issue.endTime ?? null,
  });
}

function zeroDemandAssignmentCount(result) {
  return result.placement.slots.reduce((total, slot) => {
    return total + (slot.requiredChildcareWorkers === 0 ? slot.assignedStaff.length : 0);
  }, 0);
}

function slotShortagesDoNotIncrease(before, after) {
  return before.placement.slots.every((slot, index) => {
    const next = after.placement.slots[index];
    return next
      && next.date === slot.date
      && next.startTime === slot.startTime
      && next.childcareWorkerShortage <= slot.childcareWorkerShortage
      && next.licensedNurseryTeacherShortage <= slot.licensedNurseryTeacherShortage;
  });
}

function reviewDoesNotRegress(current, candidate) {
  const before = reviewCounts(current.review);
  const after = reviewCounts(candidate.review);
  const previousRed = new Set(current.review.confirmation.redIssues.map(redIssueSignature));
  return after.red < before.red
    && after.yellow <= before.yellow
    && after.childcare <= before.childcare
    && after.licensed <= before.licensed
    && after.breaks <= before.breaks
    && after.workConditions <= before.workConditions
    && candidate.review.confirmation.redIssues.every((issue) => previousRed.has(redIssueSignature(issue)))
    && slotShortagesDoNotIncrease(current.result, candidate.result)
    && zeroDemandAssignmentCount(candidate.result) <= zeroDemandAssignmentCount(current.result);
}

function breakMinutesByStaffDate(breakSegments) {
  const minutes = new Map();
  for (const segment of breakSegments ?? []) {
    const key = staffDateKey(segment.staffId, segment.date);
    minutes.set(key, (minutes.get(key) ?? 0) + segmentMinutes(segment));
  }
  return minutes;
}

function breakRequirementsForResult(result) {
  return resolveDailyBreakRequirements(result.scheduleSegments ?? []);
}

function breakRequirementsForPlacement(placement) {
  return resolveDailyBreakRequirements(mergeChildcareAssignmentsIntoSegments(placement.slots));
}

function pendingBreakRequirements(result) {
  const actual = breakMinutesByStaffDate(result.breakSegments);
  return breakRequirementsForResult(result).filter((requirement) => {
    return (actual.get(staffDateKey(requirement.staffId, requirement.date)) ?? 0)
      < requirement.requiredBreakMinutes;
  });
}

function generatedBreakReservations(result) {
  return (result.breakSegments ?? []).filter((segment) => segment.source === "generated").map((segment) => ({
    staffId: segment.staffId,
    staffCode: segment.staffCode,
    staffName: segment.staffName,
    date: segment.date,
    startTime: segment.startTime,
    endTime: segment.endTime,
    activityType: "break",
    source: "generated",
    ...(segment.replacementStaffId ? { replacementStaffId: segment.replacementStaffId } : {}),
  }));
}

function addDependency(graph, left, right) {
  if (!left || !right || left === right) return;
  const leftValues = graph.get(left) ?? new Set();
  const rightValues = graph.get(right) ?? new Set();
  leftValues.add(right);
  rightValues.add(left);
  graph.set(left, leftValues);
  graph.set(right, rightValues);
}

function breakDependencyGraph(result) {
  const graph = new Map();
  for (const slot of result.placement.slots) {
    for (const assigned of slot.assignedStaff ?? []) {
      if (!BREAK_DERIVED_ASSIGNMENT_SOURCES.has(assigned.assignmentSource)) continue;
      addDependency(
        graph,
        staffDateKey(assigned.staffId, slot.date),
        assigned.reliefForStaffId ? staffDateKey(assigned.reliefForStaffId, slot.date) : null,
      );
    }
  }
  for (const segment of result.breakSegments ?? []) {
    if (!segment.replacementStaffId) continue;
    addDependency(
      graph,
      staffDateKey(segment.staffId, segment.date),
      staffDateKey(segment.replacementStaffId, segment.date),
    );
  }
  for (const assignment of result.breakPlan?.reliefAssignments ?? []) {
    addDependency(
      graph,
      staffDateKey(assignment.staffId, assignment.date),
      staffDateKey(assignment.reliefForStaffId, assignment.date),
    );
  }
  for (const assignment of result.breakCoveragePreparation?.reassignments ?? []) {
    addDependency(
      graph,
      staffDateKey(assignment.replacementStaffId, assignment.date),
      staffDateKey(assignment.relievedStaffId, assignment.date),
    );
  }
  return graph;
}

function expandAffectedStaffDates(initial, result) {
  const affected = new Set(initial);
  const graph = breakDependencyGraph(result);
  const queue = [...affected].sort();
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    for (const dependency of [...(graph.get(key) ?? [])].sort()) {
      if (affected.has(dependency)) continue;
      affected.add(dependency);
      queue.push(dependency);
    }
  }
  return affected;
}

function directlyAffectedStaffDates(before, after) {
  const affected = new Set();
  for (let index = 0; index < before.slots.length; index += 1) {
    const previous = before.slots[index];
    const next = after.slots[index];
    if (!next || previous.date !== next.date || previous.startTime !== next.startTime) {
      throw new TypeError("capacity transfer前後の15分枠が一致しません。");
    }
    const previousIds = new Set(previous.assignedStaff.map((entry) => entry.staffId));
    const nextIds = new Set(next.assignedStaff.map((entry) => entry.staffId));
    for (const staffId of new Set([...previousIds, ...nextIds])) {
      if (previousIds.has(staffId) !== nextIds.has(staffId)) {
        affected.add(staffDateKey(staffId, previous.date));
      }
    }
  }
  return affected;
}

function placementWithUnaffectedBreakEffects(normalPlacement, currentResult, affected) {
  const oldBySlot = new Map(currentResult.placement.slots.map((slot) => [
    `${slot.date}\u0000${slot.startTime}`,
    slot,
  ]));
  const preservedBreaks = generatedBreakReservations(currentResult).filter((segment) => (
    !affected.has(staffDateKey(segment.staffId, segment.date))
  ));
  const slots = normalPlacement.slots.map((slot) => {
    const assignments = new Map(slot.assignedStaff.map((entry) => [entry.staffId, { ...entry }]));
    for (const segment of preservedBreaks) {
      if (segmentOverlapsSlot(segment, slot)) assignments.delete(segment.staffId);
    }
    const old = oldBySlot.get(`${slot.date}\u0000${slot.startTime}`);
    for (const assigned of old?.assignedStaff ?? []) {
      if (!BREAK_DERIVED_ASSIGNMENT_SOURCES.has(assigned.assignmentSource)) continue;
      const reliefKey = staffDateKey(assigned.staffId, slot.date);
      const targetKey = assigned.reliefForStaffId
        ? staffDateKey(assigned.reliefForStaffId, slot.date)
        : null;
      if (affected.has(reliefKey) || (targetKey && affected.has(targetKey))) continue;
      assignments.set(assigned.staffId, { ...assigned });
    }
    return recalculatePlacementSlot(slot, assignments);
  });
  return placementWithRecalculatedWorkloads(normalPlacement, slots);
}

function reusableAffectedBreaks({ currentResult, normalPlacement, affected, requirements }) {
  const requirementByKey = new Map(requirements.map((entry) => [
    staffDateKey(entry.staffId, entry.date),
    entry.requiredBreakMinutes,
  ]));
  return generatedBreakReservations(currentResult).filter((segment) => {
    const key = staffDateKey(segment.staffId, segment.date);
    if (!affected.has(key)) return false;
    const requiredMinutes = requirementByKey.get(key) ?? 0;
    if (requiredMinutes === 0 || segmentMinutes(segment) < requiredMinutes) return false;
    const window = normalPlacement.slots.filter((slot) => segmentOverlapsSlot(segment, slot));
    return window.length * 15 >= requiredMinutes && window.every((slot) => (
      slot.assignedStaff.some((entry) => entry.staffId === segment.staffId)
    ));
  });
}

function rebuildBreakPlanAfterPlacementChange({
  requirementSlots,
  normalPlacement,
  currentResult,
  staffProfiles,
  affected,
}) {
  const requirements = breakRequirementsForPlacement(normalPlacement);
  const preparedPlacement = placementWithUnaffectedBreakEffects(normalPlacement, currentResult, affected);
  const unaffectedReservations = generatedBreakReservations(currentResult).filter((segment) => (
    !affected.has(staffDateKey(segment.staffId, segment.date))
  ));
  const reusable = reusableAffectedBreaks({
    currentResult,
    normalPlacement,
    affected,
    requirements,
  });
  const blockedReuseKeys = new Set();
  const maximumAttempts = reusable.length + 1;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const affectedReservations = reusable.filter((segment) => (
      !blockedReuseKeys.has(staffDateKey(segment.staffId, segment.date))
    ));
    const reservations = [...unaffectedReservations, ...affectedReservations];
    const reservedKeys = new Set(reservations.map((segment) => (
      staffDateKey(segment.staffId, segment.date)
    )));
    const reservable = requirements.filter((entry) => (
      affected.has(staffDateKey(entry.staffId, entry.date))
      && !reservedKeys.has(staffDateKey(entry.staffId, entry.date))
    ));
    const preparation = reserveAutomaticBreakCoverage({
      requirementSlots,
      placement: preparedPlacement,
      staffProfiles,
      breakRequirements: reservable,
    });
    const allReservations = [...reservations, ...preparation.reservations];
    const breakPlan = planAutomaticBreaks({
      requirementSlots,
      placement: preparation.placement,
      staffProfiles,
      breakRequirements: requirements,
      reservedBreaks: allReservations,
    });
    const outcomeByKey = new Map(breakPlan.breakOutcomes.map((outcome) => [
      staffDateKey(outcome.staffId, outcome.date),
      outcome,
    ]));
    const failedUnaffected = unaffectedReservations.some((segment) => (
      !outcomeByKey.get(staffDateKey(segment.staffId, segment.date))?.placementSucceeded
    ));
    if (failedUnaffected) return null;
    const failedReuseKeys = affectedReservations.flatMap((segment) => {
      const key = staffDateKey(segment.staffId, segment.date);
      return outcomeByKey.get(key)?.placementSucceeded ? [] : [key];
    });
    if (failedReuseKeys.length === 0) {
      return {
        breakPlan,
        preparation,
        affectedStaffDates: [...affected].sort(),
        reusedBreakCount: affectedReservations.length + unaffectedReservations.length,
      };
    }
    let changed = false;
    for (const key of failedReuseKeys) {
      if (!blockedReuseKeys.has(key)) {
        blockedReuseKeys.add(key);
        changed = true;
      }
    }
    if (!changed) return null;
  }
  return null;
}

function stableBreakRequirementEntries(result) {
  return breakRequirementsForResult(result).map((entry) => ({
    staffId: entry.staffId,
    date: entry.date,
    requiredBreakMinutes: entry.requiredBreakMinutes,
  })).sort((left, right) => left.date.localeCompare(right.date)
    || left.staffId.localeCompare(right.staffId));
}

function repairStateFingerprint(result, review) {
  const slots = result.placement.slots.map((slot) => ({
    date: slot.date,
    startTime: slot.startTime,
    assignments: slot.assignedStaff.map((entry) => ({
      staffId: entry.staffId,
      assignmentSource: entry.assignmentSource ?? "automatic",
      reliefForStaffId: entry.reliefForStaffId ?? null,
    })).sort((left, right) => left.staffId.localeCompare(right.staffId)),
  }));
  const breaks = (result.breakSegments ?? []).map((segment) => ({
    staffId: segment.staffId,
    date: segment.date,
    startTime: segment.startTime,
    endTime: segment.endTime,
  })).sort((left, right) => left.date.localeCompare(right.date)
    || left.startTime.localeCompare(right.startTime)
    || left.staffId.localeCompare(right.staffId));
  const unresolvedCodes = review.confirmation.redIssues.map((issue) => ({
    code: issue.code,
    staffId: issue.staffId ?? null,
    date: issue.date ?? null,
    startTime: issue.startTime ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({ slots, breaks, requirements: stableBreakRequirementEntries(result), unresolvedCodes });
}

function continuePendingBreakPlan({ requirementSlots, staffProfiles, current }) {
  const pending = pendingBreakRequirements(current.result);
  if (pending.length === 0) return null;
  const actual = breakMinutesByStaffDate(current.result.breakSegments);
  const reservable = pending.filter((requirement) => {
    return (actual.get(staffDateKey(requirement.staffId, requirement.date)) ?? 0) === 0;
  });
  const preparation = reserveAutomaticBreakCoverage({
    requirementSlots,
    placement: current.result.placement,
    staffProfiles,
    breakRequirements: reservable,
  });
  const reservationsByKey = new Map(generatedBreakReservations(current.result).map((entry) => [
    staffDateKey(entry.staffId, entry.date),
    entry,
  ]));
  for (const reservation of preparation.reservations) {
    const key = staffDateKey(reservation.staffId, reservation.date);
    if (!reservationsByKey.has(key)) reservationsByKey.set(key, reservation);
  }
  const breakPlan = planAutomaticBreaks({
    requirementSlots,
    placement: preparation.placement,
    staffProfiles,
    breakRequirements: breakRequirementsForResult(current.result),
    reservedBreaks: [...reservationsByKey.values()],
  });
  return { breakPlan, preparation, pendingCount: pending.length };
}

function assignmentChangeCount(before, after) {
  return before.placement.slots.reduce((total, slot, index) => {
    const beforeIds = slot.assignedStaff.map((entry) => entry.staffId).sort().join("\u0000");
    const afterIds = after.placement.slots[index].assignedStaff.map((entry) => entry.staffId).sort().join("\u0000");
    return total + Number(beforeIds !== afterIds);
  }, 0);
}

function breakRequirementIncrease(before, after) {
  const beforeByKey = new Map(stableBreakRequirementEntries(before).map((entry) => [
    staffDateKey(entry.staffId, entry.date),
    entry.requiredBreakMinutes,
  ]));
  return stableBreakRequirementEntries(after).reduce((summary, entry) => {
    const increase = Math.max(0, entry.requiredBreakMinutes - (beforeByKey.get(
      staffDateKey(entry.staffId, entry.date),
    ) ?? 0));
    return {
      count: summary.count + Number(increase > 0),
      minutes: summary.minutes + increase,
    };
  }, { count: 0, minutes: 0 });
}

function preservedBreakLossCount(before, after) {
  const afterKeys = new Set((after.breakSegments ?? []).map((segment) => {
    return `${segment.staffId}\u0000${segment.date}\u0000${segment.startTime}\u0000${segment.endTime}`;
  }));
  return (before.breakSegments ?? []).filter((segment) => !afterKeys.has(
    `${segment.staffId}\u0000${segment.date}\u0000${segment.startTime}\u0000${segment.endTime}`,
  )).length;
}

function compareRepairCandidates(left, right) {
  const leftCounts = reviewCounts(left.review);
  const rightCounts = reviewCounts(right.review);
  return leftCounts.red - rightCounts.red
    || left.newBreakRequirements.count - right.newBreakRequirements.count
    || left.newBreakRequirements.minutes - right.newBreakRequirements.minutes
    || left.preservedBreakLosses - right.preservedBreakLosses
    || left.fragmentIncrease - right.fragmentIncrease
    || left.assignmentChanges - right.assignmentChanges
    || left.tieBreak.localeCompare(right.tieBreak);
}

function evaluateCandidateUntilStable({
  candidate,
  baseDaysOffPlan,
  fixedLimitConstraints,
  targetMonth,
  requirementSlots,
  staffProfiles,
  placementStaffProfiles,
  maximumRounds,
}) {
  let state = candidate;
  const seen = new Set();
  let iterations = 0;
  let newlyRequiredBreaks = 0;
  while (iterations < maximumRounds) {
    const fingerprint = repairStateFingerprint(state.result, state.review);
    if (seen.has(fingerprint)) return { ...state, stable: false, cycleDetected: true, iterations };
    seen.add(fingerprint);
    const pending = pendingBreakRequirements(state.result);
    if (pending.length === 0) {
      return { ...state, stable: true, cycleDetected: false, iterations, newlyRequiredBreaks };
    }
    const nextPlan = continuePendingBreakPlan({
      requirementSlots,
      staffProfiles: placementStaffProfiles,
      current: state,
    });
    if (!nextPlan) return { ...state, stable: false, cycleDetected: false, iterations };
    const nextResult = finalizeGenerationResult({
      targetMonth,
      baseDaysOffPlan,
      fixedLimitConstraints,
      staffProfiles,
      breakPlan: nextPlan.breakPlan,
      breakCoveragePreparation: nextPlan.preparation,
    });
    const nextReview = reviewGenerationResult({
      targetMonth,
      requirementSlots,
      staffProfiles,
      result: nextResult,
    }).review;
    if (reviewCounts(nextReview).red >= reviewCounts(state.review).red) {
      return { ...state, stable: false, cycleDetected: false, iterations };
    }
    newlyRequiredBreaks += breakRequirementIncrease(state.result, nextResult).count;
    state = { ...state, result: nextResult, review: nextReview };
    iterations += 1;
  }
  return {
    ...state,
    stable: pendingBreakRequirements(state.result).length === 0,
    cycleDetected: false,
    iterations,
  };
}

function repairResidualAutomaticShiftIssues({
  initialResult,
  normalPlacement,
  baseDaysOffPlan,
  fixedLimitConstraints,
  targetMonth,
  requirementSlots,
  staffProfiles,
  placementStaffProfiles,
  workloadFairnessProfiles,
}) {
  let current = {
    result: initialResult,
    review: reviewGenerationResult({
      targetMonth,
      requirementSlots,
      staffProfiles,
      result: initialResult,
    }).review,
  };
  const startRedCount = reviewCounts(current.review).red;
  const maximumRounds = Math.min(startRedCount, 8);
  const seen = new Set([repairStateFingerprint(current.result, current.review)]);
  const acceptedRepairs = [];
  let capacityPlacement = normalPlacement;
  let cycleDetected = false;
  let examinedCapacityCandidates = 0;

  for (let round = 0; round < maximumRounds; round += 1) {
    const candidates = [];
    const breakCandidate = evaluateCandidateUntilStable({
      candidate: { ...current, kind: "break_replan", tieBreak: "0:break" },
      baseDaysOffPlan,
      fixedLimitConstraints,
      targetMonth,
      requirementSlots,
      staffProfiles,
      placementStaffProfiles,
      maximumRounds: maximumRounds - round,
    });
    if (breakCandidate.stable && reviewDoesNotRegress(current, breakCandidate)) {
      candidates.push(breakCandidate);
    }

    const transfers = enumerateAutomaticCapacityTransferCandidates({
      placement: capacityPlacement,
      staffProfiles: placementStaffProfiles,
      workloadFairnessProfiles,
    });
    examinedCapacityCandidates += transfers.length;
    for (const transfer of transfers) {
      const placement = placementWithRecalculatedWorkloads(
        { ...capacityPlacement, slots: transfer.slots },
        transfer.slots,
      );
      const directlyAffected = directlyAffectedStaffDates(capacityPlacement, placement);
      const affected = expandAffectedStaffDates(directlyAffected, current.result);
      const rebuilt = rebuildBreakPlanAfterPlacementChange({
        requirementSlots,
        normalPlacement: placement,
        currentResult: current.result,
        staffProfiles: placementStaffProfiles,
        affected,
      });
      if (!rebuilt) continue;
      const initialTransferResult = finalizeGenerationResult({
        targetMonth,
        baseDaysOffPlan,
        fixedLimitConstraints,
        staffProfiles,
        breakPlan: rebuilt.breakPlan,
        breakCoveragePreparation: rebuilt.preparation,
      });
      let initialTransferReview;
      try {
        initialTransferReview = reviewGenerationResult({
          targetMonth,
          requirementSlots,
          staffProfiles,
          result: initialTransferResult,
        }).review;
      } catch {
        continue;
      }
      const evaluated = evaluateCandidateUntilStable({
        candidate: {
          result: initialTransferResult,
          review: initialTransferReview,
          kind: "capacity_transfer",
          transfer,
          capacityPlacement: placement,
          affectedStaffDates: rebuilt.affectedStaffDates,
          reusedBreakCount: rebuilt.reusedBreakCount,
          tieBreak: `1:${transfer.date}:${transfer.targetStartTime}:${transfer.sourceStaffId}:${transfer.incomingStaffId}`,
        },
        baseDaysOffPlan,
        fixedLimitConstraints,
        targetMonth,
        requirementSlots,
        staffProfiles,
        placementStaffProfiles,
        maximumRounds: maximumRounds - round,
      });
      if (!evaluated.stable || !reviewDoesNotRegress(current, evaluated)) continue;
      candidates.push(evaluated);
    }
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      candidate.newBreakRequirements = breakRequirementIncrease(current.result, candidate.result);
      candidate.preservedBreakLosses = preservedBreakLossCount(current.result, candidate.result);
      candidate.fragmentIncrease = Math.max(
        0,
        candidate.result.childcareSegments.length - current.result.childcareSegments.length,
      );
      candidate.assignmentChanges = assignmentChangeCount(current.result, candidate.result);
    }
    const selected = candidates.sort(compareRepairCandidates)[0];
    const fingerprint = repairStateFingerprint(selected.result, selected.review);
    if (seen.has(fingerprint)) {
      cycleDetected = true;
      break;
    }
    seen.add(fingerprint);
    acceptedRepairs.push({
      kind: selected.kind,
      transfer: selected.transfer ? { ...selected.transfer, slots: undefined } : null,
      affectedStaffDates: selected.affectedStaffDates ?? [],
      reusedBreakCount: selected.reusedBreakCount ?? null,
      redBefore: reviewCounts(current.review).red,
      redAfter: reviewCounts(selected.review).red,
      breakReplanIterations: selected.iterations,
      newlyRequiredBreaks: selected.newlyRequiredBreaks,
    });
    if (selected.capacityPlacement) capacityPlacement = selected.capacityPlacement;
    current = { result: selected.result, review: selected.review };
  }
  current.result.phase2Repair = {
    startRedCount,
    finalRedCount: reviewCounts(current.review).red,
    finalYellowCount: reviewCounts(current.review).yellow,
    maximumRounds,
    completedRounds: acceptedRepairs.length,
    cycleDetected,
    acceptedRepairs,
    examinedCapacityCandidates,
    finalFingerprint: repairStateFingerprint(current.result, current.review),
  };
  return current.result;
}

export function calculateIntegratedMonthlyAutomaticShift({
  targetMonth,
  requirementSlots = [],
  staffProfiles = [],
  closureDates = [],
}) {
  if (!Array.isArray(staffProfiles)) {
    throw new TypeError("職員候補を配列で指定してください。");
  }

  const daysOffPlan = planFullTimeMonthlyDaysOff({
    targetMonth,
    requirementSlots,
    staffProfiles,
    closureDates,
  });
  const planByStaffId = new Map(daysOffPlan.staffPlans.map((plan) => [plan.staffId, plan]));
  const placementProfiles = staffProfiles.map((profile) => {
    return profileWithPlannedDaysOff(profile, planByStaffId.get(profile.id));
  });
  const workloadFairnessProfiles = staffProfiles.flatMap((profile) => {
    const plan = planByStaffId.get(profile.id);
    if (!plan?.monthlyBaseline) return [];
    return [{
      staffId: profile.id,
      scheduledWorkMinutes: existingScheduledWorkMinutes(profile, targetMonth),
      basicScheduledWorkMinutes: plan.monthlyBaseline.basicScheduledWorkMinutes,
    }];
  });
  const workLimitProfiles = buildWorkLimitProfiles(staffProfiles, planByStaffId, targetMonth);
  const fixedLimitConstraints = fixedWorkLimitConstraints(workLimitProfiles);
  const breakUnavailableStaffDates = new Set();
  let placement;
  let breakPlan;
  let breakCoveragePreparation;
  const maximumAttempts = Math.max(1, requirementSlots.length + 1);
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    placement = calculateAutomaticChildcareShift(requirementSlots, placementProfiles, {
      workloadFairnessProfiles,
      workLimitProfiles,
      breakUnavailableStaffDates,
    });
    const breakRequirements = resolveDailyBreakRequirements(
      mergeChildcareAssignmentsIntoSegments(placement.slots),
    );
    breakCoveragePreparation = reserveAutomaticBreakCoverage({
      requirementSlots,
      placement,
      staffProfiles: placementProfiles,
      breakRequirements,
    });
    breakPlan = planAutomaticBreaks({
      requirementSlots,
      placement: breakCoveragePreparation.placement,
      staffProfiles: placementProfiles,
      breakRequirements,
      reservedBreaks: breakCoveragePreparation.reservations,
    });
    const generatedViolations = finalWorkLimitViolations(workLimitProfiles, breakPlan.placement.slots)
      .filter((constraint) => constraint.generatedScheduledWorkMinutes > 0);
    if (generatedViolations.length === 0) break;
    let addedConstraint = false;
    for (const violation of generatedViolations) {
      if (violation.date) {
        const key = staffDateWorkKey(violation.staffId, violation.date);
        if (!breakUnavailableStaffDates.has(key)) {
          breakUnavailableStaffDates.add(key);
          addedConstraint = true;
        }
      } else {
        for (const slot of breakPlan.placement.slots) {
          if (!(slot.assignedStaff ?? []).some((entry) => entry.staffId === violation.staffId)) continue;
          const key = staffDateWorkKey(violation.staffId, slot.date);
          if (!breakUnavailableStaffDates.has(key)) {
            breakUnavailableStaffDates.add(key);
            addedConstraint = true;
          }
        }
      }
    }
    if (!addedConstraint) {
      throw new RangeError("自動生成結果を予定実労働時間上限内に収められません。");
    }
  }
  const remainingGeneratedViolations = finalWorkLimitViolations(
    workLimitProfiles,
    breakPlan.placement.slots,
  ).filter((constraint) => constraint.generatedScheduledWorkMinutes > 0);
  if (remainingGeneratedViolations.length > 0) {
    throw new RangeError("自動生成結果を予定実労働時間上限内に収められません。");
  }
  const initialResult = finalizeGenerationResult({
    targetMonth,
    baseDaysOffPlan: daysOffPlan,
    fixedLimitConstraints,
    staffProfiles,
    breakPlan,
    breakCoveragePreparation,
  });
  return repairResidualAutomaticShiftIssues({
    initialResult,
    normalPlacement: placement,
    baseDaysOffPlan: daysOffPlan,
    fixedLimitConstraints,
    targetMonth,
    requirementSlots,
    staffProfiles,
    placementStaffProfiles: placementProfiles,
    workloadFairnessProfiles,
  });
}
