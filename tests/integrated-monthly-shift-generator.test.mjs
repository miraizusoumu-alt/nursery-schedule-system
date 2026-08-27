import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateAutomaticChildcareShift,
  compareScheduledWorkProgress,
} from "../lib/server/staffing/automatic-shift-generator.mjs";
import { calculateIntegratedMonthlyAutomaticShift } from "../lib/server/staffing/integrated-monthly-shift-generator.mjs";
import { calculateDailyScheduledWorkMinutes } from "../lib/server/staffing/scheduled-work.mjs";

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

function quarterHourRequirements(date, startTime, count, requiredWorkers = 1) {
  return Array.from({ length: count }, (_, index) => {
    return requirement(date, addMinutes(startTime, index * 15), requiredWorkers);
  });
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
      id: `condition-${id}`,
      validFrom: "2026-01-01",
      validTo: null,
      employmentType: options.employmentType ?? "常勤",
      ...(options.workCondition ?? {}),
      availability: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        available: true,
        startTime: "09:00",
        endTime: "18:00",
      })),
    }],
    schedulePreferences: options.schedulePreferences ?? [],
    scheduledDays: options.scheduledDays ?? [],
    availableScheduleMonths: options.availableScheduleMonths ?? [],
  };
}

function partTimeContract(overrides = {}) {
  return {
    weeklyMinutesLimit: 20 * 60,
    weeklyMinutesLimitType: "inclusive",
    preferredWeeklyWorkDaysMin: 1,
    weeklyWorkDaysMax: 5,
    dailyWorkMinutesMin: 15,
    dailyWorkMinutesMax: 5 * 60,
    ...overrides,
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

test("produces 480 final daily work minutes after placing a required continuous break", () => {
  const date = "2026-09-14";
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [staff("A"), staff("B", { staffCode: "ST0002" })],
    requirementSlots: quarterHourRequirements(date, "09:00", 36),
  });
  const dailyMinutes = ["A", "B"].map((staffId) => {
    return calculateDailyScheduledWorkMinutes(
      result.scheduleSegments.filter((segment) => segment.staffId === staffId && segment.date === date),
    );
  });
  assert.equal(Math.max(...dailyMinutes), 480);
  assert.ok(result.breakPlan.breakOutcomes.some((outcome) => {
    return outcome.date === date && outcome.requiredBreakMinutes === 60 && outcome.placementSucceeded;
  }));
});

test("keeps final daily work within 480 minutes when the required break cannot be placed", () => {
  const date = "2026-09-14";
  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [staff("A")],
    requirementSlots: quarterHourRequirements(date, "09:00", 33),
  });
  const scheduledWorkMinutes = calculateDailyScheduledWorkMinutes(
    result.scheduleSegments.filter((segment) => segment.staffId === "A" && segment.date === date),
  );
  assert.equal(scheduledWorkMinutes, 480);
  assert.equal(result.placement.slots.reduce((total, slot) => total + slot.childcareWorkerShortage, 0), 1);
  assert.ok(result.breakPlan.unresolvedConstraints.some((entry) => entry.staffId === "A" && entry.date === date));
});

test("preserves existing limit overages, blocks additions, and reports administrator review", () => {
  const dailyDate = "2026-09-14";
  const dailyOver = staff("A", {
    scheduledDays: [scheduleDay("A", dailyDate, "work", [{
      activityType: "administration",
      startTime: "09:00",
      endTime: "17:15",
    }])],
  });
  const dailyResult = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [dailyOver],
    requirementSlots: [requirement(dailyDate, "17:15", 1)],
  });
  assert.equal(dailyResult.placement.slots[0].assignedChildcareWorkerCount, 0);
  assert.ok(dailyResult.daysOffPlan.unresolvedConstraints.some((entry) => {
    return entry.code === "DAILY_WORK_LIMIT_UNRESOLVED" && entry.staffId === "A";
  }));
  assert.equal(calculateDailyScheduledWorkMinutes(dailyOver.scheduledDays[0].segments), 495);

  const nonWorkDates = new Set([4, 8, 12, 16, 20, 24, 28, 30]);
  const existingDays = Array.from({ length: 30 }, (_, index) => index + 1)
    .filter((day) => !nonWorkDates.has(day))
    .map((day) => scheduleDay("B", `2026-09-${String(day).padStart(2, "0")}`, "work", [{
      activityType: "childcare",
      startTime: "09:00",
      endTime: "17:00",
    }]));
  const monthlyResult = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [staff("B", { scheduledDays: existingDays })],
    requirementSlots: [requirement("2026-09-30", "09:00", 1)],
  });
  assert.equal(monthlyResult.placement.slots[0].assignedChildcareWorkerCount, 0);
  assert.ok(monthlyResult.daysOffPlan.unresolvedConstraints.some((entry) => {
    return entry.code === "MONTHLY_WORK_LIMIT_UNRESOLVED" && entry.staffId === "B";
  }));
  assert.equal(existingDays.length, 22);
});

