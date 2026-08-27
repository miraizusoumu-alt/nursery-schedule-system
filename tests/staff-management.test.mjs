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

function partTimeConditions(overrides = {}) {
  return {
    weeklyMinutesLimit: 20 * 60,
    weeklyMinutesLimitType: "exclusive",
    preferredWeeklyWorkDaysMin: 3,
    weeklyWorkDaysMax: 4,
    dailyWorkMinutesMin: 3 * 60,
    dailyWorkMinutesMax: 5 * 60,
    ...overrides,
  };
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

test("stores roles and legal qualifications separately with editable inclusive periods", async () => {
  await withStaffDatabase(async ({ database, service }) => {
    const actor = { type: "administrator", id: "normal-staff-admin", role: "normal", mustChangePassword: false };
    const staffId = service.createStaff(actor, {
      name: "架空 資格", employmentStartDate: "2026-04-01",
    }).staff[0].id;
    let management = service.addQualification(actor, staffId, {
      qualificationType: "licensed_nursery_teacher", validFrom: "2026-04-01", validTo: "2031-03-31",
    });
    assert.deepEqual(management.staff[0].qualifications.map(({ qualificationType, validFrom, validTo }) => ({ qualificationType, validFrom, validTo })), [
      { qualificationType: "licensed_nursery_teacher", validFrom: "2026-04-01", validTo: "2031-03-31" },
    ]);
    management = service.addResponsibilities(actor, staffId, {
      responsibilityTypes: ["principal", "manager", "meal_service"], validFrom: "2026-04-01",
    });
    assert.deepEqual(
      management.staff[0].roles.map(({ roleType }) => roleType).sort(),
      ["manager", "meal_service", "principal"],
    );
    assert.deepEqual(management.staff[0].qualifications.map(({ qualificationType }) => qualificationType), ["licensed_nursery_teacher"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_roles").get().count, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_qualifications").get().count, 1);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE operation = 'staff_responsibilities.created'").get().count,
      1,
    );
    const role = management.staff[0].roles.find(({ roleType }) => roleType === "principal");
    management = service.updateRole(actor, staffId, role.id, {
      roleType: "principal", validFrom: "2026-05-01", validTo: "2027-03-31",
    });
    assert.deepEqual(
      management.staff[0].roles.find(({ id }) => id === role.id),
      { ...role, validFrom: "2026-05-01", validTo: "2027-03-31" },
    );
    const qualification = management.staff[0].qualifications[0];
    management = service.updateQualification(actor, staffId, qualification.id, {
      qualificationType: "childcare_support_worker_local_childcare", validFrom: "2026-05-01", validTo: "2027-03-31",
    });
    assert.equal(management.staff[0].qualifications[0].qualificationType, "childcare_support_worker_local_childcare");
    management = service.deleteRole(actor, staffId, role.id);
    assert.equal(management.staff[0].roles.some(({ id }) => id === role.id), false);
    management = service.deleteQualification(actor, staffId, qualification.id);
    assert.equal(management.staff[0].qualifications.length, 0);
    expectAuthError(() => service.addResponsibilities(actor, staffId, {
      responsibilityTypes: ["看護師"], validFrom: "2026-04-01",
    }), "INVALID_RESPONSIBILITY_CATEGORY");
    expectAuthError(() => service.addQualification(actor, "missing-staff", {
      qualificationType: "licensed_nursery_teacher", validFrom: "2026-04-01",
    }), "NOT_FOUND");
    expectAuthError(() => service.addQualification(actor, staffId, {
      qualificationType: "保育士", validFrom: "2026-04-01",
    }), "INVALID_QUALIFICATION_TYPE");
  });
});

