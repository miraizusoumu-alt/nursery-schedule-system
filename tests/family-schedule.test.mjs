import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { generateTemporaryPassword, hashPassword } from "../lib/server/auth/security.mjs";
import { createFamilyScheduleService } from "../lib/server/family-schedule/service.mjs";
import { createFamilyScheduleExcel, headcountAlertLevel } from "../lib/server/family-schedule/excel-export.mjs";
import { handleAdminScheduleApiRequest } from "../server/admin-schedule-http.mjs";
import { handleFamilyScheduleApiRequest } from "../server/family-schedule-http.mjs";

async function withScheduleDatabase(run, initialTime = new Date("2026-08-20T00:00:00.000Z")) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-family-schedule-"));
  const database = openDatabase(resolve(directory, "schedule.sqlite"));
  const clock = { value: initialTime };
  try {
    await applyMigrations(database);
    const fixture = await insertFixture(database, initialTime);
    const authService = createAuthService({ database, now: () => clock.value });
    const service = createFamilyScheduleService({ database, now: () => clock.value });
    await run({ database, service, authService, fixture, clock });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function insertFixture(database, currentTime) {
  const timestamp = currentTime.toISOString();
  const passwords = {
    familyA: generateTemporaryPassword(),
    familyB: generateTemporaryPassword(),
    administrator: generateTemporaryPassword(),
  };
  const familyAHash = await hashPassword(passwords.familyA);
  const familyBHash = await hashPassword(passwords.familyB);
  const administratorHash = await hashPassword(passwords.administrator);

  for (const [id, code, name, loginId, hash] of [
    ["family-a", "DEMO-FAMILY-A", "架空家庭A", "demo-family-a", familyAHash],
    ["family-b", "DEMO-FAMILY-B", "架空家庭B", "demo-family-b", familyBHash],
  ]) {
    database.prepare(
      `INSERT INTO families (id, family_code, display_name, status, issued_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, code, name, timestamp, timestamp, timestamp);
    database.prepare(
      `INSERT INTO family_accounts
       (id, family_id, login_id, password_hash, must_change_password, temporary_password_issued_at,
        credential_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)`,
    ).run(`${id}-account`, id, loginId, hash, timestamp, timestamp, timestamp);
  }

  database.prepare(
    `INSERT INTO administrators
     (id, login_id, display_name, role, password_hash, must_change_password,
      credential_version, status, created_at, updated_at)
     VALUES ('normal-admin', 'demo-schedule-admin', '架空予定管理者', 'normal', ?, 0, 1, 'active', ?, ?)`,
  ).run(administratorHash, timestamp, timestamp);
  database.prepare(
    `INSERT INTO administrators
     (id, login_id, display_name, role, password_hash, must_change_password,
      credential_version, status, created_at, updated_at)
     VALUES ('master-admin', 'demo-schedule-master', '架空マスター管理者', 'master', ?, 0, 1, 'active', ?, ?)`,
  ).run(administratorHash, timestamp, timestamp);

  for (const [id, code, name, className, familyId, sortOrder] of [
    ["child-a1", "DEMO-CHILD-A1", "架空園児A1", "架空組A", "family-a", 1],
    ["child-a2", "DEMO-CHILD-A2", "架空園児A2", "架空組B", "family-a", 2],
    ["child-b1", "DEMO-CHILD-B1", "架空園児B1", "架空組C", "family-b", 1],
  ]) {
    database.prepare(
      `INSERT INTO children (id, child_code, name, kana, class_name, enrollment_date, status, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, '2026-09-01', 'enrolled', ?, ?)`,
    ).run(id, code, name, className, timestamp, timestamp);
    database.prepare(
      `INSERT INTO family_children (family_id, child_id, relationship_label, is_primary, sort_order, created_at)
       VALUES (?, ?, '保護者（架空）', 1, ?, ?)`,
    ).run(familyId, id, sortOrder, timestamp);
    for (let weekday = 1; weekday <= 6; weekday += 1) {
      database.prepare(
        `INSERT INTO basic_usage_patterns
         (id, child_id, weekday, enabled, arrival_time, departure_time, valid_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '2026-09-01', ?, ?)`,
      ).run(`${id}-pattern-${weekday}`, id, weekday, weekday <= 5 ? 1 : 0, "08:30", "17:30", timestamp, timestamp);
    }
  }

  database.prepare(
    `INSERT INTO submission_periods (id, target_month, deadline_at, status, created_at, updated_at)
     VALUES ('period-2026-09', '2026-09', '2026-08-25T14:59:59.000Z', 'open', ?, ?)`,
  ).run(timestamp, timestamp);
  database.prepare(
    `INSERT INTO closure_days
     (id, date, name, type, parent_input_allowed, note, created_at, updated_at)
     VALUES ('closure-2026-09-21', '2026-09-21', '架空休園日', 'closed', 0, '', ?, ?)`,
  ).run(timestamp, timestamp);

  return {
    passwords,
    actorA: { type: "family", id: "family-a-account", familyId: "family-a", displayName: "架空家庭A", mustChangePassword: false },
    actorB: { type: "family", id: "family-b-account", familyId: "family-b", displayName: "架空家庭B", mustChangePassword: false },
    actorAdmin: { type: "administrator", id: "normal-admin", role: "normal", displayName: "架空予定管理者", mustChangePassword: false },
    actorMaster: { type: "administrator", id: "master-admin", role: "master", displayName: "架空マスター管理者", mustChangePassword: false },
  };
}

function daysWithPatch(dashboard, childId, date, patch) {
  const child = dashboard.children.find((entry) => entry.id === childId);
  assert.ok(child);
  return child.schedule.days.map((day) => day.date === date ? { ...day, ...patch } : day);
}

async function familySession(authService, loginId, password) {
  const result = await authService.login({ scope: "family", loginId, password, source: "test" });
  return {
    actor: result.actor,
    cookie: `nursery_session=${result.session.token}; nursery_csrf=${result.session.csrfToken}`,
    csrfToken: result.session.csrfToken,
  };
}

async function administratorSession(authService, loginId, password) {
  const result = await authService.login({ scope: "administrator", loginId, password, source: "test" });
  return {
    actor: result.actor,
    cookie: `nursery_session=${result.session.token}; nursery_csrf=${result.session.csrfToken}`,
    csrfToken: result.session.csrfToken,
  };
}

function apiRequest(path, session, { method = "GET", body, csrf = true } = {}) {
  const headers = new Headers({ cookie: session.cookie });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    headers.set("origin", "http://localhost");
    if (csrf) headers.set("x-csrf-token", session.csrfToken);
  }
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawSubmissionVersion(database, versionId) {
  return {
    version: database.prepare("SELECT * FROM family_submission_versions WHERE id = ?").get(versionId),
    children: database.prepare(
      "SELECT * FROM family_submission_version_children WHERE version_id = ? ORDER BY child_id",
    ).all(versionId),
    days: database.prepare(
      `SELECT d.*
       FROM family_submission_version_days d
       JOIN family_submission_version_children c ON c.id = d.version_child_id
       WHERE c.version_id = ?
       ORDER BY c.child_id, d.date`,
    ).all(versionId),
  };
}

function submissionVersionPayload(database, versionId) {
  return {
    children: database.prepare(
      `SELECT child_id, child_code_snapshot, name_snapshot, kana_snapshot,
              last_name_snapshot, first_name_snapshot, last_name_kana_snapshot, first_name_kana_snapshot,
              class_name_snapshot, birth_date_snapshot, enrollment_date_snapshot, withdrawal_date_snapshot
       FROM family_submission_version_children
       WHERE version_id = ?
       ORDER BY child_code_snapshot, child_id`,
    ).all(versionId).map((row) => ({ ...row })),
    days: database.prepare(
      `SELECT c.child_id, d.date, d.usage_status, d.arrival_time, d.departure_time, d.source, d.changed
       FROM family_submission_version_days d
       JOIN family_submission_version_children c ON c.id = d.version_child_id
       WHERE c.version_id = ?
       ORDER BY c.child_code_snapshot, c.child_id, d.date`,
    ).all(versionId).map((row) => ({ ...row })),
  };
}

function mutableSchedulePayload(database, familyId, submissionPeriodId) {
  return {
    monthly: database.prepare(
      `SELECT m.*
       FROM monthly_schedules m
       JOIN family_submissions s ON s.id = m.family_submission_id
       WHERE s.family_id = ? AND s.submission_period_id = ?
       ORDER BY m.child_id`,
    ).all(familyId, submissionPeriodId).map((row) => ({ ...row })),
    daily: database.prepare(
      `SELECT d.*
       FROM daily_schedules d
       JOIN monthly_schedules m ON m.id = d.monthly_schedule_id
       JOIN family_submissions s ON s.id = m.family_submission_id
       WHERE s.family_id = ? AND s.submission_period_id = ?
       ORDER BY m.child_id, d.date`,
    ).all(familyId, submissionPeriodId).map((row) => ({ ...row })),
  };
}

test("creates only the active target month from child-specific base patterns without overwriting drafts", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    const dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, true);
    assert.equal(dashboard.period.targetMonth, "2026-09");
    assert.deepEqual(dashboard.children.map((child) => child.id), ["child-a1", "child-a2"]);
    assert.ok(!dashboard.children.some((child) => child.id === "child-b1"));
    assert.equal(dashboard.children[0].schedule.days.length, 30);
    assert.equal(dashboard.children[0].schedule.days.find((day) => day.date === "2026-09-21").usageStatus, "closed");

    service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    const afterReload = service.dashboard(fixture.actorA);
    assert.equal(afterReload.children.find((child) => child.id === "child-a1").schedule.days.find((day) => day.date === "2026-09-01").usageStatus, "off");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monthly_schedules WHERE child_id = 'child-a1'").get().count, 1);
  });
});

test("rejects cross-family access, invalid times, and closed-day edits in both service and API paths", async () => {
  await withScheduleDatabase(async ({ service, authService, fixture }) => {
    const dashboard = service.dashboard(fixture.actorA);
    assert.deepEqual(dashboard.children.map((child) => child.id), ["child-a1", "child-a2"]);
    assert.ok(!dashboard.children.some((child) => child.id === "child-b1"));
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-b1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off" }) }),
      (error) => error.code === "CHILD_SCOPE_VIOLATION",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "using", arrivalTime: "17:30", departureTime: "08:30" }) }),
      (error) => error.code === "INVALID_TIME_RANGE",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "using", arrivalTime: "08:32", departureTime: "17:30" }) }),
      (error) => error.code === "INVALID_TIME",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "using", arrivalTime: "06:55", departureTime: "17:30" }) }),
      (error) => error.code === "OUTSIDE_OPENING_HOURS",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "using", arrivalTime: "08:30", departureTime: "20:05" }) }),
      (error) => error.code === "OUTSIDE_OPENING_HOURS",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-21", { usageStatus: "using", arrivalTime: "08:30", departureTime: "17:30" }) }),
      (error) => error.code === "LOCKED_DAY",
    );

    const session = await familySession(authService, "demo-family-a", fixture.passwords.familyA);
    const response = await handleFamilyScheduleApiRequest(new Request("http://localhost/api/family/schedule/children/child-b1", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: "http://localhost",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off" }) }),
    }), { service, authService });
    assert.equal(response.status, 403);

    const copyResponse = await handleFamilyScheduleApiRequest(
      apiRequest("/api/family/schedule/copy-to-siblings", session, {
        method: "POST",
        body: { sourceChildId: "child-b1" },
      }),
      { service, authService },
    );
    assert.equal(copyResponse.status, 403);
    assert.equal((await copyResponse.json()).code, "CHILD_SCOPE_VIOLATION");

    const crossFamilySubmit = await handleFamilyScheduleApiRequest(
      apiRequest("/api/family/schedule/submit", session, {
        method: "POST",
        body: { childId: "child-b1" },
      }),
      { service, authService },
    );
    assert.equal(crossFamilySubmit.status, 403);
    assert.equal((await crossFamilySubmit.json()).code, "SUBMISSION_SCOPE_INVALID");
  });
});

test("copies one child's schedule to siblings and still allows individual edits afterward", async () => {
  await withScheduleDatabase(async ({ service, fixture }) => {
    let dashboard = service.dashboard(fixture.actorA);
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    dashboard = service.copyChildScheduleToSiblings(fixture.actorA, "child-a1");
    assert.equal(dashboard.children.find((child) => child.id === "child-a2").schedule.days.find((day) => day.date === "2026-09-01").usageStatus, "off");

    dashboard = service.updateChildSchedule(fixture.actorA, "child-a2", {
      days: daysWithPatch(dashboard, "child-a2", "2026-09-01", { usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" }),
    });
    assert.equal(dashboard.children.find((child) => child.id === "child-a1").schedule.days.find((day) => day.date === "2026-09-01").usageStatus, "off");
    assert.equal(dashboard.children.find((child) => child.id === "child-a2").schedule.days.find((day) => day.date === "2026-09-01").arrivalTime, "09:00");
  });
});

test("submits every child in one transaction, rolls back on failure, and records resubmission history", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    service.dashboard(fixture.actorA);
    database.exec(`
      CREATE TEMP TRIGGER fail_submit_for_test
      BEFORE UPDATE OF status ON monthly_schedules
      WHEN NEW.status = 'submitted'
      BEGIN
        SELECT RAISE(ABORT, 'forced submit failure');
      END
    `);
    assert.throws(() => service.submitFamilySchedules(fixture.actorA), /forced submit failure/);
    const rolledBackSubmission = database.prepare(
      `SELECT status, submitted_at, latest_submitted_version_id,
              latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a'`,
    ).get();
    assert.deepEqual({ ...rolledBackSubmission }, {
      status: "draft",
      submitted_at: null,
      latest_submitted_version_id: null,
      latest_confirmed_version_id: null,
      latest_effective_version_id: null,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_versions").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_version_children").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_version_days").get().count, 0);

    database.exec("DROP TRIGGER fail_submit_for_test");
    let dashboard = service.submitFamilySchedules(fixture.actorA);
    const firstSubmittedAt = dashboard.submission.submittedAt;
    const firstVersion = service.latestSubmittedVersion(fixture.actorA);
    assert.equal(dashboard.submission.status, "submitted");
    assert.equal(firstVersion.sequenceNumber, 1);
    assert.equal(firstVersion.versionType, "parent_submission");
    assert.equal(firstVersion.reviewStatus, "pending");
    assert.equal(firstVersion.sourceVersionId, null);
    assert.equal(firstVersion.submittedAt, firstSubmittedAt);
    assert.equal(firstVersion.createdByFamilyAccountId, fixture.actorA.id);
    assert.equal(firstVersion.submissionPeriodId, "period-2026-09");
    assert.deepEqual(firstVersion.children.map((child) => child.childId).sort(), ["child-a1", "child-a2"]);
    assert.ok(firstVersion.children.every((child) => child.days.length === 30));

    const firstChild = firstVersion.children.find((child) => child.childId === "child-a1");
    const firstUsingDay = firstChild.days.find((day) => day.date === "2026-09-01");
    assert.deepEqual(
      {
        usageStatus: firstUsingDay.usageStatus,
        arrivalTime: firstUsingDay.arrivalTime,
        departureTime: firstUsingDay.departureTime,
      },
      { usageStatus: "using", arrivalTime: "08:30", departureTime: "17:30" },
    );
    assert.equal(firstChild.days.find((day) => day.date === "2026-09-05").usageStatus, "off");
    assert.equal(firstChild.days.find((day) => day.date === "2026-09-05").arrivalTime, null);
    assert.equal(firstChild.days.find((day) => day.date === "2026-09-21").usageStatus, "closed");
    assert.equal(firstChild.days.find((day) => day.date === "2026-09-21").departureTime, null);

    const firstPointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a'`,
    ).get();
    assert.deepEqual({ ...firstPointers }, {
      latest_submitted_version_id: firstVersion.id,
      latest_confirmed_version_id: null,
      latest_effective_version_id: firstVersion.id,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monthly_schedules WHERE status = 'submitted' AND child_id IN ('child-a1', 'child-a2')").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM change_histories WHERE family_id = 'family-a' AND reason_text = '初回提出'").get().count, 1);
    const firstRawSnapshot = rawSubmissionVersion(database, firstVersion.id);

    clock.value = new Date("2026-08-21T00:00:00.000Z");
    service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    dashboard = service.dashboard(fixture.actorA);
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboard.submission.revisionRequired, true);
    assert.equal(dashboard.submission.submittedAt, firstSubmittedAt);
    assert.equal(service.latestSubmittedVersion(fixture.actorA).id, firstVersion.id);
    assert.equal(
      service.latestSubmittedVersion(fixture.actorA)
        .children.find((child) => child.childId === "child-a1")
        .days.find((day) => day.date === "2026-09-02").usageStatus,
      "using",
    );
    assert.deepEqual(rawSubmissionVersion(database, firstVersion.id), firstRawSnapshot);

    clock.value = new Date("2026-08-21T01:00:00.000Z");
    dashboard = service.submitFamilySchedules(fixture.actorA);
    const secondVersion = service.latestSubmittedVersion(fixture.actorA);
    assert.equal(dashboard.submission.status, "submitted");
    assert.notEqual(dashboard.submission.submittedAt, firstSubmittedAt);
    assert.notEqual(secondVersion.id, firstVersion.id);
    assert.equal(secondVersion.sequenceNumber, 2);
    assert.equal(secondVersion.sourceVersionId, firstVersion.id);
    assert.equal(secondVersion.submittedAt, dashboard.submission.submittedAt);
    assert.equal(
      secondVersion.children.find((child) => child.childId === "child-a1")
        .days.find((day) => day.date === "2026-09-02").usageStatus,
      "off",
    );
    assert.deepEqual(rawSubmissionVersion(database, firstVersion.id), firstRawSnapshot);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_versions").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_version_children").get().count, 4);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_version_days").get().count, 120);
    const secondPointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a'`,
    ).get();
    assert.deepEqual({ ...secondPointers }, {
      latest_submitted_version_id: secondVersion.id,
      latest_confirmed_version_id: null,
      latest_effective_version_id: secondVersion.id,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM change_histories WHERE family_id = 'family-a' AND reason_text = '再提出'").get().count, 1);
    assert.ok(database.prepare("SELECT COUNT(*) AS count FROM change_histories WHERE family_id = 'family-a' AND target_date = '2026-09-02'").get().count >= 1);
  });
});

