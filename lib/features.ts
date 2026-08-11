import type { AdminMenuKey } from "./domain/types";

export const featureFlags = {
  workforcePrototype: true,
} as const;

const workforceAdminMenus = new Set<AdminMenuKey>([
  "staff",
  "availability",
  "leaveStatus",
  "leaveCalendar",
  "placement",
  "shiftAuto",
  "shiftAdjust",
  "shiftPublish",
]);

export function isWorkforceAdminMenu(menu: AdminMenuKey) {
  return workforceAdminMenus.has(menu);
}

export function isWorkforceHistoryTarget(target: string) {
  return /^(希望休|希望休提出期間|勤務可能時間|配置基準|シフト)/.test(target);
}
