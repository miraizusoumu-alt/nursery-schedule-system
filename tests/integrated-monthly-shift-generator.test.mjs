import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateAutomaticChildcareShift,
  compareScheduledWorkProgress,
} from "../lib/server/staffing/automatic-shift-generator.mjs";
import { calculateIntegratedMonthlyAutomaticShift } from "../lib/server/staffing/integrated-monthly-shift-generator.mjs";

function addMinutes(time, amount) {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + amount;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function requirement(date, startTime, requiredChildcareWorkers, requiredLicensedNurseryTeachers = 0) {
  return {
    date,
    startTime,
    endTime: addMinutes(startTime, 15),
    requiredChildcareWorkers,
    requiredLicensedNurseryTeachers,
  };
}

function scheduleDay(staffId, date, dayType = "work", segments = []) {
  return { staffId, date, dayType, segments };
}

function staff(id, options = {}) {
  const qualification = Object.hasOwn(options, "qualification")
    ? options.qualification
    : "licensed_nursery_teacher";
  return {
    id,
    staffCode: options.staffCode ?? `ST${id}`,
    name: `架空 職員${id}`,
    employmentStartDate: "2026-01-01",
    employmentEndDate: null,
    status: "active",
    assignedRoles: [{ type: "nursery_teacher_role", validFrom: "2026-01-01", validTo: null }],
    validQualifications: qualification
      ? [{ type: qualification, validFrom: "2026-01-01", validTo: null }]
      : [],
    workConditions: [{
      validFrom: "2026-01-01",
      validTo: null,
      employmentType: options.employmentType ?? "常勤",
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

test("integrates planned days off while preserving paid leave and non-work other days", () => {
  const profiles = [
    staff("A", {
      staffCode: "ST0001",
      schedulePreferences: [{
        date: "2026-09-10",
        preferenceType: "day_off",
        startTime: null,
        endTime: null,
      }],
      scheduledDays: [scheduleDay("A", "2026-09-11")],
    }),
    staff("B", {
      staffCode: "ST0002",
      scheduledDays: [
        scheduleDay("B", "2026-09-10"),
        scheduleDay("B", "2026-09-11", "other"),
        scheduleDay("B", "2026-09-12", "paid_leave"),
      ],
    }),
  ];
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: profiles,
    requirementSlots: [
      requirement("2026-09-10", "09:00", 1, 1),
      requirement("2026-09-11", "09:00", 1, 1),
      requirement("2026-09-12", "09:00", 1, 1),
    ],
  });

  assert.deepEqual(result.placement.slots.map((slot) => slot.assignedStaff.map((entry) => entry.staffId)), [
    ["B"],
    ["A"],
    ["A"],
  ]);
  assert.ok(result.daysOffPlan.staffPlans
    .find((plan) => plan.staffId === "A").finalPlannedDaysOff.includes("2026-09-10"));
  const otherEvaluation = result.placement.slots[1].candidateEvaluations.find((entry) => entry.staffId === "B");
  assert.ok(otherEvaluation.exclusionReasons.includes("EXISTING_NON_WORK_DAY"));
  const paidLeaveEvaluation = result.placement.slots[2].candidateEvaluations.find((entry) => entry.staffId === "B");
  assert.ok(paidLeaveEvaluation.exclusionReasons.includes("EXISTING_NON_WORK_DAY"));
  assert.deepEqual(result.shortages, []);
});

test("honors daily work-time preferences and the six-day consecutive-work limit after planning days off", () => {
  const preferred = staff("A", {
    schedulePreferences: [{
      date: "2026-09-14",
      preferenceType: "work_time",
      startTime: "10:00",
      endTime: "16:00",
    }],
    scheduledDays: [scheduleDay("A", "2026-09-14")],
  });
  const priorSix = Array.from({ length: 7 }, (_, index) => {
    return scheduleDay("B", `2026-09-${String(index + 8).padStart(2, "0")}`);
  });
  const seventh = staff("B", { scheduledDays: priorSix });
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [preferred, seventh],
    requirementSlots: [
      requirement("2026-09-14", "09:45", 1),
      requirement("2026-09-14", "10:00", 1),
    ],
  });

  assert.equal(result.placement.slots[0].assignedChildcareWorkerCount, 0);
  assert.ok(result.placement.slots[0].candidateEvaluations
    .find((entry) => entry.staffId === "A").exclusionReasons.includes("OUTSIDE_PREFERENCE_TIME"));
  assert.deepEqual(result.placement.slots[1].assignedStaff.map((entry) => entry.staffId), ["A"]);
  assert.ok(result.placement.slots[1].candidateEvaluations
    .find((entry) => entry.staffId === "B").exclusionReasons.includes("CONSECUTIVE_WORK_LIMIT"));
});

test("prioritizes licensed requirements before workload fairness", () => {
  const licensed = staff("A", { staffCode: "ST0001" });
  const support = staff("B", {
    staffCode: "ST0002",
    qualification: "childcare_support_worker_local_childcare",
  });
  const result = calculateAutomaticChildcareShift(
    [requirement("2026-09-07", "09:00", 1, 1)],
    [licensed, support],
    { workloadFairnessProfiles: [
      { staffId: "A", scheduledWorkMinutes: 120 * 60, basicScheduledWorkMinutes: 168 * 60 },
      { staffId: "B", scheduledWorkMinutes: 80 * 60, basicScheduledWorkMinutes: 168 * 60 },
    ] },
  );
  assert.deepEqual(result.slots[0].assignedStaff.map((entry) => entry.staffId), ["A"]);
  assert.equal(result.slots[0].licensedNurseryTeacherShortage, 0);
});

test("uses full-time monthly progress ratios and updates them after every assignment", () => {
  assert.equal(compareScheduledWorkProgress(
    { scheduledWorkMinutes: 88 * 60, basicScheduledWorkMinutes: 176 * 60 },
    { scheduledWorkMinutes: 96 * 60, basicScheduledWorkMinutes: 168 * 60 },
  ), -1);

  const profiles = [
    staff("A", { staffCode: "ST0001" }),
    staff("B", { staffCode: "ST0002" }),
  ];
  const result = calculateAutomaticChildcareShift([
    requirement("2026-09-07", "09:00", 1),
    requirement("2026-09-07", "09:15", 1),
    requirement("2026-09-08", "09:00", 1),
  ], profiles, {
    workloadFairnessProfiles: [
      { staffId: "A", scheduledWorkMinutes: 0, basicScheduledWorkMinutes: 168 * 60 },
      { staffId: "B", scheduledWorkMinutes: 0, basicScheduledWorkMinutes: 168 * 60 },
    ],
  });

  assert.deepEqual(result.slots.map((slot) => slot.assignedStaff.map((entry) => entry.staffId)), [
    ["A"],
    ["A"],
    ["B"],
  ]);
  assert.equal(result.slots[1].assignedStaff[0].continuedFromPreviousSlot, true);
  assert.deepEqual(result.staffWorkloads.map((entry) => [entry.staffId, entry.generatedScheduledWorkMinutes]), [
    ["A", 30],
    ["B", 15],
  ]);
});

test("the integrated month favors lower progress and merges continuous childcare segments", () => {
  const targetDate = "2026-09-20";
  const existingHour = {
    activityType: "administration",
    startTime: "09:00",
    endTime: "10:00",
  };
  const profiles = [
    staff("A", {
      staffCode: "ST0001",
      scheduledDays: [
        scheduleDay("A", "2026-09-01", "work", [existingHour]),
        scheduleDay("A", targetDate),
      ],
    }),
    staff("B", {
      staffCode: "ST0002",
      scheduledDays: [scheduleDay("B", targetDate)],
    }),
  ];
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: profiles,
    requirementSlots: [
      requirement(targetDate, "10:00", 1),
      requirement(targetDate, "10:15", 1),
    ],
  });

  assert.deepEqual(result.placement.slots.map((slot) => slot.assignedStaff.map((entry) => entry.staffId)), [
    ["B"],
    ["B"],
  ]);
  assert.deepEqual(result.childcareSegments, [{
    staffId: "B",
    staffCode: "ST0002",
    staffName: "架空 職員B",
    date: targetDate,
    startTime: "10:00",
    endTime: "10:30",
    activityType: "childcare",
  }]);
  assert.equal(result.staffWorkloads.find((entry) => entry.staffId === "A").scheduledWorkMinutes, 60);
  assert.equal(result.staffWorkloads.find((entry) => entry.staffId === "B").scheduledWorkMinutes, 30);
});

