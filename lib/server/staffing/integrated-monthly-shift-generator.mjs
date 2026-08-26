import { planFullTimeMonthlyDaysOff } from "./automatic-days-off-planner.mjs";
import { planAutomaticBreaks } from "./automatic-break-planner.mjs";
import {
  calculateAutomaticChildcareShift,
  mergeChildcareAssignmentsIntoSegments,
} from "./automatic-shift-generator.mjs";
import { calculateMonthlyScheduledWorkMinutes } from "./scheduled-work.mjs";

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

export function calculateIntegratedMonthlyAutomaticShift({
  targetMonth,
  requirementSlots = [],
  staffProfiles = [],
  closureDates = [],
  breakRequirements = [],
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
  const placement = calculateAutomaticChildcareShift(requirementSlots, placementProfiles, {
    workloadFairnessProfiles,
  });
  const breakPlan = planAutomaticBreaks({
    requirementSlots,
    placement,
    staffProfiles: placementProfiles,
    breakRequirements,
  });
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
    daysOffPlan,
    placement: breakPlan.placement,
    breakPlan,
    childcareSegments,
    breakSegments: breakPlan.breakSegments,
    scheduleSegments: breakPlan.scheduleSegments,
    staffWorkloads: breakPlan.staffWorkloads,
    shortages,
  };
}
