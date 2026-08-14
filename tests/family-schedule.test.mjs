import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { generateTemporaryPassword, hashPassword } from "../lib/server/auth/security.mjs";
import { createFamilyScheduleService } from "../lib/server/family-schedule/service.mjs";
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
     (id, submission_period_id, date, name, type, parent_input_allowed, note, created_at, updated_at)
     VALUES ('closure-2026-09-21', 'period-2026-09', '2026-09-21', '架空休園日', 'closed', 0, '', ?, ?)`,
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

test("uses Japan-time deadlines and blocks edits when the period is closed", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.editable, true);

    clock.value = new Date("2026-08-25T15:00:00.000Z");
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.editable, false);
    assert.equal(dashboard.submission.displayStatus, "期限超過");
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", { days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off" }) }),
      (error) => error.code === "SUBMISSION_LOCKED",
    );

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
    assert.equal(service.dashboard(fixture.actorA).period.editable, true);
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

test("creates a new immutable submission version when resubmitting during a family extension", async () => {
  await withScheduleDatabase(async ({ database, service, fixture, clock }) => {
    let dashboard = service.dashboard(fixture.actorA);
    dashboard = service.submitFamilySchedules(fixture.actorA);
    const firstVersion = service.latestSubmittedVersion(fixture.actorA);
    const firstSnapshot = rawSubmissionVersion(database, firstVersion.id);

    clock.value = new Date("2026-08-26T00:00:00.000Z");
    service.setFamilyDeadlineExtension(fixture.actorAdmin, {
      familyId: "family-a",
      submissionPeriodId: "period-2026-09",
      extendedDeadlineAt: "2026-08-27T14:59:59.000Z",
      reason: "再提出のための延長",
    });
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
  });
});

test("selects only the explicit parent target and switches it transactionally", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'open', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();

    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.period.id, "period-2026-09");
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      submissionPeriodId: "period-2026-10",
      days: daysWithPatch(dashboard, "child-a1", "2026-09-01", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboard.period.id, "period-2026-09");
    service.submitFamilySchedules(fixture.actorA, { submissionPeriodId: "period-2026-10" });
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM family_submissions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-10'",
    ).get().count, 0);
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
    assert.equal(dashboard.period.id, "period-2026-10");
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
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, true);
    assert.equal(dashboard.period.id, "period-2026-10");
    assert.equal(dashboard.period.editable, false);
    assert.throws(
      () => service.updateChildSchedule(fixture.actorA, "child-a1", {
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
    service.submitFamilySchedules(fixture.actorA);
    const secondSubmitted = service.latestSubmittedVersion(fixture.actorA);
    assert.equal(secondSubmitted.children.find((child) => child.childId === "child-a1").name, "佐藤 みらい");
    assert.deepEqual(rawSubmissionVersion(database, firstSubmitted.id), submittedRaw);
    assert.deepEqual(rawSubmissionVersion(database, confirmed.id), confirmedRaw);
    assert.deepEqual(rawSubmissionVersion(database, revision.id), revisionRaw);
  });
});

test("does not choose a parent target when it is unavailable or duplicated", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    database.prepare("UPDATE submission_periods SET status = 'draft' WHERE id = 'period-2026-09'").run();
    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, false);
    assert.equal(dashboard.periodCount, 1);

    database.prepare("UPDATE submission_periods SET status = 'open', is_parent_target = 0 WHERE id = 'period-2026-09'").run();
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, false);
    assert.equal(dashboard.periodCount, 0);

    // Reproduce an otherwise constrained corruption state only inside this disposable test database.
    database.exec("DROP INDEX uq_submission_periods_single_parent_target");
    database.prepare("UPDATE submission_periods SET is_parent_target = 1 WHERE id = 'period-2026-09'").run();
    database.prepare(
      `INSERT INTO submission_periods
       (id, target_month, deadline_at, status, is_parent_target, created_at, updated_at)
       VALUES ('period-2026-10', '2026-10', '2026-09-25T14:59:59.000Z', 'open', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, false);
    assert.equal(dashboard.periodCount, 2);
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
    assert.equal(parentWithExtension.period.extensionActive, true);
    assert.equal(parentWithExtension.period.deadlineSource, "family_extension");

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

    service.submitFamilySchedules(fixture.actorA);
    assert.equal(service.dashboard(fixture.actorA).submission.schoolModified, false);
    const versionCount = database.prepare(
      "SELECT COUNT(*) AS count FROM family_submission_versions WHERE family_id = 'family-a' AND submission_period_id = 'period-2026-09'",
    ).get().count;
    assert.equal(versionCount, 4);
  });
});

test("switches the parent target through the administrator API in one transaction", async () => {
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
    assert.equal(service.dashboard(fixture.actorA).period.id, "period-2026-10");
  });
});
