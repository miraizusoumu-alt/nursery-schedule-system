"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { AdminIcon } from "@/components/ui/AdminIcon";

type Availability = {
  weekday: number;
  available: boolean;
  startTime: string | null;
  endTime: string | null;
  candidates: AvailabilityCandidate[];
};

type AvailabilityCandidate = {
  candidateOrder?: number;
  startTime: string;
  endTime: string;
  weekOrdinals: number[] | null;
};

type Qualification = {
  id: string;
  qualificationType: string;
  validFrom: string;
  validTo: string | null;
};

type StaffRole = {
  id: string;
  roleType: string;
  validFrom: string;
  validTo: string | null;
};

type WorkCondition = {
  id: string;
  validFrom: string;
  validTo: string | null;
  employmentType: string;
  monthlyMinutesLimit: number | null;
  maxConsecutiveDays: number | null;
  weeklyMinutesLimit: number | null;
  weeklyMinutesLimitType: "inclusive" | "exclusive" | null;
  preferredWeeklyWorkDaysMin: number | null;
  weeklyWorkDaysMax: number | null;
  dailyWorkMinutesMin: number | null;
  dailyWorkMinutesMax: number | null;
  createdByAdministratorName: string;
  createdAt: string;
  availability: Availability[];
};

type StaffMember = {
  id: string;
  staffCode: string;
  name: string;
  employmentStartDate: string;
  employmentEndDate: string | null;
  status: "active" | "inactive";
  roles: StaffRole[];
  qualifications: Qualification[];
  conditions: WorkCondition[];
  currentCondition: WorkCondition | null;
};

type Management = { staff: StaffMember[] };

type StaffForm = {
  name: string;
  employmentStartDate: string;
  employmentEndDate: string;
  status: "active" | "inactive";
};

const weekdays = [
  { value: 0, label: "日曜日" },
  { value: 1, label: "月曜日" },
  { value: 2, label: "火曜日" },
  { value: 3, label: "水曜日" },
  { value: 4, label: "木曜日" },
  { value: 5, label: "金曜日" },
  { value: 6, label: "土曜日" },
];

const roleOptions = [
  { value: "nursery_teacher_role", label: "保育士" },
  { value: "principal", label: "園長" },
  { value: "manager", label: "マネージャー" },
  { value: "meal_service", label: "配膳" },
  { value: "other", label: "その他" },
];
const qualificationOptions = [
  { value: "licensed_nursery_teacher", label: "保育士資格" },
  { value: "childcare_support_worker_local_childcare", label: "子育て支援員研修修了（地域保育コース・地域型保育）" },
];

