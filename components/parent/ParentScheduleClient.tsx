"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client/api";

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

type AvailableDashboard = {
  available: true;
  family: { id: string; displayName: string };
  period: {
    id: string;
    targetMonth: string;
    deadlineAt: string;
    globalDeadlineAt: string | null;
    effectiveDeadlineAt: string | null;
    deadlineSource: null;
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
    resubmissionAllowed: boolean;
    schoolModified: boolean;
    schoolModifiedAt: string | null;
  };
  children: ScheduleChild[];
  periods: Array<{ id: string; targetMonth: string; status: "open" | "closed"; selected: boolean }>;
  suggestedTargetMonth: string;
};

type UnavailableDashboard = {
  available: false;
  message: string;
  periodCount: number;
  periods: Array<{ id: string; targetMonth: string; status: string }>;
};

type Dashboard = AvailableDashboard | UnavailableDashboard;

type ConfirmationState = {
  title: string;
  description: string[];
  confirmLabel: string;
  cancelLabel?: string;
  action: () => void | Promise<void>;
};

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
  const total = hours * 60 + minutes;
  return total >= 7 * 60 && total <= 20 * 60 ? total : null;
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

function usageLabel(day: ScheduleDay) {
  if (day.usageStatus === "closed") return "休園日";
  if (day.usageStatus === "not_enrolled") return "在園期間外";
  return day.usageStatus === "using" ? "利用" : "休み";
}

