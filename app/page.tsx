"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CURRENT_CHILD_ID,
  CURRENT_STAFF_ID,
  adminMenuItems,
  createInitialStore,
  ensureMonthRecords,
  hasPermission,
} from "@/lib/domain/prototype";
import { aggregateChildUsage } from "@/lib/domain/placement";
import {
  ageGroups,
  addHistory,
  applyClosedDatesToMonth,
  canStaffEditLeaves,
  clonePattern,
  createInitialShift,
  createLeavePeriod,
  createScheduleRecord,
  formatDateTime,
  formatJapaneseDate,
  formatMonthLabel,
  getBasicSummary,
  getLeavesForMonth,
  getMonthDates,
  getScheduleStats,
  getTargetMonth,
  isClosedDate,
  leaveKey,
  makeMonthPlans,
  pad,
  scheduleKey,
  shiftKey,
  shiftMonth,
  shiftStatusLabel,
  statusClass,
  statusLabel,
  timeOptions,
  timeToMinutes,
  toDateKey,
  weekdays,
} from "@/lib/domain/schedule";
import {
  generateShiftForMonth,
  overlaps,
  staffAvailableForDate,
  staffHasLeave,
} from "@/lib/domain/shift";
import type {
  AdminState,
  DayPlan,
  EmploymentType,
  LeavePeriod,
  LeaveRequest,
  PlacementRule,
  PrototypeStore,
  ScheduleChangeHistoryEntry,
  ScheduleRecord,
  ShiftAssignment,
  ShiftRecord,
  ShiftStatus,
  StaffDayAvailability,
  StaffProfile,
  StaffRole,
  UsagePattern,
  WeekdayKey,
} from "@/lib/domain/types";
import { loadPrototypeStore, savePrototypeStore } from "@/lib/storage/local-storage";
import { featureFlags, isWorkforceAdminMenu, isWorkforceHistoryTarget } from "@/lib/features";

type ParentViewKey = "top" | "bulk" | "daily" | "confirm";
type ModeKey = "parent" | "staff" | "admin";
type StaffViewKey = "leave" | "calendar" | "shift";