function optionLabel(options: Array<{ value: string; label: string }>, value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}
const staffTimeOptions = Array.from({ length: ((20 * 60 + 30) - (6 * 60 + 30)) / 15 + 1 }, (_, index) => {
  const minutes = 6 * 60 + 30 + index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

function localDateKey() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function emptyStaffForm(): StaffForm {
  return { name: "", employmentStartDate: localDateKey(), employmentEndDate: "", status: "active" };
}

function defaultAvailability(): Availability[] {
  return weekdays.map(({ value }) => ({
    weekday: value,
    available: value !== 0,
    startTime: value !== 0 ? "06:45" : null,
    endTime: value !== 0 ? "20:15" : null,
    candidates: value !== 0
      ? [{ startTime: "06:45", endTime: "20:15", weekOrdinals: null }]
      : [],
  }));
}

function candidateWeekLabel(candidate: AvailabilityCandidate) {
  return candidate.weekOrdinals === null
    ? "毎週"
    : candidate.weekOrdinals.map((ordinal) => `第${ordinal}`).join("・");
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

function hoursValue(minutes: number | null | undefined) {
  return minutes === null || minutes === undefined ? "" : String(minutes / 60);
}

function hoursToMinutes(value: string) {
  const hours = Number(value);
  return Number.isFinite(hours) ? Math.round(hours * 60) : null;
}

function formatContractHours(minutes: number | null) {
  if (minutes === null) return "未設定";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}時間` : `${hours}時間${remainder}分`;
}

export function AdminStaffManagement() {
  const [management, setManagement] = useState<Management | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [staffForm, setStaffForm] = useState<StaffForm>(emptyStaffForm());
  const [responsibilityTypes, setResponsibilityTypes] = useState<string[]>([]);
  const [roleFrom, setRoleFrom] = useState(localDateKey());
  const [roleTo, setRoleTo] = useState("");
  const [editingRoleId, setEditingRoleId] = useState("");
  const [qualificationType, setQualificationType] = useState(qualificationOptions[0].value);
  const [qualificationFrom, setQualificationFrom] = useState(localDateKey());
  const [qualificationTo, setQualificationTo] = useState("");
  const [editingQualificationId, setEditingQualificationId] = useState("");
  const [conditionFrom, setConditionFrom] = useState(localDateKey());
  const [conditionTo, setConditionTo] = useState("");
  const [employmentType, setEmploymentType] = useState("常勤");
  const [weeklyHoursLimit, setWeeklyHoursLimit] = useState("");
  const [weeklyHoursLimitType, setWeeklyHoursLimitType] = useState<"inclusive" | "exclusive">("inclusive");
  const [preferredWeeklyWorkDaysMin, setPreferredWeeklyWorkDaysMin] = useState("");
  const [weeklyWorkDaysMax, setWeeklyWorkDaysMax] = useState("");
  const [dailyWorkHoursMin, setDailyWorkHoursMin] = useState("");
  const [dailyWorkHoursMax, setDailyWorkHoursMax] = useState("");
  const [availability, setAvailability] = useState<Availability[]>(defaultAvailability());
  const [conditionDirty, setConditionDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedStaff = useMemo(
    () => management?.staff.find((staff) => staff.id === selectedStaffId) ?? null,
    [management, selectedStaffId],
  );

  const fillFromStaff = useCallback((staff: StaffMember) => {
    const condition = staff.currentCondition;
    setSelectedStaffId(staff.id);
    setIsNew(false);
    setStaffForm({
      name: staff.name,
      employmentStartDate: staff.employmentStartDate,
      employmentEndDate: staff.employmentEndDate ?? "",
      status: staff.status,
    });
    setResponsibilityTypes([]);
    setRoleFrom(localDateKey());
    setRoleTo("");
    setEditingRoleId("");
    setQualificationType(qualificationOptions[0].value);
    setQualificationFrom(localDateKey());
    setQualificationTo("");
    setEditingQualificationId("");
    setConditionFrom(localDateKey());
    setConditionTo("");
    setEmploymentType(condition?.employmentType ?? "常勤");
    setWeeklyHoursLimit(hoursValue(condition?.weeklyMinutesLimit));
    setWeeklyHoursLimitType(condition?.weeklyMinutesLimitType ?? "inclusive");
    setPreferredWeeklyWorkDaysMin(condition?.preferredWeeklyWorkDaysMin === null
      || condition?.preferredWeeklyWorkDaysMin === undefined
      ? ""
      : String(condition.preferredWeeklyWorkDaysMin));
    setWeeklyWorkDaysMax(condition?.weeklyWorkDaysMax === null || condition?.weeklyWorkDaysMax === undefined
      ? ""
      : String(condition.weeklyWorkDaysMax));
    setDailyWorkHoursMin(hoursValue(condition?.dailyWorkMinutesMin));
    setDailyWorkHoursMax(hoursValue(condition?.dailyWorkMinutesMax));
    setAvailability(condition
      ? weekdays.map(({ value }) => {
          const entry = condition.availability.find((availabilityEntry) => availabilityEntry.weekday === value);
          if (!entry) return { weekday: value, available: false, startTime: null, endTime: null, candidates: [] };
          const candidates = entry.candidates?.length
            ? entry.candidates
            : entry.available && entry.startTime && entry.endTime
              ? [{ startTime: entry.startTime, endTime: entry.endTime, weekOrdinals: null }]
              : [];
          return { ...entry, candidates };
        })
      : defaultAvailability());
    setConditionDirty(false);
  }, []);

  const staffDirty = useMemo(() => {
    if (isNew) return true;
    if (!selectedStaff) return false;
    return staffForm.name !== selectedStaff.name
      || staffForm.employmentStartDate !== selectedStaff.employmentStartDate
      || staffForm.employmentEndDate !== (selectedStaff.employmentEndDate ?? "")
      || staffForm.status !== selectedStaff.status;
  }, [isNew, selectedStaff, staffForm]);

  const acceptManagement = useCallback((next: Management, preferredStaffId = "") => {
    setManagement(next);
    const staff = next.staff.find((entry) => entry.id === preferredStaffId) ?? null;
    if (staff) fillFromStaff(staff);
  }, [fillFromStaff]);
  const partTimeConditionsComplete = employmentType !== "非常勤" || [
    weeklyHoursLimit,
    preferredWeeklyWorkDaysMin,
    weeklyWorkDaysMax,
    dailyWorkHoursMin,
    dailyWorkHoursMax,
  ].every((value) => value !== "");

  const load = useCallback(async () => {
    const result = await api<{ management: Management }>("/api/admin/staff");
    setManagement(result.management);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((caught) => setError(caught instanceof Error ? caught.message : "職員情報を読み込めませんでした。"));
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
    setSelectedStaffId("");
    setIsNew(true);
    setStaffForm(emptyStaffForm());
    setResponsibilityTypes([]);
    setEditingRoleId("");
    setEditingQualificationId("");
    setMessage("");
    setError("");
  }

  function markConditionChanged(task: () => void) {
    task();
    setConditionDirty(true);
    setMessage("");
  }

  function updateStaffForm(patch: Partial<StaffForm>) {
    setStaffForm((current) => ({ ...current, ...patch }));
    setMessage("");
  }

  function updateAvailability(weekday: number, patch: Partial<Availability>) {
    setAvailability((current) => current.map((entry) => {
      if (entry.weekday !== weekday) return entry;
      const available = patch.available ?? entry.available;
      const candidates = patch.candidates ?? (entry.candidates.length > 0
        ? entry.candidates
        : [{ startTime: "09:00", endTime: "17:00", weekOrdinals: null }]);
      return {
        ...entry,
        ...patch,
        available,
        startTime: available ? candidates[0].startTime : null,
        endTime: available ? candidates[0].endTime : null,
        candidates,
      };
    }));
  }

  function updateAvailabilityCandidate(
    weekday: number,
    candidateIndex: number,
    patch: Partial<AvailabilityCandidate>,
  ) {
    setAvailability((current) => current.map((entry) => {
      if (entry.weekday !== weekday) return entry;
      const candidates = entry.candidates.map((candidate, index) => (
        index === candidateIndex ? { ...candidate, ...patch } : candidate
      ));
      return {
        ...entry,
        candidates,
        startTime: candidates[0]?.startTime ?? null,
        endTime: candidates[0]?.endTime ?? null,
      };
    }));
  }

  function addAvailabilityCandidate(weekday: number) {
    setAvailability((current) => current.map((entry) => {
      if (entry.weekday !== weekday) return entry;
      const candidates = [
        ...entry.candidates,
        { startTime: "15:00", endTime: "18:30", weekOrdinals: null },
      ];
      return {
        ...entry,
        available: true,
        startTime: candidates[0].startTime,
        endTime: candidates[0].endTime,
        candidates,
      };
    }));
  }

  function removeAvailabilityCandidate(weekday: number, candidateIndex: number) {
    setAvailability((current) => current.map((entry) => {
      if (entry.weekday !== weekday || entry.candidates.length <= 1) return entry;
      const candidates = entry.candidates.filter((_, index) => index !== candidateIndex);
      return {
        ...entry,
        candidates,
        startTime: candidates[0].startTime,
        endTime: candidates[0].endTime,
      };
    }));
  }

  function toggleCandidateWeek(weekday: number, candidateIndex: number, ordinal: number, checked: boolean) {
    setAvailability((current) => current.map((entry) => {
      if (entry.weekday !== weekday) return entry;
      const candidates = entry.candidates.map((candidate, index) => {
        if (index !== candidateIndex) return candidate;
        const currentWeeks = candidate.weekOrdinals ?? [1, 2, 3, 4, 5];
        const nextWeeks = checked
          ? [...new Set([...currentWeeks, ordinal])].sort((left, right) => left - right)
          : currentWeeks.filter((week) => week !== ordinal);
        return nextWeeks.length > 0 ? { ...candidate, weekOrdinals: nextWeeks } : candidate;
      });
      return { ...entry, candidates };
    }));
  }

  if (!management) return <p className={`auth-message ${error ? "error" : "info"}`}>{error || "職員情報を確認中..."}</p>;

  return (
    <section id="staff-management" className="auth-section admin-staff-management">
      <div className="auth-section-heading">
        <div><span>{management.staff.length}名</span><h2><AdminIcon name="staff" />職員管理</h2></div>
        <button type="button" disabled={busy !== ""} onClick={beginNew}>＋ 職員を登録</button>
      </div>
      {message ? <p className="auth-message info" role="status">{message}</p> : null}
      {error ? <p className="auth-message error" role="alert">{error}</p> : null}
      <div className="admin-child-layout">
        <div className="admin-child-list" role="list">
          {!management.staff.length ? <p className="admin-schedule-note">職員はまだ登録されていません。</p> : null}
          {management.staff.map((staff) => (
            <button key={staff.id} type="button" className={staff.id === selectedStaffId && !isNew ? "active" : ""} onClick={() => fillFromStaff(staff)}>
              <strong>{staff.name}</strong>
              <span>{staff.staffCode} / {staff.status === "active" ? "在籍中" : "在籍終了"}</span>
              <span>{staff.currentCondition?.employmentType ?? "勤務条件未登録"}</span>
            </button>
          ))}
        </div>
        <div className="admin-staff-detail">
          {isNew || selectedStaff ? <form className="admin-child-form" onSubmit={(event) => {
            event.preventDefault();
            if (!window.confirm(isNew ? `${staffForm.name || "職員"}を登録しますか？` : `${staffForm.name}の基本情報を保存しますか？`)) return;
            void run("staff", async () => {
              const path = isNew ? "/api/admin/staff" : `/api/admin/staff/${encodeURIComponent(selectedStaffId)}`;
              const previousIds = new Set(management.staff.map((staff) => staff.id));
              const result = await api<{ management: Management }>(path, { method: isNew ? "POST" : "PUT", body: staffForm });
              const created = result.management.staff.find((entry) => !previousIds.has(entry.id));
              acceptManagement(result.management, isNew ? created?.id : selectedStaffId);
              setMessage(isNew ? "職員を登録しました。" : "職員情報を保存しました。");
            });
          }}>
            <h3>基本情報</h3>
            <p className="admin-schedule-note">職員コードは登録時に自動で発番します。常勤・非常勤と曜日別の時間は、職員登録後に勤務条件として設定します。</p>
            <div className="admin-child-form-grid">
              <label><span>氏名</span><input required value={staffForm.name} onChange={(event) => updateStaffForm({ name: event.currentTarget.value })} /></label>
              <label><span>在籍状況</span><select value={staffForm.status} onChange={(event) => updateStaffForm({ status: event.currentTarget.value as StaffForm["status"] })}><option value="active">在籍中</option><option value="inactive">在籍終了（シフト対象外）</option></select></label>
              <label><span>勤務開始日</span><input required type="date" value={staffForm.employmentStartDate} onChange={(event) => updateStaffForm({ employmentStartDate: event.currentTarget.value })} /></label>
              <label><span>勤務終了日</span><input type="date" value={staffForm.employmentEndDate} onChange={(event) => updateStaffForm({ employmentEndDate: event.currentTarget.value })} /></label>
            </div>
            <p className={`admin-save-state ${busy === "staff" ? "saving" : staffDirty ? "unsaved" : "saved"}`} role="status">
              {busy === "staff" ? "基本情報を保存中..." : staffDirty ? "基本情報は未保存です。" : "基本情報は保存済みです。"}
            </p>
            <button className="primary" type="submit" disabled={busy !== ""}><AdminIcon name="save" />{busy === "staff" ? "保存中..." : isNew ? "職員を登録" : "基本情報を保存"}</button>
          </form> : <div className="admin-staff-empty"><AdminIcon name="staff" size={28} /><strong>職員を選択してください</strong><span>職員名を選ぶと登録内容を確認できます。新しく登録する場合は「＋ 職員を登録」を押してください。</span></div>}

          {!isNew && selectedStaff ? <>
            <div className="admin-staff-subsection">
              <h3><AdminIcon name="badge" />担当区分</h3>
              <p className="admin-schedule-note">園内で担当する仕事です。担当区分の「保育士」は、法的な保育士資格の登録とは別です。</p>
              {selectedStaff.roles.length ? <ul className="admin-staff-history">{selectedStaff.roles.map((role) => (
                <li key={role.id}><span><strong>{optionLabel(roleOptions, role.roleType)}</strong><span>{role.validFrom} - {role.validTo ?? "期限なし"}</span></span><span className="admin-staff-record-actions"><button type="button" disabled={busy !== ""} onClick={() => {
                  setEditingRoleId(role.id);
                  setResponsibilityTypes([role.roleType]);
                  setRoleFrom(role.validFrom);
                  setRoleTo(role.validTo ?? "");
                }}>編集</button><button type="button" disabled={busy !== ""} onClick={() => {
                  if (!window.confirm(`担当区分「${optionLabel(roleOptions, role.roleType)}」を削除しますか？`)) return;
                  void run("role-delete", async () => {
                    const result = await api<{ management: Management }>(`/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/roles/${encodeURIComponent(role.id)}`, { method: "DELETE", body: {} });
                    acceptManagement(result.management, selectedStaff.id);
                    setMessage("担当区分を削除しました。");
                  });
                }}>削除</button></span></li>
              ))}</ul> : <p className="admin-schedule-note">この職員の担当区分は登録されていません。</p>}
              <form className="admin-schedule-form-row" onSubmit={(event) => {
                event.preventDefault();
                const labels = responsibilityTypes.map((type) => optionLabel(roleOptions, type)).join("、");
                if (!window.confirm(`${selectedStaff.name}の担当区分「${labels}」を${editingRoleId ? "更新" : "登録"}しますか？`)) return;
                void run("role", async () => {
                  const path = editingRoleId
                    ? `/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/roles/${encodeURIComponent(editingRoleId)}`
                    : `/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/responsibilities`;
                  const body = editingRoleId
                    ? { roleType: responsibilityTypes[0], validFrom: roleFrom, validTo: roleTo }
                    : { responsibilityTypes, validFrom: roleFrom, validTo: roleTo };
                  const result = await api<{ management: Management }>(path, {
                    method: editingRoleId ? "PUT" : "POST",
                    body,
                  });
                  acceptManagement(result.management, selectedStaff.id);
                  setResponsibilityTypes([]);
                  setEditingRoleId("");
                  setRoleFrom(localDateKey());
                  setRoleTo("");
                  setMessage(editingRoleId ? "担当区分を更新しました。" : "担当区分を登録しました。");
                });
              }}>
                <fieldset className="admin-responsibility-options"><legend>{editingRoleId ? "変更する担当区分" : "追加する担当区分（複数選択可）"}</legend>{roleOptions.map((option) => <label key={option.value}><input type="checkbox" checked={responsibilityTypes.includes(option.value)} onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setResponsibilityTypes((current) => checked
                    ? editingRoleId ? [option.value] : [...new Set([...current, option.value])]
                    : current.filter((value) => value !== option.value));
                }} /><span>{option.label}</span></label>)}</fieldset>
                <label><span>有効開始日</span><input required type="date" value={roleFrom} onChange={(event) => setRoleFrom(event.currentTarget.value)} /></label>
                <label><span>有効終了日</span><input type="date" value={roleTo} onChange={(event) => setRoleTo(event.currentTarget.value)} /></label>
                <button type="submit" disabled={busy !== "" || !responsibilityTypes.length}>{busy === "role" ? "保存中..." : editingRoleId ? "担当区分を更新" : "担当区分を登録"}</button>
                {editingRoleId ? <button type="button" disabled={busy !== ""} onClick={() => { setEditingRoleId(""); setResponsibilityTypes([]); setRoleFrom(localDateKey()); setRoleTo(""); }}>編集をやめる</button> : null}
              </form>
            </div>

            <div className="admin-staff-subsection">
              <h3><AdminIcon name="badge" />資格・研修</h3>
              <p className="admin-schedule-note">保育配置の法的な候補判定に使用します。担当区分とは別に、有効期間を確認して登録してください。</p>
              {selectedStaff.qualifications.length ? <ul className="admin-staff-history">{selectedStaff.qualifications.map((qualification) => (
                <li key={qualification.id}><span><strong>{optionLabel(qualificationOptions, qualification.qualificationType)}</strong><span>{qualification.validFrom} - {qualification.validTo ?? "期限なし"}</span></span><span className="admin-staff-record-actions"><button type="button" disabled={busy !== ""} onClick={() => {
                  setEditingQualificationId(qualification.id);
                  setQualificationType(qualification.qualificationType);
                  setQualificationFrom(qualification.validFrom);
                  setQualificationTo(qualification.validTo ?? "");
                }}>編集</button><button type="button" disabled={busy !== ""} onClick={() => {
                  if (!window.confirm(`資格・研修「${optionLabel(qualificationOptions, qualification.qualificationType)}」を削除しますか？`)) return;
                  void run("qualification-delete", async () => {
                    const result = await api<{ management: Management }>(`/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/qualifications/${encodeURIComponent(qualification.id)}`, { method: "DELETE", body: {} });
                    acceptManagement(result.management, selectedStaff.id);
                    setMessage("資格・研修を削除しました。");
                  });
                }}>削除</button></span></li>
              ))}</ul> : <p className="admin-schedule-note">この職員の資格・研修は登録されていません。</p>}
              <form className="admin-schedule-form-row" onSubmit={(event) => {
                event.preventDefault();
                const label = optionLabel(qualificationOptions, qualificationType);
                if (!window.confirm(`${selectedStaff.name}の資格・研修「${label}」を${editingQualificationId ? "更新" : "登録"}しますか？`)) return;
                void run("qualification", async () => {
                  const path = editingQualificationId
                    ? `/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/qualifications/${encodeURIComponent(editingQualificationId)}`
                    : `/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/qualifications`;
                  const result = await api<{ management: Management }>(path, {
                    method: editingQualificationId ? "PUT" : "POST",
                    body: { qualificationType, validFrom: qualificationFrom, validTo: qualificationTo },
                  });
                  acceptManagement(result.management, selectedStaff.id);
                  setEditingQualificationId("");
                  setQualificationType(qualificationOptions[0].value);
                  setQualificationFrom(localDateKey());
                  setQualificationTo("");
                  setMessage(editingQualificationId ? "資格・研修を更新しました。" : "資格・研修を登録しました。");
                });
              }}>
                <label className="admin-schedule-grow"><span>資格・研修</span><select value={qualificationType} onChange={(event) => setQualificationType(event.currentTarget.value)}>{qualificationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label><span>有効開始日</span><input required type="date" value={qualificationFrom} onChange={(event) => setQualificationFrom(event.currentTarget.value)} /></label>
                <label><span>有効終了日</span><input type="date" value={qualificationTo} onChange={(event) => setQualificationTo(event.currentTarget.value)} /></label>
                <button type="submit" disabled={busy !== ""}>{busy === "qualification" ? "保存中..." : editingQualificationId ? "資格・研修を更新" : "資格・研修を登録"}</button>
                {editingQualificationId ? <button type="button" disabled={busy !== ""} onClick={() => { setEditingQualificationId(""); setQualificationType(qualificationOptions[0].value); setQualificationFrom(localDateKey()); setQualificationTo(""); }}>編集をやめる</button> : null}
              </form>
            </div>

            <div className="admin-staff-subsection">
              <h3><AdminIcon name="clock" />勤務条件を登録</h3>
              <p className="admin-schedule-note">開始日が既存の無期限版より後の場合、直前の版は前日までとして履歴に残ります。</p>
              <div className="admin-child-form-grid">
                <label><span>有効開始日</span><input required type="date" value={conditionFrom} onChange={(event) => markConditionChanged(() => setConditionFrom(event.currentTarget.value))} /></label>
                <label><span>有効終了日</span><input type="date" value={conditionTo} onChange={(event) => markConditionChanged(() => setConditionTo(event.currentTarget.value))} /></label>
                <label><span>雇用区分</span><select required value={employmentType} onChange={(event) => {
                  const nextEmploymentType = event.currentTarget.value;
                  markConditionChanged(() => {
                    setEmploymentType(nextEmploymentType);
                    if (nextEmploymentType === "常勤" && availability.every((entry) => !entry.available)) {
                      setAvailability(defaultAvailability());
                    }
                  });
                }}><option value="常勤">常勤</option><option value="非常勤">非常勤</option></select></label>
              </div>
              {employmentType === "非常勤" ? <div className="admin-part-time-conditions">
                <h4>非常勤の契約勤務条件</h4>
                <p className="admin-schedule-note">自動シフトでは週・日の上限を超えません。希望最低日数と1日最低時間は確認事項として扱います。</p>
                <div className="admin-child-form-grid">
                  <label><span>週勤務時間上限（時間）</span><input required type="number" inputMode="decimal" min="0.5" max="56" step="0.25" value={weeklyHoursLimit} onChange={(event) => {
                    const value = event.currentTarget.value;
                    markConditionChanged(() => setWeeklyHoursLimit(value));
                  }} /></label>
                  <label><span>上限の扱い</span><select value={weeklyHoursLimitType} onChange={(event) => {
                    const value = event.currentTarget.value as "inclusive" | "exclusive";
                    markConditionChanged(() => setWeeklyHoursLimitType(value));
                  }}><option value="inclusive">以内（ちょうどまで可）</option><option value="exclusive">未満（ちょうどは不可）</option></select></label>
                  <label><span>週希望最低勤務日数</span><input required type="number" inputMode="numeric" min="1" max="7" step="1" value={preferredWeeklyWorkDaysMin} onChange={(event) => {
                    const value = event.currentTarget.value;
                    markConditionChanged(() => setPreferredWeeklyWorkDaysMin(value));
                  }} /></label>
                  <label><span>週最大勤務日数</span><input required type="number" inputMode="numeric" min="1" max="7" step="1" value={weeklyWorkDaysMax} onChange={(event) => {
                    const value = event.currentTarget.value;
                    markConditionChanged(() => setWeeklyWorkDaysMax(value));
                  }} /></label>
                  <label><span>1日最低勤務時間（時間）</span><input required type="number" inputMode="decimal" min="0.25" max="8" step="0.25" value={dailyWorkHoursMin} onChange={(event) => {
                    const value = event.currentTarget.value;
                    markConditionChanged(() => setDailyWorkHoursMin(value));
                  }} /></label>
                  <label><span>1日最大勤務時間（時間）</span><input required type="number" inputMode="decimal" min="0.25" max="8" step="0.25" value={dailyWorkHoursMax} onChange={(event) => {
                    const value = event.currentTarget.value;
                    markConditionChanged(() => setDailyWorkHoursMax(value));
                  }} /></label>
                </div>
              </div> : null}
              <div className="admin-pattern-grid">
                {availability.map((entry) => (
                  <div key={entry.weekday} className="admin-pattern-row admin-availability-day">
                    <div className="admin-availability-day-heading">
                      <strong>{weekdays.find((weekday) => weekday.value === entry.weekday)?.label}</strong>
                      <label className="parent-check-row"><input type="checkbox" checked={entry.available} onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        markConditionChanged(() => updateAvailability(entry.weekday, { available: checked }));
                      }} /><span>この曜日は勤務可能</span></label>
                    </div>
                    {entry.available ? <>
                      <div className="admin-availability-candidates">
                        {entry.candidates.map((candidate, candidateIndex) => (
                          <div className="admin-availability-candidate" key={`${entry.weekday}-${candidateIndex}`}>
                            <div className="admin-availability-candidate-heading">
                              <strong>勤務可能時間候補 {candidateIndex + 1}</strong>
                              {entry.candidates.length > 1 ? <button type="button" className="secondary" onClick={() => {
                                markConditionChanged(() => removeAvailabilityCandidate(entry.weekday, candidateIndex));
                              }}>候補を削除</button> : null}
                            </div>
                            <label><span>開始時刻</span><select value={candidate.startTime} onChange={(event) => {
                              const value = event.currentTarget.value;
                              markConditionChanged(() => updateAvailabilityCandidate(entry.weekday, candidateIndex, { startTime: value }));
                            }}>{staffTimeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                            <label><span>終了時刻</span><select value={candidate.endTime} onChange={(event) => {
                              const value = event.currentTarget.value;
                              markConditionChanged(() => updateAvailabilityCandidate(entry.weekday, candidateIndex, { endTime: value }));
                            }}>{staffTimeOptions.map((time) => <option key={time} value={time}>{time}</option>)}</select></label>
                            <label><span>適用する週</span><select value={candidate.weekOrdinals === null ? "all" : "selected"} onChange={(event) => {
                              const value = event.currentTarget.value;
                              markConditionChanged(() => updateAvailabilityCandidate(entry.weekday, candidateIndex, {
                                weekOrdinals: value === "all" ? null : [2, 4],
                              }));
                            }}><option value="all">毎週</option><option value="selected">指定した週だけ</option></select></label>
                            {candidate.weekOrdinals !== null ? <fieldset className="admin-availability-weeks">
                              <legend>有効にする週</legend>
                              {[1, 2, 3, 4, 5].map((ordinal) => <label className="parent-check-row" key={ordinal}><input type="checkbox" checked={candidate.weekOrdinals?.includes(ordinal) ?? false} onChange={(event) => {
                                const checked = event.currentTarget.checked;
                                markConditionChanged(() => toggleCandidateWeek(entry.weekday, candidateIndex, ordinal, checked));
                              }} /><span>第{ordinal}</span></label>)}
                            </fieldset> : null}
                          </div>
                        ))}
                      </div>
                      <button type="button" className="secondary admin-availability-add" onClick={() => {
                        markConditionChanged(() => addAvailabilityCandidate(entry.weekday));
                      }}>＋ 勤務可能時間候補を追加</button>
                    </> : <p className="admin-schedule-note">勤務不可</p>}
                  </div>
                ))}
              </div>
              <p className={`admin-save-state ${busy === "condition" ? "saving" : conditionDirty ? "unsaved" : message === "勤務条件を保存しました。" ? "saved" : "idle"}`} role="status">
                {busy === "condition" ? "勤務条件を保存中..." : conditionDirty ? "勤務条件は未保存です。" : message === "勤務条件を保存しました。" ? "勤務条件の保存が完了しました。" : "勤務条件に未保存の変更はありません。"}
              </p>
              <button type="button" className="primary" disabled={busy !== "" || !employmentType.trim() || !partTimeConditionsComplete} onClick={() => {
                if (!window.confirm(`${selectedStaff.name}の${conditionFrom}からの勤務条件を保存しますか？`)) return;
                void run("condition", async () => {
                  const result = await api<{ management: Management }>(`/api/admin/staff/${encodeURIComponent(selectedStaff.id)}/work-conditions`, {
                    method: "POST",
                    body: {
                      validFrom: conditionFrom,
                      validTo: conditionTo,
                      employmentType,
                      monthlyMinutesLimit: null,
                      maxConsecutiveDays: null,
                      weeklyMinutesLimit: employmentType === "非常勤" ? hoursToMinutes(weeklyHoursLimit) : null,
                      weeklyMinutesLimitType: employmentType === "非常勤" ? weeklyHoursLimitType : null,
                      preferredWeeklyWorkDaysMin: employmentType === "非常勤" ? Number(preferredWeeklyWorkDaysMin) : null,
                      weeklyWorkDaysMax: employmentType === "非常勤" ? Number(weeklyWorkDaysMax) : null,
                      dailyWorkMinutesMin: employmentType === "非常勤" ? hoursToMinutes(dailyWorkHoursMin) : null,
                      dailyWorkMinutesMax: employmentType === "非常勤" ? hoursToMinutes(dailyWorkHoursMax) : null,
                      availability,
                    },
                  });
                  acceptManagement(result.management, selectedStaff.id);
                  setConditionDirty(false);
                  setMessage("勤務条件を保存しました。");
                });
              }}><AdminIcon name="save" />{busy === "condition" ? "保存中..." : "勤務条件を保存"}</button>
            </div>

            <div className="admin-staff-subsection">
              <h3><AdminIcon name="history" />勤務条件履歴</h3>
              {selectedStaff.conditions.length ? <div className="admin-pattern-history">{selectedStaff.conditions.map((condition) => (
                <details key={condition.id}>
                  <summary><strong>{condition.employmentType}</strong><span>{condition.validFrom} - {condition.validTo ?? "期限なし"}</span></summary>
                  <p>{formatDateTime(condition.createdAt)} / {condition.createdByAdministratorName}</p>
                  {condition.employmentType === "非常勤" ? <p>週 {formatContractHours(condition.weeklyMinutesLimit)}{condition.weeklyMinutesLimitType === "exclusive" ? "未満" : "以内"} / 週 {condition.preferredWeeklyWorkDaysMin ?? "-"}～{condition.weeklyWorkDaysMax ?? "-"}日 / 1日 {formatContractHours(condition.dailyWorkMinutesMin)}～{formatContractHours(condition.dailyWorkMinutesMax)}</p> : null}
                  {condition.availability.map((entry) => <div key={entry.weekday}><span>{weekdays.find((weekday) => weekday.value === entry.weekday)?.label}</span><strong>{entry.available
                    ? entry.candidates.map((candidate, index) => `候補${index + 1} ${candidate.startTime} - ${candidate.endTime}（${candidateWeekLabel(candidate)}）`).join(" / ")
                    : "勤務不可"}</strong></div>)}
                </details>
              ))}</div> : <p className="admin-schedule-note">勤務条件は登録されていません。</p>}
            </div>
          </> : null}
        </div>
      </div>
    </section>
  );
}
