"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";

type FamilyOption = {
  id: string;
  familyCode: string;
  displayName: string;
  status: string;
};

type Membership = {
  familyId: string;
  familyCode: string;
  familyName: string;
  activeFrom: string | null;
  activeTo: string | null;
};

type BasicPattern = {
  weekday: number;
  enabled: boolean;
  arrivalTime: string | null;
  departureTime: string | null;
};

type PatternHistory = {
  id: string;
  weekday: number;
  before: BasicPattern | null;
  after: BasicPattern;
  reason: string;
  administratorName: string;
  changedAt: string;
};

type ManagedChild = {
  id: string;
  childCode: string;
  name: string;
  kana: string;
  lastName: string | null;
  firstName: string | null;
  lastNameKana: string | null;
  firstNameKana: string | null;
  className: string;
  birthDate: string | null;
  enrollmentDate: string | null;
  withdrawalDate: string | null;
  status: "enrolled" | "withdrawn";
  memberships: Membership[];
  patterns: BasicPattern[];
  patternHistories: PatternHistory[];
};

type Management = {
  families: FamilyOption[];
  children: ManagedChild[];
};

type ChildForm = {
  originalFamilyId: string;
  familyId: string;
  lastName: string;
  firstName: string;
  lastNameKana: string;
  firstNameKana: string;
  className: string;
  birthDate: string;
  enrollmentDate: string;
  withdrawalDate: string;
  familyActiveFrom: string;
  familyActiveTo: string;
  status: "enrolled" | "withdrawn";
};

const weekdays = [
  { value: 1, label: "月曜日" },
  { value: 2, label: "火曜日" },
  { value: 3, label: "水曜日" },
  { value: 4, label: "木曜日" },
  { value: 5, label: "金曜日" },
  { value: 6, label: "土曜日" },
];

function emptyForm(familyId = ""): ChildForm {
  return {
    originalFamilyId: familyId,
    familyId,
    lastName: "",
    firstName: "",
    lastNameKana: "",
    firstNameKana: "",
    className: "",
    birthDate: "",
    enrollmentDate: "",
    withdrawalDate: "",
    familyActiveFrom: "",
    familyActiveTo: "",
    status: "enrolled",
  };
}

