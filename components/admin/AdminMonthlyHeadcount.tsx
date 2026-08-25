"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { AdminIcon } from "@/components/ui/AdminIcon";

type HeadcountChange = {
  date: string;
  time: string;
  before: number;
  after: number;
  delta: number;
  byAgeGroup: Record<"0歳児" | "1歳児" | "2歳児", number>;
  childNames: string[];
  zeroYearOldCount: number;
  oneYearOldCount: number;
  twoYearOldCount: number;
  totalChildren: number;
  ageBasedRequirement: number;
  totalChildrenRuleRequirement: number;
  minimumStaffRequirement: number;
  requiredChildcareWorkers: number;
  requiredLicensedNurseryTeachers: number;
  appliedRules: Array<"age_based" | "total_children_3_to_1" | "minimum_staff">;
  calculationBreakdown: Record<string, unknown>;
};

type HeadcountDay = {
  date: string;
  dayOfMonth: number;
  weekday: number;
  isSaturday: boolean;
  isSunday: boolean;
  isClosure: boolean;
  closureName: string | null;
  maximum: number;
  maximumRequiredChildcareWorkers: number;
  maximumRequiredLicensedNurseryTeachers: number;
  status: "closed" | "scheduled" | "no_schedule";
  changes: HeadcountChange[];
};

type Headcount = {
  period: { id: string; targetMonth: string; status: string };
  ageGroups: ["0歳児", "1歳児", "2歳児"];
  dates: Array<Pick<HeadcountDay, "date" | "dayOfMonth" | "weekday" | "isSaturday" | "isSunday" | "isClosure" | "closureName">>;
  rows: Array<{ time: string; counts: number[] }>;
  days: HeadcountDay[];
};

type EligibleStaff = {
  staffId: string;
  staffName: string;
  employmentType: string | null;
  assignedRoles: string[];
  validQualifications: string[];
  licensedEligible: boolean;
};

type StaffingSlot = {
  date: string;
  startTime: string;
  endTime: string;
  requiredChildcareWorkers: number;
  requiredLicensedNurseryTeachers: number;
  eligibleChildcareWorkerCount: number;
  eligibleLicensedNurseryTeacherCount: number;
  childcareWorkerShortage: number;
  licensedNurseryTeacherShortage: number;
  eligibleStaff: EligibleStaff[];
  eligibleLicensedStaff: EligibleStaff[];
};

type StaffingCandidates = {
  period: { id: string; targetMonth: string; status: string };
  classificationCapabilities: {
    childcareEligibilityConfigured: boolean;
    nurseryTeacherQualificationsConfigured: boolean;
  };
  classificationLimitations: string[];
  slots: StaffingSlot[];
};

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

