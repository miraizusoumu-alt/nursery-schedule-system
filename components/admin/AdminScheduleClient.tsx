"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminChildManagement } from "@/components/admin/AdminChildManagement";
import { AdminMonthlyHeadcount } from "@/components/admin/AdminMonthlyHeadcount";
import { AdminStaffManagement } from "@/components/admin/AdminStaffManagement";
import { AdminNavigation, type AdminPrimaryArea } from "@/components/admin/AdminNavigation";
import { AdminIcon } from "@/components/ui/AdminIcon";
import { ApiError, api } from "@/lib/client/api";

type VersionDay = {
  date: string;
  usageStatus: "using" | "off" | "closed" | "not_enrolled";
  arrivalTime: string | null;
  departureTime: string | null;
};

type VersionChild = {
  childId: string;
  childCode: string;
  name: string;
  className: string;
  days: VersionDay[];
};

type SubmissionVersion = {
  id: string;
  sequenceNumber: number;
  submittedAt: string;
  sourceVersionId: string | null;
  changeSummary: { kind?: string } | null;
  children: VersionChild[];
};

type Period = {
  id: string;
  targetMonth: string;
  deadlineAt: string;
  status: "draft" | "open" | "closed";
  isParentTarget: boolean;
};

type Family = {
  id: string;
  familyCode: string;
  displayName: string;
  status: string;
  stopDate: string | null;
  submissionState: "unsubmitted" | "submitted" | "confirmed" | "school_revised";
  submittedAt: string | null;
  lastUpdatedAt: string | null;
  latestSubmittedVersionId: string | null;
  latestConfirmedVersionId: string | null;
  latestEffectiveVersionId: string | null;
  resubmissionAllowed: boolean;
};

type AdminDashboard = {
  actor: { id: string; displayName: string; role: string };
  periods: Period[];
  selectedPeriod: Period | null;
  selectedTargetMonth: string | null;
  families: Family[];
  monthlyUsageSummaries: Array<{
    childId: string;
    familyId: string | null;
    name: string;
    submissionStatus: "submitted" | "unsubmitted";
    usageDays: number;
    totalMinutes: number;
  }>;
  closures: Array<{
    date: string;
    name: string;
    type: "closed" | "family_cooperation";
    parentInputAllowed: boolean;
  }>;
  selectedFamily: Family | null;
  latestSubmittedVersion: SubmissionVersion | null;
  latestEffectiveVersion: SubmissionVersion | null;
};

type RevisionChange = {
  childId: string;
  child: { id: string; name: string };
  date: string;
  before: VersionDay;
  after: VersionDay;
};

type RevisionPreview = {
  sourceVersionId: string;
  reason: string;
  changedDateCount: number;
  changes: RevisionChange[];
};

type HistoryEntry = {
  id: string;
  familyName: string;
  targetMonth: string;
  sequenceNumber: number;
  administratorName: string;
  reason: string;
  changedDateCount: number;
  changes: RevisionChange[];
  occurredAt: string;
};

type DayEdit = {
  childId: string;
  date: string;
  usageStatus: "using" | "off";
  arrivalTime: string | null;
  departureTime: string | null;
};

type AdminArea = "overview" | Exclude<AdminPrimaryArea, "accounts">;

const stateLabels = {
  unsubmitted: "未提出",
  submitted: "提出済み",
  confirmed: "確認済み",
  school_revised: "園修正済み",
};

