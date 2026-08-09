import {
  cloneAvailability,
  clonePattern,
  createInitialShift,
  createLeavePeriod,
  createScheduleRecord,
  getTargetMonth,
  scheduleKey,
  shiftKey,
  shiftMonth,
} from "./schedule";
import type {
  ActorType,
  AdminMenuKey,
  ChildProfile,
  LeavePeriod,
  LeaveRequest,
  PrototypeStore,
  StaffDayAvailability,
  StaffProfile,
  SubmitStatus,
  UsagePattern,
  WeekdayKey,
} from "./types";

export const CURRENT_CHILD_ID = "sample-001";
export const CURRENT_STAFF_ID = "staff-001";

export const permissions = {
  parent: ["parent:own-schedule"],
  staff: ["staff:own-leave", "staff:public-leaves", "staff:own-published-shift"],
  admin: ["admin:all-children", "admin:staff-availability", "admin:leave-management", "admin:shift-management", "admin:settings"],
} satisfies Record<ActorType, string[]>;

export function hasPermission(actorType: ActorType, permission: string) {
  return permissions[actorType].includes(permission);
}

export const defaultBasePattern: Record<WeekdayKey, UsagePattern> = {
  mon: { enabled: true, start: "08:30", end: "17:30" },
  tue: { enabled: true, start: "08:30", end: "17:30" },
  wed: { enabled: true, start: "08:30", end: "17:30" },
  thu: { enabled: true, start: "08:30", end: "17:30" },
  fri: { enabled: true, start: "08:30", end: "17:30" },
  sat: { enabled: false, start: "09:00", end: "13:00" },
};

export const sampleChildren: ChildProfile[] = [
  {
    id: CURRENT_CHILD_ID,
    name: "青葉 はる",
    kana: "あおば はる",
    className: "ひまわり組",
    ageGroup: "1-2歳児",
    basePattern: clonePattern(defaultBasePattern),
  },
  {
    id: "sample-002",
    name: "白石 りく",
    kana: "しらいし りく",
    className: "ひまわり組",
    ageGroup: "0歳児",
    basePattern: {
      ...clonePattern(defaultBasePattern),
      mon: { enabled: true, start: "08:00", end: "18:00" },
      sat: { enabled: true, start: "09:00", end: "12:00" },
    },
  },
  {
    id: "sample-003",
    name: "森田 あお",
    kana: "もりた あお",
    className: "すみれ組",
    ageGroup: "3歳以上児",
    basePattern: {
      ...clonePattern(defaultBasePattern),
      thu: { enabled: false, start: "08:30", end: "17:30" },
      sat: { enabled: false, start: "09:00", end: "13:00" },
    },
  },
  {
    id: "sample-004",
    name: "高橋 みな",
    kana: "たかはし みな",
    className: "すみれ組",
    ageGroup: "1-2歳児",
    basePattern: {
      ...clonePattern(defaultBasePattern),
      tue: { enabled: true, start: "09:00", end: "16:00" },
      fri: { enabled: true, start: "08:00", end: "17:00" },
    },
  },
];

export const defaultStaffAvailability: Record<WeekdayKey, StaffDayAvailability> = {
  mon: { enabled: true, start: "08:30", end: "17:30" },
  tue: { enabled: true, start: "08:30", end: "17:30" },
  wed: { enabled: true, start: "08:30", end: "17:30" },
  thu: { enabled: true, start: "08:30", end: "17:30" },
  fri: { enabled: true, start: "08:30", end: "17:30" },
  sat: { enabled: false, start: "09:00", end: "13:00" },
};

