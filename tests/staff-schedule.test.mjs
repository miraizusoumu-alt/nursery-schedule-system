import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { hashOpaqueValue } from "../lib/server/auth/security.mjs";
import { createStaffScheduleService } from "../lib/server/staff-schedule/service.mjs";
import {
  buildAutomaticScheduleDraft,
  buildAutomaticSchedulePreview,
} from "../lib/server/staffing/automatic-draft.mjs";
import {
  calculateConsecutiveWorkWarnings,
  calculateDailyScheduledWorkMinutes,
  calculateFullTimeMonthlyBaseline,
  calculateMonthlyScheduledWorkMinutes,
  calculateWeeklyScheduledWorkMinutes,
  countsAsScheduledWork,
  evaluateMonthlyDaysOff,
  STAFF_SCHEDULE_WEEK_STARTS_ON,
  StaffScheduleValidationError,
  summarizeScheduleDays,
  validateScheduleDay,
  validateScheduleSegments,
  validateScheduleTimeRange,
} from "../lib/server/staffing/scheduled-work.mjs";
import { handleStaffScheduleApiRequest } from "../server/staff-schedule-http.mjs";

const fullWorkDay = () => [
  { startTime: "09:00", endTime: "12:00", activityType: "childcare" },
  { startTime: "12:00", endTime: "13:00", activityType: "break" },
  { startTime: "13:00", endTime: "17:00", activityType: "childcare" },
  { startTime: "17:00", endTime: "18:00", activityType: "administration" },
];

function quarterHourRequirements(date, startTime, endTime, requiredChildcareWorkers, requiredLicensedNurseryTeachers) {
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const toTime = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  const result = [];
  for (let minutes = toMinutes(startTime); minutes < toMinutes(endTime); minutes += 15) {
    result.push({
      date,
      startTime: toTime(minutes),
      endTime: toTime(minutes + 15),
      requiredChildcareWorkers,
      requiredLicensedNurseryTeachers,
    });
  }
  return result;
}

function insertAutomaticStaff(database, administratorId, id, staffCode, qualification = "licensed_nursery_teacher") {
  database.prepare(
    "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, '2026-01-01', 'active')",
  ).run(id, staffCode, `架空 職員${id}`);
  database.prepare(
    "INSERT INTO staff_qualifications (id, staff_id, qualification_type, valid_from) VALUES (?, ?, ?, '2026-01-01')",
  ).run(`qualification-${id}`, id, qualification);
  database.prepare(
    `INSERT INTO staff_work_condition_versions
     (id, staff_id, valid_from, employment_type, created_by_administrator_id)
     VALUES (?, ?, '2026-01-01', '常勤', ?)`,
  ).run(`condition-${id}`, id, administratorId);
  const insertAvailability = database.prepare(
    `INSERT INTO staff_weekly_availability
     (work_condition_version_id, weekday, available, start_time, end_time)
     VALUES (?, ?, 1, '06:30', '20:30')`,
  );
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    insertAvailability.run(`condition-${id}`, weekday);
  }
}

function stubAutomaticResult(targetMonth, staffId, overrides = {}) {
  return {
    targetMonth,
    daysOffPlan: {
      staffPlans: [{ staffId, finalPlannedDaysOff: [] }],
      unresolvedConstraints: overrides.daysOffUnresolved ?? [],
    },
    scheduleSegments: overrides.scheduleSegments ?? [{
      staffId,
      date: `${targetMonth}-01`,
      startTime: "09:00",
      endTime: "10:00",
      activityType: "childcare",
    }],
    shortages: overrides.shortages ?? [],
    breakPlan: { unresolvedConstraints: overrides.breakUnresolved ?? [] },
  };
}

function automaticRequirementSlotsProvider(slotsOrFactory = []) {
  return (_actor, { targetMonth }) => ({
    period: { id: `period-${targetMonth}`, targetMonth, status: "open" },
    slots: typeof slotsOrFactory === "function" ? slotsOrFactory(targetMonth) : slotsOrFactory,
  });
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof StaffScheduleValidationError && error.code === code);
}

test("validates fifteen-minute schedule boundaries and rejects overlapping segments", () => {
  assert.equal(validateScheduleSegments(fullWorkDay()).length, 4);
  expectCode(
    () => validateScheduleSegments([{ startTime: "09:05", endTime: "10:00", activityType: "childcare" }]),
    "INVALID_TIME",
  );
  expectCode(
    () => validateScheduleSegments([{ startTime: "10:00", endTime: "09:45", activityType: "childcare" }]),
    "INVALID_TIME_RANGE",
  );
  expectCode(
    () => validateScheduleSegments([
      { startTime: "09:00", endTime: "12:00", activityType: "childcare" },
      { startTime: "11:45", endTime: "12:15", activityType: "break" },
    ]),
    "TIME_RANGE_OVERLAP",
  );
});

test("shares fifteen-minute time validation with staff preferences", () => {
  assert.deepEqual(validateScheduleTimeRange("09:00", "18:00"), {
    startTime: "09:00",
    endTime: "18:00",
    startMinutes: 9 * 60,
    endMinutes: 18 * 60,
  });
  expectCode(() => validateScheduleTimeRange("09:05", "18:00"), "INVALID_TIME");
  expectCode(() => validateScheduleTimeRange("18:00", "09:00"), "INVALID_TIME_RANGE");
  expectCode(() => validateScheduleTimeRange("06:15", "18:00"), "OUTSIDE_SCHEDULE_RANGE");
});

test("excludes breaks and includes every work activity in daily scheduled minutes", () => {
  assert.equal(calculateDailyScheduledWorkMinutes(fullWorkDay()), 8 * 60);
  for (const activityType of ["childcare", "administration", "training", "meal_service", "other_work"]) {
    assert.equal(countsAsScheduledWork(activityType), true);
  }
  assert.equal(countsAsScheduledWork("break"), false);
});

