import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { generateTemporaryPassword, hashPassword } from "../lib/server/auth/security.mjs";
import { createFamilyScheduleService } from "../lib/server/family-schedule/service.mjs";
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
  };
  const familyAHash = await hashPassword(passwords.familyA);
  const familyBHash = await hashPassword(passwords.familyB);

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
    assert.equal(database.prepare("SELECT status, submitted_at FROM family_submissions WHERE family_id = 'family-a'").get().status, "draft");
    assert.equal(database.prepare("SELECT submitted_at FROM family_submissions WHERE family_id = 'family-a'").get().submitted_at, null);

    database.exec("DROP TRIGGER fail_submit_for_test");
    let dashboard = service.submitFamilySchedules(fixture.actorA);
    const firstSubmittedAt = dashboard.submission.submittedAt;
    assert.equal(dashboard.submission.status, "submitted");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM monthly_schedules WHERE status = 'submitted' AND child_id IN ('child-a1', 'child-a2')").get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM change_histories WHERE family_id = 'family-a' AND reason_text = '初回提出'").get().count, 1);

    clock.value = new Date("2026-08-21T00:00:00.000Z");
    dashboard = service.updateChildSchedule(fixture.actorA, "child-a1", {
      days: daysWithPatch(dashboard, "child-a1", "2026-09-02", { usageStatus: "off", arrivalTime: null, departureTime: null }),
    });
    assert.equal(dashboard.submission.revisionRequired, true);
    assert.equal(dashboard.submission.submittedAt, firstSubmittedAt);
    clock.value = new Date("2026-08-21T01:00:00.000Z");
    dashboard = service.submitFamilySchedules(fixture.actorA);
    assert.equal(dashboard.submission.status, "submitted");
    assert.notEqual(dashboard.submission.submittedAt, firstSubmittedAt);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM change_histories WHERE family_id = 'family-a' AND reason_text = '再提出'").get().count, 1);
    assert.ok(database.prepare("SELECT COUNT(*) AS count FROM change_histories WHERE family_id = 'family-a' AND target_date = '2026-09-02'").get().count >= 1);
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

test("does not choose a target month when active periods are missing or duplicated", async () => {
  await withScheduleDatabase(async ({ database, service, fixture }) => {
    database.prepare("UPDATE submission_periods SET status = 'draft' WHERE id = 'period-2026-09'").run();
    let dashboard = service.dashboard(fixture.actorA);
    assert.equal(dashboard.available, false);
    assert.equal(dashboard.periodCount, 0);

    // Reproduce an otherwise constrained corruption state only inside this disposable test database.
    database.exec("DROP INDEX uq_submission_periods_single_parent_target");
    database.prepare("UPDATE submission_periods SET status = 'open' WHERE id = 'period-2026-09'").run();
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
