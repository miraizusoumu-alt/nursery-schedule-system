import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDraftScheduleConfirmation,
  evaluateCurrentDraftSchedule,
} from "../lib/server/staffing/draft-schedule-review.mjs";

function profile(id, staffCode, qualification = "licensed_nursery_teacher", options = {}) {
  return {
    id,
    staffCode,
    name: `架空 ${staffCode}`,
    employmentStartDate: "2026-01-01",
    employmentEndDate: null,
    status: "active",
    assignedRoles: [],
    validQualifications: qualification ? [{
      type: qualification,
      validFrom: "2026-01-01",
      validTo: null,
    }] : [],
    workConditions: [{
      id: `condition-${id}`,
      validFrom: "2026-01-01",
      validTo: null,
      employmentType: options.employmentType ?? "常勤",
      ...(options.workCondition ?? {}),
      availability: options.availability ?? Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        available: true,
        startTime: "06:30",
        endTime: "20:30",
      })),
    }],
    schedulePreferences: options.schedulePreferences ?? [],
    scheduledDays: options.scheduledDays ?? [],
    availableScheduleMonths: options.availableScheduleMonths ?? [],
  };
}

function day(staffId, date, segments, dayType = "work") {
  return { staffId, date, dayType, segments };
}

function childcare(startTime, endTime) {
  return { startTime, endTime, activityType: "childcare" };
}

function requirement(date, startTime, requiredChildcareWorkers, requiredLicensedNurseryTeachers) {
  const [hours, minutes] = startTime.split(":").map(Number);
  const end = hours * 60 + minutes + 15;
  return {
    date,
    startTime,
    endTime: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
    requiredChildcareWorkers,
    requiredLicensedNurseryTeachers,
  };
}

test("rechecks saved staffing, work conditions, limits, consecutive work, and breaks without altering input", () => {
  const targetMonth = "2026-09";
  const currentDays = [
    day("staff-a", "2026-09-07", [
      childcare("09:00", "12:00"),
      { startTime: "12:00", endTime: "13:00", activityType: "break" },
      childcare("13:00", "18:00"),
    ]),
    day("staff-b", "2026-09-07", [], "day_off"),
    day("staff-c", "2026-09-08", [childcare("08:00", "09:00")]),
    ...Array.from({ length: 23 }, (_, index) => day(
      "staff-d",
      `2026-09-${String(index + 1).padStart(2, "0")}`,
      index === 7 ? [childcare("06:30", "14:45")] : [childcare("09:00", "17:00")],
    )),
  ];
  const profiles = [
    profile("staff-a", "ST0001", "licensed_nursery_teacher", {
      schedulePreferences: [{
        date: "2026-09-07",
        preferenceType: "day_off",
        startTime: null,
        endTime: null,
      }],
    }),
    profile("staff-b", "ST0002"),
    profile("staff-c", "ST0003", "childcare_support_worker_local_childcare", {
      employmentType: "非常勤",
      schedulePreferences: [{
        date: "2026-09-08",
        preferenceType: "work_time",
        startTime: "09:00",
        endTime: "16:00",
      }],
    }),
    profile("staff-d", "ST0004"),
  ];
  const requirementSource = {
    period: { id: "period-review", targetMonth, status: "open" },
    slots: [
      requirement("2026-09-07", "12:00", 2, 2),
      requirement("2026-09-07", "12:15", 2, 2),
      requirement("2026-09-08", "08:00", 2, 2),
    ],
  };
  const before = structuredClone({ profiles, currentDays, requirementSource });

  const review = evaluateCurrentDraftSchedule({ targetMonth, requirementSource, staffProfiles: profiles, currentDays });

  assert.equal(review.requirementSlotCount, 3);
  assert.equal(review.issues.childcareStaffing.some((issue) => issue.date === "2026-09-07"), true);
  assert.equal(review.issues.licensedStaffing.some((issue) => issue.date === "2026-09-08"), true);
  assert.equal(review.issues.licensedStaffing.find((issue) => issue.date === "2026-09-08")
    .assignedLicensedNurseryTeacherCount, 1, "a support worker is not counted as a nursery teacher");
  assert.equal(review.issues.workConditions.some((issue) => issue.code === "PREFERENCE_DAY_OFF"), true);
  assert.equal(review.issues.workConditions.some((issue) => issue.code === "OUTSIDE_PREFERENCE_TIME"), true);
  assert.equal(review.issues.workConditions.some((issue) => issue.code === "DAILY_WORK_LIMIT_EXCEEDED"), true);
  assert.equal(review.issues.workConditions.some((issue) => issue.code === "MONTHLY_WORK_LIMIT_EXCEEDED"), true);
  assert.equal(review.issues.workConditions.some((issue) => issue.code === "CONSECUTIVE_WORK_LIMIT"), true);
  assert.equal(review.issues.workConditions.some((issue) => issue.code === "DAY_OFF_TARGET_UNRESOLVED"), true);
  assert.equal(review.issues.breaks.some((issue) => issue.code === "BREAK_CHILDCARE_COVERAGE_SHORTAGE"), true);
  assert.equal(review.issues.breaks.some((issue) => issue.code === "BREAK_LICENSED_COVERAGE_SHORTAGE"), true);
  assert.equal(review.issues.breaks.some((issue) => issue.code === "BREAK_MINUTES_SHORTAGE"), true);
  assert.equal(review.confirmation.status, "blocked");
  assert.equal(review.confirmation.canConfirm, false);
  assert.equal(review.confirmation.redCount > 0, true);
  assert.equal(review.confirmation.yellowCount > 0, true, "red and yellow issues remain separately visible");
  assert.deepEqual(
    review.issues.breaks
      .filter((issue) => issue.staffId === "staff-a" && issue.code === "BREAK_CHILDCARE_COVERAGE_SHORTAGE")
      .map(({ startTime, endTime }) => ({ startTime, endTime })),
    [{ startTime: "12:00", endTime: "12:30" }],
  );
  assert.equal(review.hasIssues, true);
  assert.deepEqual({ profiles, currentDays, requirementSource }, before);
});

