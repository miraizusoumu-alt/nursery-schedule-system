import { AuthError } from "../lib/server/auth/permissions.mjs";
import { assertCsrf, json, readJson, requireSession } from "./auth-http.mjs";

export async function handleStaffScheduleApiRequest(request, { service, authService } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/staff-schedules")) return null;

  try {
    const session = requireSession(request, authService, { type: "administrator" });
    if (request.method === "GET" && url.pathname === "/api/admin/staff-schedules") {
      return json({
        ok: true,
        schedule: service.scheduleDashboard(session.actor, {
          targetMonth: url.searchParams.get("targetMonth"),
          selectedDate: url.searchParams.get("selectedDate"),
          versionId: url.searchParams.get("versionId"),
        }),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") assertCsrf(request, session);
    const body = await readJson(request);
    if (request.method === "POST" && url.pathname === "/api/admin/staff-schedules") {
      return json({ ok: true, schedule: service.createMonthlySchedule(session.actor, body) }, 201);
    }
    if (request.method === "PUT" && url.pathname === "/api/admin/staff-schedules/day") {
      return json({ ok: true, schedule: service.saveScheduleDay(session.actor, body) });
    }
    if (request.method === "PUT" && url.pathname === "/api/admin/staff-schedules/preference") {
      return json({ ok: true, schedule: service.saveStaffPreference(session.actor, body) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/staff-schedules/confirm") {
      return json({ ok: true, schedule: service.confirmMonthlySchedule(session.actor, body) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/staff-schedules/revision") {
      return json({ ok: true, schedule: service.createRevisionDraft(session.actor, body) }, 201);
    }

    return json({ ok: false, code: "NOT_FOUND", message: "APIが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    return json({ ok: false, code: "INTERNAL_ERROR", message: "処理を完了できませんでした。" }, 500);
  }
}
