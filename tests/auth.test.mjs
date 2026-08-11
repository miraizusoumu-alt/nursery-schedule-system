import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDevelopmentAuthAccounts, resetDevelopmentAuthAccounts } from "../db/auth-dev-accounts.mjs";
import { applyMigrations, inspectDatabase, openDatabase } from "../db/sqlite.mjs";
import { AuthError } from "../lib/server/auth/permissions.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { generateTemporaryPassword, hashPassword } from "../lib/server/auth/security.mjs";
import { authorizeProtectedPage, handleAuthApiRequest } from "../server/auth-http.mjs";

async function withAuthDatabase(run, initialTime = new Date("2026-08-11T00:00:00.000Z")) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-auth-"));
  const database = openDatabase(resolve(directory, "auth.sqlite"));
  const clock = { value: initialTime };
  try {
    await applyMigrations(database);
    const fixture = await insertFixture(database, initialTime);
    const service = createAuthService({ database, now: () => clock.value });
    await run({ database, service, fixture, clock });
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
    normal: generateTemporaryPassword(),
    master: generateTemporaryPassword(),
  };
  const hashes = {
    familyA: await hashPassword(passwords.familyA),
    familyB: await hashPassword(passwords.familyB),
    normal: await hashPassword(passwords.normal),
    master: await hashPassword(passwords.master),
  };
  for (const suffix of ["a", "b"]) {
    database.prepare(
      `INSERT INTO families (id, family_code, display_name, status, issued_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).run(`family-${suffix}`, `DEMO-AUTH-${suffix.toUpperCase()}`, `架空家庭${suffix.toUpperCase()}`, timestamp, timestamp, timestamp);
    database.prepare(
      `INSERT INTO family_accounts
       (id, family_id, login_id, password_hash, must_change_password, temporary_password_issued_at,
        credential_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(`family-account-${suffix}`, `family-${suffix}`, `demo-family-${suffix}`, hashes[`family${suffix.toUpperCase()}`], suffix === "a" ? 1 : 0, timestamp, timestamp, timestamp);
    database.prepare(
      `INSERT INTO children (id, child_code, name, class_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`child-${suffix}`, `DEMO-CHILD-${suffix.toUpperCase()}`, `架空園児${suffix.toUpperCase()}`, `架空組${suffix.toUpperCase()}`, timestamp, timestamp);
    database.prepare(
      `INSERT INTO family_children (family_id, child_id, relationship_label, is_primary, sort_order, created_at)
       VALUES (?, ?, '保護者（架空）', 1, 0, ?)`,
    ).run(`family-${suffix}`, `child-${suffix}`, timestamp);
  }
  for (const [id, role] of [["normal-admin", "normal"], ["master-admin", "master"]]) {
    database.prepare(
      `INSERT INTO administrators
       (id, login_id, display_name, role, password_hash, must_change_password,
        credential_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, 'active', ?, ?)`,
    ).run(id, `demo-${role}`, `架空${role === "master" ? "マスター" : "通常"}管理者`, role, hashes[role], timestamp, timestamp);
  }
  return { passwords };
}

async function expectAuthError(run, code) {
  await assert.rejects(run, (error) => error instanceof AuthError && error.code === code);
}

test("logs in and out with hashed passwords and hashed session tokens", async () => {
  await withAuthDatabase(async ({ database, service, fixture }) => {
    const result = await service.login({ scope: "family", loginId: "demo-family-a", password: fixture.passwords.familyA, source: "test-source" });
    assert.equal(result.actor.familyId, "family-a");
    assert.equal(result.actor.mustChangePassword, true);
    assert.ok(service.sessionByToken(result.session.token));
    const sessionRow = database.prepare("SELECT token_hash, csrf_token_hash FROM auth_sessions WHERE id = ?").get(result.session.sessionId);
    assert.notEqual(sessionRow.token_hash, result.session.token);
    assert.notEqual(sessionRow.csrf_token_hash, result.session.csrfToken);
    const passwordHash = database.prepare("SELECT password_hash FROM family_accounts WHERE id = 'family-account-a'").get().password_hash;
    assert.notEqual(passwordHash, fixture.passwords.familyA);
    assert.match(passwordHash, /^scrypt\$/);
    service.logout(service.sessionByToken(result.session.token));
    assert.equal(service.sessionByToken(result.session.token), null);

    let unknownMessage;
    try { await service.login({ scope: "family", loginId: "unknown-account", password: fixture.passwords.familyA, source: "one" }); } catch (error) { unknownMessage = error.message; }
    let wrongMessage;
    try { await service.login({ scope: "family", loginId: "demo-family-a", password: generateTemporaryPassword(), source: "two" }); } catch (error) { wrongMessage = error.message; }
    assert.equal(unknownMessage, wrongMessage);
  });
});

test("forces the first password change and invalidates old passwords and sessions after reissue", async () => {
  await withAuthDatabase(async ({ service, fixture }) => {
    const first = await service.login({ scope: "family", loginId: "demo-family-a", password: fixture.passwords.familyA, source: "family-a" });
    const changedPassword = generateTemporaryPassword();
    const changed = await service.changePassword({ session: service.sessionByToken(first.session.token), currentPassword: fixture.passwords.familyA, newPassword: changedPassword });
    assert.equal(service.sessionByToken(first.session.token), null);
    assert.equal(changed.actor.mustChangePassword, false);
    await expectAuthError(() => service.login({ scope: "family", loginId: "demo-family-a", password: fixture.passwords.familyA, source: "old" }), "INVALID_CREDENTIALS");
    const current = await service.login({ scope: "family", loginId: "demo-family-a", password: changedPassword, source: "new" });

    const master = await service.login({ scope: "administrator", loginId: "demo-master", password: fixture.passwords.master, source: "master" });
    const reissued = await service.reissueFamilyPassword(master.actor, "family-a");
    assert.equal(service.sessionByToken(current.session.token), null);
    assert.equal(service.sessionByToken(changed.session.token), null);
    await expectAuthError(() => service.login({ scope: "family", loginId: "demo-family-a", password: changedPassword, source: "old-new" }), "INVALID_CREDENTIALS");
    const temporary = await service.login({ scope: "family", loginId: reissued.loginId, password: reissued.temporaryPassword, source: "temporary" });
    assert.equal(temporary.actor.mustChangePassword, true);
  });
});

test("enforces family ownership and administrator role boundaries", async () => {
  await withAuthDatabase(async ({ service, fixture }) => {
    const family = await service.login({ scope: "family", loginId: "demo-family-b", password: fixture.passwords.familyB, source: "family" });
    assert.equal(service.getFamilySummary(family.actor).family.id, "family-b");
    assert.throws(() => service.getFamilySummary(family.actor, "family-a"), (error) => error.code === "FAMILY_SCOPE_VIOLATION");

    const normal = await service.login({ scope: "administrator", loginId: "demo-normal", password: fixture.passwords.normal, source: "normal" });
    await expectAuthError(
      () => service.issueAdministrator(normal.actor, { loginId: "demo-new-master", displayName: "架空追加マスター", role: "master", currentPassword: fixture.passwords.normal }),
      "FORBIDDEN",
    );
    await expectAuthError(() => service.stopAdministrator(normal.actor, "master-admin", fixture.passwords.normal), "FORBIDDEN");

    const master = await service.login({ scope: "administrator", loginId: "demo-master", password: fixture.passwords.master, source: "master" });
    await expectAuthError(() => service.stopAdministrator(master.actor, "master-admin", fixture.passwords.master), "SELF_STOP_FORBIDDEN");
    await expectAuthError(() => service.changeAdministratorRole(master.actor, "master-admin", "normal", fixture.passwords.master), "LAST_MASTER");
  });
});

test("uses Tokyo stop dates, rate limits five failures, and expires administrator sessions", async () => {
  await withAuthDatabase(async ({ service, fixture, clock }) => {
    const master = await service.login({ scope: "administrator", loginId: "demo-master", password: fixture.passwords.master, source: "master" });
    clock.value = new Date("2026-08-11T14:59:59.000Z");
    service.setFamilyStopDate(master.actor, "family-b", "2026-08-11");
    const family = await service.login({ scope: "family", loginId: "demo-family-b", password: fixture.passwords.familyB, source: "tokyo" });
    clock.value = new Date("2026-08-11T15:00:00.000Z");
    const stoppedApi = await handleAuthApiRequest(new Request("http://localhost:3000/api/family/me", {
      headers: { cookie: `nursery_session=${family.session.token}` },
    }), { service });
    assert.equal(stoppedApi.status, 401);
    const stoppedPage = authorizeProtectedPage(new Request("http://localhost:3000/parent/account", {
      headers: { cookie: `nursery_session=${family.session.token}` },
    }), service);
    assert.equal(stoppedPage.status, 303);
    assert.equal(service.sessionByToken(family.session.token), null);
    await expectAuthError(() => service.login({ scope: "family", loginId: "demo-family-b", password: fixture.passwords.familyB, source: "tokyo-next-day" }), "INVALID_CREDENTIALS");

    const badPassword = generateTemporaryPassword();
    clock.value = new Date("2026-08-11T16:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      await expectAuthError(() => service.login({ scope: "administrator", loginId: "missing-admin", password: badPassword, source: `id-source-${index}` }), "INVALID_CREDENTIALS");
    }
    await expectAuthError(() => service.login({ scope: "administrator", loginId: "missing-admin", password: badPassword, source: "id-source-final" }), "LOGIN_RESTRICTED");

    for (let index = 0; index < 5; index += 1) {
      await expectAuthError(() => service.login({ scope: "family", loginId: `missing-family-${index}`, password: badPassword, source: "limited-source" }), "INVALID_CREDENTIALS");
    }
    await expectAuthError(() => service.login({ scope: "family", loginId: "missing-family-final", password: badPassword, source: "limited-source" }), "LOGIN_RESTRICTED");

    clock.value = new Date("2026-08-11T16:15:00.000Z");
    await expectAuthError(() => service.login({ scope: "administrator", loginId: "missing-admin", password: badPassword, source: "id-source-after-lock" }), "INVALID_CREDENTIALS");

    clock.value = new Date("2026-08-12T00:00:00.000Z");
    const expiring = await service.login({ scope: "administrator", loginId: "demo-normal", password: fixture.passwords.normal, source: "expiry" });
    clock.value = new Date("2026-08-12T08:00:00.000Z");
    assert.equal(service.sessionByToken(expiring.session.token), null);
  });
});

test("enforces password length boundaries on the server and never stores plaintext", async () => {
  await withAuthDatabase(async ({ database, service, fixture }) => {
    const seven = "a".repeat(7);
    const eightNumeric = "12345678";
    const eightMixed = "Abc!2345";
    const eightLetters = "abcdefgh";
    const oneHundredTwentyEight = "c".repeat(128);
    const oneHundredTwentyNine = "d".repeat(129);

    const familyA = await service.login({ scope: "family", loginId: "demo-family-a", password: fixture.passwords.familyA, source: "password-7-8" });
    await expectAuthError(
      () => service.changePassword({ session: service.sessionByToken(familyA.session.token), currentPassword: fixture.passwords.familyA, newPassword: seven }),
      "INVALID_PASSWORD",
    );
    await service.changePassword({ session: service.sessionByToken(familyA.session.token), currentPassword: fixture.passwords.familyA, newPassword: eightNumeric });

    const familyB = await service.login({ scope: "family", loginId: "demo-family-b", password: fixture.passwords.familyB, source: "password-128" });
    await service.changePassword({ session: service.sessionByToken(familyB.session.token), currentPassword: fixture.passwords.familyB, newPassword: oneHundredTwentyEight });

    const normal = await service.login({ scope: "administrator", loginId: "demo-normal", password: fixture.passwords.normal, source: "normal-password-7-8" });
    await expectAuthError(
      () => service.changePassword({ session: service.sessionByToken(normal.session.token), currentPassword: fixture.passwords.normal, newPassword: seven }),
      "INVALID_PASSWORD",
    );
    await service.changePassword({ session: service.sessionByToken(normal.session.token), currentPassword: fixture.passwords.normal, newPassword: eightMixed });

    const master = await service.login({ scope: "administrator", loginId: "demo-master", password: fixture.passwords.master, source: "master-password-7-8-129" });
    await expectAuthError(
      () => service.changePassword({ session: service.sessionByToken(master.session.token), currentPassword: fixture.passwords.master, newPassword: seven }),
      "INVALID_PASSWORD",
    );
    const changedMaster = await service.changePassword({ session: service.sessionByToken(master.session.token), currentPassword: fixture.passwords.master, newPassword: eightLetters });
    await expectAuthError(
      () => service.changePassword({ session: service.sessionByToken(changedMaster.session.token), currentPassword: eightLetters, newPassword: oneHundredTwentyNine }),
      "INVALID_PASSWORD",
    );

    const persistedAuthenticationData = JSON.stringify({
      familyAccounts: database.prepare("SELECT password_hash FROM family_accounts").all(),
      administrators: database.prepare("SELECT password_hash FROM administrators").all(),
      sessions: database.prepare("SELECT token_hash, csrf_token_hash, invalidation_reason FROM auth_sessions").all(),
      attempts: database.prepare("SELECT login_id_hash, source_hash, attempted_at FROM auth_login_attempts").all(),
      operations: database.prepare("SELECT operation, detail_json FROM operation_logs").all(),
    });
    for (const password of [...Object.values(fixture.passwords), seven, eightNumeric, eightMixed, eightLetters, oneHundredTwentyEight, oneHundredTwentyNine]) {
      assert.equal(persistedAuthenticationData.includes(password), false);
    }
  });
});

test("returns identical HTTP errors for unknown and known login IDs", async () => {
  await withAuthDatabase(async ({ service, fixture }) => {
    const wrongPassword = generateTemporaryPassword();
    const request = (loginId, source) => new Request("http://localhost:3000/api/auth/login/family", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-forwarded-for": source,
      },
      body: JSON.stringify({ loginId, password: wrongPassword }),
    });
    const unknown = await handleAuthApiRequest(request("unknown-family", "unknown-http"), { service });
    const known = await handleAuthApiRequest(request("demo-family-b", "known-http"), { service });
    assert.equal(unknown.status, 401);
    assert.equal(known.status, 401);
    const unknownBody = await unknown.json();
    const knownBody = await known.json();
    assert.deepEqual(unknownBody, knownBody);
    assert.equal(JSON.stringify(unknownBody).includes(wrongPassword), false);
    assert.equal(JSON.stringify(knownBody).includes(fixture.passwords.familyB), false);
  });
});

test("rejects direct API privilege escalation and missing administrator reauthentication", async () => {
  await withAuthDatabase(async ({ service, fixture }) => {
    const family = await service.login({ scope: "family", loginId: "demo-family-b", password: fixture.passwords.familyB, source: "family-api-scope" });
    const familyCookie = `nursery_session=${family.session.token}; nursery_csrf=${family.session.csrfToken}`;
    const otherFamily = await handleAuthApiRequest(new Request("http://localhost:3000/api/families/family-a", {
      headers: { cookie: familyCookie },
    }), { service });
    assert.equal(otherFamily.status, 403);
    assert.equal((await otherFamily.json()).code, "FAMILY_SCOPE_VIOLATION");
    const familyToAdmin = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/accounts", {
      headers: { cookie: familyCookie },
    }), { service });
    assert.equal(familyToAdmin.status, 403);

    const normal = await service.login({ scope: "administrator", loginId: "demo-normal", password: fixture.passwords.normal, source: "normal-direct-api" });
    const normalHeaders = {
      origin: "http://localhost:3000",
      cookie: `nursery_session=${normal.session.token}; nursery_csrf=${normal.session.csrfToken}`,
      "content-type": "application/json",
      "x-csrf-token": normal.session.csrfToken,
    };
    const issueMaster = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/administrators", {
      method: "POST",
      headers: normalHeaders,
      body: JSON.stringify({ loginId: "blocked-master", displayName: "架空拒否対象", role: "master", currentPassword: fixture.passwords.normal }),
    }), { service });
    assert.equal(issueMaster.status, 403);
    assert.equal((await issueMaster.json()).code, "FORBIDDEN");
    const stopMasterAsNormal = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/administrators/master-admin/stop", {
      method: "PATCH",
      headers: normalHeaders,
      body: JSON.stringify({ currentPassword: fixture.passwords.normal }),
    }), { service });
    assert.equal(stopMasterAsNormal.status, 403);

    const master = await service.login({ scope: "administrator", loginId: "demo-master", password: fixture.passwords.master, source: "master-direct-api" });
    const masterHeaders = {
      origin: "http://localhost:3000",
      cookie: `nursery_session=${master.session.token}; nursery_csrf=${master.session.csrfToken}`,
      "content-type": "application/json",
      "x-csrf-token": master.session.csrfToken,
    };
    const selfStop = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/administrators/master-admin/stop", {
      method: "PATCH",
      headers: masterHeaders,
      body: JSON.stringify({ currentPassword: fixture.passwords.master }),
    }), { service });
    assert.equal(selfStop.status, 409);
    assert.equal((await selfStop.json()).code, "SELF_STOP_FORBIDDEN");
    const lastMasterDemotion = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/administrators/master-admin/role", {
      method: "PATCH",
      headers: masterHeaders,
      body: JSON.stringify({ role: "normal", currentPassword: fixture.passwords.master }),
    }), { service });
    assert.equal(lastMasterDemotion.status, 409);
    assert.equal((await lastMasterDemotion.json()).code, "LAST_MASTER");
    const missingReauthentication = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/administrators/normal-admin/role", {
      method: "PATCH",
      headers: masterHeaders,
      body: JSON.stringify({ role: "master" }),
    }), { service });
    assert.equal(missingReauthentication.status, 403);
    assert.equal((await missingReauthentication.json()).code, "REAUTHENTICATION_FAILED");
  });
});

test("rejects untrusted API writes and protects pages on the server", async () => {
  await withAuthDatabase(async ({ service, fixture }) => {
    const unauthenticatedPage = authorizeProtectedPage(new Request("http://localhost:3000/admin/accounts"), service);
    assert.equal(unauthenticatedPage.status, 303);
    const unauthenticatedApi = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/accounts"), { service });
    assert.equal(unauthenticatedApi.status, 401);

    const loginResponse = await handleAuthApiRequest(new Request("http://localhost:3000/api/auth/login/admin", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": "api-test" },
      body: JSON.stringify({ loginId: "demo-master", password: fixture.passwords.master }),
    }), { service });
    assert.equal(loginResponse.status, 200);
    const setCookies = loginResponse.headers.getSetCookie();
    const sessionSetCookie = setCookies.find((value) => value.startsWith("nursery_session="));
    const csrfSetCookie = setCookies.find((value) => value.startsWith("nursery_csrf="));
    assert.match(sessionSetCookie, /HttpOnly/);
    assert.match(sessionSetCookie, /SameSite=Lax/);
    assert.match(sessionSetCookie, /Path=\//);
    assert.doesNotMatch(sessionSetCookie, /Secure/);
    assert.match(csrfSetCookie, /SameSite=Lax/);
    assert.match(csrfSetCookie, /Path=\//);
    assert.ok(setCookies.every((value) => !value.includes(fixture.passwords.master)));
    const cookieHeader = setCookies.map((value) => value.split(";")[0]).join("; ");
    const protectedPage = authorizeProtectedPage(new Request("http://localhost:3000/admin/accounts", { headers: { cookie: cookieHeader } }), service);
    assert.equal(protectedPage, null);

    const temporaryFamily = await service.login({ scope: "family", loginId: "demo-family-a", password: fixture.passwords.familyA, source: "temporary-page" });
    const passwordRedirect = authorizeProtectedPage(new Request("http://localhost:3000/", { headers: { cookie: `nursery_session=${temporaryFamily.session.token}` } }), service);
    assert.equal(passwordRedirect.status, 303);
    assert.equal(new URL(passwordRedirect.headers.get("location")).pathname, "/account/password");
    const passwordRequiredApi = await handleAuthApiRequest(new Request("http://localhost:3000/api/family/me", { headers: { cookie: `nursery_session=${temporaryFamily.session.token}` } }), { service });
    assert.equal(passwordRequiredApi.status, 403);
    assert.equal((await passwordRequiredApi.json()).code, "PASSWORD_CHANGE_REQUIRED");

    const noCsrf = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/families", {
      method: "POST",
      headers: { origin: "http://localhost:3000", cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ familyCode: "DEMO-CSRF", displayName: "架空CSRF家庭", loginId: "demo-csrf-family" }),
    }), { service });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).code, "CSRF_INVALID");

    const forgedCsrf = await handleAuthApiRequest(new Request("http://localhost:3000/api/admin/families", {
      method: "POST",
      headers: { origin: "http://localhost:3000", cookie: cookieHeader, "content-type": "application/json", "x-csrf-token": "forged-token" },
      body: JSON.stringify({ familyCode: "DEMO-CSRF", displayName: "架空CSRF家庭", loginId: "demo-csrf-family" }),
    }), { service });
    assert.equal(forgedCsrf.status, 403);
    assert.equal((await forgedCsrf.json()).code, "CSRF_INVALID");

    const wrongOrigin = await handleAuthApiRequest(new Request("http://localhost:3000/api/auth/login/admin", {
      method: "POST",
      headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ loginId: "demo-master", password: fixture.passwords.master }),
    }), { service });
    assert.equal(wrongOrigin.status, 403);

    const spoofedHttps = await handleAuthApiRequest(new Request("http://localhost:3000/api/auth/login/family", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-forwarded-for": "spoofed-https",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ loginId: "demo-family-b", password: fixture.passwords.familyB }),
    }), { service });
    assert.equal(spoofedHttps.status, 200);
    assert.ok(spoofedHttps.headers.getSetCookie().every((value) => !value.includes("Secure")));

    const httpsLogin = await handleAuthApiRequest(new Request("https://localhost:3000/api/auth/login/family", {
      method: "POST",
      headers: { origin: "https://localhost:3000", "content-type": "application/json", "x-forwarded-for": "actual-https" },
      body: JSON.stringify({ loginId: "demo-family-b", password: fixture.passwords.familyB }),
    }), { service });
    assert.equal(httpsLogin.status, 200);
    assert.ok(httpsLogin.headers.getSetCookie().every((value) => value.includes("Secure")));

    const productionCookies = await handleAuthApiRequest(new Request("http://localhost:3000/api/auth/login/family", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": "runtime-secure" },
      body: JSON.stringify({ loginId: "demo-family-b", password: fixture.passwords.familyB }),
    }), { service, runtimeSecureCookies: true });
    assert.equal(productionCookies.status, 200);
    assert.ok(productionCookies.headers.getSetCookie().every((value) => value.includes("Secure")));
  });
});

test("records issue, handover, reissue, stop, role, and security-setting operations", async () => {
  await withAuthDatabase(async ({ database, service, fixture }) => {
    const master = await service.login({ scope: "administrator", loginId: "demo-master", password: fixture.passwords.master, source: "audit-master" });
    const family = await service.issueFamilyAccount(master.actor, {
      familyCode: "DEMO-AUDIT",
      displayName: "架空 操作履歴家庭",
      loginId: "demo-audit-family",
    });
    service.recordFamilyHandover(master.actor, family.familyId, "2026-08-12");
    service.setFamilyStopDate(master.actor, family.familyId, "2026-08-31");
    const reissuedFamily = await service.reissueFamilyPassword(master.actor, family.familyId);
    const administrator = await service.issueAdministrator(master.actor, {
      loginId: "demo-audit-admin",
      displayName: "架空 操作履歴管理者",
      role: "normal",
    });
    const issuedAdministratorSession = await service.login({ scope: "administrator", loginId: administrator.loginId, password: administrator.temporaryPassword, source: "issued-administrator" });
    const reissuedAdministrator = await service.reissueAdministratorPassword(master.actor, administrator.administratorId, fixture.passwords.master);
    assert.equal(service.sessionByToken(issuedAdministratorSession.session.token), null);
    const reissuedAdministratorSession = await service.login({ scope: "administrator", loginId: administrator.loginId, password: reissuedAdministrator.temporaryPassword, source: "reissued-administrator" });
    await service.changeAdministratorRole(master.actor, administrator.administratorId, "master", fixture.passwords.master);
    assert.equal(service.sessionByToken(reissuedAdministratorSession.session.token), null);
    await service.stopAdministrator(master.actor, administrator.administratorId, fixture.passwords.master);
    await expectAuthError(() => service.login({ scope: "administrator", loginId: administrator.loginId, password: reissuedAdministrator.temporaryPassword, source: "stopped-administrator" }), "INVALID_CREDENTIALS");
    const updatedSettings = await service.updateAuthSettings(master.actor, { loginLockMinutes: 20, passwordMinimumLength: 8 }, fixture.passwords.master);
    assert.equal(updatedSettings.passwordMinimumLength, 8);
    await expectAuthError(
      () => service.updateAuthSettings(master.actor, { passwordMinimumLength: 7 }, fixture.passwords.master),
      "INVALID_SETTINGS",
    );

    const operations = new Set(database.prepare("SELECT operation FROM operation_logs").all().map((row) => row.operation));
    for (const operation of [
      "family_account.issued",
      "family_account.handover_recorded",
      "family_account.stop_date_changed",
      "family_account.password_reissued",
      "administrator.issued",
      "administrator.password_reissued",
      "administrator.role_changed",
      "administrator.stopped",
      "auth_settings.changed",
    ]) assert.ok(operations.has(operation), operation);
    const serializedLogs = database.prepare("SELECT COALESCE(GROUP_CONCAT(detail_json, ''), '') AS value FROM operation_logs").get().value;
    assert.equal(serializedLogs.includes(family.temporaryPassword), false);
    assert.equal(serializedLogs.includes(reissuedFamily.temporaryPassword), false);
    assert.equal(serializedLogs.includes(administrator.temporaryPassword), false);
    assert.equal(serializedLogs.includes(reissuedAdministrator.temporaryPassword), false);
  });
});

test("records account operations without passwords and keeps development account creation idempotent", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-auth-dev-"));
  const databasePath = resolve(directory, "development.sqlite");
  const database = openDatabase(databasePath);
  try {
    await applyMigrations(database);
    const first = await createDevelopmentAuthAccounts(database, new Date("2099-01-01T00:00:00.000Z"));
    const second = await createDevelopmentAuthAccounts(database, new Date("2099-01-02T00:00:00.000Z"));
    assert.equal(first.filter((entry) => entry.temporaryPassword).length, 3);
    assert.equal(second.filter((entry) => entry.temporaryPassword).length, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM family_accounts").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM administrators").get().count, 2);
    const service = createAuthService({ database, now: () => new Date("2099-01-02T00:00:00.000Z") });
    const firstFamily = first.find((entry) => entry.type === "family");
    const oldSession = await service.login({ scope: "family", loginId: firstFamily.loginId, password: firstFamily.temporaryPassword, source: "development-reset" });
    const reset = await resetDevelopmentAuthAccounts(database, new Date("2099-01-03T00:00:00.000Z"));
    assert.equal(reset.filter((entry) => entry.temporaryPassword).length, 3);
    assert.equal(service.sessionByToken(oldSession.session.token), null);
    await expectAuthError(() => service.login({ scope: "family", loginId: firstFamily.loginId, password: firstFamily.temporaryPassword, source: "development-old" }), "INVALID_CREDENTIALS");
    const resetFamily = reset.find((entry) => entry.type === "family");
    const resetLogin = await service.login({ scope: "family", loginId: resetFamily.loginId, password: resetFamily.temporaryPassword, source: "development-new" });
    assert.equal(resetLogin.actor.mustChangePassword, true);
    for (const entry of first) {
      const allLogs = database.prepare("SELECT COALESCE(GROUP_CONCAT(detail_json, ''), '') AS text FROM operation_logs").get().text;
      assert.equal(allLogs.includes(entry.temporaryPassword), false);
      const allHashes = database.prepare("SELECT password_hash FROM family_accounts UNION ALL SELECT password_hash FROM administrators").all();
      assert.equal(allHashes.some((row) => row.password_hash === entry.temporaryPassword), false);
    }
    for (const entry of reset) {
      const allLogs = database.prepare("SELECT COALESCE(GROUP_CONCAT(detail_json, ''), '') AS text FROM operation_logs").get().text;
      assert.equal(allLogs.includes(entry.temporaryPassword), false);
    }
    const report = inspectDatabase(database);
    assert.equal(report.integrityOk, true);
    assert.equal(report.foreignKeysOk, true);
    assert.deepEqual(report.missingTables, []);
    const source = await readFile(new URL("../db/auth-dev-accounts.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /initialPassword\s*=\s*["']/i);
    const cliSource = await readFile(new URL("../db/auth-cli.mjs", import.meta.url), "utf8");
    assert.match(cliSource, /resolveDatabasePath\(optionValue\("--db"\)\)/);
    assert.doesNotMatch(cliSource, /optionValue\("--db"\) \|\| DEFAULT_DATABASE_PATH/);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
