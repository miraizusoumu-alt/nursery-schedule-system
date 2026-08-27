import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCurrentDraftSchedule } from "../lib/server/staffing/draft-schedule-review.mjs";

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
      availability: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        available: true,
        startTime: "06:30",
        endTime: "20:30",
      })),
    }],
    schedulePreferences: options.schedulePreferences ?? [],
    scheduledDays: options.scheduledDays ?? [],
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
  assert.deepEqual(
    review.issues.breaks
      .filter((issue) => issue.staffId === "staff-a" && issue.code === "BREAK_CHILDCARE_COVERAGE_SHORTAGE")
      .map(({ startTime, endTime }) => ({ startTime, endTime })),
    [{ startTime: "12:00", endTime: "12:30" }],
  );
  assert.equal(review.hasIssues, true);
  assert.deepEqual({ profiles, currentDays, requirementSource }, before);
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
});