export default function Home() {
  const [store, setStore] = useState<PrototypeStore>(() => createInitialStore());
  const [loaded, setLoaded] = useState(false);
  const lastPersistedStore = useRef<PrototypeStore | null>(null);
  const [mode, setMode] = useState<ModeKey>("parent");
  const [parentView, setParentView] = useState<ParentViewKey>("top");
  const [staffView, setStaffView] = useState<StaffViewKey>("leave");
  const [notice, setNotice] = useState("試作版です。架空データだけを使用し、入力内容はこのブラウザに保存されます。");

  useEffect(() => {
    let active = true;
    const result = loadPrototypeStore(window.localStorage);
    queueMicrotask(() => {
      if (!active) return;
      lastPersistedStore.current = result.store;
      setStore(result.store);
      if (result.recovered) {
        setNotice("保存データを読み込めなかったため、試作用データで開始しました。");
      }
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (lastPersistedStore.current === store) return;
    savePrototypeStore(window.localStorage, store);
    lastPersistedStore.current = store;
  }, [loaded, store]);

  const targetMonth = getTargetMonth();
  const parentChild = store.children.find((item) => item.id === CURRENT_CHILD_ID) ?? store.children[0];
  const parentClosedDates = useMemo(
    () => store.admin.closedDatesByMonth[targetMonth] ?? [],
    [store.admin.closedDatesByMonth, targetMonth],
  );
  const parentSchedule = useMemo(() => {
    return store.schedules[scheduleKey(parentChild.id, targetMonth)] ?? createScheduleRecord(parentChild, targetMonth, parentClosedDates);
  }, [parentChild, parentClosedDates, store.schedules, targetMonth]);
  const parentDays = useMemo(() => Object.values(parentSchedule.days).sort((a, b) => a.date.localeCompare(b.date)), [parentSchedule.days]);
  const parentStats = getScheduleStats(parentSchedule);
  const canParentEdit = new Date() <= new Date(`${parentSchedule.deadline}T23:59:59`);

  const selectedMonth = store.admin.selectedMonth;
  const selectedMonthDates = getMonthDates(selectedMonth);
  const adminClosedDates = store.admin.closedDatesByMonth[selectedMonth] ?? [];
  const currentStaff = store.staff.find((staff) => staff.id === CURRENT_STAFF_ID) ?? store.staff[0];
  const selectedStaff = store.staff.find((staff) => staff.id === store.admin.selectedStaffId) ?? store.staff[0];
  const leavePeriod = store.leavePeriods[selectedMonth] ?? createLeavePeriod(selectedMonth);
  const targetLeavePeriod = store.leavePeriods[targetMonth] ?? createLeavePeriod(targetMonth);
  const canCurrentStaffEditLeaves = canStaffEditLeaves(targetLeavePeriod);
  const monthLeaves = getLeavesForMonth(store.leaveRequests, selectedMonth);
  const targetMonthLeaves = getLeavesForMonth(store.leaveRequests, targetMonth);
  const shift = store.shifts[shiftKey(selectedMonth)] ?? createInitialShift(selectedMonth);
  const targetShift = store.shifts[shiftKey(targetMonth)] ?? createInitialShift(targetMonth);
  const childUsageSlots = useMemo(() => aggregateChildUsage(selectedMonth, store.schedules, store.children, store.admin.slotMinutes), [selectedMonth, store.admin.slotMinutes, store.children, store.schedules]);
  const childSlotsForDate = childUsageSlots.filter((slot) => slot.date === store.admin.childCountDate);
  const filteredAdminRows = useMemo(() => {
    const query = store.admin.filterText.trim().toLowerCase();
    return store.children
      .map((child) => {
        const schedule = store.schedules[scheduleKey(child.id, selectedMonth)];
        const status = schedule?.status ?? "unsubmitted";
        return { child, schedule, status };
      })
      .filter(({ child, status }) => {
        const statusOk = store.admin.filterStatus === "all" || status === store.admin.filterStatus;
        const haystack = `${child.name} ${child.kana} ${child.className}`.toLowerCase();
        return statusOk && (!query || haystack.includes(query));
      });
  }, [selectedMonth, store.admin.filterStatus, store.admin.filterText, store.children, store.schedules]);
  const monthOptions = useMemo(() => {
    const base = getTargetMonth();
    const values = [-3, -2, -1, 0, 1, 2].map((offset) => shiftMonth(base, offset));
    const stored = Object.values(store.schedules).map((schedule) => schedule.targetMonth);
    return Array.from(new Set([...values, ...stored, ...Object.keys(store.leavePeriods)])).sort();
  }, [store.leavePeriods, store.schedules]);
  const selectedMonthIsPast = selectedMonth < targetMonth;
  const staffPublicShift = targetShift.status === "published" ? targetShift.assignments.filter((assignment) => assignment.staffId === currentStaff.id) : [];
  const visibleAdminMenuItems = featureFlags.workforcePrototype
    ? adminMenuItems
    : adminMenuItems.filter((item) => !isWorkforceAdminMenu(item.key));
  const activeAdminMenu =
    !featureFlags.workforcePrototype && isWorkforceAdminMenu(store.admin.menu) ? "children" : store.admin.menu;
  const visibleHistories = featureFlags.workforcePrototype
    ? store.histories
    : store.histories.filter((entry) => !isWorkforceHistoryTarget(entry.target));

  function upsertSchedule(nextSchedule: ScheduleRecord, nextNotice?: string) {
    setStore((current) => ({
      ...current,
      schedules: {
        ...current.schedules,
        [nextSchedule.id]: nextSchedule,
      },
    }));
    if (nextNotice) setNotice(nextNotice);
  }

  function markParentEdited(schedule: ScheduleRecord) {
    return {
      ...schedule,
      status: schedule.status === "submitted" ? "draft" : schedule.status,
      updatedAt: new Date().toISOString(),
    };
  }

  function rebuildFromBasePattern() {
    if (!canParentEdit || !hasPermission("parent", "parent:own-schedule")) return;
    const ok = window.confirm("管理者が登録した基本利用パターンで、対象月の予定を作成します。現在の対象月の変更内容は上書きされます。よろしいですか？");
    if (!ok) return;
    const nextSchedule: ScheduleRecord = {
      ...parentSchedule,
      basePatternSnapshot: clonePattern(parentChild.basePattern),
      weekdayOverrides: {},
      days: makeMonthPlans(targetMonth, parentChild.basePattern, parentClosedDates),
      status: "draft",
      updatedAt: new Date().toISOString(),
    };
    upsertSchedule(nextSchedule, "基本利用パターンから対象月の予定を作成しました。基本利用パターン自体は変更していません。");
    setParentView("daily");
  }

  function updateWeekdayOverride(weekdayKey: WeekdayKey, patch: Partial<UsagePattern>) {
    if (!canParentEdit) return;
    const currentPattern = parentSchedule.weekdayOverrides[weekdayKey] ?? parentChild.basePattern[weekdayKey];
    const weekdayOverrides = { ...parentSchedule.weekdayOverrides, [weekdayKey]: { ...currentPattern, ...patch } };
    const nextSchedule = markParentEdited({
      ...parentSchedule,
      weekdayOverrides,
      days: makeMonthPlans(targetMonth, parentChild.basePattern, parentClosedDates, weekdayOverrides, parentSchedule.days),
    });
    upsertSchedule(nextSchedule, `${weekdays.find((weekday) => weekday.key === weekdayKey)?.label ?? "曜日"}の予定を対象月へ反映しました。`);
  }

  function resetWeekdayOverride(weekdayKey: WeekdayKey) {
    if (!canParentEdit) return;
    const weekdayOverrides = { ...parentSchedule.weekdayOverrides };
    delete weekdayOverrides[weekdayKey];
    const nextSchedule = markParentEdited({
      ...parentSchedule,
      weekdayOverrides,
      days: makeMonthPlans(targetMonth, parentChild.basePattern, parentClosedDates, weekdayOverrides, parentSchedule.days),
    });
    upsertSchedule(nextSchedule, "選択した曜日を基本利用パターンに戻しました。");
  }

  function updateDay(dateKey: string, patch: Partial<DayPlan>) {
    if (!canParentEdit || isClosedDate(dateKey, parentClosedDates)) return;
    const current = parentSchedule.days[dateKey];
    const nextSchedule = markParentEdited({
      ...parentSchedule,
      days: {
        ...parentSchedule.days,
        [dateKey]: {
          ...current,
          ...patch,
          date: dateKey,
          source: "daily",
          changed: true,
          closed: false,
        },
      },
    });
    upsertSchedule(nextSchedule, `${formatJapaneseDate(dateKey)}の予定を変更しました。`);
  }

  function resetDay(dateKey: string) {
    if (!canParentEdit || isClosedDate(dateKey, parentClosedDates)) return;
    const rebuilt = makeMonthPlans(targetMonth, parentChild.basePattern, parentClosedDates, parentSchedule.weekdayOverrides);
    const nextSchedule = markParentEdited({
      ...parentSchedule,
      days: { ...parentSchedule.days, [dateKey]: rebuilt[dateKey] },
    });
    upsertSchedule(nextSchedule, `${formatJapaneseDate(dateKey)}を曜日パターンに戻しました。`);
  }

  function submitSchedule() {
    if (!canParentEdit) return;
    const ok = window.confirm("この内容で提出します。提出期限までは同じURLから再編集できます。よろしいですか？");
    if (!ok) return;
    const now = new Date().toISOString();
    upsertSchedule({ ...parentSchedule, status: "submitted", submittedAt: now, updatedAt: now }, "提出しました。提出期限までは再編集できます。");
    setParentView("top");
  }

  function setAdminMonth(monthKey: string) {
    setStore((current) => ensureMonthRecords(current, monthKey));
    setNotice(`${formatMonthLabel(monthKey)}の管理者確認に切り替えました。`);
  }

  function updateAdmin(patch: Partial<AdminState>) {
    setStore((current) => ({ ...current, admin: { ...current.admin, ...patch } }));
  }

  function addClosedDate() {
    const dateKey = store.admin.correctionDate;
    if (!dateKey.startsWith(selectedMonth) || isClosedDate(dateKey, adminClosedDates)) return;
    const nextClosedDates = Array.from(new Set([...adminClosedDates, dateKey])).sort();
    setStore((current) => ({
      ...current,
      schedules: applyClosedDatesToMonth(current, selectedMonth, nextClosedDates),
      admin: {
        ...current.admin,
        closedDatesByMonth: { ...current.admin.closedDatesByMonth, [selectedMonth]: nextClosedDates },
      },
    }));
    setNotice(`${formatJapaneseDate(dateKey)}を休園日に設定しました。`);
  }

  function removeClosedDate(dateKey: string) {
    const nextClosedDates = adminClosedDates.filter((item) => item !== dateKey);
    setStore((current) => ({
      ...current,
      schedules: applyClosedDatesToMonth(current, selectedMonth, nextClosedDates),
      admin: {
        ...current.admin,
        closedDatesByMonth: { ...current.admin.closedDatesByMonth, [selectedMonth]: nextClosedDates },
      },
    }));
    setNotice(`${formatJapaneseDate(dateKey)}の休園日設定を解除しました。`);
  }

  function applyAdminCorrection() {
    const child = store.children.find((item) => item.id === store.admin.correctionChildId) ?? store.children[0];
    if (!child || isClosedDate(store.admin.correctionDate, adminClosedDates) || !store.admin.correctionReason.trim()) return;
    const ok = window.confirm("理由を履歴に残して、管理者としてこの日の予定を修正します。よろしいですか？");
    if (!ok) return;
    const key = scheduleKey(child.id, selectedMonth);
    const currentSchedule = store.schedules[key] ?? createScheduleRecord(child, selectedMonth, adminClosedDates);
    const before = currentSchedule.days[store.admin.correctionDate];
    const after: DayPlan = {
      ...before,
      enabled: store.admin.correctionEnabled,
      start: store.admin.correctionStart,
      end: store.admin.correctionEnd,
      source: "admin",
      changed: true,
      closed: false,
    };
    const now = new Date().toISOString();
    const history: ScheduleChangeHistoryEntry = {
      id: `${key}:${now}`,
      changedAt: now,
      changedBy: "管理者（試作）",
      reason: store.admin.correctionReason.trim(),
      before,
      after,
    };
    setStore((current) => ({
      ...current,
      schedules: {
        ...current.schedules,
        [key]: {
          ...currentSchedule,
          days: { ...currentSchedule.days, [store.admin.correctionDate]: after },
          updatedAt: now,
          changeHistory: [history, ...currentSchedule.changeHistory],
        },
      },
      admin: { ...current.admin, correctionReason: "" },
    }));
    setNotice("管理者修正を保存し、変更履歴に記録しました。");
  }

  function toggleStaffLeave(dateKey: string) {
    if (!hasPermission("staff", "staff:own-leave") || !canCurrentStaffEditLeaves) return;
    const key = leaveKey(currentStaff.id, targetMonth, dateKey);
    const existing = store.leaveRequests[key];
    const sameDateOtherLeaves = targetMonthLeaves.filter((leave) => leave.date === dateKey && leave.staffId !== currentStaff.id);

    if (!existing && sameDateOtherLeaves.length >= 2) {
      const ok = window.confirm("この日はすでに複数の職員が希望休を提出しています。提出はできますが、よろしいですか？");
      if (!ok) return;
    }

    setStore((current) => {
      const leaveRequests = { ...current.leaveRequests };
      const histories = [...current.histories];
      if (existing) {
        delete leaveRequests[key];
        histories.unshift(
          addHistory(current, {
            actorId: currentStaff.id,
            actorType: "staff",
            target: `希望休:${dateKey}`,
            before: existing,
            after: null,
            reason: "職員本人による期限内削除",
            targetMonth,
          }),
        );
      } else {
        const now = new Date().toISOString();
        const leave: LeaveRequest = { id: key, staffId: currentStaff.id, targetMonth, date: dateKey, submittedAt: now, updatedAt: now };
        leaveRequests[key] = leave;
        histories.unshift(
          addHistory(current, {
            actorId: currentStaff.id,
            actorType: "staff",
            target: `希望休:${dateKey}`,
            before: null,
            after: leave,
            reason: "職員本人による期限内登録",
            targetMonth,
          }),
        );
      }
      return { ...current, leaveRequests, histories };
    });
    setNotice(existing ? `${formatJapaneseDate(dateKey)}の希望休を削除しました。` : `${formatJapaneseDate(dateKey)}を希望休として提出しました。`);
  }

  function updateLeavePeriod(patch: Partial<LeavePeriod>) {
    setStore((current) => ({
      ...current,
      leavePeriods: {
        ...current.leavePeriods,
        [selectedMonth]: { ...(current.leavePeriods[selectedMonth] ?? createLeavePeriod(selectedMonth)), ...patch, targetMonth: selectedMonth },
      },
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: `希望休提出期間:${selectedMonth}`,
          before: current.leavePeriods[selectedMonth] ?? null,
          after: { ...(current.leavePeriods[selectedMonth] ?? createLeavePeriod(selectedMonth)), ...patch },
          reason: "管理者による提出期限設定",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
    }));
    setNotice("希望休提出期限を更新しました。");
  }

  function adminToggleLeave() {
    if (!hasPermission("admin", "admin:leave-management")) return;
    const staff = store.staff.find((item) => item.id === store.admin.leaveCorrectionStaffId) ?? store.staff[0];
    const dateKey = store.admin.staffLeaveDate;
    if (!staff || !dateKey.startsWith(selectedMonth)) return;
    const key = leaveKey(staff.id, selectedMonth, dateKey);
    const existing = store.leaveRequests[key];
    setStore((current) => {
      const leaveRequests = { ...current.leaveRequests };
      const now = new Date().toISOString();
      const after: LeaveRequest | null = existing ? null : { id: key, staffId: staff.id, targetMonth: selectedMonth, date: dateKey, submittedAt: now, updatedAt: now };
      if (existing) delete leaveRequests[key];
      if (after) leaveRequests[key] = after;
      return {
        ...current,
        leaveRequests,
        histories: [
          addHistory(current, {
            actorId: "admin",
            actorType: "admin",
            target: `希望休:${staff.id}:${dateKey}`,
            before: existing ?? null,
            after,
            reason: "管理者による希望休変更",
            targetMonth: selectedMonth,
          }),
          ...current.histories,
        ],
      };
    });
    setNotice(existing ? "管理者として希望休を削除しました。" : "管理者として希望休を追加しました。");
  }

  function updateStaffAvailability(staffId: string, weekdayKey: WeekdayKey, patch: Partial<StaffDayAvailability>) {
    setStore((current) => ({
      ...current,
      staff: current.staff.map((staff) =>
        staff.id === staffId
          ? { ...staff, availability: { ...staff.availability, [weekdayKey]: { ...staff.availability[weekdayKey], ...patch } } }
          : staff,
      ),
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: `勤務可能時間:${staffId}:${weekdayKey}`,
          before: current.staff.find((staff) => staff.id === staffId)?.availability[weekdayKey] ?? null,
          after: patch,
          reason: "管理者による勤務可能時間変更",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
    }));
    setNotice("勤務可能時間を更新しました。過去に確定したシフトには反映しません。");
  }

  function updateStaffProfile(staffId: string, patch: Partial<StaffProfile>) {
    setStore((current) => ({
      ...current,
      staff: current.staff.map((staff) => (staff.id === staffId ? { ...staff, ...patch } : staff)),
    }));
  }

  function updatePlacementRule(ruleId: string, patch: Partial<PlacementRule>) {
    setStore((current) => ({
      ...current,
      placementRules: current.placementRules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: `配置基準:${ruleId}`,
          before: current.placementRules.find((rule) => rule.id === ruleId) ?? null,
          after: patch,
          reason: "管理者による配置基準変更",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
    }));
  }

  function runAutoShift(scopeDate?: string) {
    const nextShift = generateShiftForMonth(store, selectedMonth, scopeDate);
    setStore((current) => ({
      ...current,
      shifts: { ...current.shifts, [shiftKey(selectedMonth)]: nextShift },
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: scopeDate ? `シフト自動作成:${scopeDate}` : `シフト自動作成:${selectedMonth}`,
          before: current.shifts[shiftKey(selectedMonth)] ?? null,
          after: nextShift,
          reason: scopeDate ? "一部の日だけ再度自動作成" : "月全体を自動作成",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
    }));
    setNotice(nextShift.issues.length ? "シフト案を作成しました。未解決の問題があります。" : "シフト案を作成しました。");
  }

  function addManualAssignment() {
    const currentShift = store.shifts[shiftKey(selectedMonth)] ?? createInitialShift(selectedMonth);
    if ((currentShift.status === "confirmed" || currentShift.status === "published") && !store.admin.shiftEditReason.trim()) {
      setNotice("確定後または公開後の変更には変更理由が必要です。");
      return;
    }
    const staff = store.staff.find((item) => item.id === store.admin.shiftEditStaffId) ?? store.staff[0];
    if (!staff) return;
    const assignment: ShiftAssignment = {
      id: `manual:${selectedMonth}:${store.admin.shiftEditDate}:${staff.id}:${Date.now()}`,
      staffId: staff.id,
      date: store.admin.shiftEditDate,
      start: store.admin.shiftEditStart,
      end: store.admin.shiftEditEnd,
      breakMinutes: store.admin.shiftEditBreak,
      role: store.admin.shiftEditRole,
      fixed: store.admin.shiftEditFixed,
      source: "manual",
      note: store.admin.shiftEditReason,
    };
    const availability = staffAvailableForDate(staff, assignment.date);
    if (!availability || timeToMinutes(assignment.start) < timeToMinutes(availability.start) || timeToMinutes(assignment.end) > timeToMinutes(availability.end)) {
      setNotice("勤務可能時間外のため、この勤務枠は追加できません。");
      return;
    }
    if (staffHasLeave(staff.id, selectedMonth, assignment.date, store.leaveRequests)) {
      setNotice("希望休の日には勤務を割り当てられません。");
      return;
    }
    if (currentShift.assignments.some((item) => overlaps(item, assignment))) {
      setNotice("同じ職員を同じ時間帯に重複配置できません。");
      return;
    }
    const nextShift: ShiftRecord = {
      ...currentShift,
      status: currentShift.status === "published" ? "published" : "adjusting",
      assignments: [...currentShift.assignments, assignment].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)),
      updatedAt: new Date().toISOString(),
    };
    setStore((current) => ({
      ...current,
      shifts: { ...current.shifts, [shiftKey(selectedMonth)]: nextShift },
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: `シフト勤務枠:${assignment.id}`,
          before: null,
          after: assignment,
          reason: store.admin.shiftEditReason || "管理者による手動追加",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
      admin: { ...current.admin, shiftEditReason: "" },
    }));
    setNotice("シフト勤務枠を追加しました。固定した枠は再計算で上書きされません。");
  }

  function removeAssignment(assignmentId: string) {
    const currentShift = store.shifts[shiftKey(selectedMonth)] ?? createInitialShift(selectedMonth);
    const target = currentShift.assignments.find((assignment) => assignment.id === assignmentId);
    const nextShift = { ...currentShift, status: "adjusting" as ShiftStatus, assignments: currentShift.assignments.filter((assignment) => assignment.id !== assignmentId), updatedAt: new Date().toISOString() };
    setStore((current) => ({
      ...current,
      shifts: { ...current.shifts, [shiftKey(selectedMonth)]: nextShift },
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: `シフト勤務枠:${assignmentId}`,
          before: target ?? null,
          after: null,
          reason: "管理者によるシフト削除",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
    }));
  }

  function toggleAssignmentFixed(assignmentId: string) {
    const currentShift = store.shifts[shiftKey(selectedMonth)] ?? createInitialShift(selectedMonth);
    const nextAssignments = currentShift.assignments.map((assignment) => (assignment.id === assignmentId ? { ...assignment, fixed: !assignment.fixed } : assignment));
    setStore((current) => ({
      ...current,
      shifts: { ...current.shifts, [shiftKey(selectedMonth)]: { ...currentShift, assignments: nextAssignments, updatedAt: new Date().toISOString() } },
    }));
  }

  function setShiftStatus(status: ShiftStatus) {
    const currentShift = store.shifts[shiftKey(selectedMonth)] ?? createInitialShift(selectedMonth);
    const now = new Date().toISOString();
    const nextShift: ShiftRecord = {
      ...currentShift,
      status,
      confirmedAt: status === "confirmed" ? now : status === "draft" ? undefined : currentShift.confirmedAt,
      publishedAt: status === "published" ? now : status === "draft" ? undefined : currentShift.publishedAt,
      updatedAt: now,
    };
    setStore((current) => ({
      ...current,
      shifts: { ...current.shifts, [shiftKey(selectedMonth)]: nextShift },
      histories: [
        addHistory(current, {
          actorId: "admin",
          actorType: "admin",
          target: `シフト状態:${selectedMonth}`,
          before: currentShift.status,
          after: status,
          reason: status === "published" ? "シフト公開" : status === "confirmed" ? "シフト確定" : "確定解除",
          targetMonth: selectedMonth,
        }),
        ...current.histories,
      ],
    }));
    setNotice(`シフト状態を「${shiftStatusLabel(status)}」に変更しました。`);
  }

  function renderPatternGrid(pattern: Record<WeekdayKey, UsagePattern>) {
    return (
      <div className="base-pattern-grid">
        {weekdays.map((weekday) => {
          const setting = pattern[weekday.key];
          return (
            <div className={`pattern-chip ${setting.enabled ? "use" : "off"}`} key={weekday.key}>
              <span>{weekday.label}</span>
              <strong>{setting.enabled ? `${setting.start} - ${setting.end}` : "利用なし"}</strong>
            </div>
          );
        })}
      </div>
    );
  }

  function renderPlanCard(day: DayPlan, editable: boolean) {
    const closed = isClosedDate(day.date, parentClosedDates);
    return (
      <article className={`plan-card ${closed ? "closed" : ""} ${day.changed ? "changed" : ""}`} key={day.date}>
        <div className="plan-date">
          <strong>{formatJapaneseDate(day.date)}</strong>
          <span>{closed ? "休園日は編集できません" : day.changed ? "通常と異なる日" : "通常予定"}</span>
        </div>
        <div className="plan-status-row">
          <span className={`status-badge ${closed ? "closed" : day.enabled ? "use" : "off"}`}>{closed ? "休園日" : day.enabled ? "利用" : "休み"}</span>
          {day.changed && !closed ? <span className="status-badge changed">変更あり</span> : null}
        </div>
        {editable && !closed ? (
          <div className="day-edit-grid">
            <label className="checkbox-row">
              <input type="checkbox" checked={day.enabled} disabled={!canParentEdit} onChange={(event) => updateDay(day.date, { enabled: event.target.checked })} />
              <span>この日は利用する</span>
            </label>
            <label>
              <span>登園予定時刻</span>
              <select disabled={!canParentEdit || !day.enabled} value={day.start} onChange={(event) => updateDay(day.date, { start: event.target.value })}>
                {timeOptions.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>降園予定時刻</span>
              <select disabled={!canParentEdit || !day.enabled} value={day.end} onChange={(event) => updateDay(day.date, { end: event.target.value })}>
                {timeOptions.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={!canParentEdit} onClick={() => resetDay(day.date)}>
              曜日設定に戻す
            </button>
          </div>
        ) : (
          <div className="plan-time">
            <span>登園予定時刻</span>
            <strong>{closed || !day.enabled ? "-" : day.start}</strong>
            <span>降園予定時刻</span>
            <strong>{closed || !day.enabled ? "-" : day.end}</strong>
          </div>
        )}
      </article>
    );
  }

  function renderParentFixedActions() {
    const actions: Record<ParentViewKey, React.ReactNode> = {
      top: (
        <>
          <button type="button" onClick={() => setParentView("bulk")}>
            曜日変更
          </button>
          <button type="button" className="primary" onClick={() => setParentView("confirm")}>
            確認へ
          </button>
        </>
      ),
      bulk: (
        <>
          <button type="button" onClick={() => setParentView("top")}>
            戻る
          </button>
          <button type="button" className="primary" onClick={() => setParentView("daily")}>
            日別修正へ
          </button>
        </>
      ),
      daily: (
        <>
          <button type="button" onClick={() => setParentView("bulk")}>
            戻る
          </button>
          <button type="button" className="primary" onClick={() => setParentView("confirm")}>
            確認へ
          </button>
        </>
      ),
      confirm: (
        <>
          <button type="button" onClick={() => setParentView("daily")}>
            戻る
          </button>
          <button type="button" className="primary" disabled={!canParentEdit} onClick={submitSchedule}>
            提出
          </button>
        </>
      ),
    };
    return <div className="mobile-fixed-actions">{actions[parentView]}</div>;
  }

  function renderParentScreen() {
    return (
      <>
        <nav className="tab-bar" aria-label="保護者画面切り替え">
          {[
            ["top", "トップ"],
            ["bulk", "曜日設定"],
            ["daily", "日別修正"],
            ["confirm", "確認・提出"],
          ].map(([key, label]) => (
            <button key={key} type="button" className={parentView === key ? "active" : ""} onClick={() => setParentView(key as ParentViewKey)}>
              {label}
            </button>
          ))}
        </nav>

        {parentView === "top" ? (
          <section className="screen-grid" aria-label="利用予定トップ画面">
            <section className="summary-card">
              <div className="section-title">
                <span>架空園児</span>
                <h2>{parentChild.name}</h2>
              </div>
              <div className="stats-grid">
                <div>
                  <span>提出状況</span>
                  <strong className={`status-badge ${statusClass(parentSchedule.status)}`}>{statusLabel(parentSchedule.status)}</strong>
                </div>
                <div>
                  <span>利用予定日数</span>
                  <strong>{parentStats.useDays}日</strong>
                </div>
                <div>
                  <span>変更した日</span>
                  <strong>{parentStats.changedDays}日</strong>
                </div>
                <div>
                  <span>最終更新日時</span>
                  <strong>{formatDateTime(parentSchedule.updatedAt)}</strong>
                </div>
              </div>
            </section>

            <section className="base-pattern-card">
              <div className="section-title">
                <span>管理者登録</span>
                <h2>基本利用パターン</h2>
              </div>
              {renderPatternGrid(parentChild.basePattern)}
              <div className="action-row">
                <button type="button" className="primary" disabled={!canParentEdit} onClick={rebuildFromBasePattern}>
                  この内容で対象月の予定を作成する
                </button>
                <button type="button" disabled={!canParentEdit} onClick={() => setParentView("bulk")}>
                  対象月の曜日ごとの予定を変更する
                </button>
              </div>
            </section>

            <section className="calendar-section">
              <div className="section-title">
                <span>{formatMonthLabel(targetMonth)}</span>
                <h2>月間予定</h2>
              </div>
              <div className="calendar-list">{parentDays.map((day) => renderPlanCard(day, false))}</div>
            </section>
          </section>
        ) : null}

        {parentView === "bulk" ? (
          <section className="screen-grid" aria-label="曜日別一括設定画面">
            <section className="weekday-section">
              <div className="section-title">
                <span>対象月だけに反映</span>
                <h2>曜日ごとの利用予定変更</h2>
              </div>
              <div className="weekday-list">
                {weekdays.map((weekday) => {
                  const base = parentChild.basePattern[weekday.key];
                  const current = parentSchedule.weekdayOverrides[weekday.key] ?? base;
                  const overridden = Boolean(parentSchedule.weekdayOverrides[weekday.key]);
                  return (
                    <details className="weekday-card" key={weekday.key} open={weekday.key === "mon" || overridden}>
                      <summary>
                        <strong>{weekday.label}</strong>
                        <span>{current.enabled ? `${current.start} - ${current.end}` : "利用なし"}</span>
                        {overridden ? <em>対象月のみ変更</em> : <em>基本パターン</em>}
                      </summary>
                      <div className="weekday-body">
                        <label className="checkbox-row">
                          <input type="checkbox" checked={current.enabled} disabled={!canParentEdit} onChange={(event) => updateWeekdayOverride(weekday.key, { enabled: event.target.checked })} />
                          <span>この曜日は利用する</span>
                        </label>
                        <div className="time-pair">
                          <label>
                            <span>登園予定時刻</span>
                            <select disabled={!canParentEdit || !current.enabled} value={current.start} onChange={(event) => updateWeekdayOverride(weekday.key, { start: event.target.value })}>
                              {timeOptions.map((time) => (
                                <option key={time} value={time}>
                                  {time}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>降園予定時刻</span>
                            <select disabled={!canParentEdit || !current.enabled} value={current.end} onChange={(event) => updateWeekdayOverride(weekday.key, { end: event.target.value })}>
                              {timeOptions.map((time) => (
                                <option key={time} value={time}>
                                  {time}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <button type="button" disabled={!canParentEdit || !overridden} onClick={() => resetWeekdayOverride(weekday.key)}>
                          基本パターンに戻す
                        </button>
                      </div>
                    </details>
                  );
                })}
              </div>
            </section>
          </section>
        ) : null}

        {parentView === "daily" ? (
          <section className="calendar-section" aria-label="日別修正画面">
            <div className="section-title">
              <span>休み・時刻変更</span>
              <h2>日ごとの修正</h2>
            </div>
            <div className="calendar-list">{parentDays.map((day) => renderPlanCard(day, true))}</div>
          </section>
        ) : null}

        {parentView === "confirm" ? (
          <section className="screen-grid" aria-label="確認・提出画面">
            <section className="summary-card">
              <div className="section-title">
                <span>確認</span>
                <h2>提出前の内容</h2>
              </div>
              <div className="stats-grid">
                <div>
                  <span>提出状況</span>
                  <strong className={`status-badge ${statusClass(parentSchedule.status)}`}>{statusLabel(parentSchedule.status)}</strong>
                </div>
                <div>
                  <span>登園予定時刻</span>
                  <strong>{parentStats.startSummary}</strong>
                </div>
                <div>
                  <span>降園予定時刻</span>
                  <strong>{parentStats.endSummary}</strong>
                </div>
                <div>
                  <span>提出日時</span>
                  <strong>{formatDateTime(parentSchedule.submittedAt)}</strong>
                </div>
              </div>
              {!canParentEdit ? <p className="warning-text">提出期限を過ぎたため、保護者画面からは編集できません。</p> : null}
            </section>
            <section className="calendar-section">
              <div className="section-title">
                <span>{formatMonthLabel(targetMonth)}</span>
                <h2>月間予定一覧</h2>
              </div>
              <div className="calendar-list">{parentDays.map((day) => renderPlanCard(day, false))}</div>
            </section>
          </section>
        ) : null}
        {renderParentFixedActions()}
      </>
    );
  }

  function renderStaffScreen() {
    return (
      <section className="staff-dashboard" aria-label="職員画面">
        <p className="prototype-disclaimer">試作機能・架空データのみ使用。職員・シフト試作は認証DBへ接続していません。</p>
        <nav className="tab-bar staff-tabs">
          {[
            ["leave", "希望休提出"],
            ["calendar", "希望休カレンダー"],
            ["shift", "自分のシフト"],
          ].map(([key, label]) => (
            <button key={key} type="button" className={staffView === key ? "active" : ""} onClick={() => setStaffView(key as StaffViewKey)}>
              {label}
            </button>
          ))}
        </nav>

        <section className="summary-card">
          <div className="section-title">
            <span>職員</span>
            <h2>{currentStaff.name}</h2>
          </div>
          <div className="stats-grid">
            <div>
              <span>対象月</span>
              <strong>{formatMonthLabel(targetMonth)}</strong>
            </div>
            <div>
              <span>提出期限</span>
              <strong>{formatJapaneseDate(targetLeavePeriod.deadline)}</strong>
            </div>
            <div>
              <span>受付状態</span>
              <strong className={`status-badge ${canCurrentStaffEditLeaves ? "use" : "off"}`}>{canCurrentStaffEditLeaves ? "受付中" : "受付終了"}</strong>
            </div>
            <div>
              <span>自分の希望休</span>
              <strong>{targetMonthLeaves.filter((leave) => leave.staffId === currentStaff.id).length}日</strong>
            </div>
          </div>
          <p className="mini-note">{targetLeavePeriod.guidance}</p>
        </section>

        {staffView === "leave" || staffView === "calendar" ? (
          <section className="calendar-section">
            <div className="section-title">
              <span>公開情報は氏名と希望休日のみ</span>
              <h2>{staffView === "leave" ? "希望休を選択" : "職員希望休カレンダー"}</h2>
            </div>
            <div className="staff-calendar-list">
              {getMonthDates(targetMonth).map((date) => {
                const dateKey = toDateKey(date);
                const leaves = targetMonthLeaves.filter((leave) => leave.date === dateKey);
                const ownLeave = leaves.find((leave) => leave.staffId === currentStaff.id);
                return (
                  <article className={`staff-day-card ${ownLeave ? "selected" : ""}`} key={dateKey}>
                    <div className="plan-date">
                      <strong>{formatJapaneseDate(dateKey)}</strong>
                      <span>{leaves.length ? `${leaves.length}名が希望休` : "希望休なし"}</span>
                    </div>
                    <ul className="name-list">
                      {leaves.length ? (
                        leaves.map((leave) => <li key={leave.id}>{store.staff.find((staff) => staff.id === leave.staffId)?.name ?? "職員"}</li>)
                      ) : (
                        <li>登録なし</li>
                      )}
                    </ul>
                    {staffView === "leave" ? (
                      <button type="button" className={ownLeave ? "" : "primary"} disabled={!canCurrentStaffEditLeaves} onClick={() => toggleStaffLeave(dateKey)}>
                        {ownLeave ? "希望休を取り消す" : "希望休にする"}
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {staffView === "shift" ? (
          <section className="calendar-section">
            <div className="section-title">
              <span>{targetShift.status === "published" ? "公開済み" : "未公開"}</span>
              <h2>自分の勤務予定</h2>
            </div>
            {targetShift.status !== "published" ? (
              <p className="warning-text">管理者が公開したシフトだけを表示します。調整中のシフト案は職員画面には表示されません。</p>
            ) : null}
            <div className="calendar-list">
              {staffPublicShift.length ? (
                staffPublicShift.map((assignment) => (
                  <article className="plan-card" key={assignment.id}>
                    <div className="plan-date">
                      <strong>{formatJapaneseDate(assignment.date)}</strong>
                      <span>{assignment.role === "early" ? "早番" : assignment.role === "late" ? "遅番" : "通常"}</span>
                    </div>
                    <div className="plan-time">
                      <span>勤務開始</span>
                      <strong>{assignment.start}</strong>
                      <span>勤務終了</span>
                      <strong>{assignment.end}</strong>
                      <span>休憩</span>
                      <strong>{assignment.breakMinutes}分</strong>
                      <span>連絡事項</span>
                      <strong>{targetShift.adminNotice || "-"}</strong>
                    </div>
                  </article>
                ))
              ) : (
                <p className="mini-note">公開済みの勤務予定はありません。</p>
              )}
            </div>
          </section>
        ) : null}
      </section>
    );
  }

  function renderAdminToolbar() {
    return (
      <div className="admin-toolbar">
        <label>
          <span>対象月</span>
          <select value={selectedMonth} onChange={(event) => setAdminMonth(event.target.value)}>
            {monthOptions.map((month) => (
              <option key={month} value={month}>
                {formatMonthLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>検索</span>
          <input value={store.admin.filterText} onChange={(event) => updateAdmin({ filterText: event.target.value })} placeholder="園児名・職員名" />
        </label>
        <label>
          <span>提出状況</span>
          <select value={store.admin.filterStatus} onChange={(event) => updateAdmin({ filterStatus: event.target.value as AdminState["filterStatus"] })}>
            <option value="all">すべて</option>
            <option value="submitted">提出済み</option>
            <option value="draft">下書き</option>
            <option value="unsubmitted">未提出</option>
          </select>
        </label>
      </div>
    );
  }

  function renderAdminScreen() {
    return (
      <section className="admin-dashboard" aria-label="管理者画面">
        {renderAdminToolbar()}
        <nav className="admin-menu" aria-label="管理者メニュー">
          {visibleAdminMenuItems.map((item) => (
            <button key={item.key} type="button" className={activeAdminMenu === item.key ? "active" : ""} onClick={() => updateAdmin({ menu: item.key })}>
              {item.label}
            </button>
          ))}
        </nav>
        <p className="admin-note">{selectedMonthIsPast ? "過去月は閲覧を基本とし、必要な場合だけ管理者が履歴付きで修正できます。" : featureFlags.workforcePrototype ? "園児利用予定、職員希望休、勤務条件、シフト案を同じ対象月で確認できます。" : "園児利用予定と時間帯別人数を同じ対象月で確認できます。"}</p>

        {activeAdminMenu === "children" ? renderAdminChildren() : null}
        {activeAdminMenu === "staff" ? renderAdminStaffList() : null}
        {activeAdminMenu === "availability" ? renderAdminAvailability() : null}
        {activeAdminMenu === "leaveStatus" ? renderAdminLeaveStatus() : null}
        {activeAdminMenu === "leaveCalendar" ? renderAdminLeaveCalendar() : null}
        {activeAdminMenu === "childCounts" ? renderAdminChildCounts() : null}
        {activeAdminMenu === "placement" ? renderPlacementRules() : null}
        {activeAdminMenu === "shiftAuto" ? renderShiftAuto() : null}
        {activeAdminMenu === "shiftAdjust" ? renderShiftAdjust() : null}
        {activeAdminMenu === "shiftPublish" ? renderShiftPublish() : null}
        {activeAdminMenu === "history" ? renderHistory() : null}
      </section>
    );
  }

  function renderAdminChildren() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>{formatMonthLabel(selectedMonth)}</span>
          <h2>園児一覧・提出状況</h2>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>園児名</th>
                <th>年齢区分</th>
                <th>提出状況</th>
                <th>基本利用予定</th>
                <th>月間利用予定</th>
                <th>登園予定時刻</th>
                <th>降園予定時刻</th>
                <th>提出日時</th>
                <th>最終更新日時</th>
              </tr>
            </thead>
            <tbody>
              {filteredAdminRows.map(({ child, schedule }) => {
                const stats = schedule ? getScheduleStats(schedule) : null;
                return (
                  <tr key={child.id}>
                    <td>
                      <strong>{child.name}</strong>
                      <span>{child.className}</span>
                    </td>
                    <td>{child.ageGroup}</td>
                    <td>
                      <span className={`status-badge ${statusClass(schedule?.status)}`}>{statusLabel(schedule?.status)}</span>
                    </td>
                    <td>{getBasicSummary(child.basePattern)}</td>
                    <td>{stats ? `${stats.useDays}日利用 / ${stats.restDays}日休み` : "未作成"}</td>
                    <td>{stats?.startSummary ?? "-"}</td>
                    <td>{stats?.endSummary ?? "-"}</td>
                    <td>{formatDateTime(schedule?.submittedAt)}</td>
                    <td>{formatDateTime(schedule?.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <section className="admin-panel nested-panel">
          <div className="section-title">
            <span>休園日と管理者修正</span>
            <h2>園児利用予定の管理</h2>
          </div>
          <div className="correction-grid">
            <label>
              <span>園児</span>
              <select value={store.admin.correctionChildId} onChange={(event) => updateAdmin({ correctionChildId: event.target.value })}>
                {store.children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>日付</span>
              <input type="date" value={store.admin.correctionDate} min={`${selectedMonth}-01`} max={`${selectedMonth}-${pad(selectedMonthDates.length)}`} onChange={(event) => updateAdmin({ correctionDate: event.target.value })} />
            </label>
            <label className="checkbox-row correction-check">
              <input type="checkbox" checked={store.admin.correctionEnabled} onChange={(event) => updateAdmin({ correctionEnabled: event.target.checked })} />
              <span>利用する</span>
            </label>
            <label>
              <span>登園予定時刻</span>
              <select value={store.admin.correctionStart} disabled={!store.admin.correctionEnabled} onChange={(event) => updateAdmin({ correctionStart: event.target.value })}>
                {timeOptions.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>降園予定時刻</span>
              <select value={store.admin.correctionEnd} disabled={!store.admin.correctionEnabled} onChange={(event) => updateAdmin({ correctionEnd: event.target.value })}>
                {timeOptions.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
            <label className="reason-field">
              <span>変更理由</span>
              <input value={store.admin.correctionReason} onChange={(event) => updateAdmin({ correctionReason: event.target.value })} placeholder="例：保護者から電話連絡" />
            </label>
            <button type="button" className="primary" disabled={!store.admin.correctionReason.trim()} onClick={applyAdminCorrection}>
              予定を修正
            </button>
          </div>
          <div className="closed-input-row">
            <button type="button" onClick={addClosedDate}>
              選択日を休園日にする
            </button>
            <div className="closed-date-list">
              {adminClosedDates.map((dateKey) => (
                <span className="closed-date-chip" key={dateKey}>
                  {formatJapaneseDate(dateKey)}
                  <button type="button" onClick={() => removeClosedDate(dateKey)}>
                    解除
                  </button>
                </span>
              ))}
            </div>
          </div>
        </section>
      </section>
    );
  }

  function renderAdminStaffList() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>管理者のみ閲覧</span>
          <h2>職員一覧</h2>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>職員氏名</th>
                <th>職員ID</th>
                <th>雇用区分</th>
                <th>保有資格</th>
                <th>早番</th>
                <th>遅番</th>
                <th>土曜</th>
                <th>週上限</th>
                <th>月上限</th>
                <th>連勤上限</th>
                <th>有効期間</th>
              </tr>
            </thead>
            <tbody>
              {store.staff.map((staff) => (
                <tr key={staff.id}>
                  <td>{staff.name}</td>
                  <td>{staff.id}</td>
                  <td>{staff.employmentType}</td>
                  <td>{staff.qualifications.join(" / ")}</td>
                  <td>{staff.canEarly ? "可" : "不可"}</td>
                  <td>{staff.canLate ? "可" : "不可"}</td>
                  <td>{staff.canSaturday ? "可" : "不可"}</td>
                  <td>{staff.maxWeeklyDays}日</td>
                  <td>{staff.maxMonthlyHours}時間</td>
                  <td>{staff.maxConsecutiveDays}日</td>
                  <td>{staff.validFrom} - {staff.validTo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function renderAdminAvailability() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>職員本人には非表示</span>
          <h2>勤務可能時間</h2>
        </div>
        <div className="correction-grid">
          <label>
            <span>職員</span>
            <select value={selectedStaff.id} onChange={(event) => updateAdmin({ selectedStaffId: event.target.value })}>
              {store.staff.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>雇用区分</span>
            <select value={selectedStaff.employmentType} onChange={(event) => updateStaffProfile(selectedStaff.id, { employmentType: event.target.value as EmploymentType })}>
              <option value="常勤">常勤</option>
              <option value="非常勤">非常勤</option>
              <option value="短時間">短時間</option>
            </select>
          </label>
          <label>
            <span>月間勤務時間上限</span>
            <input type="number" value={selectedStaff.maxMonthlyHours} onChange={(event) => updateStaffProfile(selectedStaff.id, { maxMonthlyHours: Number(event.target.value) })} />
          </label>
          <label>
            <span>連続勤務日数上限</span>
            <input type="number" value={selectedStaff.maxConsecutiveDays} onChange={(event) => updateStaffProfile(selectedStaff.id, { maxConsecutiveDays: Number(event.target.value) })} />
          </label>
          <label>
            <span>有効開始日</span>
            <input type="date" value={selectedStaff.validFrom} onChange={(event) => updateStaffProfile(selectedStaff.id, { validFrom: event.target.value })} />
          </label>
          <label>
            <span>有効終了日</span>
            <input type="date" value={selectedStaff.validTo} onChange={(event) => updateStaffProfile(selectedStaff.id, { validTo: event.target.value })} />
          </label>
        </div>
        <div className="compact-weekday-list">
          {weekdays.map((weekday) => {
            const setting = selectedStaff.availability[weekday.key];
            return (
              <div className="compact-weekday-row staff-availability-row" key={weekday.key}>
                <label className="checkbox-row">
                  <input type="checkbox" checked={setting.enabled} onChange={(event) => updateStaffAvailability(selectedStaff.id, weekday.key, { enabled: event.target.checked })} />
                  <span>{weekday.short}</span>
                </label>
                <select value={setting.start} disabled={!setting.enabled} onChange={(event) => updateStaffAvailability(selectedStaff.id, weekday.key, { start: event.target.value })}>
                  {timeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
                <select value={setting.end} disabled={!setting.enabled} onChange={(event) => updateStaffAvailability(selectedStaff.id, weekday.key, { end: event.target.value })}>
                  {timeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <div className="toggle-grid">
          {[
            ["canEarly", "早番対応"],
            ["canLate", "遅番対応"],
            ["canSaturday", "土曜日勤務"],
          ].map(([key, label]) => (
            <label className="checkbox-row" key={key}>
              <input type="checkbox" checked={Boolean(selectedStaff[key as keyof StaffProfile])} onChange={(event) => updateStaffProfile(selectedStaff.id, { [key]: event.target.checked } as Partial<StaffProfile>)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <label>
          <span>管理者メモ</span>
          <input value={selectedStaff.memo} onChange={(event) => updateStaffProfile(selectedStaff.id, { memo: event.target.value })} />
        </label>
      </section>
    );
  }

  function renderAdminLeaveStatus() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>{formatMonthLabel(selectedMonth)}</span>
          <h2>希望休提出状況</h2>
        </div>
        <div className="correction-grid">
          <label>
            <span>提出開始日</span>
            <input type="date" value={leavePeriod.startDate} onChange={(event) => updateLeavePeriod({ startDate: event.target.value })} />
          </label>
          <label>
            <span>提出期限</span>
            <input type="date" value={leavePeriod.deadline} onChange={(event) => updateLeavePeriod({ deadline: event.target.value })} />
          </label>
          <label>
            <span>受付状態</span>
            <select value={leavePeriod.status} onChange={(event) => updateLeavePeriod({ status: event.target.value as LeavePeriod["status"] })}>
              <option value="open">受付中</option>
              <option value="closed">受付終了</option>
            </select>
          </label>
          <label className="reason-field">
            <span>職員への案内文</span>
            <input value={leavePeriod.guidance} onChange={(event) => updateLeavePeriod({ guidance: event.target.value })} />
          </label>
        </div>
        <div className="stats-grid">
          <div>
            <span>希望休提出者</span>
            <strong>{new Set(monthLeaves.map((leave) => leave.staffId)).size}名</strong>
          </div>
          <div>
            <span>希望休日数</span>
            <strong>{monthLeaves.length}件</strong>
          </div>
          <div>
            <span>重複がある日</span>
            <strong>{selectedMonthDates.filter((date) => monthLeaves.filter((leave) => leave.date === toDateKey(date)).length >= 2).length}日</strong>
          </div>
          <div>
            <span>期限後の管理者修正</span>
            <strong>可能</strong>
          </div>
        </div>
      </section>
    );
  }

  function renderAdminLeaveCalendar() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>管理者のみ全件管理</span>
          <h2>希望休カレンダー</h2>
        </div>
        <div className="correction-grid">
          <label>
            <span>職員</span>
            <select value={store.admin.leaveCorrectionStaffId} onChange={(event) => updateAdmin({ leaveCorrectionStaffId: event.target.value })}>
              {store.staff.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>希望休日</span>
            <input type="date" value={store.admin.staffLeaveDate} min={`${selectedMonth}-01`} max={`${selectedMonth}-${pad(selectedMonthDates.length)}`} onChange={(event) => updateAdmin({ staffLeaveDate: event.target.value })} />
          </label>
          <button type="button" className="primary" onClick={adminToggleLeave}>
            管理者として追加・削除
          </button>
        </div>
        <div className="staff-calendar-list">
          {selectedMonthDates.map((date) => {
            const dateKey = toDateKey(date);
            const leaves = monthLeaves.filter((leave) => leave.date === dateKey);
            return (
              <article className={`staff-day-card ${leaves.length >= 2 ? "crowded" : ""}`} key={dateKey}>
                <div className="plan-date">
                  <strong>{formatJapaneseDate(dateKey)}</strong>
                  <span>{leaves.length ? `${leaves.length}名` : "希望休なし"}</span>
                </div>
                <ul className="name-list">
                  {leaves.length ? leaves.map((leave) => <li key={leave.id}>{store.staff.find((staff) => staff.id === leave.staffId)?.name ?? leave.staffId}</li>) : <li>登録なし</li>}
                </ul>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  function renderAdminChildCounts() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>保護者提出内容から自動集計</span>
          <h2>園児数集計</h2>
        </div>
        <div className="correction-grid">
          <label>
            <span>集計単位</span>
            <select value={store.admin.slotMinutes} onChange={(event) => updateAdmin({ slotMinutes: Number(event.target.value) as 15 | 30 })}>
              <option value={15}>15分単位</option>
              <option value={30}>30分単位</option>
            </select>
          </label>
          <label>
            <span>確認日</span>
            <input type="date" value={store.admin.childCountDate} min={`${selectedMonth}-01`} max={`${selectedMonth}-${pad(selectedMonthDates.length)}`} onChange={(event) => updateAdmin({ childCountDate: event.target.value })} />
          </label>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>日付</th>
                <th>時間帯</th>
                {ageGroups.map((ageGroup) => (
                  <th key={ageGroup}>{ageGroup}</th>
                ))}
                <th>合計</th>
                <th>登園予定児童</th>
              </tr>
            </thead>
            <tbody>
              {childSlotsForDate.map((slot) => (
                <tr key={`${slot.date}:${slot.start}`}>
                  <td>{formatJapaneseDate(slot.date)}</td>
                  <td>{slot.start} - {slot.end}</td>
                  {ageGroups.map((ageGroup) => (
                    <td key={ageGroup}>{slot.countsByAgeGroup[ageGroup]}</td>
                  ))}
                  <td>{slot.totalChildren}</td>
                  <td>{slot.children.map((child) => `${child.name} ${child.start}-${child.end}`).join(" / ") || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function renderPlacementRules() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>法令上の最低基準と施設独自方針を分離</span>
          <h2>配置基準設定</h2>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>種別</th>
                <th>年齢区分</th>
                <th>園児何名あたり</th>
                <th>最低職員数</th>
                <th>必要資格者</th>
                <th>開園時人数</th>
                <th>閉園時人数</th>
                <th>追加配置</th>
              </tr>
            </thead>
            <tbody>
              {store.placementRules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.ruleType === "law" ? "法令基準" : "施設独自"}</td>
                  <td>{rule.ageGroup}</td>
                  {[
                    ["childrenPerStaff", rule.childrenPerStaff],
                    ["minStaff", rule.minStaff],
                    ["requiredQualified", rule.requiredQualified],
                    ["openingStaff", rule.openingStaff],
                    ["closingStaff", rule.closingStaff],
                    ["extraStaff", rule.extraStaff],
                  ].map(([key, value]) => (
                    <td key={key}>
                      <input type="number" value={Number(value)} onChange={(event) => updatePlacementRule(rule.id, { [key]: Number(event.target.value) } as Partial<PlacementRule>)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function renderShiftAuto() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>{formatMonthLabel(selectedMonth)}</span>
          <h2>シフト自動作成</h2>
        </div>
        <div className="stats-grid">
          <div>
            <span>状態</span>
            <strong className={`status-badge ${shift.status === "published" ? "submitted" : shift.status === "uncreated" ? "unsubmitted" : "draft"}`}>{shiftStatusLabel(shift.status)}</strong>
          </div>
          <div>
            <span>勤務枠</span>
            <strong>{shift.assignments.length}件</strong>
          </div>
          <div>
            <span>未解決</span>
            <strong>{shift.issues.length}件</strong>
          </div>
          <div>
            <span>集計単位</span>
            <strong>{store.admin.slotMinutes}分</strong>
          </div>
        </div>
        <div className="action-row">
          <button type="button" className="primary" onClick={() => runAutoShift()}>
            月全体を自動作成
          </button>
          <button type="button" onClick={() => runAutoShift(store.admin.shiftEditDate)}>
            選択日だけ再作成
          </button>
        </div>
        <div className="issue-list">
          {shift.issues.length ? (
            shift.issues.map((issue) => (
              <article className={`issue-item ${issue.severity}`} key={issue.id}>
                <strong>{formatJapaneseDate(issue.date)} {issue.timeRange}</strong>
                <span>{issue.message}</span>
              </article>
            ))
          ) : (
            <p className="mini-note">未解決の問題はありません。</p>
          )}
        </div>
      </section>
    );
  }

  function renderShiftAdjust() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>手動調整と固定枠</span>
          <h2>シフト調整</h2>
        </div>
        <div className="correction-grid">
          <label>
            <span>職員</span>
            <select value={store.admin.shiftEditStaffId} onChange={(event) => updateAdmin({ shiftEditStaffId: event.target.value })}>
              {store.staff.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>勤務日</span>
            <input type="date" value={store.admin.shiftEditDate} min={`${selectedMonth}-01`} max={`${selectedMonth}-${pad(selectedMonthDates.length)}`} onChange={(event) => updateAdmin({ shiftEditDate: event.target.value })} />
          </label>
          <label>
            <span>勤務開始</span>
            <select value={store.admin.shiftEditStart} onChange={(event) => updateAdmin({ shiftEditStart: event.target.value })}>
              {timeOptions.map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>勤務終了</span>
            <select value={store.admin.shiftEditEnd} onChange={(event) => updateAdmin({ shiftEditEnd: event.target.value })}>
              {timeOptions.map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>休憩時間</span>
            <input type="number" value={store.admin.shiftEditBreak} onChange={(event) => updateAdmin({ shiftEditBreak: Number(event.target.value) })} />
          </label>
          <label>
            <span>早番・遅番</span>
            <select value={store.admin.shiftEditRole} onChange={(event) => updateAdmin({ shiftEditRole: event.target.value as StaffRole })}>
              <option value="normal">通常</option>
              <option value="early">早番</option>
              <option value="late">遅番</option>
            </select>
          </label>
          <label className="checkbox-row correction-check">
            <input type="checkbox" checked={store.admin.shiftEditFixed} onChange={(event) => updateAdmin({ shiftEditFixed: event.target.checked })} />
            <span>固定枠にする</span>
          </label>
          <label className="reason-field">
            <span>変更理由</span>
            <input value={store.admin.shiftEditReason} onChange={(event) => updateAdmin({ shiftEditReason: event.target.value })} placeholder="確定後の変更では必須" />
          </label>
          <button type="button" className="primary" onClick={addManualAssignment}>
            勤務枠を追加
          </button>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>日付</th>
                <th>職員</th>
                <th>時間</th>
                <th>休憩</th>
                <th>区分</th>
                <th>固定</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shift.assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <td>{formatJapaneseDate(assignment.date)}</td>
                  <td>{store.staff.find((staff) => staff.id === assignment.staffId)?.name ?? assignment.staffId}</td>
                  <td>{assignment.start} - {assignment.end}</td>
                  <td>{assignment.breakMinutes}分</td>
                  <td>{assignment.role === "early" ? "早番" : assignment.role === "late" ? "遅番" : "通常"}</td>
                  <td>{assignment.fixed ? "固定" : "自動調整可"}</td>
                  <td>
                    <button type="button" onClick={() => toggleAssignmentFixed(assignment.id)}>
                      {assignment.fixed ? "固定解除" : "固定"}
                    </button>
                    <button type="button" onClick={() => removeAssignment(assignment.id)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function renderShiftPublish() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>公開済みだけ職員画面へ表示</span>
          <h2>シフト確定・公開</h2>
        </div>
        <div className="stats-grid">
          <div>
            <span>現在の状態</span>
            <strong>{shiftStatusLabel(shift.status)}</strong>
          </div>
          <div>
            <span>確定日時</span>
            <strong>{formatDateTime(shift.confirmedAt)}</strong>
          </div>
          <div>
            <span>公開日時</span>
            <strong>{formatDateTime(shift.publishedAt)}</strong>
          </div>
          <div>
            <span>職員への連絡事項</span>
            <strong>{shift.adminNotice || "-"}</strong>
          </div>
        </div>
        <div className="action-row">
          <button type="button" onClick={() => setShiftStatus("confirmed")} disabled={!shift.assignments.length}>
            シフトを確定
          </button>
          <button type="button" className="primary" onClick={() => setShiftStatus("published")} disabled={!shift.assignments.length || shift.status === "uncreated"}>
            シフトを公開
          </button>
          <button type="button" onClick={() => setShiftStatus("draft")}>
            確定を解除
          </button>
        </div>
      </section>
    );
  }

  function renderHistory() {
    return (
      <section className="admin-panel">
        <div className="section-title">
          <span>最低限の変更履歴</span>
          <h2>変更履歴</h2>
        </div>
        <div className="history-list">
          {visibleHistories.length ? (
            visibleHistories.map((entry) => (
              <article className="history-item" key={entry.id}>
                <div>
                  <strong>{entry.target}</strong>
                  <span>{formatDateTime(entry.changedAt)} / {entry.actorType}:{entry.actorId}</span>
                </div>
                <p>対象月：{formatMonthLabel(entry.targetMonth)}</p>
                <p>理由：{entry.reason || "未入力"}</p>
              </article>
            ))
          ) : (
            <p className="mini-note">変更履歴はまだありません。</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className={`app-shell ${mode === "admin" ? "admin-mode" : mode === "staff" ? "staff-mode" : "parent-mode"}`}>
      <header className="hero-band">
        <div>
          <p className="eyebrow">{mode === "parent" ? "保護者向け利用予定提出" : mode === "staff" ? "職員向け希望休提出" : "管理者向け利用予定・シフト支援"}</p>
          <h1>翌月利用予定提出・職員シフト支援システム 試作版</h1>
          <p className="hero-copy">
            {mode === "parent"
              ? "保護者画面は、現在の提出対象月だけを表示します。"
              : mode === "staff"
                ? "職員画面では、自分の希望休提出と公開済みの自分のシフトだけを確認できます。"
                : featureFlags.workforcePrototype
                  ? "管理者画面では、園児数、職員条件、希望休、シフト案を月ごとに確認できます。"
                  : "管理者画面では、園児の利用予定と時間帯別人数を月ごとに確認できます。"}
          </p>
        </div>
        <aside className="deadline-panel" aria-label="対象月">
          <span>提出対象月</span>
          <strong>{formatMonthLabel(targetMonth)}</strong>
          <span>{mode === "staff" ? "希望休提出期限" : "保護者提出期限"}</span>
          <strong>{mode === "staff" ? formatJapaneseDate(targetLeavePeriod.deadline) : formatJapaneseDate(parentSchedule.deadline)}</strong>
          <em className={mode === "staff" ? (canCurrentStaffEditLeaves ? "" : "expired") : canParentEdit ? "" : "expired"}>
            {mode === "staff" ? (canCurrentStaffEditLeaves ? "希望休を編集できます" : "職員本人は編集できません") : canParentEdit ? "提出期限まで再編集できます" : "提出期限を過ぎています"}
          </em>
        </aside>
      </header>

      <nav className="auth-entry-links" aria-label="認証機能">
        <span>第2段階 認証確認</span>
        <a href="/auth/parent">保護者ログイン</a>
        <a href="/auth/admin">管理者ログイン</a>
      </nav>

      <div className="mode-switch role-switch" aria-label="利用者種類切り替え">
        <button type="button" className={mode === "parent" ? "active" : ""} onClick={() => setMode("parent")}>
          保護者画面
        </button>
        {featureFlags.workforcePrototype ? (
          <button type="button" className={mode === "staff" ? "active" : ""} onClick={() => setMode("staff")}>
            職員画面
          </button>
        ) : null}
        <button type="button" className={mode === "admin" ? "active" : ""} onClick={() => setMode("admin")}>
          管理者画面
        </button>
      </div>

      <p className="notice" role="status">
        {notice}
      </p>

      {mode === "parent" ? renderParentScreen() : null}
      {mode === "staff" ? renderStaffScreen() : null}
      {mode === "admin" ? renderAdminScreen() : null}
    </main>
  );
}