test("keeps submission versions isolated by family and target month", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    service.dashboard(fixture.actorA);
    service.dashboard(fixture.actorB);
    assert.equal(service.latestSubmittedVersion(fixture.actorB), null);

    database.exec(`
      INSERT INTO submission_periods
      (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
      VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'draft', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO family_submissions
      (id, family_id, submission_period_id, status, submitted_at, last_updated_at, created_at)
      VALUES ('submission-a-oct', 'family-a', 'period-2026-10', 'draft', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO monthly_schedules
      (id, child_id, submission_period_id, family_submission_id, status, base_pattern_snapshot_json, confirmed_at, created_at, updated_at)
      VALUES ('monthly-a1-oct', 'child-a1', 'period-2026-10', 'submission-a-oct', 'draft', '[]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO daily_schedules
      (id, monthly_schedule_id, date, usage_status, arrival_time, departure_time, source, changed, created_at, updated_at)
      VALUES ('day-a1-oct-01', 'monthly-a1-oct', '2026-10-01', 'using', '09:00', '16:00', 'daily', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    service.submitFamilySchedules(fixture.actorA);
    const familyAVersion = service.latestSubmittedVersion(fixture.actorA);
    assert.equal(familyAVersion.familyId, "family-a");
    assert.equal(familyAVersion.submissionPeriodId, "period-2026-09");
    assert.deepEqual(familyAVersion.children.map((child) => child.childId).sort(), ["child-a1", "child-a2"]);
    assert.ok(familyAVersion.children.flatMap((child) => child.days).every((day) => day.date.startsWith("2026-09-")));
    assert.equal(service.latestSubmittedVersion(fixture.actorB), null);

    service.submitFamilySchedules(fixture.actorB);
    const familyBVersion = service.latestSubmittedVersion(fixture.actorB);
    assert.equal(familyBVersion.familyId, "family-b");
    assert.equal(familyBVersion.submissionPeriodId, "period-2026-09");
    assert.deepEqual(familyBVersion.children.map((child) => child.childId), ["child-b1"]);
    assert.equal(service.latestSubmittedVersion(fixture.actorA).id, familyAVersion.id);
    assert.deepEqual(
      database.prepare(
        `SELECT family_id, submission_period_id, sequence_number
         FROM family_submission_versions ORDER BY family_id`,
      ).all().map((row) => ({ ...row })),
      [
        { family_id: "family-a", submission_period_id: "period-2026-09", sequence_number: 1 },
        { family_id: "family-b", submission_period_id: "period-2026-09", sequence_number: 1 },
      ],
    );
  });
});

test("confirms the latest parent submission immutably and reconfirms only after resubmission", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    let dashboard = service.dashboard(fixture.actorA);
    service.dashboard(fixture.actorB);
    dashboard = service.submitFamilySchedules(fixture.actorA);
    const firstSubmitted = service.latestSubmittedVersion(fixture.actorA);
    const firstSubmittedRaw = rawSubmissionVersion(database, firstSubmitted.id);
    const firstSubmittedPayload = submissionVersionPayload(database, firstSubmitted.id);

    assert.throws(
      () => service.confirmLatestFamilySubmission(fixture.actorA, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    assert.throws(
      () => service.confirmLatestFamilySubmission(fixture.actorAdmin, {
        familyId: "family-b",
        submissionPeriodId: "period-2026-09",
      }),
      (error) => error.code === "SUBMITTED_VERSION_REQUIRED",
    );
    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'draft', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    assert.throws(
      () => service.confirmLatestFamilySubmission(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-10",
      }),
      (error) => error.code === "PERIOD_NOT_REVIEWABLE",
    );

    clock.value = new Date("2026-08-21T00:00:00.000Z");
    service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    dashboard = service.dashboard(fixture.actorA);
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboard.submission.revisionRequired, true);
    assert.equal(
      dashboard.children.find((child) => child.id === "child-a1")
        .schedule.days.find((day) => day.date === "2026-09-02").usageStatus,
      "off",
    );

    clock.value = new Date("2026-08-26T00:00:00.000Z");
    database.prepare("UPDATE submission_periods SET status = 'closed' WHERE id = 'period-2026-09'").run();
    const firstConfirmed = service.confirmLatestFamilySubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(firstConfirmed.idempotent, false);
    assert.equal(firstConfirmed.sequenceNumber, 2);
    assert.equal(firstConfirmed.versionType, "administrator_revision");
    assert.equal(firstConfirmed.reviewStatus, "confirmed");
    assert.equal(firstConfirmed.sourceVersionId, firstSubmitted.id);
    assert.equal(firstConfirmed.createdByFamilyAccountId, null);
    assert.equal(firstConfirmed.createdByAdministratorId, fixture.actorAdmin.id);
    assert.equal(firstConfirmed.confirmedByAdministratorId, fixture.actorAdmin.id);
    assert.equal(firstConfirmed.confirmedAt, "2026-08-26T00:00:00.000Z");
    assert.deepEqual(firstConfirmed.changeSummary, {
      kind: "confirmation",
      changed: false,
      sourceVersionId: firstSubmitted.id,
    });
    assert.deepEqual(submissionVersionPayload(database, firstConfirmed.id), firstSubmittedPayload);
    const firstConfirmedRaw = rawSubmissionVersion(database, firstConfirmed.id);
    assert.equal(
      firstConfirmed.children.find((child) => child.childId === "child-a1")
        .days.find((day) => day.date === "2026-09-02").usageStatus,
      "using",
    );
    assert.deepEqual(rawSubmissionVersion(database, firstSubmitted.id), firstSubmittedRaw);

    let pointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    assert.deepEqual({ ...pointers }, {
      latest_submitted_version_id: firstSubmitted.id,
      latest_confirmed_version_id: firstConfirmed.id,
      latest_effective_version_id: firstConfirmed.id,
    });

    const idempotentConfirmation = service.confirmLatestFamilySubmission(fixture.actorMaster, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(idempotentConfirmation.id, firstConfirmed.id);
    assert.equal(idempotentConfirmation.idempotent, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'family_submission.confirmed'").get().count, 1);

    database.prepare("UPDATE submission_periods SET status = 'open' WHERE id = 'period-2026-09'").run();
    service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      extendedDeadlineAt: "2026-08-27T14:59:59.000Z",
      reason: "再提出確認のための延長",
    });
    service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    service.submitFamilySchedules(fixture.actorA);
    const secondSubmitted = service.latestSubmittedVersion(fixture.actorA);
    const secondSubmittedRaw = rawSubmissionVersion(database, secondSubmitted.id);
    assert.equal(secondSubmitted.sequenceNumber, 3);
    assert.equal(secondSubmitted.sourceVersionId, firstSubmitted.id);
    assert.equal(
      secondSubmitted.children.find((child) => child.childId === "child-a1")
        .days.find((day) => day.date === "2026-09-02").usageStatus,
      "off",
    );
    pointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    assert.deepEqual({ ...pointers }, {
      latest_submitted_version_id: secondSubmitted.id,
      latest_confirmed_version_id: firstConfirmed.id,
      latest_effective_version_id: secondSubmitted.id,
    });
    const secondConfirmed = service.confirmLatestFamilySubmission(fixture.actorMaster, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(secondConfirmed.sequenceNumber, 4);
    assert.equal(secondConfirmed.sourceVersionId, secondSubmitted.id);
    assert.equal(secondConfirmed.createdByAdministratorId, fixture.actorMaster.id);
    assert.deepEqual(submissionVersionPayload(database, secondConfirmed.id), submissionVersionPayload(database, secondSubmitted.id));
    pointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    assert.deepEqual({ ...pointers }, {
      latest_submitted_version_id: secondSubmitted.id,
      latest_confirmed_version_id: secondConfirmed.id,
      latest_effective_version_id: secondConfirmed.id,
    });
    assert.deepEqual(rawSubmissionVersion(database, firstSubmitted.id), firstSubmittedRaw);
    assert.deepEqual(rawSubmissionVersion(database, firstConfirmed.id), firstConfirmedRaw);
    assert.deepEqual(rawSubmissionVersion(database, secondSubmitted.id), secondSubmittedRaw);

    const confirmationLogs = database.prepare(
      `SELECT actor_type, actor_id, target_type, target_id, target_month, detail_json
       FROM operation_logs
       WHERE operation = 'family_submission.confirmed'
       ORDER BY occurred_at, rowid`,
    ).all();
    assert.equal(confirmationLogs.length, 2);
    assert.deepEqual(confirmationLogs.map((row) => [row.actor_type, row.actor_id]), [
      ["administrator", fixture.actorAdmin.id],
      ["administrator", fixture.actorMaster.id],
    ]);
    assert.equal(confirmationLogs[0].target_type, "family_submission");
    assert.equal(confirmationLogs[0].target_id, firstSubmitted.familySubmissionId);
    assert.equal(confirmationLogs[0].target_month, "2026-09");
    assert.deepEqual(JSON.parse(confirmationLogs[0].detail_json), {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      sourceVersionId: firstSubmitted.id,
      confirmedVersionId: firstConfirmed.id,
      sequenceNumber: 2,
      childCount: 2,
      dayCount: 60,
    });
  });
});

test("rolls back the complete administrator confirmation when final audit logging fails", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    service.dashboard(fixture.actorA);
    service.submitFamilySchedules(fixture.actorA);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const submittedRaw = rawSubmissionVersion(database, submitted.id);
    database.exec(`
      CREATE TEMP TRIGGER fail_confirmation_for_test
      BEFORE INSERT ON operation_logs
      WHEN NEW.operation = 'family_submission.confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'forced confirmation failure');
      END
    `);

    assert.throws(
      () => service.confirmLatestFamilySubmission(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
      }),
      /forced confirmation failure/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_versions").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_version_children").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_version_days").get().count, 60);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'family_submission.confirmed'").get().count, 0);
    assert.deepEqual(rawSubmissionVersion(database, submitted.id), submittedRaw);
    const pointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    assert.deepEqual({ ...pointers }, {
      latest_submitted_version_id: submitted.id,
      latest_confirmed_version_id: null,
      latest_effective_version_id: submitted.id,
    });
  });
});

test("previews and creates immutable administrator revisions from the current effective version", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    service.dashboard(fixture.actorA);
    service.dashboard(fixture.actorB);
    service.submitFamilySchedules(fixture.actorA);
    service.submitFamilySchedules(fixture.actorB);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const familyBSubmitted = service.latestSubmittedVersion(fixture.actorB);
    const confirmed = service.confirmLatestFamilySubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    const confirmedRaw = rawSubmissionVersion(database, confirmed.id);
    const confirmedPayload = submissionVersionPayload(database, confirmed.id);
    const mutableBefore = mutableSchedulePayload(database, "family-a", "period-2026-09");
    const versionCountBeforePreview = database.prepare(
      "SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'",
    ).get().count;

    const changes = [
      { childId: "child-a1", date: "2026-09-01", usageStatus: "off" },
      { childId: "child-a1", date: "2026-09-02", usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" },
      { childId: "child-a1", date: "2026-09-05", usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" },
    ];
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorA, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        reason: "Test revision",
        changes,
      }),
      (error) => error.code === "FORBIDDEN",
    );
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        reason: "",
        changes,
      }),
      (error) => error.code === "INVALID_REASON",
    );
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        reason: "Invalid child",
        changes: [{ childId: "child-b1", date: "2026-09-01", usageStatus: "off" }],
      }),
      (error) => error.code === "CHILD_SCOPE_VIOLATION",
    );
    assert.throws(
      () => service.createAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-b",
        submissionPeriodId: "period-2026-09",
        sourceVersionId: confirmed.id,
        reason: "Wrong family source",
        changes: [{ childId: "child-b1", date: "2026-09-01", usageStatus: "off" }],
      }),
      (error) => error.code === "EFFECTIVE_VERSION_CHANGED",
    );
    assert.notEqual(familyBSubmitted.id, confirmed.id);
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        reason: "Outside target month",
        changes: [{ childId: "child-a1", date: "2026-10-01", usageStatus: "off" }],
      }),
      (error) => error.code === "INVALID_DATE",
    );
    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'draft', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-10",
        reason: "Draft period",
        changes: [{ childId: "child-a1", date: "2026-10-01", usageStatus: "off" }],
      }),
      (error) => error.code === "PERIOD_NOT_REVIEWABLE",
    );
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        reason: "Invalid time",
        changes: [{ childId: "child-a1", date: "2026-09-02", usageStatus: "using", arrivalTime: "08:32", departureTime: "17:30" }],
      }),
      (error) => error.code === "INVALID_TIME",
    );
    assert.throws(
      () => service.previewAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        reason: "Locked day",
        changes: [{ childId: "child-a1", date: "2026-09-21", usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" }],
      }),
      (error) => error.code === "LOCKED_DAY",
    );

    const preview = service.previewAdministratorRevision(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: "Parent requested a correction after submission",
      changes,
    });
    assert.equal(preview.sourceVersionId, confirmed.id);
    assert.equal(preview.changedDateCount, 3);
    assert.deepEqual(preview.changes.map((change) => [change.childId, change.date]), [
      ["child-a1", "2026-09-01"],
      ["child-a1", "2026-09-02"],
      ["child-a1", "2026-09-05"],
    ]);
    assert.deepEqual(preview.changes[0].before, {
      date: "2026-09-01",
      usageStatus: "using",
      arrivalTime: "08:30",
      departureTime: "17:30",
    });
    assert.deepEqual(preview.changes[0].after, {
      date: "2026-09-01",
      usageStatus: "off",
      arrivalTime: null,
      departureTime: null,
    });
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'",
    ).get().count, versionCountBeforePreview);

    clock.value = new Date("2026-08-30T00:00:00.000Z");
    database.prepare("UPDATE submission_periods SET status = 'closed' WHERE id = 'period-2026-09'").run();
    const revision = service.createAdministratorRevision(fixture.actorAdmin, {
      ...preview,
      changes,
    });
    assert.equal(revision.sequenceNumber, 3);
    assert.equal(revision.versionType, "administrator_revision");
    assert.equal(revision.reviewStatus, "confirmed");
    assert.equal(revision.sourceVersionId, confirmed.id);
    assert.equal(revision.createdByAdministratorId, fixture.actorAdmin.id);
    assert.equal(revision.confirmedByAdministratorId, fixture.actorAdmin.id);
    assert.equal(revision.reason, preview.reason);
    assert.equal(revision.changeSummary.changedDateCount, 3);
    assert.equal(revision.changeSummary.revisionVersionId, revision.id);
    assert.equal(revision.copied.childCount, 2);
    assert.equal(revision.copied.dayCount, 60);

    const revisionPayload = submissionVersionPayload(database, revision.id);
    assert.deepEqual(revisionPayload.children, confirmedPayload.children);
    const changedKeys = [];
    for (let index = 0; index < confirmedPayload.days.length; index += 1) {
      const before = confirmedPayload.days[index];
      const after = revisionPayload.days[index];
      assert.equal(after.child_id, before.child_id);
      assert.equal(after.date, before.date);
      if (JSON.stringify(after) !== JSON.stringify(before)) changedKeys.push(`${after.child_id}:${after.date}`);
    }
    assert.deepEqual(changedKeys, [
      "child-a1:2026-09-01",
      "child-a1:2026-09-02",
      "child-a1:2026-09-05",
    ]);
    const revisedDays = new Map(revisionPayload.days.map((day) => [`${day.child_id}:${day.date}`, day]));
    assert.deepEqual(
      {
        usageStatus: revisedDays.get("child-a1:2026-09-01").usage_status,
        arrivalTime: revisedDays.get("child-a1:2026-09-01").arrival_time,
        departureTime: revisedDays.get("child-a1:2026-09-01").departure_time,
      },
      { usageStatus: "off", arrivalTime: null, departureTime: null },
    );
    assert.deepEqual(
      {
        usageStatus: revisedDays.get("child-a1:2026-09-05").usage_status,
        arrivalTime: revisedDays.get("child-a1:2026-09-05").arrival_time,
        departureTime: revisedDays.get("child-a1:2026-09-05").departure_time,
      },
      { usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" },
    );
    assert.ok(revisionPayload.days.filter((day) => day.child_id === "child-a2")
      .every((day, index) => JSON.stringify(day) === JSON.stringify(confirmedPayload.days.filter((entry) => entry.child_id === "child-a2")[index])));
    assert.deepEqual(rawSubmissionVersion(database, confirmed.id), confirmedRaw);
    assert.deepEqual(mutableSchedulePayload(database, "family-a", "period-2026-09"), mutableBefore);

    let pointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    assert.deepEqual({ ...pointers }, {
      latest_submitted_version_id: submitted.id,
      latest_confirmed_version_id: revision.id,
      latest_effective_version_id: revision.id,
    });
    const operation = database.prepare(
      `SELECT actor_type, actor_id, target_type, target_id, target_month, detail_json
       FROM operation_logs WHERE operation = 'family_submission.revised'`,
    ).get();
    assert.equal(operation.actor_type, "administrator");
    assert.equal(operation.actor_id, fixture.actorAdmin.id);
    assert.equal(operation.target_type, "family_submission");
    assert.equal(operation.target_id, revision.familySubmissionId);
    assert.equal(operation.target_month, "2026-09");
    assert.deepEqual(JSON.parse(operation.detail_json), revision.changeSummary);

    const versionCountAfterRevision = database.prepare(
      "SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'",
    ).get().count;
    assert.throws(
      () => service.createAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        sourceVersionId: revision.id,
        reason: "No actual change",
        changes: [{ childId: "child-a1", date: "2026-09-01", usageStatus: "off" }],
      }),
      (error) => error.code === "NO_CHANGES",
    );
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'",
    ).get().count, versionCountAfterRevision);
    assert.throws(
      () => service.createAdministratorRevision(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        sourceVersionId: confirmed.id,
        reason: "Stale preview",
        changes: [{ childId: "child-a1", date: "2026-09-01", usageStatus: "using", arrivalTime: "08:30", departureTime: "17:30" }],
      }),
      (error) => error.code === "EFFECTIVE_VERSION_CHANGED" && error.status === 409,
    );

    const secondPreview = service.previewAdministratorRevision(fixture.actorMaster, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: "Second administrator correction",
      changes: [{ childId: "child-a1", date: "2026-09-01", usageStatus: "using", arrivalTime: "08:30", departureTime: "17:30" }],
    });
    const revisionRaw = rawSubmissionVersion(database, revision.id);
    const secondRevision = service.createAdministratorRevision(fixture.actorMaster, {
      ...secondPreview,
      changes: [{ childId: "child-a1", date: "2026-09-01", usageStatus: "using", arrivalTime: "08:30", departureTime: "17:30" }],
    });
    assert.equal(secondRevision.sequenceNumber, 4);
    assert.equal(secondRevision.sourceVersionId, revision.id);
    assert.equal(secondRevision.createdByAdministratorId, fixture.actorMaster.id);
    assert.deepEqual(rawSubmissionVersion(database, revision.id), revisionRaw);
    pointers = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    assert.deepEqual({ ...pointers }, {
      latest_submitted_version_id: submitted.id,
      latest_confirmed_version_id: secondRevision.id,
      latest_effective_version_id: secondRevision.id,
    });
  });
});

test("rolls back an administrator revision when final audit logging fails", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    service.dashboard(fixture.actorA);
    service.submitFamilySchedules(fixture.actorA);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const confirmed = service.confirmLatestFamilySubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    const confirmedRaw = rawSubmissionVersion(database, confirmed.id);
    const mutableBefore = mutableSchedulePayload(database, "family-a", "period-2026-09");
    const pointersBefore = database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id, last_updated_at
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get();
    const preview = service.previewAdministratorRevision(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: "Rollback test",
      changes: [{ childId: "child-a1", date: "2026-09-01", usageStatus: "off" }],
    });
    database.exec(`
      CREATE TEMP TRIGGER fail_revision_for_test
      BEFORE INSERT ON operation_logs
      WHEN NEW.operation = 'family_submission.revised'
      BEGIN
        SELECT RAISE(ABORT, 'forced revision failure');
      END
    `);

    assert.throws(
      () => service.createAdministratorRevision(fixture.actorAdmin, {
        ...preview,
        changes: [{ childId: "child-a1", date: "2026-09-01", usageStatus: "off" }],
      }),
      /forced revision failure/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'").get().count, 2);
    assert.equal(database.prepare(
      `SELECT COUNT(*) AS count FROM family_submission_version_children c
       JOIN family_submission_versions v ON v.id = c.version_id WHERE v.family_id = 'family-a'`,
    ).get().count, 4);
    assert.equal(database.prepare(
      `SELECT COUNT(*) AS count FROM family_submission_version_days d
       JOIN family_submission_version_children c ON c.id = d.version_child_id
       JOIN family_submission_versions v ON v.id = c.version_id WHERE v.family_id = 'family-a'`,
    ).get().count, 120);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'family_submission.revised'").get().count, 0);
    assert.deepEqual(rawSubmissionVersion(database, confirmed.id), confirmedRaw);
    assert.deepEqual(mutableSchedulePayload(database, "family-a", "period-2026-09"), mutableBefore);
    assert.deepEqual({ ...database.prepare(
      `SELECT latest_submitted_version_id, latest_confirmed_version_id, latest_effective_version_id, last_updated_at
       FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'`,
    ).get() }, { ...pointersBefore });
    assert.equal(submitted.id, pointersBefore.latest_submitted_version_id);
  });
});

