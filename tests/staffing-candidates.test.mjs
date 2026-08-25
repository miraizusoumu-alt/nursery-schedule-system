import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { aggregateStaffingRequirementsToQuarterHours } from "../lib/server/staffing/quarter-hour-requirements.mjs";
import {
  CURRENT_STAFF_CLASSIFICATION_CAPABILITIES,
  loadStaffCandidateProfiles,
} from "../lib/server/staffing/staff-candidate-repository.mjs";
import {
  connectRequirementWithStaffCandidates,
  evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot,
  evaluateStaffEligibilityForQuarterHourSlot,
} from "../lib/server/staffing/staff-eligibility.mjs";

function requirements(date, startTime, values) {
  const [hours, minutes] = startTime.split(":").map(Number);
  const start = hours * 60 + minutes;
  return values.map((entry, index) => {
    const minute = start + index * 5;
    return {
      date,
      time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
      requiredChildcareWorkers: entry[0],
      requiredLicensedNurseryTeachers: entry[1],
    };
  });
}

function aggregate(values, startTime = "08:00") {
  const endMinute = startTime === "16:30" ? "16:55" : "08:25";
  return aggregateStaffingRequirementsToQuarterHours(requirements("2026-05-11", startTime, values), {
    shiftStartTime: startTime,
    shiftEndTime: startTime === "16:30" ? "17:00" : "08:30",
    requirementStartTime: startTime,
    requirementEndTime: endMinute,
  });
}

function staff(overrides = {}) {
  return {
    id: "staff-1",
    staffCode: "ST0001",
    name: "架空 職員",
    employmentStartDate: "2026-05-01",
    employmentEndDate: "2026-05-31",
    status: "active",
    assignedRoles: [{ type: "nursery_teacher_role", validFrom: "2026-05-01", validTo: null }],
    validQualifications: [{ type: "licensed_nursery_teacher", validFrom: "2026-05-01", validTo: "2026-05-31" }],
    workConditions: [{
      validFrom: "2026-05-01",
      validTo: "2026-05-31",
      employmentType: "常勤",
      availability: [{ weekday: 1, available: true, startTime: "09:00", endTime: "16:00" }],
    }],
    ...overrides,
  };
}

test("uses the maximum five-minute requirement for decreases, increases, and licensed staff", () => {
  const decreasing = aggregate([
    [4, 2], [4, 2], [3, 1], [3, 1], [3, 1], [3, 1],
  ], "16:30");
  assert.deepEqual(
    decreasing.map(({ startTime, requiredChildcareWorkers }) => [startTime, requiredChildcareWorkers]),
    [["16:30", 4], ["16:45", 3]],
  );
  const increasing = aggregate([
    [3, 1], [3, 1], [4, 2], [4, 2], [4, 2], [4, 2],
  ]);
  assert.equal(increasing[0].requiredChildcareWorkers, 4);
  assert.equal(increasing[0].requiredLicensedNurseryTeachers, 2);
  assert.deepEqual(increasing[0].maxRequirementReason.childcareWorkerTimes, ["08:10"]);
  assert.equal(aggregate([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]])[0].requiredChildcareWorkers, 0);
});

test("keeps child requirements at zero outside 07:00 through 20:00", () => {
  const source = requirements("2026-05-11", "07:00", Array.from({ length: 157 }, () => [2, 1]));
  const slots = aggregateStaffingRequirementsToQuarterHours(source);
  assert.equal(slots.length, 56);
  assert.deepEqual([slots[0].startTime, slots.at(-1).endTime], ["06:30", "20:30"]);
  assert.equal(slots.find((entry) => entry.startTime === "06:30").requiredChildcareWorkers, 0);
  assert.equal(slots.find((entry) => entry.startTime === "06:45").requiredChildcareWorkers, 0);
  assert.equal(slots.find((entry) => entry.startTime === "20:00").requiredChildcareWorkers, 2);
  assert.equal(slots.find((entry) => entry.startTime === "20:15").requiredChildcareWorkers, 0);
});

