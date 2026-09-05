import { AuthError } from "../lib/server/auth/permissions.mjs";
import { constantTimeHashMatch } from "../lib/server/auth/security.mjs";

export const SESSION_COOKIE = "nursery_session";
export const CSRF_COOKIE = "nursery_csrf";

function parseCookies(header) {
  const result = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookie fragments and continue without trusting them.
    }
  }
  return result;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join("; ");
}

export function json(body, status = 200, headers = new Headers()) {
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

function sessionCookieHeaders(session, settings, request, runtimeSecureCookies) {
  const secure = runtimeSecureCookies || settings.secureCookies || new URL(request.url).protocol === "https:";
  const maxAge = Math.max(0, (new Date(session.expiresAt).getTime() - Date.now()) / 1000);
  const headers = new Headers();
  headers.append("set-cookie", cookie(SESSION_COOKIE, session.token, { httpOnly: true, secure, maxAge }));
  headers.append("set-cookie", cookie(CSRF_COOKIE, session.csrfToken, { secure, maxAge }));
  return headers;
}

function clearCookieHeaders(request, runtimeSecureCookies) {
  const secure = runtimeSecureCookies || new URL(request.url).protocol === "https:";
  const headers = new Headers();
  headers.append("set-cookie", cookie(SESSION_COOKIE, "", { httpOnly: true, secure, maxAge: 0 }));
  headers.append("set-cookie", cookie(CSRF_COOKIE, "", { secure, maxAge: 0 }));
  return headers;
}

function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) throw new AuthError("ORIGIN_REQUIRED", "送信元を確認できません。", 403);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AuthError("ORIGIN_INVALID", "送信元を確認できません。", 403);
  }
  if (parsed.origin !== new URL(request.url).origin) {
    throw new AuthError("ORIGIN_MISMATCH", "この送信元からの操作は許可されていません。", 403);
  }
}

export async function readJson(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AuthError("JSON_REQUIRED", "JSON形式で送信してください。", 415);
  }
  try {
    return await request.json();
  } catch {
    throw new AuthError("INVALID_JSON", "入力内容を読み取れませんでした。");
  }
}