test("reports mixed alternative availability candidates and week-specific outside work as warnings", () => {
  const availability = Array.from({ length: 7 }, (_, weekday) => ({
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
        weekOrdinals: [2, 4],
      },
    ] : [],
  }));
  const staff = profile("staff-alt", "ST0090", "licensed_nursery_teacher", {
    employmentType: "非常勤",
    availability,
  });
  const review = evaluateCurrentDraftSchedule({
    targetMonth: "2026-09",
    requirementSource: { period: null, slots: [] },
    staffProfiles: [staff],
    currentDays: [
      day("staff-alt", "2026-09-11", [
        childcare("10:00", "12:00"),
        childcare("15:00", "17:00"),
      ]),
      day("staff-alt", "2026-09-18", [childcare("15:00", "16:00")]),
    ],
  });
  assert.equal(review.issues.workConditions.some((issue) => (
    issue.code === "MULTIPLE_AVAILABILITY_CANDIDATES_USED" && issue.date === "2026-09-11"
  )), true);
  assert.equal(review.issues.workConditions.some((issue) => (
    issue.code === "OUTSIDE_AVAILABLE_TIME" && issue.date === "2026-09-18"
  )), true);
  assert.equal(review.confirmation.yellowIssues.some((issue) => (
    issue.code === "MULTIPLE_AVAILABILITY_CANDIDATES_USED"
  )), true);
});