test("does not lock drafts by deadline and keeps explicitly closed periods read-only", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.editable, true);

    clock.value = new Date("2026-08-25T15:00:00.000Z");
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.editable, true);
    assert.equal(dashboard.submission.displayStatus, "未提出");
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off" }),
    });
    assert.equal(dashboard.children.find((child) => child.id === "child-a1").schedule.days.find((day) => day.date === "2026-09-01").usageStatus, "off");

    clock.value = new Date("2026-08-20T00:00:00.000Z");
    database.prepare("UPDATE submission_periods SET status = 'closed' WHERE id = 'period-2026-09'").run();
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.editable, false);
    assert.throws(
      () => service.submitFamilySchedules(fixture.actorA),
      (error) => error.code === "SUBMISSION_LOCKED",
    );
  });
});

test("uses one access decision for global deadlines, family extensions, boundaries, and closed periods", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    let dashboardA = service.dashboard(fixture.actorA);
    const dashboardB = service.dashboard(fixture.actorB);

    clock.value = new Date("2026-08-25T14:59:59.000Z");
    dashboardA = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboardA, "child-a1", "2026-09-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboardA.period.editable, true);
    dashboardA = service.submitFamilySchedules(fixture.actorA);
    assert.equal(dashboardA.submission.status, "submitted");

    clock.value = new Date("2026-08-25T14:59:59.001Z");
    assert.equal(service.dashboard(fixture.actorA).period.editable, false);
    assert.throws(() => service.submitFamilySchedules(fixture.actorA), (error) => error.code === "SUBMISSION_LOCKED");
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", {
        days: daysWithPatch(dashboardA, "child-a1", "2026-09-02", { usageStatus: "off", arrivalTime: null, departureTime: null }),
      }),
      (error) => error.code === "SUBMISSION_LOCKED",
    );
    assert.throws(
      () => service.applyBasicUsagePattern(fixture.actorA, "child-a1"),
      (error) => error.code === "SUBMISSION_LOCKED",
    );
    assert.throws(
      () => service.copyChildScheduleToSiblings(fixture.actorA, "child-a1"),
      (error) => error.code === "SUBMISSION_LOCKED",
    );
    assert.throws(
      () => service.setFamilyDeadlineExtension(fixture.actorA, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        extendedDeadlineAt: "2026-08-27T14:59:59.000Z",
        reason: "権限拒否確認",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    assert.throws(
      () => service.setFamilyDeadlineExtension(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
        extendedDeadlineAt: "2026-08-25T14:59:58.000Z",
        reason: "不正期限確認",
      }),
      (error) => error.code === "INVALID_DEADLINE_EXTENSION",
    );

    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'draft', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-10",
      extendedDeadlineAt: "2026-09-27T14:59:59.000Z",
      reason: "別期間への延長",
    });
    assert.equal(service.dashboard(fixture.actorA).period.editable, false);

    const created = service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      extendedDeadlineAt: "2026-08-27T14:59:59.000Z",
      reason: "家庭事情による延長",
    });
    const updated = service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      extendedDeadlineAt: "2026-08-28T14:59:59.000Z",
      reason: "確認日変更による再延長",
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.extendedDeadlineAt, "2026-08-28T14:59:59.000Z");
    assert.equal(updated.administratorId, fixture.actorAdmin.id);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_deadline_extensions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'",
    ).get().count, 1);
    assert.equal(service.dashboard(fixture.actorA).period.editable, false);
    service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-b",
      submissionPeriodId: "period-2026-09",
      extendedDeadlineAt: "2026-08-28T14:59:59.000Z",
      reason: "別家庭への延長",
    });
    database.prepare("UPDATE families SET status = 'stopped' WHERE id = 'family-b'").run();
    assert.equal(service.dashboard(fixture.actorB).period.editable, false);
    assert.deepEqual(dashboardB.children.map((child) => child.id), ["child-b1"]);

    clock.value = new Date("2026-08-28T14:59:59.000Z");
    service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    dashboardA = service.dashboard(fixture.actorA);
    dashboardA = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboardA, "child-a1", "2026-09-01", { usageStatus: "using", arrivalTime: "08:30", departureTime: "17:30" }),
    });
    assert.equal(dashboardA.period.editable, true);
    dashboardA = service.submitFamilySchedules(fixture.actorA);
    assert.equal(dashboardA.submission.status, "submitted");
    assert.equal(service.latestSubmittedVersion(fixture.actorA).sequenceNumber, 2);

    clock.value = new Date("2026-08-28T14:59:59.001Z");
    assert.equal(service.dashboard(fixture.actorA).period.editable, false);
    assert.throws(() => service.submitFamilySchedules(fixture.actorA), (error) => error.code === "SUBMISSION_LOCKED");

    clock.value = new Date("2026-08-27T00:00:00.000Z");
    database.prepare("UPDATE submission_periods SET status = 'closed' WHERE id = 'period-2026-09'").run();
    assert.equal(service.dashboard(fixture.actorA).period.editable, false);
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: dashboardA.children[0].schedule.days }),
      (error) => error.code === "SUBMISSION_LOCKED",
    );

    const extensionOperations = database.prepare(
      `SELECT actor_type, actor_id, operation
       FROM operation_logs
       WHERE target_type = 'family_deadline_extension'
       ORDER BY occurred_at, rowid`,
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(extensionOperations, [
      { actor_type: "administrator", actor_id: "normal-admin", operation: "family_deadline_extension.created" },
      { actor_type: "administrator", actor_id: "normal-admin", operation: "family_deadline_extension.created" },
      { actor_type: "administrator", actor_id: "normal-admin", operation: "family_deadline_extension.updated" },
      { actor_type: "administrator", actor_id: "normal-admin", operation: "family_deadline_extension.created" },
    ]);
  });
});

