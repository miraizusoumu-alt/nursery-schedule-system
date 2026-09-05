"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/client/api";

type PreferenceType = "none" | "day_off" | "work_time";
type Preference = { date: string; preferenceType: PreferenceType; startTime: string | null; endTime: string | null };
type Period = { id: string; targetMonth: string; deadlineAt: string; status: "draft" | "open" | "closed"; writable: boolean };
type Dashboard = {
  actor: { staffId: string; displayName: string };
  periods: Period[];
  period: Period | null;
  submission: {
    id: string | null;
    status: "unentered" | "draft" | "submitted";
    revision: number;
    submittedAt: string | null;
    basePreferencesHash: string;
    hasConflict: boolean;
  } | null;
  preferences: Preference[];
  officialPreferencesHash: string | null;
  dayCount?: number;
};

const timeOptions = Array.from({ length: ((20 * 60 + 30) - (6 * 60 + 30)) / 15 + 1 }, (_, index) => {
  const minutes = 6 * 60 + 30 + index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

function formatMonth(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function formatDeadline(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function dayLabel(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][parsed.getUTCDay()];
  return `${Number(date.slice(8))}日（${weekday}）`;
}

function preferenceMap(dashboard: Dashboard) {
  return Object.fromEntries(dashboard.preferences.map((preference) => [preference.date, preference]));
}

export function StaffPreferenceClient() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [entries, setEntries] = useState<Record<string, Preference>>({});
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const accept = useCallback((next: Dashboard) => {
    setDashboard(next);
    setEntries(preferenceMap(next));
    setDirty(false);
    setConfirming(false);
  }, []);

  const load = useCallback(async (targetMonth = "") => {
    const query = targetMonth ? `?targetMonth=${encodeURIComponent(targetMonth)}` : "";
    const result = await api<{ dashboard: Dashboard }>(`/api/staff/preferences${query}`);
    accept(result.dashboard);
  }, [accept]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((caught) => setError(caught instanceof Error ? caught.message : "希望提出画面を読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dates = useMemo(() => {
    if (!dashboard?.period) return [];
    const count = dashboard.dayCount ?? new Date(Number(dashboard.period.targetMonth.slice(0, 4)), Number(dashboard.period.targetMonth.slice(5, 7)), 0).getDate();
    return Array.from({ length: count }, (_, index) => `${dashboard.period?.targetMonth}-${String(index + 1).padStart(2, "0")}`);
  }, [dashboard]);
  const chosen = useMemo(() => Object.values(entries).filter((entry) => entry.preferenceType !== "none").sort((left, right) => left.date.localeCompare(right.date)), [entries]);
  const locked = dashboard?.submission?.status === "submitted";
  const hasConflict = dashboard?.submission?.hasConflict === true;
  const editable = dashboard?.period?.writable === true && !locked && !hasConflict;

  function update(date: string, patch: Partial<Preference>) {
    setEntries((current) => {
      const previous = current[date] ?? { date, preferenceType: "none" as const, startTime: null, endTime: null };
      const next = { ...previous, ...patch };
      if (next.preferenceType === "none" || next.preferenceType === "day_off") {
        next.startTime = null;
        next.endTime = null;
      } else {
        next.startTime ??= "09:00";
        next.endTime ??= "17:00";
      }
      return { ...current, [date]: next };
    });
    setDirty(true);
    setMessage("");
  }

  async function run(operation: string, task: () => Promise<void>) {
    setBusy(operation);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError(`${caught.message} 画面を再読み込みしてください。`);
      } else {
        setError(caught instanceof Error ? caught.message : "処理を完了できませんでした。");
      }
    } finally {
      setBusy("");
    }
  }

  if (!dashboard) return <p className={`auth-message ${error ? "error" : "info"}`}>{error || "希望提出画面を確認中..."}</p>;

  return (
    <div className="staff-preference-page">
      <section className="auth-section staff-preference-toolbar">
        <div className="auth-section-heading">
          <div><span>{dashboard.actor.displayName}</span><h2>職員希望提出</h2></div>
          <button type="button" onClick={() => void run("logout", async () => {
            await api("/api/auth/logout", { method: "POST", body: {} });
            window.location.assign("/auth/staff");
          })}>ログアウト</button>
        </div>
        {dashboard.periods.length ? <label><span>対象月</span><select value={dashboard.period?.targetMonth ?? ""} disabled={busy !== "" || dirty} onChange={(event) => {
          void run("load", async () => load(event.currentTarget.value));
        }}>{dashboard.periods.map((period) => <option key={period.id} value={period.targetMonth}>{formatMonth(period.targetMonth)}</option>)}</select></label> : null}
      </section>

      {error ? <p className="auth-message error" role="alert">{error}</p> : null}
      {message ? <p className="auth-message info" role="status">{message}</p> : null}
      {!dashboard.period ? <p className="auth-message info">現在、職員希望を提出できる月はありません。</p> : <>
        <section className="staff-preference-status" aria-label="提出状況">
          <div><strong>{formatMonth(dashboard.period.targetMonth)} 希望提出</strong><span>提出期限 {formatDeadline(dashboard.period.deadlineAt)}</span></div>
          <span className={`admin-state ${locked ? "confirmed" : dashboard.submission?.status === "draft" ? "warning" : "draft"}`}>
            {locked ? "提出済み" : dashboard.submission?.status === "draft" ? "入力途中" : "未提出"}
          </span>
        </section>

        {locked ? <p className="auth-message info">提出済みです。変更が必要な場合は管理者へご連絡ください。</p> : !dashboard.period.writable ? <p className="auth-message warning">この月の提出期間は終了しています。</p> : null}

        {hasConflict ? <section className="auth-section staff-preference-conflict" role="alert">
          <div><h2>管理者による希望内容の変更がありました</h2><p>現在の下書きはそのまま保存・提出できません。最新の内容を読み込み直してください。</p></div>
          <button type="button" className="primary" disabled={busy !== "" || !dashboard.period.writable} onClick={() => {
            if (!window.confirm("入力途中の希望は破棄されます。最新の管理者設定を読み込み直しますか？")) return;
            void run("reset", async () => {
              const result = await api<{ dashboard: Dashboard }>("/api/staff/preferences/reset", { method: "POST", body: {
                targetMonth: dashboard.period?.targetMonth,
                revision: dashboard.submission?.revision ?? 0,
                expectedOfficialPreferencesHash: dashboard.officialPreferencesHash,
              } });
              accept(result.dashboard);
              setMessage("最新の管理者設定を読み込みました。希望を改めて入力してください。");
            });
          }}>{busy === "reset" ? "読み込み中..." : "最新内容を読み込み直す"}</button>
        </section> : null}

        {confirming ? <section className="auth-section staff-preference-confirmation">
          <div className="auth-section-heading"><div><span>最終確認</span><h2>提出内容</h2></div><button type="button" onClick={() => setConfirming(false)}>入力へ戻る</button></div>
          <div className="staff-preference-confirm-groups">
            <div><h3>希望休日</h3>{chosen.some((entry) => entry.preferenceType === "day_off") ? <ul>{chosen.filter((entry) => entry.preferenceType === "day_off").map((entry) => <li key={entry.date}>{dayLabel(entry.date)}</li>)}</ul> : <p>設定なし</p>}</div>
            <div><h3>希望勤務時間</h3>{chosen.some((entry) => entry.preferenceType === "work_time") ? <ul>{chosen.filter((entry) => entry.preferenceType === "work_time").map((entry) => <li key={entry.date}>{dayLabel(entry.date)} {entry.startTime}～{entry.endTime}</li>)}</ul> : <p>設定なし</p>}</div>
          </div>
          <button type="button" className="primary" disabled={busy !== ""} onClick={() => {
            if (!window.confirm("この内容で提出しますか？提出後は職員画面から変更できません。")) return;
            void run("submit", async () => {
              const result = await api<{ dashboard: Dashboard }>("/api/staff/preferences/submit", { method: "POST", body: {
                targetMonth: dashboard.period?.targetMonth,
                revision: dashboard.submission?.revision ?? 0,
                expectedOfficialPreferencesHash: dashboard.officialPreferencesHash,
              } });
              accept(result.dashboard);
              setMessage("希望を提出しました。");
            });
          }}>{busy === "submit" ? "提出中..." : "提出する"}</button>
        </section> : <section className="staff-preference-days" aria-label="日別希望">
          {dates.map((date) => {
            const entry = entries[date] ?? { date, preferenceType: "none" as const, startTime: null, endTime: null };
            return <article key={date}>
              <h3>{dayLabel(date)}</h3>
              <div className="staff-preference-choice" role="radiogroup" aria-label={`${dayLabel(date)}の希望`}>
                {(["none", "day_off", "work_time"] as PreferenceType[]).map((type) => <label key={type}><input type="radio" name={`preference-${date}`} value={type} checked={entry.preferenceType === type} disabled={!editable || busy !== ""} onChange={() => update(date, { preferenceType: type })} /><span>{type === "none" ? "希望なし" : type === "day_off" ? "希望休" : "希望勤務時間"}</span></label>)}
              </div>
              {entry.preferenceType === "work_time" ? <div className="staff-preference-day-times">
                <label><span>開始</span><select value={entry.startTime ?? "09:00"} disabled={!editable || busy !== ""} onChange={(event) => update(date, { startTime: event.currentTarget.value })}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                <span aria-hidden="true">～</span>
                <label><span>終了</span><select value={entry.endTime ?? "17:00"} disabled={!editable || busy !== ""} onChange={(event) => update(date, { endTime: event.currentTarget.value })}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
              </div> : null}
            </article>;
          })}
        </section>}

        {!locked && !confirming ? <section className="staff-preference-actions">
          <p className={dirty ? "unsaved" : "saved"}>{dirty ? "入力内容は未保存です。" : dashboard.submission?.status === "draft" ? "下書きは保存済みです。" : "希望を入力してください。"}</p>
          <div>
            <button type="button" disabled={!editable || busy !== "" || !dirty} onClick={() => void run("save", async () => {
              const result = await api<{ dashboard: Dashboard }>("/api/staff/preferences/draft", { method: "PUT", body: {
                targetMonth: dashboard.period?.targetMonth,
                revision: dashboard.submission?.revision ?? 0,
                expectedOfficialPreferencesHash: dashboard.officialPreferencesHash,
                preferences: chosen,
              } });
              accept(result.dashboard);
              setMessage("下書きを保存しました。");
            })}>{busy === "save" ? "保存中..." : "下書きを保存"}</button>
            <button type="button" className="primary" disabled={!editable || busy !== "" || dirty || dashboard.submission?.status !== "draft"} onClick={() => setConfirming(true)}>内容を確認</button>
          </div>
        </section> : null}
      </>}
    </div>
  );
}
