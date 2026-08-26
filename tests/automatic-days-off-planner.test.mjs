import assert from "node:assert/strict";
import test from "node:test";
import { planFullTimeMonthlyDaysOff } from "../lib/server/staffing/automatic-days-off-planner.mjs";

function staff(id, options = {}) {
  const employmentType = options.employmentType ?? "常勤";
  const qualification = Object.hasOwn(options, "qualification")
    ? options.qualification
    : "licensed_nursery_teacher";
  return {
    id,
    staffCode: options.staffCode ?? `ST${id}`,
    name: `架空 職員${id}`,
    employmentStartDate: options.employmentStartDate ?? "2026-01-01",
    employmentEndDate: options.employmentEndDate ?? null,
    status: options.status ?? "active",
    assignedRoles: [{ type: "nursery_teacher_role", validFrom: "2026-01-01", validTo: null }],
    validQualifications: qualification
      ? [{ type: qualification, validFrom: "2026-01-01", validTo: null }]
      : [],
    workConditions: [{
      validFrom: "2026-01-01",
      validTo: null,
      employmentType,
      availability: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        available: true,
        startTime: "09:00",
        endTime: "18:00",
      })),
    }],
    schedulePreferences: options.schedulePreferences ?? [],
    scheduledDays: options.scheduledDays ?? [],
  };
}

function workDay(staffId, date) {
  return { staffId, date, dayType: "work", segments: [] };
}

function dayOff(staffId, date) {
  return { staffId, date, dayType: "day_off", segments: [] };
}

function paidLeave(staffId, date) {
  return { staffId, date, dayType: "paid_leave", segments: [] };
}

function dayOffPreference(date) {
  return { date, preferenceType: "day_off", startTime: null, endTime: null };
}

function requirement(date, requiredChildcareWorkers = 1, requiredLicensedNurseryTeachers = 1) {
  return {
    date,
    startTime: "09:00",
    endTime: "09:15",
    requiredChildcareWorkers,
    requiredLicensedNurseryTeachers,
  };
}

