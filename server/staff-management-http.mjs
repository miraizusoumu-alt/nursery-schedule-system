import { AuthError } from "../lib/server/auth/permissions.mjs";
import { assertCsrf, json, readJson, requireSession } from "./auth-http.mjs";

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export async function handleStaffManagementApiRequest(request, { service, authService } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/staff")) return null;

  try {
    const session = requireSession(request, authService, { type: "administrator" });
    if (request.method === "GET" && url.pathname === "/api/admin/staff") {
      return json({ ok: true, management: service.staffManagement(session.actor) });
    }

    if (request.method !== "GET" && request.method !== "HEAD") assertCsrf(request, session);
    const body = await readJson(request);
    const staffUpdate = routeMatch(url.pathname, /^\/api\/admin\/staff\/([^/]+)$/);
    const qualificationCreate = routeMatch(url.pathname, /^\/api\/admin\/staff\/([^/]+)\/qualifications$/);
    const qualificationUpdate = routeMatch(url.pathname, /^\/api\/admin\/staff\/([^/]+)\/qualifications\/([^/]+)$/);
    const responsibilityCreate = routeMatch(url.pathname, /^\/api\/admin\/staff\/([^/]+)\/responsibilities$/);
    const roleUpdate = routeMatch(url.pathname, /^\/api\/admin\/staff\/([^/]+)\/roles\/([^/]+)$/);
    const workConditionCreate = routeMatch(url.pathname, /^\/api\/admin\/staff\/([^/]+)\/work-conditions$/);

    if (request.method === "POST" && url.pathname === "/api/admin/staff") {
      return json({ ok: true, management: service.createStaff(session.actor, body) }, 201);
    }
    if (request.method === "PUT" && staffUpdate) {
      return json({ ok: true, management: service.updateStaff(session.actor, staffUpdate[0], body) });
    }
    if (request.method === "POST" && qualificationCreate) {
      return json({ ok: true, management: service.addQualification(session.actor, qualificationCreate[0], body) }, 201);
    }
    if (request.method === "PUT" && qualificationUpdate) {
      return json({ ok: true, management: service.updateQualification(session.actor, qualificationUpdate[0], qualificationUpdate[1], body) });
    }
    if (request.method === "DELETE" && qualificationUpdate) {
      return json({ ok: true, management: service.deleteQualification(session.actor, qualificationUpdate[0], qualificationUpdate[1]) });
    }
    if (request.method === "POST" && responsibilityCreate) {
      return json({ ok: true, management: service.addResponsibilities(session.actor, responsibilityCreate[0], body) }, 201);
    }
    if (request.method === "PUT" && roleUpdate) {
      return json({ ok: true, management: service.updateRole(session.actor, roleUpdate[0], roleUpdate[1], body) });
    }
    if (request.method === "DELETE" && roleUpdate) {
      return json({ ok: true, management: service.deleteRole(session.actor, roleUpdate[0], roleUpdate[1]) });
    }
    if (request.method === "POST" && workConditionCreate) {
      return json({ ok: true, management: service.createWorkConditionVersion(session.actor, workConditionCreate[0], body) }, 201);
    }

    return json({ ok: false, code: "NOT_FOUND", message: "APIが見つかりません。" }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ ok: false, code: error.code, message: error.message }, error.status);
    }
    return json({ ok: false, code: "INTERNAL_ERROR", message: "処理を完了できませんでした。" }, 500);
  }
}
