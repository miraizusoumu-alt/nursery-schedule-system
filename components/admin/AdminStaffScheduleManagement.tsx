"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminIcon } from "@/components/ui/AdminIcon";
import { ApiError, api } from "@/lib/client/api";

type DayType = "work" | "day_off" | "paid_leave" | "other";
type ActivityType = "childcare" | "break" | "administration" | "training" | "meal_service" | "other_work";
type Segment = { id?: string; startTime: string; endTime: string; activityType: ActivityType };
type ScheduleDay = { id: string; date: string; dayType: DayType; segments: Segment[] };
type StaffPreferenceType = "none" | "day_off" | "work_time";
type StaffPreference = {
  id: string | null;
  date: string;
  preferenceType: StaffPreferenceType;
  startTime: string | null;
  endTime: string | null;
  requiresAdministratorReview: boolean;
  reviewMessage: string | null;
  weeklyAvailability: null | { available: boolean; startTime: string | null; endTime: string | null };
};
type StaffSummary = {
  id: string;
  staffCode: string;
  name: string;
  employmentType: string | null;
  days: ScheduleDay[];
  selectedPreference: StaffPreference;
  selectedDay: ScheduleDay | null;
  selectedDayScheduledWorkMinutes: number;
  selectedWeek: { startDate: string; endDate: string };
  weeklyScheduledWorkMinutes: number;
  monthlyScheduledWorkMinutes: number;
  basicMonthlyScheduledWorkMinutes: number | null;
  monthlyScheduledWorkDifferenceMinutes: number | null;
  daysOff: {
    applies: boolean;
    dayOffDays: number;
    paidLeaveDays: number;
    requiredDaysOff: number | null;
    shortageDays: number;
    warning: string | null;
  };
  consecutiveWorkWarnings: Array<{ startDate: string; endDate: string; consecutiveDays: number; message: string }>;
};
type ScheduleHalf = "first" | "second";
type StaffSchedule = {
  targetMonth: string;
  fiscalYear: number;
  selectedDate: string;
  dayCount: number;
  weekStartsOn: number;
  month: null | { id: string; status: "draft" | "confirmed"; currentVersionId: string; confirmedAt: string | null };
  viewedVersion: null | {
    id: string;
    versionNumber: number;
    status: "draft" | "confirmed";
    sourceVersionId: string | null;
    confirmedAt: string | null;
    isCurrent: boolean;
    readOnly: boolean;
  };
  versions: Array<{ id: string; versionNumber: number; status: "draft" | "confirmed"; confirmedAt: string | null; createdAt: string }>;
  availableMonths: Array<{ targetMonth: string; status: "draft" | "confirmed"; confirmedAt: string | null }>;
  staff: StaffSummary[];
};
type AutomaticPreviewIssue = {
  code?: string;
  staffId?: string;
  staffCode?: string;
  staffName?: string;
  message?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  shortageDays?: number;
  requiredBreakMinutes?: number;
  childcareWorkerShortage?: number;
  licensedNurseryTeacherShortage?: number;
  requiredChildcareWorkers?: number;
  assignedChildcareWorkerCount?: number;
  requiredLicensedNurseryTeachers?: number;
  assignedLicensedNurseryTeacherCount?: number;
  eligibleChildcareWorkerCandidateCount?: number;
  eligibleLicensedNurseryTeacherCandidateCount?: number;
  candidateStaffCount?: number;
  exclusionReasons?: Array<{ code: string; label: string; count: number }>;
  workStartTime?: string | null;
  workEndTime?: string | null;
  unresolvedReasonLabel?: string;
  generalReliefUnavailable?: boolean;
  qualifiedReliefUnavailable?: boolean;
};
type AutomaticPreviewDay = {
  staffId: string;
  staffCode: string;
  staffName: string;
  date: string;
  dayType: DayType;
  segments: Segment[];
  scheduledWorkMinutes: number;
};
type AutomaticPreview = {
  targetMonth: string;
  sourcePeriod: { id: string; targetMonth: string; status: string };
  requirementSlotCount: number;
  days: AutomaticPreviewDay[];
  issues: {
    childcareStaffing: AutomaticPreviewIssue[];
    licensedStaffing: AutomaticPreviewIssue[];
    daysOff: AutomaticPreviewIssue[];
    consecutiveWork: AutomaticPreviewIssue[];
    breaks: AutomaticPreviewIssue[];
  };
  hasUnresolved: boolean;
};
type DraftReviewIssue = AutomaticPreviewIssue & {
  label?: string;
  activityType?: ActivityType;
  actualMinutes?: number;
  limitMinutes?: number;
  actualBreakMinutes?: number;
  scheduledWorkMinutes?: number;
  dayOffDays?: number;
  requiredDaysOff?: number;
  consecutiveDays?: number;
  startDate?: string;
  shortage?: number;
  actualDays?: number;
  limitDays?: number;
  minimumDays?: number;
  weekStart?: string;
  weekEnd?: string;
  missingContextMonths?: string[];
};
type DraftReviewIssueKind = "childcareStaffing" | "licensedStaffing" | "workConditions" | "breaks";
type DraftConfirmationIssue = DraftReviewIssue & {
  kind: DraftReviewIssueKind;
  code: string;
  label: string;
};
type DraftConfirmation = {
  status: "blocked" | "warning" | "ready";
  canConfirm: boolean;
  requiresConfirmation: boolean;
  redCount: number;
  yellowCount: number;
  redSummary: Array<{ code: string; label: string; count: number }>;
  yellowSummary: Array<{ code: string; label: string; count: number }>;
  redIssues: DraftConfirmationIssue[];
  yellowIssues: DraftConfirmationIssue[];
};
type DraftReview = {
  targetMonth: string;
  versionId: string;
  checkedAt: string;
  sourcePeriod: { id: string; targetMonth: string; status: string };
  requirementSlotCount: number;
  issues: {
    childcareStaffing: DraftReviewIssue[];
    licensedStaffing: DraftReviewIssue[];
    workConditions: DraftReviewIssue[];
    breaks: DraftReviewIssue[];
  };
  summary: {
    childcareStaffing: number;
    licensedStaffing: number;
    workConditions: number;
    breaks: number;
  };
  hasIssues: boolean;
  confirmation: DraftConfirmation;
};
type StaffPreferenceOverview = {
  period: null | { id: string; targetMonth: string; deadlineAt: string; status: "draft" | "open" | "closed"; writable: boolean };
  staff: Array<{
    id: string;
    staffCode: string;
    name: string;
    submissionStatus: "unentered" | "draft" | "submitted";
    submittedAt: string | null;
    revision: number;
    dayOffCount: number;
    hasWorkTimePreference: boolean;
    administratorInput: boolean;
  }>;
};

