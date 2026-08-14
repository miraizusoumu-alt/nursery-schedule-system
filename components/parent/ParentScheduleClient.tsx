"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { LogoutButton } from "@/components/auth/AuthClient";

type UsageStatus = "using" | "off" | "closed" | "not_enrolled";
type SaveState = "idle" | "saving" | "saved" | "failed";

type ScheduleDay = {
  id: string;
  date: string;
  weekday: number;
  usageStatus: UsageStatus;
  arrivalTime: string | null;
  departureTime: string | null;
  source: string;
  changed: boolean;
  locked: boolean;
  closureName: string | null;
  updatedAt: string;
};

type ScheduleChild = {
  id: string;
  childCode: string;
  name: string;
  kana: string;
  className: string;
  schedule: {
    id: string;
    status: string;
    updatedAt: string;
    days: ScheduleDay[];
  };
};

type HistoryEntry = {
  id: string;
  childName: string | null;
  targetDate: string | null;
  fieldName: string | null;
  reason: string;
  changedAt: string;
  after: unknown;
};

type AvailableDashboard = {
  available: true;
  family: { id: string; displayName: string };
  period: {
    id: string;
    targetMonth: string;
    deadlineAt: string;
    globalDeadlineAt: string | null;
    effectiveDeadlineAt: string | null;
    deadlineSource: "submission_period" | "family_extension";
    extensionActive: boolean;
    status: "open" | "closed";
    editable: boolean;
    lockMessage: string | null;
  };
  submission: {
    id: string;
    status: "draft" | "submitted" | "overdue";
    displayStatus: string;
    submittedAt: string | null;
    lastUpdatedAt: string;
    revisionRequired: boolean;
    schoolModified: boolean;
    schoolModifiedAt: string | null;
  };
  children: ScheduleChild[];
  history: HistoryEntry[];
};

type UnavailableDashboard = {
  available: false;
  message: string;
  periodCount: number;
  periods: Array<{ targetMonth: string; status: string }>;
};

type Dashboard = AvailableDashboard | UnavailableDashboard;

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
const bulkWeekdays = [
  { value: 1, label: "月曜日" },
  { value: 2, label: "火曜日" },
  { value: 3, label: "水曜日" },
  { value: 4, label: "木曜日" },
  { value: 5, label: "金曜日" },
  { value: 6, label: "土曜日" },
];

function makeTimeOptions() {
  const values: string[] = [];
  for (let minutes = 7 * 60; minutes <= 20 * 60; minutes += 5) {
    values.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return values;
}

const timeOptions = makeTimeOptions();

function isAvailableDashboard(value: Dashboard | null): value is AvailableDashboard {
  return value?.available === true;
}

function timeToMinutes(value: string | null) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes % 5 !== 0) return null;
  return hours * 60 + minutes;
}

function validateDay(day: ScheduleDay) {
  if (day.usageStatus !== "using") return "";
  const arrival = timeToMinutes(day.arrivalTime);
  const departure = timeToMinutes(day.departureTime);
  if (arrival === null || departure === null) return "利用日は登園・降園時刻をHH:mm形式の5分単位で入力してください。";
  if (arrival >= departure) return "登園時刻は降園時刻より前にしてください。";
  return "";
}

function validateDays(days: ScheduleDay[]) {
  return days.map(validateDay).find(Boolean) ?? "";
}

function formatMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return `${year}年${month}月`;
}

function formatDate(value: string) {
  const [, month, day] = value.split("-");
  const weekday = weekdayLabels[new Date(`${value}T00:00:00+09:00`).getDay()];
  return `${Number(month)}/${Number(day)}（${weekday}）`;
}

function formatDateTime(value: string | null) {
  if (!value) return "未記録";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未記録";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function usageLabel(day: ScheduleDay) {
  if (day.usageStatus === "closed") return day.closureName ?? "休園日";
  if (day.usageStatus === "not_enrolled") return "在園期間外";
  return day.usageStatus === "using" ? "利用" : "休み";
}

function dayTimeLabel(day: ScheduleDay) {
  return day.usageStatus === "using" ? `${day.arrivalTime ?? "--:--"} - ${day.departureTime ?? "--:--"}` : "-";
}

function childStats(child: ScheduleChild) {
  const editableDays = child.schedule.days.filter((day) => !day.locked);
  const useDays = editableDays.filter((day) => day.usageStatus === "using");
  const changedDays = editableDays.filter((day) => day.changed);
  const invalidDays = editableDays.filter((day) => validateDay(day));
  return {
    useDays: useDays.length,
    changedDays: changedDays.length,
    invalidDays: invalidDays.length,
  };
}

