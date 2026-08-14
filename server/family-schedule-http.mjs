import { AuthError } from "../lib/server/auth/permissions.mjs";
import { assertCsrf, json, readJson, requireSession } from "./auth-http.mjs";

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export async function handleFamilyScheduleApiRequest(request, { service, authService } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/family/schedule")) return null;

  try {
    if (request.method === "GET" && url.pathname === "/api/family/schedule") {
      const session = requireSession(request, authService, { type: "family" });
      return json({ ok: true, dashboard: service.dashboard(session.actor) });
    }

    const childUpdate = routeMatch(url.pathname, /^\/api\/family\/schedule\/children\/([^/]+)$/);
    if (request.method === "PUT" && childUpdate) {
      const session = requireSession(request, authService, { type: "family" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, dashboard: service.updateChildSchedule(session.actor, childUpdate[0], body) });
    }

    if (request.method === "POST" && url.pathname === "/api/family/schedule/copy-to-siblings") {
      const session = requireSession(request, authService, { type: "family" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, dashboard: service.copyChildScheduleToSiblings(session.actor, body.sourceChildId) });
    }

    if (request.method === "POST" && url.pathname === "/api/family/schedule/apply-basic-pattern") {
      const session = requireSession(request, authService, { type: "family" });
      assertCsrf(request, session);
      const body = await readJson(request);
      return json({ ok: true, dashboard: service.applyBasicUsagePattern(session.actor, body.childId) });
    }

    if (request.method === "POST" && url.pathname === "/api/family/schedule/submit") {
      const session = requireSession(request, authService, { type: "family" });
      assertCsrf(request, session);
      return json({ ok: true, dashboard: service.submitFamilySchedules(session.actor) });
    }

    return json({ ok: false, code: "NOT_FOUND", message: "APIが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    return json({ ok: false, code: "INTERNAL_ERROR", message: "処理を完了できませんでした。" }, 500);
  }
}