const dayTypeLabels: Record<DayType, string> = {
  work: "勤務",
  day_off: "公休",
  paid_leave: "有給",
  other: "その他",
};
const activityLabels: Record<ActivityType, string> = {
  childcare: "保育",
  break: "休憩",
  administration: "事務",
  training: "研修",
  meal_service: "配膳",
  other_work: "その他業務",
};
const tableWeekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
const timeOptions = Array.from({ length: (14 * 60) / 15 + 1 }, (_, index) => {
  const minutes = 6 * 60 + 30 + index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
const defaultSegments = (): Segment[] => [
  { startTime: "09:00", endTime: "12:00", activityType: "childcare" },
  { startTime: "12:00", endTime: "13:00", activityType: "break" },
  { startTime: "13:00", endTime: "17:00", activityType: "childcare" },
  { startTime: "17:00", endTime: "18:00", activityType: "administration" },
];

function fiscalYearForMonth(targetMonth: string) {
  const [year, month] = targetMonth.split("-").map(Number);
  return month >= 4 ? year : year - 1;
}

function monthsForFiscalYear(fiscalYear: number) {
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(fiscalYear, 3 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

function currentTargetMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function formatDate(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function tokyoDateTimeInput(value: string | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const item = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${item.year}-${item.month}-${item.day}T${item.hour}:${item.minute}`;
}

function formatTableDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return `${Number(value.slice(-2))}日（${tableWeekdayLabels[date.getUTCDay()]}）`;
}

function scheduleCellLines(day: ScheduleDay | null) {
  if (!day) return [{ key: "empty", label: "－", kind: "empty" }];
  if (day.dayType === "day_off" || day.dayType === "paid_leave") {
    return [{ key: day.dayType, label: dayTypeLabels[day.dayType], kind: "state" }];
  }
  const lines = day.segments.map((segment, index) => ({
    key: `${segment.startTime}-${segment.endTime}-${segment.activityType}-${index}`,
    label: `${segment.activityType === "childcare" ? "" : segment.activityType === "break" ? "休 " : `${activityLabels[segment.activityType]} `}${segment.startTime}～${segment.endTime}`,
    kind: segment.activityType === "break" ? "break" : "work",
  }));
  if (day.dayType === "other") {
    lines.unshift({ key: "other", label: dayTypeLabels.other, kind: "state" });
  }
  return lines.length ? lines : [{ key: day.dayType, label: dayTypeLabels[day.dayType], kind: "state" }];
}

function ScheduleCellContent({ day }: { day: ScheduleDay | null }) {
  return <>{scheduleCellLines(day).map((line) => <span key={line.key} className={`staff-schedule-cell-line ${line.kind}`}>{line.label}</span>)}</>;
}

function formatMinutes(value: number) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 60)}時間${String(absolute % 60).padStart(2, "0")}分`;
}

function automaticDayWindow(day: AutomaticPreviewDay) {
  if (day.dayType !== "work" || !day.segments.length) return dayTypeLabels[day.dayType];
  return `${day.segments[0].startTime}～${day.segments.at(-1)?.endTime}`;
}

function issueLabel(issue: AutomaticPreviewIssue, kind: keyof AutomaticPreview["issues"]) {
  const staff = issue.staffName ? `${issue.staffName}${issue.staffCode ? `（${issue.staffCode}）` : ""}: ` : "";
  const time = issue.startTime ? issue.endTime ? ` ${issue.startTime}～${issue.endTime}` : ` ${issue.startTime}` : "";
  const when = issue.date ? `${formatDate(issue.date)}${time}` : "対象月内";
  if (kind === "childcareStaffing") return `${when}: 保育従事者が${issue.childcareWorkerShortage ?? 0}人不足`;
  if (kind === "licensedStaffing") return `${when}: 保育士資格者が${issue.licensedNurseryTeacherShortage ?? 0}人不足`;
  if (kind === "consecutiveWork") return `${staff}${when}: 最大6連勤の条件を満たせません`;
  if (kind === "breaks") return `${staff}${when}: ${issue.requiredBreakMinutes ? `${issue.requiredBreakMinutes}分の` : "必要な"}休憩を配置できません`;
  if (issue.code === "DAY_OFF_TARGET_UNRESOLVED") return `${staff}公休9日まであと${issue.shortageDays ?? 0}日を安全に割り当てられません`;
  if (issue.code === "DAY_OFF_PREFERENCE_REQUIRES_REVIEW") return `${staff}${when}: 公休に分類できない希望休があります`;
  return `${staff}${issue.message ?? "公休9日の計画に確認が必要です"}`;
}

function AutomaticIssueDetails({ issue, kind }: {
  issue: AutomaticPreviewIssue;
  kind: keyof AutomaticPreview["issues"];
}) {
  const isStaffingIssue = kind === "childcareStaffing" || kind === "licensedStaffing";
  const isBreakIssue = kind === "breaks";

  return <details className="automatic-preview-issue-detail">
    <summary><span>{issueLabel(issue, kind)}</span><strong>理由を見る</strong></summary>
    <div className="automatic-preview-issue-body">
      {isStaffingIssue ? <>
        <dl className="automatic-preview-issue-metrics">
          <div><dt>必要保育従事者</dt><dd>{issue.requiredChildcareWorkers ?? 0}名</dd></div>
          <div><dt>配置済み</dt><dd>{issue.assignedChildcareWorkerCount ?? 0}名</dd></div>
          <div><dt>不足</dt><dd>{issue.childcareWorkerShortage ?? 0}名</dd></div>
          <div><dt>必要保育士資格者</dt><dd>{issue.requiredLicensedNurseryTeachers ?? 0}名</dd></div>
          <div><dt>配置済み資格者</dt><dd>{issue.assignedLicensedNurseryTeacherCount ?? 0}名</dd></div>
          <div><dt>資格者不足</dt><dd>{issue.licensedNurseryTeacherShortage ?? 0}名</dd></div>
          {kind === "licensedStaffing" ? <div><dt>有効な資格者候補</dt><dd>{issue.eligibleLicensedNurseryTeacherCandidateCount ?? 0}名</dd></div> : null}
        </dl>
        <div className="automatic-preview-exclusion-reasons">
          <h5>配置できない主な理由</h5>
          {issue.exclusionReasons?.length ? <ul>{issue.exclusionReasons.map((reason) => <li key={reason.code}><span>{reason.label}</span><strong>{reason.count}名</strong></li>)}</ul>
            : <p>候補職員の除外理由はありません。</p>}
          <p className="admin-schedule-note">1人に複数の理由がある場合は、それぞれに数えています。</p>
        </div>
      </> : null}
      {isBreakIssue ? <>
        <dl className="automatic-preview-issue-metrics">
          <div><dt>勤務時間</dt><dd>{issue.workStartTime && issue.workEndTime ? `${issue.workStartTime}～${issue.workEndTime}` : "確認できません"}</dd></div>
          <div><dt>必要休憩</dt><dd>{issue.requiredBreakMinutes ?? 0}分</dd></div>
          <div><dt>未配置理由</dt><dd>{issue.unresolvedReasonLabel ?? "交代要員を確保できません"}</dd></div>
        </dl>
        <ul className="automatic-preview-break-reasons">
          {issue.generalReliefUnavailable ? <li>一般の交代要員が不足しています。</li> : null}
          {issue.qualifiedReliefUnavailable ? <li>保育士資格者の交代要員が不足しています。</li> : null}
        </ul>
      </> : null}
      {!isStaffingIssue && !isBreakIssue ? <p>{issue.message ?? issueLabel(issue, kind)}</p> : null}
    </div>
  </details>;
}

function draftReviewIssueLabel(issue: DraftReviewIssue, kind: keyof DraftReview["issues"]) {
  if (kind === "childcareStaffing" || kind === "licensedStaffing") {
    return issueLabel(issue, kind);
  }
  const staff = issue.staffName ? `${issue.staffName}${issue.staffCode ? `（${issue.staffCode}）` : ""}` : "対象職員";
  const date = issue.date ? formatDate(issue.date) : "対象月内";
  const time = issue.startTime && issue.endTime ? ` ${issue.startTime}～${issue.endTime}` : "";
  return `${staff} / ${date}${time}: ${issue.label ?? "確認が必要です"}`;
}

function DraftReviewIssueDetails({ issue, kind }: {
  issue: DraftReviewIssue;
  kind: keyof DraftReview["issues"];
}) {
  if (kind === "childcareStaffing" || kind === "licensedStaffing") {
    return <AutomaticIssueDetails issue={issue} kind={kind} />;
  }
  return <details className="automatic-preview-issue-detail">
    <summary><span>{draftReviewIssueLabel(issue, kind)}</span><strong>詳細を見る</strong></summary>
    <div className="automatic-preview-issue-body">
      {kind === "workConditions" ? <dl className="automatic-preview-issue-metrics">
        {issue.actualMinutes !== undefined ? <div><dt>予定実労働</dt><dd>{formatMinutes(issue.actualMinutes)}</dd></div> : null}
        {issue.limitMinutes !== undefined ? <div><dt>上限</dt><dd>{formatMinutes(issue.limitMinutes)}</dd></div> : null}
        {issue.consecutiveDays !== undefined ? <div><dt>連続勤務</dt><dd>{issue.consecutiveDays}日</dd></div> : null}
        {issue.requiredDaysOff !== undefined ? <div><dt>必要公休</dt><dd>{issue.requiredDaysOff}日</dd></div> : null}
        {issue.dayOffDays !== undefined ? <div><dt>現在の公休</dt><dd>{issue.dayOffDays}日</dd></div> : null}
        {issue.shortageDays !== undefined ? <div><dt>不足公休</dt><dd>{issue.shortageDays}日</dd></div> : null}
        {issue.actualDays !== undefined ? <div><dt>週の勤務日数</dt><dd>{issue.actualDays}日</dd></div> : null}
        {issue.limitDays !== undefined ? <div><dt>週最大勤務日数</dt><dd>{issue.limitDays}日</dd></div> : null}
        {issue.minimumDays !== undefined ? <div><dt>週希望最低日数</dt><dd>{issue.minimumDays}日</dd></div> : null}
        {issue.weekStart && issue.weekEnd ? <div><dt>対象週</dt><dd>{formatDate(issue.weekStart)}～{formatDate(issue.weekEnd)}</dd></div> : null}
        {issue.missingContextMonths?.length ? <div><dt>未確認の月</dt><dd>{issue.missingContextMonths.join("、")}</dd></div> : null}
      </dl> : null}
      {kind === "breaks" ? <dl className="automatic-preview-issue-metrics">
        <div><dt>勤務時間</dt><dd>{issue.workStartTime && issue.workEndTime ? `${issue.workStartTime}～${issue.workEndTime}` : "確認できません"}</dd></div>
        <div><dt>必要休憩</dt><dd>{issue.requiredBreakMinutes ?? 0}分</dd></div>
        <div><dt>実際の休憩</dt><dd>{issue.actualBreakMinutes ?? 0}分</dd></div>
        {issue.requiredChildcareWorkers !== undefined ? <div><dt>必要保育従事者</dt><dd>{issue.requiredChildcareWorkers}名</dd></div> : null}
        {issue.assignedChildcareWorkerCount !== undefined ? <div><dt>配置済み</dt><dd>{issue.assignedChildcareWorkerCount}名</dd></div> : null}
        {issue.requiredLicensedNurseryTeachers !== undefined ? <div><dt>必要保育士資格者</dt><dd>{issue.requiredLicensedNurseryTeachers}名</dd></div> : null}
        {issue.assignedLicensedNurseryTeacherCount !== undefined ? <div><dt>配置済み資格者</dt><dd>{issue.assignedLicensedNurseryTeacherCount}名</dd></div> : null}
      </dl> : null}
      <p>{issue.label ?? "現在の下書きに確認が必要です。"}</p>
    </div>
  </details>;
}

function DraftReviewIssueGroup({
  kind,
  label,
  issues,
}: {
  kind: keyof DraftReview["issues"];
  label: string;
  issues: DraftReviewIssue[];
}) {
  const [expanded, setExpanded] = useState(false);
  return <details onToggle={(event) => {
    const open = event.currentTarget.open;
    setExpanded(open);
  }}>
    <summary>{label}（{issues.length}件）</summary>
    {expanded ? <ul className="automatic-preview-issue-list">{issues.map((issue, index) => <li key={`${kind}-${issue.code ?? "issue"}-${index}`}><DraftReviewIssueDetails issue={issue} kind={kind} /></li>)}</ul> : null}
  </details>;
}

function DraftConfirmationStatus({ confirmation }: { confirmation: DraftConfirmation }) {
  const blocked = confirmation.status === "blocked";
  const warning = confirmation.status === "warning";
  const issues = blocked ? confirmation.redIssues : warning ? confirmation.yellowIssues : [];
  const summaries = blocked ? confirmation.redSummary : warning ? confirmation.yellowSummary : [];
  const title = blocked ? "このシフトはまだ確定できません" : warning ? "確認事項があります" : "確定可能です";
  const description = blocked
    ? "確定前に赤の問題を修正してください。管理者確認だけでは確定できません。"
    : warning
      ? "内容を確認した管理者だけが、明示的な確認操作で確定できます。"
      : "現在のシフトに確定を妨げる問題はありません。";

  return <div className={`schedule-confirmation-status ${confirmation.status}`} role={blocked ? "alert" : "status"}>
    <div>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
    {summaries.length ? <ul className="schedule-confirmation-summary">
      {summaries.map((summary) => <li key={summary.code}><span>{summary.label}</span><strong>{summary.count}件</strong></li>)}
    </ul> : null}
    {issues.length ? <details>
      <summary>{blocked ? "確定前に修正する箇所を見る" : "管理者が確認する項目を見る"}（{issues.length}件）</summary>
      <ul className="schedule-confirmation-issues">
        {issues.map((issue, index) => <li key={`${issue.kind}-${issue.code}-${index}`}>
          <strong>{issue.label}</strong>
          <span>{draftReviewIssueLabel(issue, issue.kind)}</span>
        </li>)}
      </ul>
    </details> : null}
  </div>;
}

export function AdminStaffScheduleManagement() {
  const initialMonth = currentTargetMonth();
  const [schedule, setSchedule] = useState<StaffSchedule | null>(null);
  const [targetMonth, setTargetMonth] = useState(initialMonth);
  const [selectedDate, setSelectedDate] = useState(`${initialMonth}-01`);
  const [selectedStaffId, setSelectedStaffId] = useState("");
  const [dayType, setDayType] = useState<DayType>("work");
  const [segments, setSegments] = useState<Segment[]>(defaultSegments);
  const [preferenceType, setPreferenceType] = useState<StaffPreferenceType>("none");
  const [preferenceStartTime, setPreferenceStartTime] = useState("09:00");
  const [preferenceEndTime, setPreferenceEndTime] = useState("18:00");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [automaticPreview, setAutomaticPreview] = useState<AutomaticPreview | null>(null);
  const [draftReview, setDraftReview] = useState<DraftReview | null>(null);
  const [preferenceOverview, setPreferenceOverview] = useState<StaffPreferenceOverview | null>(null);
  const [preferenceDeadline, setPreferenceDeadline] = useState("");
  const [preferencePeriodStatus, setPreferencePeriodStatus] = useState<"draft" | "open" | "closed">("draft");
  const [dayEditorDirty, setDayEditorDirty] = useState(false);
  const [preferenceEditorDirty, setPreferenceEditorDirty] = useState(false);
  const [scheduleHalf, setScheduleHalf] = useState<ScheduleHalf>("first");
  const [compactDate, setCompactDate] = useState(`${initialMonth}-01`);
  const dayEditorRef = useRef<HTMLElement>(null);

  const load = useCallback(async (month: string, date = `${month}-01`, versionId = "") => {
    const query = new URLSearchParams({ targetMonth: month, selectedDate: date });
    if (versionId) query.set("versionId", versionId);
    const result = await api<{ schedule: StaffSchedule }>(`/api/admin/staff-schedules?${query}`);
    setSchedule(result.schedule);
    setAutomaticPreview(null);
    setDraftReview(null);
    setDayEditorDirty(false);
    setPreferenceEditorDirty(false);
    setTargetMonth(month);
    setSelectedDate(result.schedule.selectedDate);
    setScheduleHalf(Number(result.schedule.selectedDate.slice(-2)) <= 15 ? "first" : "second");
    setCompactDate(result.schedule.selectedDate);
    setSelectedStaffId((current) => result.schedule.staff.some((staff) => staff.id === current)
      ? current
      : result.schedule.staff[0]?.id ?? "");
    return result.schedule;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(initialMonth).catch((caught) => setError(caught instanceof Error ? caught.message : "シフトを読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialMonth, load]);

  const loadPreferenceOverview = useCallback(async (month: string) => {
    const result = await api<{ overview: StaffPreferenceOverview }>(`/api/admin/staff-preferences?targetMonth=${encodeURIComponent(month)}`);
    setPreferenceOverview(result.overview);
    setPreferenceDeadline(tokyoDateTimeInput(result.overview.period?.deadlineAt ?? null));
    setPreferencePeriodStatus(result.overview.period?.status ?? "draft");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPreferenceOverview(targetMonth).catch((caught) => setError(caught instanceof Error ? caught.message : "職員希望の提出状況を読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPreferenceOverview, targetMonth]);

  const selectedStaff = schedule?.staff.find((staff) => staff.id === selectedStaffId) ?? null;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedStaff?.selectedDay) {
        setDayType(selectedStaff.selectedDay.dayType);
        setSegments(selectedStaff.selectedDay.segments.map((segment) => ({ ...segment })));
      } else {
        setDayType("work");
        setSegments(defaultSegments());
      }
      const preference = selectedStaff?.selectedPreference;
      setPreferenceType(preference?.preferenceType ?? "none");
      setPreferenceStartTime(preference?.startTime ?? preference?.weeklyAvailability?.startTime ?? "09:00");
      setPreferenceEndTime(preference?.endTime ?? preference?.weeklyAvailability?.endTime ?? "18:00");
      setDayEditorDirty(false);
      setPreferenceEditorDirty(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedStaff]);

  async function run(operation: string, task: () => Promise<void>) {
    setBusy(operation);
    setMessage("");
    setError("");
    try {
      await task();
    } catch (caught) {
      if (caught instanceof ApiError
        && (caught.code === "SCHEDULE_CONFIRMATION_BLOCKED"
          || caught.code === "SCHEDULE_CONFIRMATION_REQUIRES_ACKNOWLEDGEMENT")) {
        const details = caught.details as { review?: DraftReview } | null;
        if (details?.review) setDraftReview(details.review);
        setError(caught.message);
      } else if (caught instanceof ApiError && caught.code === "STAFF_SCHEDULE_VERSION_CHANGED") {
        setError("別の操作でシフトが更新されました。最新状態を読み直してください。");
      } else {
        setError(caught instanceof Error ? caught.message : "処理できませんでした。");
      }
    } finally {
      setBusy("");
    }
  }

  const fiscalYear = fiscalYearForMonth(targetMonth);
  const fiscalYears = useMemo(() => [fiscalYear - 1, fiscalYear, fiscalYear + 1], [fiscalYear]);
  const fiscalMonths = useMemo(() => monthsForFiscalYear(fiscalYear), [fiscalYear]);
  const dates = useMemo(() => {
    const dayCount = schedule?.targetMonth === targetMonth
      ? schedule.dayCount
      : new Date(Date.UTC(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5, 7)), 0)).getUTCDate();
    return Array.from({ length: dayCount }, (_, index) => `${targetMonth}-${String(index + 1).padStart(2, "0")}`);
  }, [schedule, targetMonth]);
  const halfDates = useMemo(() => scheduleHalf === "first" ? dates.slice(0, 15) : dates.slice(15), [dates, scheduleHalf]);
  const readOnly = !schedule?.viewedVersion || schedule.viewedVersion.readOnly;
  const previewDates = useMemo(() => {
    const grouped = new Map<string, AutomaticPreviewDay[]>();
    for (const day of automaticPreview?.days ?? []) {
      const entries = grouped.get(day.date) ?? [];
      entries.push(day);
      grouped.set(day.date, entries);
    }
    return [...grouped.entries()];
  }, [automaticPreview]);
  const previewIssueGroups = automaticPreview ? [
    ["childcareStaffing", "保育従事者不足", automaticPreview.issues.childcareStaffing],
    ["licensedStaffing", "保育士資格者不足", automaticPreview.issues.licensedStaffing],
    ["daysOff", "公休計画", automaticPreview.issues.daysOff],
    ["consecutiveWork", "連勤条件", automaticPreview.issues.consecutiveWork],
    ["breaks", "休憩未配置", automaticPreview.issues.breaks],
  ] as const : [];
  const draftReviewIssueGroups = draftReview ? [
    ["childcareStaffing", "配置不足 / 保育従事者", draftReview.issues.childcareStaffing],
    ["licensedStaffing", "配置不足 / 保育士資格者", draftReview.issues.licensedStaffing],
    ["workConditions", "勤務条件", draftReview.issues.workConditions],
    ["breaks", "休憩", draftReview.issues.breaks],
  ] as const : [];
  const hasUnsavedEditorChanges = dayEditorDirty || preferenceEditorDirty;
  const currentDraftReview = draftReview && schedule?.viewedVersion?.id === draftReview.versionId
    ? draftReview
    : null;
  const confirmationStatus = currentDraftReview?.confirmation.status ?? null;

  function confirmCurrentDraft() {
    if (!schedule?.viewedVersion) return;
    if (hasUnsavedEditorChanges) {
      setMessage("");
      setError("未保存の変更があります。保存してから確定してください。");
      return;
    }
    void run("confirm", async () => {
      let latestReview = currentDraftReview;
      if (!latestReview) {
        const result = await api<{ review: DraftReview }>("/api/admin/staff-schedules/draft-review", {
          method: "POST",
          body: { targetMonth, versionId: schedule.viewedVersion?.id },
        });
        latestReview = result.review;
        setDraftReview(result.review);
      }
      if (latestReview.confirmation.status === "blocked") {
        setError("このシフトはまだ確定できません。確定前に赤の問題を修正してください。");
        return;
      }
      if (latestReview.confirmation.status === "warning" && !currentDraftReview) {
        setMessage("確認が必要な項目があります。内容を確認してから、明示的な確定操作を行ってください。");
        return;
      }
      const acknowledgeWarnings = latestReview.confirmation.status === "warning";
      const prompt = acknowledgeWarnings
        ? `黄色の確認事項${latestReview.confirmation.yellowCount}件を確認しました。${formatMonth(targetMonth)}のシフトを確定しますか？`
        : `${formatMonth(targetMonth)}のシフトを確定しますか？`;
      if (!window.confirm(prompt)) return;
      const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules/confirm", {
        method: "POST",
        body: {
          targetMonth,
          versionId: schedule.viewedVersion?.id,
          acknowledgeWarnings,
        },
      });
      setSchedule(result.schedule);
      setDraftReview(null);
      setMessage("月間シフトを確定しました。");
    });
  }

  function markDayEditorDirty() {
    setDayEditorDirty(true);
    setDraftReview(null);
  }

  function markPreferenceEditorDirty() {
    setPreferenceEditorDirty(true);
    setDraftReview(null);
  }

  function selectScheduleCell(staffId: string, date: string) {
    if (!schedule?.viewedVersion) return;
    if (hasUnsavedEditorChanges) {
      setMessage("");
      setError("未保存の変更があります。保存またはキャンセルしてから別の日を選択してください。");
      return;
    }
    const versionId = schedule.viewedVersion.isCurrent ? "" : schedule.viewedVersion.id;
    void run("cell", async () => {
      await load(targetMonth, date, versionId);
      setSelectedStaffId(staffId);
      setCompactDate(date);
      window.setTimeout(() => {
        dayEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        dayEditorRef.current?.querySelector<HTMLElement>("select, button")?.focus({ preventScroll: true });
      }, 0);
    });
  }

  return (
    <div className="admin-area-content staff-schedule-management">
      {message ? <p className="auth-message info" role="status">{message}</p> : null}
      {error ? <p className="auth-message error" role="alert">{error}</p> : null}

      <section className="auth-section">
        <div className="auth-section-heading">
          <div><span>月ごとに保存・確定</span><h2><AdminIcon name="clock" />月間職員シフト</h2></div>
          <span className={`admin-state ${schedule?.month?.status ?? "unsubmitted"}`}>
            {!schedule?.month ? "未作成" : schedule.month.status === "confirmed" ? "確定済み" : "作成中"}
          </span>
        </div>
        <div className="staff-schedule-period-controls">
          <label><span>対象年度</span><select value={fiscalYear} onChange={(event) => {
            const month = `${event.currentTarget.value}-04`;
            void run("load", async () => { await load(month); });
          }}>{fiscalYears.map((year) => <option key={year} value={year}>{year}年度</option>)}</select></label>
          <label><span>対象月</span><select value={targetMonth} onChange={(event) => {
            const month = event.currentTarget.value;
            void run("load", async () => { await load(month); });
          }}>{fiscalMonths.map((month) => <option key={month} value={month}>{formatMonth(month)}</option>)}</select></label>
          {!schedule?.month ? <button type="button" className="primary" disabled={busy !== ""} onClick={() => void run("create", async () => {
            const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules", { method: "POST", body: { targetMonth } });
            setSchedule(result.schedule);
            setSelectedStaffId(result.schedule.staff[0]?.id ?? "");
            setMessage(`${formatMonth(targetMonth)}のシフトを作成しました。`);
          })}>この月のシフトを作成</button> : null}
          {!schedule?.month ? <button type="button" disabled={busy !== ""} onClick={() => void run("automatic-preview", async () => {
            const result = await api<{ preview: AutomaticPreview }>("/api/admin/staff-schedules/automatic-preview", {
              method: "POST",
              body: { targetMonth },
            });
            setAutomaticPreview(result.preview);
            setMessage(`${formatMonth(targetMonth)}の自動シフト案を計算しました。まだ保存されていません。`);
          })}>{busy === "automatic-preview" ? "計算中..." : "自動シフトをプレビュー"}</button> : null}
          {schedule?.viewedVersion?.isCurrent && schedule.viewedVersion.status === "draft" ? <button type="button" disabled={busy !== ""} onClick={() => {
            if (hasUnsavedEditorChanges) {
              setMessage("");
              setError("未保存の変更があります。保存してから再チェックしてください。");
              return;
            }
            void run("draft-review", async () => {
              const result = await api<{ review: DraftReview }>("/api/admin/staff-schedules/draft-review", {
                method: "POST",
                body: { targetMonth, versionId: schedule.viewedVersion?.id },
              });
              setDraftReview(result.review);
              setMessage("保存済みの現在の下書きを再チェックしました。");
            });
          }}>{busy === "draft-review" ? "再チェック中..." : "現在の下書きを再チェック"}</button> : null}
          {schedule?.viewedVersion?.isCurrent && schedule.viewedVersion.status === "draft" ? <button
            type="button"
            className="primary"
            disabled={busy !== "" || hasUnsavedEditorChanges || confirmationStatus === "blocked"}
            onClick={confirmCurrentDraft}
          >{busy === "confirm"
              ? "確定前の再チェック中..."
              : confirmationStatus === "blocked"
                ? "修正後に確定できます"
                : confirmationStatus === "warning"
                  ? "確認事項を確認してシフトを確定"
                  : "シフトを確定"}</button> : null}
          {schedule?.viewedVersion?.isCurrent && schedule.viewedVersion.status === "confirmed" ? <button type="button" disabled={busy !== ""} onClick={() => {
            if (!window.confirm("確定済みシフトをコピーして、修正用の新しい下書きを作成しますか？")) return;
            void run("revision", async () => {
              const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules/revision", { method: "POST", body: { targetMonth } });
              setSchedule(result.schedule);
              setMessage("確定版を残して、修正用のシフトを作成しました。");
            });
          }}>シフトを修正</button> : null}
        </div>
        {schedule?.versions.length ? <details className="staff-schedule-history">
          <summary>過去の確定内容を確認</summary>
          <div>{schedule.versions.map((version) => <button key={version.id} type="button" className={schedule.viewedVersion?.id === version.id ? "active" : ""} disabled={busy !== ""} onClick={() => void run("history", async () => { await load(targetMonth, selectedDate, version.id); })}>{version.status === "confirmed" ? `確定済み ${version.confirmedAt ? new Date(version.confirmedAt).toLocaleDateString("ja-JP") : ""}` : "作成中"}</button>)}</div>
        </details> : null}
        {schedule?.month?.status === "draft" ? <p className="auth-message info">すでに作成中のシフトがあります。自動作成では上書きしません。</p> : null}
        {schedule?.month?.status === "confirmed" ? <p className="auth-message info">確定済みのシフトがあります。自動作成では変更しません。</p> : null}
      </section>

      <section className="auth-section staff-preference-overview">
        <div className="auth-section-heading">
          <div><span>{formatMonth(targetMonth)}</span><h3>職員希望の提出状況</h3></div>
          <span className={`admin-state ${preferenceOverview?.period?.status === "open" ? "confirmed" : "draft"}`}>
            {!preferenceOverview?.period ? "期間未設定" : preferenceOverview.period.status === "open" ? "受付中" : preferenceOverview.period.status === "closed" ? "受付終了" : "準備中"}
          </span>
        </div>
        <form className="staff-preference-period-form" onSubmit={(event) => {
          event.preventDefault();
          if (!preferenceDeadline) {
            setError("職員希望の提出期限を入力してください。");
            return;
          }
          void run("preference-period", async () => {
            const result = await api<{ overview: StaffPreferenceOverview }>("/api/admin/staff-preferences/period", { method: "PUT", body: {
              targetMonth,
              deadlineAt: new Date(`${preferenceDeadline}:00+09:00`).toISOString(),
              status: preferencePeriodStatus,
            } });
            setPreferenceOverview(result.overview);
            setPreferenceDeadline(tokyoDateTimeInput(result.overview.period?.deadlineAt ?? null));
            setMessage("職員希望の提出期間を保存しました。");
          });
        }}>
          <label><span>提出期限（日本時間）</span><input required type="datetime-local" value={preferenceDeadline} onChange={(event) => setPreferenceDeadline(event.currentTarget.value)} /></label>
          <label><span>受付状態</span><select value={preferencePeriodStatus} onChange={(event) => setPreferencePeriodStatus(event.currentTarget.value as "draft" | "open" | "closed")}><option value="draft">準備中</option><option value="open">受付中</option><option value="closed">受付終了</option></select></label>
          <button type="submit" disabled={busy !== ""}>{busy === "preference-period" ? "保存中..." : "提出期間を保存"}</button>
        </form>
        {preferenceOverview ? <div className="staff-preference-overview-list">
          {preferenceOverview.staff.map((staff) => {
            const status = staff.submissionStatus === "submitted"
              ? "提出済み"
              : staff.submissionStatus === "draft"
                ? "入力途中"
                : staff.administratorInput ? "管理者入力あり・本人未提出" : "未入力";
            return <article key={staff.id}>
              <div><strong>{staff.name}</strong><span>{staff.staffCode}</span></div>
              <span className={`admin-state ${staff.submissionStatus === "submitted" ? "confirmed" : staff.submissionStatus === "draft" ? "warning" : "draft"}`}>{status}</span>
              <div className="staff-preference-overview-counts"><span>希望休 {staff.dayOffCount}日</span><span>{staff.hasWorkTimePreference ? "時間希望あり" : "時間希望なし"}</span></div>
            </article>;
          })}
          {!preferenceOverview.staff.length ? <p className="admin-schedule-note">この月の対象職員はいません。</p> : null}
        </div> : <p className="admin-schedule-note">提出状況を読み込んでいます。</p>}
      </section>

      {schedule?.viewedVersion?.isCurrent && schedule.viewedVersion.status === "draft" && hasUnsavedEditorChanges
        ? <p className="auth-message warning" role="status">未保存の変更があります。保存してから確定してください。</p>
        : null}

      {automaticPreview && !schedule?.month ? <section className="auth-section automatic-shift-preview">
        <div className="auth-section-heading">
          <div><span>{formatMonth(automaticPreview.targetMonth)} / 保存前</span><h3>自動シフト案</h3></div>
          <span className={`admin-state ${automaticPreview.hasUnresolved ? "warning" : "confirmed"}`}>{automaticPreview.hasUnresolved ? "要確認" : "確認事項なし"}</span>
        </div>
        <p className="admin-schedule-note">園児の採用中の利用予定から15分単位の必要人数を計算しています。内容を確認してから下書きを作成してください。</p>
        <div className="automatic-preview-issues" aria-label="自動作成の未解決事項">
          {!automaticPreview.hasUnresolved ? <p className="auth-message info">自動作成上の未解決事項はありません。</p> : previewIssueGroups.map(([kind, label, issues]) => issues.length ? <details key={kind}>
            <summary>{label}（{issues.length}件）</summary>
            <ul className="automatic-preview-issue-list">{issues.map((issue, index) => <li key={`${kind}-${index}`}><AutomaticIssueDetails issue={issue} kind={kind} /></li>)}</ul>
          </details> : null)}
        </div>
        <div className="automatic-preview-days">
          {previewDates.map(([date, days], index) => <details key={date} open={index === 0}>
            <summary><strong>{formatDate(date)}</strong><span>{days.length}名の予定</span></summary>
            <div>{days.map((day) => <article key={`${day.staffId}:${day.date}`}>
              <div><strong>{day.staffName}</strong><span>{day.staffCode}</span></div>
              <dl><div><dt>状態・時間</dt><dd>{automaticDayWindow(day)}</dd></div><div><dt>予定実労働</dt><dd>{formatMinutes(day.scheduledWorkMinutes)}</dd></div></dl>
              {day.segments.length ? <ul>{day.segments.map((segment, segmentIndex) => <li key={`${segment.startTime}:${segmentIndex}`}><span>{activityLabels[segment.activityType]}</span><strong>{segment.startTime}～{segment.endTime}</strong></li>)}</ul> : null}
            </article>)}</div>
          </details>)}
          {!previewDates.length ? <p className="admin-schedule-note">表示できる勤務・公休予定がありません。</p> : null}
        </div>
        <div className="automatic-preview-actions">
          <p>保存時には最新の利用予定・職員条件で再計算します。</p>
          <button type="button" className="primary" disabled={busy !== ""} onClick={() => {
            if (!window.confirm("表示中の案を確認しました。最新条件で再計算して、作成中のシフトとして保存しますか？")) return;
            void run("automatic-draft", async () => {
              const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules/automatic-draft", {
                method: "POST",
                body: { targetMonth },
              });
              setAutomaticPreview(null);
              setSchedule(result.schedule);
              setSelectedStaffId(result.schedule.staff[0]?.id ?? "");
              setMessage(`${formatMonth(targetMonth)}の自動シフト案を作成中のシフトとして保存しました。`);
            });
          }}>{busy === "automatic-draft" ? "下書き作成中..." : "この内容で下書きを作成"}</button>
        </div>
      </section> : null}

      {draftReview && schedule?.viewedVersion?.id === draftReview.versionId ? <section className="auth-section automatic-shift-preview draft-schedule-review">
        <div className="auth-section-heading">
          <div><span>{formatMonth(draftReview.targetMonth)} / 現在の作成中版</span><h3>下書きの再チェック結果</h3></div>
          <span className={`admin-state ${draftReview.hasIssues ? "warning" : "confirmed"}`}>{draftReview.hasIssues ? "要確認" : "確認事項なし"}</span>
        </div>
        <p className="admin-schedule-note">保存済みの現在版を読み取り専用で評価しています。勤務・公休・休憩は変更していません。</p>
        <DraftConfirmationStatus confirmation={draftReview.confirmation} />
        <div className="automatic-preview-issues" aria-label="現在の下書きの確認事項">
          {!draftReview.hasIssues ? <p className="auth-message info">現在の下書きに確認が必要な項目はありません。</p> : draftReviewIssueGroups.map(([kind, label, issues]) => issues.length
            ? <DraftReviewIssueGroup key={kind} kind={kind} label={label} issues={issues} />
            : null)}
        </div>
        <p className="admin-schedule-note">確認日時: {new Date(draftReview.checkedAt).toLocaleString("ja-JP")}</p>
      </section> : null}

      {schedule?.month ? <section className="auth-section staff-schedule-half-view">
        <div className="auth-section-heading">
          <div><span>{formatMonth(targetMonth)} / {schedule.viewedVersion?.status === "confirmed" ? "確定済み" : "作成中"}</span><h3>職員別シフト表</h3></div>
          <div className="staff-schedule-half-switch" role="group" aria-label="表示する期間">
            <button type="button" className={scheduleHalf === "first" ? "active" : ""} aria-pressed={scheduleHalf === "first"} onClick={() => {
              setScheduleHalf("first");
              setCompactDate(dates[0] ?? `${targetMonth}-01`);
            }}>1日～15日</button>
            <button type="button" className={scheduleHalf === "second" ? "active" : ""} aria-pressed={scheduleHalf === "second"} onClick={() => {
              setScheduleHalf("second");
              setCompactDate(dates[15] ?? dates.at(-1) ?? `${targetMonth}-01`);
            }}>16日～月末</button>
          </div>
        </div>
        <p className="admin-schedule-note">職員と日付のセルを選ぶと、既存の日別シフト編集欄へ移動します。</p>
        <div className="staff-schedule-half-table-wrap">
          <table className="staff-schedule-half-table">
            <thead><tr><th className="staff-schedule-name-column" scope="col">職員</th>{halfDates.map((date) => <th key={date} scope="col">{formatTableDate(date)}</th>)}</tr></thead>
            <tbody>{schedule.staff.map((staff) => <tr key={staff.id}>
              <th className="staff-schedule-name-column" scope="row"><strong>{staff.name}</strong><span>{staff.staffCode}</span></th>
              {halfDates.map((date) => {
                const day = staff.days.find((entry) => entry.date === date) ?? null;
                const selected = selectedStaffId === staff.id && selectedDate === date;
                const summary = scheduleCellLines(day).map((line) => line.label).join("、");
                return <td key={date}><button type="button" className={selected ? "selected" : ""} disabled={busy !== ""} aria-label={`${staff.name} ${formatTableDate(date)} ${summary}`} onClick={() => selectScheduleCell(staff.id, date)}><ScheduleCellContent day={day} /></button></td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
        <div className="staff-schedule-mobile-view">
          <label><span>表示する日</span><select value={halfDates.includes(compactDate) ? compactDate : halfDates[0] ?? ""} onChange={(event) => setCompactDate(event.currentTarget.value)}>{halfDates.map((date) => <option key={date} value={date}>{formatTableDate(date)}</option>)}</select></label>
          <div className="staff-schedule-mobile-list">{schedule.staff.map((staff) => {
            const day = staff.days.find((entry) => entry.date === compactDate) ?? null;
            return <button key={staff.id} type="button" disabled={busy !== ""} className={selectedStaffId === staff.id && selectedDate === compactDate ? "selected" : ""} onClick={() => selectScheduleCell(staff.id, compactDate)}><span><strong>{staff.name}</strong><small>{staff.staffCode}</small></span><span className="staff-schedule-mobile-summary"><ScheduleCellContent day={day} /></span></button>;
          })}</div>
        </div>
      </section> : null}

      {schedule ? <section className="auth-section">
        <div className="auth-section-heading"><div><span>{formatMonth(targetMonth)}</span><h3>職員と日付を選択</h3></div></div>
        <div className="staff-schedule-selection">
          <label><span>職員</span><select value={selectedStaffId} onChange={(event) => selectScheduleCell(event.currentTarget.value, selectedDate)}>{schedule.staff.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}（{staff.staffCode}）</option>)}</select></label>
          <label><span>日付</span><select value={selectedDate} onChange={(event) => {
            const date = event.currentTarget.value;
            selectScheduleCell(selectedStaffId, date);
          }}>{dates.map((date) => <option key={date} value={date}>{formatDate(date)}</option>)}</select></label>
        </div>
        {!schedule.staff.length ? <p className="admin-schedule-note">この月に在籍する職員がいません。</p> : null}
      </section> : null}

      {selectedStaff ? <section className="auth-section staff-preference-editor">
        <div className="auth-section-heading">
          <div><span>{selectedStaff.name} / {formatDate(selectedDate)}</span><h3>希望休・希望勤務時間</h3></div>
          <span className={`admin-state ${preferenceEditorDirty ? "warning" : "confirmed"}`}>{busy === "preference" ? "保存中" : preferenceEditorDirty ? "未保存" : "保存済み"}</span>
        </div>
        <p className="admin-schedule-note">実際の公休・有給とは別に、シフト作成前の希望を登録します。</p>
        <div className="staff-preference-options" role="radiogroup" aria-label="希望内容">
          <label><input type="radio" name="staff-preference" checked={preferenceType === "none"} disabled={busy !== ""} onChange={() => { setPreferenceType("none"); markPreferenceEditorDirty(); }} />希望なし</label>
          <label><input type="radio" name="staff-preference" checked={preferenceType === "day_off"} disabled={busy !== ""} onChange={() => { setPreferenceType("day_off"); markPreferenceEditorDirty(); }} />希望休</label>
          <label><input type="radio" name="staff-preference" checked={preferenceType === "work_time"} disabled={busy !== ""} onChange={() => { setPreferenceType("work_time"); markPreferenceEditorDirty(); }} />希望勤務時間</label>
        </div>
        {preferenceType === "work_time" ? <div className="staff-preference-times">
          <label><span>希望開始</span><select value={preferenceStartTime} disabled={busy !== ""} onChange={(event) => { setPreferenceStartTime(event.currentTarget.value); markPreferenceEditorDirty(); }}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
          <label><span>希望終了</span><select value={preferenceEndTime} disabled={busy !== ""} onChange={(event) => { setPreferenceEndTime(event.currentTarget.value); markPreferenceEditorDirty(); }}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
        </div> : null}
        <p className="staff-preference-weekly">
          基本勤務可能時間: {selectedStaff.selectedPreference.weeklyAvailability?.available
            ? `${selectedStaff.selectedPreference.weeklyAvailability.startTime}～${selectedStaff.selectedPreference.weeklyAvailability.endTime}`
            : "勤務不可または未登録"}
        </p>
        {selectedStaff.selectedPreference.reviewMessage ? <p className="auth-message warning">{selectedStaff.selectedPreference.reviewMessage}</p> : null}
        <button type="button" className="primary" disabled={busy !== ""} onClick={() => void run("preference", async () => {
          const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules/preference", { method: "PUT", body: {
            targetMonth,
            staffId: selectedStaff.id,
            date: selectedDate,
            preferenceType,
            startTime: preferenceType === "work_time" ? preferenceStartTime : null,
            endTime: preferenceType === "work_time" ? preferenceEndTime : null,
          } });
          setSchedule(result.schedule);
          setPreferenceEditorDirty(false);
          setDraftReview(null);
          setMessage(`${selectedStaff.name}の${formatDate(selectedDate)}の希望を保存しました。`);
        })}>{busy === "preference" ? "保存中..." : "希望を保存"}</button>
      </section> : null}

      {schedule?.month ? <>
        {selectedStaff ? <>
          <section className="staff-schedule-metrics" aria-label={`${selectedStaff.name}の予定実労働時間`}>
            <div><span>選択日</span><strong>{formatMinutes(selectedStaff.selectedDayScheduledWorkMinutes)}</strong></div>
            <div><span>{formatDate(selectedStaff.selectedWeek.startDate)}～{formatDate(selectedStaff.selectedWeek.endDate)}</span><strong>{formatMinutes(selectedStaff.weeklyScheduledWorkMinutes)}</strong></div>
            <div><span>月間</span><strong>{formatMinutes(selectedStaff.monthlyScheduledWorkMinutes)}</strong></div>
            <div className={selectedStaff.daysOff.warning ? "warning" : ""}><span>公休</span><strong>{selectedStaff.daysOff.applies ? `${selectedStaff.daysOff.dayOffDays} / ${selectedStaff.daysOff.requiredDaysOff}日` : `${selectedStaff.daysOff.dayOffDays}日（非常勤等）`}</strong></div>
          </section>
          {selectedStaff.basicMonthlyScheduledWorkMinutes !== null ? <p className="staff-schedule-baseline">予定 {formatMinutes(selectedStaff.monthlyScheduledWorkMinutes)} / 基本 {formatMinutes(selectedStaff.basicMonthlyScheduledWorkMinutes)} / 差 {formatMinutes(selectedStaff.monthlyScheduledWorkDifferenceMinutes ?? 0)}</p> : null}
          {selectedStaff.daysOff.warning ? <p className="auth-message warning">{selectedStaff.daysOff.warning}</p> : null}

          <section ref={dayEditorRef} className="auth-section staff-schedule-editor">
            <div className="auth-section-heading"><div><span>{selectedStaff.name} / {formatDate(selectedDate)}</span><h3>日別シフト</h3></div>{readOnly ? <span className="admin-state confirmed">閲覧のみ</span> : <span className={`admin-state ${dayEditorDirty ? "warning" : "confirmed"}`}>{busy === "save" ? "保存中" : dayEditorDirty ? "未保存" : "保存済み"}</span>}</div>
            <label><span>日別状態</span><select value={dayType} disabled={readOnly || busy !== ""} onChange={(event) => {
              const value = event.currentTarget.value as DayType;
              setDayType(value);
              if (value === "day_off" || value === "paid_leave") setSegments([]);
              else if (!segments.length) setSegments(defaultSegments());
              markDayEditorDirty();
            }}>{Object.entries(dayTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {dayType === "work" || dayType === "other" ? <div className="staff-schedule-segments">
              {segments.map((segment, index) => <div key={`${index}:${segment.id ?? "new"}`}>
                <label><span>開始</span><select value={segment.startTime} disabled={readOnly || busy !== ""} onChange={(event) => {
                  const value = event.currentTarget.value;
                  setSegments((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, startTime: value } : entry));
                  markDayEditorDirty();
                }}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                <label><span>終了</span><select value={segment.endTime} disabled={readOnly || busy !== ""} onChange={(event) => {
                  const value = event.currentTarget.value;
                  setSegments((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, endTime: value } : entry));
                  markDayEditorDirty();
                }}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                <label><span>勤務内容</span><select value={segment.activityType} disabled={readOnly || busy !== ""} onChange={(event) => {
                  const value = event.currentTarget.value as ActivityType;
                  setSegments((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, activityType: value } : entry));
                  markDayEditorDirty();
                }}>{Object.entries(activityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <button type="button" className="icon-button" title="勤務区分を削除" aria-label="勤務区分を削除" disabled={readOnly || busy !== ""} onClick={() => {
                  setSegments((current) => current.filter((_, entryIndex) => entryIndex !== index));
                  markDayEditorDirty();
                }}>×</button>
              </div>)}
              <button type="button" disabled={readOnly || busy !== ""} onClick={() => {
                setSegments((current) => [...current, { startTime: "09:00", endTime: "10:00", activityType: "childcare" }]);
                markDayEditorDirty();
              }}>＋ 勤務区分を追加</button>
            </div> : <p className="admin-schedule-note">公休・有給には勤務時間を保存しません。</p>}
            <button type="button" className="primary" disabled={readOnly || busy !== "" || !schedule.viewedVersion} onClick={() => void run("save", async () => {
              const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules/day", { method: "PUT", body: {
                targetMonth,
                versionId: schedule.viewedVersion?.id,
                staffId: selectedStaff.id,
                date: selectedDate,
                dayType,
                segments: dayType === "day_off" || dayType === "paid_leave" ? [] : segments,
              } });
              setSchedule(result.schedule);
              setDayEditorDirty(false);
              setDraftReview(null);
              setMessage(`${selectedStaff.name}の${formatDate(selectedDate)}を保存しました。`);
            })}>{busy === "save" ? "保存中..." : "日別シフトを保存"}</button>
            {dayType === "other" ? <p className="admin-schedule-note">「その他」の詳細備考は将来追加します。勤務区分がある場合は予定実労働時間と連続勤務へ含まれます。</p> : null}
          </section>
        </> : null}
      </> : <section className="auth-section"><p className="admin-schedule-note">対象月のシフトを作成すると、職員別の日次シフトを入力できます。</p></section>}
    </div>
  );
}