test("calculates monthly and explicitly configured weekly scheduled minutes", () => {
  const days = Array.from({ length: 5 }, (_, index) => ({
    staffId: "staff-a",
    date: `2026-09-0${index + 1}`,
    dayType: "work",
    segments: fullWorkDay(),
  }));
  assert.equal(calculateMonthlyScheduledWorkMinutes(days, { staffId: "staff-a" }), 40 * 60);
  expectCode(() => calculateWeeklyScheduledWorkMinutes(days, { staffId: "staff-a" }), "WEEK_START_REQUIRED");
  assert.deepEqual(calculateWeeklyScheduledWorkMinutes(days, { staffId: "staff-a", weekStartsOn: 1 }), [
    { weekStart: "2026-08-31", scheduledWorkMinutes: 40 * 60 },
  ]);
});

test("keeps public days off and paid leave separate from work days", () => {
  const days = [
    { staffId: "staff-a", date: "2026-09-01", dayType: "work", segments: fullWorkDay() },
    { staffId: "staff-a", date: "2026-09-02", dayType: "day_off", segments: [] },
    { staffId: "staff-a", date: "2026-09-03", dayType: "paid_leave", segments: [] },
  ];
  assert.deepEqual(summarizeScheduleDays(days, { staffId: "staff-a" }), {
    workDays: 1,
    dayOffDays: 1,
    paidLeaveDays: 1,
    otherDays: 0,
  });
  expectCode(
    () => validateScheduleDay({ date: "2026-09-02", dayType: "day_off", segments: fullWorkDay() }),
    "NON_WORK_DAY_HAS_SEGMENTS",
  );
});

