"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LogoutButton } from "@/components/auth/AuthClient";
import { AdminChildManagement } from "@/components/admin/AdminChildManagement";
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
  status: string;
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
  extension: {
    extendedDeadlineAt: string;
    reason: string;
  } | null;
};

type AdminDashboard = {
  actor: { id: string; displayName: string; role: string };
  periods: Period[];
  selectedPeriod: Period | null;
  families: Family[];
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

function toTokyoLocalInput(value: string | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function tokyoLocalToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("延長期限を入力してください。");
  const parsed = new Date(`${value}:00+09:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("延長期限を確認してください。");
  return parsed.toISOString();
}

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
  const [targetPeriodId, setTargetPeriodId] = useState("");
  const [extensionDeadline, setExtensionDeadline] = useState("");
  const [extensionReason, setExtensionReason] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [edits, setEdits] = useState<Record<string, DayEdit>>({});
  const [preview, setPreview] = useState<RevisionPreview | null>(null);
  const [historyChildId, setHistoryChildId] = useState("");

  const load = useCallback(async (submissionPeriodId = "", familyId = "") => {
    const query = new URLSearchParams();
    if (submissionPeriodId) query.set("submissionPeriodId", submissionPeriodId);
    if (familyId) query.set("familyId", familyId);
    const result = await api<{ dashboard: AdminDashboard }>(`/api/admin/schedules?${query}`);
    setDashboard(result.dashboard);
    setTargetPeriodId(result.dashboard.periods.find((period) => period.isParentTarget)?.id ?? "");
    setExtensionDeadline(toTokyoLocalInput(result.dashboard.selectedFamily?.extension?.extendedDeadlineAt ?? null));
    setExtensionReason(result.dashboard.selectedFamily?.extension?.reason ?? "");
    setEdits({});
    setPreview(null);
    setRevisionReason("");
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

  async function reload(submissionPeriodId = dashboard?.selectedPeriod?.id ?? "", familyId = dashboard?.selectedFamily?.id ?? "") {
    const data = await load(submissionPeriodId, familyId);
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
  const selectedFamily = dashboard.selectedFamily;
  const confirmationBlocked = !dashboard.latestSubmittedVersion
    || selectedFamily?.submissionState === "confirmed"
    || selectedFamily?.submissionState === "school_revised";

  return (
    <div className="auth-stack admin-schedule-view">
      <section className="auth-section auth-toolbar">
        <div><span>ログイン中</span><strong>{dashboard.actor.displayName}</strong></div>
        <div className="admin-schedule-nav"><a href="/admin/accounts">アカウント管理</a><LogoutButton /></div>
      </section>
      {message ? <p className="auth-message info" role="status">{message}</p> : null}
      {error ? <p className="auth-message error" role="alert">{error}</p> : null}

      <AdminChildManagement />

      <section className="auth-section">
        <div className="auth-section-heading"><div><span>保護者画面に表示する月</span><h2>対象月</h2></div></div>
        <div className="admin-schedule-form-row">
          <label><span>確認する期間</span><select value={selectedPeriod?.id ?? ""} onChange={(event) => void run("period", async () => reload(event.currentTarget.value, ""))}>{dashboard.periods.map((period) => <option key={period.id} value={period.id}>{formatMonth(period.targetMonth)} / {period.status}{period.isParentTarget ? " / 現在の対象月" : ""}</option>)}</select></label>
          <label><span>新しい保護者向け対象月</span><select value={targetPeriodId} onChange={(event) => setTargetPeriodId(event.currentTarget.value)}>{dashboard.periods.map((period) => <option key={period.id} value={period.id}>{formatMonth(period.targetMonth)} / {period.status}</option>)}</select></label>
          <button type="button" disabled={busy !== "" || !selectedPeriod} onClick={() => {
            if (selectedPeriod) void downloadExcel(selectedPeriod);
          }}>{selectedPeriod ? `${formatMonth(selectedPeriod.targetMonth)}のExcelを出力` : "Excelを出力"}</button>
          <button type="button" disabled={busy !== "" || !targetPeriodId} onClick={() => {
            const target = dashboard.periods.find((period) => period.id === targetPeriodId);
            if (!target || !window.confirm(`保護者向け対象月を${formatMonth(target.targetMonth)}へ切り替えますか？`)) return;
            void run("target", async () => {
              await api("/api/admin/schedules/parent-target", { method: "POST", body: { submissionPeriodId: target.id } });
              await reload(target.id, selectedFamily?.id ?? "");
              setMessage("保護者向け対象月を切り替えました。");
            });
          }}>対象月を切り替える</button>
        </div>
      </section>

      <section className="auth-section">
        <div className="auth-section-heading"><div><span>{dashboard.families.length}家庭</span><h2>提出状況</h2></div></div>
        <div className="admin-schedule-family-layout">
          <div className="auth-table-wrap"><table className="auth-table"><thead><tr><th>家庭</th><th>状態</th><th>最終提出</th></tr></thead><tbody>{dashboard.families.map((family) => <tr key={family.id} className={family.id === selectedFamily?.id ? "selected" : ""} onClick={() => void run("family", async () => reload(selectedPeriod?.id ?? "", family.id))}><th><button type="button" className="admin-family-select">{family.displayName}</button><span>{family.familyCode}</span></th><td><span className={`admin-state ${family.submissionState}`}>{stateLabels[family.submissionState]}</span></td><td>{formatDateTime(family.submittedAt)}</td></tr>)}</tbody></table></div>
        </div>
      </section>

      {selectedPeriod && selectedFamily ? <>
        <section className="auth-section">
          <div className="auth-section-heading"><div><span>{selectedFamily.displayName}</span><h2>家庭別期限延長</h2></div></div>
          <p className="admin-schedule-note">全体期限: {formatDateTime(selectedPeriod.deadlineAt)}（日本時間）</p>
          <div className="admin-schedule-form-row">
            <label><span>延長後期限（日本時間）</span><input type="datetime-local" value={extensionDeadline} onChange={(event) => setExtensionDeadline(event.currentTarget.value)} /></label>
            <label className="admin-schedule-grow"><span>延長理由</span><input value={extensionReason} onChange={(event) => setExtensionReason(event.currentTarget.value)} placeholder="保護者からの連絡など" /></label>
            <button type="button" disabled={busy !== "" || !extensionDeadline || !extensionReason.trim()} onClick={() => {
              if (!window.confirm(`${selectedFamily.displayName}の期限を${extensionDeadline.replace("T", " ")}まで延長しますか？`)) return;
              void run("extension", async () => {
                await api("/api/admin/schedules/deadline-extension", { method: "PUT", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id, extendedDeadlineAt: tokyoLocalToIso(extensionDeadline), reason: extensionReason } });
                await reload();
                setMessage("家庭別の提出期限を保存しました。");
              });
            }}>延長期限を保存</button>
          </div>
        </section>

        <section className="auth-section">
          <div className="auth-section-heading"><div><span>{stateLabels[selectedFamily.submissionState]}</span><h2>最新提出内容の確認</h2></div><button type="button" disabled={busy !== "" || confirmationBlocked} onClick={() => {
            if (!window.confirm("最新の保護者提出内容を管理者確認済みにしますか？")) return;
            void run("confirm", async () => {
              await api("/api/admin/schedules/confirm", { method: "POST", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id } });
              await reload();
              setMessage("最新の提出内容を確認済みにしました。");
            });
          }}>{confirmationBlocked && dashboard.latestSubmittedVersion ? "確認済み" : "提出内容を確認する"}</button></div>
          {dashboard.latestSubmittedVersion ? <div className="admin-version-summary"><strong>提出版 第{dashboard.latestSubmittedVersion.sequenceNumber}版</strong><span>{formatDateTime(dashboard.latestSubmittedVersion.submittedAt)}</span><span>{dashboard.latestSubmittedVersion.children.length}名</span></div> : <p className="admin-schedule-note">この家庭からの提出はまだありません。</p>}
        </section>

        <section className="auth-section">
          <div className="auth-section-heading"><div><span>現在採用中の版を修正</span><h2>園での予定修正</h2></div></div>
          {dashboard.latestEffectiveVersion ? <>
            <div className="admin-schedule-form-row"><label className="admin-schedule-grow"><span>修正理由（必須）</span><input value={revisionReason} onChange={(event) => { setRevisionReason(event.currentTarget.value); setPreview(null); }} placeholder="保護者から変更連絡を受けたため" /></label><button type="button" disabled={busy !== "" || !revisionReason.trim() || changes.length === 0} onClick={() => void run("preview", async () => {
              const result = await api<{ result: RevisionPreview }>("/api/admin/schedules/revision/preview", { method: "POST", body: { familyId: selectedFamily.id, submissionPeriodId: selectedPeriod.id, reason: revisionReason, changes } });
              setPreview(result.result);
              setMessage(`${result.result.changedDateCount}件の変更内容を確認してください。`);
            })}>変更内容を確認</button></div>
            <div className="admin-revision-children">{effectiveChildren.map((child) => <details key={child.childId}><summary>{child.name} <span>{child.className}</span></summary><div className="auth-table-wrap"><table className="auth-table admin-day-table"><thead><tr><th>日付</th><th>利用</th><th>登園</th><th>降園</th></tr></thead><tbody>{child.days.map((day) => {
              const edit = edits[`${child.childId}:${day.date}`];
              const current = edit ?? day;
              const locked = day.usageStatus === "closed" || day.usageStatus === "not_enrolled";
              return <tr key={day.date}><th>{formatDate(day.date)}<span>{locked ? dayLabel(day) : ""}</span></th><td><select disabled={locked} value={current.usageStatus === "using" ? "using" : "off"} onChange={(event) => updateEdit(child.childId, day, { usageStatus: event.currentTarget.value as "using" | "off" })}><option value="using">利用</option><option value="off">休み</option></select></td><td><input type="time" step={300} disabled={locked || current.usageStatus !== "using"} value={current.arrivalTime ?? "08:30"} onChange={(event) => updateEdit(child.childId, day, { arrivalTime: event.currentTarget.value })} /></td><td><input type="time" step={300} disabled={locked || current.usageStatus !== "using"} value={current.departureTime ?? "17:30"} onChange={(event) => updateEdit(child.childId, day, { departureTime: event.currentTarget.value })} /></td></tr>;
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
          </> : <p className="admin-schedule-note">修正できる提出内容がありません。</p>}
        </section>

        <section className="auth-section">
          <div className="auth-section-heading"><div><span>園で実際に変更した履歴</span><h2>変更履歴</h2></div><label><span>園児で絞り込み</span><select value={historyChildId} onChange={(event) => { const childId = event.currentTarget.value; setHistoryChildId(childId); void run("history", async () => loadHistory(dashboard, childId)); }}><option value="">全園児</option>{effectiveChildren.map((child) => <option key={child.childId} value={child.childId}>{child.name}</option>)}</select></label></div>
          {history.length ? <div className="admin-history-list">{history.map((entry) => <details key={entry.id}><summary><strong>{entry.familyName} / {formatMonth(entry.targetMonth)}</strong><span>{entry.changedDateCount}件 / {formatDateTime(entry.occurredAt)}</span></summary><p>{entry.administratorName} / {entry.reason}</p>{entry.changes.map((change) => <div key={`${entry.id}:${change.childId}:${change.date}`}><strong>{change.child.name} {formatDate(change.date)}</strong><span>{dayLabel(change.before)} → {dayLabel(change.after)}</span></div>)}</details>)}</div> : <p className="admin-schedule-note">該当する園での修正履歴はありません。</p>}
        </section>
      </> : <section className="auth-section"><p className="admin-schedule-note">対象期間または家庭が登録されていません。</p></section>}
    </div>
  );
}
