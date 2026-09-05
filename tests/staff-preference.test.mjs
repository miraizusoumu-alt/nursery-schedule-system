import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, inspectDatabase, openDatabase, PROJECT_ROOT } from "../db/sqlite.mjs";
import { AuthError } from "../lib/server/auth/permissions.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { hashPassword } from "../lib/server/auth/security.mjs";
import { createStaffPreferenceService } from "../lib/server/staff-preference/service.mjs";
import { createStaffScheduleService } from "../lib/server/staff-schedule/service.mjs";
import { loadStaffCandidateProfiles } from "../lib/server/staffing/staff-candidate-repository.mjs";
import { authorizeProtectedPage, handleAuthApiRequest } from "../server/auth-http.mjs";
import { handleStaffPreferenceApiRequest } from "../server/staff-preference-http.mjs";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const ORIGIN = "https://nursery.example";

async function fixture(database) {
  const password = "Staff-test-Password-1";
  const adminPassword = "Admin-test-Password-1";
  const timestamp = NOW.toISOString();
  database.prepare(
    `INSERT INTO administrators
     (id, login_id, display_name, role, password_hash, must_change_password, credential_version, status, created_at, updated_at)
     VALUES ('admin', 'admin-test', '架空管理者', 'master', ?, 0, 1, 'active', ?, ?)`,
  ).run(await hashPassword(adminPassword), timestamp, timestamp);
  for (const [id, code] of [["staff-a", "ST-A"], ["staff-b", "ST-B"]]) {
    database.prepare(
      `INSERT INTO staff_members
       (id, staff_code, name, employment_start_date, status, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01', 'active', ?, ?)`,
    ).run(id, code, `架空職員${code.slice(-1)}`, timestamp, timestamp);
  }
  const auth = createAuthService({ database, now: () => NOW });
  const admin = { type: "administrator", id: "admin", role: "master", loginId: "admin-test", displayName: "架空管理者", mustChangePassword: false };
  const first = await auth.issueStaffAccount(admin, { staffId: "staff-a", loginId: "staff-a-login" });
  const second = await auth.issueStaffAccount(admin, { staffId: "staff-b", loginId: "staff-b-login" });
  database.prepare("UPDATE staff_accounts SET password_hash = ? WHERE id = ?").run(await hashPassword(password), first.accountId);
  database.prepare("UPDATE staff_accounts SET password_hash = ? WHERE id = ?").run(await hashPassword(password), second.accountId);
  const preferences = createStaffPreferenceService({ database, now: () => NOW });
  preferences.savePeriod(admin, { targetMonth: "2026-09", deadlineAt: "2026-08-31T14:59:59.000Z", status: "open" });
  return { admin, auth, preferences, password, first, second };
}

