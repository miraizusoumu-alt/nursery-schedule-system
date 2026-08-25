import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { createStaffScheduleService } from "../lib/server/staff-schedule/service.mjs";
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
} from "../lib/server/staffing/scheduled-work.mjs";
import { handleStaffScheduleApiRequest } from "../server/staff-schedule-http.mjs";

const fullWorkDay = () => [
  { startTime: "09:00", endTime: "12:00", activityType: "childcare" },
  { startTime: "12:00", endTime: "13:00", activityType: "break" },
  { startTime: "13:00", endTime: "17:00", activityType: "childcare" },
  { startTime: "17:00", endTime: "18:00", activityType: "administration" },
];

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