test("requires an administrator grant before creating a new immutable resubmission version", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    let dashboard = service.dashboard(fixture.actorA);
    dashboard = service.submitFamilySchedules(fixture.actorA);
    const firstVersion = service.latestSubmittedVersion(fixture.actorA);
    const firstSnapshot = rawSubmissionVersion(database, firstVersion.id);
    const firstUsage = service.administratorScheduleDashboard(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).monthlyUsageSummaries.find((child) => child.childId === "child-a1");

    clock.value = new Date("2026-08-26T00:00:00.000Z");
    service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      extendedDeadlineAt: "2026-08-27T14:59:59.000Z",
      reason: "再提出のための延長",
    });
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", {
        days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "off", arrivalTime: null, departureTime: null }),
      }),
      (error) => error.code === "SUBMISSION_LOCKED",
    );
    assert.throws(() => service.applyBasicUsagePattern(fixture.actorA, "child-a1"), (error) => error.code === "SUBMISSION_LOCKED");
    assert.throws(() => service.copyChildScheduleToSiblings(fixture.actorA, "child-a1"), (error) => error.code === "SUBMISSION_LOCKED");
    assert.throws(
      () => service.allowFamilyResubmission(fixture.actorA, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    const permission = service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(permission.submittedVersionId, firstVersion.id);
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.editable, true);
    assert.equal(dashboard.submission.resubmissionAllowed, true);
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboard.submission.revisionRequired, true);

    service.submitFamilySchedules(fixture.actorA);
    const secondVersion = service.latestSubmittedVersion(fixture.actorA);
    assert.equal(secondVersion.sequenceNumber, 2);
    assert.equal(secondVersion.sourceVersionId, firstVersion.id);
    assert.notEqual(secondVersion.id, firstVersion.id);
    assert.equal(
      secondVersion.children.find((child) => child.childId === "child-a1")
        .days.find((day) => day.date === "2026-09-02").usageStatus,
      "off",
    );
    assert.deepEqual(service.latestSubmittedVersion(fixture.actorA).id, secondVersion.id);
    assert.deepEqual(rawSubmissionVersion(database, firstVersion.id), firstSnapshot);
    const resubmittedUsage = service.administratorScheduleDashboard(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).monthlyUsageSummaries.find((child) => child.childId === "child-a1");
    assert.equal(resubmittedUsage.usageDays, firstUsage.usageDays - 1);
    assert.equal(resubmittedUsage.totalMinutes, firstUsage.totalMinutes - (9 * 60));
    const locked = service.dashboard(fixture.actorA);
    assert.equal(locked.period.editable, false);
    assert.equal(locked.submission.resubmissionAllowed, false);
    assert.equal(database.prepare(
      "SELECT resubmission_allowed_for_version_id FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'",
    ).get().resubmission_allowed_for_version_id, null);
    assert.throws(() => service.submitFamilySchedules(fixture.actorA), (error) => error.code === "SUBMISSION_LOCKED");
    const grantLog = database.prepare(
      "SELECT actor_id, detail_json FROM operation_logs WHERE operation = 'family_submission.resubmission_allowed'",
    ).get();
    assert.equal(grantLog.actor_id, fixture.actorAdmin.id);
    assert.equal(JSON.parse(grantLog.detail_json).submittedVersionId, firstVersion.id);
  });
});

test("starts an allowed resubmission from the current effective version and rolls back failed grants", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    service.dashboard(fixture.actorA);
    service.submitFamilySchedules(fixture.actorA);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const submittedRaw = rawSubmissionVersion(database, submitted.id);
    const preview = service.previewAdministratorRevision(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: "保護者からの連絡により修正",
      changes: [{ childId: "child-a1", date: "2026-09-02", usageStatus: "off" }],
    });
    const revision = service.createAdministratorRevision(fixture.actorAdmin, {
      ...preview,
      changes: [{ childId: "child-a1", date: "2026-09-02", usageStatus: "off" }],
    });
    const revisionRaw = rawSubmissionVersion(database, revision.id);
    const mutableBeforeGrant = mutableSchedulePayload(database, "family-a", "period-2026-09");

    database.exec(`
      CREATE TEMP TRIGGER fail_resubmission_grant_for_test
      BEFORE INSERT ON operation_logs
      WHEN NEW.operation = 'family_submission.resubmission_allowed'
      BEGIN
        SELECT RAISE(ABORT, 'forced resubmission grant failure');
      END
    `);
    assert.throws(
      () => service.allowFamilyResubmission(fixture.actorAdmin, {
        familyId: "family-a",
        submissionPeriodId: "period-2026-09",
      }),
      /forced resubmission grant failure/,
    );
    assert.deepEqual(mutableSchedulePayload(database, "family-a", "period-2026-09"), mutableBeforeGrant);
    assert.equal(database.prepare(
      "SELECT resubmission_allowed_for_version_id FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'",
    ).get().resubmission_allowed_for_version_id, null);
    database.exec("DROP TRIGGER fail_resubmission_grant_for_test");

    const grant = service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(grant.sourceVersionId, revision.id);
    const dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.children.find((child) => child.id === "child-a1")
      .schedule.days.find((day) => day.date === "2026-09-02").usageStatus, "off");
    assert.deepEqual(rawSubmissionVersion(database, submitted.id), submittedRaw);
    assert.deepEqual(rawSubmissionVersion(database, revision.id), revisionRaw);
    assert.equal(service.allowFamilyResubmission(fixture.actorMaster, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    }).idempotent, true);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'family_submission.resubmission_allowed'",
    ).get().count, 1);
  });
});

test("uses the Tokyo suggested month by default and validates explicitly selected months", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'open', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();

    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.id, "period-2026-09");
    assert.throws(() => service.updateChildSchedule(fixture.actorA, "child-a1", {
      submissionPeriodId: "period-2026-10",
      days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    }), (error) => error.code === "INVALID_DATE");

    dashboard = service.dashboard(fixture.actorA, { submissionPeriodId: "period-2026-10" });
    assert.equal(dashboard.period.id, "period-2026-10");
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      submissionPeriodId: "period-2026-10",
      days: daysWithPatch(dashboard, "child-a1", "2026-10-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboard.period.id, "period-2026-10");
    service.submitFamilySchedules(fixture.actorA, { submissionPeriodId: "period-2026-10" });
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-10'",
    ).get().count, 1);
    assert.throws(
      () => service.setParentTargetPeriod(fixture.actorA, { submissionPeriodId: "period-2026-10" }),
      (error) => error.code === "FORBIDDEN",
    );

    const switched = service.setParentTargetPeriod(fixture.actorAdmin, { submissionPeriodId: "period-2026-10" });
    assert.equal(switched.submissionPeriodId, "period-2026-10");
    assert.equal(switched.idempotent, false);
    assert.deepEqual(switched.previousSubmissionPeriodIds, ["period-2026-09"]);
    assert.deepEqual(database.prepare(
      "SELECT id, is_parent_target FROM submission_periods ORDER BY target_month",
    ).all().map((row) => ({ ...row })), [
      { id: "period-2026-09", is_parent_target: 0 },
      { id: "period-2026-10", is_parent_target: 1 },
    ]);
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.id, "period-2026-09");
    assert.equal(dashboard.period.editable, true);

    const operation = database.prepare(
      `SELECT actor_type, actor_id, target_type, target_id, target_month, detail_json
       FROM operation_logs WHERE operation = 'submission_period.parent_target_changed'`,
    ).get();
    assert.equal(operation.actor_type, "administrator");
    assert.equal(operation.actor_id, fixture.actorAdmin.id);
    assert.equal(operation.target_type, "submission_period");
    assert.equal(operation.target_id, "period-2026-10");
    assert.equal(operation.target_month, "2026-10");
    assert.deepEqual(JSON.parse(operation.detail_json), {
      administratorId: fixture.actorAdmin.id,
      previousSubmissionPeriodIds: ["period-2026-09"],
      newSubmissionPeriodId: "period-2026-10",
      performedAt: "2026-08-20T00:00:00.000Z",
    });

    database.prepare("UPDATE submission_periods SET status = 'closed' WHERE id = 'period-2026-10'").run();
    dashboard = service.dashboard(fixture.actorA, { submissionPeriodId: "period-2026-10" });
    assert.equal(dashboard.available, true);
    assert.equal(dashboard.period.id, "period-2026-10");
    assert.equal(dashboard.period.editable, false);
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", {
        submissionPeriodId: "period-2026-10",
        days: daysWithPatch(dashboard, "child-a1", "2026-10-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
      }),
      (error) => error.code === "SUBMISSION_LOCKED",
    );

    database.exec(`
      CREATE TEMP TRIGGER fail_parent_target_switch_for_test
      BEFORE INSERT ON operation_logs
      WHEN NEW.operation = 'submission_period.parent_target_changed'
      BEGIN
        SELECT RAISE(ABORT, 'forced parent target switch failure');
      END
    `);
    assert.throws(
      () => service.setParentTargetPeriod(fixture.actorMaster, { submissionPeriodId: "period-2026-09" }),
      /forced parent target switch failure/,
    );
    assert.deepEqual(database.prepare(
      "SELECT id, is_parent_target FROM submission_periods ORDER BY target_month",
    ).all().map((row) => ({ ...row })), [
      { id: "period-2026-09", is_parent_target: 0 },
      { id: "period-2026-10", is_parent_target: 1 },
    ]);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'submission_period.parent_target_changed'",
    ).get().count, 1);
  });
});

test("switches the initially displayed month at midnight Japan time on the fifteenth", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    for (const [id, targetMonth] of [["period-2026-08", "2026-08"], ["period-2026-10", "2026-10"]]) {
      database.prepare(
        `INSERT INTO submission_periods
         (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
         VALUES (?, ?, '2099-12-31T14:59:59.000Z', 'open', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(id, targetMonth);
    }

    clock.value = new Date("2026-08-14T14:59:59.999Z");
    assert.equal(service.dashboard(fixture.actorA).period.targetMonth, "2026-08");

    clock.value = new Date("2026-08-14T15:00:00.000Z");
    assert.equal(service.dashboard(fixture.actorA).period.targetMonth, "2026-09");

    clock.value = new Date("2026-09-14T15:00:00.000Z");
    assert.equal(service.dashboard(fixture.actorA).period.targetMonth, "2026-10");
    const previousMonth = service.dashboard(fixture.actorA, { submissionPeriodId: "period-2026-09" });
    assert.equal(previousMonth.period.targetMonth, "2026-09");
    assert.equal(previousMonth.period.editable, true);
  });
});

test("uses split child identity and inclusive enrollment periods consistently", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    database.prepare(
      `UPDATE children
       SET last_name = '山田', first_name = 'はると',
           last_name_kana = 'ヤマダ', first_name_kana = 'ハルト',
           birth_date = '2025-06-10', enrollment_date = '2026-09-15', withdrawal_date = '2026-09-18'
       WHERE id = 'child-a1'`,
    ).run();
    database.prepare(
      `UPDATE children
       SET kana = 'カクウエンジエーツー', birth_date = '2024-04-02',
           enrollment_date = '2026-09-01', withdrawal_date = '2026-09-30', status = 'withdrawn'
       WHERE id = 'child-a2'`,
    ).run();
    database.prepare(
      `INSERT INTO children
       (id, child_code, name, kana, class_name, birth_date, enrollment_date, status, created_at, updated_at)
       VALUES ('child-a3', 'DEMO-CHILD-A3', 'Future Child', 'フューチャーチャイルド', 'Future Class',
               '2025-01-01', '2026-10-01', 'enrolled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    database.prepare(
      `INSERT INTO family_children
       (family_id, child_id, relationship_label, is_primary, sort_order, active_from, created_at)
       VALUES ('family-a', 'child-a3', 'Test guardian', 1, 3, '2026-10-01', CURRENT_TIMESTAMP)`,
    ).run();
    database.prepare(
      `INSERT INTO children
       (id, child_code, name, kana, class_name, birth_date, enrollment_date, status, created_at, updated_at)
       VALUES ('child-a4', 'DEMO-CHILD-A4', 'Membership Child', 'メンバーシップチャイルド', 'Test Class',
               '2025-02-01', '2026-09-01', 'enrolled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    database.prepare(
      `INSERT INTO family_children
       (family_id, child_id, relationship_label, is_primary, sort_order, active_from, active_to, created_at)
       VALUES ('family-a', 'child-a4', 'Test guardian', 1, 4, '2026-09-10', '2026-09-11', CURRENT_TIMESTAMP)`,
    ).run();
    for (let weekday = 1; weekday <= 6; weekday += 1) {
      database.prepare(
        `INSERT INTO basic_usage_patterns
         (id, child_id, weekday, enabled, arrival_time, departure_time, valid_from, created_at, updated_at)
         VALUES (?, 'child-a4', ?, ?, '08:30', '17:30', '2026-09-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(`child-a4-pattern-${weekday}`, weekday, weekday <= 5 ? 1 : 0);
    }

    let dashboard = service.dashboard(fixture.actorA);
    assert.deepEqual(dashboard.children.map((child) => child.id), ["child-a1", "child-a2", "child-a4"]);
    const splitChild = dashboard.children.find((child) => child.id === "child-a1");
    const legacyChild = dashboard.children.find((child) => child.id === "child-a2");
    assert.equal(splitChild.name, "山田 はると");
    assert.equal(splitChild.kana, "ヤマダ ハルト");
    assert.equal(splitChild.birthDate, "2025-06-10");
    assert.equal(splitChild.enrollmentDate, "2026-09-15");
    assert.equal(splitChild.withdrawalDate, "2026-09-18");
    assert.equal(legacyChild.name, "架空園児A2");
    assert.equal(legacyChild.kana, "カクウエンジエーツー");
    assert.equal(splitChild.schedule.days.find((day) => day.date === "2026-09-14").usageStatus, "not_enrolled");
    assert.equal(splitChild.schedule.days.find((day) => day.date === "2026-09-15").usageStatus, "using");
    assert.equal(splitChild.schedule.days.find((day) => day.date === "2026-09-18").usageStatus, "using");
    assert.equal(splitChild.schedule.days.find((day) => day.date === "2026-09-19").usageStatus, "not_enrolled");
    assert.equal(legacyChild.schedule.days.find((day) => day.date === "2026-09-01").usageStatus, "using");
    assert.equal(legacyChild.schedule.days.find((day) => day.date === "2026-09-30").usageStatus, "using");
    const membershipChild = dashboard.children.find((child) => child.id === "child-a4");
    assert.equal(membershipChild.schedule.days.find((day) => day.date === "2026-09-09").usageStatus, "not_enrolled");
    assert.equal(membershipChild.schedule.days.find((day) => day.date === "2026-09-10").usageStatus, "using");
    assert.equal(membershipChild.schedule.days.find((day) => day.date === "2026-09-11").usageStatus, "using");
    assert.equal(membershipChild.schedule.days.find((day) => day.date === "2026-09-12").usageStatus, "not_enrolled");
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", {
        days: daysWithPatch(dashboard, "child-a1", "2026-09-14", { usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" }),
      }),
      (error) => error.code === "LOCKED_DAY",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", {
        days: daysWithPatch(dashboard, "child-a1", "2026-09-19", { usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" }),
      }),
      (error) => error.code === "LOCKED_DAY",
    );
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a3", { days: splitChild.schedule.days }),
      (error) => error.code === "CHILD_SCOPE_VIOLATION",
    );

    dashboard = service.updateChildSchedule(fixture.actorA, "child-a2", {
      days: daysWithPatch(dashboard, "child-a2", "2026-09-16", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    dashboard = service.copyChildScheduleToSiblings(fixture.actorA, "child-a2");
    assert.equal(
      dashboard.children.find((child) => child.id === "child-a1")
        .schedule.days.find((day) => day.date === "2026-09-16").usageStatus,
      "off",
    );
    assert.equal(
      dashboard.children.find((child) => child.id === "child-a1")
        .schedule.days.find((day) => day.date === "2026-09-14").usageStatus,
      "not_enrolled",
    );

    service.submitFamilySchedules(fixture.actorA);
    const firstSubmitted = service.latestSubmittedVersion(fixture.actorA);
    const firstChildSnapshot = firstSubmitted.children.find((child) => child.childId === "child-a1");
    const legacyChildSnapshot = firstSubmitted.children.find((child) => child.childId === "child-a2");
    assert.deepEqual(firstSubmitted.children.map((child) => child.childId).sort(), ["child-a1", "child-a2", "child-a4"]);
    assert.equal(firstChildSnapshot.name, "山田 はると");
    assert.equal(firstChildSnapshot.kana, "ヤマダ ハルト");
    assert.equal(firstChildSnapshot.lastName, "山田");
    assert.equal(firstChildSnapshot.firstName, "はると");
    assert.equal(firstChildSnapshot.birthDate, "2025-06-10");
    assert.equal(firstChildSnapshot.enrollmentDate, "2026-09-15");
    assert.equal(firstChildSnapshot.withdrawalDate, "2026-09-18");
    assert.equal(legacyChildSnapshot.name, "架空園児A2");
    assert.equal(legacyChildSnapshot.kana, "カクウエンジエーツー");
    assert.equal(firstChildSnapshot.days.find((day) => day.date === "2026-09-14").usageStatus, "not_enrolled");
    assert.equal(firstChildSnapshot.days.find((day) => day.date === "2026-09-18").usageStatus, "using");
    assert.equal(firstChildSnapshot.days.find((day) => day.date === "2026-09-19").usageStatus, "not_enrolled");

    const submittedRaw = rawSubmissionVersion(database, firstSubmitted.id);
    const confirmed = service.confirmLatestFamilySubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    const confirmedRaw = rawSubmissionVersion(database, confirmed.id);
    const preview = service.previewAdministratorRevision(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: "Correct one enrolled day",
      changes: [{ childId: "child-a1", date: "2026-09-17", usageStatus: "off" }],
    });
    const revision = service.createAdministratorRevision(fixture.actorAdmin, {
      ...preview,
      changes: [{ childId: "child-a1", date: "2026-09-17", usageStatus: "off" }],
    });
    const revisionRaw = rawSubmissionVersion(database, revision.id);
    database.prepare(
      `UPDATE children
       SET last_name = '佐藤', first_name = 'みらい',
           last_name_kana = 'サトウ', first_name_kana = 'ミライ'
       WHERE id = 'child-a1'`,
    ).run();
    service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    service.submitFamilySchedules(fixture.actorA);
    const secondSubmitted = service.latestSubmittedVersion(fixture.actorA);
    assert.equal(secondSubmitted.children.find((child) => child.childId === "child-a1").name, "佐藤 みらい");
    assert.deepEqual(rawSubmissionVersion(database, firstSubmitted.id), submittedRaw);
    assert.deepEqual(rawSubmissionVersion(database, confirmed.id), confirmedRaw);
    assert.deepEqual(rawSubmissionVersion(database, revision.id), revisionRaw);
  });
});

