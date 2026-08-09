import type {
  ActorType,
  DayPlan,
  LeavePeriod,
  LeaveRequest,
  PrototypeStore,
  ScheduleRecord,
  ShiftAssignment,
  ShiftRecord,
  ShiftStatus,
  StaffDayAvailability,
  SubmitStatus,
  SystemHistoryEntry,
  UsagePattern,
  WeekdayKey,
} from "./types";

export const ageGroups = ["0歳児", "1-2歳児", "3歳以上児"] as const;

export const weekdays: Array<{ key: WeekdayKey; short: string; label: string; day: number }> = [
  { key: "mon", short: "月", label: "月曜日", day: 1 },
  { key: "tue", short: "火", label: "火曜日", day: 2 },
  { key: "wed", short: "水", label: "水曜日", day: 3 },
  { key: "thu", short: "木", label: "木曜日", day: 4 },
  { key: "fri", short: "金", label: "金曜日", day: 5 },
  { key: "sat", short: "土", label: "土曜日", day: 6 },
];

const weekdayShorts = ["日", "月", "火", "水", "木", "金", "土"];

export function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function toDateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function shiftMonth(monthKey: string, offset: number) {
  const [year, month] = monthKey.split("-").map(Number);
  return toMonthKey(new Date(year, month - 1 + offset, 1));
}

export function getTargetMonth(now = new Date()) {
  return toMonthKey(new Date(now.getFullYear(), now.getMonth() + 1, 1));
}

export function getDeadline(targetMonth: string) {
  const [year, month] = targetMonth.split("-").map(Number);
  return toDateKey(new Date(year, month - 2, 25));
}

