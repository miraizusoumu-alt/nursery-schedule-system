import { aggregateChildUsage, calculateRequiredStaff } from "./placement";
import {
  createInitialShift,
  formatJapaneseDate,
  getMonthDates,
  leaveKey,
  minutesToTime,
  shiftDurationMinutes,
  shiftKey,
  timeToMinutes,
  toDateKey,
  weekdayKeyFromDate,
} from "./schedule";
import type { LeaveRequest, PrototypeStore, ShiftAssignment, ShiftIssue, ShiftStatus, StaffProfile } from "./types";

export function isQualified(staff: StaffProfile) {
  return staff.qualifications.some((item) => item.includes("保育士") || item.includes("看護師"));
}

export function staffAvailableForDate(staff: StaffProfile, dateKey: string) {
  const weekdayKey = weekdayKeyFromDate(new Date(`${dateKey}T00:00:00`));
  if (!weekdayKey) return null;
  if (staff.fixedDaysOff.includes(weekdayKey)) return null;
  if (weekdayKey === "sat" && !staff.canSaturday) return null;
  const availability = staff.availability[weekdayKey];
  return availability.enabled ? availability : null;
}

export function staffHasLeave(
  staffId: string,
  monthKey: string,
  dateKey: string,
  leaveRequests: Record<string, LeaveRequest>,
) {
  return Boolean(leaveRequests[leaveKey(staffId, monthKey, dateKey)]);
}

export function overlaps(
  a: Pick<ShiftAssignment, "date" | "start" | "end" | "staffId">,
  b: Pick<ShiftAssignment, "date" | "start" | "end" | "staffId">,
) {
  return a.staffId === b.staffId && a.date === b.date && timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(a.end) > timeToMinutes(b.start);
}

export function wouldExceedConsecutive(
  staffId: string,
  dateKey: string,
  assignments: ShiftAssignment[],
  maxConsecutiveDays: number,
) {
  const assignedDates = new Set(assignments.filter((assignment) => assignment.staffId === staffId).map((assignment) => assignment.date));
  assignedDates.add(dateKey);
  let streak = 0;
  const monthKey = dateKey.slice(0, 7);
  for (const date of getMonthDates(monthKey)) {
    const key = toDateKey(date);
    if (assignedDates.has(key)) {
      streak += 1;
      if (streak > maxConsecutiveDays) return true;
    } else {
      streak = 0;
    }
  }
  return false;
}

export function createIssue(
  date: string,
  timeRange: string,
  message: string,
  severity: ShiftIssue["severity"] = "warning",
): ShiftIssue {
  return { id: `${date}:${timeRange}:${message}`, date, timeRange, message, severity };
}