test("uses the same quarter-hour aggregation on Saturdays", () => {
  const slots = aggregateStaffingRequirementsToQuarterHours(
    requirements("2026-05-09", "09:00", [[2, 1], [3, 2], [2, 1]]),
    {
      shiftStartTime: "09:00", shiftEndTime: "09:15",
      requirementStartTime: "09:00", requirementEndTime: "09:10",
    },
  );
  assert.equal(slots[0].requiredChildcareWorkers, 3);
  assert.equal(slots[0].requiredLicensedNurseryTeachers, 2);
});

test("evaluates inclusive employment dates, weekdays, and end-time boundaries separately", () => {
  const slot = { date: "2026-05-11", startTime: "15:45", endTime: "16:00" };
  const eligible = evaluateStaffEligibilityForQuarterHourSlot(staff(), slot);
  assert.equal(eligible.isActiveOnDate, true);
  assert.equal(eligible.isAvailableOnWeekday, true);
  assert.equal(eligible.isWithinAvailableTime, true);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.licensedEligible, true);
  assert.equal(eligible.employmentType, "常勤");

  const afterEnd = evaluateStaffEligibilityForQuarterHourSlot(staff(), {
    date: "2026-05-11", startTime: "16:00", endTime: "16:15",
  });
  assert.equal(afterEnd.isWithinAvailableTime, false);
  assert.ok(afterEnd.exclusionReasons.includes("OUTSIDE_AVAILABLE_TIME"));
  const beforeEmployment = evaluateStaffEligibilityForQuarterHourSlot(staff(), {
    date: "2026-04-30", startTime: "09:00", endTime: "09:15",
  });
  assert.ok(beforeEmployment.exclusionReasons.includes("NOT_EMPLOYED_ON_DATE"));
  const endDate = evaluateStaffEligibilityForQuarterHourSlot(staff(), {
    date: "2026-05-31", startTime: "09:00", endTime: "09:15",
  });
  assert.equal(endDate.isEmployedOnDate, true);
  const exactEmploymentPeriod = evaluateStaffEligibilityForQuarterHourSlot(staff({
    employmentStartDate: "2026-05-11",
    employmentEndDate: "2026-05-11",
    workConditions: [{
      validFrom: "2026-05-11", validTo: "2026-05-11", employmentType: "非常勤",
      availability: [{ weekday: 1, available: true, startTime: "09:00", endTime: "16:00" }],
    }],
  }), { date: "2026-05-11", startTime: "09:00", endTime: "09:15" });
  assert.equal(exactEmploymentPeriod.isActiveOnDate, true);
  assert.equal(exactEmploymentPeriod.employmentType, "非常勤");
});

test("keeps Sunday availability possible and rejects unavailable or inactive staff", () => {
  const sundayStaff = staff({
    workConditions: [{
      validFrom: "2026-05-01", validTo: null, employmentType: "非常勤",
      availability: [{ weekday: 0, available: true, startTime: "09:00", endTime: "12:00" }],
    }],
  });
  assert.equal(evaluateStaffEligibilityForQuarterHourSlot(sundayStaff, {
    date: "2026-05-10", startTime: "09:00", endTime: "09:15",
  }).eligible, true);
  const unavailable = evaluateStaffEligibilityForQuarterHourSlot(staff(), {
    date: "2026-05-12", startTime: "09:00", endTime: "09:15",
  });
  assert.ok(unavailable.exclusionReasons.includes("WEEKDAY_NOT_AVAILABLE"));
  const inactive = evaluateStaffEligibilityForQuarterHourSlot(staff({ status: "inactive" }), {
    date: "2026-05-11", startTime: "09:00", endTime: "09:15",
  });
  assert.ok(inactive.exclusionReasons.includes("INACTIVE"));
});