function formatMonth(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function fiscalYearForMonth(targetMonth: string) {
  const [year, month] = targetMonth.split("-").map(Number);
  return month >= 4 ? year : year - 1;
}

function monthsForFiscalYear(fiscalYear: number) {
  return Array.from({ length: 12 }, (_, index) => {
    const monthOffset = index + 3;
    const year = fiscalYear + Math.floor(monthOffset / 12);
    const month = monthOffset % 12 + 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

function currentFiscalYear() {
  const now = new Date();
  return fiscalYearForMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
}

function formatDate(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatUsageDuration(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}時間${String(minutes).padStart(2, "0")}分`;
}

function monthCalendar(targetMonth: string) {
  const [year, month] = targetMonth.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => `${targetMonth}-${String(index + 1).padStart(2, "0")}`),
  ];
}

const calendarWeekdays = ["日", "月", "火", "水", "木", "金", "土"];

const timeOptions = Array.from({ length: ((20 - 7) * 60) / 5 + 1 }, (_, index) => {
  const minutes = 7 * 60 + index * 5;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

function dayLabel(day: VersionDay) {
  if (day.usageStatus === "using") return `${day.arrivalTime ?? "--:--"} - ${day.departureTime ?? "--:--"}`;
  if (day.usageStatus === "closed") return "休園日";
  if (day.usageStatus === "not_enrolled") return "在籍期間外";
  return "休み";
}

export function AdminScheduleClient() {
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selectedScheduleChildId, setSelectedScheduleChildId] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [edits, setEdits] = useState<Record<string, DayEdit>>({});
  const [preview, setPreview] = useState<RevisionPreview | null>(null);
  const [historyChildId, setHistoryChildId] = useState("");
  const [activeArea, setActiveArea] = useState<AdminArea>("overview");
  const [resubmissionConfirmationOpen, setResubmissionConfirmationOpen] = useState(false);
  const [closureMode, setClosureMode] = useState<"closed" | "family_cooperation">("closed");

  const load = useCallback(async (submissionPeriodId = "", familyId = "", targetMonth = "") => {
    const query = new URLSearchParams();
    if (submissionPeriodId) query.set("submissionPeriodId", submissionPeriodId);
    else if (targetMonth) query.set("targetMonth", targetMonth);
    if (familyId) query.set("familyId", familyId);
    const result = await api<{ dashboard: AdminDashboard }>(`/api/admin/schedules?${query}`);
    setDashboard(result.dashboard);
    setEdits({});
    setPreview(null);
    setRevisionReason("");
    setResubmissionConfirmationOpen(false);
    return result.dashboard;
  }, []);

  const loadHistory = useCallback(async (data: AdminDashboard, childId = "") => {
    const query = new URLSearchParams();
    if (data.selectedPeriod) query.set("submissionPeriodId", data.selectedPeriod.id);
    if (data.selectedFamily) query.set("familyId", data.selectedFamily.id);
    if (childId) query.set("childId", childId);
    const result = await api<{ history: HistoryEntry[] }>(`/api/admin/schedules/history?${query}`);
    setHistory(result.history);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().then((data) => loadHistory(data)).catch((caught) => setError(caught instanceof Error ? caught.message : "読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadHistory]);

  useEffect(() => {
    const area = new URLSearchParams(window.location.search).get("area");
    if (area !== "children" && area !== "schedules" && area !== "staff" && area !== "reports") return;
    const timer = window.setTimeout(() => setActiveArea(area), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function reload(
    submissionPeriodId = dashboard?.selectedPeriod?.id ?? "",
    familyId = dashboard?.selectedFamily?.id ?? "",
    targetMonth = dashboard?.selectedTargetMonth ?? "",
  ) {
    const data = await load(submissionPeriodId, familyId, targetMonth);
    setHistoryChildId("");
    await loadHistory(data);
  }

  async function run(operation: string, task: () => Promise<void>) {
    setBusy(operation);
    setMessage("");
    setError("");
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "処理できませんでした。");
    } finally {
      setBusy("");
    }
  }

  async function downloadExcel(period: Period) {
    await run("excel", async () => {
      const query = new URLSearchParams({ submissionPeriodId: period.id });
      const response = await fetch(`/api/admin/schedules/export?${query}`, {
        method: "GET",
        headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { code?: string; message?: string } | null;
        throw new ApiError(
          result?.code ?? "EXCEL_EXPORT_FAILED",
          result?.message ?? "Excelファイルを作成できませんでした。時間をおいて再度お試しください。",
          response.status,
        );
      }
      const blob = await response.blob();
      const fallback = `nursery-schedule-${period.targetMonth}.xlsx`;
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? fallback;
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      setMessage(`${formatMonth(period.targetMonth)}のExcelをダウンロードしました。`);
    });
  }

  function updateEdit(childId: string, day: VersionDay, patch: Partial<DayEdit>) {
    if (day.usageStatus === "closed" || day.usageStatus === "not_enrolled") return;
    const key = `${childId}:${day.date}`;
    const base = edits[key] ?? {
      childId,
      date: day.date,
      usageStatus: day.usageStatus === "using" ? "using" : "off",
      arrivalTime: day.arrivalTime,
      departureTime: day.departureTime,
    };
    const usageStatus = patch.usageStatus ?? base.usageStatus;
    const next = {
      ...base,
      ...patch,
      usageStatus,
      arrivalTime: usageStatus === "using" ? patch.arrivalTime ?? base.arrivalTime ?? "08:30" : null,
      departureTime: usageStatus === "using" ? patch.departureTime ?? base.departureTime ?? "17:30" : null,
    };
    setEdits((current) => ({ ...current, [key]: next }));
    setPreview(null);
  }

  const changes = useMemo(() => Object.values(edits), [edits]);
  const effectiveChildren = dashboard?.latestEffectiveVersion?.children ?? [];

  if (!dashboard) return <p className={`auth-message ${error ? "error" : "info"}`}>{error || "利用予定を確認中..."}</p>;

  const selectedPeriod = dashboard.selectedPeriod;
  const selectedTargetMonth = dashboard.selectedTargetMonth ?? selectedPeriod?.targetMonth ?? dashboard.periods[0]?.targetMonth ?? "";
  const selectedFiscalYear = selectedTargetMonth ? fiscalYearForMonth(selectedTargetMonth) : currentFiscalYear();
  const fiscalYears = [...new Set([
    currentFiscalYear() - 1,
    currentFiscalYear(),
    currentFiscalYear() + 1,
    selectedFiscalYear,
    ...dashboard.periods.map((period) => fiscalYearForMonth(period.targetMonth)),
  ])].sort((left, right) => left - right);
  const fiscalMonths = monthsForFiscalYear(selectedFiscalYear);
  const selectedFamily = dashboard.selectedFamily;
  const selectedScheduleChild = dashboard.monthlyUsageSummaries.find((child) => child.childId === selectedScheduleChildId) ?? null;
  const selectedEffectiveChildren = selectedScheduleChild
    ? effectiveChildren.filter((child) => child.childId === selectedScheduleChild.childId)
    : [];
  const confirmationBlocked = !dashboard.latestSubmittedVersion
    || selectedFamily?.submissionState === "confirmed"
    || selectedFamily?.submissionState === "school_revised";

  function selectArea(area: Exclude<AdminPrimaryArea, "accounts">) {
    setActiveArea(area);
    window.history.replaceState(null, "", `/admin/schedules?area=${area}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="auth-stack admin-schedule-view">
      {message ? <p className="auth-message info" role="status">{message}</p> : null}
      {error ? <p className="auth-message error" role="alert">{error}</p> : null}

      <AdminNavigation activeArea={activeArea === "overview" ? null : activeArea} onSelect={selectArea} />

      {activeArea === "overview" ? <section className="auth-section admin-area-overview">
        <div className="auth-section-heading"><div><span>目的から選択</span><h2>管理メニュー</h2></div></div>
        <div className="admin-purpose-grid">
          <button type="button" onClick={() => selectArea("children")}><AdminIcon name="child" size={28} /><span><strong>園児</strong><small>園児情報・保護者アカウントとの登録・基本利用時間</small></span></button>
          <button type="button" onClick={() => selectArea("schedules")}><AdminIcon name="calendar" size={28} /><span><strong>利用予定</strong><small>対象月・提出状況・休園日・園での修正</small></span></button>
          <button type="button" onClick={() => selectArea("staff")}><AdminIcon name="staff" size={28} /><span><strong>職員</strong><small>職員情報・担当区分・曜日別勤務可能時間</small></span></button>
          <div className="admin-purpose-future" aria-label="シフトは次段階で実装予定"><AdminIcon name="clock" size={28} /><span><strong>シフト</strong><small>希望休・希望勤務時間・シフト作成は次段階で実装します</small></span></div>
          <button type="button" onClick={() => selectArea("reports")}><AdminIcon name="report" size={28} /><span><strong>集計・Excel</strong><small>月間人数・人数変化時刻・Excel出力</small></span></button>
          <a href="/admin/accounts"><AdminIcon name="account" size={28} /><span><strong>アカウント</strong><small>保護者・家庭と管理者のアカウント管理</small></span></a>
        </div>
      </section> : null}

      <div hidden={activeArea !== "staff"}><AdminStaffManagement /></div>

      <div hidden={activeArea !== "children"}><AdminChildManagement /></div>

      <div hidden={activeArea !== "schedules"} className="admin-area-content">

      <section className="auth-section">
        <div className="auth-section-heading"><div><span>年度を選び、4月から翌年3月まで確認</span><h2>対象年度・対象月</h2></div></div>
        <div className="admin-fiscal-selector">
          <label><span>対象年度</span><select value={selectedFiscalYear} onChange={(event) => {
            const targetMonth = `${event.currentTarget.value}-04`;
            const period = dashboard.periods.find((entry) => entry.targetMonth === targetMonth);
            setSelectedScheduleChildId("");
            void run("period", async () => reload(period?.id ?? "", "", targetMonth));
          }}>{fiscalYears.map((year) => <option key={year} value={year}>{year}年度</option>)}</select></label>
          <div className="admin-fiscal-months" role="group" aria-label={`${selectedFiscalYear}年度の対象月`}>
            {fiscalMonths.map((targetMonth) => {
              const period = dashboard.periods.find((entry) => entry.targetMonth === targetMonth);
              return <button key={targetMonth} type="button" className={targetMonth === selectedTargetMonth ? "active" : ""} disabled={busy !== ""} onClick={() => {
                setSelectedScheduleChildId("");
                void run("period", async () => reload(period?.id ?? "", "", targetMonth));
              }}>{Number(targetMonth.slice(-2))}月</button>;
            })}
          </div>
        </div>
        {!selectedPeriod && selectedTargetMonth ? <p className="auth-message info">{formatMonth(selectedTargetMonth)}の提出対象はまだ登録されていません。休園日・家庭保育協力日は設定できます。園児の利用予定は対象期間の登録後に確認できます。</p> : null}
        {selectedTargetMonth ? <div className="admin-closure-settings">
          <div className="auth-section-heading">
            <div><span>{formatMonth(selectedTargetMonth)}</span><h3>休園日・家庭保育協力日</h3></div>
          </div>
          <p className="admin-schedule-note">設定する区分を選んで日付を押してください。日曜日は常に休園日です。家庭保育協力日は利用予定を入力でき、人数集計にも含まれます。</p>
          <div className="admin-closure-mode" role="group" aria-label="設定する日付区分">
            <button type="button" className={closureMode === "closed" ? "active" : ""} onClick={() => setClosureMode("closed")}>休園日</button>
            <button type="button" className={closureMode === "family_cooperation" ? "active" : ""} onClick={() => setClosureMode("family_cooperation")}>家庭保育協力日</button>
          </div>
          <div className="admin-closure-calendar" aria-label={`${formatMonth(selectedTargetMonth)}の休園日設定`}>
            {calendarWeekdays.map((weekday, index) => <span key={weekday} className={index === 0 ? "sunday" : index === 6 ? "saturday" : ""}>{weekday}</span>)}
            {monthCalendar(selectedTargetMonth).map((date, index) => {
              if (!date) return <span key={`blank-${index}`} aria-hidden="true" />;
              const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
              const isSunday = weekday === 0;
              const closure = dashboard.closures.find((entry) => entry.date === date);
              const isClosure = closure?.type === "closed";
              const isCooperationDay = closure?.type === "family_cooperation" || closure?.parentInputAllowed;
              return <button
                key={date}
                type="button"
                className={`${isSunday ? "sunday" : weekday === 6 ? "saturday" : ""} ${isClosure ? "closure" : ""} ${isCooperationDay ? "cooperation" : ""}`.trim()}
                aria-pressed={isSunday || Boolean(closure)}
                aria-label={`${formatDate(date)} ${isSunday ? "日曜日（休園）" : closure ? `${closure.name}。押すと設定変更または解除` : `${closureMode === "closed" ? "休園日" : "家庭保育協力日"}に設定`}`}
                disabled={busy !== "" || isSunday}
                onClick={() => {
                  const sameType = closure?.type === closureMode;
                  const label = closureMode === "closed" ? "休園日" : "家庭保育協力日";
                  const action = sameType ? `${label}設定を解除` : `${label}に設定`;
                  if (!window.confirm(`${date.replaceAll("-", "/")}を${action}しますか？`)) return;
                  void run("closure", async () => {
                    await api("/api/admin/schedules/closure-day", { method: sameType ? "DELETE" : "POST", body: { targetMonth: selectedTargetMonth, date, dayType: closureMode } });
                    await reload(selectedPeriod?.id ?? "", selectedFamily?.id ?? "", selectedTargetMonth);
                    setMessage(sameType ? `${label}設定を解除しました。` : `${label}を保存しました。`);
                  });
                }}
              ><strong>{Number(date.slice(-2))}</strong><small>{isSunday ? "休園" : closure?.name ?? ""}</small></button>;
            })}
          </div>
        </div> : null}
      </section>

      <section className="auth-section">
        <div className="auth-section-heading"><div><span>{selectedPeriod ? `${formatMonth(selectedPeriod.targetMonth)} / ${dashboard.monthlyUsageSummaries.length}名` : "対象月未選択"}</span><h2>園児の利用予定</h2></div></div>
        <p className="admin-schedule-note">園児を選ぶと、保護者が提出し、現在採用されている予定を確認できます。</p>
        <div className="auth-table-wrap"><table className="auth-table admin-child-schedule-table"><thead><tr><th>園児</th><th>提出状況</th><th>利用予定日数</th><th>月間利用予定時間</th></tr></thead><tbody>{dashboard.monthlyUsageSummaries.map((child) => <tr key={child.childId} className={child.childId === selectedScheduleChildId ? "selected" : ""}><th><button type="button" className="admin-child-schedule-select" onClick={() => {
          setSelectedScheduleChildId(child.childId);
          if (!child.familyId) {
            setError("この園児には対象月の保護者ログインアカウントが登録されていません。");
            return;
          }
          void run("child-schedule", async () => reload(selectedPeriod?.id ?? "", child.familyId ?? ""));
        }}>{child.name}<span>予定を確認</span></button></th><td><span className={`admin-state ${child.submissionStatus}`}>{child.submissionStatus === "submitted" ? "提出済み" : "未提出"}</span></td><td>{child.submissionStatus === "submitted" ? `${child.usageDays}日` : "-"}</td><td>{child.submissionStatus === "submitted" ? formatUsageDuration(child.totalMinutes) : "-"}</td></tr>)}</tbody></table></div>
      </section>

      {selectedPeriod && selectedFamily && selectedScheduleChild && selectedScheduleChild.familyId === selectedFamily.id ? <>
        <section className="auth-section admin-schedule-context" aria-label="選択中の利用予定">
          <div><span>対象月</span><strong>{formatMonth(selectedPeriod.targetMonth)}</strong></div>
          <div><span>確認中の園児</span><strong>{selectedScheduleChild.name}</strong></div>
          <div><span>提出状況</span><strong>{stateLabels[selectedFamily.submissionState]}</strong></div>
        </section>
        <section className="auth-section">
          <div className="auth-section-heading"><div><span>{selectedScheduleChild.name} / {stateLabels[selectedFamily.submissionState]}</span><h2>最新提出内容の確認</h2></div><div className="admin-heading-actions"><button type="button" disabled={busy !== "" || confirmationBlocked} onClick={() => {
            if (!window.confirm("最新の保護者提出内容を管理者確認済みにしますか？")) return;
            void run("confirm", async () => {
              await api("/api/admin/schedules/confirm", { method: "POST", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id } });
              await reload();
              setMessage("最新の提出内容を確認済みにしました。");
            });
          }}>{confirmationBlocked && dashboard.latestSubmittedVersion ? "確認済み" : "提出内容を確認する"}</button><button type="button" disabled={busy !== "" || !dashboard.latestSubmittedVersion || selectedPeriod.status === "draft" || selectedFamily.resubmissionAllowed} onClick={() => setResubmissionConfirmationOpen(true)}>{selectedFamily.resubmissionAllowed ? "この家庭は再提出可能" : "この家庭の再提出を許可"}</button></div></div>
          {dashboard.latestSubmittedVersion ? <div className="admin-version-summary"><strong>提出済み</strong><span>{formatDateTime(dashboard.latestSubmittedVersion.submittedAt)}</span><span>{dashboard.latestSubmittedVersion.children.length}名</span></div> : <p className="admin-schedule-note">この家庭からの提出はまだありません。</p>}
          {selectedFamily.resubmissionAllowed ? <p className="auth-message info">保護者がこの対象月を修正し、再提出できる状態です。再提出後は自動的に編集できなくなります。</p> : null}
        </section>

        <section className="auth-section">
          <div className="auth-section-heading"><div><span>園児・日付ごとに確認</span><h2>現在の利用予定・園での修正</h2></div></div>
          {dashboard.latestEffectiveVersion ? <>
            <div className="admin-version-summary"><strong>現在の利用予定</strong><span>{formatDateTime(dashboard.latestEffectiveVersion.submittedAt)}</span><span>{dashboard.latestEffectiveVersion.children.length}名</span></div>
            <div className="admin-schedule-form-row"><label className="admin-schedule-grow"><span>修正理由（必須）</span><input value={revisionReason} onChange={(event) => { setRevisionReason(event.currentTarget.value); setPreview(null); }} placeholder="保護者から変更連絡を受けたため" /></label><button type="button" disabled={busy !== "" || !revisionReason.trim() || changes.length === 0} onClick={() => void run("preview", async () => {
              const result = await api<{ result: RevisionPreview }>("/api/admin/schedules/revision/preview", { method: "POST", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id, reason: revisionReason, changes } });
              setPreview(result.result);
              setMessage(`${result.result.changedDateCount}件の変更内容を確認してください。`);
            })}>変更内容を確認</button></div>
            <div className="admin-revision-children">{selectedEffectiveChildren.map((child) => <details key={child.childId} open><summary>{child.name}</summary><div className="auth-table-wrap"><table className="auth-table admin-day-table"><thead><tr><th>日付</th><th>利用</th><th>登園</th><th>降園</th></tr></thead><tbody>{child.days.map((day) => {
              const edit = edits[`${child.childId}:${day.date}`];
              const current = edit ?? day;
              const locked = day.usageStatus === "closed" || day.usageStatus === "not_enrolled";
              return <tr key={day.date}><th>{formatDate(day.date)}<span>{locked ? dayLabel(day) : ""}</span></th><td><select disabled={locked} value={current.usageStatus === "using" ? "using" : "off"} onChange={(event) => updateEdit(child.childId, day, { usageStatus: event.currentTarget.value as "using" | "off" })}><option value="using">利用</option><option value="off">休み</option></select></td><td><select disabled={locked || current.usageStatus !== "using"} value={current.arrivalTime ?? "08:30"} onChange={(event) => updateEdit(child.childId, day, { arrivalTime: event.currentTarget.value })}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></td><td><select disabled={locked || current.usageStatus !== "using"} value={current.departureTime ?? "17:30"} onChange={(event) => updateEdit(child.childId, day, { departureTime: event.currentTarget.value })}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></td></tr>;
            })}</tbody></table></div></details>)}</div>
            {preview ? <div className="admin-preview"><h3>保存前の確認: {preview.changedDateCount}件</h3>{preview.changes.map((change) => <div key={`${change.childId}:${change.date}`}><strong>{change.child.name} {formatDate(change.date)}</strong><span>{dayLabel(change.before)} → {dayLabel(change.after)}</span></div>)}<button className="primary" type="button" disabled={busy !== "" || preview.changedDateCount === 0} onClick={() => void run("revision", async () => {
              try {
                await api("/api/admin/schedules/revision", { method: "POST", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id, sourceVersionId: preview.sourceVersionId, reason: revisionReason, changes } });
              } catch (caught) {
                if (caught instanceof ApiError && caught.code === "EFFECTIVE_VERSION_CHANGED") throw new Error("最新状態が更新されました。再読み込みして、変更内容をもう一度確認してください。");
                if (caught instanceof ApiError && caught.code === "NO_CHANGES") throw new Error("保存する変更がありません。");
                throw caught;
              }
              await reload();
              setMessage("園での予定修正を保存しました。");
            })}>この内容で保存</button></div> : null}
          </> : <p className="admin-schedule-note">この園児の提出済み利用予定はありません。</p>}
        </section>

        <section className="auth-section">
          <div className="auth-section-heading"><div><span>園で実際に変更した履歴</span><h2>変更履歴</h2></div><label><span>園児で絞り込み</span><select value={historyChildId} onChange={(event) => { const childId = event.currentTarget.value; setHistoryChildId(childId); void run("history", async () => loadHistory(dashboard, childId)); }}><option value="">全園児</option>{effectiveChildren.map((child) => <option key={child.childId} value={child.childId}>{child.name}</option>)}</select></label></div>
          {history.length ? <div className="admin-history-list">{history.map((entry) => <details key={entry.id}><summary><strong>{entry.familyName} / {formatMonth(entry.targetMonth)}</strong><span>{entry.changedDateCount}件 / {formatDateTime(entry.occurredAt)}</span></summary><p>{entry.administratorName} / {entry.reason}</p>{entry.changes.map((change) => <div key={`${entry.id}:${change.childId}:${change.date}`}><strong>{change.child.name} {formatDate(change.date)}</strong><span>{dayLabel(change.before)} → {dayLabel(change.after)}</span></div>)}</details>)}</div> : <p className="admin-schedule-note">該当する園での修正履歴はありません。</p>}
        </section>
      </> : <section className="auth-section"><p className="admin-schedule-note">園児を選択すると、提出された利用予定と家庭単位の操作を確認できます。</p></section>}
      </div>

      <div hidden={activeArea !== "reports"} className="admin-area-content">
        <section className="auth-section">
          <div className="auth-section-heading"><div><span>月間の利用予定</span><h2><AdminIcon name="download" />集計・Excel</h2></div></div>
          <div className="admin-schedule-form-row">
            <label><span>確認・出力する月</span><select value={selectedPeriod?.id ?? ""} onChange={(event) => void run("period", async () => reload(event.currentTarget.value, ""))}>{dashboard.periods.map((period) => <option key={period.id} value={period.id}>{formatMonth(period.targetMonth)}</option>)}</select></label>
            <button type="button" className="primary" disabled={busy !== "" || !selectedPeriod} onClick={() => {
              if (selectedPeriod) void downloadExcel(selectedPeriod);
            }}><AdminIcon name="download" />{busy === "excel" ? "Excelを作成中..." : selectedPeriod ? `${formatMonth(selectedPeriod.targetMonth)}のExcelを出力` : "Excelを出力"}</button>
          </div>
        </section>
        {selectedPeriod ? <AdminMonthlyHeadcount submissionPeriodId={selectedPeriod.id} /> : <p className="admin-schedule-note">確認する対象月を選択してください。</p>}
      </div>

      {resubmissionConfirmationOpen && selectedFamily && selectedPeriod ? <div className="parent-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && busy === "") setResubmissionConfirmationOpen(false); }}><section className="parent-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-resubmission-title"><div><span className="parent-eyebrow">内容をご確認ください</span><h2 id="admin-resubmission-title">この家庭の再提出を許可しますか？</h2></div><div className="parent-dialog-description"><p>保護者が対象月の予定を再び編集・提出できるようになります。</p><p>現在採用中の予定をもとに再入力を開始し、再提出後は自動的にロックされます。</p></div><div className="parent-dialog-actions"><button type="button" disabled={busy !== ""} onClick={() => setResubmissionConfirmationOpen(false)}>キャンセル</button><button type="button" className="primary" disabled={busy !== ""} onClick={() => void run("allow-resubmission", async () => { await api("/api/admin/schedules/allow-resubmission", { method: "POST", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id } }); setResubmissionConfirmationOpen(false); await reload(); setMessage("この家庭の再提出を許可しました。"); })}>{busy === "allow-resubmission" ? "処理しています..." : "再提出を許可する"}</button></div></section></div> : null}
    </div>
  );
}
