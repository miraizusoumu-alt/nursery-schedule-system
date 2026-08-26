import { planFullTimeMonthlyDaysOff } from "./automatic-days-off-planner.mjs";
import {
  planAutomaticBreaks,
  reserveAutomaticBreakCoverage,
} from "./automatic-break-planner.mjs";
import { resolveDailyBreakRequirements } from "./break-requirements.mjs";
import {
  calculateAutomaticChildcareShift,
  mergeChildcareAssignmentsIntoSegments,
} from "./automatic-shift-generator.mjs";
import { staffDateWorkKey } from "./automatic-work-limits.mjs";
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
      .filter((day) => day.date.startsWith(`${targetMonth}-`))
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
      dailyLimitMinutes: FULL_TIME_DAILY_MINUTES,
      monthlyLimitMinutes: plan?.monthlyBaseline?.basicScheduledWorkMinutes ?? null,
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
      monthlyScheduledWorkMinutes += scheduledWorkMinutes;
      if (scheduledWorkMinutes > profile.dailyLimitMinutes) {
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
  const preferredWorkConstraints = preferredWorkDayConstraints(
    staffProfiles,
    targetMonth,
    breakPlan.placement.slots,
  );
  const resolvedDaysOffPlan = appendStaffConstraints(
    daysOffPlan,
    [...fixedLimitConstraints, ...preferredWorkConstraints],
  );
  const childcareSegments = mergeChildcareAssignmentsIntoSegments(breakPlan.placement.slots);
  const shortages = breakPlan.placement.slots.flatMap((slot) => {
    if (slot.childcareWorkerShortage === 0 && slot.licensedNurseryTeacherShortage === 0) return [];
    return [{
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      childcareWorkerShortage: slot.childcareWorkerShortage,
      licensedNurseryTeacherShortage: slot.licensedNurseryTeacherShortage,
    }];
  });

  return {
    targetMonth,
    daysOffPlan: resolvedDaysOffPlan,
    placement: breakPlan.placement,
    breakPlan,
    breakCoveragePreparation,
    childcareSegments,
    breakSegments: breakPlan.breakSegments,
    scheduleSegments: breakPlan.scheduleSegments,
    staffWorkloads: breakPlan.staffWorkloads,
    shortages,
  };
}