test("uses day-specific preferences before weekly availability for automatic placement", () => {
  const weeklyStaff = staff({
    workConditions: [{
      validFrom: "2026-05-01", validTo: null, employmentType: "常勤",
      availability: [{ weekday: 1, available: true, startTime: "09:00", endTime: "18:00" }],
    }],
  });
  const preferred = staff({
    ...weeklyStaff,
    schedulePreferences: [{
      date: "2026-05-11", preferenceType: "work_time", startTime: "10:00", endTime: "16:00",
    }],
  });
  const inside = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(preferred, {
    date: "2026-05-11", startTime: "10:00", endTime: "10:15",
  });
  assert.equal(inside.automaticPlacementEligible, true);
  assert.equal(inside.hasWorkTimePreference, true);
  assert.deepEqual(inside.effectiveAvailability, {
    source: "preference", available: true, startTime: "10:00", endTime: "16:00",
  });
  for (const slot of [
    { date: "2026-05-11", startTime: "09:45", endTime: "10:00" },
    { date: "2026-05-11", startTime: "16:00", endTime: "16:15" },
  ]) {
    const outside = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(preferred, slot);
    assert.equal(outside.automaticPlacementEligible, false);
    assert.ok(outside.exclusionReasons.includes("OUTSIDE_PREFERENCE_TIME"));
  }

  const outsideWeekly = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(staff({
    ...weeklyStaff,
    schedulePreferences: [{
      date: "2026-05-11", preferenceType: "work_time", startTime: "08:00", endTime: "17:00",
    }],
  }), { date: "2026-05-11", startTime: "08:00", endTime: "08:15" });
  assert.equal(outsideWeekly.automaticPlacementEligible, true);
  assert.equal(outsideWeekly.isWithinAvailableTime, true);

  const noPreference = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(weeklyStaff, {
    date: "2026-05-11", startTime: "09:00", endTime: "09:15",
  });
  assert.equal(noPreference.automaticPlacementEligible, true);
  assert.equal(noPreference.effectiveAvailability.source, "weekly");

  const dayOff = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(staff({
    ...weeklyStaff,
    schedulePreferences: [{ date: "2026-05-11", preferenceType: "day_off", startTime: null, endTime: null }],
  }), { date: "2026-05-11", startTime: "09:00", endTime: "09:15" });
  assert.equal(dayOff.automaticPlacementEligible, false);
  assert.equal(dayOff.hasDayOffPreference, true);
  assert.ok(dayOff.exclusionReasons.includes("PREFERENCE_DAY_OFF"));
});

test("allows the sixth work day and excludes a seventh across month boundaries", () => {
  const availability = Array.from({ length: 7 }, (_, weekday) => ({
    weekday, available: true, startTime: "06:30", endTime: "20:30",
  }));
  const scheduledDays = (dates) => dates.map((date) => ({
    staffId: "staff-1", date, dayType: "work", segments: [],
  }));
  const septemberStaff = (dates) => staff({
    employmentStartDate: "2026-01-01",
    employmentEndDate: null,
    validQualifications: [{ type: "licensed_nursery_teacher", validFrom: "2026-01-01", validTo: null }],
    workConditions: [{ validFrom: "2026-01-01", validTo: null, employmentType: "常勤", availability }],
    scheduledDays: scheduledDays(dates),
  });
  const slot = (date) => ({ date, startTime: "09:00", endTime: "09:15" });

  const sixth = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(
    septemberStaff(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]),
    slot("2026-09-06"),
  );
  assert.equal(sixth.consecutiveWork.consecutiveDays, 6);
  assert.equal(sixth.violatesConsecutiveWorkLimit, false);
  assert.equal(sixth.automaticPlacementEligible, true);

  const seventh = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(
    septemberStaff(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]),
    slot("2026-09-07"),
  );
  assert.equal(seventh.consecutiveWork.consecutiveDays, 7);
  assert.equal(seventh.violatesConsecutiveWorkLimit, true);
  assert.equal(seventh.automaticPlacementEligible, false);
  assert.ok(seventh.exclusionReasons.includes("CONSECUTIVE_WORK_LIMIT"));

  const crossing = evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(
    septemberStaff(["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]),
    slot("2026-09-04"),
  );
  assert.equal(crossing.consecutiveWork.startDate, "2026-08-29");
  assert.equal(crossing.consecutiveWork.consecutiveDays, 7);
  assert.equal(crossing.automaticPlacementEligible, false);
});

