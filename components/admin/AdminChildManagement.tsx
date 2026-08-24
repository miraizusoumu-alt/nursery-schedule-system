"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { AdminIcon } from "@/components/ui/AdminIcon";
import { CredentialNotice, type Credential } from "@/components/auth/AuthClient";

type FamilyOption = {
  id: string;
  familyCode: string;
  displayName: string;
  status: string;
  loginId: string | null;
  startDate: string | null;
  stopDate: string | null;
  hasAccount: boolean;
};

type Membership = {
  familyId: string;
  familyCode: string;
  familyName: string;
  hasAccount: boolean;
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

const timeOptions = Array.from({ length: ((20 - 7) * 60) / 5 + 1 }, (_, index) => {
  const minutes = 7 * 60 + index * 5;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

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

function katakanaToHiragana(value: string) {
  return value.replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
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
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [credential, setCredential] = useState<Credential | null>(null);
  const [accountMode, setAccountMode] = useState<"new" | "existing">("new");
  const [accountStartDate, setAccountStartDate] = useState("");
  const [existingFamilyId, setExistingFamilyId] = useState("");

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
      ["姓（かな）", katakanaToHiragana(selectedChild.lastNameKana ?? ""), form.lastNameKana],
      ["名（かな）", katakanaToHiragana(selectedChild.firstNameKana ?? ""), form.firstNameKana],
      ["生年月日", selectedChild.birthDate ?? "", form.birthDate],
      ["入園日", selectedChild.enrollmentDate ?? "", form.enrollmentDate],
      ["退園日", selectedChild.withdrawalDate ?? "", form.withdrawalDate],
      ["在籍状態", selectedChild.status, form.status],
      ["保護者・家庭", selectedMembership?.familyId ?? "", form.familyId],
      ["保護者・家庭の登録開始日", selectedMembership?.activeFrom ?? "", form.familyActiveFrom],
      ["保護者・家庭の登録終了日", selectedMembership?.activeTo ?? "", form.familyActiveTo],
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
      lastNameKana: katakanaToHiragana(child.lastNameKana ?? ""),
      firstNameKana: katakanaToHiragana(child.firstNameKana ?? ""),
      className: child.className,
      birthDate: child.birthDate ?? "",
      enrollmentDate: child.enrollmentDate ?? "",
      withdrawalDate: child.withdrawalDate ?? "",
      familyActiveFrom: membership?.activeFrom ?? "",
      familyActiveTo: membership?.activeTo ?? "",
      status: child.status,
    });
    setPatterns(patternsOrDefaults(child.patterns));
    setCredential(null);
    setAccountMode("new");
    setAccountStartDate(child.enrollmentDate ?? "");
  }, []);

  const load = useCallback(async (preferredChildId = "") => {
    const result = await api<{ management: Management }>("/api/admin/schedules/children");
    setManagement(result.management);
    setExistingFamilyId((current) => result.management.families.some((family) => family.id === current && family.hasAccount)
      ? current
      : result.management.families.find((family) => family.hasAccount)?.id ?? "");
    const child = preferredChildId
      ? result.management.children.find((entry) => entry.id === preferredChildId) ?? null
      : null;
    if (child) fillFromChild(child);
    else {
      setSelectedChildId("");
      setIsNew(false);
      setForm(emptyForm());
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
    setSelectedChildId("");
    setIsNew(true);
    setForm(emptyForm());
    setPatterns(patternsOrDefaults());
    setMessage("");
    setError("");
    setCredential(null);
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
          <div><span>{management.children.length}名</span><h2><AdminIcon name="child" />園児情報</h2></div>
          <button type="button" disabled={busy !== ""} onClick={beginNew}>＋ 園児を新規登録</button>
        </div>
        {message ? <p className="auth-message info" role="status">{message}</p> : null}
        {error ? <p className="auth-message error" role="alert">{error}</p> : null}
        <div className="admin-child-layout">
          <div className="admin-child-list" role="list">
            {management.children.map((child) => (
              <button key={child.id} type="button" className={child.id === selectedChildId && !isNew ? "active" : ""} onClick={() => fillFromChild(child)}>
                <strong>{child.name}</strong>
                {!child.memberships.some((membership) => membership.hasAccount) ? <span className="admin-account-missing">保護者ログインアカウント未作成</span> : null}
              </button>
            ))}
          </div>
          {isNew || selectedChild ? <form className="admin-child-form" name="nursery-child-profile" autoComplete="off" onSubmit={(event) => {
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
              setMessage(isNew ? "園児を登録しました。続けて保護者ログインアカウントを設定してください。" : "園児情報を保存しました。");
            });
            }}>
              <div className="admin-child-form-grid">
                <div className="admin-child-name-row">
                  <label><span>姓</span><input name="nursery-child-family-name" autoComplete="off" required value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.currentTarget.value })} /></label>
                  <label><span>姓（かな）</span><input name="nursery-child-family-name-kana" autoComplete="off" required pattern="[ぁ-ゖー]+" inputMode="text" placeholder="やまだ" value={form.lastNameKana} onChange={(event) => setForm({ ...form, lastNameKana: event.currentTarget.value })} /></label>
                </div>
                <div className="admin-child-name-row">
                  <label><span>名</span><input name="nursery-child-given-name" autoComplete="off" required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.currentTarget.value })} /></label>
                  <label><span>名（かな）</span><input name="nursery-child-given-name-kana" autoComplete="off" required pattern="[ぁ-ゖー]+" inputMode="text" placeholder="たろう" value={form.firstNameKana} onChange={(event) => setForm({ ...form, firstNameKana: event.currentTarget.value })} /></label>
                </div>
                <div className="admin-child-date-row">
                  <label><span>生年月日</span><input name="nursery-child-birth-date" autoComplete="off" required type="date" value={form.birthDate} onChange={(event) => setForm({ ...form, birthDate: event.currentTarget.value })} /></label>
                  <label><span>入園日</span><input name="nursery-child-enrollment-date" autoComplete="off" required type="date" value={form.enrollmentDate} onChange={(event) => setForm({ ...form, enrollmentDate: event.currentTarget.value })} /></label>
                  <label><span>退園日</span><input name="nursery-child-withdrawal-date" autoComplete="off" type="date" value={form.withdrawalDate} onChange={(event) => setForm({ ...form, withdrawalDate: event.currentTarget.value })} /></label>
                </div>
                <label className="admin-child-status-field"><span>在籍状態</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.currentTarget.value as ChildForm["status"] })}><option value="enrolled">在籍</option><option value="withdrawn">退園</option></select></label>
              </div>
            <button className="primary" type="submit" disabled={busy !== ""}>{busy === "child" ? "保存中..." : isNew ? "園児を登録" : "園児情報を保存"}</button>
          </form> : <div className="admin-child-empty"><strong>園児を選択してください</strong><p>園児情報を編集する場合は一覧から選択し、新しく登録する場合は「＋ 園児を新規登録」を押してください。</p></div>}
        </div>
      </section>

      {!isNew && selectedChild && (credential || !selectedChild.memberships.some((membership) => membership.hasAccount)) ? <section className="auth-section admin-child-family-setup">
        <div className="auth-section-heading"><div><span>園児登録の次の手順</span><h2>保護者ログインアカウント</h2></div></div>
        {credential ? <CredentialNotice credential={credential} onDismiss={() => setCredential(null)} /> : null}
        {!credential ? <>
          <p className="admin-account-missing">保護者ログインアカウント未作成</p>
          <p className="admin-schedule-note">新しくログイン情報を発行するか、きょうだいと同じ保護者ログインアカウントへ追加してください。</p>
          <div className="admin-account-mode" role="group" aria-label="保護者ログインアカウントの設定方法">
            <button type="button" className={accountMode === "new" ? "active" : ""} onClick={() => setAccountMode("new")}>新しい保護者ログインアカウントを発行</button>
            <button type="button" className={accountMode === "existing" ? "active" : ""} onClick={() => setAccountMode("existing")}>既存の保護者ログインアカウントに追加</button>
          </div>
          <div className="admin-schedule-form-row">
            {accountMode === "existing" ? <label className="admin-schedule-grow"><span>追加する家庭</span><select value={existingFamilyId} onChange={(event) => setExistingFamilyId(event.currentTarget.value)}>{management.families.filter((family) => family.hasAccount).map((family) => <option key={family.id} value={family.id}>{family.displayName}</option>)}</select></label> : null}
            {accountMode === "new" ? <label><span>使用開始日</span><input type="date" value={accountStartDate} onChange={(event) => setAccountStartDate(event.currentTarget.value)} /></label> : null}
            <button type="button" className="primary" disabled={busy !== "" || (accountMode === "new" ? !accountStartDate : !existingFamilyId)} onClick={() => {
              const action = accountMode === "new" ? "新しい保護者ログインアカウントを発行" : "既存の保護者ログインアカウントへ追加";
              if (!window.confirm(`${selectedChild.name}について、${action}しますか？`)) return;
              void run("family-account", async () => {
                if (accountMode === "new") {
                  const result = await api<{ credential: Credential; management: Management }>(`/api/admin/schedules/children/${encodeURIComponent(selectedChild.id)}/family-account`, { method: "POST", body: { startDate: accountStartDate } });
                  setManagement(result.management);
                  setCredential(result.credential);
                  const child = result.management.children.find((entry) => entry.id === selectedChild.id);
                  if (child) fillFromChild(child);
                  setCredential(result.credential);
                  setMessage("保護者ログインアカウントを発行しました。ログイン案内はこの画面を閉じる前に印刷・PDF保存してください。");
                } else {
                  const result = await api<{ management: Management }>(`/api/admin/schedules/children/${encodeURIComponent(selectedChild.id)}/family-membership`, { method: "POST", body: { familyId: existingFamilyId } });
                  setManagement(result.management);
                  const child = result.management.children.find((entry) => entry.id === selectedChild.id);
                  if (child) fillFromChild(child);
                  setMessage("既存の保護者ログインアカウントへ園児を追加しました。");
                }
              });
            }}>{busy === "family-account" ? "処理中..." : accountMode === "new" ? "保護者ログインアカウントを発行" : "このアカウントに追加"}</button>
          </div>
        </> : null}
      </section> : null}

      {!isNew && selectedChild ? <section className="auth-section admin-pattern-management">
        <div className="auth-section-heading"><div><span>{selectedChild.name}</span><h2>基本利用予定</h2></div></div>
        <div className="admin-pattern-grid">
          {patterns.map((pattern) => (
            <div key={pattern.weekday} className="admin-pattern-row">
              <strong>{weekdays.find((weekday) => weekday.value === pattern.weekday)?.label}</strong>
              <label className="parent-check-row"><input type="checkbox" checked={pattern.enabled} onChange={(event) => updatePattern(pattern.weekday, { enabled: event.currentTarget.checked })} /><span>利用する</span></label>
              <label><span>登園</span><select disabled={!pattern.enabled} value={pattern.arrivalTime ?? "08:30"} onChange={(event) => updatePattern(pattern.weekday, { arrivalTime: event.currentTarget.value })}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
              <label><span>降園</span><select disabled={!pattern.enabled} value={pattern.departureTime ?? "17:30"} onChange={(event) => updatePattern(pattern.weekday, { departureTime: event.currentTarget.value })}>{timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
            </div>
          ))}
        </div>
        <div className="admin-schedule-form-row">
          <button type="button" disabled={busy !== ""} onClick={() => {
            if (!window.confirm(`${selectedChild.name}の基本利用パターンを保存しますか？\n変更曜日: ${changedPatternWeekdays.join("、") || "変更なし"}`)) return;
            void run("patterns", async () => {
              const result = await api<{ result: { changed: boolean; management: Management } }>(`/api/admin/schedules/children/${encodeURIComponent(selectedChild.id)}/basic-patterns`, { method: "PUT", body: { patterns } });
              setManagement(result.result.management);
              const child = result.result.management.children.find((entry) => entry.id === selectedChild.id);
              if (child) fillFromChild(child);
              setMessage(result.result.changed ? "基本利用パターンと履歴を保存しました。" : "変更はありませんでした。");
            });
          }}>{busy === "patterns" ? "保存中..." : "基本利用予定を保存"}</button>
        </div>
        <div className="admin-pattern-history">
          <h3>基本利用パターン履歴</h3>
          {selectedChild.patternHistories.length ? selectedChild.patternHistories.map((history) => (
            <details key={history.id}>
              <summary><strong>{weekdays.find((weekday) => weekday.value === history.weekday)?.label}</strong><span>{formatDateTime(history.changedAt)} / {history.administratorName}</span></summary>
              <div><span>{patternLabel(history.before)}</span><span>→</span><span>{patternLabel(history.after)}</span></div>
            </details>
          )) : <p className="admin-schedule-note">変更履歴はありません。</p>}
        </div>
      </section> : null}
    </>
  );
}
