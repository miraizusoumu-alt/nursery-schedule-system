"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

  const load = useCallback(async (month: string, date = `${month}-01`, versionId = "") => {
    const query = new URLSearchParams({ targetMonth: month, selectedDate: date });
    if (versionId) query.set("versionId", versionId);
    const result = await api<{ schedule: StaffSchedule }>(`/api/admin/staff-schedules?${query}`);
    setSchedule(result.schedule);
    setAutomaticPreview(null);
    setTargetMonth(month);
    setSelectedDate(result.schedule.selectedDate);
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
      if (caught instanceof ApiError && caught.code === "STAFF_SCHEDULE_VERSION_CHANGED") {
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
          {schedule?.viewedVersion?.isCurrent && schedule.viewedVersion.status === "draft" ? <button type="button" className="primary" disabled={busy !== ""} onClick={() => {
            if (!window.confirm(`${formatMonth(targetMonth)}のシフトを確定しますか？`)) return;
            void run("confirm", async () => {
              const result = await api<{ schedule: StaffSchedule }>("/api/admin/staff-schedules/confirm", { method: "POST", body: { targetMonth, versionId: schedule.viewedVersion?.id } });
              setSchedule(result.schedule);
              setMessage("月間シフトを確定しました。");
            });
          }}>{busy === "confirm" ? "確定中..." : "シフトを確定"}</button> : null}
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

      {automaticPreview && !schedule?.month ? <section className="auth-section automatic-shift-preview">
        <div className="auth-section-heading">
          <div><span>{formatMonth(automaticPreview.targetMonth)} / 保存前</span><h3>自動シフト案</h3></div>
          <span className={`admin-state ${automaticPreview.hasUnresolved ? "warning" : "confirmed"}`}>{automaticPreview.hasUnresolved ? "要確認" : "確認事項なし"}</span>
        </div>
        <p className="admin-schedule-note">園児の採用中の利用予定から15分単位の必要人数を計算しています。内容を確認してから下書きを作成してください。</p>
        <div className="automatic-preview-issues" aria-label="自動作成の未解決事項">
          {!automaticPreview.hasUnresolved ? <p className="auth-message info">自動作成上の未解決事項はありません。</p> : previewIssueGroups.map(([kind, label, issues]) => issues.length ? <details key={kind}>
            <summary>{label}（{issues.length}件）</summary>
            <ul>{issues.map((issue, index) => <li key={`${kind}-${index}`}>{issueLabel(issue, kind)}</li>)}</ul>
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

      {schedule ? <section className="auth-section">
        <div className="auth-section-heading"><div><span>{formatMonth(targetMonth)}</span><h3>職員と日付を選択</h3></div></div>
        <div className="staff-schedule-selection">
          <label><span>職員</span><select value={selectedStaffId} onChange={(event) => setSelectedStaffId(event.currentTarget.value)}>{schedule.staff.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}（{staff.staffCode}）</option>)}</select></label>
          <label><span>日付</span><select value={selectedDate} onChange={(event) => {
            const date = event.currentTarget.value;
            void run("date", async () => { await load(targetMonth, date, schedule.viewedVersion?.isCurrent ? "" : schedule.viewedVersion?.id ?? ""); });
          }}>{dates.map((date) => <option key={date} value={date}>{formatDate(date)}</option>)}</select></label>
        </div>
        {!schedule.staff.length ? <p className="admin-schedule-note">この月に在籍する職員がいません。</p> : null}
      </section> : null}

      {selectedStaff ? <section className="auth-section staff-preference-editor">
        <div className="auth-section-heading">
          <div><span>{selectedStaff.name} / {formatDate(selectedDate)}</span><h3>希望休・希望勤務時間</h3></div>
          {selectedStaff.selectedPreference.requiresAdministratorReview ? <span className="admin-state warning">要確認</span> : null}
        </div>
        <p className="admin-schedule-note">実際の公休・有給とは別に、シフト作成前の希望を登録します。</p>
        <div className="staff-preference-options" role="radiogroup" aria-label="希望内容">
          <label><input type="radio" name="staff-preference" checked={preferenceType === "none"} disabled={busy !== ""} onChange={() => setPreferenceType("none")} />希望なし</label>
          <label><input type="radio" name="staff-preference" checked={preferenceType === "day_off"} disabled={busy !== ""} onChange={() => setPreferenceType("day_off")} />希望休</label>
          <label><input type="radio" name="staff-preference" checked={preferenceType === "work_time"} disabled={busy !== ""} onChange={() => setPreferenceType("work_time")} />希望勤務時間</label>
        </div>
        {preferenceType === "work_time" ? <div className="staff-preference-times">
          <label><span>希望開始</span><select value={preferenceStartTime} disabled={busy !== ""} onChange={(event) => setPreferenceStartTime(event.currentTarget.value)}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
          <label><span>希望終了</span><select value={preferenceEndTime} disabled={busy !== ""} onChange={(event) => setPreferenceEndTime(event.currentTarget.value)}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
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

          <section className="auth-section staff-schedule-editor">
            <div className="auth-section-heading"><div><span>{selectedStaff.name} / {formatDate(selectedDate)}</span><h3>日別シフト</h3></div>{readOnly ? <span className="admin-state confirmed">閲覧のみ</span> : null}</div>
            <label><span>日別状態</span><select value={dayType} disabled={readOnly || busy !== ""} onChange={(event) => {
              const value = event.currentTarget.value as DayType;
              setDayType(value);
              if (value === "day_off" || value === "paid_leave") setSegments([]);
              else if (!segments.length) setSegments(defaultSegments());
            }}>{Object.entries(dayTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {dayType === "work" || dayType === "other" ? <div className="staff-schedule-segments">
              {segments.map((segment, index) => <div key={`${index}:${segment.id ?? "new"}`}>
                <label><span>開始</span><select value={segment.startTime} disabled={readOnly || busy !== ""} onChange={(event) => setSegments((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, startTime: event.currentTarget.value } : entry))}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                <label><span>終了</span><select value={segment.endTime} disabled={readOnly || busy !== ""} onChange={(event) => setSegments((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, endTime: event.currentTarget.value } : entry))}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                <label><span>勤務内容</span><select value={segment.activityType} disabled={readOnly || busy !== ""} onChange={(event) => setSegments((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, activityType: event.currentTarget.value as ActivityType } : entry))}>{Object.entries(activityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <button type="button" className="icon-button" title="勤務区分を削除" aria-label="勤務区分を削除" disabled={readOnly || busy !== ""} onClick={() => setSegments((current) => current.filter((_, entryIndex) => entryIndex !== index))}>×</button>
              </div>)}
              <button type="button" disabled={readOnly || busy !== ""} onClick={() => setSegments((current) => [...current, { startTime: "09:00", endTime: "10:00", activityType: "childcare" }])}>＋ 勤務区分を追加</button>
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
              setMessage(`${selectedStaff.name}の${formatDate(selectedDate)}を保存しました。`);
            })}>{busy === "save" ? "保存中..." : "日別シフトを保存"}</button>
            {dayType === "other" ? <p className="admin-schedule-note">「その他」の詳細備考は将来追加します。勤務区分がある場合は予定実労働時間と連続勤務へ含まれます。</p> : null}
          </section>
        </> : null}
      </> : <section className="auth-section"><p className="admin-schedule-note">対象月のシフトを作成すると、職員別の日次シフトを入力できます。</p></section>}
    </div>
  );
}