test("separates recorded roles from childcare eligibility and legal license validity", () => {
  const slot = { date: "2026-05-11", startTime: "09:00", endTime: "09:15" };
  const director = evaluateStaffEligibilityForQuarterHourSlot(staff({
    assignedRoles: [
      { type: "nursery_teacher_role", validFrom: "2026-05-01", validTo: null },
      { type: "principal", validFrom: "2026-05-01", validTo: null },
    ],
  }), slot);
  assert.deepEqual(director.assignedRoles, ["nursery_teacher_role", "principal"]);
  assert.deepEqual(director.validQualifications, ["licensed_nursery_teacher"]);
  assert.equal(director.licensedEligible, true);
  const manager = evaluateStaffEligibilityForQuarterHourSlot(staff({
    assignedRoles: [
      { type: "nursery_teacher_role", validFrom: "2026-05-01", validTo: null },
      { type: "manager", validFrom: "2026-05-01", validTo: null },
    ],
  }), slot);
  assert.equal(manager.licensedEligible, true);
  const mealOnly = evaluateStaffEligibilityForQuarterHourSlot(staff({
    assignedRoles: [{ type: "meal_service", validFrom: "2026-05-01", validTo: null }],
    validQualifications: [],
  }), slot);
  assert.equal(mealOnly.eligible, false);
  assert.ok(mealOnly.exclusionReasons.includes("NO_VALID_CHILDCARE_CREDENTIAL"));
  const otherOnly = evaluateStaffEligibilityForQuarterHourSlot(staff({
    assignedRoles: [{ type: "other", validFrom: "2026-05-01", validTo: null }],
    validQualifications: [{ type: "childcare_support_worker_local_childcare", validFrom: "2026-05-01", validTo: null }],
  }), slot);
  assert.equal(otherOnly.isEligibleChildcareWorker, true);
  assert.equal(otherOnly.isLicensedNurseryTeacher, false);
  assert.equal(otherOnly.eligible, true);
});

test("classifies fictional staff A through E from credentials rather than assigned roles", () => {
  const slot = { date: "2026-05-11", startTime: "09:00", endTime: "09:15" };
  const cases = [
    ["A", ["nursery_teacher_role", "principal"], ["licensed_nursery_teacher"], true, true],
    ["B", ["other"], ["childcare_support_worker_local_childcare"], true, false],
    ["C", ["meal_service"], [], false, false],
    ["D", ["manager", "nursery_teacher_role"], ["licensed_nursery_teacher"], true, true],
    ["E", ["nursery_teacher_role"], [], false, false],
  ];
  for (const [name, roleTypes, qualificationTypes, eligible, licensedEligible] of cases) {
    const result = evaluateStaffEligibilityForQuarterHourSlot(staff({
      id: `staff-${name}`,
      name: `架空 職員${name}`,
      assignedRoles: roleTypes.map((type) => ({ type, validFrom: "2026-04-01", validTo: null })),
      validQualifications: qualificationTypes.map((type) => ({ type, validFrom: "2026-04-01", validTo: null })),
    }), slot);
    assert.equal(result.eligible, eligible, `職員${name}の保育従事者候補`);
    assert.equal(result.licensedEligible, licensedEligible, `職員${name}の資格者候補`);
  }
});

