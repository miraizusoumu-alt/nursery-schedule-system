"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { AdminIcon } from "@/components/ui/AdminIcon";

type HeadcountChange = {
  time: string;
  before: number;
  after: number;
  delta: number;
  byAgeGroup: Record<"0歳児" | "1歳児" | "2歳児", number>;
  childNames: string[];
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

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

function monthLabel(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function dateLabel(day: HeadcountDay) {
  return `${day.dayOfMonth}日（${weekdayLabels[day.weekday]}）`;
}

export function AdminMonthlyHeadcount({ submissionPeriodId }: { submissionPeriodId: string }) {
  const [data, setData] = useState<Headcount | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!submissionPeriodId) return;
    let active = true;
    const query = new URLSearchParams({ submissionPeriodId });
    void api<{ headcount: Headcount }>(`/api/admin/schedules/headcount?${query}`)
      .then((result) => {
        if (!active) return;
        setData(result.headcount);
        setSelectedDate(result.headcount.days[0]?.date ?? "");
        setError("");
      })
      .catch((caught) => {
        if (!active) return;
        setData(null);
        setError(caught instanceof Error ? caught.message : "月間人数を読み込めませんでした。");
      });
    return () => { active = false; };
  }, [submissionPeriodId]);

  if (error) return <p className="auth-message error" role="alert">{error}</p>;
  if (!data) return <p className="auth-message info">月間人数を集計中...</p>;

  const selectedDay = data.days.find((day) => day.date === selectedDate) ?? data.days[0] ?? null;

  return (
    <section className="auth-section admin-headcount-section">
      <div className="auth-section-heading">
        <div><span>{monthLabel(data.period.targetMonth)}</span><h2><AdminIcon name="report" />月間の園児人数</h2></div>
      </div>
      <p className="admin-schedule-note">人数が変わる時刻だけを表示しています。内部集計は7:00から20:00まで5分単位です。</p>

      <div className="admin-headcount-scroll-note">表は横にスクロールして日付を確認できます。</div>
      <div className="admin-headcount-table-wrap" tabIndex={0} aria-label="月間の園児人数表">
        <table className="admin-headcount-table">
          <thead><tr><th>時刻</th>{data.dates.map((date) => <th key={date.date} className={date.isClosure ? "closed" : date.isSaturday ? "saturday" : ""}>{date.dayOfMonth}<span>（{weekdayLabels[date.weekday]}）</span></th>)}</tr></thead>
          <tbody>{data.rows.length ? data.rows.map((row) => <tr key={row.time}><th>{row.time}</th>{row.counts.map((count, index) => <td key={data.dates[index].date} className={data.dates[index].isClosure ? "closed" : data.dates[index].isSaturday ? "saturday" : ""}>{count}</td>)}</tr>) : <tr><td colSpan={data.dates.length + 1}>利用予定はありません。</td></tr>}</tbody>
          <tfoot><tr><th>最大人数</th>{data.days.map((day) => <td key={day.date} className={day.isClosure ? "closed" : day.isSaturday ? "saturday" : ""}>{day.maximum}</td>)}</tr></tfoot>
        </table>
      </div>

      <div className="admin-headcount-detail">
        <div className="auth-section-heading">
          <div><span>日付を選ぶと内訳を確認できます</span><h3>日別の人数変化</h3></div>
          <label><span>確認する日</span><select value={selectedDay?.date ?? ""} onChange={(event) => setSelectedDate(event.currentTarget.value)}>{data.days.map((day) => <option key={day.date} value={day.date}>{dateLabel(day)}{day.isClosure ? ` / ${day.closureName ?? "休園"}` : ""}</option>)}</select></label>
        </div>
        {selectedDay?.isClosure ? <p className="admin-headcount-empty">{selectedDay.closureName ?? "休園日"}のため、在園予定人数は0人です。</p> : selectedDay?.changes.length ? <div className="admin-headcount-change-list">{selectedDay.changes.map((change) => <article key={change.time}>
          <div className="admin-headcount-change-main"><strong>{change.time}</strong><span>{change.before}人 → {change.after}人</span><em className={change.delta >= 0 ? "increase" : "decrease"}>{change.delta >= 0 ? "+" : ""}{change.delta}人</em></div>
          <p>0歳児 {change.byAgeGroup["0歳児"]}人｜1歳児 {change.byAgeGroup["1歳児"]}人｜2歳児 {change.byAgeGroup["2歳児"]}人｜合計 {change.after}人</p>
          <p>{change.childNames.length ? change.childNames.join("、") : "在園予定なし"}</p>
        </article>)}</div> : <p className="admin-headcount-empty">利用予定なし</p>}
      </div>
    </section>
  );
}