export const sampleStaff: StaffProfile[] = [
  {
    id: CURRENT_STAFF_ID,
    name: "佐藤 あかり",
    employmentType: "常勤",
    qualifications: ["保育士"],
    availability: cloneAvailability(defaultStaffAvailability),
    canEarly: true,
    canLate: true,
    canSaturday: true,
    maxWeeklyDays: 5,
    maxMonthlyHours: 168,
    maxConsecutiveDays: 5,
    fixedDaysOff: [],
    memo: "リーダー対応可",
    validFrom: "2026-04-01",
    validTo: "2027-03-31",
  },
  {
    id: "staff-002",
    name: "田中 まい",
    employmentType: "非常勤",
    qualifications: ["保育士"],
    availability: {
      ...cloneAvailability(defaultStaffAvailability),
      mon: { enabled: true, start: "09:00", end: "16:00" },
      tue: { enabled: false, start: "09:00", end: "16:00" },
      wed: { enabled: true, start: "09:00", end: "16:00" },
      thu: { enabled: true, start: "09:00", end: "16:00" },
      fri: { enabled: false, start: "09:00", end: "16:00" },
      sat: { enabled: false, start: "09:00", end: "13:00" },
    },
    canEarly: false,
    canLate: false,
    canSaturday: false,
    maxWeeklyDays: 3,
    maxMonthlyHours: 96,
    maxConsecutiveDays: 3,
    fixedDaysOff: ["tue", "fri", "sat"],
    memo: "短時間勤務中心",
    validFrom: "2026-04-01",
    validTo: "2027-03-31",
  },
  {
    id: "staff-003",
    name: "山本 けん",
    employmentType: "短時間",
    qualifications: ["子育て支援員"],
    availability: {
      ...cloneAvailability(defaultStaffAvailability),
      mon: { enabled: true, start: "07:30", end: "12:30" },
      tue: { enabled: true, start: "07:30", end: "12:30" },
      wed: { enabled: true, start: "07:30", end: "12:30" },
      thu: { enabled: false, start: "07:30", end: "12:30" },
      fri: { enabled: true, start: "07:30", end: "12:30" },
      sat: { enabled: true, start: "08:30", end: "12:30" },
    },
    canEarly: true,
    canLate: false,
    canSaturday: true,
    maxWeeklyDays: 4,
    maxMonthlyHours: 80,
    maxConsecutiveDays: 4,
    fixedDaysOff: ["thu"],
    memo: "早番補助",
    validFrom: "2026-04-01",
    validTo: "2027-03-31",
  },
  {
    id: "staff-004",
    name: "鈴木 のぞみ",
    employmentType: "常勤",
    qualifications: ["保育士", "看護師"],
    availability: {
      ...cloneAvailability(defaultStaffAvailability),
      mon: { enabled: true, start: "09:30", end: "18:30" },
      tue: { enabled: true, start: "09:30", end: "18:30" },
      wed: { enabled: true, start: "09:30", end: "18:30" },
      thu: { enabled: true, start: "09:30", end: "18:30" },
      fri: { enabled: true, start: "09:30", end: "18:30" },
      sat: { enabled: false, start: "09:00", end: "13:00" },
    },
    canEarly: false,
    canLate: true,
    canSaturday: false,
    maxWeeklyDays: 5,
    maxMonthlyHours: 168,
    maxConsecutiveDays: 5,
    fixedDaysOff: [],
    memo: "遅番・看護対応可",
    validFrom: "2026-04-01",
    validTo: "2027-03-31",
  },
];

export const adminMenuItems: Array<{ key: AdminMenuKey; label: string }> = [
  { key: "children", label: "園児一覧" },
  { key: "staff", label: "職員一覧" },
  { key: "availability", label: "勤務可能時間" },
  { key: "leaveStatus", label: "希望休提出状況" },
  { key: "leaveCalendar", label: "希望休カレンダー" },
  { key: "childCounts", label: "園児数集計" },
  { key: "placement", label: "配置基準設定" },
  { key: "shiftAuto", label: "シフト自動作成" },
  { key: "shiftAdjust", label: "シフト調整" },
  { key: "shiftPublish", label: "シフト公開" },
  { key: "history", label: "変更履歴" },
];