function dashboardWithRevision(current: AvailableDashboard): AvailableDashboard {
  if (current.submission.status !== "submitted") return current;
  return {
    ...current,
    submission: {
      ...current.submission,
      status: "draft",
      displayStatus: "修正中・再提出が必要",
      revisionRequired: true,
      lastUpdatedAt: new Date().toISOString(),
    },
  };
}

function payloadDay(day: ScheduleDay) {
  return {
    date: day.date,
    usageStatus: day.usageStatus,
    arrivalTime: day.usageStatus === "using" ? day.arrivalTime : null,
    departureTime: day.usageStatus === "using" ? day.departureTime : null,
  };
}

export function ParentScheduleClient() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [selectedChildId, setSelectedChildId] = useState("");
  const [message, setMessage] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [bulkWeekday, setBulkWeekday] = useState(1);
  const [bulkEnabled, setBulkEnabled] = useState(true);
  const [bulkArrival, setBulkArrival] = useState("08:30");
  const [bulkDeparture, setBulkDeparture] = useState("17:30");
  const [submitting, setSubmitting] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);
  const pendingSaveRef = useRef<{ childId: string; days: ScheduleDay[]; version: number } | null>(null);

  useEffect(() => {
    let active = true;
    api<{ dashboard: Dashboard }>("/api/family/schedule")
      .then((result) => {
        if (active) setData(result.dashboard);
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : "予定を読み込めませんでした。");
      });
    return () => {
      active = false;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const currentChild = useMemo(() => {
    if (!isAvailableDashboard(data)) return null;
    return data.children.find((child) => child.id === selectedChildId) ?? data.children[0] ?? null;
  }, [data, selectedChildId]);

  const currentStats = currentChild ? childStats(currentChild) : null;
  const allStats = useMemo(() => {
    if (!isAvailableDashboard(data)) return [];
    return data.children.map((child) => ({ child, stats: childStats(child) }));
  }, [data]);

  async function performSave(payload: { childId: string; days: ScheduleDay[]; version: number }) {
    const validation = validateDays(payload.days);
    if (validation) {
      setSaveState("failed");
      setMessage(validation);
      return false;
    }
    setSaveState("saving");
    try {
      const result = await api<{ dashboard: Dashboard }>(`/api/family/schedule/children/${encodeURIComponent(payload.childId)}`, {
        method: "PUT",
        body: { days: payload.days.map(payloadDay) },
      });
      if (payload.version === saveVersionRef.current) {
        pendingSaveRef.current = null;
        setData(result.dashboard);
        setSaveState("saved");
        setMessage("保存しました。提出済みの内容を修正した場合は再提出してください。");
      }
      return true;
    } catch (error) {
      if (payload.version === saveVersionRef.current) {
        setSaveState("failed");
        setMessage(error instanceof Error ? error.message : "保存できませんでした。入力内容は画面に残しています。");
      }
      return false;
    }
  }

  function queueAutosave(childId: string, days: ScheduleDay[]) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const payload = { childId, days, version: saveVersionRef.current + 1 };
    saveVersionRef.current = payload.version;
    pendingSaveRef.current = payload;
    setSaveState("saving");
    saveTimerRef.current = setTimeout(() => {
      void performSave(payload);
    }, 600);
  }

  async function flushAutosave() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (!pending) return true;
    return performSave(pending);
  }

  function prepareEdit() {
    if (!isAvailableDashboard(data) || !data.period.editable) return false;
    if (data.submission.status === "submitted") {
      const ok = window.confirm("提出済み内容を修正します。修正後は再提出が必要です。よろしいですか？");
      if (!ok) return false;
    }
    return true;
  }

  function replaceCurrentChildDays(nextDays: ScheduleDay[], nextMessage: string) {
    if (!isAvailableDashboard(data) || !currentChild) return;
    const validation = validateDays(nextDays);
    const nextData = dashboardWithRevision({
      ...data,
      children: data.children.map((child) => (
        child.id === currentChild.id
          ? { ...child, schedule: { ...child.schedule, days: nextDays, updatedAt: new Date().toISOString() } }
          : child
      )),
    });
    setData(nextData);
    setMessage(validation || nextMessage);
    if (validation) {
      setSaveState("failed");
      return;
    }
    queueAutosave(currentChild.id, nextDays);
  }

  function updateDay(date: string, patch: Partial<ScheduleDay>) {
    if (!currentChild || !prepareEdit()) return;
    const nextDays = currentChild.schedule.days.map((day) => {
      if (day.date !== date || day.locked) return day;
      const nextStatus = patch.usageStatus ?? day.usageStatus;
      const next: ScheduleDay = {
        ...day,
        ...patch,
        usageStatus: nextStatus,
        arrivalTime: nextStatus === "using" ? (patch.arrivalTime ?? day.arrivalTime ?? "08:30") : null,
        departureTime: nextStatus === "using" ? (patch.departureTime ?? day.departureTime ?? "17:30") : null,
        changed: true,
        source: "parent",
      };
      return next;
    });
    replaceCurrentChildDays(nextDays, `${formatDate(date)}の予定を自動保存しています。`);
  }

  function applyWeekdayBulk() {
    if (!currentChild || !prepareEdit()) return;
    if (bulkEnabled) {
      const arrival = timeToMinutes(bulkArrival);
      const departure = timeToMinutes(bulkDeparture);
      if (arrival === null || departure === null || arrival >= departure) {
        setSaveState("failed");
        setMessage("曜日一括変更の時刻を確認してください。");
        return;
      }
    }
    const nextDays = currentChild.schedule.days.map((day) => {
      if (day.weekday !== bulkWeekday || day.locked) return day;
      return {
        ...day,
        usageStatus: bulkEnabled ? "using" as const : "off" as const,
        arrivalTime: bulkEnabled ? bulkArrival : null,
        departureTime: bulkEnabled ? bulkDeparture : null,
        changed: true,
        source: "parent",
      };
    });
    replaceCurrentChildDays(nextDays, `${bulkWeekdays.find((item) => item.value === bulkWeekday)?.label ?? "曜日"}の予定を自動保存しています。`);
  }

  async function applyBasicPattern() {
    if (!isAvailableDashboard(data) || !currentChild || !prepareEdit()) return;
    const ok = window.confirm("園に登録されている基本予定を反映します。現在の入力内容は上書きされます。よろしいですか？");
    if (!ok) return;
    const saved = await flushAutosave();
    if (!saved) return;
    setSaveState("saving");
    try {
      const result = await api<{ dashboard: Dashboard }>("/api/family/schedule/apply-basic-pattern", {
        method: "POST",
        body: { childId: currentChild.id },
      });
      setData(result.dashboard);
      setSaveState("saved");
      setMessage("基本予定を反映しました。休園日と在籍期間外の日付は変更していません。");
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "基本予定を反映できませんでした。");
    }
  }

  async function copyToSiblings() {
    if (!isAvailableDashboard(data) || !currentChild || !prepareEdit()) return;
    const ok = window.confirm("この子の予定を兄弟姉妹にも反映します。兄弟姉妹の既存入力は上書きされます。よろしいですか？");
    if (!ok) return;
    const saved = await flushAutosave();
    if (!saved) return;
    setSaveState("saving");
    try {
      const result = await api<{ dashboard: Dashboard }>("/api/family/schedule/copy-to-siblings", {
        method: "POST",
        body: { sourceChildId: currentChild.id },
      });
      setData(result.dashboard);
      setSaveState("saved");
      setMessage("兄弟姉妹へ反映しました。必要に応じて園児ごとに個別修正できます。");
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "兄弟姉妹へ反映できませんでした。");
    }
  }

  async function submitFamily() {
    if (!isAvailableDashboard(data)) return;
    const validation = data.children.map((child) => validateDays(child.schedule.days)).find(Boolean);
    if (validation) {
      setSaveState("failed");
      setMessage(validation);
      return;
    }
    const saved = await flushAutosave();
    if (!saved) return;
    const ok = window.confirm(data.submission.submittedAt ? "家庭内の全園児分を再提出します。提出日時が更新されます。" : "家庭内の全園児分をまとめて提出します。");
    if (!ok) return;
    setSubmitting(true);
    try {
      const result = await api<{ dashboard: Dashboard }>("/api/family/schedule/submit", { method: "POST", body: {} });
      setData(result.dashboard);
      setSaveState("saved");
      setMessage(data.submission.submittedAt ? "再提出しました。" : "提出しました。");
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "提出できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  if (message && !data) return <p className="auth-message error">{message}</p>;
  if (!data) return <p className="auth-message info">予定を確認中...</p>;

  if (!isAvailableDashboard(data)) {
    return (
      <div className="parent-schedule">
        <section className="parent-schedule-panel important">
          <span className="parent-eyebrow">提出対象月を確認できません</span>
          <h2>園の設定確認が必要です</h2>
          <p>{data.message}</p>
          {data.periods.length ? (
            <ul className="parent-mini-list">
              {data.periods.map((period) => <li key={period.targetMonth}>{formatMonth(period.targetMonth)} / {period.status}</li>)}
            </ul>
          ) : null}
        </section>
      </div>
    );
  }

  const readonly = !data.period.editable;
  const saveLabel = saveState === "saving" ? "保存中" : saveState === "saved" ? "保存済み" : saveState === "failed" ? "保存失敗" : "待機中";

  return (
    <div className="parent-schedule">
      <section className="parent-schedule-hero">
        <div>
          <span className="parent-eyebrow">{data.family.displayName}</span>
          <h2>{formatMonth(data.period.targetMonth)}の利用予定</h2>
        </div>
        <LogoutButton />
      </section>

      <section className="parent-status-grid" aria-label="提出状態">
        <div>
          <span>提出状態</span>
          <strong className={`parent-status ${readonly ? "locked" : data.submission.revisionRequired ? "editing" : data.submission.status}`}>{data.submission.displayStatus}</strong>
        </div>
        <div>
          <span>提出日時</span>
          <strong>{formatDateTime(data.submission.submittedAt)}</strong>
        </div>
        <div>
          <span>最終更新日時</span>
          <strong>{formatDateTime(data.submission.lastUpdatedAt)}</strong>
        </div>
        <div>
          <span>自動保存</span>
          <strong className={`parent-save-state ${saveState}`}>{saveLabel}</strong>
        </div>
        <div>
          <span>{data.period.deadlineSource === "family_extension" ? "延長後の提出期限" : "提出期限"}</span>
          <strong>{formatDateTime(data.period.effectiveDeadlineAt ?? data.period.deadlineAt)}</strong>
        </div>
      </section>

      {readonly ? <p className="auth-message info">{data.period.lockMessage}</p> : null}
      {data.period.extensionActive ? <p className="auth-message info">園から提出期限が延長されています。延長後の期限まで編集・再提出できます。</p> : null}
      {data.submission.schoolModified ? <p className="auth-message info">提出後、園で予定を変更しています。詳しくは園へお問い合わせください。</p> : null}
      {message ? <p className={`auth-message ${saveState === "failed" ? "error" : "info"}`} role={saveState === "failed" ? "alert" : "status"}>{message}</p> : null}

      <nav className="child-switcher" aria-label="園児切替">
        {data.children.map((child) => {
          const stats = childStats(child);
          return (
            <button key={child.id} type="button" className={child.id === currentChild?.id ? "active" : ""} onClick={() => setSelectedChildId(child.id)}>
              <strong>{child.name}</strong>
              <span>{stats.useDays}日利用 / 変更{stats.changedDays}日</span>
            </button>
          );
        })}
      </nav>

      {currentChild ? (
        <>
          <section className="parent-schedule-panel current-child">
            <span className="parent-eyebrow">現在編集中</span>
            <h2>{currentChild.name}</h2>
            <div className="child-meta-row">
              <span>{currentChild.className || currentChild.childCode}</span>
              <span>{currentStats?.useDays ?? 0}日利用</span>
              <span>{currentStats?.changedDays ?? 0}日変更</span>
            </div>
          </section>

          <section className="parent-schedule-panel">
            <div className="parent-section-title">
              <div>
                <span className="parent-eyebrow">対象月だけに反映</span>
                <h2>曜日ごとの一括変更</h2>
              </div>
              <div className="parent-section-actions">
                <button type="button" disabled={readonly || saveState === "saving"} onClick={() => void applyBasicPattern()}>基本予定を反映</button>
                <button type="button" disabled={readonly} onClick={applyWeekdayBulk}>曜日設定を反映</button>
              </div>
            </div>
            <div className="weekday-bulk-form">
              <label>
                <span>曜日</span>
                <select value={bulkWeekday} disabled={readonly} onChange={(event) => setBulkWeekday(Number(event.currentTarget.value))}>
                  {bulkWeekdays.map((weekday) => <option key={weekday.value} value={weekday.value}>{weekday.label}</option>)}
                </select>
              </label>
              <label className="parent-check-row">
                <input type="checkbox" checked={bulkEnabled} disabled={readonly} onChange={(event) => setBulkEnabled(event.currentTarget.checked)} />
                <span>この曜日は利用する</span>
              </label>
              <label>
                <span>登園時刻</span>
                <select value={bulkArrival} disabled={readonly || !bulkEnabled} onChange={(event) => setBulkArrival(event.currentTarget.value)}>
                  {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <label>
                <span>降園時刻</span>
                <select value={bulkDeparture} disabled={readonly || !bulkEnabled} onChange={(event) => setBulkDeparture(event.currentTarget.value)}>
                  {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="parent-schedule-panel">
            <div className="parent-section-title">
              <div>
                <span className="parent-eyebrow">日ごとの休み・時刻変更</span>
                <h2>{currentChild.name}の月間予定</h2>
              </div>
            </div>
            <div className="parent-day-list">
              {currentChild.schedule.days.map((day) => {
                const error = validateDay(day);
                return (
                  <article className={`parent-day-card ${day.locked ? "locked" : ""} ${day.changed ? "changed" : ""}`} key={day.date}>
                    <div className="parent-day-head">
                      <div>
                        <strong>{formatDate(day.date)}</strong>
                        <span>{day.locked ? usageLabel(day) : day.changed ? "変更あり" : "基本予定"}</span>
                      </div>
                      <span className={`parent-status ${day.usageStatus}`}>{usageLabel(day)}</span>
                    </div>
                    {day.locked ? (
                      <div className="parent-readonly-time">{day.closureName ?? usageLabel(day)}</div>
                    ) : (
                      <div className="parent-day-fields">
                        <label className="parent-check-row">
                          <input type="checkbox" checked={day.usageStatus === "using"} disabled={readonly} onChange={(event) => updateDay(day.date, { usageStatus: event.currentTarget.checked ? "using" : "off" })} />
                          <span>利用する</span>
                        </label>
                        <label>
                          <span>登園</span>
                          <select value={day.arrivalTime ?? "08:30"} disabled={readonly || day.usageStatus !== "using"} onChange={(event) => updateDay(day.date, { arrivalTime: event.currentTarget.value })}>
                            {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>降園</span>
                          <select value={day.departureTime ?? "17:30"} disabled={readonly || day.usageStatus !== "using"} onChange={(event) => updateDay(day.date, { departureTime: event.currentTarget.value })}>
                            {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
                          </select>
                        </label>
                        <div className="parent-day-time">{dayTimeLabel(day)}</div>
                      </div>
                    )}
                    {error ? <p className="parent-field-error">{error}</p> : null}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="parent-schedule-panel">
            <div className="parent-section-title">
              <div>
                <span className="parent-eyebrow">提出前の確認</span>
                <h2>家庭内の入力状況</h2>
              </div>
            </div>
            <div className="family-review-list">
              {allStats.map(({ child, stats }) => (
                <div key={child.id}>
                  <strong>{child.name}</strong>
                  <span>{stats.useDays}日利用 / 変更{stats.changedDays}日 / 入力エラー{stats.invalidDays}件</span>
                </div>
              ))}
            </div>
          </section>

          <section className="parent-schedule-panel">
            <div className="parent-section-title">
              <div>
                <span className="parent-eyebrow">履歴</span>
                <h2>提出・変更履歴</h2>
              </div>
            </div>
            {data.history.length ? (
              <ol className="parent-history-list">
                {data.history.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.reason}</strong>
                    <span>{entry.childName ? `${entry.childName} ` : ""}{entry.targetDate ? formatDate(entry.targetDate) : formatMonth(data.period.targetMonth)} / {formatDateTime(entry.changedAt)}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="parent-empty-text">まだ変更履歴はありません。</p>}
          </section>

          <div className="parent-fixed-actions">
            <button type="button" disabled={readonly || data.children.length < 2 || saveState === "saving"} onClick={() => void copyToSiblings()}>
              この子の予定を兄弟姉妹にも反映
            </button>
            <button type="button" className="primary" disabled={readonly || submitting || saveState === "saving"} onClick={() => void submitFamily()}>
              {data.submission.submittedAt ? "再提出" : "提出"}
            </button>
          </div>
        </>
      ) : (
        <section className="parent-schedule-panel">
          <h2>園児が登録されていません</h2>
          <p>この家庭に紐づく園児が見つかりません。園へご連絡ください。</p>
        </section>
      )}
    </div>
  );
}