function dashboardWithRevision(current: AvailableDashboard): AvailableDashboard {
  if (current.submission.status !== "submitted" || !current.submission.resubmissionAllowed) return current;
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

function ConfirmationDialog({
  confirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  confirmation: ConfirmationState;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="parent-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section
        className="parent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-confirm-title"
        aria-describedby="parent-confirm-description"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          if (event.shiftKey && document.activeElement === cancelButtonRef.current) {
            event.preventDefault();
            confirmButtonRef.current?.focus();
          } else if (!event.shiftKey && document.activeElement === confirmButtonRef.current) {
            event.preventDefault();
            cancelButtonRef.current?.focus();
          }
        }}
      >
        <div>
          <span className="parent-eyebrow">内容をご確認ください</span>
          <h2 id="parent-confirm-title">{confirmation.title}</h2>
        </div>
        <div id="parent-confirm-description" className="parent-dialog-description">
          {confirmation.description.map((line) => <p key={line}>{line}</p>)}
        </div>
        <div className="parent-dialog-actions">
          <button ref={cancelButtonRef} type="button" disabled={busy} onClick={onCancel}>{confirmation.cancelLabel ?? "キャンセル"}</button>
          <button ref={confirmButtonRef} type="button" className="primary" disabled={busy} onClick={onConfirm}>
            {busy ? "処理しています..." : confirmation.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
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
  const [weekdayBulkOpen, setWeekdayBulkOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [completionMessage, setCompletionMessage] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);
  const pendingSaveRef = useRef<{ childId: string; submissionPeriodId: string; days: ScheduleDay[]; version: number } | null>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);

  async function loadDashboard(submissionPeriodId = "") {
    const query = submissionPeriodId ? `?submissionPeriodId=${encodeURIComponent(submissionPeriodId)}` : "";
    const result = await api<{ dashboard: Dashboard }>(`/api/family/schedule${query}`);
    setData(result.dashboard);
    setSelectedChildId("");
    setSaveState("idle");
    setMessage("");
    setCompletionMessage("");
  }

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

  function openConfirmation(nextConfirmation: ConfirmationState) {
    confirmationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation(nextConfirmation);
  }

  function closeConfirmation() {
    setConfirmation(null);
    setConfirming(false);
    window.setTimeout(() => confirmationTriggerRef.current?.focus(), 0);
  }

  async function runConfirmedAction() {
    if (!confirmation || confirming) return;
    setConfirming(true);
    try {
      await confirmation.action();
    } finally {
      closeConfirmation();
    }
  }

  async function performSave(payload: { childId: string; submissionPeriodId: string; days: ScheduleDay[]; version: number }) {
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
        body: { submissionPeriodId: payload.submissionPeriodId, days: payload.days.map(payloadDay) },
      });
      if (payload.version === saveVersionRef.current) {
        pendingSaveRef.current = null;
        setData(result.dashboard);
        setSaveState("saved");
        setMessage(result.dashboard.available && result.dashboard.submission.resubmissionAllowed
          ? "入力内容を保存しました。園へ反映するには再提出してください。"
          : "入力内容を保存しました。");
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
    if (!isAvailableDashboard(data)) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const payload = { childId, submissionPeriodId: data.period.id, days, version: saveVersionRef.current + 1 };
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

  function requestEdit(action: () => void) {
    if (!isAvailableDashboard(data) || !data.period.editable) return false;
    action();
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
    if (!currentChild) return;
    requestEdit(() => {
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
    });
  }

  function applyWeekdayBulk() {
    if (!currentChild) return;
    if (bulkEnabled) {
      const arrival = timeToMinutes(bulkArrival);
      const departure = timeToMinutes(bulkDeparture);
      if (arrival === null || departure === null || arrival >= departure) {
        setSaveState("failed");
        setMessage("曜日一括変更の時刻を確認してください。");
        return;
      }
    }
    requestEdit(() => {
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
    });
  }

  async function copyToSiblings() {
    if (!isAvailableDashboard(data) || !currentChild || !data.period.editable) return;
    const saved = await flushAutosave();
    if (!saved) return;
    setSaveState("saving");
    try {
      const result = await api<{ dashboard: Dashboard }>("/api/family/schedule/copy-to-siblings", {
        method: "POST",
        body: { sourceChildId: currentChild.id, submissionPeriodId: data.period.id },
      });
      setData(result.dashboard);
      setSaveState("saved");
      setMessage("きょうだいへコピーしました。必要に応じてお子さまごとに個別修正できます。");
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "きょうだいへコピーできませんでした。");
    }
  }

  function requestSiblingCopy() {
    if (!isAvailableDashboard(data) || !currentChild || !data.period.editable || data.children.length < 2) return;
    const siblingNames = data.children.filter((child) => child.id !== currentChild.id).map((child) => child.name).join("、");
    openConfirmation({
      title: "この予定をきょうだいにもコピーしますか？",
      description: [
        `${currentChild.name}さんの予定を、${siblingNames}さんへコピーします。`,
        "コピー先で現在入力している内容は上書きされます。コピー後も、お子さまごとに修正できます。",
        ...(data.submission.resubmissionAllowed ? ["コピー後は、園へもう一度提出してください。"] : []),
      ],
      confirmLabel: "きょうだいにもコピーする",
      action: copyToSiblings,
    });
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
    setSubmitting(true);
    try {
      const result = await api<{ dashboard: Dashboard }>("/api/family/schedule/submit", { method: "POST", body: { submissionPeriodId: data.period.id } });
      setData(result.dashboard);
      setSaveState("saved");
      const wasResubmission = data.submission.resubmissionAllowed;
      setMessage("");
      setCompletionMessage(`✓ ${formatMonth(data.period.targetMonth)}の利用予定を${wasResubmission ? "再提出" : "提出"}しました`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "提出できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  function requestFamilySubmission() {
    if (!isAvailableDashboard(data) || !data.period.editable) return;
    openConfirmation({
      title: data.submission.resubmissionAllowed ? "修正した内容を園へ再提出しますか？" : "この内容で園へ提出しますか？",
      description: [
        "提出後は、ご自身で予定を変更できません。",
        "変更が必要な場合は、園へLINEまたは直接ご連絡ください。",
        "入力内容を確認してから提出してください。",
      ],
      confirmLabel: data.submission.resubmissionAllowed ? "この内容で園へ再提出する" : "この内容で園へ提出する",
      cancelLabel: "戻って確認する",
      action: submitFamily,
    });
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
      window.location.assign("/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログアウトできませんでした。");
      setSaveState("failed");
      setLoggingOut(false);
    }
  }

  if (message && !data) return <p className="auth-message error">{message}</p>;
  if (!data) return <p className="auth-message info">予定を確認中...</p>;

  if (!isAvailableDashboard(data)) {
    const hasSelectablePeriods = data.periods.length > 0;
    return (
      <div className="parent-schedule">
        <section className="parent-schedule-panel important">
          <span className="parent-eyebrow">利用予定</span>
          <h2>{hasSelectablePeriods ? "確認する月を選んでください" : "園の設定確認が必要です"}</h2>
          <p>{data.message}</p>
          {hasSelectablePeriods ? (
            <label className="parent-month-select">
              <span>確認する月</span>
              <select defaultValue="" onChange={(event) => {
                const periodId = event.currentTarget.value;
                if (periodId) void loadDashboard(periodId);
              }}>
                <option value="" disabled>月を選択</option>
                {data.periods.map((period) => <option key={period.id} value={period.id}>{formatMonth(period.targetMonth)}</option>)}
              </select>
            </label>
          ) : null}
        </section>
      </div>
    );
  }

  const readonly = !data.period.editable;
  const saveLabel = saveState === "saving" ? "保存しています" : saveState === "saved" ? "入力内容を保存しました" : saveState === "failed" ? "保存できませんでした" : "入力待ち";

  return (
    <div className="parent-schedule">
      <section className="parent-schedule-hero">
        <div>
          <span className="parent-eyebrow">利用予定</span>
          <h2>{formatMonth(data.period.targetMonth)}の利用予定</h2>
        </div>
        <label className="parent-month-select">
          <span>確認する月</span>
          <select value={data.period.id} disabled={saveState === "saving"} onChange={(event) => {
            const periodId = event.currentTarget.value;
            void flushAutosave().then((saved) => {
              if (saved) return loadDashboard(periodId);
            }).catch((error) => {
              setSaveState("failed");
              setMessage(error instanceof Error ? error.message : "対象月を切り替えられませんでした。");
            });
          }}>
            {data.periods.map((period) => <option key={period.id} value={period.id}>{formatMonth(period.targetMonth)}</option>)}
          </select>
        </label>
      </section>

      {completionMessage ? <section className="parent-submission-complete" role="status"><strong>{completionMessage}</strong><span>提出後の変更は、園へLINEまたは直接ご連絡ください。</span></section> : null}

      <section className="parent-status-summary" aria-label="提出状態">
        <div>
          <span>状態</span>
          <strong className={`parent-status ${readonly ? "locked" : data.submission.revisionRequired ? "editing" : data.submission.status}`}>{data.submission.displayStatus}</strong>
        </div>
      </section>

      {readonly ? <p className="auth-message info">{data.period.lockMessage}</p> : null}
      {data.submission.resubmissionAllowed ? <p className="auth-message info">園から再提出が許可されています。予定を修正し、もう一度提出してください。</p> : null}
      {data.submission.schoolModified ? <p className="auth-message info">提出後、園で予定を変更しています。詳しくは園へお問い合わせください。</p> : null}
      {message ? <p className={`auth-message ${saveState === "failed" ? "error" : "info"}`} role={saveState === "failed" ? "alert" : "status"}>{message}</p> : null}

      <section className="parent-schedule-panel parent-child-selector">
        <div className="parent-section-title">
          <div>
            <span className="parent-eyebrow">このご家庭のお子さま</span>
            <h2>入力するお子さま</h2>
          </div>
        </div>
        <p className="parent-section-description">ログイン中のご家庭に登録されているお子さまだけが表示されます。</p>
        {data.children.length > 1 ? (
          <nav className="child-switcher" aria-label="入力するお子さま">
            {data.children.map((child) => (
              <button key={child.id} type="button" className={child.id === currentChild?.id ? "active" : ""} aria-pressed={child.id === currentChild?.id} onClick={() => setSelectedChildId(child.id)}>
                <strong>{child.name}</strong>
              </button>
            ))}
          </nav>
        ) : currentChild ? (
          <div className="parent-single-child">
            <strong>{currentChild.name}</strong>
            <span>このお子さまの予定を入力します。</span>
          </div>
        ) : null}
      </section>

      {currentChild ? (
        <>
          {!readonly ? <section className="parent-autosave-note" aria-label="入力内容の保存について">
            <div>
              <strong>入力内容は自動で保存されます</strong>
              <span className={`parent-save-state ${saveState}`}>{saveLabel}</span>
            </div>
            <p>途中で画面を閉じても、入力した内容は残ります。園への提出は、入力後に「{data.submission.resubmissionAllowed ? "この内容で園へ再提出する" : "この内容で園へ提出する"}」を押してください。</p>
          </section> : null}

          <section className="parent-schedule-tools" aria-label="予定のまとめ入力">
            <div className="parent-quick-entry-list">
              <article>
                <div>
                  <strong>曜日ごとにまとめて入力</strong>
                  <p>「毎週月曜日は8:30～17:00」のように、同じ曜日の予定をまとめて設定できます。</p>
                </div>
                <button type="button" aria-expanded={weekdayBulkOpen} aria-controls="parent-weekday-settings" disabled={readonly} onClick={() => setWeekdayBulkOpen((open) => !open)}>
                  {weekdayBulkOpen ? "曜日設定を閉じる" : "曜日ごとに設定する"}
                </button>
              </article>
              {data.children.length > 1 ? (
                <article>
                  <div>
                    <strong>きょうだいへコピー</strong>
                    <p>入力した予定を、このご家庭のきょうだいの予定にもコピーできます。</p>
                  </div>
                  <button type="button" disabled={readonly || saveState === "saving"} onClick={requestSiblingCopy}>この予定をきょうだいにもコピー</button>
                </article>
              ) : null}
            </div>
            {weekdayBulkOpen ? (
              <div id="parent-weekday-settings" className="parent-weekday-settings">
                <div>
                  <strong>曜日ごとの予定を設定する</strong>
                  <p>休園日と在籍期間外の日付は変更されません。</p>
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
                <button type="button" className="parent-weekday-apply" disabled={readonly} onClick={applyWeekdayBulk}>選んだ曜日の予定をまとめて反映する</button>
              </div>
            ) : null}
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
                    {day.closureName === "家庭保育協力日" ? <p className="parent-cooperation-day">家庭保育協力日</p> : null}
                    {day.locked ? (
                      <div className="parent-readonly-time">{usageLabel(day)}</div>
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
                      </div>
                    )}
                    {error ? <p className="parent-field-error">{error}</p> : null}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="parent-schedule-panel parent-submit-panel">
            <div>
              <span className="parent-eyebrow">入力の最後に行います</span>
              <h2>{readonly ? "提出済みです" : "入力内容を確認して、園へ提出してください"}</h2>
              <p>{readonly ? "変更が必要な場合は、園へLINEまたは直接ご連絡ください。" : "家庭内のお子さま全員の入力状況を確認してから、まとめて園へ提出します。"}</p>
            </div>
            {!readonly ? <button type="button" className="primary" disabled={submitting || saveState === "saving"} onClick={requestFamilySubmission}>
              {data.submission.resubmissionAllowed ? "この内容で園へ再提出する" : "この内容で園へ提出する"}
            </button> : null}
          </section>
        </>
      ) : (
        <section className="parent-schedule-panel">
          <h2>園児が登録されていません</h2>
          <p>この家庭に紐づく園児が見つかりません。園へご連絡ください。</p>
        </section>
      )}
      <div className="parent-footer-actions">
        <button type="button" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? "ログアウト中..." : "ログアウト"}</button>
      </div>
      {confirmation ? (
        <ConfirmationDialog
          confirmation={confirmation}
          busy={confirming}
          onCancel={closeConfirmation}
          onConfirm={() => void runConfirmedAction()}
        />
      ) : null}
    </div>
  );
}
