import { createInitialStore, mergeChildren } from "../domain/prototype";
import type { AdminState, ChildProfile, PrototypeStore, ScheduleRecord } from "../domain/types";

export const STORAGE_KEY = "nursery-schedule-prototype-v2";
export const STORAGE_VERSION = 3 as const;
export const STORAGE_BACKUP_KEY = `${STORAGE_KEY}-original-backup-once`;
export const STORAGE_BACKUP_META_KEY = `${STORAGE_BACKUP_KEY}-meta`;

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type PrototypeStoreLoadResult = {
  store: PrototypeStore;
  recovered: boolean;
};

export type PrototypeStoreBackupResult = {
  status: "ready" | "created" | "already-backed-up" | "no-source" | "failed";
  verified: boolean;
  sourceExists: boolean;
  backupExists: boolean;
  createdAt?: string;
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

export function inspectPrototypeStoreBackup(storage: StorageLike): PrototypeStoreBackupResult {
  const source = storage.getItem(STORAGE_KEY);
  const backup = storage.getItem(STORAGE_BACKUP_KEY);
  let createdAt: string | undefined;
  try {
    const metadata = JSON.parse(storage.getItem(STORAGE_BACKUP_META_KEY) ?? "null") as { createdAt?: unknown } | null;
    if (metadata && typeof metadata.createdAt === "string") createdAt = metadata.createdAt;
  } catch {
    createdAt = undefined;
  }
  return {
    status: backup === null ? (source === null ? "no-source" : "ready") : "already-backed-up",
    verified: backup !== null,
    sourceExists: source !== null,
    backupExists: backup !== null,
    createdAt,
  };
}

export function backupPrototypeStoreOnce(storage: StorageLike, now = new Date()): PrototypeStoreBackupResult {
  const source = storage.getItem(STORAGE_KEY);
  const existingBackup = storage.getItem(STORAGE_BACKUP_KEY);
  if (existingBackup !== null) {
    return {
      ...inspectPrototypeStoreBackup(storage),
      status: "already-backed-up",
      verified: true,
    };
  }
  if (source === null) {
    return {
      status: "no-source",
      verified: false,
      sourceExists: false,
      backupExists: false,
    };
  }

  try {
    storage.setItem(STORAGE_BACKUP_KEY, source);
    const verified = storage.getItem(STORAGE_BACKUP_KEY) === source;
    if (!verified) {
      return {
        status: "failed",
        verified: false,
        sourceExists: true,
        backupExists: storage.getItem(STORAGE_BACKUP_KEY) !== null,
      };
    }
    const createdAt = now.toISOString();
    try {
      storage.setItem(
        STORAGE_BACKUP_META_KEY,
        JSON.stringify({ sourceKey: STORAGE_KEY, backupKey: STORAGE_BACKUP_KEY, createdAt, sourceLength: source.length }),
      );
    } catch {
      // The original JSON is already verified. Metadata failure must not remove it.
    }
    return {
      status: "created",
      verified: true,
      sourceExists: true,
      backupExists: true,
      createdAt,
    };
  } catch {
    return {
      status: "failed",
      verified: false,
      sourceExists: true,
      backupExists: storage.getItem(STORAGE_BACKUP_KEY) !== null,
    };
  }
}