test("excludes draft months and safely supports multiple selectable parent months", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    database.prepare("UPDATE submission_periods SET status = 'draft' WHERE id = 'period-2026-09'").run();
    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, false);
    assert.equal(dashboard.periodCount, 0);

    database.prepare("UPDATE submission_periods SET status = 'open', is_parent_target = 0 WHERE id = 'period-2026-09'").run();
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, true);
    assert.equal(dashboard.period.id, "period-2026-09");

    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'open', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, true);
    assert.equal(dashboard.period.id, "period-2026-09");
    assert.deepEqual(dashboard.periods.map((period) => period.targetMonth), ["2026-09", "2026-10"]);
    assert.equal(service.dashboard(fixture.actorA, { submissionPeriodId: "period-2026-10" }).period.id, "period-2026-10");
    const unavailable = service.dashboard(fixture.actorA, { submissionPeriodId: "period-other-family" });
    assert.equal(unavailable.available, false);
    assert.match(unavailable.message, /指定された利用予定月/);
  });
});

test("connects administrator schedule APIs without exposing them to family sessions", async () => {
  await withScheduleDatabase(async ({ database, service, authService, fixture }) => {
    service.dashboard(fixture.actorA);
    service.submitFamilySchedules(fixture.actorA);
    const family = await familySession(authService, "demo-family-a", fixture.passwords.familyA);
    const administrator = await administratorSession(authService, "demo-schedule-admin", fixture.passwords.administrator);

    const forbidden = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules", family),
      { service, authService },
    );
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, "FORBIDDEN");
    const familyGrant = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/allow-resubmission", family, {
        method: "POST",
        body: { familyId: "family-a", submissionPeriodId: "period-2026-09" },
      }),
      { service, authService },
    );
    assert.equal(familyGrant.status, 403);
    assert.equal((await familyGrant.json()).code, "FORBIDDEN");

    const missingCsrf = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/confirm", administrator, {
        method: "POST",
        csrf: false,
        body: { familyId: "family-a", submissionPeriodId: "period-2026-09" },
      }),
      { service, authService },
    );
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).code, "CSRF_INVALID");

    const dashboardResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules?submissionPeriodId=period-2026-09&familyId=family-a", administrator),
      { service, authService },
    );
    assert.equal(dashboardResponse.status, 200);
    const adminDashboard = (await dashboardResponse.json()).dashboard;
    assert.equal(adminDashboard.selectedFamily.id, "family-a");
    assert.equal(adminDashboard.selectedFamily.submissionState, "submitted");
    assert.equal(adminDashboard.latestSubmittedVersion.children.length, 2);
    assert.ok(!JSON.stringify(adminDashboard).toLowerCase().includes("password"));
    assert.ok(!JSON.stringify(adminDashboard).toLowerCase().includes("birthdate"));
    assert.ok(!JSON.stringify(adminDashboard).toLowerCase().includes("kana"));

    const forbiddenClosure = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/closure-day", family, {
        method: "POST",
        body: { targetMonth: "2026-09", date: "2026-09-22" },
      }),
      { service, authService },
    );
    assert.equal(forbiddenClosure.status, 403);
    const closureResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/closure-day", administrator, {
        method: "POST",
        body: { targetMonth: "2026-09", date: "2026-09-22" },
      }),
      { service, authService },
    );
    assert.equal(closureResponse.status, 201);
    assert.equal((await closureResponse.json()).result.name, "休園日");

    const extensionResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/deadline-extension", administrator, {
        method: "PUT",
        body: {
          familyId: "family-a",
          submissionPeriodId: "period-2026-09",
          extendedDeadlineAt: "2026-08-30T14:59:59.000Z",
          reason: "架空の手動確認用延長",
        },
      }),
      { service, authService },
    );
    assert.equal(extensionResponse.status, 200);
    const parentWithExtension = service.dashboard(fixture.actorA);
    assert.equal(parentWithExtension.period.extensionActive, false);
    assert.equal(parentWithExtension.period.deadlineSource, null);
    assert.equal(parentWithExtension.period.editable, false);

    const confirmResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/confirm", administrator, {
        method: "POST",
        body: { familyId: "family-a", submissionPeriodId: "period-2026-09" },
      }),
      { service, authService },
    );
    assert.equal(confirmResponse.status, 200);
    const confirmed = (await confirmResponse.json()).result;
    assert.equal(confirmed.changeSummary.kind, "confirmation");
    assert.equal(service.dashboard(fixture.actorA).submission.schoolModified, false);

    const changes = [{ childId: "child-a1", date: "2026-09-01", usageStatus: "off", arrivalTime: null, departureTime: null }];
    const previewResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/revision/preview", administrator, {
        method: "POST",
        body: { familyId: "family-a", submissionPeriodId: "period-2026-09", reason: "架空の変更連絡", changes },
      }),
      { service, authService },
    );
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).result;
    assert.equal(preview.changedDateCount, 1);
    assert.equal(preview.changes[0].childId, "child-a1");

    const revisionResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/revision", administrator, {
        method: "POST",
        body: {
          familyId: "family-a",
          submissionPeriodId: "period-2026-09",
          sourceVersionId: preview.sourceVersionId,
          reason: preview.reason,
          changes,
        },
      }),
      { service, authService },
    );
    assert.equal(revisionResponse.status, 200);
    const revision = (await revisionResponse.json()).result;
    assert.deepEqual(revision.changeSummary.changes, preview.changes);
    assert.equal(service.dashboard(fixture.actorA).submission.schoolModified, true);

    const repeatConfirmResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/confirm", administrator, {
        method: "POST",
        body: { familyId: "family-a", submissionPeriodId: "period-2026-09" },
      }),
      { service, authService },
    );
    assert.equal(repeatConfirmResponse.status, 200);
    const repeatConfirmation = (await repeatConfirmResponse.json()).result;
    assert.equal(repeatConfirmation.id, revision.id);
    assert.equal(repeatConfirmation.idempotent, true);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a'").get().count,
      3,
    );

    const staleResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/revision", administrator, {
        method: "POST",
        body: {
          familyId: "family-a",
          submissionPeriodId: "period-2026-09",
          sourceVersionId: preview.sourceVersionId,
          reason: "古い版からの保存",
          changes: [{ childId: "child-a1", date: "2026-09-02", usageStatus: "off" }],
        },
      }),
      { service, authService },
    );
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).code, "EFFECTIVE_VERSION_CHANGED");

    const historyResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/history?submissionPeriodId=period-2026-09&familyId=family-a&childId=child-a1", administrator),
      { service, authService },
    );
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()).history;
    assert.equal(history.length, 1);
    assert.equal(history[0].reason, "架空の変更連絡");
    assert.equal(history[0].changes.length, 1);
    assert.equal(history[0].administratorName, "架空予定管理者");

    const unrelatedHistory = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/history?submissionPeriodId=period-2026-09&familyId=family-b", administrator),
      { service, authService },
    );
    assert.deepEqual((await unrelatedHistory.json()).history, []);

    const crossFamilyPreview = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/revision/preview", administrator, {
        method: "POST",
        body: {
          familyId: "family-a",
          submissionPeriodId: "period-2026-09",
          reason: "別家庭園児を指定",
          changes: [{ childId: "child-b1", date: "2026-09-01", usageStatus: "off" }],
        },
      }),
      { service, authService },
    );
    assert.equal(crossFamilyPreview.status, 403);
    assert.equal((await crossFamilyPreview.json()).code, "CHILD_SCOPE_VIOLATION");

    const grantResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/allow-resubmission", administrator, {
        method: "POST",
        body: { familyId: "family-a", submissionPeriodId: "period-2026-09" },
      }),
      { service, authService },
    );
    assert.equal(grantResponse.status, 200);
    assert.equal(service.dashboard(fixture.actorA).submission.resubmissionAllowed, true);
    service.submitFamilySchedules(fixture.actorA);
    assert.equal(service.dashboard(fixture.actorA).submission.schoolModified, false);
    const versionCount = database.prepare(
      "SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'",
    ).get().count;
    assert.equal(versionCount, 4);
  });
});

test("creates and updates child profiles without changing immutable submission snapshots", async () => {
  await withScheduleDatabase(async ({ database, service, authService, fixture }) => {
    const legacy = service.administratorChildManagement(fixture.actorAdmin).children.find((child) => child.id === "child-a1");
    assert.equal(legacy.name, "架空園児A1");
    assert.equal(legacy.lastName, null);

    const createdManagement = service.createChild(fixture.actorAdmin, {
      lastName: "未来",
      firstName: "花子",
      lastNameKana: "みらい",
      firstNameKana: "はなこ",
      className: "架空組D",
      birthDate: "2025-05-01",
      enrollmentDate: "2026-09-01",
      withdrawalDate: "",
      status: "enrolled",
    });
    const created = createdManagement.children.find((child) => child.lastName === "未来" && child.firstName === "花子");
    assert.ok(created);
    const createdRaw = database.prepare("SELECT * FROM children WHERE id = ?").get(created.id);
    assert.equal(createdRaw.name, "未来 花子");
    assert.equal(createdRaw.kana, "ミライ ハナコ");
    assert.deepEqual(created.memberships, []);

    const issued = await authService.issueFamilyAccountForChild(fixture.actorAdmin, {
      childId: created.id,
      startDate: "2026-08-20",
      activeFrom: "2099-01-01",
      activeTo: "2099-12-31",
    });
    assert.match(issued.loginId, /^family-[0-9a-f]{12}$/);
    assert.match(issued.temporaryPassword, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.deepEqual(issued.childNames, ["未来 花子"]);
    assert.equal(issued.startDate, "2026-08-20");
    const issuedAccount = database.prepare(
      "SELECT password_hash FROM family_accounts WHERE family_id = ?",
    ).get(issued.familyId);
    assert.notEqual(issuedAccount.password_hash, issued.temporaryPassword);
    assert.match(issuedAccount.password_hash, /^scrypt\$/);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_children WHERE family_id = ? AND child_id = ?",
    ).get(issued.familyId, created.id).count, 1);
    assert.deepEqual({ ...database.prepare(
      "SELECT active_from, active_to FROM family_children WHERE family_id = ? AND child_id = ?",
    ).get(issued.familyId, created.id) }, { active_from: "2026-09-01", active_to: null });
    const issuedChild = service.administratorChildManagement(fixture.actorAdmin).children.find((child) => child.id === created.id);
    assert.equal(issuedChild.memberships[0].hasAccount, true);
    const issuedLogin = await authService.login({
      scope: "family", loginId: issued.loginId, password: issued.temporaryPassword, source: "test-issued-family",
    });
    assert.equal(issuedLogin.actor.familyId, issued.familyId);
    assert.equal(issuedLogin.actor.mustChangePassword, false);
    assert.deepEqual(service.dashboard(issuedLogin.actor).children.map(({ name }) => name), ["未来 花子"]);

    const siblingManagement = service.createChild(fixture.actorAdmin, {
      lastName: "未来",
      firstName: "次郎",
      lastNameKana: "みらい",
      firstNameKana: "じろう",
      birthDate: "2025-08-01",
      enrollmentDate: "2026-09-01",
      withdrawalDate: "",
      status: "enrolled",
    });
    const sibling = siblingManagement.children.find((child) => child.lastName === "未来" && child.firstName === "次郎");
    assert.ok(sibling);
    const linked = authService.linkChildToFamilyAccount(fixture.actorAdmin, {
      childId: sibling.id,
      familyId: issued.familyId,
      activeFrom: "2099-01-01",
      activeTo: "2099-12-31",
    });
    assert.equal(linked.familyId, issued.familyId);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_children WHERE family_id = ?",
    ).get(issued.familyId).count, 2);
    assert.deepEqual({ ...database.prepare(
      "SELECT active_from, active_to FROM family_children WHERE family_id = ? AND child_id = ?",
    ).get(issued.familyId, sibling.id) }, { active_from: "2026-09-01", active_to: null });

    const rollbackManagement = service.createChild(fixture.actorAdmin, {
      lastName: "安全",
      firstName: "確認",
      lastNameKana: "あんぜん",
      firstNameKana: "かくにん",
      birthDate: "2025-09-01",
      enrollmentDate: "2026-09-01",
      status: "enrolled",
    });
    const rollbackChild = rollbackManagement.children.find((child) => child.lastName === "安全" && child.firstName === "確認");
    const familyCountBeforeFailure = database.prepare("SELECT COUNT(*) AS count FROM families").get().count;
    const accountCountBeforeFailure = database.prepare("SELECT COUNT(*) AS count FROM family_accounts").get().count;
    database.exec(`
      CREATE TRIGGER fail_family_child_issue
      BEFORE INSERT ON family_children
      WHEN NEW.child_id = '${rollbackChild.id}'
      BEGIN
        SELECT RAISE(FAIL, 'forced family issue failure');
      END
    `);
    await assert.rejects(
      () => authService.issueFamilyAccountForChild(fixture.actorAdmin, {
        childId: rollbackChild.id,
        startDate: "2026-08-25",
        activeFrom: "2026-09-01",
      }),
      /forced family issue failure/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM families").get().count, familyCountBeforeFailure);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_accounts").get().count, accountCountBeforeFailure);

    service.dashboard(fixture.actorA);
    service.submitFamilySchedules(fixture.actorA);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const submittedRaw = rawSubmissionVersion(database, submitted.id);

    service.updateChild(fixture.actorAdmin, "child-a1", {
      originalFamilyId: "family-a",
      familyId: "family-a",
      lastName: "山田",
      firstName: "はると",
      lastNameKana: "やまだ",
      firstNameKana: "はると",
      className: "架空組A",
      birthDate: "2025-04-10",
      enrollmentDate: "2026-09-01",
      withdrawalDate: "2026-09-30",
      familyActiveFrom: "2026-09-01",
      familyActiveTo: "2026-09-30",
      status: "withdrawn",
    });
    const updated = database.prepare("SELECT * FROM children WHERE id = 'child-a1'").get();
    assert.equal(updated.name, "山田 はると");
    assert.equal(updated.kana, "ヤマダ ハルト");
    assert.deepEqual(rawSubmissionVersion(database, submitted.id), submittedRaw);

    assert.throws(
      () => service.createChild(fixture.actorAdmin, {
        familyId: "family-a", lastName: "片仮名", firstName: "入力", lastNameKana: "カタカナ", firstNameKana: "にゅうりょく",
        birthDate: "2025-01-01", enrollmentDate: "2026-09-01", familyActiveFrom: "2026-09-01", status: "enrolled",
      }),
      (error) => error.code === "INVALID_KANA" && error.message.includes("全角ひらがな"),
    );

    assert.throws(
      () => service.createChild(fixture.actorAdmin, {
        familyId: "family-a", lastName: "不正", firstName: "日付", lastNameKana: "ふせい", firstNameKana: "ひづけ",
        birthDate: "2025-01-01", enrollmentDate: "2026-09-10", withdrawalDate: "2026-09-01",
        familyActiveFrom: "2026-09-10", familyActiveTo: "2026-09-01", status: "enrolled",
      }),
      (error) => error.code === "INVALID_DATE_RANGE",
    );
    assert.throws(
      () => service.updateChild(fixture.actorAdmin, "child-a1", {
        originalFamilyId: "family-a", familyId: "family-b",
        lastName: "山田", firstName: "はると", lastNameKana: "やまだ", firstNameKana: "はると",
        birthDate: "2025-04-10", enrollmentDate: "2026-09-01", withdrawalDate: "2026-09-30",
        familyActiveFrom: "2026-09-15", familyActiveTo: "2026-09-20", status: "withdrawn",
      }),
      (error) => error.code === "MEMBERSHIP_OVERLAP",
    );
    assert.throws(
      () => service.createChild(fixture.actorA, {
        familyId: "family-a", lastName: "権限", firstName: "なし", lastNameKana: "けんげん", firstNameKana: "なし",
        birthDate: "2025-01-01", enrollmentDate: "2026-09-01", familyActiveFrom: "2026-09-01",
      }),
      (error) => error.code === "FORBIDDEN",
    );
  });
});