export function generateShiftForMonth(
  store: PrototypeStore,
  monthKey: string,
  scopeDate?: string,
  now = new Date(),
) {
  const current = store.shifts[shiftKey(monthKey)] ?? createInitialShift(monthKey, now);
  const slotMinutes = store.admin.slotMinutes;
  const slots = aggregateChildUsage(monthKey, store.schedules, store.children, slotMinutes);
  const dayGroups = new Map<string, ReturnType<typeof aggregateChildUsage>>();
  slots.forEach((slot) => {
    if (scopeDate && slot.date !== scopeDate) return;
    if (!dayGroups.has(slot.date)) dayGroups.set(slot.date, []);
    dayGroups.get(slot.date)?.push(slot);
  });

  const fixedAssignments = current.assignments.filter((assignment) => assignment.fixed && (!scopeDate || assignment.date === scopeDate));
  const preservedAssignments = current.assignments.filter((assignment) => scopeDate && assignment.date !== scopeDate);
  const assignments: ShiftAssignment[] = [...preservedAssignments, ...fixedAssignments];
  const issues: ShiftIssue[] = [];
  const monthlyMinutes: Record<string, number> = {};
  assignments.forEach((assignment) => {
    monthlyMinutes[assignment.staffId] = (monthlyMinutes[assignment.staffId] ?? 0) + shiftDurationMinutes(assignment);
  });

  dayGroups.forEach((daySlots, dateKey) => {
    const maxSlot = daySlots.reduce((max, slot) => (slot.totalChildren > max.totalChildren ? slot : max), daySlots[0]);
    const requirement = calculateRequiredStaff(maxSlot, store.placementRules);
    const earliest = Math.min(...daySlots.filter((slot) => slot.totalChildren > 0).map((slot) => timeToMinutes(slot.start)));
    const latest = Math.max(...daySlots.filter((slot) => slot.totalChildren > 0).map((slot) => timeToMinutes(slot.end)));
    const fixedForDay = assignments.filter((assignment) => assignment.date === dateKey);
    const requiredStaffCount = Math.max(requirement.requiredStaff, fixedForDay.length);
    const candidates = store.staff
      .map((staff) => {
        const availability = staffAvailableForDate(staff, dateKey);
        if (!availability) return null;
        if (staffHasLeave(staff.id, monthKey, dateKey, store.leaveRequests)) return null;
        const start = Math.max(timeToMinutes(availability.start), earliest);
        const end = Math.min(timeToMinutes(availability.end), latest);
        const breakMinutes = end - start >= 6 * 60 ? 60 : 0;
        const potentialMinutes = Math.max(0, end - start - breakMinutes);
        if (potentialMinutes < 180) return null;
        const baseAssignment: ShiftAssignment = {
          id: `auto:${monthKey}:${dateKey}:${staff.id}`,
          staffId: staff.id,
          date: dateKey,
          start: minutesToTime(start),
          end: minutesToTime(end),
          breakMinutes,
          role: start <= 8 * 60 + 30 && staff.canEarly ? "early" : end >= 17 * 60 + 30 && staff.canLate ? "late" : "normal",
          fixed: false,
          source: "auto",
          note: "",
        };
        const monthlyAfter = (monthlyMinutes[staff.id] ?? 0) + potentialMinutes;
        if (monthlyAfter > staff.maxMonthlyHours * 60) return null;
        if (wouldExceedConsecutive(staff.id, dateKey, assignments, staff.maxConsecutiveDays)) return null;
        if (assignments.some((assignment) => overlaps(assignment, baseAssignment))) return null;
        return { staff, assignment: baseAssignment, monthlyAfter };
      })
      .filter(Boolean) as Array<{ staff: StaffProfile; assignment: ShiftAssignment; monthlyAfter: number }>;

    const selected = [...fixedForDay];
    const sortedCandidates = candidates.sort((a, b) => (monthlyMinutes[a.staff.id] ?? 0) - (monthlyMinutes[b.staff.id] ?? 0));
    sortedCandidates.forEach((candidate) => {
      if (selected.length >= requiredStaffCount) return;
      selected.push(candidate.assignment);
      assignments.push(candidate.assignment);
      monthlyMinutes[candidate.staff.id] = candidate.monthlyAfter;
    });

    const qualifiedCount = selected.filter((assignment) => isQualified(store.staff.find((staff) => staff.id === assignment.staffId)!)).length;
    const earlyCount = selected.filter((assignment) => assignment.role === "early").length;
    const lateCount = selected.filter((assignment) => assignment.role === "late").length;
    if (selected.length < requirement.requiredStaff) {
      issues.push(
        createIssue(
          dateKey,
          `${minutesToTime(earliest)}-${minutesToTime(latest)}`,
          `${formatJapaneseDate(dateKey)}の必要職員数が${requirement.requiredStaff - selected.length}名不足しています。`,
          "critical",
        ),
      );
    }
    if (qualifiedCount < requirement.requiredQualified) {
      issues.push(createIssue(dateKey, "有資格者", `${formatJapaneseDate(dateKey)}の有資格者が${requirement.requiredQualified - qualifiedCount}名不足しています。`, "critical"));
    }
    if (requirement.openingStaff > 0 && earlyCount < requirement.openingStaff) {
      issues.push(createIssue(dateKey, "開園", `${formatJapaneseDate(dateKey)}の開園担当者を配置できません。`));
    }
    if (requirement.closingStaff > 0 && lateCount < requirement.closingStaff) {
      issues.push(createIssue(dateKey, "閉園", `${formatJapaneseDate(dateKey)}の閉園担当者を配置できません。`));
    }
  });

  const fixedOutsideScope = current.assignments.filter((assignment) => assignment.fixed && scopeDate && assignment.date !== scopeDate);
  const nextAssignments = [...assignments, ...fixedOutsideScope].filter(
    (assignment, index, all) => all.findIndex((item) => item.id === assignment.id) === index,
  );
  const nowIso = now.toISOString();
  return {
    ...current,
    targetMonth: monthKey,
    slotMinutes,
    status: "draft" as ShiftStatus,
    assignments: nextAssignments.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.staffId.localeCompare(b.staffId)),
    issues,
    generatedAt: nowIso,
    updatedAt: nowIso,
  };
}