test("does not present legacy responsibility rows as legal qualifications", async () => {
  await withStaffDatabase(async ({ database, service }) => {
    const actor = { type: "administrator", id: "normal-staff-admin", role: "normal", mustChangePassword: false };
    const staffId = service.createStaff(actor, {
      name: "架空 旧混在確認", employmentStartDate: "2026-04-01",
    }).staff[0].id;
    database.prepare(
      `INSERT INTO staff_qualifications
       (id, staff_id, qualification_type, valid_from, valid_to, created_at, updated_at)
       VALUES ('legacy-responsibility-row', ?, '保育士', '2026-04-01', NULL, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')`,
    ).run(staffId);

    const management = service.staffManagement(actor);
    assert.deepEqual(management.staff[0].roles, []);
    assert.deepEqual(management.staff[0].qualifications, []);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_qualifications WHERE staff_id = ?").get(staffId).count, 1);
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
      monthlyMinutesLimit: 7200, maxConsecutiveDays: 4, ...partTimeConditions(), availability: allWeekdays(),
    });
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2026-07-01", validTo: "2026-12-31", employmentType: "非常勤",
      ...partTimeConditions(), availability: allWeekdays(),
    }), "OVERLAPPING_WORK_CONDITION");
    const multipleAvailability = allWeekdays({ startTime: "08:30", endTime: "17:30" });
    multipleAvailability[1].candidates = [
      { startTime: "10:00", endTime: "14:30", weekOrdinals: null },
      { startTime: "15:00", endTime: "18:30", weekOrdinals: [2, 4] },
    ];
    const management = service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2026-10-01", employmentType: "常勤", monthlyMinutesLimit: 9600,
      maxConsecutiveDays: 5, availability: multipleAvailability,
    });
    assert.equal(management.staff[0].conditions.length, 2);
    assert.equal(management.staff[0].conditions[0].employmentType, "非常勤");
    assert.deepEqual({
      weeklyMinutesLimit: management.staff[0].conditions[0].weeklyMinutesLimit,
      weeklyMinutesLimitType: management.staff[0].conditions[0].weeklyMinutesLimitType,
      preferredWeeklyWorkDaysMin: management.staff[0].conditions[0].preferredWeeklyWorkDaysMin,
      weeklyWorkDaysMax: management.staff[0].conditions[0].weeklyWorkDaysMax,
      dailyWorkMinutesMin: management.staff[0].conditions[0].dailyWorkMinutesMin,
      dailyWorkMinutesMax: management.staff[0].conditions[0].dailyWorkMinutesMax,
    }, partTimeConditions());
    assert.equal(management.staff[0].conditions[1].availability.length, 7);
    assert.deepEqual(management.staff[0].conditions[1].availability[0], {
      weekday: 0, available: false, startTime: null, endTime: null, candidates: [],
    });
    assert.deepEqual(management.staff[0].conditions[1].availability[1], {
      weekday: 1, available: true, startTime: "10:00", endTime: "14:30",
      candidates: [
        { candidateOrder: 0, startTime: "10:00", endTime: "14:30", weekOrdinals: null },
        { candidateOrder: 1, startTime: "15:00", endTime: "18:30", weekOrdinals: [2, 4] },
      ],
    });
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM staff_weekly_availability_candidates WHERE work_condition_version_id = ?",
    ).get(management.staff[0].conditions[1].id).count, 2);

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
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "非常勤", availability: allWeekdays(),
    }), "INVALID_INPUT");
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "非常勤",
      ...partTimeConditions({ weeklyMinutesLimit: 20 * 60 + 5 }), availability: allWeekdays(),
    }), "INVALID_INPUT");
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "非常勤",
      ...partTimeConditions({ preferredWeeklyWorkDaysMin: 5, weeklyWorkDaysMax: 4 }),
      availability: allWeekdays(),
    }), "INVALID_INPUT");
    expectAuthError(() => service.createWorkConditionVersion(actor, staffId, {
      validFrom: "2027-04-01", employmentType: "非常勤",
      ...partTimeConditions({ dailyWorkMinutesMin: 315, dailyWorkMinutesMax: 300 }),
      availability: allWeekdays(),
    }), "INVALID_INPUT");
    assert.throws(() => database.prepare(
      `INSERT INTO staff_weekly_availability
       (work_condition_version_id, weekday, available, start_time, end_time)
       VALUES (?, 6, 0, '09:00', '16:00')`,
    ).run(management.staff[0].conditions[1].id));
  });
});

test("stores representative part-time weekly and daily contract patterns without applying full-time monthly rules", async () => {
  await withStaffDatabase(async ({ service }) => {
    const actor = { type: "administrator", id: "normal-staff-admin", role: "normal", mustChangePassword: false };
    const patterns = [
      partTimeConditions({ weeklyMinutesLimit: 20 * 60, weeklyMinutesLimitType: "exclusive", weeklyWorkDaysMax: 4 }),
      partTimeConditions({ weeklyMinutesLimit: 12 * 60, weeklyMinutesLimitType: "inclusive", weeklyWorkDaysMax: 3 }),
      partTimeConditions({ weeklyMinutesLimit: 30 * 60, weeklyMinutesLimitType: "inclusive", weeklyWorkDaysMax: 4, dailyWorkMinutesMin: 240, dailyWorkMinutesMax: 420 }),
      partTimeConditions({ weeklyMinutesLimit: 20 * 60, weeklyMinutesLimitType: "inclusive", weeklyWorkDaysMax: 5, dailyWorkMinutesMax: 240 }),
      partTimeConditions({ weeklyMinutesLimit: 40 * 60, weeklyMinutesLimitType: "inclusive", weeklyWorkDaysMax: 5, dailyWorkMinutesMin: 360, dailyWorkMinutesMax: 480 }),
    ];
    for (const [index, contract] of patterns.entries()) {
      const management = service.createStaff(actor, {
        name: `架空 非常勤${index + 1}`,
        employmentStartDate: "2026-04-01",
      });
      const staffId = management.staff.find((staff) => staff.name === `架空 非常勤${index + 1}`).id;
      const saved = service.createWorkConditionVersion(actor, staffId, {
        validFrom: "2026-04-01",
        employmentType: "非常勤",
        ...contract,
        availability: allWeekdays(),
      }).staff.find((staff) => staff.id === staffId).conditions[0];
      assert.equal(saved.monthlyMinutesLimit, null);
      assert.deepEqual({
        weeklyMinutesLimit: saved.weeklyMinutesLimit,
        weeklyMinutesLimitType: saved.weeklyMinutesLimitType,
        preferredWeeklyWorkDaysMin: saved.preferredWeeklyWorkDaysMin,
        weeklyWorkDaysMax: saved.weeklyWorkDaysMax,
        dailyWorkMinutesMin: saved.dailyWorkMinutesMin,
        dailyWorkMinutesMax: saved.dailyWorkMinutesMax,
      }, contract);
    }
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
        method: "POST", body: { responsibilityTypes: ["nursery_teacher_role", "meal_service"], validFrom: "2026-04-01" },
      }),
      { service, authService },
    );
    assert.equal(responsibilities.status, 201);
    assert.deepEqual((await responsibilities.json()).management.staff[0].roles.map(({ roleType }) => roleType).sort(), ["meal_service", "nursery_teacher_role"]);
    const qualification = await handleStaffManagementApiRequest(
      apiRequest(`/api/admin/staff/${staffId}/qualifications`, master, {
        method: "POST", body: { qualificationType: "licensed_nursery_teacher", validFrom: "2026-04-01" },
      }),
      { service, authService },
    );
    assert.equal(qualification.status, 201);
    assert.deepEqual((await qualification.json()).management.staff[0].qualifications.map(({ qualificationType }) => qualificationType), ["licensed_nursery_teacher"]);
  });
});
