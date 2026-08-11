export const AUTH_PERMISSIONS = Object.freeze({
  family: new Set(["family:read-own"]),
  normal: new Set([
    "family:issue-account",
    "family:reissue-password",
    "family:record-handover",
    "family:set-stop-date",
    "administrator:issue-normal",
    "administrator:list",
    "operation-log:read",
  ]),
  master: new Set([
    "family:issue-account",
    "family:reissue-password",
    "family:record-handover",
    "family:set-stop-date",
    "administrator:issue-normal",
    "administrator:issue-master",
    "administrator:list",
    "administrator:stop",
    "administrator:reissue-password",
    "administrator:change-role",
    "auth-settings:manage",
    "operation-log:read",
  ]),
});

export function hasAuthPermission(actor, permission) {
  if (!actor) return false;
  if (actor.mustChangePassword) return false;
  if (actor.type === "family") return AUTH_PERMISSIONS.family.has(permission);
  return AUTH_PERMISSIONS[actor.role]?.has(permission) === true;
}

export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export function requirePermission(actor, permission) {
  if (!actor) throw new AuthError("UNAUTHENTICATED", "ログインが必要です。", 401);
  if (!hasAuthPermission(actor, permission)) throw new AuthError("FORBIDDEN", "この操作を行う権限がありません。", 403);
}