test("reports a clean current draft when staffing and rules are satisfied", () => {
  const targetMonth = "2026-09";
  const staff = profile("staff-a", "ST0001", "licensed_nursery_teacher", { employmentType: "非常勤" });
  const currentDays = [day("staff-a", "2026-09-01", [childcare("09:00", "10:00")])];
  const review = evaluateCurrentDraftSchedule({
    targetMonth,
    requirementSource: {
      period: { id: "period-clean", targetMonth, status: "open" },
      slots: [requirement("2026-09-01", "09:00", 1, 1)],
    },
    staffProfiles: [staff],
    currentDays,
  });

  assert.deepEqual(review.summary, {
    childcareStaffing: 0,
    licensedStaffing: 0,
    workConditions: 0,
    breaks: 0,
  });
  assert.equal(review.hasIssues, false);
  assert.deepEqual(review.confirmation, {
    status: "ready",
    canConfirm: true,
    requiresConfirmation: false,
    redCount: 0,
    yellowCount: 0,
    redSummary: [],
    yellowSummary: [],
    redIssues: [],
    yellowIssues: [],
  });
});

test("rechecks part-time daily and Monday-to-Sunday weekly contracts including adjacent months", () => {
  const targetMonth = "2026-08";
  const workCondition = {
    weeklyMinutesLimit: 20 * 60,
    weeklyMinutesLimitType: "exclusive",
    preferredWeeklyWorkDaysMin: 3,
    weeklyWorkDaysMax: 4,
    dailyWorkMinutesMin: 3 * 60,
    dailyWorkMinutesMax: 5 * 60,
  };
  const adjacentDays = [
    day("part-time", "2026-07-27", [
      { startTime: "09:00", endTime: "12:00", activityType: "training" },
      { startTime: "12:00", endTime: "13:00", activityType: "break" },
      { startTime: "13:00", endTime: "15:00", activityType: "administration" },
    ]),
    day("part-time", "2026-07-28", [childcare("09:00", "14:00")]),
    day("part-time", "2026-07-29", [childcare("09:00", "14:00")]),
  ];
  const currentDays = [
    day("part-time", "2026-08-01", [childcare("09:00", "14:00")]),
    day("part-time", "2026-08-02", [childcare("09:00", "09:15")]),
    day("part-time", "2026-08-03", [childcare("09:00", "14:15")]),
    day("part-time", "2026-08-04", [childcare("09:00", "11:00")]),
    day("part-time", "2026-08-05", [childcare("08:00", "10:00")]),
  ];
  const staff = profile("part-time", "STPT01", "licensed_nursery_teacher", {
    employmentType: "非常勤",
    workCondition,
    scheduledDays: adjacentDays,
    availableScheduleMonths: ["2026-07"],
    schedulePreferences: [{
      date: "2026-08-05",
      preferenceType: "work_time",
      startTime: "08:00",
      endTime: "10:00",
    }],
  });
  const review = evaluateCurrentDraftSchedule({
    targetMonth,
    requirementSource: { period: { id: "period-pt", targetMonth, status: "open" }, slots: [] },
    staffProfiles: [staff],
    currentDays,
  });
  const byCode = new Map(review.issues.workConditions.map((issue) => [issue.code, issue]));
  assert.equal(byCode.get("PART_TIME_WEEKLY_WORK_LIMIT_EXCEEDED").weekStart, "2026-07-27");
  assert.equal(byCode.get("PART_TIME_WEEKLY_WORK_LIMIT_EXCEEDED").actualMinutes, 20 * 60 + 15);
  assert.equal(byCode.get("PART_TIME_WEEKLY_WORK_LIMIT_EXCEEDED").limitMinutes, 19 * 60 + 45);
  assert.equal(byCode.get("PART_TIME_WEEKLY_WORK_DAYS_EXCEEDED").actualDays, 5);
  assert.equal(byCode.get("PART_TIME_DAILY_WORK_MINUTES_EXCEEDED").actualMinutes, 5 * 60 + 15);
  assert.ok(review.issues.workConditions.some((issue) => {
    return issue.code === "PART_TIME_DAILY_MINIMUM_MINUTES_UNMET" && issue.date === "2026-08-04";
  }));
  assert.ok(!review.issues.workConditions.some((issue) => {
    return issue.code === "PART_TIME_DAILY_MINIMUM_MINUTES_UNMET" && issue.date === "2026-08-05";
  }));
  assert.ok(review.issues.workConditions.some((issue) => {
    return issue.code === "PART_TIME_WEEKLY_MINIMUM_DAYS_UNMET";
  }));
  assert.ok(review.issues.workConditions.some((issue) => {
    return issue.code === "WEEKLY_WORK_CONTEXT_INCOMPLETE" && issue.missingContextMonths.includes("2026-09");
  }));
  assert.equal(review.confirmation.status, "blocked");
  assert.ok(review.confirmation.redIssues.some((issue) => issue.code === "PART_TIME_WEEKLY_WORK_LIMIT_EXCEEDED"));
  assert.ok(review.confirmation.yellowIssues.some((issue) => issue.code === "PART_TIME_DAILY_MINIMUM_MINUTES_UNMET"));
  assert.ok(review.confirmation.yellowIssues.some((issue) => issue.code === "WEEKLY_WORK_CONTEXT_INCOMPLETE"));
});