function monthLabel(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function dateLabel(day: HeadcountDay) {
  return `${day.dayOfMonth}日（${weekdayLabels[day.weekday]}）`;
}

const appliedRuleLabels = {
  age_based: "年齢別基準",
  total_children_3_to_1: "園独自3対1",
  minimum_staff: "最低2名",
};

const roleLabels: Record<string, string> = {
  nursery_teacher_role: "保育士",
  principal: "園長",
  manager: "マネージャー",
  meal_service: "配膳",
  other: "その他",
};

const qualificationLabels: Record<string, string> = {
  licensed_nursery_teacher: "保育士資格",
  childcare_support_worker_local_childcare: "子育て支援員研修",
};

function appliedRulesLabel(rules: HeadcountChange["appliedRules"]) {
  return rules.map((rule) => appliedRuleLabels[rule]).join("・");
}

export function AdminMonthlyHeadcount({ submissionPeriodId }: { submissionPeriodId: string }) {
  const [data, setData] = useState<Headcount | null>(null);
  const [staffing, setStaffing] = useState<StaffingCandidates | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!submissionPeriodId) return;
    let active = true;
    const query = new URLSearchParams({ submissionPeriodId });
    void Promise.all([
      api<{ headcount: Headcount }>(`/api/admin/schedules/headcount?${query}`),
      api<{ staffing: StaffingCandidates }>(`/api/admin/schedules/staffing-candidates?${query}`),
    ])
      .then(([headcountResult, staffingResult]) => {
        if (!active) return;
        setData(headcountResult.headcount);
        setStaffing(staffingResult.staffing);
        setSelectedDate(headcountResult.headcount.days[0]?.date ?? "");
        setError("");
      })
      .catch((caught) => {
        if (!active) return;
        setData(null);
        setStaffing(null);
        setError(caught instanceof Error ? caught.message : "月間人数を読み込めませんでした。");
      });
    return () => { active = false; };
  }, [submissionPeriodId]);

  if (error) return <p className="auth-message error" role="alert">{error}</p>;
  if (!data || !staffing) return <p className="auth-message info">月間人数と職員候補を集計中...</p>;

  const selectedDay = data.days.find((day) => day.date === selectedDate) ?? data.days[0] ?? null;
  const selectedStaffingSlots = staffing.slots.filter((slot) => (
    slot.date === selectedDay?.date
    && (slot.requiredChildcareWorkers > 0 || slot.childcareWorkerShortage > 0 || slot.licensedNurseryTeacherShortage > 0)
  ));

  return (
    <section className="auth-section admin-headcount-section">
      <div className="auth-section-heading">
        <div><span>{monthLabel(data.period.targetMonth)}</span><h2><AdminIcon name="report" />月間の園児人数</h2></div>
      </div>
      <p className="admin-schedule-note">年齢別の園児人数または必要人数が変わる時刻だけを表示しています。内部集計は7:00から20:00まで5分単位です。</p>
      <div className="admin-headcount-guidance">
        <p><strong>必要保育従事者</strong>：その時間帯に保育配置として必要な職員総数</p>
        <p><strong>うち保育士資格者</strong>：その中で最低限必要な保育士資格者数</p>
        <p>園独自基準として、園児3人につき職員1人以上を確保します。園児がいる時間帯は最低2人です。</p>
      </div>

      <div className="admin-headcount-scroll-note">表は横にスクロールして日付を確認できます。</div>
      <div className="admin-headcount-table-wrap" tabIndex={0} aria-label="月間の園児人数表">
        <table className="admin-headcount-table">
          <thead><tr><th>時刻</th>{data.dates.map((date) => <th key={date.date} className={date.isClosure ? "closed" : date.isSaturday ? "saturday" : ""}>{date.dayOfMonth}<span>（{weekdayLabels[date.weekday]}）</span></th>)}</tr></thead>
          <tbody>{data.rows.length ? data.rows.map((row) => <tr key={row.time}><th>{row.time}</th>{row.counts.map((count, index) => <td key={data.dates[index].date} className={data.dates[index].isClosure ? "closed" : data.dates[index].isSaturday ? "saturday" : ""}>{count}</td>)}</tr>) : <tr><td colSpan={data.dates.length + 1}>利用予定はありません。</td></tr>}</tbody>
          <tfoot>
            <tr><th>最大人数</th>{data.days.map((day) => <td key={day.date} className={day.isClosure ? "closed" : day.isSaturday ? "saturday" : ""}>{day.maximum}</td>)}</tr>
            <tr><th>必要職員</th>{data.days.map((day) => <td key={day.date} className={day.isClosure ? "closed" : day.isSaturday ? "saturday" : ""}>{day.maximumRequiredChildcareWorkers}</td>)}</tr>
            <tr><th>うち保育士</th>{data.days.map((day) => <td key={day.date} className={day.isClosure ? "closed" : day.isSaturday ? "saturday" : ""}>{day.maximumRequiredLicensedNurseryTeachers}</td>)}</tr>
          </tfoot>
        </table>
      </div>

      <div className="admin-headcount-detail">
        <div className="auth-section-heading">
          <div><span>日付を選ぶと内訳を確認できます</span><h3>日別の人数変化</h3></div>
          <label><span>確認する日</span><select value={selectedDay?.date ?? ""} onChange={(event) => setSelectedDate(event.currentTarget.value)}>{data.days.map((day) => <option key={day.date} value={day.date}>{dateLabel(day)}{day.isClosure ? ` / ${day.closureName ?? "休園"}` : ""}</option>)}</select></label>
        </div>
        {selectedDay?.isClosure ? <p className="admin-headcount-empty">{selectedDay.closureName ?? "休園日"}のため、園児人数・必要保育従事者・保育士資格者はいずれも0人です。</p> : selectedDay?.changes.length ? <div className="admin-headcount-change-list">{selectedDay.changes.map((change) => <article key={change.time}>
          <div className="admin-headcount-change-main"><strong>{change.time}</strong><span>{change.before}人 → {change.after}人</span><em className={change.delta >= 0 ? "increase" : "decrease"}>{change.delta >= 0 ? "+" : ""}{change.delta}人</em></div>
          <p>0歳児 {change.zeroYearOldCount}人｜1歳児 {change.oneYearOldCount}人｜2歳児 {change.twoYearOldCount}人｜合計 {change.totalChildren}人</p>
          <p className="admin-headcount-staffing"><strong>必要保育従事者 {change.requiredChildcareWorkers}人</strong><span>うち保育士資格者 {change.requiredLicensedNurseryTeachers}人</span></p>
          <p>判定：{appliedRulesLabel(change.appliedRules)}（年齢別 {change.ageBasedRequirement}人／3対1 {change.totalChildrenRuleRequirement}人／最低配置 {change.minimumStaffRequirement}人）</p>
          <p>{change.childNames.length ? change.childNames.join("、") : "在園予定なし"}</p>
        </article>)}</div> : <p className="admin-headcount-empty">利用予定なし</p>}
      </div>

      <div className="admin-staffing-candidate-section">
        <div className="auth-section-heading"><div><span>{selectedDay ? dateLabel(selectedDay) : "日付未選択"}</span><h3>15分単位の職員候補</h3></div></div>
        <p className="admin-schedule-note">勤務条件と対象日に有効な資格・研修から候補を判定します。ここでは実際の配置職員はまだ選びません。</p>
        {selectedStaffingSlots.length ? <div className="admin-staffing-slot-list">{selectedStaffingSlots.map((slot) => {
          const hasShortage = slot.childcareWorkerShortage > 0 || slot.licensedNurseryTeacherShortage > 0;
          return <article key={`${slot.date}:${slot.startTime}`} className={hasShortage ? "shortage" : "ready"}>
            <div className="admin-staffing-slot-summary"><strong>{slot.startTime} - {slot.endTime}</strong><span>必要 {slot.requiredChildcareWorkers}人 / 候補 {slot.eligibleChildcareWorkerCount}人</span><span>保育士資格者 {slot.requiredLicensedNurseryTeachers}人必要 / 候補 {slot.eligibleLicensedNurseryTeacherCount}人</span></div>
            {slot.childcareWorkerShortage > 0 ? <p className="auth-message error">保育従事者が{slot.childcareWorkerShortage}人不足しています。</p> : null}
            {slot.licensedNurseryTeacherShortage > 0 ? <p className="auth-message error">保育士資格者が{slot.licensedNurseryTeacherShortage}人不足しています。</p> : null}
            <details><summary>候補を確認（{slot.eligibleStaff.length}名）</summary>{slot.eligibleStaff.length ? <ul>{slot.eligibleStaff.map((staff) => <li key={staff.staffId}><strong>{staff.staffName}</strong><span>{staff.employmentType ?? "雇用区分未設定"}</span><span>担当：{staff.assignedRoles.length ? staff.assignedRoles.map((role) => roleLabels[role] ?? role).join("、") : "未登録"}</span><span>資格・研修：{staff.validQualifications.map((qualification) => qualificationLabels[qualification] ?? qualification).join("、")}</span></li>)}</ul> : <p>この時間帯の候補職員はいません。</p>}</details>
          </article>;
        })}</div> : <p className="admin-headcount-empty">この日の利用予定はなく、必要な保育配置は0人です。</p>}
      </div>
    </section>
  );
}
