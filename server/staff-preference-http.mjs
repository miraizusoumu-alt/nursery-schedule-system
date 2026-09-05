import { AuthError } from "../lib/server/auth/permissions.mjs";
import { assertCsrf, json, readJson, requireSession } from "./auth-http.mjs";

export async function handleStaffPreferenceApiRequest(request, { service, authService } = {}) {
  const url = new URL(request.url);
  const isStaffRoute = url.pathname === "/api/staff/preferences"
    || url.pathname === "/api/staff/preferences/draft"
    || url.pathname === "/api/staff/preferences/reset"
    || url.pathname === "/api/staff/preferences/submit";
  const isAdminRoute = url.pathname === "/api/admin/staff-preferences"
    || url.pathname === "/api/admin/staff-preferences/period";
  if (!isStaffRoute && !isAdminRoute) return null;

  try {
    if (isStaffRoute) {
      const session = requireSession(request, authService, { type: "staff" });
      if (request.method === "GET" && url.pathname === "/api/staff/preferences") {
        return json({ ok: true, dashboard: service.ownDashboard(session.actor, { targetMonth: url.searchParams.get("targetMonth") }) });
      }
      if (request.method !== "GET" && request.method !== "HEAD") assertCsrf(request, session);
      const body = await readJson(request);
      if (request.method === "PUT" && url.pathname === "/api/staff/preferences/draft") {
        return json({ ok: true, dashboard: service.saveOwnDraft(session.actor, body) });
      }
      if (request.method === "POST" && url.pathname === "/api/staff/preferences/reset") {
        return json({ ok: true, dashboard: service.resetOwnDraft(session.actor, body) });
      }
      if (request.method === "POST" && url.pathname === "/api/staff/preferences/submit") {
        return json({ ok: true, dashboard: service.submitOwnDraft(session.actor, body) });
      }
    } else {
      const session = requireSession(request, authService, { type: "administrator" });
      if (request.method === "GET" && url.pathname === "/api/admin/staff-preferences") {
        return json({ ok: true, overview: service.administratorOverview(session.actor, { targetMonth: url.searchParams.get("targetMonth") }) });
      }
      if (request.method !== "GET" && request.method !== "HEAD") assertCsrf(request, session);
      const body = await readJson(request);
      if (request.method === "PUT" && url.pathname === "/api/admin/staff-preferences/period") {
        return json({ ok: true, overview: service.savePeriod(session.actor, body) });
      }
    }
    return json({ ok: false, code: "NOT_FOUND", message: "APIが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    return json({ ok: false, code: "INTERNAL_ERROR", message: "処理を完了できませんでした。" }, 500);
  }
}