function requestSource(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function currentSession(request, service) {
  const cookies = parseCookies(request.headers.get("cookie"));
  return service.sessionByToken(cookies[SESSION_COOKIE]);
}

export function requireSession(request, service, { type = null, allowPasswordChangeRequired = false } = {}) {
  const session = currentSession(request, service);
  if (!session) throw new AuthError("UNAUTHENTICATED", "ログインが必要です。", 401);
  if (type && session.actor.type !== type) throw new AuthError("FORBIDDEN", "この画面を利用する権限がありません。", 403);
  if (session.actor.mustChangePassword && !allowPasswordChangeRequired) {
    throw new AuthError("PASSWORD_CHANGE_REQUIRED", "パスワード変更を完了してください。", 403);
  }
  return session;
}

export function assertCsrf(request, session) {
  assertSameOrigin(request);
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken || !constantTimeHashMatch(headerToken, session.csrfTokenHash)) {
    throw new AuthError("CSRF_INVALID", "操作の安全性を確認できません。画面を再読み込みしてください。", 403);
  }
}

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export async function handleAuthApiRequest(request, { service, runtimeSecureCookies = false } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  try {
    if (request.method === "POST" && new Set([
      "/api/auth/login/family",
      "/api/auth/login/admin",
      "/api/auth/login/staff",
    ]).has(url.pathname)) {
      assertSameOrigin(request);
      const body = await readJson(request);
      const scope = url.pathname.endsWith("/family")
        ? "family"
        : url.pathname.endsWith("/staff") ? "staff" : "administrator";
      const result = await service.login({ scope, loginId: body.loginId, password: body.password, source: requestSource(request) });
      const headers = sessionCookieHeaders(result.session, result.settings, request, runtimeSecureCookies);
      return json({
        ok: true,
        actor: service.publicActor(result.actor),
        redirectTo: result.actor.type === "family"
          ? "/parent/schedule"
          : result.actor.type === "staff"
            ? "/staff/preferences"
            : result.actor.mustChangePassword ? "/account/password" : "/admin/accounts",
      }, 200, headers);
    }

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const session = requireSession(request, service, { allowPasswordChangeRequired: true });
      return json({ ok: true, actor: service.publicActor(session.actor), expiresAt: session.expiresAt });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const session = requireSession(request, service, { allowPasswordChangeRequired: true });
      assertCsrf(request, session);
      service.logout(session);
      return json({ ok: true }, 200, clearCookieHeaders(request, runtimeSecureCookies));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/change-password") {
      const session = requireSession(request, service, { allowPasswordChangeRequired: true });
      assertCsrf(request, session);
      const body = await readJson(request);
      const result = await service.changePassword({ session, currentPassword: body.currentPassword, newPassword: body.newPassword });
      const headers = sessionCookieHeaders(result.session, result.settings, request, runtimeSecureCookies);
      return json({
        ok: true,
        actor: service.publicActor(result.actor),
        redirectTo: result.actor.type === "family"
          ? "/parent/schedule"
          : result.actor.type === "staff" ? "/staff/preferences" : "/admin/accounts",
      }, 200, headers);
    }

    if (request.method === "GET" && url.pathname === "/api/family/me") {
      const session = requireSession(request, service, { type: "family" });
      return json({ ok: true, ...service.getFamilySummary(session.actor) });
    }

    const familyRead = routeMatch(url.pathname, /^\/api\/families\/([^/]+)$/);
    if (request.method === "GET" && familyRead) {
      const session = requireSession(request, service);
      return json({ ok: true, ...service.getFamilySummary(session.actor, familyRead[0]) });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/accounts") {
      const session = requireSession(request, service, { type: "administrator" });
      return json({ ok: true, actor: service.publicActor(session.actor), ...service.listAccounts(session.actor) });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/operation-logs") {
      const session = requireSession(request, service, { type: "administrator" });
      return json({ ok: true, logs: service.listOperationLogs(session.actor, url.searchParams.get("limit")) });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/families") {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      throw new AuthError(
        "CHILD_REQUIRED",
        "先に園児を登録し、園児画面から家庭アカウントを発行してください。",
        409,
      );
    }

    const familyReissue = routeMatch(url.pathname, /^\/api\/admin\/families\/([^/]+)\/reissue-password$/);
    if (request.method === "POST" && familyReissue) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      return json({ ok: true, credential: await service.reissueFamilyPassword(session.actor, familyReissue[0]) });
    }

    const familyHandover = routeMatch(url.pathname, /^\/api\/admin\/families\/([^/]+)\/handover$/);
    if (request.method === "PATCH" && familyHandover) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, result: service.recordFamilyHandover(session.actor, familyHandover[0], body.handedOverAt) });
    }

    const familyStop = routeMatch(url.pathname, /^\/api\/admin\/families\/([^/]+)\/stop-date$/);
    if (request.method === "PATCH" && familyStop) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, result: service.setFamilyStopDate(session.actor, familyStop[0], body.stopDate) });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/administrators") {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, credential: await service.issueAdministrator(session.actor, body) }, 201);
    }

    if (request.method === "POST" && url.pathname === "/api/admin/staff-accounts") {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, credential: await service.issueStaffAccount(session.actor, body) }, 201);
    }

    const staffPasswordReissue = routeMatch(url.pathname, /^\/api\/admin\/staff-accounts\/([^/]+)\/reissue-password$/);
    if (request.method === "POST" && staffPasswordReissue) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      return json({ ok: true, credential: await service.reissueStaffPassword(session.actor, staffPasswordReissue[0]) });
    }

    const administratorReissue = routeMatch(url.pathname, /^\/api\/admin\/administrators\/([^/]+)\/reissue-password$/);
    if (request.method === "POST" && administratorReissue) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, credential: await service.reissueAdministratorPassword(session.actor, administratorReissue[0], body.currentPassword) });
    }

    const administratorStop = routeMatch(url.pathname, /^\/api\/admin\/administrators\/([^/]+)\/stop$/);
    if (request.method === "PATCH" && administratorStop) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, result: await service.stopAdministrator(session.actor, administratorStop[0], body.currentPassword) });
    }

    const administratorRole = routeMatch(url.pathname, /^\/api\/admin\/administrators\/([^/]+)\/role$/);
    if (request.method === "PATCH" && administratorRole) {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, result: await service.changeAdministratorRole(session.actor, administratorRole[0], body.role, body.currentPassword) });
    }

    if (request.method === "PATCH" && url.pathname === "/api/admin/auth-settings") {
      const session = requireSession(request, service, { type: "administrator" });
      assertCsrf(request, session);
      const body = await readJson(request);
      const settings = await service.updateAuthSettings(
        session.actor,
        body.settings,
        body.currentPassword,
        { isHttps: url.protocol === "https:" },
      );
      return json({ ok: true, settings });
    }

    return json({ ok: false, code: "NOT_FOUND", message: "APIが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      const headers = error.code === "UNAUTHENTICATED" ? clearCookieHeaders(request, runtimeSecureCookies) : new Headers();
      return json({ ok: false, code: error.code, message: error.message }, error.status, headers);
    }
    return json({ ok: false, code: "INTERNAL_ERROR", message: "処理を完了できませんでした。" }, 500);
  }
}

export function authorizeProtectedPage(request, service) {
  const url = new URL(request.url);
  const isParentPage = url.pathname === "/parent/account";
  const isParentSchedulePage = url.pathname === "/parent/schedule";
  const isAdministratorPage = url.pathname === "/admin/accounts" || url.pathname === "/admin/schedules";
  const isStaffPage = url.pathname === "/staff/preferences";
  const isPasswordPage = url.pathname === "/account/password";
  const isPrototypeTop = url.pathname === "/";
  if (!isParentPage && !isParentSchedulePage && !isAdministratorPage && !isStaffPage && !isPasswordPage && !isPrototypeTop) return null;

  const session = currentSession(request, service);
  if (isPrototypeTop && !session) return null;
  if (!session) {
    const loginPath = isAdministratorPage ? "/auth/admin" : isStaffPage ? "/auth/staff" : "/auth/parent";
    return Response.redirect(new URL(loginPath, request.url), 303);
  }
  if (isPasswordPage && session.actor.type === "family") {
    return Response.redirect(new URL("/parent/schedule", request.url), 303);
  }
  if (session.actor.mustChangePassword && !isPasswordPage) {
    return Response.redirect(new URL("/account/password", request.url), 303);
  }
  if ((isParentPage || isParentSchedulePage) && session.actor.type !== "family") {
    return new Response("この画面を利用する権限がありません。", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (isAdministratorPage && session.actor.type !== "administrator") {
    return new Response("この画面を利用する権限がありません。", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (isStaffPage && session.actor.type !== "staff") {
    return new Response("この画面を利用する権限がありません。", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return null;
}