test("prioritizes work-time preference dates and reports them when no placement is needed", () => {
  const date = "2026-09-14";
  const preferred = staff("A", {
    schedulePreferences: [{
      date,
      preferenceType: "work_time",
      startTime: "10:00",
      endTime: "16:00",
    }],
  });
  const assigned = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [preferred],
    requirementSlots: [requirement(date, "10:00", 1)],
  });
  assert.deepEqual(assigned.placement.slots[0].assignedStaff.map((entry) => entry.staffId), ["A"]);
  assert.ok(!assigned.daysOffPlan.staffPlans[0].finalPlannedDaysOff.includes(date));
  assert.ok(!assigned.daysOffPlan.unresolvedConstraints.some((entry) => {
    return entry.code === "PREFERRED_WORK_DAY_UNASSIGNED";
  }));

  const unassigned = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [preferred],
    requirementSlots: [],
  });
  assert.ok(!unassigned.daysOffPlan.staffPlans[0].finalPlannedDaysOff.includes(date));
  assert.ok(unassigned.daysOffPlan.unresolvedConstraints.some((entry) => {
    return entry.code === "PREFERRED_WORK_DAY_UNASSIGNED" && entry.date === date;
  }));
});

test("distinguishes part-time weekly limits below and within while enforcing weekly days and daily maximums", () => {
  const date = "2026-09-10";
  const exclusiveContract = partTimeContract({ weeklyMinutesLimitType: "exclusive" });
  const profile = staff("PT", { employmentType: "非常勤", workCondition: exclusiveContract });
  const baseLimitProfile = {
    staffId: "PT",
    targetMonth: "2026-09",
    dailyLimitMinutes: 480,
    monthlyLimitMinutes: null,
    workConditions: profile.workConditions,
    schedulePreferences: [],
    existingDays: [
      { date: "2026-09-07", scheduledWorkMinutes: 480, breakMinutes: 0 },
      { date: "2026-09-08", scheduledWorkMinutes: 480, breakMinutes: 0 },
      { date: "2026-09-09", scheduledWorkMinutes: 210, breakMinutes: 0 },
    ],
  };
  const exclusive = calculateAutomaticChildcareShift(
    quarterHourRequirements(date, "09:00", 2),
    [profile],
    { workLimitProfiles: [baseLimitProfile] },
  );
  assert.deepEqual(exclusive.slots.map((slot) => slot.assignedChildcareWorkerCount), [1, 0]);
  assert.ok(exclusive.slots[1].candidateEvaluations[0].exclusionReasons.includes(
    "PART_TIME_WEEKLY_WORK_LIMIT_EXCEEDED",
  ));

  const inclusiveProfile = staff("IN", {
    employmentType: "非常勤",
    workCondition: partTimeContract(),
  });
  const inclusive = calculateAutomaticChildcareShift(
    [requirement(date, "09:00", 1)],
    [inclusiveProfile],
    { workLimitProfiles: [{
      ...baseLimitProfile,
      staffId: "IN",
      workConditions: inclusiveProfile.workConditions,
      existingDays: [
        { date: "2026-09-07", scheduledWorkMinutes: 480, breakMinutes: 0 },
        { date: "2026-09-08", scheduledWorkMinutes: 480, breakMinutes: 0 },
        { date: "2026-09-09", scheduledWorkMinutes: 225, breakMinutes: 0 },
      ],
    }] },
  );
  assert.equal(inclusive.slots[0].assignedChildcareWorkerCount, 1);

  const dayLimitedProfile = staff("DAY", {
    employmentType: "非常勤",
    workCondition: partTimeContract({ dailyWorkMinutesMax: 180 }),
  });
  const dailyLimited = calculateAutomaticChildcareShift(
    quarterHourRequirements(date, "09:00", 13),
    [dayLimitedProfile],
    { workLimitProfiles: [{
      staffId: "DAY",
      targetMonth: "2026-09",
      dailyLimitMinutes: 480,
      monthlyLimitMinutes: null,
      workConditions: dayLimitedProfile.workConditions,
      existingDays: [],
    }] },
  );
  assert.equal(dailyLimited.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount, 0), 12);
  assert.ok(dailyLimited.slots.at(-1).candidateEvaluations[0].exclusionReasons.includes(
    "PART_TIME_DAILY_WORK_MINUTES_EXCEEDED",
  ));

  const daysLimitedProfile = staff("DAYS", {
    employmentType: "非常勤",
    workCondition: partTimeContract({ weeklyWorkDaysMax: 3 }),
  });
  const daysLimited = calculateAutomaticChildcareShift(
    [requirement(date, "09:00", 1)],
    [daysLimitedProfile],
    { workLimitProfiles: [{
      staffId: "DAYS",
      targetMonth: "2026-09",
      dailyLimitMinutes: 480,
      monthlyLimitMinutes: null,
      workConditions: daysLimitedProfile.workConditions,
      existingDays: [
        { date: "2026-09-07", scheduledWorkMinutes: 180, breakMinutes: 0 },
        { date: "2026-09-08", scheduledWorkMinutes: 180, breakMinutes: 0 },
        { date: "2026-09-09", scheduledWorkMinutes: 180, breakMinutes: 0 },
      ],
    }] },
  );
  assert.equal(daysLimited.slots[0].assignedChildcareWorkerCount, 0);
  assert.ok(daysLimited.slots[0].candidateEvaluations[0].exclusionReasons.includes(
    "PART_TIME_WEEKLY_WORK_DAYS_EXCEEDED",
  ));
});