test("records Monday-to-Saturday basic patterns and applies them only by explicit parent action", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    let dashboard = service.dashboard(fixture.actorA);
    const monday = dashboard.children.find((child) => child.id === "child-a1").schedule.days.find((day) => day.date === "2026-09-07");
    const sunday = dashboard.children.find((child) => child.id === "child-a1").schedule.days.find((day) => day.date === "2026-09-06");
    const closure = dashboard.children.find((child) => child.id === "child-a1").schedule.days.find((day) => day.date === "2026-09-21");
    assert.equal(monday.arrivalTime, "08:30");
    assert.equal(sunday.usageStatus, "closed");
    assert.equal(closure.usageStatus, "closed");
    database.prepare("UPDATE daily_schedules SET source = 'daily' WHERE id = ?").run(monday.id);

    service.submitFamilySchedules(fixture.actorA);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const submittedRaw = rawSubmissionVersion(database, submitted.id);
    const patterns = [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      enabled: weekday <= 5,
      arrivalTime: weekday <= 5 ? (weekday === 1 ? "07:00" : "09:00") : null,
      departureTime: weekday <= 5 ? (weekday === 1 ? "20:00" : "16:00") : null,
    }));
    const result = service.updateBasicUsagePatterns(fixture.actorAdmin, "child-a1", { patterns });
    assert.equal(result.changed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM basic_usage_pattern_histories WHERE child_id = 'child-a1'").get().count, 5);
    const operation = database.prepare(
      "SELECT detail_json FROM operation_logs WHERE operation = 'basic_usage_pattern.changed' ORDER BY occurred_at DESC LIMIT 1",
    ).get();
    assert.equal(JSON.parse(operation.detail_json).reason, "管理者変更");
    const reloadedMondayPattern = service.administratorChildManagement(fixture.actorAdmin).children
      .find((child) => child.id === "child-a1").patterns.find((pattern) => pattern.weekday === 1);
    assert.deepEqual(reloadedMondayPattern, { weekday: 1, enabled: true, arrivalTime: "07:00", departureTime: "20:00" });
    assert.deepEqual(rawSubmissionVersion(database, submitted.id), submittedRaw);
    assert.equal(database.prepare("SELECT arrival_time FROM daily_schedules WHERE id = ?").get(monday.id).arrival_time, "08:30");
    assert.equal(database.prepare("SELECT source FROM daily_schedules WHERE id = ?").get(monday.id).source, "daily");

    const beforeNoChange = database.prepare("SELECT COUNT(*) AS count FROM basic_usage_pattern_histories WHERE child_id = 'child-a1'").get().count;
    const noChange = service.updateBasicUsagePatterns(fixture.actorAdmin, "child-a1", { patterns });
    assert.equal(noChange.changed, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM basic_usage_pattern_histories WHERE child_id = 'child-a1'").get().count, beforeNoChange);
    assert.throws(
      () => service.updateBasicUsagePatterns(fixture.actorAdmin, "child-a1", {
        patterns: [{ ...patterns[0], weekday: 0 }, ...patterns.slice(1)],
      }),
      (error) => error.code === "INVALID_WEEKDAY",
    );
    assert.throws(
      () => service.updateBasicUsagePatterns(fixture.actorAdmin, "child-a1", {
        patterns: patterns.map((pattern) => pattern.weekday === 1 ? { ...pattern, arrivalTime: "06:55" } : pattern),
      }),
      (error) => error.code === "OUTSIDE_OPENING_HOURS",
    );
    assert.throws(
      () => service.updateBasicUsagePatterns(fixture.actorAdmin, "child-a1", {
        patterns: patterns.map((pattern) => pattern.weekday === 1 ? { ...pattern, arrivalTime: "09:03" } : pattern),
      }),
      (error) => error.code === "INVALID_TIME",
    );
    assert.throws(
      () => service.updateBasicUsagePatterns(fixture.actorA, "child-a1", { patterns }),
      (error) => error.code === "FORBIDDEN",
    );

    service.allowFamilyResubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    dashboard = service.applyBasicUsagePattern(fixture.actorA, "child-a1");
    const applied = dashboard.children.find((child) => child.id === "child-a1").schedule.days;
    assert.equal(applied.find((day) => day.date === "2026-09-07").arrivalTime, "07:00");
    assert.equal(applied.find((day) => day.date === "2026-09-06").usageStatus, "closed");
    assert.equal(applied.find((day) => day.date === "2026-09-21").usageStatus, "closed");
    assert.equal(applied.find((day) => day.date === "2026-09-21").closureName, "休園日");
    assert.deepEqual(rawSubmissionVersion(database, submitted.id), submittedRaw);

    service.updateChild(fixture.actorAdmin, "child-a2", {
      originalFamilyId: "family-a",
      familyId: "family-a",
      lastName: "未来",
      firstName: "次郎",
      lastNameKana: "みらい",
      firstNameKana: "じろう",
      className: "架空組B",
      birthDate: "2025-03-01",
      enrollmentDate: "2026-09-10",
      withdrawalDate: "",
      familyActiveFrom: "2026-09-10",
      familyActiveTo: "",
      status: "enrolled",
    });
    const childTwoApplied = service.applyBasicUsagePattern(fixture.actorA, "child-a2");
    assert.equal(
      childTwoApplied.children.find((child) => child.id === "child-a2").schedule.days.find((day) => day.date === "2026-09-09").usageStatus,
      "not_enrolled",
    );

    assert.throws(
      () => service.applyBasicUsagePattern(fixture.actorB, "child-a1"),
      (error) => error.code === "CHILD_SCOPE_VIOLATION",
    );

    database.exec(`
      CREATE TRIGGER fail_basic_pattern_operation
      BEFORE INSERT ON operation_logs
      WHEN NEW.operation = 'basic_usage_pattern.changed'
      BEGIN
        SELECT RAISE(FAIL, 'forced basic pattern audit failure');
      END
    `);
    const beforePattern = database.prepare("SELECT * FROM basic_usage_patterns WHERE child_id = 'child-a2' ORDER BY weekday").all().map((row) => ({ ...row }));
    assert.throws(
      () => service.updateBasicUsagePatterns(fixture.actorAdmin, "child-a2", {
        patterns: patterns.map((pattern) => ({ ...pattern, arrivalTime: pattern.enabled ? "09:30" : null })),
      }),
      /forced basic pattern audit failure/,
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM basic_usage_patterns WHERE child_id = 'child-a2' ORDER BY weekday").all().map((row) => ({ ...row })),
      beforePattern,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM basic_usage_pattern_histories WHERE child_id = 'child-a2'").get().count, 0);
  });
});

test("distinguishes hard closures from editable family cooperation days in schedules and counts", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    assert.throws(
      () => service.saveClosureDay(fixture.actorA, { targetMonth: "2026-09", date: "2026-09-22" }),
      (error) => error.code === "FORBIDDEN",
    );
    const saved = service.saveClosureDay(fixture.actorAdmin, {
      targetMonth: "2026-09",
      date: "2026-09-22",
    });
    assert.equal(saved.name, "休園日");
    assert.equal(database.prepare(
      "SELECT name FROM closure_days WHERE date = '2026-09-22'",
    ).get().name, "休園日");

    const dashboard = service.dashboard(fixture.actorA);
    const savedDay = dashboard.children.find((child) => child.id === "child-a1")
      .schedule.days.find((day) => day.date === "2026-09-22");
    const fixtureDay = dashboard.children.find((child) => child.id === "child-a1")
      .schedule.days.find((day) => day.date === "2026-09-21");
    assert.deepEqual(
      { status: savedDay.usageStatus, label: savedDay.closureName, arrival: savedDay.arrivalTime, departure: savedDay.departureTime },
      { status: "closed", label: "休園日", arrival: null, departure: null },
    );
    assert.equal(fixtureDay.closureName, "休園日");

    const cooperation = service.saveClosureDay(fixture.actorAdmin, {
      targetMonth: "2026-09",
      date: "2026-09-23",
      dayType: "family_cooperation",
    });
    assert.deepEqual(
      { name: cooperation.name, type: cooperation.type, parentInputAllowed: cooperation.parentInputAllowed },
      { name: "家庭保育協力日", type: "family_cooperation", parentInputAllowed: true },
    );
    let cooperationDashboard = service.dashboard(fixture.actorA);
    const cooperationDay = cooperationDashboard.children.find((child) => child.id === "child-a1")
      .schedule.days.find((day) => day.date === "2026-09-23");
    assert.equal(cooperationDay.closureName, "家庭保育協力日");
    assert.equal(cooperationDay.locked, false);
    cooperationDashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(cooperationDashboard, "child-a1", "2026-09-23", {
        usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00",
      }),
    });
    assert.equal(
      cooperationDashboard.children.find((child) => child.id === "child-a1")
        .schedule.days.find((day) => day.date === "2026-09-23").usageStatus,
      "using",
    );
    service.submitFamilySchedules(fixture.actorA);
    const exportData = service.administratorScheduleExportData(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    const cooperationDate = exportData.dates.find((day) => day.date === "2026-09-23");
    assert.equal(cooperationDate.isClosure, false);
    assert.equal(cooperationDate.closureName, "家庭保育協力日");
    const submittedCooperationDay = exportData.children.find((child) => child.childId === "child-a1")
      .days.find((day) => day.date === "2026-09-23");
    assert.equal(submittedCooperationDay.usageStatus, "using");
    database.prepare("UPDATE children SET birth_date = '2025-05-01' WHERE id = 'child-a1'").run();
    database.prepare("UPDATE children SET birth_date = '2024-05-01' WHERE id = 'child-a2'").run();
    database.prepare("UPDATE children SET birth_date = '2023-05-01' WHERE id = 'child-b1'").run();
    assert.equal(service.administratorMonthlyHeadcount(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).days.find((day) => day.date === "2026-09-23").maximum > 0, true);
    const quarterHours = service.administratorQuarterHourStaffingCandidates(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).slots;
    assert.ok(quarterHours
      .filter((slot) => slot.date === "2026-09-22")
      .every((slot) => slot.requiredChildcareWorkers === 0));
    assert.equal(quarterHours
      .find((slot) => slot.date === "2026-09-23" && slot.startTime === "09:00")
      .requiredChildcareWorkers > 0, true);

    const immutableSubmitted = service.latestSubmittedVersion(fixture.actorA);
    const immutablePayload = rawSubmissionVersion(database, immutableSubmitted.id);
    database.prepare("UPDATE submission_periods SET status = 'closed' WHERE id = 'period-2026-09'").run();
    service.saveClosureDay(fixture.actorAdmin, {
      targetMonth: "2026-09",
      date: "2026-09-24",
      dayType: "closed",
    });
    service.saveClosureDay(fixture.actorMaster, {
      targetMonth: "2026-09",
      date: "2026-09-25",
      dayType: "family_cooperation",
    });
    const postSubmissionExport = service.administratorScheduleExportData(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(postSubmissionExport.dates.find((day) => day.date === "2026-09-24").isClosure, true);
    assert.equal(postSubmissionExport.dates.find((day) => day.date === "2026-09-25").isClosure, false);
    assert.equal(service.administratorMonthlyHeadcount(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).days.find((day) => day.date === "2026-09-24").maximum, 0);
    assert.equal(service.administratorMonthlyHeadcount(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).days.find((day) => day.date === "2026-09-25").maximum > 0, true);
    assert.deepEqual(rawSubmissionVersion(database, immutableSubmitted.id), immutablePayload);

    for (const input of [
      { targetMonth: "2026-07", date: "2026-07-14", dayType: "closed" },
      { targetMonth: "2026-11", date: "2026-11-17", dayType: "family_cooperation" },
    ]) {
      service.saveClosureDay(fixture.actorAdmin, input);
      assert.equal(database.prepare(
        "SELECT COUNT(*) AS count FROM closure_days WHERE date = ?",
      ).get(input.date).count, 1);
      const monthDashboard = service.administratorScheduleDashboard(fixture.actorAdmin, { targetMonth: input.targetMonth });
      assert.equal(monthDashboard.selectedPeriod, null);
      assert.equal(monthDashboard.closures.some((closure) => closure.date === input.date), true);
    }

    assert.throws(
      () => database.prepare(
        `INSERT INTO closure_days
         (id, date, name, type, parent_input_allowed, note, created_at, updated_at)
         VALUES ('duplicate-closure', '2026-07-14', '重複', 'closed', 0, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(),
      /UNIQUE constraint failed: closure_days\.date/,
    );

    database.exec(`
      INSERT INTO submission_periods
        (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
      VALUES
        ('period-2026-07', '2026-07', '2026-06-25T14:59:59.000Z', 'closed', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('period-2026-11', '2026-11', '2026-10-25T14:59:59.000Z', 'draft', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM closure_days WHERE date IN ('2026-07-14', '2026-11-17')").get().count, 2);
    database.exec("DELETE FROM submission_periods WHERE id IN ('period-2026-07', 'period-2026-11')");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM closure_days WHERE date IN ('2026-07-14', '2026-11-17')").get().count, 2);

    service.removeClosureDay(fixture.actorAdmin, { targetMonth: "2026-07", date: "2026-07-14" });
    service.removeClosureDay(fixture.actorAdmin, { targetMonth: "2026-11", date: "2026-11-17" });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM closure_days WHERE date IN ('2026-07-14', '2026-11-17')").get().count, 0);

    service.removeClosureDay(fixture.actorMaster, {
      targetMonth: "2026-09",
      date: "2026-09-22",
    });
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM closure_days WHERE date = '2026-09-22'",
    ).get().count, 0);
  });
});

test("lets administrators select any fiscal month without changing the parent target rule", async () => {
  await withScheduleDatabase(async ({ service, fixture }) => {
    const initial = service.administratorScheduleDashboard(fixture.actorAdmin);
    assert.equal(initial.selectedTargetMonth, "2026-08");
    assert.equal(initial.selectedPeriod, null);

    const january = service.administratorScheduleDashboard(fixture.actorAdmin, { targetMonth: "2027-01" });
    assert.equal(january.selectedPeriod, null);
    assert.equal(january.selectedTargetMonth, "2027-01");
    assert.deepEqual(january.monthlyUsageSummaries, []);

    const september = service.administratorScheduleDashboard(fixture.actorAdmin, { targetMonth: "2026-09" });
    assert.equal(september.selectedPeriod.id, "period-2026-09");
    assert.equal(september.selectedTargetMonth, "2026-09");
    assert.throws(
      () => service.administratorScheduleDashboard(fixture.actorAdmin, { targetMonth: "2026-13" }),
      (error) => error.code === "INVALID_TARGET_MONTH",
    );
    assert.equal(service.dashboard(fixture.actorA).period.targetMonth, "2026-09");
  });
});

test("protects child-management APIs and connects explicit basic-pattern application", async () => {
  await withScheduleDatabase(async ({ service, authService, fixture }) => {
    const family = await familySession(authService, "demo-family-a", fixture.passwords.familyA);
    const administrator = await administratorSession(authService, "demo-schedule-admin", fixture.passwords.administrator);
    const forbidden = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/children", family),
      { service, authService },
    );
    assert.equal(forbidden.status, 403);

    const managementResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/children", administrator),
      { service, authService },
    );
    assert.equal(managementResponse.status, 200);
    const management = (await managementResponse.json()).management;
    assert.equal(management.children.length, 3);
    assert.ok(!JSON.stringify(management).toLowerCase().includes("password"));

    const missingCsrf = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/children/child-a1/basic-patterns", administrator, {
        method: "PUT",
        csrf: false,
        body: { reason: "CSRF確認", patterns: management.children[0].patterns },
      }),
      { service, authService },
    );
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).code, "CSRF_INVALID");

    service.dashboard(fixture.actorA);
    const applyResponse = await handleFamilyScheduleApiRequest(
      apiRequest("/api/family/schedule/apply-basic-pattern", family, {
        method: "POST",
        body: { childId: "child-b1" },
      }),
      { service, authService },
    );
    assert.equal(applyResponse.status, 403);
    assert.equal((await applyResponse.json()).code, "CHILD_SCOPE_VIOLATION");
  });
});