function patternsOrDefaults(patterns: BasicPattern[] = []) {
  return weekdays.map(({ value }) => {
    const pattern = patterns.find((entry) => entry.weekday === value);
    return pattern ?? { weekday: value, enabled: false, arrivalTime: null, departureTime: null };
  });
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function patternLabel(pattern: BasicPattern | null) {
  if (!pattern?.enabled) return "休み";
  return `${pattern.arrivalTime ?? "--:--"} - ${pattern.departureTime ?? "--:--"}`;
}

export function AdminChildManagement() {
  const [management, setManagement] = useState<Management | null>(null);
  const [selectedChildId, setSelectedChildId] = useState("");
  const [form, setForm] = useState<ChildForm>(emptyForm());
  const [isNew, setIsNew] = useState(false);
  const [patterns, setPatterns] = useState<BasicPattern[]>(patternsOrDefaults());
  const [patternReason, setPatternReason] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedChild = useMemo(
    () => management?.children.find((child) => child.id === selectedChildId) ?? null,
    [management, selectedChildId],
  );
  const selectedMembership = selectedChild?.memberships.find((membership) => membership.familyId === form.originalFamilyId) ?? null;
  const changedChildFields = useMemo(() => {
    if (isNew || !selectedChild) return ["新規登録"];
    const comparisons = [
      ["姓", selectedChild.lastName ?? "", form.lastName],
      ["名", selectedChild.firstName ?? "", form.firstName],
      ["姓かな", selectedChild.lastNameKana ?? "", form.lastNameKana],
      ["名かな", selectedChild.firstNameKana ?? "", form.firstNameKana],
      ["クラス", selectedChild.className, form.className],
      ["生年月日", selectedChild.birthDate ?? "", form.birthDate],
      ["入園日", selectedChild.enrollmentDate ?? "", form.enrollmentDate],
      ["退園日", selectedChild.withdrawalDate ?? "", form.withdrawalDate],
      ["在籍状態", selectedChild.status, form.status],
      ["所属家庭", selectedMembership?.familyId ?? "", form.familyId],
      ["家庭所属開始日", selectedMembership?.activeFrom ?? "", form.familyActiveFrom],
      ["家庭所属終了日", selectedMembership?.activeTo ?? "", form.familyActiveTo],
    ];
    return comparisons.filter(([, before, after]) => before !== after).map(([label]) => label);
  }, [form, isNew, selectedChild, selectedMembership]);
  const changedPatternWeekdays = useMemo(() => {
    if (!selectedChild) return [];
    return patterns.filter((pattern) => {
      const before = selectedChild.patterns.find((entry) => entry.weekday === pattern.weekday)
        ?? { weekday: pattern.weekday, enabled: false, arrivalTime: null, departureTime: null };
      return JSON.stringify(before) !== JSON.stringify(pattern);
    }).map((pattern) => weekdays.find((weekday) => weekday.value === pattern.weekday)?.label ?? String(pattern.weekday));
  }, [patterns, selectedChild]);

  const fillFromChild = useCallback((child: ManagedChild, membership = child.memberships[0]) => {
    setSelectedChildId(child.id);
    setIsNew(false);
    setForm({
      originalFamilyId: membership?.familyId ?? "",
      familyId: membership?.familyId ?? "",
      lastName: child.lastName ?? "",
      firstName: child.firstName ?? "",
      lastNameKana: child.lastNameKana ?? "",
      firstNameKana: child.firstNameKana ?? "",
      className: child.className,
      birthDate: child.birthDate ?? "",
      enrollmentDate: child.enrollmentDate ?? "",
      withdrawalDate: child.withdrawalDate ?? "",
      familyActiveFrom: membership?.activeFrom ?? "",
      familyActiveTo: membership?.activeTo ?? "",
      status: child.status,
    });
    setPatterns(patternsOrDefaults(child.patterns));
    setPatternReason("");
  }, []);

  const load = useCallback(async (preferredChildId = "") => {
    const result = await api<{ management: Management }>("/api/admin/schedules/children");
    setManagement(result.management);
    const child = result.management.children.find((entry) => entry.id === preferredChildId)
      ?? result.management.children[0]
      ?? null;
    if (child) fillFromChild(child);
    else {
      setIsNew(true);
      setForm(emptyForm(result.management.families[0]?.id ?? ""));
      setPatterns(patternsOrDefaults());
    }
  }, [fillFromChild]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((caught) => setError(caught instanceof Error ? caught.message : "園児情報を読み込めませんでした。"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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

  function beginNew() {
    const familyId = management?.families[0]?.id ?? "";
    setSelectedChildId("");
    setIsNew(true);
    setForm(emptyForm(familyId));
    setPatterns(patternsOrDefaults());
    setPatternReason("");
    setMessage("");
    setError("");
  }

  function selectMembership(familyId: string) {
    if (!selectedChild) return;
    const membership = selectedChild.memberships.find((entry) => entry.familyId === familyId);
    if (membership) fillFromChild(selectedChild, membership);
  }

  function updatePattern(weekday: number, patch: Partial<BasicPattern>) {
    setPatterns((current) => current.map((pattern) => {
      if (pattern.weekday !== weekday) return pattern;
      const enabled = patch.enabled ?? pattern.enabled;
      return {
        ...pattern,
        ...patch,
        enabled,
        arrivalTime: enabled ? patch.arrivalTime ?? pattern.arrivalTime ?? "08:30" : null,
        departureTime: enabled ? patch.departureTime ?? pattern.departureTime ?? "17:30" : null,
      };
    }));
  }

  if (!management) return <p className={`auth-message ${error ? "error" : "info"}`}>{error || "園児情報を確認中..."}</p>;

  return (
    <>
      <section className="auth-section admin-child-management">
        <div className="auth-section-heading">
          <div><span>{management.children.length}名</span><h2>園児情報</h2></div>
          <button type="button" disabled={busy !== ""} onClick={beginNew}>園児を新規登録</button>
        </div>
        {message ? <p className="auth-message info" role="status">{message}</p> : null}
        {error ? <p className="auth-message error" role="alert">{error}</p> : null}
        <div className="admin-child-layout">
          <div className="admin-child-list" role="list">
            {management.children.map((child) => (
              <button key={child.id} type="button" className={child.id === selectedChildId && !isNew ? "active" : ""} onClick={() => fillFromChild(child)}>
                <strong>{child.name}</strong>
                <span>{child.memberships.map((membership) => membership.familyName).join(" / ") || "所属家庭なし"}</span>
              </button>
            ))}
          </div>
          <form className="admin-child-form" onSubmit={(event) => {
            event.preventDefault();
            const label = `${form.lastName} ${form.firstName}`.trim() || "園児";
            const confirmation = isNew
              ? `${label}を新規登録しますか？`
              : `${label}の変更内容（${changedChildFields.join("、") || "変更なし"}）を保存しますか？`;
            if (!window.confirm(confirmation)) return;
            void run("child", async () => {
              const path = isNew ? "/api/admin/schedules/children" : `/api/admin/schedules/children/${encodeURIComponent(selectedChildId)}`;
              const result = await api<{ management: Management }>(path, { method: isNew ? "POST" : "PUT", body: form });
              setManagement(result.management);
              const child = result.management.children.find((entry) => isNew
                ? entry.lastName === form.lastName && entry.firstName === form.firstName && entry.birthDate === form.birthDate
                : entry.id === selectedChildId);
              if (child) fillFromChild(child, child.memberships.find((membership) => membership.familyId === form.familyId));
              setMessage(isNew ? "園児を登録しました。" : "園児情報を保存しました。");
            });
          }}>
            <div className="admin-child-form-grid">
              <label><span>姓</span><input required value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.currentTarget.value })} /></label>
              <label><span>名</span><input required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.currentTarget.value })} /></label>
              <label><span>姓かな</span><input required value={form.lastNameKana} onChange={(event) => setForm({ ...form, lastNameKana: event.currentTarget.value })} /></label>
              <label><span>名かな</span><input required value={form.firstNameKana} onChange={(event) => setForm({ ...form, firstNameKana: event.currentTarget.value })} /></label>
              <label><span>クラス</span><input value={form.className} onChange={(event) => setForm({ ...form, className: event.currentTarget.value })} /></label>
              <label><span>生年月日</span><input required type="date" value={form.birthDate} onChange={(event) => setForm({ ...form, birthDate: event.currentTarget.value })} /></label>
              <label><span>入園日</span><input required type="date" value={form.enrollmentDate} onChange={(event) => setForm({ ...form, enrollmentDate: event.currentTarget.value })} /></label>
              <label><span>退園日</span><input type="date" value={form.withdrawalDate} onChange={(event) => setForm({ ...form, withdrawalDate: event.currentTarget.value })} /></label>
              <label><span>在籍状態</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.currentTarget.value as ChildForm["status"] })}><option value="enrolled">在籍</option><option value="withdrawn">退園</option></select></label>
              {!isNew && selectedChild && selectedChild.memberships.length > 1 ? <label><span>編集する家庭所属</span><select value={form.originalFamilyId} onChange={(event) => selectMembership(event.currentTarget.value)}>{selectedChild.memberships.map((membership) => <option key={membership.familyId} value={membership.familyId}>{membership.familyName}</option>)}</select></label> : null}
              <label><span>所属家庭</span><select required value={form.familyId} onChange={(event) => setForm({ ...form, familyId: event.currentTarget.value })}>{management.families.map((family) => <option key={family.id} value={family.id}>{family.displayName}</option>)}</select></label>
              <label><span>家庭所属開始日</span><input required type="date" value={form.familyActiveFrom} onChange={(event) => setForm({ ...form, familyActiveFrom: event.currentTarget.value })} /></label>
              <label><span>家庭所属終了日</span><input type="date" value={form.familyActiveTo} onChange={(event) => setForm({ ...form, familyActiveTo: event.currentTarget.value })} /></label>
            </div>
            <button className="primary" type="submit" disabled={busy !== "" || !form.familyId}>{busy === "child" ? "保存中..." : isNew ? "園児を登録" : "園児情報を保存"}</button>
          </form>
        </div>
      </section>

      {!isNew && selectedChild ? <section className="auth-section admin-pattern-management">
        <div className="auth-section-heading"><div><span>{selectedChild.name}</span><h2>基本利用パターン</h2></div></div>
        <div className="admin-pattern-grid">
          {patterns.map((pattern) => (
            <div key={pattern.weekday} className="admin-pattern-row">
              <strong>{weekdays.find((weekday) => weekday.value === pattern.weekday)?.label}</strong>
              <label className="parent-check-row"><input type="checkbox" checked={pattern.enabled} onChange={(event) => updatePattern(pattern.weekday, { enabled: event.currentTarget.checked })} /><span>利用する</span></label>
              <label><span>登園</span><input type="time" min="07:00" max="20:00" step={300} disabled={!pattern.enabled} value={pattern.arrivalTime ?? "08:30"} onChange={(event) => updatePattern(pattern.weekday, { arrivalTime: event.currentTarget.value })} /></label>
              <label><span>降園</span><input type="time" min="07:00" max="20:00" step={300} disabled={!pattern.enabled} value={pattern.departureTime ?? "17:30"} onChange={(event) => updatePattern(pattern.weekday, { departureTime: event.currentTarget.value })} /></label>
            </div>
          ))}
        </div>
        <div className="admin-schedule-form-row">
          <label className="admin-schedule-grow"><span>変更理由</span><input value={patternReason} onChange={(event) => setPatternReason(event.currentTarget.value)} placeholder="利用時間変更の連絡を受けたため" /></label>
          <button type="button" disabled={busy !== "" || !patternReason.trim()} onClick={() => {
            if (!window.confirm(`${selectedChild.name}の基本利用パターンを保存しますか？\n変更曜日: ${changedPatternWeekdays.join("、") || "変更なし"}`)) return;
            void run("patterns", async () => {
              const result = await api<{ result: { changed: boolean; management: Management } }>(`/api/admin/schedules/children/${encodeURIComponent(selectedChild.id)}/basic-patterns`, { method: "PUT", body: { reason: patternReason, patterns } });
              setManagement(result.result.management);
              const child = result.result.management.children.find((entry) => entry.id === selectedChild.id);
              if (child) fillFromChild(child);
              setMessage(result.result.changed ? "基本利用パターンと履歴を保存しました。" : "変更はありませんでした。");
            });
          }}>{busy === "patterns" ? "保存中..." : "基本パターンを保存"}</button>
        </div>
        <div className="admin-pattern-history">
          <h3>基本利用パターン履歴</h3>
          {selectedChild.patternHistories.length ? selectedChild.patternHistories.map((history) => (
            <details key={history.id}>
              <summary><strong>{weekdays.find((weekday) => weekday.value === history.weekday)?.label}</strong><span>{formatDateTime(history.changedAt)} / {history.administratorName}</span></summary>
              <p>{history.reason || "変更理由の記録なし"}</p>
              <div><span>{patternLabel(history.before)}</span><span>→</span><span>{patternLabel(history.after)}</span></div>
            </details>
          )) : <p className="admin-schedule-note">変更履歴はありません。</p>}
        </div>
      </section> : null}
    </>
  );
}