test("selects one Friday alternative while preserving a three-to-five-hour part-time contract", () => {
  const date = "2026-09-11";
  const profile = staff("PT-ALT", {
    employmentType: "非常勤",
    workCondition: partTimeContract({
      weeklyWorkDaysMax: 3,
      dailyWorkMinutesMin: 3 * 60,
      dailyWorkMinutesMax: 5 * 60,
    }),
    availableScheduleMonths: ["2026-08", "2026-10"],
  });
  profile.workConditions[0].availability = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    available: weekday === 5,
    startTime: weekday === 5 ? "10:00" : null,
    endTime: weekday === 5 ? "14:30" : null,
    candidates: weekday === 5 ? [
      {
        candidateId: "friday-morning",
        candidateOrder: 0,
        startTime: "10:00",
        endTime: "14:30",
        weekOrdinals: null,
      },
      {
        candidateId: "friday-afternoon",
        candidateOrder: 1,
        startTime: "15:00",
        endTime: "18:30",
        weekOrdinals: null,
      },
    ] : [],
  }));
  const requirementSlots = [
    ...quarterHourRequirements(date, "10:00", 18),
    ...quarterHourRequirements(date, "15:00", 14),
  ];

  const result = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [profile],
    requirementSlots,
  });
  const selected = result.placement.selectedAvailabilityCandidates.find((entry) => entry.staffId === profile.id);
  const assignedSlots = result.placement.slots.filter((slot) => slot.assignedStaff.some((entry) => (
    entry.staffId === profile.id
  )));

  assert.equal(selected.candidateId, "friday-morning");
  assert.equal(assignedSlots.length * 15, 270);
  assert.equal(assignedSlots.every((slot) => slot.startTime >= "10:00" && slot.endTime <= "14:30"), true);
  assert.equal(result.daysOffPlan.unresolvedConstraints.some((entry) => (
    entry.staffId === profile.id && [
      "PART_TIME_DAILY_MINIMUM_MINUTES_UNMET",
      "PART_TIME_DAILY_WORK_MINUTES_EXCEEDED",
      "PART_TIME_WEEKLY_WORK_DAYS_EXCEEDED",
      "PART_TIME_WEEKLY_WORK_MINUTES_EXCEEDED",
    ].includes(entry.code)
  )), false);
});

test("does not keep short part-time assignments unless a shorter daily preference explicitly allows them", () => {
  const date = "2026-09-14";
  const contract = partTimeContract({ dailyWorkMinutesMin: 180, dailyWorkMinutesMax: 300 });
  const short = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [staff("PT", {
      employmentType: "非常勤",
      workCondition: contract,
      availableScheduleMonths: ["2026-08", "2026-10"],
    })],
    requirementSlots: quarterHourRequirements(date, "09:00", 4),
  });
  assert.equal(short.placement.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount, 0), 0);
  assert.ok(short.placement.slots[0].candidateEvaluations[0].exclusionReasons.includes(
    "PART_TIME_DAILY_MINIMUM_MINUTES_UNMET",
  ));

  const preferred = calculateIntegratedMonthlyAutomaticShift({
    targetMonth: "2026-09",
    staffProfiles: [staff("PT", {
      employmentType: "非常勤",
      workCondition: contract,
      availableScheduleMonths: ["2026-08", "2026-10"],
      schedulePreferences: [{
        date,
        preferenceType: "work_time",
        startTime: "09:00",
        endTime: "11:00",
      }],
    })],
    requirementSlots: quarterHourRequirements(date, "09:00", 8),
  });
  assert.equal(preferred.placement.slots.reduce((total, slot) => total + slot.assignedChildcareWorkerCount, 0), 8);
  assert.ok(!preferred.daysOffPlan.staffPlans[0].finalPlannedDaysOff.includes(date));
});