test("keeps the legacy parent-target switch transactional without overriding the Tokyo default month", async () => {
  await withScheduleDatabase(async ({ database, service, authService, fixture }) => {
    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'open', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    const administrator = await administratorSession(authService, "demo-schedule-admin", fixture.passwords.administrator);
    const response = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/parent-target", administrator, {
        method: "POST",
        body: { submissionPeriodId: "period-2026-10" },
      }),
      { service, authService },
    );
    assert.equal(response.status, 200);
    const rows = database.prepare(
      "SELECT id, is_parent_target FROM submission_periods ORDER BY id",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: "period-2026-09", is_parent_target: 0 },
      { id: "period-2026-10", is_parent_target: 1 },
    ]);
    assert.equal(service.dashboard(fixture.actorA).period.id, "period-2026-09");
    assert.equal(service.dashboard(fixture.actorA, { submissionPeriodId: "period-2026-10" }).period.id, "period-2026-10");
  });
});

test("aggregates the effective monthly schedule with fiscal-age groups and privacy-safe names", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    assert.throws(
      () => service.administratorMonthlyHeadcount(fixture.actorAdmin, { submissionPeriodId: "period-2026-09" }),
      (error) => error.code === "CHILD_PROFILE_INCOMPLETE" && error.message.includes("生年月日未設定"),
    );

    for (const [id, lastName, firstName, birthDate] of [
      ["child-a1", "山田", "はると", "2025-04-02"],
      ["child-a2", "佐藤", "みお", "2023-04-02"],
      ["child-b1", "佐々木", "はると", "2024-04-02"],
    ]) {
      database.prepare(
        `UPDATE children
         SET name = ?, last_name = ?, first_name = ?, birth_date = ?
         WHERE id = ?`,
      ).run(`${lastName} ${firstName}`, lastName, firstName, birthDate, id);
    }

    let dashboard = service.dashboard(fixture.actorA);
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: dashboard.children.find((entry) => entry.id === "child-a1").schedule.days.map((day) => {
        if (day.date === "2026-09-01") return { ...day, usageStatus: "using", arrivalTime: "09:00", departureTime: "16:00" };
        if (day.date === "2026-09-02") return { ...day, usageStatus: "using", arrivalTime: "09:00", departureTime: "09:55" };
        return day;
      }),
    });
    service.updateChildSchedule(fixture.actorA, "child-a2", {
      days: dashboard.children.find((entry) => entry.id === "child-a2").schedule.days.map((day) => {
        if (day.date === "2026-09-01") return { ...day, usageStatus: "using", arrivalTime: "10:00", departureTime: "15:00" };
        if (day.date === "2026-09-02") return { ...day, usageStatus: "using", arrivalTime: "10:00", departureTime: "15:00" };
        return day;
      }),
    });
    service.submitFamilySchedules(fixture.actorA);

    const headcount = service.administratorMonthlyHeadcount(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    assert.deepEqual(headcount.ageGroups, ["0歳児", "1歳児", "2歳児"]);
    const firstDay = headcount.days.find((day) => day.date === "2026-09-01");
    assert.equal(firstDay.maximum, 2);
    assert.deepEqual(firstDay.changes.map((change) => [change.time, change.before, change.after]), [
      ["9:00", 0, 1],
      ["10:00", 1, 2],
      ["15:05", 2, 1],
      ["16:05", 1, 0],
    ]);
    assert.deepEqual(firstDay.changes[0].byAgeGroup, { "0歳児": 1, "1歳児": 0, "2歳児": 0 });
    assert.deepEqual(firstDay.changes[0].childNames, ["はると（山）"]);
    assert.equal(firstDay.changes[0].requiredChildcareWorkers, 2);
    assert.equal(firstDay.changes[0].requiredLicensedNurseryTeachers, 1);
    assert.deepEqual(firstDay.changes[0].appliedRules, ["minimum_staff"]);
    assert.deepEqual(firstDay.changes[1].childNames, ["はると（山）", "みお"]);
    assert.ok(!JSON.stringify(headcount).includes("はると（佐）"), "未提出園児は人数・園児名へ含めない");

    const row1605 = headcount.rows.find((row) => row.time === "16:05");
    assert.equal(row1605.counts[0], 0);
    const change1605 = firstDay.changes.find((change) => change.time === "16:05");
    assert.equal(change1605.before, 1);
    assert.equal(change1605.after, 0);
    assert.equal(change1605.requiredChildcareWorkers, 0);
    assert.equal(change1605.requiredLicensedNurseryTeachers, 0);
    assert.equal(firstDay.changes.find((change) => change.time === "15:05").totalChildren, 1);
    const firstDay1605 = headcount.staffingChangePoints.find((point) => point.date === "2026-09-01" && point.time === "16:05");
    assert.equal(firstDay1605.totalChildren, 0, "16:00降園は16:05から除外する");
    const staffingRequirements = service.administratorStaffingRequirements(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    const staffingAt = (date, time) => staffingRequirements.slots.find((slot) => slot.date === date && slot.time === time);
    assert.equal(staffingAt("2026-09-01", "16:00").totalChildren, 1);
    assert.equal(staffingAt("2026-09-01", "16:00").requiredChildcareWorkers, 2);
    assert.equal(staffingAt("2026-09-01", "16:05").totalChildren, 0);
    assert.equal(staffingAt("2026-09-01", "16:05").requiredChildcareWorkers, 0);
    for (const [staffId, staffCode, roleType, qualificationType] of [
      ["staff-a", "ST9001", "nursery_teacher_role", "licensed_nursery_teacher"],
      ["staff-b", "ST9002", "other", "childcare_support_worker_local_childcare"],
      ["staff-e", "ST9003", "nursery_teacher_role", null],
    ]) {
      database.prepare(
        `INSERT INTO staff_members (id, staff_code, name, employment_start_date, status)
         VALUES (?, ?, ?, '2026-04-01', 'active')`,
      ).run(staffId, staffCode, `架空 ${staffId}`);
      database.prepare(
        `INSERT INTO staff_roles (id, staff_id, role_type, valid_from)
         VALUES (?, ?, ?, '2026-04-01')`,
      ).run(`role-${staffId}`, staffId, roleType);
      if (qualificationType) {
        database.prepare(
          `INSERT INTO staff_qualifications (id, staff_id, qualification_type, valid_from)
           VALUES (?, ?, ?, '2026-04-01')`,
        ).run(`qualification-${staffId}`, staffId, qualificationType);
      }
      database.prepare(
        `INSERT INTO staff_work_condition_versions
         (id, staff_id, valid_from, employment_type, created_by_administrator_id)
         VALUES (?, ?, '2026-04-01', '常勤', ?)`,
      ).run(`condition-${staffId}`, staffId, fixture.actorAdmin.id);
      database.prepare(
        `INSERT INTO staff_weekly_availability
         (work_condition_version_id, weekday, available, start_time, end_time)
         VALUES (?, 2, 1, '09:00', '16:00')`,
      ).run(`condition-${staffId}`);
    }
    const quarterHourCandidates = service.administratorQuarterHourStaffingCandidates(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    const automaticShiftRequirements = service.administratorQuarterHourStaffingRequirements(fixture.actorAdmin, {
      targetMonth: "2026-09",
    });
    assert.equal(automaticShiftRequirements.period.id, "period-2026-09");
    assert.equal(automaticShiftRequirements.slots.length, quarterHourCandidates.slots.length);
    assert.deepEqual(
      automaticShiftRequirements.slots.map((slot) => [
        slot.date,
        slot.startTime,
        slot.requiredChildcareWorkers,
        slot.requiredLicensedNurseryTeachers,
      ]),
      quarterHourCandidates.slots.map((slot) => [
        slot.date,
        slot.startTime,
        slot.requiredChildcareWorkers,
        slot.requiredLicensedNurseryTeachers,
      ]),
    );
    assert.throws(
      () => service.administratorQuarterHourStaffingRequirements(fixture.actorAdmin, { targetMonth: "2098-01" }),
      (error) => error.code === "AUTOMATIC_SHIFT_PERIOD_NOT_FOUND",
    );
    assert.throws(
      () => service.administratorQuarterHourStaffingCandidates(fixture.actorA, {
        submissionPeriodId: "period-2026-09",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    const quarterAt = (date, startTime) => quarterHourCandidates.slots
      .find((slot) => slot.date === date && slot.startTime === startTime);
    assert.equal(quarterAt("2026-09-01", "16:00").requiredChildcareWorkers, 2);
    assert.equal(quarterAt("2026-09-01", "16:15").requiredChildcareWorkers, 0);
    assert.equal(quarterAt("2026-09-01", "15:45").childcareCandidateAssessmentStatus, "READY");
    assert.equal(quarterAt("2026-09-01", "15:45").eligibleChildcareWorkerCount, 2);
    assert.equal(quarterAt("2026-09-01", "15:45").eligibleLicensedNurseryTeacherCount, 1);
    assert.equal(quarterAt("2026-09-01", "15:45").childcareWorkerShortage, 0);
    assert.equal(quarterAt("2026-09-01", "15:45").licensedNurseryTeacherShortage, 0);
    assert.deepEqual(quarterAt("2026-09-01", "15:45").eligibleStaff.map((entry) => entry.staffId), ["staff-a", "staff-b"]);
    assert.equal(quarterAt("2026-09-01", "16:00").eligibleChildcareWorkerCount, 0);
    assert.equal(quarterAt("2026-09-01", "16:00").childcareWorkerShortage, 2);
    assert.equal(quarterAt("2026-09-01", "16:00").licensedNurseryTeacherShortage, 1);
    assert.equal(quarterHourCandidates.classificationLimitations.length, 0);

    database.prepare(
      `INSERT INTO staff_schedule_preferences
       (id, staff_id, date, preference_type, start_time, end_time,
        created_by_administrator_id, updated_by_administrator_id)
       VALUES ('preference-staff-a', 'staff-a', '2026-09-01', 'day_off', NULL, NULL, ?, ?)`,
    ).run(fixture.actorAdmin.id, fixture.actorAdmin.id);
    const dayOffCandidates = service.administratorQuarterHourStaffingCandidates(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    assert.deepEqual(dayOffCandidates.slots
      .find((slot) => slot.date === "2026-09-01" && slot.startTime === "15:45")
      .eligibleStaff.map((entry) => entry.staffId), ["staff-b"]);

    database.prepare(
      `UPDATE staff_schedule_preferences
       SET preference_type = 'work_time', start_time = '08:00', end_time = '17:00'
       WHERE id = 'preference-staff-a'`,
    ).run();
    const preferredTimeCandidates = service.administratorQuarterHourStaffingCandidates(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    const preferredMorning = preferredTimeCandidates.slots
      .find((slot) => slot.date === "2026-09-01" && slot.startTime === "08:00");
    assert.deepEqual(preferredMorning.eligibleStaff.map((entry) => entry.staffId), ["staff-a"]);
    assert.equal(preferredMorning.eligibleStaff[0].effectiveAvailability.source, "preference");
    database.prepare("DELETE FROM staff_schedule_preferences WHERE id = 'preference-staff-a'").run();

    const secondDay = headcount.days.find((day) => day.date === "2026-09-02");
    const ageCompositionChange = secondDay.changes.find((change) => change.time === "10:00");
    assert.equal(ageCompositionChange.before, 1);
    assert.equal(ageCompositionChange.after, 1);
    assert.deepEqual(ageCompositionChange.byAgeGroup, { "0歳児": 0, "1歳児": 0, "2歳児": 1 });
    assert.equal(ageCompositionChange.delta, 0, "合計人数が同じでも年齢構成の変化を残す");
    const closureIndex = headcount.dates.findIndex((date) => date.date === "2026-09-21");
    assert.equal(headcount.days[closureIndex].status, "closed");
    assert.equal(headcount.days[closureIndex].maximumRequiredChildcareWorkers, 0);
    assert.equal(headcount.days[closureIndex].maximumRequiredLicensedNurseryTeachers, 0);
    assert.ok(headcount.rows.every((row) => row.counts[closureIndex] === 0));
    assert.ok(staffingRequirements.slots
      .filter((slot) => slot.date === "2026-09-21")
      .every((slot) => slot.totalChildren === 0 && slot.requiredChildcareWorkers === 0));
    assert.ok(quarterHourCandidates.slots
      .filter((slot) => slot.date === "2026-09-21")
      .every((slot) => slot.requiredChildcareWorkers === 0 && slot.requiredLicensedNurseryTeachers === 0));

    const adminDashboard = service.administratorScheduleDashboard(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
      familyId: "family-a",
    });
    assert.deepEqual(adminDashboard.latestSubmittedVersion.children.map((child) => child.name), ["はると", "みお"]);
    const submittedSummary = adminDashboard.monthlyUsageSummaries.find((child) => child.childId === "child-a1");
    assert.equal(submittedSummary.submissionStatus, "submitted");
    assert.ok(submittedSummary.usageDays > 0);
    assert.ok(submittedSummary.totalMinutes > 0);
    assert.deepEqual(adminDashboard.monthlyUsageSummaries.find((child) => child.childId === "child-b1"), {
      childId: "child-b1",
      familyId: "family-b",
      name: "はると（佐）",
      submissionStatus: "unsubmitted",
      usageDays: 0,
      totalMinutes: 0,
    });
  });
});

test("exports the latest effective schedules as a valid two-sheet workbook", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    let dashboard = service.dashboard(fixture.actorA);
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-01", {
        usageStatus: "using",
        arrivalTime: "09:00",
        departureTime: "16:00",
      }),
    });
    service.updateChildSchedule(fixture.actorA, "child-a2", {
      days: daysWithPatch(dashboard, "child-a2", "2026-09-01", {
        usageStatus: "off",
        arrivalTime: null,
        departureTime: null,
      }),
    });
    service.submitFamilySchedules(fixture.actorA);
    const submitted = service.latestSubmittedVersion(fixture.actorA);
    const submittedUsage = service.administratorScheduleDashboard(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).monthlyUsageSummaries.find((child) => child.childId === "child-a1");
    assert.equal(
      submitted.children.find((child) => child.childId === "child-a1").days.find((day) => day.date === "2026-09-02").usageStatus,
      "using",
    );
    service.confirmLatestFamilySubmission(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
    });
    const preview = service.previewAdministratorRevision(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: "Excel export fixture revision",
      changes: [{ childId: "child-a1", date: "2026-09-02", usageStatus: "off" }],
    });
    service.createAdministratorRevision(fixture.actorAdmin, {
      sourceVersionId: preview.sourceVersionId,
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      reason: preview.reason,
      changes: [{ childId: "child-a1", date: "2026-09-02", usageStatus: "off" }],
    });
    const revisedUsage = service.administratorScheduleDashboard(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    }).monthlyUsageSummaries.find((child) => child.childId === "child-a1");
    assert.equal(revisedUsage.usageDays, submittedUsage.usageDays - 1);
    assert.equal(revisedUsage.totalMinutes, submittedUsage.totalMinutes - (9 * 60));

    database.prepare(
      "UPDATE children SET enrollment_date = '2026-09-10', withdrawal_date = '2026-09-20' WHERE id = 'child-a2'",
    ).run();
    database.prepare(
      "UPDATE family_children SET active_from = '2026-09-10', active_to = '2026-09-20' WHERE family_id = 'family-a' AND child_id = 'child-a2'",
    ).run();
    database.prepare("UPDATE children SET name = '=2+2' WHERE id = 'child-b1'").run();

    const data = service.administratorScheduleExportData(fixture.actorAdmin, {
      submissionPeriodId: "period-2026-09",
    });
    assert.equal(data.dates.length, 30);
    assert.equal(data.dates[0].weekday, 2);
    assert.equal(data.children.length, 3);
    const childA1 = data.children.find((child) => child.name.includes("A1"));
    const childA2 = data.children.find((child) => child.name.includes("A2"));
    const childB1 = data.children.find((child) => child.name === "=2+2");
    assert.equal(childA1.submissionStatus, "submitted");
    assert.equal(childA1.days[0].arrivalTime, "09:00");
    assert.equal(childA1.days[0].departureTime, "16:00");
    assert.equal(childA1.days[1].usageStatus, "off");
    assert.equal(childA2.days[8].usageStatus, "not_enrolled");
    assert.equal(childA2.days[9].usageStatus, "using");
    assert.equal(childA2.days[20].usageStatus, "not_enrolled");
    assert.equal(childB1.submissionStatus, "unsubmitted");
    assert.equal(childA1.days[5].usageStatus, "closed");
    assert.equal(childA1.days[20].usageStatus, "closed");

    const excel = await createFamilyScheduleExcel(data);
    assert.equal(excel.filename, "nursery-schedule-2026-09.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel.buffer);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["園児利用予定", "時間帯別人数"]);

    const monthly = workbook.getWorksheet("園児利用予定");
    const headcount = workbook.getWorksheet("時間帯別人数");
    assert.equal(monthly.views[0].state, "frozen");
    assert.equal(monthly.views[0].xSplit, 2);
    assert.equal(monthly.views[0].ySplit, 2);
    assert.equal(headcount.views[0].state, "frozen");
    assert.equal(headcount.views[0].xSplit, 1);
    assert.equal(headcount.views[0].ySplit, 2);
    assert.equal(monthly.pageSetup.orientation, "landscape");

    const dangerousNameCell = [...Array(monthly.rowCount)].map((_, index) => monthly.getCell(index + 1, 1))
      .find((cell) => cell.value === "'=2+2");
    assert.ok(dangerousNameCell);
    assert.equal(typeof dangerousNameCell.value, "string");
    monthly.eachRow((row) => row.eachCell((cell) => {
      assert.ok(!(cell.value && typeof cell.value === "object" && "formula" in cell.value));
    }));

    const childA1Row = [...Array(monthly.rowCount)].map((_, index) => monthly.getRow(index + 1))
      .find((row) => String(row.getCell(1).value).includes("A1"));
    assert.equal(childA1Row.getCell(3).value, "9:00〜16:00");
    assert.equal(childA1Row.getCell(4).value, "休み");
    assert.equal(monthly.getRow(data.children.length + 3).getCell(3).value, 1);
    assert.equal(monthly.getCell(2, 7).fill.fgColor.argb, "FFDCEBFA");
    assert.equal(monthly.getCell(2, 8).fill.fgColor.argb, "FFFDE2E2");
    assert.equal(monthly.getCell(2, 23).fill.fgColor.argb, "FFFDE2E2");

    const row1600 = 3 + ((16 * 60 - 7 * 60) / 5);
    const row1605 = row1600 + 1;
    assert.equal(headcount.getCell(row1600, 2).value, 1);
    assert.equal(headcount.getCell(row1605, 2).value, 0);
    assert.equal(headcount.getCell(3, 7).value, 0);
    assert.equal(headcount.getCell(3, 22).value, 0);

    const exportedValues = [];
    workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => exportedValues.push(String(cell.value ?? "")))));
    const exportedText = exportedValues.join("\n");
    for (const forbidden of [
      fixture.passwords.familyA,
      fixture.passwords.administrator,
      "child-a1",
      "family-a",
      "2025-",
      "Excel export fixture revision",
    ]) assert.ok(!exportedText.includes(forbidden));

    assert.throws(
      () => service.administratorScheduleExportData(fixture.actorA, { submissionPeriodId: "period-2026-09" }),
      (error) => error.code === "FORBIDDEN",
    );
    assert.throws(
      () => service.administratorScheduleExportData(fixture.actorAdmin, { submissionPeriodId: "missing-period" }),
      (error) => error.code === "NOT_FOUND",
    );
  });
});

