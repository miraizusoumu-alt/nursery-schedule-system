export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export type AdminMenuKey =
  | "children"
  | "staff"
  | "availability"
  | "leaveStatus"
  | "leaveCalendar"
  | "childCounts"
  | "placement"
  | "shiftAuto"
  | "shiftAdjust"
  | "shiftPublish"
  | "history";

export type SubmitStatus = "draft" | "submitted";
export type DaySource = "base" | "weekday" | "daily" | "admin";
export type ActorType = "parent" | "staff" | "admin";
export type ShiftStatus = "uncreated" | "generating" | "draft" | "adjusting" | "confirmed" | "published";
export type StaffRole = "normal" | "early" | "late";
export type EmploymentType = "常勤" | "非常勤";
export type AgeGroup = "0歳児" | "1-2歳児" | "3歳以上児";

export type UsagePattern = {
  enabled: boolean;
  start: string;
  end: string;
};

export type DayPlan = {
  date: string;
  enabled: boolean;
  start: string;
  end: string;
  source: DaySource;
  changed: boolean;
  closed: boolean;
};

export type ScheduleChangeHistoryEntry = {
  id: string;
  changedAt: string;
  changedBy: string;
  reason: string;
  before: DayPlan;
  after: DayPlan;
};

export type ChildProfile = {
  id: string;
  name: string;
  kana: string;
  className: string;
  ageGroup: AgeGroup;
  basePattern: Record<WeekdayKey, UsagePattern>;
};

export type ScheduleRecord = {
  id: string;
  childId: string;
  targetMonth: string;
  deadline: string;
  status: SubmitStatus;
  basePatternSnapshot: Record<WeekdayKey, UsagePattern>;
  weekdayOverrides: Partial<Record<WeekdayKey, UsagePattern>>;
  days: Record<string, DayPlan>;
  submittedAt?: string;
  updatedAt: string;
  createdAt: string;
  changeHistory: ScheduleChangeHistoryEntry[];
};

export type StaffDayAvailability = {
  enabled: boolean;
  start: string;
  end: string;
};

export type StaffProfile = {
  id: string;
  name: string;
  employmentType: EmploymentType;
  qualifications: string[];
  availability: Record<WeekdayKey, StaffDayAvailability>;
  canEarly: boolean;
  canLate: boolean;
  canSaturday: boolean;
  maxWeeklyDays: number;
  maxMonthlyHours: number;
  maxConsecutiveDays: number;
  fixedDaysOff: WeekdayKey[];
  memo: string;
  validFrom: string;
  validTo: string;
};

export type LeavePeriod = {
  targetMonth: string;
  startDate: string;
  deadline: string;
  guidance: string;
  status: "open" | "closed";
};

export type LeaveRequest = {
  id: string;
  staffId: string;
  targetMonth: string;
  date: string;
  submittedAt: string;
  updatedAt: string;
};

export type PlacementRule = {
  id: string;
  ageGroup: AgeGroup;
  childrenPerStaff: number;
  minStaff: number;
  requiredQualified: number;
  openingStaff: number;
  closingStaff: number;
  extraStaff: number;
  ruleType: "law" | "facility";
};

export type ChildUsageSlot = {
  date: string;
  start: string;
  end: string;
  countsByAgeGroup: Record<AgeGroup, number>;
  totalChildren: number;
  children: Array<{ childId: string; name: string; ageGroup: AgeGroup; start: string; end: string }>;
};

export type ShiftAssignment = {
  id: string;
  staffId: string;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
  role: StaffRole;
  fixed: boolean;
  source: "auto" | "manual";
  note: string;
};

export type ShiftIssue = {
  id: string;
  date: string;
  timeRange: string;
  message: string;
  severity: "warning" | "critical";
};

export type ShiftRecord = {
  id: string;
  targetMonth: string;
  status: ShiftStatus;
  slotMinutes: 15 | 30;
  assignments: ShiftAssignment[];
  issues: ShiftIssue[];
  generatedAt?: string;
  confirmedAt?: string;
  publishedAt?: string;
  updatedAt: string;
  adminNotice: string;
};

export type SystemHistoryEntry = {
  id: string;
  changedAt: string;
  actorId: string;
  actorType: ActorType;
  target: string;
  before: unknown;
  after: unknown;
  reason: string;
  targetMonth: string;
};

export type AdminState = {
  selectedMonth: string;
  closedDatesByMonth: Record<string, string[]>;
  filterStatus: "all" | SubmitStatus | "unsubmitted";
  filterText: string;
  selectedChildId: string;
  correctionChildId: string;
  correctionDate: string;
  correctionEnabled: boolean;
  correctionStart: string;
  correctionEnd: string;
  correctionReason: string;
  menu: AdminMenuKey;
  selectedStaffId: string;
  leaveCorrectionStaffId: string;
  staffLeaveDate: string;
  childCountDate: string;
  slotMinutes: 15 | 30;
  shiftEditStaffId: string;
  shiftEditDate: string;
  shiftEditStart: string;
  shiftEditEnd: string;
  shiftEditBreak: number;
  shiftEditRole: StaffRole;
  shiftEditFixed: boolean;
  shiftEditReason: string;
};

export type PrototypeStore = {
  version: 3;
  children: ChildProfile[];
  schedules: Record<string, ScheduleRecord>;
  staff: StaffProfile[];
  leavePeriods: Record<string, LeavePeriod>;
  leaveRequests: Record<string, LeaveRequest>;
  placementRules: PlacementRule[];
  shifts: Record<string, ShiftRecord>;
  histories: SystemHistoryEntry[];
  admin: AdminState;
};