test("classifies staffing, qualification, break, and consecutive-work issues as confirmation blockers", () => {
  const issue = (code, label = code) => ({ code, label, date: "2026-09-01", staffId: "staff-a" });
  const confirmation = classifyDraftScheduleConfirmation({
    issues: {
      childcareStaffing: [{ date: "2026-09-01", startTime: "09:00", endTime: "09:15" }],
      licensedStaffing: [{ date: "2026-09-01", startTime: "09:00", endTime: "09:15" }],
      workConditions: [
        issue("MISSING_REQUIRED_ROLE"),
        issue("MISSING_REQUIRED_QUALIFICATION"),
        issue("NO_VALID_CHILDCARE_CREDENTIAL"),
        issue("CONSECUTIVE_WORK_LIMIT"),
      ],
      breaks: [
        issue("BREAK_MINUTES_SHORTAGE"),
        issue("BREAK_CHILDCARE_COVERAGE_SHORTAGE"),
        issue("BREAK_LICENSED_COVERAGE_SHORTAGE"),
      ],
    },
  });

  assert.equal(confirmation.status, "blocked");
  assert.equal(confirmation.canConfirm, false);
  assert.equal(confirmation.redCount, 9);
  assert.deepEqual(new Set(confirmation.redIssues.map((entry) => entry.code)), new Set([
    "CHILDCARE_STAFFING_SHORTAGE",
    "LICENSED_STAFFING_SHORTAGE",
    "MISSING_REQUIRED_ROLE",
    "MISSING_REQUIRED_QUALIFICATION",
    "NO_VALID_CHILDCARE_CREDENTIAL",
    "CONSECUTIVE_WORK_LIMIT",
    "BREAK_MINUTES_SHORTAGE",
    "BREAK_CHILDCARE_COVERAGE_SHORTAGE",
    "BREAK_LICENSED_COVERAGE_SHORTAGE",
  ]));
});

test("classifies preferences, availability, limits, and days-off issues as acknowledged warnings", () => {
  const codes = [
    "PREFERENCE_DAY_OFF",
    "OUTSIDE_PREFERENCE_TIME",
    "WEEKDAY_NOT_AVAILABLE",
    "DAILY_WORK_LIMIT_EXCEEDED",
    "MONTHLY_WORK_LIMIT_EXCEEDED",
    "DAY_OFF_TARGET_UNRESOLVED",
  ];
  const confirmation = classifyDraftScheduleConfirmation({
    issues: {
      childcareStaffing: [],
      licensedStaffing: [],
      workConditions: codes.map((code) => ({ code, label: code, date: "2026-09-01", staffId: "staff-a" })),
      breaks: [],
    },
  });

  assert.equal(confirmation.status, "warning");
  assert.equal(confirmation.canConfirm, true);
  assert.equal(confirmation.requiresConfirmation, true);
  assert.equal(confirmation.yellowCount, codes.length);
  assert.deepEqual(confirmation.yellowIssues.map((entry) => entry.code), codes);
});