export function getMonthDates(targetMonth: string) {
  const [year, month] = targetMonth.split("-").map(Number);
  const dates: Date[] = [];
  const cursor = new Date(year, month - 1, 1);
  while (cursor.getMonth() === month - 1) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

export function weekdayKeyFromDate(date: Date): WeekdayKey | null {
  return weekdays.find((weekday) => weekday.day === date.getDay())?.key ?? null;
}

export function getWeekdayShort(dateKey: string) {
  return weekdayShorts[new Date(`${dateKey}T00:00:00`).getDay()];
}

export function formatDateNumber(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00`);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatJapaneseDate(dateKey: string) {
  return `${formatDateNumber(dateKey)}（${getWeekdayShort(dateKey)}）`;
}

export function formatMonthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return `${year}年${month}月`;
}

export function formatDateTime(value?: string) {
  if (!value) return "未記録";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未記録";
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function makeTimeOptions() {
  const options: string[] = [];
  for (let minutes = 7 * 60; minutes <= 20 * 60; minutes += 5) {
    options.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  }
  return options;
}

export const timeOptions = makeTimeOptions();

export function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function minutesToTime(value: number) {
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

export function roundDownTime(value: string, step: 15 | 30) {
  return minutesToTime(Math.floor(timeToMinutes(value) / step) * step);
}

export function roundUpTime(value: string, step: 15 | 30) {
  return minutesToTime(Math.ceil(timeToMinutes(value) / step) * step);
}

export function shiftDurationMinutes(assignment: Pick<ShiftAssignment, "start" | "end" | "breakMinutes">) {
  return Math.max(0, timeToMinutes(assignment.end) - timeToMinutes(assignment.start) - assignment.breakMinutes);
}

export function clonePattern(pattern: Record<WeekdayKey, UsagePattern>) {
  return Object.fromEntries(weekdays.map((weekday) => [weekday.key, { ...pattern[weekday.key] }])) as Record<WeekdayKey, UsagePattern>;
}

export function cloneAvailability(availability: Record<WeekdayKey, StaffDayAvailability>) {
  return Object.fromEntries(weekdays.map((weekday) => [weekday.key, { ...availability[weekday.key] }])) as Record<WeekdayKey, StaffDayAvailability>;
}

export function scheduleKey(childId: string, monthKey: string) {
  return `${childId}:${monthKey}`;
}

export function leaveKey(staffId: string, monthKey: string, dateKey: string) {
  return `${staffId}:${monthKey}:${dateKey}`;
}

export function shiftKey(monthKey: string) {
  return `shift:${monthKey}`;
}

export function isClosedDate(dateKey: string, closedDates: string[]) {
  return new Date(`${dateKey}T00:00:00`).getDay() === 0 || closedDates.includes(dateKey);
}

export function makeMonthPlans(
  targetMonth: string,
  basePattern: Record<WeekdayKey, UsagePattern>,
  closedDates: string[] = [],
  weekdayOverrides: Partial<Record<WeekdayKey, UsagePattern>> = {},
  existingDays: Record<string, DayPlan> = {},
) {
  return Object.fromEntries(
    getMonthDates(targetMonth).map((date) => {
      const dateKey = toDateKey(date);
      const weekdayKey = weekdayKeyFromDate(date);
      const closed = isClosedDate(dateKey, closedDates);
      const sourcePattern = weekdayKey ? weekdayOverrides[weekdayKey] ?? basePattern[weekdayKey] : null;
      const generated: DayPlan = {
        date: dateKey,
        enabled: closed ? false : Boolean(sourcePattern?.enabled),
        start: sourcePattern?.start ?? "08:30",
        end: sourcePattern?.end ?? "17:30",
        source: weekdayKey && weekdayOverrides[weekdayKey] ? "weekday" : "base",
        changed: Boolean(weekdayKey && weekdayOverrides[weekdayKey]),
        closed,
      };
      const existing = existingDays[dateKey];
      if (closed) return [dateKey, generated];
      if (existing && (existing.source === "daily" || existing.source === "admin")) {
        return [dateKey, { ...existing, closed: false, changed: true }];
      }
      return [dateKey, generated];
    }),
  ) as Record<string, DayPlan>;
}

export function createScheduleRecord(
  child: { id: string; basePattern: Record<WeekdayKey, UsagePattern> },
  targetMonth: string,
  closedDates: string[] = [],
  status: SubmitStatus = "draft",
  submittedAt?: string,
  now = new Date(),
) {
  const nowIso = now.toISOString();
  return {
    id: scheduleKey(child.id, targetMonth),
    childId: child.id,
    targetMonth,
    deadline: getDeadline(targetMonth),
    status,
    basePatternSnapshot: clonePattern(child.basePattern),
    weekdayOverrides: {},
    days: makeMonthPlans(targetMonth, child.basePattern, closedDates),
    submittedAt,
    updatedAt: submittedAt ?? nowIso,
    createdAt: nowIso,
    changeHistory: [],
  } satisfies ScheduleRecord;
}

export function createLeavePeriod(monthKey: string): LeavePeriod {
  const [year, month] = monthKey.split("-").map(Number);
  return {
    targetMonth: monthKey,
    startDate: toDateKey(new Date(year, month - 2, 1)),
    deadline: toDateKey(new Date(year, month - 2, 20)),
    guidance: "希望休は期限まで追加・削除できます。理由の入力は不要です。",
    status: "open",
  };
}

export function createInitialShift(monthKey: string, now = new Date()): ShiftRecord {
  return {
    id: shiftKey(monthKey),
    targetMonth: monthKey,
    status: "uncreated",
    slotMinutes: 15,
    assignments: [],
    issues: [],
    updatedAt: now.toISOString(),
    adminNotice: "公開後に職員画面へ表示されます。",
  };
}

export function statusLabel(status?: SubmitStatus) {
  return status === "submitted" ? "提出済み" : status === "draft" ? "下書き" : "未提出";
}

export function statusClass(status?: SubmitStatus) {
  return status === "submitted" ? "submitted" : status === "draft" ? "draft" : "unsubmitted";
}

export function shiftStatusLabel(status: ShiftStatus) {
  const labels: Record<ShiftStatus, string> = {
    uncreated: "未作成",
    generating: "自動作成中",
    draft: "シフト案",
    adjusting: "調整中",
    confirmed: "確定",
    published: "公開済み",
  };
  return labels[status];
}

export function getBasicSummary(settings: Record<WeekdayKey, UsagePattern>) {
  return (
    weekdays
      .filter((weekday) => settings[weekday.key].enabled)
      .map((weekday) => `${weekday.short} ${settings[weekday.key].start}-${settings[weekday.key].end}`)
      .join(" / ") || "利用なし"
  );
}

export function getScheduleStats(schedule: ScheduleRecord) {
  const days = Object.values(schedule.days);
  const useDays = days.filter((day) => day.enabled && !day.closed);
  const restDays = days.filter((day) => !day.enabled && !day.closed);
  const changedDays = days.filter((day) => day.changed && !day.closed);
  const starts = Array.from(new Set(useDays.map((day) => day.start))).sort();
  const ends = Array.from(new Set(useDays.map((day) => day.end))).sort();
  return {
    useDays: useDays.length,
    restDays: restDays.length,
    changedDays: changedDays.length,
    startSummary: starts.length ? starts.join(" / ") : "-",
    endSummary: ends.length ? ends.join(" / ") : "-",
  };
}

export function describeDay(day: DayPlan) {
  if (day.closed) return "休園日";
  if (!day.enabled) return "休み";
  return `${day.start} - ${day.end}`;
}

export function canStaffEditLeaves(period: LeavePeriod, now = new Date()) {
  return period.status === "open" && now <= new Date(`${period.deadline}T23:59:59`);
}

export function getLeavesForMonth(leaveRequests: Record<string, LeaveRequest>, monthKey: string) {
  return Object.values(leaveRequests)
    .filter((leave) => leave.targetMonth === monthKey)
    .sort((a, b) => a.date.localeCompare(b.date) || a.staffId.localeCompare(b.staffId));
}

export function applyClosedDatesToMonth(store: PrototypeStore, monthKey: string, closedDates: string[]) {
  const schedules = { ...store.schedules };
  store.children.forEach((child) => {
    const key = scheduleKey(child.id, monthKey);
    const current = schedules[key] ?? createScheduleRecord(child, monthKey, closedDates);
    schedules[key] = {
      ...current,
      days: makeMonthPlans(monthKey, current.basePatternSnapshot, closedDates, current.weekdayOverrides, current.days),
      updatedAt: new Date().toISOString(),
    };
  });
  return schedules;
}

export function addHistory(
  _store: PrototypeStore,
  entry: Omit<SystemHistoryEntry, "id" | "changedAt">,
  now = new Date(),
): SystemHistoryEntry {
  return {
    id: `${entry.targetMonth}:${entry.target}:${now.getTime()}`,
    changedAt: now.toISOString(),
    ...entry,
  };
}

export type PermissionMap = Record<ActorType, string[]>;