test("stores independent months and immutable historical versions in SQLite", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-schedule-"));
  const database = openDatabase(resolve(directory, "schedule.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ).run("staff-a", "ST0001", "架空 職員A", "2026-01-01");
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-a", "schedule-admin", "架空 管理者");

    const insertMonth = database.prepare(
      "INSERT INTO staff_schedule_months (id, target_month, status) VALUES (?, ?, 'draft')",
    );
    const insertVersion = database.prepare(
      "INSERT INTO staff_schedule_versions (id, schedule_month_id, version_number, source, status, source_version_id, created_by_administrator_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertMonth.run("month-sep", "2026-09");
    insertVersion.run("version-sep-1", "month-sep", 1, "manual", "confirmed", null, "admin-a", "2026-08-25T00:00:00.000Z");
    database.prepare(
      "UPDATE staff_schedule_months SET status = 'confirmed', current_version_id = ?, confirmed_at = ? WHERE id = ?",
    ).run("version-sep-1", "2026-08-25T00:00:00.000Z", "month-sep");
    database.prepare(
      "INSERT INTO staff_schedule_days (id, version_id, staff_id, date, day_type) VALUES (?, ?, ?, ?, ?)",
    ).run("day-sep-v1", "version-sep-1", "staff-a", "2026-09-01", "day_off");

    insertVersion.run("version-sep-2", "month-sep", 2, "manual", "draft", "version-sep-1", "admin-a", null);
    database.prepare(
      "UPDATE staff_schedule_months SET status = 'draft', current_version_id = ?, confirmed_at = NULL WHERE id = ?",
    ).run("version-sep-2", "month-sep");
    database.prepare(
      "INSERT INTO staff_schedule_days (id, version_id, staff_id, date, day_type) VALUES (?, ?, ?, ?, ?)",
    ).run("day-sep-v2", "version-sep-2", "staff-a", "2026-09-01", "paid_leave");

    insertMonth.run("month-oct", "2026-10");
    insertVersion.run("version-oct-1", "month-oct", 1, "manual", "draft", null, "admin-a", null);
    database.prepare("UPDATE staff_schedule_months SET current_version_id = ? WHERE id = ?").run("version-oct-1", "month-oct");

    assert.deepEqual(database.prepare(
      "SELECT target_month, status FROM staff_schedule_months ORDER BY target_month",
    ).all().map((row) => ({ ...row })), [
      { target_month: "2026-09", status: "draft" },
      { target_month: "2026-10", status: "draft" },
    ]);
    assert.deepEqual(database.prepare(
      "SELECT version_number, status, source_version_id FROM staff_schedule_versions WHERE schedule_month_id = ? ORDER BY version_number",
    ).all("month-sep").map((row) => ({ ...row })), [
      { version_number: 1, status: "confirmed", source_version_id: null },
      { version_number: 2, status: "draft", source_version_id: "version-sep-1" },
    ]);
    assert.equal(database.prepare("SELECT day_type FROM staff_schedule_days WHERE id = ?").get("day-sep-v1").day_type, "day_off");
    assert.equal(database.prepare("SELECT day_type FROM staff_schedule_days WHERE id = ?").get("day-sep-v2").day_type, "paid_leave");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces database time and day uniqueness constraints", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-schedule-constraints-"));
  const database = openDatabase(resolve(directory, "schedule.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ).run("staff-a", "ST0001", "架空 職員A", "2026-01-01");
    database.prepare("INSERT INTO staff_schedule_months (id, target_month, status) VALUES (?, ?, 'draft')").run("month-sep", "2026-09");
    database.prepare(
      "INSERT INTO staff_schedule_versions (id, schedule_month_id, version_number, source, status) VALUES (?, ?, 1, 'manual', 'draft')",
    ).run("version-sep-1", "month-sep");
    database.prepare(
      "INSERT INTO staff_schedule_days (id, version_id, staff_id, date, day_type) VALUES (?, ?, ?, ?, 'work')",
    ).run("day-sep", "version-sep-1", "staff-a", "2026-09-01");
    assert.throws(() => database.prepare(
      "INSERT INTO staff_schedule_days (id, version_id, staff_id, date, day_type) VALUES (?, ?, ?, ?, 'day_off')",
    ).run("day-duplicate", "version-sep-1", "staff-a", "2026-09-01"));
    assert.throws(() => database.prepare(
      "INSERT INTO staff_schedule_segments (id, schedule_day_id, start_time, end_time, activity_type) VALUES (?, ?, ?, ?, ?)",
    ).run("segment-five-minutes", "day-sep", "09:05", "10:00", "childcare"));
    assert.throws(() => database.prepare(
      "INSERT INTO staff_schedule_segments (id, schedule_day_id, start_time, end_time, activity_type) VALUES (?, ?, ?, ?, ?)",
    ).run("segment-reversed", "day-sep", "10:00", "09:45", "childcare"));
    assert.throws(() => database.prepare(
      "INSERT INTO staff_schedule_segments (id, schedule_day_id, start_time, end_time, activity_type) VALUES (?, ?, ?, ?, ?)",
    ).run("segment-outside-hours", "day-sep", "06:15", "07:00", "childcare"));
    assert.throws(() => database.prepare("DELETE FROM staff_members WHERE id = ?").run("staff-a"));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("calculates full-time monthly baselines and applies the nine-day rule only to full-time staff", () => {
  assert.deepEqual(calculateFullTimeMonthlyBaseline("2026-01"), {
    calendarDays: 31,
    requiredDaysOff: 9,
    basicWorkDays: 22,
    basicScheduledWorkMinutes: 176 * 60,
  });
  assert.equal(calculateFullTimeMonthlyBaseline("2026-04").basicScheduledWorkMinutes, 168 * 60);
  assert.equal(calculateFullTimeMonthlyBaseline("2028-02").basicScheduledWorkMinutes, 160 * 60);
  assert.equal(calculateFullTimeMonthlyBaseline("2027-02").basicScheduledWorkMinutes, 152 * 60);

  const daysOff = (count) => Array.from({ length: count }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    dayType: "day_off",
    segments: [],
  }));
  assert.deepEqual(evaluateMonthlyDaysOff(daysOff(9), { employmentType: "常勤" }), {
    applies: true,
    dayOffDays: 9,
    paidLeaveDays: 0,
    requiredDaysOff: 9,
    shortageDays: 0,
    warning: null,
  });
  assert.equal(evaluateMonthlyDaysOff(daysOff(8), { employmentType: "常勤" }).warning, "公休が1日不足しています");
  assert.equal(evaluateMonthlyDaysOff(daysOff(10), { employmentType: "常勤" }).shortageDays, 0);
  assert.equal(evaluateMonthlyDaysOff(daysOff(8), { employmentType: "非常勤" }).applies, false);
  const paidLeave = [{ date: "2026-09-20", dayType: "paid_leave", segments: [] }];
  assert.equal(evaluateMonthlyDaysOff([...daysOff(8), ...paidLeave], { employmentType: "常勤" }).dayOffDays, 8);
});

test("warns after six consecutive work days and can include prior-month days", () => {
  const workDays = (startDay, count) => Array.from({ length: count }, (_, index) => ({
    staffId: "staff-a",
    date: `2026-09-${String(startDay + index).padStart(2, "0")}`,
    dayType: "work",
    segments: fullWorkDay(),
  }));
  assert.deepEqual(calculateConsecutiveWorkWarnings(workDays(1, 6), { staffId: "staff-a" }), []);
  assert.deepEqual(calculateConsecutiveWorkWarnings(workDays(1, 7), { staffId: "staff-a" }), [{
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    consecutiveDays: 7,
    message: "7日連続勤務になっています",
  }]);
  const priorDays = [29, 30, 31].map((day) => ({
    staffId: "staff-a",
    date: `2026-08-${day}`,
    dayType: "work",
    segments: fullWorkDay(),
  }));
  const crossing = calculateConsecutiveWorkWarnings(workDays(1, 4), { staffId: "staff-a", priorDays });
  assert.equal(crossing[0].startDate, "2026-08-29");
  assert.equal(crossing[0].endDate, "2026-09-04");
  assert.equal(crossing[0].consecutiveDays, 7);
  assert.deepEqual(calculateConsecutiveWorkWarnings([
    ...workDays(1, 3),
    { staffId: "staff-a", date: "2026-09-04", dayType: "paid_leave", segments: [] },
    ...workDays(5, 4),
  ], { staffId: "staff-a" }), []);
  assert.equal(STAFF_SCHEDULE_WEEK_STARTS_ON, 1);
});

test("counts other days only when they contain scheduled work", () => {
  const otherWork = { date: "2026-09-01", dayType: "other", segments: [
    { startTime: "09:00", endTime: "10:00", activityType: "training" },
  ] };
  const otherWithoutWork = { date: "2026-09-02", dayType: "other", segments: [] };
  assert.equal(calculateMonthlyScheduledWorkMinutes([otherWork, otherWithoutWork]), 60);
  assert.deepEqual(calculateConsecutiveWorkWarnings([otherWork, otherWithoutWork]), []);
});

test("creates, confirms, revises, and reconfirms monthly schedules without changing old versions", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-schedule-service-"));
  const database = openDatabase(resolve(directory, "schedule.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-a", "schedule-admin", "架空 管理者");
    database.prepare(
      "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ).run("staff-full", "ST0001", "架空 常勤職員", "2026-01-01");
    database.prepare(
      "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ).run("staff-part", "ST0002", "架空 非常勤職員", "2026-01-01");
    const insertCondition = database.prepare(
      `INSERT INTO staff_work_condition_versions
       (id, staff_id, valid_from, valid_to, employment_type, created_by_administrator_id)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    );
    insertCondition.run("condition-full", "staff-full", "2026-01-01", "常勤", "admin-a");
    insertCondition.run("condition-part", "staff-part", "2026-01-01", "非常勤", "admin-a");
    const actor = { type: "administrator", id: "admin-a", role: "normal", mustChangePassword: false };
    const service = createStaffScheduleService({ database, now: () => new Date("2026-08-25T08:00:00.000Z") });

    let september = service.createMonthlySchedule(actor, { targetMonth: "2026-09" });
    const firstVersionId = september.viewedVersion.id;
    for (let day = 1; day <= 5; day += 1) {
      september = service.saveScheduleDay(actor, {
        targetMonth: "2026-09",
        versionId: firstVersionId,
        staffId: "staff-full",
        date: `2026-09-${String(day).padStart(2, "0")}`,
        dayType: "work",
        segments: fullWorkDay(),
      });
    }
    september = service.saveScheduleDay(actor, {
      targetMonth: "2026-09",
      versionId: firstVersionId,
      staffId: "staff-full",
      date: "2026-09-06",
      dayType: "day_off",
      segments: [],
    });
    assert.equal(september.staff.find((staff) => staff.id === "staff-full").monthlyScheduledWorkMinutes, 40 * 60);
    september = service.confirmMonthlySchedule(actor, { targetMonth: "2026-09", versionId: firstVersionId });
    assert.equal(september.month.status, "confirmed");
    assert.throws(() => service.saveScheduleDay(actor, {
      targetMonth: "2026-09", versionId: firstVersionId, staffId: "staff-full",
      date: "2026-09-01", dayType: "paid_leave", segments: [],
    }), (error) => error.code === "STAFF_SCHEDULE_CONFIRMED");

    september = service.createRevisionDraft(actor, { targetMonth: "2026-09" });
    const secondVersionId = september.viewedVersion.id;
    assert.notEqual(secondVersionId, firstVersionId);
    assert.equal(september.versions.length, 2);
    service.saveScheduleDay(actor, {
      targetMonth: "2026-09",
      versionId: secondVersionId,
      staffId: "staff-full",
      date: "2026-09-01",
      dayType: "paid_leave",
      segments: [],
    });
    september = service.confirmMonthlySchedule(actor, { targetMonth: "2026-09", versionId: secondVersionId });
    assert.equal(september.month.status, "confirmed");
    const oldVersion = service.scheduleDashboard(actor, { targetMonth: "2026-09", versionId: firstVersionId, selectedDate: "2026-09-01" });
    const newVersion = service.scheduleDashboard(actor, { targetMonth: "2026-09", selectedDate: "2026-09-01" });
    assert.equal(oldVersion.staff.find((staff) => staff.id === "staff-full").selectedDay.dayType, "work");
    assert.equal(newVersion.staff.find((staff) => staff.id === "staff-full").selectedDay.dayType, "paid_leave");

    const october = service.createMonthlySchedule(actor, { targetMonth: "2026-10" });
    service.saveScheduleDay(actor, {
      targetMonth: "2026-10",
      versionId: october.viewedVersion.id,
      staffId: "staff-full",
      date: "2026-10-01",
      dayType: "day_off",
      segments: [],
    });
    const septemberAfterOctober = service.scheduleDashboard(actor, { targetMonth: "2026-09", versionId: firstVersionId, selectedDate: "2026-09-01" });
    assert.equal(septemberAfterOctober.staff.find((staff) => staff.id === "staff-full").selectedDay.dayType, "work");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE target_type = 'staff_schedule_month'").get().count > 0, true);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects overlapping saves, stale versions, family actors, and family API sessions", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-schedule-security-"));
  const database = openDatabase(resolve(directory, "schedule.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-a", "schedule-admin", "架空 管理者");
    database.prepare(
      "INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ).run("staff-a", "ST0001", "架空 職員", "2026-01-01");
    const actor = { type: "administrator", id: "admin-a", role: "normal", mustChangePassword: false };
    const family = { type: "family", id: "family-account", familyId: "family-a", mustChangePassword: false };
    const service = createStaffScheduleService({ database });
    const schedule = service.createMonthlySchedule(actor, { targetMonth: "2026-09" });
    assert.throws(() => service.saveScheduleDay(actor, {
      targetMonth: "2026-09",
      versionId: schedule.viewedVersion.id,
      staffId: "staff-a",
      date: "2026-09-01",
      dayType: "work",
      segments: [
        { startTime: "09:00", endTime: "12:00", activityType: "childcare" },
        { startTime: "11:45", endTime: "12:15", activityType: "break" },
      ],
    }), (error) => error.code === "TIME_RANGE_OVERLAP");
    assert.throws(() => service.scheduleDashboard(family, { targetMonth: "2026-09" }), (error) => error.code === "FORBIDDEN");
    assert.throws(() => service.saveScheduleDay(actor, {
      targetMonth: "2026-10", versionId: schedule.viewedVersion.id, staffId: "staff-a",
      date: "2026-10-01", dayType: "day_off", segments: [],
    }), (error) => error.code === "STAFF_SCHEDULE_NOT_FOUND");

    const response = await handleStaffScheduleApiRequest(
      new Request("http://localhost/api/admin/staff-schedules?targetMonth=2026-09", {
        headers: { cookie: "nursery_session=family-session" },
      }),
      { service, authService: { sessionByToken: () => ({ actor: family }) } },
    );
    assert.equal(response.status, 403);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores independent staff day-off and work-time preferences with effective availability", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-preferences-"));
  const database = openDatabase(resolve(directory, "preferences.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-a", "preference-admin", "架空 管理者");
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
       VALUES (?, 4, 1, '09:00', '18:00')`,
    ).run("condition-a");

    const actor = { type: "administrator", id: "admin-a", role: "normal", mustChangePassword: false };
    const family = { type: "family", id: "family-account", familyId: "family-a", mustChangePassword: false };
    const service = createStaffScheduleService({ database, now: () => new Date("2026-08-25T11:00:00.000Z") });

    let september = service.saveStaffPreference(actor, {
      targetMonth: "2026-09",
      staffId: "staff-a",
      date: "2026-09-10",
      preferenceType: "day_off",
    });
    let preference = september.staff[0].selectedPreference;
    assert.equal(preference.preferenceType, "day_off");
    assert.equal(preference.effectiveAvailability.available, false);

    september = service.saveStaffPreference(actor, {
      targetMonth: "2026-09",
      staffId: "staff-a",
      date: "2026-09-10",
      preferenceType: "work_time",
      startTime: "10:00",
      endTime: "16:00",
    });
    preference = september.staff[0].selectedPreference;
    assert.equal(preference.preferenceType, "work_time");
    assert.equal(preference.requiresAdministratorReview, false);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM staff_schedule_preferences WHERE staff_id = ? AND date = ?",
    ).get("staff-a", "2026-09-10").count, 1);

    september = service.saveStaffPreference(actor, {
      targetMonth: "2026-09",
      staffId: "staff-a",
      date: "2026-09-10",
      preferenceType: "work_time",
      startTime: "08:00",
      endTime: "17:00",
    });
    preference = september.staff[0].selectedPreference;
    assert.equal(preference.requiresAdministratorReview, false);
    assert.equal(preference.reviewMessage, null);
    assert.deepEqual(preference.effectiveAvailability, {
      source: "preference",
      available: true,
      startTime: "08:00",
      endTime: "17:00",
    });

    service.saveStaffPreference(actor, {
      targetMonth: "2026-10",
      staffId: "staff-a",
      date: "2026-10-01",
      preferenceType: "day_off",
    });
    assert.deepEqual(service.staffPreferencesForMonth(actor, { targetMonth: "2026-09", staffId: "staff-a" })
      .preferences.map((entry) => entry.date), ["2026-09-10"]);
    assert.deepEqual(service.staffPreferencesForMonth(actor, { targetMonth: "2026-10", staffId: "staff-a" })
      .preferences.map((entry) => entry.date), ["2026-10-01"]);

    assert.throws(() => service.saveStaffPreference(actor, {
      targetMonth: "2026-09", staffId: "staff-a", date: "2026-09-10",
      preferenceType: "work_time", startTime: "09:05", endTime: "18:00",
    }), (error) => error.code === "INVALID_TIME");
    assert.throws(() => service.saveStaffPreference(actor, {
      targetMonth: "2026-09", staffId: "staff-a", date: "2026-09-10",
      preferenceType: "work_time", startTime: "18:00", endTime: "09:00",
    }), (error) => error.code === "INVALID_TIME_RANGE");
    assert.throws(() => service.saveStaffPreference(family, {
      targetMonth: "2026-09", staffId: "staff-a", date: "2026-09-10", preferenceType: "day_off",
    }), (error) => error.code === "FORBIDDEN");

    september = service.saveStaffPreference(actor, {
      targetMonth: "2026-09",
      staffId: "staff-a",
      date: "2026-09-10",
      preferenceType: "none",
    });
    assert.equal(september.staff[0].selectedPreference.preferenceType, "none");
    assert.equal(service.staffPreferencesForMonth(actor, { targetMonth: "2026-09" }).preferences.length, 0);
    assert.equal(service.staffPreferencesForMonth(actor, { targetMonth: "2026-10" }).preferences.length, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_days").get().count, 0);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM operation_logs WHERE target_type = 'staff_schedule_preference'",
    ).get().count, 5);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("converts automatic results while preserving paid leave and non-work other days", () => {
  const targetMonth = "2026-09";
  const staffProfiles = [{
    id: "staff-a",
    scheduledDays: [
      { staffId: "staff-a", date: "2026-09-02", dayType: "paid_leave", segments: [] },
      { staffId: "staff-a", date: "2026-09-03", dayType: "other", segments: [] },
    ],
  }];
  const days = buildAutomaticScheduleDraft({
    targetMonth,
    staffProfiles,
    generationResult: {
      targetMonth,
      daysOffPlan: {
        staffPlans: [{ staffId: "staff-a", finalPlannedDaysOff: ["2026-09-04"] }],
      },
      scheduleSegments: [
        { staffId: "staff-a", date: "2026-09-01", startTime: "09:00", endTime: "12:00", activityType: "childcare" },
        { staffId: "staff-a", date: "2026-09-01", startTime: "12:00", endTime: "13:00", activityType: "break" },
      ],
    },
  });
  assert.deepEqual(days.map((day) => [day.date, day.dayType, day.segments.length]), [
    ["2026-09-01", "work", 2],
    ["2026-09-02", "paid_leave", 0],
    ["2026-09-03", "other", 0],
    ["2026-09-04", "day_off", 0],
  ]);
});

test("explains staffing shortages and unplaced breaks from existing candidate evaluations", () => {
  const candidate = (staffId, exclusionReasons, options = {}) => ({
    staffId,
    automaticPlacementEligible: false,
    isLicensedNurseryTeacher: false,
    existingScheduleDayType: null,
    exclusionReasons,
    ...options,
  });
  const slot = {
    date: "2026-10-17",
    startTime: "09:00",
    endTime: "09:15",
    requiredChildcareWorkers: 2,
    assignedChildcareWorkerCount: 1,
    childcareWorkerShortage: 1,
    requiredLicensedNurseryTeachers: 1,
    assignedLicensedNurseryTeacherCount: 0,
    licensedNurseryTeacherShortage: 1,
    assignedStaff: [{ staffId: "staff-working" }],
    candidateEvaluations: [
      candidate("staff-preference-day-off", ["PREFERENCE_DAY_OFF"]),
      candidate("staff-outside-preference", ["OUTSIDE_PREFERENCE_TIME"]),
      candidate("staff-day-off", ["EXISTING_NON_WORK_DAY"], { existingScheduleDayType: "day_off" }),
      candidate("staff-paid-leave", ["EXISTING_NON_WORK_DAY"], { existingScheduleDayType: "paid_leave" }),
      candidate("staff-other", ["EXISTING_NON_WORK_DAY"], { existingScheduleDayType: "other" }),
      candidate("staff-weekday", ["WEEKDAY_NOT_AVAILABLE"]),
      candidate("staff-consecutive", ["CONSECUTIVE_WORK_LIMIT"]),
      candidate("staff-daily-limit", ["DAILY_WORK_LIMIT"], { isLicensedNurseryTeacher: true }),
      candidate("staff-monthly-limit", ["MONTHLY_WORK_LIMIT"], { isLicensedNurseryTeacher: true }),
      candidate("staff-support", [], { automaticPlacementEligible: true }),
    ],
  };
  const generationResult = {
    targetMonth: "2026-10",
    placement: { slots: [slot] },
    scheduleSegments: [{
      staffId: "staff-working",
      date: "2026-10-17",
      startTime: "07:30",
      endTime: "15:30",
      activityType: "childcare",
    }],
    breakPlan: {
      breakOutcomes: [{
        staffId: "staff-working",
        date: "2026-10-17",
        requiredBreakMinutes: 45,
        unresolvedReasonCode: "QUALIFIED_BREAK_COVERAGE_UNAVAILABLE",
      }],
    },
  };
  const preview = buildAutomaticSchedulePreview({
    targetMonth: "2026-10",
    days: [],
    staffProfiles: [{ id: "staff-working", staffCode: "ST0001", name: "架空 職員" }],
    requirementSource: {
      period: { id: "period-2026-10", targetMonth: "2026-10", status: "open" },
      slots: [slot],
    },
    unresolved: {
      staffingShortages: [{
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        childcareWorkerShortage: 1,
        licensedNurseryTeacherShortage: 1,
      }],
      daysOff: [],
      breaks: [{
        code: "QUALIFIED_BREAK_COVERAGE_UNAVAILABLE",
        staffId: "staff-working",
        date: "2026-10-17",
        requiredBreakMinutes: 45,
      }],
    },
    generationResult,
  });

  const childcare = preview.issues.childcareStaffing[0];
  assert.deepEqual({
    required: childcare.requiredChildcareWorkers,
    assigned: childcare.assignedChildcareWorkerCount,
    shortage: childcare.childcareWorkerShortage,
  }, { required: 2, assigned: 1, shortage: 1 });
  for (const code of [
    "PREFERENCE_DAY_OFF",
    "OUTSIDE_PREFERENCE_TIME",
    "EXISTING_DAY_OFF",
    "EXISTING_PAID_LEAVE",
    "EXISTING_NON_WORK_OTHER",
    "WEEKDAY_NOT_AVAILABLE",
    "CONSECUTIVE_WORK_LIMIT",
    "DAILY_WORK_LIMIT",
    "MONTHLY_WORK_LIMIT",
  ]) {
    assert.equal(childcare.exclusionReasons.some((entry) => entry.code === code), true, code);
  }
  const licensed = preview.issues.licensedStaffing[0];
  assert.equal(licensed.requiredLicensedNurseryTeachers, 1);
  assert.equal(licensed.assignedLicensedNurseryTeacherCount, 0);
  assert.equal(licensed.licensedNurseryTeacherShortage, 1);
  assert.equal(licensed.eligibleLicensedNurseryTeacherCandidateCount, 0);
  assert.equal(licensed.exclusionReasons.find((entry) => entry.code === "LICENSE_NOT_VALID").count, 8);
  assert.equal(licensed.exclusionReasons.some((entry) => entry.label === "月間勤務時間の上限に達しています"), true);

  const breakIssue = preview.issues.breaks[0];
  assert.equal(breakIssue.staffName, "架空 職員");
  assert.equal(breakIssue.workStartTime, "07:30");
  assert.equal(breakIssue.workEndTime, "15:30");
  assert.equal(breakIssue.qualifiedReliefUnavailable, true);
  assert.equal(breakIssue.unresolvedReasonLabel, "保育士資格者の交代要員を確保できません");
});

test("creates one auto-generated draft transactionally and keeps it compatible with retrieval and confirmation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-auto-draft-"));
  const database = openDatabase(resolve(directory, "automatic-draft.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-auto", "automatic-admin", "架空 自動作成管理者");
    for (const [id, code] of [["staff-a", "ST0001"], ["staff-b", "ST0002"], ["staff-c", "ST0003"], ["staff-d", "ST0004"]]) {
      insertAutomaticStaff(database, "admin-auto", id, code);
    }
    const actor = { type: "administrator", id: "admin-auto", role: "normal", mustChangePassword: false };
    const requirements = quarterHourRequirements("2026-09-07", "09:00", "18:00", 3, 1);
    let requirementLoadCount = 0;
    const service = createStaffScheduleService({
      database,
      now: () => new Date("2026-08-26T01:00:00.000Z"),
      automaticRequirementSlotsProvider: automaticRequirementSlotsProvider((targetMonth) => {
        requirementLoadCount += 1;
        return targetMonth === "2026-09" ? requirements : [];
      }),
    });

    const preview = service.previewAutomaticMonthlyDraft(actor, { targetMonth: "2026-09" });
    assert.equal(preview.sourcePeriod.id, "period-2026-09");
    assert.equal(preview.requirementSlotCount, requirements.length);
    assert.equal(preview.days.some((day) => day.dayType === "day_off"), true);
    assert.equal(preview.days.some((day) => day.segments.some((segment) => segment.activityType === "childcare")), true);
    assert.equal(preview.days.some((day) => day.segments.some((segment) => segment.activityType === "break")), true);
    assert.equal(preview.days.some((day) => day.scheduledWorkMinutes > 0), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_months").get().count, 0);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM operation_logs WHERE target_type = 'staff_schedule_month'",
    ).get().count, 0);

    const result = service.createAutomaticMonthlyDraft(actor, { targetMonth: "2026-09" });
    assert.equal(requirementLoadCount, 2, "preview and save each load the latest server-side requirements");

    assert.equal(result.schedule.month.status, "draft");
    assert.equal(result.schedule.viewedVersion.source, "auto_generated");
    assert.equal(result.schedule.viewedVersion.status, "draft");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_months").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_versions").get().count, 1);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM staff_schedule_days WHERE day_type = 'day_off'",
    ).get().count > 0, true);
    assert.equal(database.prepare(
      `SELECT COUNT(*) AS count FROM staff_schedule_segments WHERE activity_type = 'childcare'`,
    ).get().count > 0, true);
    assert.equal(database.prepare(
      `SELECT COUNT(*) AS count FROM staff_schedule_segments WHERE activity_type = 'break'`,
    ).get().count > 0, true);
    assert.equal(database.prepare(
      `SELECT COUNT(*) AS count
       FROM staff_schedule_segments s
       JOIN staff_schedule_days d ON d.id = s.schedule_day_id
       WHERE d.day_type <> 'work'`,
    ).get().count, 0);

    const loaded = service.scheduleDashboard(actor, {
      targetMonth: "2026-09",
      selectedDate: "2026-09-07",
    });
    assert.equal(loaded.viewedVersion.id, result.schedule.viewedVersion.id);
    assert.equal(loaded.staff.some((staff) => staff.selectedDay?.segments.some((segment) => segment.activityType === "break")), true);
    assert.equal(loaded.staff.reduce((total, staff) => total + staff.monthlyScheduledWorkMinutes, 0) > 0, true);

    assert.throws(() => service.createAutomaticMonthlyDraft(actor, {
      targetMonth: "2026-09",
    }), (error) => error.code === "DRAFT_ALREADY_EXISTS");
    const countsBeforeConfirmation = {
      versions: database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_versions").get().count,
      days: database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_days").get().count,
      segments: database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_segments").get().count,
    };
    service.confirmMonthlySchedule(actor, {
      targetMonth: "2026-09",
      versionId: result.schedule.viewedVersion.id,
    });
    assert.throws(() => service.createAutomaticMonthlyDraft(actor, {
      targetMonth: "2026-09",
    }), (error) => error.code === "CONFIRMED_SCHEDULE_EXISTS");
    assert.deepEqual({
      versions: database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_versions").get().count,
      days: database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_days").get().count,
      segments: database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_segments").get().count,
    }, countsBeforeConfirmation);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM _schema_migrations WHERE name = '0009_exotic_skin.sql'",
    ).get().count, 1);

    service.previewAutomaticMonthlyDraft(actor, { targetMonth: "2026-10" });
    service.createMonthlySchedule(actor, { targetMonth: "2026-10" });
    assert.throws(
      () => service.createAutomaticMonthlyDraft(actor, { targetMonth: "2026-10" }),
      (error) => error.code === "DRAFT_ALREADY_EXISTS",
      "save rechecks a conflict created after preview",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("saves unresolved automatic results as a draft without persisting the unresolved metadata", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-auto-unresolved-"));
  const database = openDatabase(resolve(directory, "automatic-unresolved.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-auto", "automatic-admin", "架空 自動作成管理者");
    insertAutomaticStaff(database, "admin-auto", "staff-a", "ST0001");
    database.prepare(
      `INSERT INTO closure_days (id, date, name, type, parent_input_allowed)
       VALUES ('closure-auto', '2026-10-03', '架空休園日', 'closed', 0),
              ('cooperation-auto', '2026-10-04', '架空家庭保育協力日', 'family_cooperation', 1)`,
    ).run();
    const actor = { type: "administrator", id: "admin-auto", role: "normal", mustChangePassword: false };
    const automaticShiftCalculator = ({ targetMonth, closureDates }) => {
      assert.deepEqual(closureDates, ["2026-10-03"]);
      return stubAutomaticResult(targetMonth, "staff-a", {
        shortages: [
          { date: `${targetMonth}-01`, startTime: "09:00", endTime: "09:15", childcareWorkerShortage: 1 },
          { date: `${targetMonth}-01`, startTime: "09:15", endTime: "09:30", childcareWorkerShortage: 1 },
        ],
        daysOffUnresolved: [
          { code: "DAY_OFF_TARGET_UNRESOLVED", staffId: "staff-a", shortageDays: 1 },
          { code: "CHILDCARE_STAFF_SHORTAGE_AFTER_DAY_OFF_PLAN", date: `${targetMonth}-01`, startTime: "09:00", shortage: 1 },
        ],
        breakUnresolved: [{ code: "BREAK_COVERAGE_UNAVAILABLE" }],
      });
    };
    const service = createStaffScheduleService({
      database,
      automaticShiftCalculator,
      automaticRequirementSlotsProvider: automaticRequirementSlotsProvider(),
    });
    const preview = service.previewAutomaticMonthlyDraft(actor, { targetMonth: "2026-10" });
    assert.equal(preview.hasUnresolved, true);
    assert.equal(preview.issues.childcareStaffing.length, 1);
    assert.equal(preview.issues.childcareStaffing[0].endTime, "09:30");
    assert.equal(preview.issues.daysOff.length, 1);
    assert.equal(preview.issues.daysOff[0].staffName, "架空 職員staff-a");
    assert.equal(preview.issues.breaks.length, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_months").get().count, 0);
    const result = service.createAutomaticMonthlyDraft(actor, { targetMonth: "2026-10" });
    assert.equal(result.schedule.month.status, "draft");
    assert.equal(result.unresolved.hasUnresolved, true);
    assert.equal(result.unresolved.staffingShortages.length, 2);
    assert.equal(result.unresolved.daysOff.length, 2);
    assert.equal(result.unresolved.breaks.length, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_months").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_segments").get().count, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects structurally invalid automatic results before saving and rolls back an insert failure", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-auto-rollback-"));
  const database = openDatabase(resolve(directory, "automatic-rollback.sqlite"));
  try {
    await applyMigrations(database);
    database.prepare(
      "INSERT INTO administrators (id, login_id, display_name, role, status) VALUES (?, ?, ?, 'normal', 'active')",
    ).run("admin-auto", "automatic-admin", "架空 自動作成管理者");
    insertAutomaticStaff(database, "admin-auto", "staff-a", "ST0001");
    const actor = { type: "administrator", id: "admin-auto", role: "normal", mustChangePassword: false };
    const overlapping = createStaffScheduleService({
      database,
      automaticShiftCalculator: ({ targetMonth }) => stubAutomaticResult(targetMonth, "staff-a", {
        scheduleSegments: [
          { staffId: "staff-a", date: `${targetMonth}-01`, startTime: "09:00", endTime: "12:00", activityType: "childcare" },
          { staffId: "staff-a", date: `${targetMonth}-01`, startTime: "11:45", endTime: "12:15", activityType: "break" },
        ],
      }),
      automaticRequirementSlotsProvider: automaticRequirementSlotsProvider(),
    });
    assert.throws(() => overlapping.createAutomaticMonthlyDraft(actor, {
      targetMonth: "2026-11",
      requirementSlots: [],
    }), (error) => error.code === "TIME_RANGE_OVERLAP");

    const invalidQuarterHour = createStaffScheduleService({
      database,
      automaticShiftCalculator: ({ targetMonth }) => stubAutomaticResult(targetMonth, "staff-a", {
        scheduleSegments: [{
          staffId: "staff-a",
          date: `${targetMonth}-01`,
          startTime: "09:05",
          endTime: "10:00",
          activityType: "childcare",
        }],
      }),
      automaticRequirementSlotsProvider: automaticRequirementSlotsProvider(),
    });
    assert.throws(() => invalidQuarterHour.createAutomaticMonthlyDraft(actor, {
      targetMonth: "2026-11",
      requirementSlots: [],
    }), (error) => error.code === "INVALID_TIME");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_months").get().count, 0);

    database.exec(`
      CREATE TEMP TRIGGER fail_auto_segment_for_test
      BEFORE INSERT ON staff_schedule_segments
      BEGIN
        SELECT RAISE(ABORT, 'forced automatic segment failure');
      END;
    `);
    const valid = createStaffScheduleService({
      database,
      automaticShiftCalculator: ({ targetMonth }) => stubAutomaticResult(targetMonth, "staff-a"),
      automaticRequirementSlotsProvider: automaticRequirementSlotsProvider(),
    });
    assert.throws(() => valid.createAutomaticMonthlyDraft(actor, {
      targetMonth: "2026-12",
      requirementSlots: [],
    }), /forced automatic segment failure/);
    for (const table of [
      "staff_schedule_months",
      "staff_schedule_versions",
      "staff_schedule_days",
      "staff_schedule_segments",
    ]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM operation_logs WHERE target_type = 'staff_schedule_month'",
    ).get().count, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("connects administrator-only automatic preview and explicit draft APIs", async () => {
  const csrfToken = "automatic-preview-csrf-token";
  const actor = { type: "administrator", id: "admin-auto", role: "normal", mustChangePassword: false };
  const session = { actor, csrfTokenHash: hashOpaqueValue(csrfToken) };
  const authService = {
    sessionByToken: (token) => token === "admin-session" ? session : null,
  };
  const calls = [];
  const service = {
    previewAutomaticMonthlyDraft(receivedActor, body) {
      calls.push(["preview", receivedActor.id, body.targetMonth]);
      return { targetMonth: body.targetMonth, days: [], issues: {}, hasUnresolved: false };
    },
    createAutomaticMonthlyDraft(receivedActor, body) {
      calls.push(["draft", receivedActor.id, body.targetMonth]);
      return { schedule: { targetMonth: body.targetMonth }, unresolved: { hasUnresolved: false } };
    },
  };
  const request = (path) => new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost",
      cookie: `nursery_session=admin-session; nursery_csrf=${csrfToken}`,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ targetMonth: "2026-09", requirementSlots: [{ untrusted: true }] }),
  });

  const previewResponse = await handleStaffScheduleApiRequest(
    request("/api/admin/staff-schedules/automatic-preview"),
    { service, authService },
  );
  assert.equal(previewResponse.status, 200);
  assert.equal((await previewResponse.json()).preview.targetMonth, "2026-09");
  const draftResponse = await handleStaffScheduleApiRequest(
    request("/api/admin/staff-schedules/automatic-draft"),
    { service, authService },
  );
  assert.equal(draftResponse.status, 201);
  assert.deepEqual(calls, [
    ["preview", "admin-auto", "2026-09"],
    ["draft", "admin-auto", "2026-09"],
  ]);

  const unauthenticated = await handleStaffScheduleApiRequest(
    new Request("http://localhost/api/admin/staff-schedules/automatic-preview", { method: "POST" }),
    { service, authService },
  );
  assert.equal(unauthenticated.status, 401);
});
