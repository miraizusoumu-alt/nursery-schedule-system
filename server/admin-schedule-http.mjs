import { AuthError } from "../lib/server/auth/permissions.mjs";
import { createFamilyScheduleExcel } from "../lib/server/family-schedule/excel-export.mjs";
import { assertCsrf, json, readJson, requireSession } from "./auth-http.mjs";

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export async function handleAdminScheduleApiRequest(request, { service, authService } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/schedules")) return null;

  try {
    const session = requireSession(request, authService, { type: "administrator" });

    if (request.method === "GET" && url.pathname === "/api/admin/schedules") {
      return json({
        ok: true,
        dashboard: service.administratorScheduleDashboard(session.actor, {
          submissionPeriodId: url.searchParams.get("submissionPeriodId"),
          familyId: url.searchParams.get("familyId"),
        }),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/schedules/history") {
      return json({
        ok: true,
        history: service.administratorRevisionHistory(session.actor, {
          submissionPeriodId: url.searchParams.get("submissionPeriodId"),
          familyId: url.searchParams.get("familyId"),
          childId: url.searchParams.get("childId"),
        }),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/schedules/export") {
      const data = service.administratorScheduleExportData(session.actor, {
        submissionPeriodId: url.searchParams.get("submissionPeriodId"),
      });
      const excel = await createFamilyScheduleExcel(data);
      return new Response(excel.buffer, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${excel.filename}"`,
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/schedules/children") {
      return json({ ok: true, management: service.administratorChildManagement(session.actor) });
    }

    if (request.method !== "GET" && request.method !== "HEAD") assertCsrf(request, session);
    const body = await readJson(request);
    const childUpdate = routeMatch(url.pathname, /^\/api\/admin\/schedules\/children\/([^/]+)$/);
    const patternUpdate = routeMatch(url.pathname, /^\/api\/admin\/schedules\/children\/([^/]+)\/basic-patterns$/);
    if (request.method === "POST" && url.pathname === "/api/admin/schedules/children") {
      return json({ ok: true, management: service.createChild(session.actor, body) }, 201);
    }
    if (request.method === "PUT" && childUpdate) {
      return json({ ok: true, management: service.updateChild(session.actor, childUpdate[0], body) });
    }
    if (request.method === "PUT" && patternUpdate) {
      return json({ ok: true, result: service.updateBasicUsagePatterns(session.actor, patternUpdate[0], body) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/schedules/parent-target") {
      return json({ ok: true, result: service.setParentTargetPeriod(session.actor, body) });
    }
    if (request.method === "PUT" && url.pathname === "/api/admin/schedules/deadline-extension") {
      return json({ ok: true, result: service.setFamilyDeadlineExtension(session.actor, body) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/schedules/confirm") {
      return json({ ok: true, result: service.confirmLatestFamilySubmission(session.actor, body) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/schedules/revision/preview") {
      return json({ ok: true, result: service.previewAdministratorRevision(session.actor, body) });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/schedules/revision") {
      return json({ ok: true, result: service.createAdministratorRevision(session.actor, body) });
    }

    return json({ ok: false, code: "NOT_FOUND", message: "APIが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    return json({ ok: false, code: "INTERNAL_ERROR", message: "処理を完了できませんでした。" }, 500);
  }
}