test("keeps shortages instead of violating protected schedules or qualification requirements", () => {
  const date = "2026-09-21";
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [
      staff("A", { scheduledDays: [scheduleDay("A", date, "paid_leave")] }),
      staff("B", {
        qualification: "childcare_support_worker_local_childcare",
        scheduledDays: [scheduleDay("B", date)],
      }),
    ],
    requirementSlots: [requirement(date, "09:00", 2, 1)],
  });
  const slot = result.placement.slots[0];
  assert.deepEqual(slot.assignedStaff.map((entry) => entry.staffId), ["B"]);
  assert.equal(slot.childcareWorkerShortage, 1);
  assert.equal(slot.licensedNurseryTeacherShortage, 1);
  assert.equal(result.shortages.length, 1);
});

test("returns the same integrated month for the same input regardless of array order", () => {
  const date = "2026-09-24";
  const profiles = [
    staff("A", { staffCode: "ST0001", scheduledDays: [scheduleDay("A", date)] }),
    staff("B", { staffCode: "ST0002", scheduledDays: [scheduleDay("B", date)] }),
    staff("C", {
      staffCode: "ST0003",
      qualification: "childcare_support_worker_local_childcare",
      scheduledDays: [scheduleDay("C", date)],
    }),
  ];
  const requirements = [
    requirement(date, "09:00", 2, 1),
    requirement(date, "09:15", 2, 1),
  ];
  const first = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: profiles,
    requirementSlots: requirements,
  });
  const second = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [...profiles].reverse(),
    requirementSlots: [...requirements].reverse(),
  });
  assert.deepEqual(first, second);
});