export function createInitialStore(now = new Date()): PrototypeStore {
  const targetMonth = getTargetMonth(now);
  const previousMonth = shiftMonth(targetMonth, -1);
  const nextMonth = shiftMonth(targetMonth, 1);
  const closedDatesByMonth: Record<string, string[]> = {
    [previousMonth]: [],
    [targetMonth]: [],
    [nextMonth]: [],
  };
  const schedules: PrototypeStore["schedules"] = {};
  const leavePeriods: Record<string, LeavePeriod> = {
    [previousMonth]: { ...createLeavePeriod(previousMonth), status: "closed" },
    [targetMonth]: createLeavePeriod(targetMonth),
    [nextMonth]: createLeavePeriod(nextMonth),
  };
  const leaveRequests: Record<string, LeaveRequest> = {};

  sampleChildren.forEach((child, index) => {
    const submittedAt = new Date(now.getTime() - (index + 8) * 24 * 60 * 60 * 1000).toISOString();
    schedules[scheduleKey(child.id, previousMonth)] = createScheduleRecord(
      child,
      previousMonth,
      closedDatesByMonth[previousMonth],
      "submitted",
      submittedAt,
      now,
    );
    const currentStatus: SubmitStatus = child.id === "sample-002" ? "submitted" : "draft";
    schedules[scheduleKey(child.id, targetMonth)] = createScheduleRecord(
      child,
      targetMonth,
      closedDatesByMonth[targetMonth],
      currentStatus,
      currentStatus === "submitted" ? new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() : undefined,
      now,
    );
  });

  const sampleLeaveDates = [`${targetMonth}-10`, `${targetMonth}-15`, `${targetMonth}-20`];
  sampleStaff.slice(1).forEach((staff, index) => {
    const date = sampleLeaveDates[index] ?? `${targetMonth}-12`;
    const timestamp = new Date(now.getTime() - (index + 1) * 60 * 60 * 1000).toISOString();
    const key = `${staff.id}:${targetMonth}:${date}`;
    leaveRequests[key] = {
      id: key,
      staffId: staff.id,
      targetMonth,
      date,
      submittedAt: timestamp,
      updatedAt: timestamp,
    };
  });

  return {
    version: 3,
    children: sampleChildren.map((child) => ({ ...child, basePattern: clonePattern(child.basePattern) })),
    schedules,
    staff: sampleStaff.map((staff) => ({
      ...staff,
      availability: cloneAvailability(staff.availability),
      qualifications: [...staff.qualifications],
      fixedDaysOff: [...staff.fixedDaysOff],
    })),
    leavePeriods,
    leaveRequests,
    placementRules: [
      { id: "rule-0-law", ageGroup: "0歳児", childrenPerStaff: 3, minStaff: 1, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 0, ruleType: "law" },
      { id: "rule-1-law", ageGroup: "1-2歳児", childrenPerStaff: 6, minStaff: 1, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 0, ruleType: "law" },
      { id: "rule-3-law", ageGroup: "3歳以上児", childrenPerStaff: 20, minStaff: 1, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 0, ruleType: "law" },
      { id: "rule-facility-extra", ageGroup: "3歳以上児", childrenPerStaff: 20, minStaff: 2, requiredQualified: 1, openingStaff: 1, closingStaff: 1, extraStaff: 1, ruleType: "facility" },
    ],
    shifts: {
      [shiftKey(previousMonth)]: createInitialShift(previousMonth, now),
      [shiftKey(targetMonth)]: createInitialShift(targetMonth, now),
      [shiftKey(nextMonth)]: createInitialShift(nextMonth, now),
    },
    histories: [],
    admin: {
      selectedMonth: targetMonth,
      closedDatesByMonth,
      filterStatus: "all",
      filterText: "",
      selectedChildId: CURRENT_CHILD_ID,
      correctionChildId: CURRENT_CHILD_ID,
      correctionDate: `${targetMonth}-01`,
      correctionEnabled: true,
      correctionStart: "08:30",
      correctionEnd: "17:30",
      correctionReason: "",
      menu: "staff",
      selectedStaffId: CURRENT_STAFF_ID,
      leaveCorrectionStaffId: CURRENT_STAFF_ID,
      staffLeaveDate: `${targetMonth}-01`,
      childCountDate: `${targetMonth}-01`,
      slotMinutes: 15,
      shiftEditStaffId: CURRENT_STAFF_ID,
      shiftEditDate: `${targetMonth}-01`,
      shiftEditStart: "08:30",
      shiftEditEnd: "17:30",
      shiftEditBreak: 60,
      shiftEditRole: "normal",
      shiftEditFixed: false,
      shiftEditReason: "",
    },
  };
}

export function mergeChildren(children: ChildProfile[]) {
  const defaults = Object.fromEntries(sampleChildren.map((child) => [child.id, child]));
  return children.map((child) => ({
    ...child,
    ageGroup: child.ageGroup ?? defaults[child.id]?.ageGroup ?? "1-2歳児",
    basePattern: clonePattern(child.basePattern ?? defaults[child.id]?.basePattern ?? defaultBasePattern),
  }));
}

export function ensureMonthRecords(store: PrototypeStore, monthKey: string) {
  const closedDates = store.admin.closedDatesByMonth[monthKey] ?? [];
  const schedules = { ...store.schedules };
  const leavePeriods = { ...store.leavePeriods };
  const shifts = { ...store.shifts };
  store.children.forEach((child) => {
    const key = scheduleKey(child.id, monthKey);
    if (!schedules[key]) schedules[key] = createScheduleRecord(child, monthKey, closedDates);
  });
  if (!leavePeriods[monthKey]) leavePeriods[monthKey] = createLeavePeriod(monthKey);
  if (!shifts[shiftKey(monthKey)]) shifts[shiftKey(monthKey)] = createInitialShift(monthKey);
  return {
    ...store,
    schedules,
    leavePeriods,
    shifts,
    admin: {
      ...store.admin,
      selectedMonth: monthKey,
      correctionDate: store.admin.correctionDate.startsWith(monthKey) ? store.admin.correctionDate : `${monthKey}-01`,
      staffLeaveDate: store.admin.staffLeaveDate.startsWith(monthKey) ? store.admin.staffLeaveDate : `${monthKey}-01`,
      childCountDate: store.admin.childCountDate.startsWith(monthKey) ? store.admin.childCountDate : `${monthKey}-01`,
      shiftEditDate: store.admin.shiftEditDate.startsWith(monthKey) ? store.admin.shiftEditDate : `${monthKey}-01`,
    },
  };
}
