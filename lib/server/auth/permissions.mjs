export const AUTH_PERMISSIONS = Object.freeze({
  family: new Set(["family:read-own"]),
  staff: new Set([
    "staff-preference:read-own",
    "staff-preference:write-own",
    "staff-preference:submit-own",
  ]),
  normal: new Set([
    "family:issue-account",
    "family:reissue-password",
    "family:record-handover",
    "family:set-stop-date",
    "family-submission:confirm",
    "family-submission:allow-resubmission",
    "family-submission:revise",
    "family-schedule:read",
    "child:manage",
    "basic-usage-pattern:manage",
    "basic-usage-pattern-history:read",
    "closure-day:manage",
    "submission-period:extend-family-deadline",
    "submission-period:set-parent-target",
    "administrator:issue-normal",
    "administrator:list",
    "operation-log:read",
    "staff:manage",
    "staff:issue-account",
    "staff:reissue-password",
    "staff-schedule:manage",
    "staff-preference-period:manage",
  ]),
  master: new Set([
    "family:issue-account",
    "family:reissue-password",
    "family:record-handover",
    "family:set-stop-date",
    "family-submission:confirm",
    "family-submission:allow-resubmission",
    "family-submission:revise",
    "family-schedule:read",
    "child:manage",
    "basic-usage-pattern:manage",
    "basic-usage-pattern-history:read",
    "closure-day:manage",
    "submission-period:extend-family-deadline",
    "submission-period:set-parent-target",
    "administrator:issue-normal",
    "administrator:issue-master",
    "administrator:list",
    "administrator:stop",
    "administrator:reissue-password",
    "administrator:change-role",
    "auth-settings:manage",
    "operation-log:read",
    "staff:manage",
    "staff:issue-account",
    "staff:reissue-password",
    "staff-schedule:manage",
    "staff-preference-period:manage",
  ]),
});

export function hasAuthPermission(actor, permission) {
  if (!actor) return false;
  if (actor.mustChangePassword) return false;
  if (actor.type === "family") return AUTH_PERMISSIONS.family.has(permission);
  if (actor.type === "staff") return AUTH_PERMISSIONS.staff.has(permission);
  return AUTH_PERMISSIONS[actor.role]?.has(permission) === true;
}

export class AuthError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function requirePermission(actor, permission) {
  if (!actor) throw new AuthError("UNAUTHENTICATED", "ログインが必要です。", 401);
  if (!hasAuthPermission(actor, permission)) throw new AuthError("FORBIDDEN", "この操作を行う権限がありません。", 403);
}