test("rejects expired or not-yet-valid licenses without treating roles as licenses", () => {
  const slot = { date: "2026-05-11", startTime: "09:00", endTime: "09:15" };
  for (const period of [
    { validFrom: "2026-05-12", validTo: null },
    { validFrom: "2026-04-01", validTo: "2026-05-10" },
  ]) {
    const result = evaluateStaffEligibilityForQuarterHourSlot(staff({
      validQualifications: [{ type: "licensed_nursery_teacher", ...period }],
    }), slot);
    assert.equal(result.isLicensedNurseryTeacher, false);
    assert.ok(result.licensedExclusionReasons.includes("LICENSE_NOT_VALID"));
  }
  const unconfigured = evaluateStaffEligibilityForQuarterHourSlot(staff({
    assignedRoles: [{ type: "nursery_teacher_role", validFrom: "2026-05-01", validTo: null }],
    validQualifications: [],
  }), slot);
  assert.equal(unconfigured.isEligibleChildcareWorker, false);
  assert.equal(unconfigured.isLicensedNurseryTeacher, false);
  assert.ok(unconfigured.exclusionReasons.includes("NO_VALID_CHILDCARE_CREDENTIAL"));
  const exactQualificationPeriod = evaluateStaffEligibilityForQuarterHourSlot(staff({
    validQualifications: [{ type: "licensed_nursery_teacher", validFrom: "2026-05-11", validTo: "2026-05-11" }],
  }), slot);
  assert.equal(exactQualificationPeriod.isLicensedNurseryTeacher, true);
});

test("calculates shortages only when both classifications are explicitly configured", () => {
  const requirement = {
    date: "2026-05-11", startTime: "09:00", endTime: "09:15",
    requiredChildcareWorkers: 4, requiredLicensedNurseryTeachers: 2,
  };
  const eligibleEvaluation = {
    preliminaryEligible: true, eligible: true, licensedEligible: true,
  };
  const unlicensedEvaluation = {
    preliminaryEligible: true, eligible: true, licensedEligible: false,
  };
  const noShortage = connectRequirementWithStaffCandidates(
    requirement,
    [eligibleEvaluation, eligibleEvaluation, eligibleEvaluation, unlicensedEvaluation, unlicensedEvaluation],
    { childcareEligibilityConfigured: true, nurseryTeacherQualificationsConfigured: true },
  );
  assert.equal(noShortage.eligibleChildcareWorkerCount, 5);
  assert.equal(noShortage.eligibleLicensedNurseryTeacherCount, 3);
  assert.equal(noShortage.childcareWorkerShortage, 0);
  assert.equal(noShortage.licensedNurseryTeacherShortage, 0);
  const shortage = connectRequirementWithStaffCandidates(
    requirement,
    [eligibleEvaluation, unlicensedEvaluation, unlicensedEvaluation],
    { childcareEligibilityConfigured: true, nurseryTeacherQualificationsConfigured: true },
  );
  assert.equal(shortage.childcareWorkerShortage, 1);
  assert.equal(shortage.licensedNurseryTeacherShortage, 1);
  const childcareOnlyShortage = connectRequirementWithStaffCandidates(
    requirement,
    [eligibleEvaluation, eligibleEvaluation, eligibleEvaluation],
    { childcareEligibilityConfigured: true, nurseryTeacherQualificationsConfigured: true },
  );
  assert.equal(childcareOnlyShortage.childcareWorkerShortage, 1);
  assert.equal(childcareOnlyShortage.licensedNurseryTeacherShortage, 0);
  const licensedOnlyShortage = connectRequirementWithStaffCandidates(
    requirement,
    [eligibleEvaluation, unlicensedEvaluation, unlicensedEvaluation, unlicensedEvaluation],
    { childcareEligibilityConfigured: true, nurseryTeacherQualificationsConfigured: true },
  );
  assert.equal(licensedOnlyShortage.childcareWorkerShortage, 0);
  assert.equal(licensedOnlyShortage.licensedNurseryTeacherShortage, 1);
  const notConfigured = connectRequirementWithStaffCandidates(requirement, [], {
    childcareEligibilityConfigured: false,
    nurseryTeacherQualificationsConfigured: false,
  });
  assert.equal(notConfigured.eligibleChildcareWorkerCount, null);
  assert.equal(notConfigured.childcareWorkerShortage, null);
  assert.equal(notConfigured.licensedNurseryTeacherShortage, null);
});