test("colors morning and afternoon headcounts at the specified boundaries", async () => {
  for (const [slot, count, expected] of [
    [7 * 60, 6, "normal"],
    [7 * 60, 7, "warning"],
    [11 * 60 + 55, 9, "warning"],
    [11 * 60 + 55, 10, "strong"],
    [12 * 60, 10, "strong"],
    [12 * 60, 5, "normal"],
    [12 * 60, 6, "warning"],
    [12 * 60, 8, "warning"],
    [12 * 60, 9, "strong"],
    [20 * 60, 9, "strong"],
  ]) assert.equal(headcountAlertLevel(slot, count), expected, `${slot} minutes / ${count} children`);
  assert.equal(headcountAlertLevel(11 * 60 + 55, 6), "normal");
  assert.equal(headcountAlertLevel(12 * 60, 6), "warning");

  const dates = [
    { date: "2026-09-01", dayOfMonth: 1, weekday: 2, isSaturday: false, isClosure: false },
    { date: "2026-09-02", dayOfMonth: 2, weekday: 3, isSaturday: false, isClosure: false },
  ];
  const child = (index, arrivalTime, departureTime, dateIndex) => ({
    name: `架空園児${index}`,
    submissionStatus: "submitted",
    days: dates.map((date, currentDateIndex) => ({
      date: date.date,
      usageStatus: currentDateIndex === dateIndex ? "using" : "off",
      arrivalTime: currentDateIndex === dateIndex ? arrivalTime : null,
      departureTime: currentDateIndex === dateIndex ? departureTime : null,
    })),
  });
  const children = [
    ...Array.from({ length: 6 }, (_, index) => child(index + 1, "07:00", "12:00", 0)),
    ...Array.from({ length: 4 }, (_, index) => child(index + 7, "07:00", "11:50", 0)),
    ...Array.from({ length: 9 }, (_, index) => child(index + 11, "12:00", "20:00", 1)),
  ];
  const excel = await createFamilyScheduleExcel({
    period: { id: "period-color-test", targetMonth: "2026-09", status: "open" },
    dates,
    children,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excel.buffer);
  const headcount = workbook.getWorksheet("時間帯別人数");
  const rowFor = (time) => {
    const [hour, minute] = time.split(":").map(Number);
    return 3 + ((hour * 60 + minute - 7 * 60) / 5);
  };

  assert.equal(headcount.getCell(rowFor("07:00"), 2).value, 10);
  assert.equal(headcount.getCell(rowFor("07:00"), 2).fill.fgColor.argb, "FFFFC857");
  assert.equal(headcount.getCell(rowFor("11:55"), 2).value, 6);
  assert.notEqual(headcount.getCell(rowFor("11:55"), 2).fill.fgColor?.argb, "FFFFF1B8");
  assert.notEqual(headcount.getCell(rowFor("11:55"), 2).fill.fgColor?.argb, "FFFFC857");
  assert.equal(headcount.getCell(rowFor("12:00"), 2).value, 6);
  assert.equal(headcount.getCell(rowFor("12:00"), 2).fill.fgColor.argb, "FFFFF1B8");
  assert.equal(headcount.getCell(rowFor("12:00"), 3).value, 9);
  assert.equal(headcount.getCell(rowFor("12:00"), 3).fill.fgColor.argb, "FFFFC857");
  assert.equal(headcount.getCell(rowFor("20:00"), 3).value, 9);
  assert.equal(headcount.getCell(rowFor("20:00"), 3).fill.fgColor.argb, "FFFFC857");
});

test("serves Excel downloads only to authenticated administrators", async () => {
  await withScheduleDatabase(async ({ database, service, authService, fixture }) => {
    database.prepare("UPDATE children SET birth_date = '2025-04-02' WHERE birth_date IS NULL").run();
    service.dashboard(fixture.actorA);
    service.submitFamilySchedules(fixture.actorA);
    const family = await familySession(authService, "demo-family-a", fixture.passwords.familyA);
    const administrator = await administratorSession(authService, "demo-schedule-admin", fixture.passwords.administrator);

    const unauthenticated = await handleAdminScheduleApiRequest(
      new Request("http://localhost/api/admin/schedules/export?submissionPeriodId=period-2026-09"),
      { service, authService },
    );
    assert.equal(unauthenticated.status, 401);

    const forbidden = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/export?submissionPeriodId=period-2026-09", family),
      { service, authService },
    );
    assert.equal(forbidden.status, 403);

    const unauthenticatedHeadcount = await handleAdminScheduleApiRequest(
      new Request("http://localhost/api/admin/schedules/headcount?submissionPeriodId=period-2026-09"),
      { service, authService },
    );
    assert.equal(unauthenticatedHeadcount.status, 401);

    const forbiddenHeadcount = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/headcount?submissionPeriodId=period-2026-09", family),
      { service, authService },
    );
    assert.equal(forbiddenHeadcount.status, 403);
    const unauthenticatedCandidates = await handleAdminScheduleApiRequest(
      new Request("http://localhost/api/admin/schedules/staffing-candidates?submissionPeriodId=period-2026-09"),
      { service, authService },
    );
    assert.equal(unauthenticatedCandidates.status, 401);
    const forbiddenCandidates = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/staffing-candidates?submissionPeriodId=period-2026-09", family),
      { service, authService },
    );
    assert.equal(forbiddenCandidates.status, 403);

    const missing = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/export?submissionPeriodId=missing-period", administrator),
      { service, authService },
    );
    assert.equal(missing.status, 404);

    const response = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/export?submissionPeriodId=period-2026-09", administrator),
      { service, authService },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    assert.match(response.headers.get("content-disposition"), /nursery-schedule-2026-09\.xlsx/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["園児利用予定", "時間帯別人数"]);

    const headcountResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/headcount?submissionPeriodId=period-2026-09", administrator),
      { service, authService },
    );
    assert.equal(headcountResponse.status, 200);
    const headcount = (await headcountResponse.json()).headcount;
    assert.deepEqual(headcount.ageGroups, ["0歳児", "1歳児", "2歳児"]);
    const candidateResponse = await handleAdminScheduleApiRequest(
      apiRequest("/api/admin/schedules/staffing-candidates?submissionPeriodId=period-2026-09", administrator),
      { service, authService },
    );
    assert.equal(candidateResponse.status, 200);
    const staffing = (await candidateResponse.json()).staffing;
    assert.equal(staffing.classificationCapabilities.childcareEligibilityConfigured, true);
    assert.equal(staffing.slots[0].eligibleChildcareWorkerCount, 0);
  });
});
