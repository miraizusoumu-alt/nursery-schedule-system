import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { AuthError } from "../lib/server/auth/permissions.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { generateTemporaryPassword, hashPassword } from "../lib/server/auth/security.mjs";
import { createStaffManagementService } from "../lib/server/staff-management/service.mjs";
import { handleStaffManagementApiRequest } from "../server/staff-management-http.mjs";

function allWeekdays(monday = { startTime: "09:00", endTime: "16:00" }) {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    available: weekday === 1,
    startTime: weekday === 1 ? monday.startTime : null,
    endTime: weekday === 1 ? monday.endTime : null,
  }));
}

async function withStaffDatabase(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-staff-management-"));
  const database = openDatabase(resolve(directory, "staff.sqlite"));
  const now = new Date("2026-08-20T00:00:00.000Z");
  try {
    await applyMigrations(database);
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    const timestamp = now.toISOString();
    database.prepare(
      `INSERT INTO families (id, family_code, display_name, status, created_at, updated_at)
       VALUES ('fictional-family', 'FICTIONAL-FAMILY', '架空職員テスト家庭', 'active', ?, ?)`,
    ).run(timestamp, timestamp);
    database.prepare(
      `INSERT INTO family_accounts
       (id, family_id, login_id, password_hash, must_change_password, credential_version, created_at, updated_at)
       VALUES ('fictional-family-account', 'fictional-family', 'fictional-family-login', ?, 0, 1, ?, ?)`,
    ).run(passwordHash, timestamp, timestamp);
    for (const [id, loginId, displayName, role] of [
      ["normal-staff-admin", "normal-staff-admin", "架空職員管理者", "normal"],
      ["master-staff-admin", "master-staff-admin", "架空マスター管理者", "master"],
    ]) {
      database.prepare(
        `INSERT INTO administrators
         (id, login_id, display_name, role, password_hash, must_change_password, credential_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, 'active', ?, ?)`,
      ).run(id, loginId, displayName, role, passwordHash, timestamp, timestamp);
    }
    const authService = createAuthService({ database, now: () => now });
    const service = createStaffManagementService({ database, now: () => now });
    await run({ database, authService, password, service });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function expectAuthError(run, code) {
  assert.throws(run, (error) => error instanceof AuthError && error.code === code);
}

async function session(authService, scope, loginId, password) {
  const result = await authService.login({ scope, loginId, password, source: `test-${scope}-${loginId}` });
  return {
    cookie: `nursery_session=${result.session.token}; nursery_csrf=${result.session.csrfToken}`,
    csrfToken: result.session.csrfToken,
  };
}

function apiRequest(path, auth = null, { method = "GET", body, csrf = true } = {}) {
  const headers = new Headers();
  if (auth) headers.set("cookie", auth.cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    headers.set("origin", "http://localhost");
    if (auth && csrf) headers.set("x-csrf-token", auth.csrfToken);
  }
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("auto-numbers staff codes and updates staff without requiring code input", async () => {
  await withStaffDatabase(async ({ database, service }) => {
    const normal = { type: "administrator", id: "normal-staff-admin", role: "normal", mustChangePassword: false };
    const master = { type: "administrator", id: "master-staff-admin", role: "master", mustChangePassword: false };
    const family = { type: "family", id: "fictional-family-account", familyId: "fictional-family", mustChangePassword: false };
    let management = service.createStaff(normal, {
      name: "架空 花子", employmentStartDate: "2026-04-01", status: "active",
    });
    const staffId = management.staff[0].id;
    assert.equal(management.staff[0].staffCode, "ST0001");

    management = service.createStaff(normal, {
      name: "架空 次郎", employmentStartDate: "2026-04-01",
    });
    assert.deepEqual(management.staff.map(({ staffCode }) => staffCode), ["ST0001", "ST0002"]);
    assert.equal(new Set(management.staff.map(({ staffCode }) => staffCode)).size, 2);
    expectAuthError(() => service.createStaff(normal, {
      name: "架空 期間不正", employmentStartDate: "2026-05-01", employmentEndDate: "2026-04-30",
    }), "INVALID_DATE_RANGE");

    management = service.updateStaff(master, staffId, {
      name: "架空 花子（更新）", employmentStartDate: "2026-04-01",
      employmentEndDate: "2027-03-31", status: "inactive",
    });
    const updated = management.staff.find(({ id }) => id === staffId);
    assert.equal(updated.name, "架空 花子（更新）");
    assert.equal(updated.staffCode, "ST0001");
    assert.equal(updated.status, "inactive");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE operation LIKE 'staff_member.%'").get().count, 3);
    expectAuthError(() => service.staffManagement(family), "FORBIDDEN");
  });
});

test("stores multiple responsibility categories and rejects invalid categories or missing staff", async () => {
  await withStaffDatabase(async ({ database, service }) => {
    const actor = { type: "administrator", id: "normal-staff-admin", role: "normal", mustChangePassword: false };
    const staffId = service.createStaff(actor, {
      name: "架空 資格", employmentStartDate: "2026-04-01",
    }).staff[0].id;
    const management = service.addQualification(actor, staffId, {
      qualificationType: "保育士", validFrom: "2026-04-01", validTo: "2031-03-31",
    });
    assert.deepEqual(management.staff[0].qualifications.map(({ qualificationType, validFrom, validTo }) => ({ qualificationType, validFrom, validTo })), [
      { qualificationType: "保育士", validFrom: "2026-04-01", validTo: "2031-03-31" },
    ]);
    const multiple = service.addResponsibilities(actor, staffId, {
      responsibilityTypes: ["園長", "マネージャー", "配膳"], validFrom: "2026-04-01",
    });
    assert.deepEqual(
      multiple.staff[0].qualifications.map(({ qualificationType }) => qualificationType).sort(),
      ["マネージャー", "保育士", "園長", "配膳"].sort(),
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'staff_responsibilities.created'").get().count,
      1,
    );
    expectAuthError(() => service.addResponsibilities(actor, staffId, {
      responsibilityTypes: ["看護師"], validFrom: "2026-04-01",
    }), "INVALID_RESPONSIBILITY_CATEGORY");
    expectAuthError(() => service.addQualification(actor, "missing-staff", {
      qualificationType: "看護師", validFrom: "2026-04-01",
    }), "NOT_FOUND");
  });
});

test("preserves work-condition versions and validates periods, weekdays, and time ranges", async () => {
  await withStaffDatabase(async ({ database, service }) => {
    const actor = { type: "administrator", id: "normal-staff-admin", role: "normal", mustChangePassword: false };
    const staffId = service.createStaff(actor, {
      name: "架空 条件", employmentStartDate: "2026-04-01",
    }).staff[0].id;
    service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2026-04-01", validTo: "2026-09-30", employmentType: "非常勤",
      monthlyMinutesLimit: 7200, maxConsecutiveDays: 4, availability: allWeekdays(),
    });
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2026-07-01", validTo: "2026-12-31", employmentType: "非常勤", availability: allWeekdays(),
    }), "OVERLAPPING_WORK_CONDITION");
    const management = service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2026-10-01", employmentType: "常勤", monthlyMinutesLimit: 9600,
      maxConsecutiveDays: 5, availability: allWeekdays({ startTime: "08:30", endTime: "17:30" }),
    });
    assert.equal(management.staff[0].conditions.length, 2);
    assert.equal(management.staff[0].conditions[0].employmentType, "非常勤");
    assert.equal(management.staff[0].conditions[1].availability.length, 7);
    assert.deepEqual(management.staff[0].conditions[1].availability[0], {
      weekday: 0, available: false, startTime: null, endTime: null,
    });
    assert.deepEqual(management.staff[0].conditions[1].availability[1], {
      weekday: 1, available: true, startTime: "08:30", endTime: "17:30",
    });

    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", validTo: "2027-03-31", employmentType: "常勤", availability: allWeekdays(),
    }), "INVALID_DATE_RANGE");
    const invalidWeekdays = allWeekdays();
    invalidWeekdays[6] = { weekday: 7, available: false, startTime: null, endTime: null };
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "常勤", availability: invalidWeekdays,
    }), "INVALID_WEEKDAY");
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "常勤",
      availability: allWeekdays({ startTime: "16:00", endTime: "16:00" }),
    }), "INVALID_TIME_RANGE");
    for (const monday of [
      { startTime: "06:15", endTime: "17:00" },
      { startTime: "06:30", endTime: "20:45" },
      { startTime: "09:10", endTime: "17:00" },
    ]) {
      expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
        validFrom: "2027-04-01", employmentType: "常勤", availability: allWeekdays(monday),
      }), "INVALID_TIME");
    }
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "短時間", availability: allWeekdays(),
    }), "INVALID_EMPLOYMENT_TYPE");
    assert.throws(() => database.prepare(
      `INSERT INTO staff_weekly_availability
       (work_condition_version_id, weekday, available, start_time, end_time)
       VALUES (?, 6, 0, '09:00', '16:00')`,
    ).run(management.staff[0].conditions[1].id));
  });
});