test("loads roles and qualifications independently without promoting legacy ambiguous rows", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-candidate-"));
  const database = openDatabase(resolve(directory, "candidate.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      `INSERT INTO staff_members
       (id, staff_code, name, employment_start_date, employment_end_date, status)
       VALUES ('staff-ambiguous', 'ST0001', '架空 混在職員', '2026-04-01', NULL, 'active')`,
    ).run();
    database.prepare(
      `INSERT INTO staff_qualifications
       (id, staff_id, qualification_type, valid_from, valid_to)
       VALUES ('shared-row', 'staff-ambiguous', '保育士', '2026-04-01', NULL)`,
    ).run();
    const [profile] = loadStaffCandidateProfiles(database);
    assert.deepEqual(profile.assignedRoles, []);
    assert.equal(profile.validQualifications[0].type, "保育士");
    const result = evaluateStaffEligibilityForQuarterHourSlot(profile, {
      date: "2026-05-11", startTime: "09:00", endTime: "09:15",
    });
    assert.equal(result.isEligibleChildcareWorker, false);
    assert.equal(result.isLicensedNurseryTeacher, false);
    assert.deepEqual(CURRENT_STAFF_CLASSIFICATION_CAPABILITIES, {
      childcareEligibilityConfigured: true,
      nurseryTeacherQualificationsConfigured: true,
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads preferences and only current schedule versions into automatic candidate profiles", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-automatic-candidate-"));
  const database = openDatabase(resolve(directory, "candidate.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-a", "candidate-admin", "架空 管理者");
    database.prepare(
      "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ).run("staff-a", "ST0001", "架空 職員", "2026-01-01");
    database.prepare(
      `INSERT INTO staff_work_condition_versions
       (id, staff_id, valid_from, employment_type, created_by_administrator_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("condition-a", "staff-a", "2026-01-01", "常勤", "admin-a");
    database.prepare(
      `INSERT INTO staff_weekly_availability
       (work_condition_version_id, weekday, available, start_time, end_time)
       VALUES (?, 1, 1, '09:00', '18:00')`,
    ).run("condition-a");
    database.prepare(
      `INSERT INTO staff_qualifications
       (id, staff_id, qualification_type, valid_from, valid_to)
       VALUES (?, ?, 'licensed_nursery_teacher', '2026-01-01', NULL)`,
    ).run("qualification-a", "staff-a");
    database.prepare(
      `INSERT INTO staff_schedule_preferences
       (id, staff_id, date, preference_type, start_time, end_time,
        created_by_administrator_id, updated_by_administrator_id)
       VALUES (?, ?, '2026-09-07', 'work_time', '10:00', '16:00', ?, ?)`,
    ).run("preference-a", "staff-a", "admin-a", "admin-a");
    database.prepare(
      `INSERT INTO staff_schedule_months (id, target_month, status, current_version_id)
       VALUES ('month-a', '2026-09', 'draft', NULL)`,
    ).run();
    database.prepare(
      `INSERT INTO staff_schedule_versions
       (id, schedule_month_id, version_number, source, status, created_by_administrator_id)
       VALUES ('version-old', 'month-a', 1, 'manual', 'draft', 'admin-a'),
              ('version-current', 'month-a', 2, 'manual', 'draft', 'admin-a')`,
    ).run();
    database.prepare("UPDATE staff_schedule_months SET current_version_id = 'version-current' WHERE id = 'month-a'").run();
    database.prepare(
      `INSERT INTO staff_schedule_days (id, version_id, staff_id, date, day_type)
       VALUES ('day-old', 'version-old', 'staff-a', '2026-09-01', 'work'),
              ('day-current', 'version-current', 'staff-a', '2026-09-02', 'work')`,
    ).run();

    const [profile] = loadStaffCandidateProfiles(database);
    assert.deepEqual(profile.schedulePreferences, [{
      date: "2026-09-07", preferenceType: "work_time", startTime: "10:00", endTime: "16:00",
    }]);
    assert.deepEqual(profile.scheduledDays.map((day) => day.date), ["2026-09-02"]);
    assert.equal(evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(profile, {
      date: "2026-09-07", startTime: "10:00", endTime: "10:15",
    }).automaticPlacementEligible, true);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