async function withDatabase(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-preference-"));
  const databasePath = resolve(directory, "test.sqlite");
  const database = openDatabase(databasePath);
  try {
    await applyMigrations(database);
    await run({ database, databasePath, ...await fixture(database) });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function login(auth, loginId, password) {
  return auth.login({ scope: "staff", loginId, password, source: `test-${loginId}` });
}

function staffRequest(path, session, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("cookie", `nursery_session=${session.session.token}; nursery_csrf=${session.session.csrfToken}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.csrf !== false && options.method && options.method !== "GET") {
    headers.set("origin", ORIGIN);
    headers.set("x-csrf-token", session.session.csrfToken);
  }
  return new Request(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

test("authenticates staff with isolated actor scope, credential invalidation, and protected routes", async () => {
  await withDatabase(async ({ database, auth, password, first }) => {
    const signedIn = await login(auth, "staff-a-login", password);
    assert.deepEqual(
      { type: signedIn.actor.type, id: signedIn.actor.id, staffId: signedIn.actor.staffId, mustChangePassword: signedIn.actor.mustChangePassword },
      { type: "staff", id: first.accountId, staffId: "staff-a", mustChangePassword: false },
    );
    assert.notEqual(database.prepare("SELECT password_hash FROM staff_accounts WHERE id = ?").get(first.accountId).password_hash, password);
    assert.equal(authorizeProtectedPage(staffRequest("/staff/preferences", signedIn), auth), null);
    assert.equal(authorizeProtectedPage(staffRequest("/admin/schedules", signedIn), auth).status, 403);
    assert.equal(authorizeProtectedPage(staffRequest("/parent/schedule", signedIn), auth).status, 403);
    await assert.rejects(() => login(auth, "staff-a-login", "incorrect-password"), (error) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS");

    database.prepare("UPDATE staff_accounts SET credential_version = credential_version + 1 WHERE id = ?").run(first.accountId);
    assert.equal(auth.sessionByToken(signedIn.session.token), null);
    database.prepare("UPDATE staff_accounts SET disabled_at = ? WHERE id = ?").run(NOW.toISOString(), first.accountId);
    await assert.rejects(() => login(auth, "staff-a-login", password), (error) => error instanceof AuthError && error.code === "ACCOUNT_UNAVAILABLE");
  });
});

test("allows staff to change a hashed password and invalidates the prior session", async () => {
  await withDatabase(async ({ database, auth, password, first }) => {
    const signedIn = await login(auth, "staff-a-login", password);
    const changed = await auth.changePassword({
      session: auth.sessionByToken(signedIn.session.token),
      currentPassword: password,
      newPassword: "Staff-new-Password-2",
    });
    assert.equal(changed.actor.type, "staff");
    assert.equal(auth.sessionByToken(signedIn.session.token), null);
    assert.ok(auth.sessionByToken(changed.session.token));
    assert.notEqual(database.prepare("SELECT password_hash FROM staff_accounts WHERE id = ?").get(first.accountId).password_hash, "Staff-new-Password-2");
    await assert.rejects(() => login(auth, "staff-a-login", password), (error) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS");
    assert.equal((await login(auth, "staff-a-login", "Staff-new-Password-2")).actor.staffId, "staff-a");
  });
});

test("reissues a staff password once and invalidates every existing staff session", async () => {
  await withDatabase(async ({ auth, password, second, admin }) => {
    const signedIn = await login(auth, "staff-b-login", password);
    const credential = await auth.reissueStaffPassword(admin, "staff-b");
    assert.equal(credential.accountId, second.accountId);
    assert.equal(auth.sessionByToken(signedIn.session.token), null);
    await assert.rejects(() => login(auth, "staff-b-login", password), (error) => error instanceof AuthError && error.code === "INVALID_CREDENTIALS");
    assert.equal((await login(auth, credential.loginId, credential.temporaryPassword)).actor.staffId, "staff-b");
  });
});

test("sets secure staff cookies on HTTPS login without returning password hashes", async () => {
  await withDatabase(async ({ auth, password }) => {
    const response = await handleAuthApiRequest(new Request(`${ORIGIN}/api/auth/login/staff`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ loginId: "staff-a-login", password }),
    }), { service: auth, runtimeSecureCookies: true });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.actor.type, "staff");
    assert.equal(body.actor.staffId, "staff-a");
    assert.equal(body.redirectTo, "/staff/preferences");
    assert.equal(Object.hasOwn(body.actor, "passwordHash"), false);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /nursery_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
  });
});

test("keeps staff drafts private and out of canonical generator input until atomic submission", async () => {
  await withDatabase(async ({ database, auth, preferences, password, first }) => {
    const signedIn = await login(auth, "staff-a-login", password);
    const actor = signedIn.actor;
    const initial = preferences.ownDashboard(actor, { targetMonth: "2026-09", staffId: "staff-b" });
    assert.equal(initial.actor.staffId, "staff-a");
    assert.equal(initial.submission.status, "unentered");

    const draft = preferences.saveOwnDraft(actor, {
      targetMonth: "2026-09",
      staffId: "staff-b",
      revision: 0,
      expectedOfficialPreferencesHash: initial.officialPreferencesHash,
      preferences: [
        { date: "2026-09-03", preferenceType: "day_off" },
        { date: "2026-09-04", preferenceType: "work_time", startTime: "10:00", endTime: "15:00" },
      ],
    });
    assert.equal(draft.submission.status, "draft");
    assert.equal(draft.submission.revision, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_preferences").get().count, 0);
    assert.deepEqual(loadStaffCandidateProfiles(database).find((staff) => staff.id === "staff-a").schedulePreferences, []);

    const submitted = preferences.submitOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: 1,
      staffId: "staff-b",
      expectedOfficialPreferencesHash: draft.officialPreferencesHash,
    });
    assert.equal(submitted.submission.status, "submitted");
    assert.equal(submitted.submission.revision, 2);
    const canonical = database.prepare(
      `SELECT staff_id, date, preference_type, start_time, end_time,
              created_by_administrator_id, created_by_staff_account_id, updated_by_staff_account_id
       FROM staff_schedule_preferences ORDER BY date`,
    ).all();
    assert.equal(canonical.length, 2);
    assert.ok(canonical.every((row) => row.staff_id === "staff-a" && row.created_by_administrator_id === null
      && row.created_by_staff_account_id === first.accountId && row.updated_by_staff_account_id === first.accountId));
    assert.equal(loadStaffCandidateProfiles(database).find((staff) => staff.id === "staff-a").schedulePreferences.length, 2);
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: 2,
        expectedOfficialPreferencesHash: submitted.officialPreferencesHash,
        preferences: [],
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_ALREADY_SUBMITTED",
    );
  });
});

test("enforces shared time validation, deadline, closed period, and optimistic conflicts", async () => {
  await withDatabase(async ({ database, auth, preferences, password, admin }) => {
    const actor = (await login(auth, "staff-a-login", password)).actor;
    const initial = preferences.ownDashboard(actor, { targetMonth: "2026-09" });
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: 0,
        expectedOfficialPreferencesHash: initial.officialPreferencesHash,
        preferences: [{ date: "2026-09-01", preferenceType: "work_time", startTime: "09:05", endTime: "12:00" }],
      }),
      (error) => error instanceof AuthError && error.code === "INVALID_TIME",
    );
    const saved = preferences.saveOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: 0,
      expectedOfficialPreferencesHash: initial.officialPreferencesHash,
      preferences: [{ date: "2026-09-01", preferenceType: "work_time", startTime: "09:00", endTime: "12:00" }],
    });
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: 0,
        expectedOfficialPreferencesHash: saved.officialPreferencesHash,
        preferences: [],
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_REVISION_CONFLICT",
    );
    database.prepare(
      `INSERT INTO staff_schedule_preferences
       (id, staff_id, date, preference_type, created_by_administrator_id, updated_by_administrator_id)
       VALUES ('admin-change', 'staff-a', '2026-09-02', 'day_off', 'admin', 'admin')`,
    ).run();
    assert.throws(
      () => preferences.submitOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: saved.submission.revision,
        expectedOfficialPreferencesHash: saved.officialPreferencesHash,
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_REVISION_CONFLICT",
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_schedule_preferences").get().count, 1);
    assert.equal(database.prepare("SELECT status FROM staff_preference_submissions WHERE staff_id = 'staff-a'").get().status, "draft");

    preferences.savePeriod(admin, { targetMonth: "2026-09", deadlineAt: "2026-08-31T14:59:59.000Z", status: "closed" });
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: saved.submission.revision,
        expectedOfficialPreferencesHash: saved.officialPreferencesHash,
        preferences: [],
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_PERIOD_CLOSED",
    );
    preferences.savePeriod(admin, { targetMonth: "2026-09", deadlineAt: "2026-07-31T14:59:59.000Z", status: "open" });
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: saved.submission.revision,
        expectedOfficialPreferencesHash: saved.officialPreferencesHash,
        preferences: [],
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_DEADLINE_PASSED",
    );
  });
});

test("requires the official hash from the initial screen and preserves a later administrator edit", async () => {
  await withDatabase(async ({ database, auth, preferences, password }) => {
    const actor = (await login(auth, "staff-a-login", password)).actor;
    const initial = preferences.ownDashboard(actor, { targetMonth: "2026-09" });
    assert.match(initial.officialPreferencesHash, /^[a-f0-9]{64}$/);
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: 0,
        preferences: [{ date: "2026-09-01", preferenceType: "day_off" }],
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_HASH_REQUIRED" && error.status === 409,
    );

    database.prepare(
      `INSERT INTO staff_schedule_preferences
       (id, staff_id, date, preference_type, created_by_administrator_id, updated_by_administrator_id)
       VALUES ('admin-first-save', 'staff-a', '2026-09-02', 'day_off', 'admin', 'admin')`,
    ).run();
    assert.throws(
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: 0,
        expectedOfficialPreferencesHash: initial.officialPreferencesHash,
        preferences: [{ date: "2026-09-01", preferenceType: "day_off" }],
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_REVISION_CONFLICT" && error.status === 409,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_preference_submissions").get().count, 0);
    assert.deepEqual(
      database.prepare(
        `SELECT id, date, preference_type, created_by_administrator_id
         FROM staff_schedule_preferences WHERE staff_id = 'staff-a' ORDER BY date`,
      ).all().map((row) => ({ ...row })),
      [{ id: "admin-first-save", date: "2026-09-02", preference_type: "day_off", created_by_administrator_id: "admin" }],
    );
  });
});

test("serializes the initial hash check and draft creation against an administrator writer", async () => {
  await withDatabase(async ({ database, databasePath, auth, preferences, password }) => {
    const actor = (await login(auth, "staff-a-login", password)).actor;
    const initial = preferences.ownDashboard(actor, { targetMonth: "2026-09" });
    const administratorConnection = openDatabase(databasePath);
    try {
      administratorConnection.exec("BEGIN IMMEDIATE");
      administratorConnection.prepare(
        `INSERT INTO staff_schedule_preferences
         (id, staff_id, date, preference_type, created_by_administrator_id, updated_by_administrator_id)
         VALUES ('admin-race', 'staff-a', '2026-09-06', 'day_off', 'admin', 'admin')`,
      ).run();
      database.exec("PRAGMA busy_timeout = 1");
      assert.throws(
        () => preferences.saveOwnDraft(actor, {
          targetMonth: "2026-09",
          revision: 0,
          expectedOfficialPreferencesHash: initial.officialPreferencesHash,
          preferences: [{ date: "2026-09-01", preferenceType: "day_off" }],
        }),
        /locked|busy/i,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_preference_submissions").get().count, 0);
      administratorConnection.exec("COMMIT");
      database.exec("PRAGMA busy_timeout = 5000");
      assert.throws(
        () => preferences.saveOwnDraft(actor, {
          targetMonth: "2026-09",
          revision: 0,
          expectedOfficialPreferencesHash: initial.officialPreferencesHash,
          preferences: [{ date: "2026-09-01", preferenceType: "day_off" }],
        }),
        (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_REVISION_CONFLICT",
      );
      assert.equal(database.prepare("SELECT id FROM staff_schedule_preferences WHERE id = 'admin-race'").get().id, "admin-race");
    } finally {
      if (administratorConnection.inTransaction) administratorConnection.exec("ROLLBACK");
      administratorConnection.close();
      database.exec("PRAGMA busy_timeout = 5000");
    }
  });
});

test("shows a persistent conflict and explicitly resets only the own draft to current official preferences", async () => {
  await withDatabase(async ({ database, auth, preferences, password, admin }) => {
    const actor = (await login(auth, "staff-a-login", password)).actor;
    const initial = preferences.ownDashboard(actor, { targetMonth: "2026-09" });
    const saved = preferences.saveOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: 0,
      expectedOfficialPreferencesHash: initial.officialPreferencesHash,
      preferences: [{ date: "2026-09-01", preferenceType: "day_off" }],
    });
    database.prepare(
      `INSERT INTO staff_schedule_preferences
       (id, staff_id, date, preference_type, created_by_administrator_id, updated_by_administrator_id)
       VALUES ('admin-conflict', 'staff-a', '2026-09-02', 'day_off', 'admin', 'admin')`,
    ).run();

    for (const action of [
      () => preferences.saveOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: saved.submission.revision,
        expectedOfficialPreferencesHash: saved.officialPreferencesHash,
        preferences: saved.preferences,
      }),
      () => preferences.submitOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: saved.submission.revision,
        expectedOfficialPreferencesHash: saved.officialPreferencesHash,
      }),
    ]) {
      assert.throws(action, (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_REVISION_CONFLICT");
    }
    assert.deepEqual(
      database.prepare("SELECT id, preference_type FROM staff_schedule_preferences ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: "admin-conflict", preference_type: "day_off" }],
    );
    assert.deepEqual(
      { ...database.prepare("SELECT status, submitted_at FROM staff_preference_submissions WHERE staff_id = 'staff-a'").get() },
      { status: "draft", submitted_at: null },
    );

    const reloaded = preferences.ownDashboard(actor, { targetMonth: "2026-09" });
    assert.equal(reloaded.submission.hasConflict, true);
    assert.equal(reloaded.submission.basePreferencesHash, saved.submission.basePreferencesHash);
    assert.notEqual(reloaded.officialPreferencesHash, reloaded.submission.basePreferencesHash);
    assert.deepEqual(reloaded.preferences, saved.preferences);
    assert.equal(
      database.prepare("SELECT base_preferences_hash FROM staff_preference_submissions WHERE staff_id = 'staff-a'").get().base_preferences_hash,
      saved.submission.basePreferencesHash,
    );

    const reset = preferences.resetOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: reloaded.submission.revision,
      expectedOfficialPreferencesHash: reloaded.officialPreferencesHash,
      staffId: "staff-b",
    });
    assert.equal(reset.submission.hasConflict, false);
    assert.equal(reset.submission.basePreferencesHash, reset.officialPreferencesHash);
    assert.deepEqual(reset.preferences, [{ date: "2026-09-02", preferenceType: "day_off", startTime: null, endTime: null }]);
    assert.deepEqual(
      database.prepare("SELECT id, preference_type FROM staff_schedule_preferences ORDER BY id").all().map((row) => ({ ...row })),
      [{ id: "admin-conflict", preference_type: "day_off" }],
    );

    const resumed = preferences.saveOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: reset.submission.revision,
      expectedOfficialPreferencesHash: reset.officialPreferencesHash,
      preferences: [...reset.preferences, { date: "2026-09-04", preferenceType: "day_off" }],
    });
    const schedule = createStaffScheduleService({ database, now: () => NOW });
    schedule.saveStaffPreference(admin, {
      targetMonth: "2026-09",
      staffId: "staff-a",
      date: "2026-09-02",
      preferenceType: "work_time",
      startTime: "09:00",
      endTime: "15:00",
    });
    assert.throws(
      () => preferences.submitOwnDraft(actor, {
        targetMonth: "2026-09",
        revision: resumed.submission.revision,
        expectedOfficialPreferencesHash: resumed.officialPreferencesHash,
      }),
      (error) => error instanceof AuthError && error.code === "STAFF_PREFERENCE_REVISION_CONFLICT",
    );
    assert.deepEqual(
      { ...database.prepare(
        `SELECT preference_type, start_time, end_time, updated_by_administrator_id
         FROM staff_schedule_preferences WHERE id = 'admin-conflict'`,
      ).get() },
      { preference_type: "work_time", start_time: "09:00", end_time: "15:00", updated_by_administrator_id: "admin" },
    );
    assert.deepEqual(
      { ...database.prepare("SELECT status, submitted_at FROM staff_preference_submissions WHERE staff_id = 'staff-a'").get() },
      { status: "draft", submitted_at: null },
    );
  });
});

test("applies CSRF and Origin checks and never exposes another staff draft", async () => {
  await withDatabase(async ({ auth, preferences, password }) => {
    const first = await login(auth, "staff-a-login", password);
    const second = await login(auth, "staff-b-login", password);
    const firstDashboard = preferences.ownDashboard(first.actor, { targetMonth: "2026-09" });
    const missingCsrf = await handleStaffPreferenceApiRequest(staffRequest("/api/staff/preferences/draft", first, {
      method: "PUT", csrf: false, body: { targetMonth: "2026-09", revision: 0, preferences: [] },
    }), { service: preferences, authService: auth });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).code, "ORIGIN_REQUIRED");

    const wrongOrigin = staffRequest("/api/staff/preferences/draft", first, {
      method: "PUT", body: { targetMonth: "2026-09", revision: 0, preferences: [] },
    });
    const wrongHeaders = new Headers(wrongOrigin.headers);
    wrongHeaders.set("origin", "https://other.example");
    const rejectedOrigin = await handleStaffPreferenceApiRequest(new Request(wrongOrigin.url, {
      method: "PUT",
      headers: wrongHeaders,
      body: JSON.stringify({ targetMonth: "2026-09", revision: 0, preferences: [] }),
    }), { service: preferences, authService: auth });
    assert.equal(rejectedOrigin.status, 403);
    assert.equal((await rejectedOrigin.json()).code, "ORIGIN_MISMATCH");

    const resetWithoutCsrf = await handleStaffPreferenceApiRequest(staffRequest("/api/staff/preferences/reset", first, {
      method: "POST", csrf: false, body: { targetMonth: "2026-09", revision: 0 },
    }), { service: preferences, authService: auth });
    assert.equal(resetWithoutCsrf.status, 403);
    assert.equal((await resetWithoutCsrf.json()).code, "ORIGIN_REQUIRED");

    const resetWrongOrigin = staffRequest("/api/staff/preferences/reset", first, {
      method: "POST", body: { targetMonth: "2026-09", revision: 0 },
    });
    const resetWrongHeaders = new Headers(resetWrongOrigin.headers);
    resetWrongHeaders.set("origin", "https://other.example");
    const rejectedResetOrigin = await handleStaffPreferenceApiRequest(new Request(resetWrongOrigin.url, {
      method: "POST",
      headers: resetWrongHeaders,
      body: JSON.stringify({ targetMonth: "2026-09", revision: 0 }),
    }), { service: preferences, authService: auth });
    assert.equal(rejectedResetOrigin.status, 403);
    assert.equal((await rejectedResetOrigin.json()).code, "ORIGIN_MISMATCH");

    const saved = await handleStaffPreferenceApiRequest(staffRequest("/api/staff/preferences/draft", first, {
      method: "PUT",
      body: {
        targetMonth: "2026-09",
        revision: 0,
        staffId: "staff-b",
        expectedOfficialPreferencesHash: firstDashboard.officialPreferencesHash,
        preferences: [{ date: "2026-09-05", preferenceType: "day_off" }],
      },
    }), { service: preferences, authService: auth });
    assert.equal(saved.status, 200);
    const secondView = await handleStaffPreferenceApiRequest(
      staffRequest("/api/staff/preferences?targetMonth=2026-09&staffId=staff-a", second),
      { service: preferences, authService: auth },
    );
    const secondBody = await secondView.json();
    assert.equal(secondBody.dashboard.actor.staffId, "staff-b");
    assert.deepEqual(secondBody.dashboard.preferences, []);

    const forbiddenReset = await handleStaffPreferenceApiRequest(staffRequest("/api/staff/preferences/reset", second, {
      method: "POST",
      body: {
        targetMonth: "2026-09",
        revision: 0,
        expectedOfficialPreferencesHash: secondBody.dashboard.officialPreferencesHash,
        staffId: "staff-a",
      },
    }), { service: preferences, authService: auth });
    assert.equal(forbiddenReset.status, 409);
    assert.equal((await forbiddenReset.json()).code, "STAFF_PREFERENCE_DRAFT_REQUIRED");
    assert.equal(preferences.ownDashboard(first.actor, { targetMonth: "2026-09" }).preferences.length, 1);

    const forbiddenAdmin = await handleStaffPreferenceApiRequest(
      staffRequest("/api/admin/staff-preferences?targetMonth=2026-09", first),
      { service: preferences, authService: auth },
    );
    assert.equal(forbiddenAdmin.status, 403);

    const logout = await handleAuthApiRequest(staffRequest("/api/auth/logout", first, { method: "POST", body: {} }), { service: auth });
    assert.equal(logout.status, 200);
    assert.equal(auth.sessionByToken(first.session.token), null);
  });
});

test("allows administrator edits after submission while preserving creator attribution", async () => {
  await withDatabase(async ({ database, auth, preferences, password, admin }) => {
    const actor = (await login(auth, "staff-a-login", password)).actor;
    const initial = preferences.ownDashboard(actor, { targetMonth: "2026-09" });
    const saved = preferences.saveOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: 0,
      expectedOfficialPreferencesHash: initial.officialPreferencesHash,
      preferences: [{ date: "2026-09-03", preferenceType: "day_off" }],
    });
    preferences.submitOwnDraft(actor, {
      targetMonth: "2026-09",
      revision: saved.submission.revision,
      expectedOfficialPreferencesHash: saved.officialPreferencesHash,
    });
    const schedule = createStaffScheduleService({ database, now: () => NOW });
    schedule.saveStaffPreference(admin, { targetMonth: "2026-09", staffId: "staff-a", date: "2026-09-03", preferenceType: "work_time", startTime: "09:00", endTime: "15:00" });
    const row = database.prepare(
      `SELECT created_by_staff_account_id, updated_by_staff_account_id, updated_by_administrator_id
       FROM staff_schedule_preferences WHERE staff_id = 'staff-a' AND date = '2026-09-03'`,
    ).get();
    assert.ok(row.created_by_staff_account_id);
    assert.equal(row.updated_by_staff_account_id, null);
    assert.equal(row.updated_by_administrator_id, "admin");
  });
});

test("preserves pre-0013 authentication, preferences, sessions, attempts, and operation logs", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-migration-"));
  const migrationsPath = resolve(directory, "migrations");
  const database = openDatabase(resolve(directory, "migration.sqlite"));
  try {
    await mkdir(migrationsPath);
    const names = (await readdir(resolve(PROJECT_ROOT, "drizzle")))
      .filter((name) => name.endsWith(".sql") && name < "0013_")
      .sort();
    for (const name of names) await cp(resolve(PROJECT_ROOT, "drizzle", name), resolve(migrationsPath, name));
    await applyMigrations(database, migrationsPath);
    database.prepare("INSERT INTO administrators (id, login_id, display_name, role, status) VALUES ('a', 'admin-a', '架空管理者', 'master', 'active')").run();
    database.prepare("INSERT INTO staff_members (id, staff_code, name, employment_start_date, status) VALUES ('s', 'ST-X', '架空職員', '2026-01-01', 'active')").run();
    database.prepare(
      `INSERT INTO staff_schedule_preferences
       (id, staff_id, date, preference_type, created_by_administrator_id, updated_by_administrator_id)
       VALUES ('p', 's', '2026-09-01', 'day_off', 'a', 'a')`,
    ).run();
    database.prepare(
      `INSERT INTO auth_sessions
       (id, subject_type, administrator_id, token_hash, csrf_token_hash, credential_version, issued_at, expires_at, last_seen_at)
       VALUES ('session', 'administrator', 'a', 'token', 'csrf', 1, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    database.prepare("INSERT INTO auth_login_attempts (id, login_scope, login_id_hash, source_hash, success, attempted_at) VALUES ('attempt', 'administrator', 'login', 'source', 1, '2026-01-01T00:00:00.000Z')").run();
    database.prepare("INSERT INTO operation_logs (id, actor_type, actor_id, operation, target_type) VALUES ('log', 'administrator', 'a', 'test', 'test')").run();
    const before = Object.fromEntries(["staff_schedule_preferences", "auth_sessions", "auth_login_attempts", "operation_logs"].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    const migrated = await applyMigrations(database);
    assert.deepEqual(migrated.applied, ["0013_grey_random.sql"]);
    const after = Object.fromEntries(Object.keys(before).map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    assert.deepEqual(after, before);
    const preference = database.prepare("SELECT created_by_administrator_id, created_by_staff_account_id FROM staff_schedule_preferences WHERE id = 'p'").get();
    assert.deepEqual({ ...preference }, { created_by_administrator_id: "a", created_by_staff_account_id: null });
    assert.equal(inspectDatabase(database).integrityOk, true);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