test("protects staff-management HTTP APIs with administrator sessions and CSRF", async () => {
  await withStaffDatabase(async ({ authService, password, service }) => {
    const unauthenticated = await handleStaffManagementApiRequest(apiRequest("/api/admin/staff"), { service, authService });
    assert.equal(unauthenticated.status, 401);

    const family = await session(authService, "family", "fictional-family-login", password);
    const forbidden = await handleStaffManagementApiRequest(apiRequest("/api/admin/staff", family), { service, authService });
    assert.equal(forbidden.status, 403);

    const normal = await session(authService, "administrator", "normal-staff-admin", password);
    const missingCsrf = await handleStaffManagementApiRequest(
      apiRequest("/api/admin/staff", normal, {
        method: "POST", csrf: false,
        body: { name: "架空 CSRF", employmentStartDate: "2026-04-01" },
      }),
      { service, authService },
    );
    assert.equal(missingCsrf.status, 403);

    const created = await handleStaffManagementApiRequest(
      apiRequest("/api/admin/staff", normal, {
        method: "POST", body: { name: "架空 API職員", employmentStartDate: "2026-04-01" },
      }),
      { service, authService },
    );
    assert.equal(created.status, 201);
    assert.equal((await created.json()).management.staff[0].staffCode, "ST0001");

    const master = await session(authService, "administrator", "master-staff-admin", password);
    const listed = await handleStaffManagementApiRequest(apiRequest("/api/admin/staff", master), { service, authService });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).management.staff.length, 1);

    const staffId = service.staffManagement({ type: "administrator", id: "master-staff-admin", role: "master", mustChangePassword: false }).staff[0].id;
    const responsibilities = await handleStaffManagementApiRequest(
      apiRequest(`/api/admin/staff/${staffId}/responsibilities`, master, {
        method: "POST", body: { responsibilityTypes: ["保育士", "配膳"], validFrom: "2026-04-01" },
      }),
      { service, authService },
    );
    assert.equal(responsibilities.status, 201);
    assert.deepEqual((await responsibilities.json()).management.staff[0].qualifications.map(({ qualificationType }) => qualificationType).sort(), ["保育士", "配膳"]);
  });
});