function septemberDates() {
  return Array.from({ length: 30 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
}

test("plans nine public days off only for full-time staff", () => {
  const result = planFullTimeMonthlyDaysOff({
    targetMonth: "2026-09",
    staffProfiles: [staff("A"), staff("B", { employmentType: "非常勤" })],
  });
  const fullTime = result.staffPlans.find((entry) => entry.staffId === "A");
  const partTime = result.staffPlans.find((entry) => entry.staffId === "B");
  assert.equal(fullTime.plannedDaysOffCount, 9);
  assert.equal(fullTime.differenceFromRequiredDaysOff, 0);
  assert.equal(fullTime.monthlyBaseline.basicScheduledWorkMinutes, 168 * 60);
  assert.equal(fullTime.consecutiveWorkCheck.valid, true);
  assert.equal(partTime.requiredDaysOff, null);
  assert.deepEqual(partTime.automaticDaysOff, []);
  assert.equal(partTime.differenceFromRequiredDaysOff, null);
  assert.equal(partTime.consecutiveWorkCheck.valid, true);
  assert.deepEqual(partTime.unresolvedConstraints, []);
});

test("keeps existing public days off, excludes paid leave, and prioritizes requested days off", () => {
  const profile = staff("A", {
    scheduledDays: [dayOff("A", "2026-09-01"), paidLeave("A", "2026-09-02")],
    schedulePreferences: [dayOffPreference("2026-09-03"), dayOffPreference("2026-09-04")],
  });
  const plan = planFullTimeMonthlyDaysOff({ targetMonth: "2026-09", staffProfiles: [profile] }).staffPlans[0];
  assert.deepEqual(plan.existingDaysOff, ["2026-09-01"]);
  assert.deepEqual(plan.preferredPlannedDaysOff, ["2026-09-03", "2026-09-04"]);
  assert.ok(!plan.finalPlannedDaysOff.includes("2026-09-02"));
  assert.equal(plan.plannedDaysOffCount, 9);
  assert.equal(plan.automaticDaysOff.length, 6);
});

test("returns requested days beyond nine for administrator review without reclassifying them", () => {
  const preferences = Array.from({ length: 10 }, (_, index) => {
    return dayOffPreference(`2026-09-${String(index + 1).padStart(2, "0")}`);
  });
  const plan = planFullTimeMonthlyDaysOff({
    targetMonth: "2026-09",
    staffProfiles: [staff("A", { schedulePreferences: preferences })],
  }).staffPlans[0];
  assert.equal(plan.plannedDaysOffCount, 9);
  assert.deepEqual(plan.unclassifiedDayOffPreferences, [{
    date: "2026-09-10",
    reason: "MONTHLY_DAY_OFF_LIMIT_REACHED",
  }]);
  assert.ok(!plan.finalPlannedDaysOff.includes("2026-09-10"));
  assert.ok(plan.unresolvedConstraints.some((entry) => entry.code === "DAY_OFF_PREFERENCE_REQUIRES_REVIEW"));
});

test("selects low-impact days and avoids creating a licensed-staff shortage", () => {
  const lowDemandDates = new Set([
    "2026-09-01", "2026-09-04", "2026-09-07", "2026-09-10", "2026-09-13",
    "2026-09-16", "2026-09-19", "2026-09-22", "2026-09-25", "2026-09-28",
  ]);
  const requirements = septemberDates().map((date) => {
    return lowDemandDates.has(date) ? requirement(date, 0, 0) : requirement(date, 1, 1);
  });
  const result = planFullTimeMonthlyDaysOff({
    targetMonth: "2026-09",
    requirementSlots: requirements,
    closureDates: ["2026-09-13"],
    staffProfiles: [
      staff("A"),
      staff("B", { employmentType: "非常勤", qualification: "childcare_support_worker_local_childcare" }),
    ],
  });
  const plan = result.staffPlans.find((entry) => entry.staffId === "A");
  assert.equal(plan.automaticDaysOff.length, 9);
  assert.ok(plan.automaticDaysOff.every((date) => lowDemandDates.has(date)));
  assert.equal(result.days.reduce((total, day) => total + day.introducedLicensedNurseryTeacherShortage, 0), 0);
  assert.equal(result.days.find((day) => day.date === "2026-09-13").isClosureDay, true);
});

test("coordinates multiple full-time plans instead of concentrating avoidable days off", () => {
  const input = {
    targetMonth: "2026-09",
    requirementSlots: septemberDates().map((date) => requirement(date, 1, 1)),
    staffProfiles: [staff("B", { staffCode: "ST0002" }), staff("A", { staffCode: "ST0001" })],
  };
  const first = planFullTimeMonthlyDaysOff(input);
  const second = planFullTimeMonthlyDaysOff({
    ...input,
    staffProfiles: [...input.staffProfiles].reverse(),
    requirementSlots: [...input.requirementSlots].reverse(),
  });
  assert.deepEqual(first, second);
  assert.equal(first.staffPlans.every((entry) => entry.plannedDaysOffCount === 9), true);
  assert.equal(Math.max(...first.days.map((day) => day.plannedDayOffStaffIds.length)), 1);
  assert.equal(first.days.reduce((total, day) => total + day.introducedChildcareWorkerShortage, 0), 0);
});

test("uses prior-month work when preventing a seventh consecutive work day", () => {
  const priorDates = ["2026-08-29", "2026-08-30", "2026-08-31"];
  const plan = planFullTimeMonthlyDaysOff({
    targetMonth: "2026-09",
    staffProfiles: [staff("A", { scheduledDays: priorDates.map((date) => workDay("A", date)) })],
  }).staffPlans[0];
  assert.equal(plan.consecutiveWorkCheck.valid, true);
  assert.ok(plan.finalPlannedDaysOff.some((date) => date <= "2026-09-04"));
});

test("reports an unsatisfied plan without overwriting fixed work or breaking constraints", () => {
  const fixedWork = Array.from({ length: 7 }, (_, index) => {
    return workDay("A", `2026-09-${String(index + 1).padStart(2, "0")}`);
  });
  const plan = planFullTimeMonthlyDaysOff({
    targetMonth: "2026-09",
    staffProfiles: [staff("A", { scheduledDays: fixedWork })],
  }).staffPlans[0];
  assert.deepEqual(plan.automaticDaysOff, []);
  assert.equal(plan.plannedDaysOffCount, 0);
  assert.ok(plan.unresolvedConstraints.some((entry) => entry.code === "DAY_OFF_TARGET_UNRESOLVED"));
  assert.ok(plan.unresolvedConstraints.some((entry) => entry.code === "CONSECUTIVE_WORK_LIMIT_UNRESOLVED"));
});
