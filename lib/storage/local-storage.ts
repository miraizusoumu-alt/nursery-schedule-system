import { createInitialStore, mergeChildren } from "../domain/prototype";
import type { AdminState, ChildProfile, PrototypeStore, ScheduleRecord } from "../domain/types";

export const STORAGE_KEY = "nursery-schedule-prototype-v2";
export const STORAGE_VERSION = 3 as const;

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type PrototypeStoreLoadResult = {
  store: PrototypeStore;
  recovered: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordOr<T>(value: unknown, fallback: T): T {
  return (isRecord(value) ? value : fallback) as T;
}

export function normalizeStore(raw: unknown, now = new Date()): PrototypeStore {
  const initial = createInitialStore(now);
  if (!isRecord(raw)) return initial;

  const parsed = raw as Partial<PrototypeStore> & { version?: number };
  if (parsed.version !== STORAGE_VERSION) {
    const legacy = raw as {
      children?: ChildProfile[];
      schedules?: Record<string, ScheduleRecord>;
      admin?: Partial<AdminState> & { closedDatesByMonth?: Record<string, string[]> };
    };
    const legacyAdmin = isRecord(legacy.admin) ? legacy.admin : {};
    return {
      ...initial,
      children: mergeChildren(Array.isArray(legacy.children) ? legacy.children : initial.children),
      schedules: recordOr(legacy.schedules, initial.schedules),
      admin: {
        ...initial.admin,
        selectedMonth: typeof legacyAdmin.selectedMonth === "string" ? legacyAdmin.selectedMonth : initial.admin.selectedMonth,
        closedDatesByMonth: {
          ...initial.admin.closedDatesByMonth,
          ...recordOr(legacyAdmin.closedDatesByMonth, {}),
        },
        filterStatus: legacyAdmin.filterStatus ?? "all",
        filterText: typeof legacyAdmin.filterText === "string" ? legacyAdmin.filterText : "",
        selectedChildId: typeof legacyAdmin.selectedChildId === "string" ? legacyAdmin.selectedChildId : initial.admin.selectedChildId,
      },
    };
  }

  const parsedAdmin: Partial<AdminState> = isRecord(parsed.admin) ? parsed.admin : {};
  const parsedChildren = Array.isArray(parsed.children) ? parsed.children : initial.children;
  const parsedStaff = Array.isArray(parsed.staff) && parsed.staff.length ? parsed.staff : initial.staff;
  const parsedRules = Array.isArray(parsed.placementRules) && parsed.placementRules.length ? parsed.placementRules : initial.placementRules;
  const parsedHistories = Array.isArray(parsed.histories) ? parsed.histories : initial.histories;

  return {
    ...initial,
    ...parsed,
    version: STORAGE_VERSION,
    children: mergeChildren(parsedChildren),
    staff: parsedStaff,
    schedules: recordOr(parsed.schedules, initial.schedules),
    leavePeriods: { ...initial.leavePeriods, ...recordOr(parsed.leavePeriods, {}) },
    leaveRequests: recordOr(parsed.leaveRequests, initial.leaveRequests),
    placementRules: parsedRules,
    shifts: { ...initial.shifts, ...recordOr(parsed.shifts, {}) },
    histories: parsedHistories,
    admin: {
      ...initial.admin,
      ...parsedAdmin,
      closedDatesByMonth: {
        ...initial.admin.closedDatesByMonth,
        ...recordOr(parsedAdmin.closedDatesByMonth, {}),
      },
    },
  };
}

export function loadPrototypeStore(storage: StorageLike, now = new Date()): PrototypeStoreLoadResult {
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return { store: createInitialStore(now), recovered: false };
    return { store: normalizeStore(JSON.parse(saved), now), recovered: false };
  } catch {
    return { store: createInitialStore(now), recovered: true };
  }
}

export function savePrototypeStore(storage: StorageLike, store: PrototypeStore) {
  storage.setItem(STORAGE_KEY, JSON.stringify(store));
}
