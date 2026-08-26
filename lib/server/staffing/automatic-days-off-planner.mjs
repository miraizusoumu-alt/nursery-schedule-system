import {
  calculateConsecutiveWorkWarnings,
  calculateFullTimeMonthlyBaseline,
  countsAsScheduledWorkDay,
  evaluateConsecutiveWorkLimitForDate,
  FULL_TIME_REQUIRED_DAYS_OFF,
  MAX_CONSECUTIVE_WORK_DAYS,
  validateScheduleDay,
} from "./scheduled-work.mjs";
import { normalizeAutomaticShiftRequirementSlots } from "./automatic-shift-generator.mjs";
import { evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot } from "./staff-eligibility.mjs";

const FULL_TIME = "常勤";

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function targetMonthDates(targetMonth) {
  const baseline = calculateFullTimeMonthlyBaseline(targetMonth);
  const [year, month] = targetMonth.split("-").map(Number);
  return {
    baseline,
    dates: Array.from({ length: baseline.calendarDays }, (_, index) => {
      return dateKey(new Date(Date.UTC(year, month - 1, index + 1)));
    }),
  };
}

function staffSortKey(staff) {
  return `${staff.staffCode ?? ""}\u0000${staff.id ?? ""}`;
}

function employedOnDate(staff, date) {
  return staff.status === "active"
    && staff.employmentStartDate <= date
    && (!staff.employmentEndDate || date <= staff.employmentEndDate);
}

function employmentTypeForMonth(staff, startDate, endDate) {
  const types = [...new Set((staff.workConditions ?? [])
    .filter((condition) => condition.validFrom <= endDate && (!condition.validTo || condition.validTo >= startDate))
    .map((condition) => condition.employmentType))];
  if (types.length === 1) return types[0];
  if (types.length > 1) return "期間内変更";
  return null;
}

function indexUniqueByDate(records, label) {
  const result = new Map();
  for (const record of records ?? []) {
    validateScheduleDay({ date: record?.date, dayType: "work", segments: [] });
    if (result.has(record.date)) throw new TypeError(`${label}の日付が重複しています: ${record.date}`);
    result.set(record.date, record);
  }
  return result;
}

function addToSetMap(map, key, value) {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function copySetMap(source) {
  return new Map([...source].map(([key, values]) => [key, new Set(values)]));
}

function profileWithPlannedDaysOff(staff, plannedDaysOffByStaff) {
  const planned = plannedDaysOffByStaff.get(staff.id) ?? new Set();
  const existingDates = new Set((staff.scheduledDays ?? []).map((day) => day.date));
  const additions = [...planned]
    .filter((date) => !existingDates.has(date))
    .map((date) => ({ staffId: staff.id, date, dayType: "day_off", segments: [] }));
  return { ...staff, scheduledDays: [...(staff.scheduledDays ?? []), ...additions] };
}

function summarizeStaffingForDate(date, slots, staff, plannedDaysOffByStaff) {
  const profiles = staff.map((entry) => profileWithPlannedDaysOff(entry, plannedDaysOffByStaff));
  const slotSummaries = slots.map((slot) => {
    const evaluations = profiles.map((entry) => {
      return evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(entry, slot);
    });
    const eligibleChildcareWorkerCount = evaluations.filter((entry) => entry.automaticPlacementEligible).length;
    const eligibleLicensedNurseryTeacherCount = evaluations.filter((entry) => entry.licensedEligible).length;
    return {
      date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      requiredChildcareWorkers: slot.requiredChildcareWorkers,
      requiredLicensedNurseryTeachers: slot.requiredLicensedNurseryTeachers,
      eligibleChildcareWorkerCount,
      eligibleLicensedNurseryTeacherCount,
      childcareWorkerCapacityMargin: eligibleChildcareWorkerCount - slot.requiredChildcareWorkers,
      licensedNurseryTeacherCapacityMargin:
        eligibleLicensedNurseryTeacherCount - slot.requiredLicensedNurseryTeachers,
      childcareWorkerShortage: Math.max(0, slot.requiredChildcareWorkers - eligibleChildcareWorkerCount),
      licensedNurseryTeacherShortage:
        Math.max(0, slot.requiredLicensedNurseryTeachers - eligibleLicensedNurseryTeacherCount),
    };
  });
  return {
    date,
    slots: slotSummaries,
    totalRequiredChildcareWorkerSlots:
      slotSummaries.reduce((total, slot) => total + slot.requiredChildcareWorkers, 0),
    totalRequiredLicensedNurseryTeacherSlots:
      slotSummaries.reduce((total, slot) => total + slot.requiredLicensedNurseryTeachers, 0),
    totalChildcareWorkerShortage:
      slotSummaries.reduce((total, slot) => total + slot.childcareWorkerShortage, 0),
    totalLicensedNurseryTeacherShortage:
      slotSummaries.reduce((total, slot) => total + slot.licensedNurseryTeacherShortage, 0),
    totalEligibleChildcareWorkerSlots:
      slotSummaries.reduce((total, slot) => total + slot.eligibleChildcareWorkerCount, 0),
    totalEligibleLicensedNurseryTeacherSlots:
      slotSummaries.reduce((total, slot) => total + slot.eligibleLicensedNurseryTeacherCount, 0),
  };
}

function addCost(left, right) {
  return left.map((value, index) => value + right[index]);
}

function compareCost(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function betterPlan(left, right) {
  if (!right) return true;
  const costComparison = compareCost(left.cost, right.cost);
  if (costComparison !== 0) return costComparison < 0;
  return left.selected.join("\u0000") < right.selected.join("\u0000");
}

function selectDaysOffWithConsecutiveLimit({
  dates,
  candidateCosts,
  fixedNonWorkDates,
  fixedWorkDates,
  requiredCount,
  priorConsecutiveWorkDays,
}) {
  const zeroCost = Array.from({ length: 9 }, () => 0);
  for (let targetCount = requiredCount; targetCount >= 0; targetCount -= 1) {
    let states = new Map([[`0:${priorConsecutiveWorkDays}`, {
      selectedCount: 0,
      consecutiveWorkDays: priorConsecutiveWorkDays,
      selected: [],
      cost: zeroCost,
    }]]);
    for (const date of dates) {
      const nextStates = new Map();
      for (const state of states.values()) {
        const options = [];
        if (fixedNonWorkDates.has(date)) {
          options.push({ isDayOff: false, isWork: false });
        } else if (fixedWorkDates.has(date) || !candidateCosts.has(date)) {
          options.push({ isDayOff: false, isWork: true });
        } else {
          options.push({ isDayOff: false, isWork: true }, { isDayOff: true, isWork: false });
        }
        for (const option of options) {
          const selectedCount = state.selectedCount + (option.isDayOff ? 1 : 0);
          if (selectedCount > targetCount) continue;
          const consecutiveWorkDays = option.isWork ? state.consecutiveWorkDays + 1 : 0;
          if (consecutiveWorkDays > MAX_CONSECUTIVE_WORK_DAYS) continue;
          const candidate = {
            selectedCount,
            consecutiveWorkDays,
            selected: option.isDayOff ? [...state.selected, date] : state.selected,
            cost: option.isDayOff ? addCost(state.cost, candidateCosts.get(date)) : state.cost,
          };
          const key = `${selectedCount}:${consecutiveWorkDays}`;
          if (betterPlan(candidate, nextStates.get(key))) nextStates.set(key, candidate);
        }
      }
      states = nextStates;
      if (states.size === 0) break;
    }
    const completed = [...states.values()].filter((state) => state.selectedCount === targetCount);
    completed.sort((left, right) => compareCost(left.cost, right.cost)
      || left.selected.join("\u0000").localeCompare(right.selected.join("\u0000")));
    if (completed[0]) return { selected: completed[0].selected, requestedCount: requiredCount, fulfilled: targetCount === requiredCount };
  }
  return { selected: [], requestedCount: requiredCount, fulfilled: requiredCount === 0 };
}

function priorDaysForStaff(staff, monthStart) {
  const byDate = new Map();
  for (const day of staff.scheduledDays ?? []) {
    if (day.date < monthStart) byDate.set(day.date, day);
  }
  for (const preference of staff.schedulePreferences ?? []) {
    if (preference.date < monthStart && preference.preferenceType === "day_off" && !byDate.has(preference.date)) {
      byDate.set(preference.date, {
        staffId: staff.id,
        date: preference.date,
        dayType: "other",
        segments: [],
      });
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function priorConsecutiveWorkDays(staff, monthStart, priorDays) {
  const check = evaluateConsecutiveWorkLimitForDate([], monthStart, {
    staffId: staff.id,
    priorDays,
  });
  return Math.max(0, check.consecutiveDays - 1);
}

function projectedMonthDays(staff, dates, existingByDate, finalDaysOff, dayOffPreferences, assumeUnplannedWork) {
  return dates.map((date) => {
    const existing = existingByDate.get(date);
    if (existing) return existing;
    if (!assumeUnplannedWork) return null;
    if (finalDaysOff.has(date)) return { staffId: staff.id, date, dayType: "day_off", segments: [] };
    if (!employedOnDate(staff, date) || dayOffPreferences.has(date)) {
      return { staffId: staff.id, date, dayType: "other", segments: [] };
    }
    return { staffId: staff.id, date, dayType: "work", segments: [] };
  }).filter(Boolean);
}

function dayOffCost({ before, after, currentDayOffCount, isClosureDay }) {
  return [
    Math.max(0, after.totalLicensedNurseryTeacherShortage - before.totalLicensedNurseryTeacherShortage),
    Math.max(0, after.totalChildcareWorkerShortage - before.totalChildcareWorkerShortage),
    after.totalLicensedNurseryTeacherShortage,
    after.totalChildcareWorkerShortage,
    Math.max(0, before.totalEligibleLicensedNurseryTeacherSlots - after.totalEligibleLicensedNurseryTeacherSlots),
    Math.max(0, before.totalEligibleChildcareWorkerSlots - after.totalEligibleChildcareWorkerSlots),
    currentDayOffCount,
    isClosureDay ? 0 : 1,
    before.totalRequiredChildcareWorkerSlots + before.totalRequiredLicensedNurseryTeacherSlots,
  ];
}

export function planFullTimeMonthlyDaysOff({
  targetMonth,
  requirementSlots = [],
  staffProfiles = [],
  closureDates = [],
  requiredDaysOff = FULL_TIME_REQUIRED_DAYS_OFF,
} = {}) {
  if (!Array.isArray(staffProfiles) || !Array.isArray(closureDates)) {
    throw new TypeError("職員候補と休園日を配列で指定してください。");
  }
  if (!Number.isInteger(requiredDaysOff) || requiredDaysOff < 0) {
    throw new TypeError("必要公休日数は0以上の整数で指定してください。");
  }
  const { baseline, dates } = targetMonthDates(targetMonth);
  const monthStart = dates[0];
  const monthEnd = dates.at(-1);
  const dateSet = new Set(dates);
  const closures = new Set(closureDates);
  for (const date of closures) {
    validateScheduleDay({ date, dayType: "work", segments: [] });
    if (!dateSet.has(date)) throw new RangeError(`休園日は対象月内で指定してください: ${date}`);
  }
  const slots = normalizeAutomaticShiftRequirementSlots(requirementSlots);
  if (slots.some((slot) => !dateSet.has(slot.date))) {
    throw new RangeError("必要人数の時間枠は対象月内で指定してください。");
  }
  const slotsByDate = new Map(dates.map((date) => [date, []]));
  for (const slot of slots) slotsByDate.get(slot.date).push(slot);

  const staffIds = new Set();
  const staff = [...staffProfiles].sort((left, right) => staffSortKey(left).localeCompare(staffSortKey(right)));
  for (const entry of staff) {
    if (!entry?.id || staffIds.has(entry.id)) throw new TypeError("職員IDは重複しない値を指定してください。");
    staffIds.add(entry.id);
  }

  const plannedDaysOffByStaff = new Map();
  const initialDaysOffByStaff = new Map();
  const planInputs = new Map();
  for (const entry of staff) {
    const existingByDate = indexUniqueByDate(entry.scheduledDays ?? [], "現在版シフト");
    const preferencesByDate = indexUniqueByDate(entry.schedulePreferences ?? [], "希望");
    const existingDaysOff = new Set(dates.filter((date) => existingByDate.get(date)?.dayType === "day_off"));
    const dayOffPreferences = new Set(dates.filter((date) => preferencesByDate.get(date)?.preferenceType === "day_off"));
    const workTimePreferences = new Set(dates.filter((date) => {
      return preferencesByDate.get(date)?.preferenceType === "work_time";
    }));
    const employmentType = employmentTypeForMonth(entry, monthStart, monthEnd);
    const preferredPlannedDaysOff = new Set();
    const unclassifiedDayOffPreferences = [];
    if (employmentType === FULL_TIME) {
      for (const date of [...dayOffPreferences].sort()) {
        const existing = existingByDate.get(date);
        if (existing?.dayType === "day_off") continue;
        if (!employedOnDate(entry, date)) {
          unclassifiedDayOffPreferences.push({ date, reason: "OUTSIDE_EMPLOYMENT" });
        } else if (existing) {
          unclassifiedDayOffPreferences.push({ date, reason: "EXISTING_SCHEDULE_CONFLICT" });
        } else if (existingDaysOff.size + preferredPlannedDaysOff.size < requiredDaysOff) {
          preferredPlannedDaysOff.add(date);
        } else {
          unclassifiedDayOffPreferences.push({ date, reason: "MONTHLY_DAY_OFF_LIMIT_REACHED" });
        }
      }
    }
    const initiallyPlanned = new Set([...existingDaysOff, ...preferredPlannedDaysOff]);
    plannedDaysOffByStaff.set(entry.id, initiallyPlanned);
    initialDaysOffByStaff.set(entry.id, new Set(existingDaysOff));
    planInputs.set(entry.id, {
      employmentType,
      existingByDate,
      existingDaysOff,
      dayOffPreferences,
      workTimePreferences,
      preferredPlannedDaysOff,
      unclassifiedDayOffPreferences,
    });
  }

  const staffPlans = [];
  for (const entry of staff) {
    const input = planInputs.get(entry.id);
    const automaticDaysOff = new Set();
    const unresolvedConstraints = [];
    if (input.employmentType === "期間内変更") {
      unresolvedConstraints.push({
        code: "EMPLOYMENT_TYPE_CHANGED_IN_MONTH",
        message: "対象月内で雇用区分が変わるため、月9日公休を自動計画できません。",
      });
    }
    if (input.employmentType === FULL_TIME) {
      const fixedNonWorkDates = new Set();
      const fixedWorkDates = new Set();
      for (const date of dates) {
        const existing = input.existingByDate.get(date);
        if (!employedOnDate(entry, date) || input.dayOffPreferences.has(date)) {
          fixedNonWorkDates.add(date);
        } else if (existing) {
          if (existing.dayType === "day_off" || existing.dayType === "paid_leave" || !countsAsScheduledWorkDay(existing)) {
            fixedNonWorkDates.add(date);
          } else {
            fixedWorkDates.add(date);
          }
        } else if (input.workTimePreferences.has(date)) {
          fixedWorkDates.add(date);
        }
      }
      const currentPlanned = plannedDaysOffByStaff.get(entry.id);
      for (const date of currentPlanned) fixedNonWorkDates.add(date);
      const candidateDates = dates.filter((date) => {
        return employedOnDate(entry, date)
          && !input.existingByDate.has(date)
          && !input.dayOffPreferences.has(date)
          && !input.workTimePreferences.has(date)
          && !currentPlanned.has(date);
      });
      const candidateCosts = new Map();
      for (const date of candidateDates) {
        const before = summarizeStaffingForDate(date, slotsByDate.get(date), staff, plannedDaysOffByStaff);
        const proposed = copySetMap(plannedDaysOffByStaff);
        addToSetMap(proposed, entry.id, date);
        const after = summarizeStaffingForDate(date, slotsByDate.get(date), staff, proposed);
        const currentDayOffCount = [...plannedDaysOffByStaff.values()]
          .filter((daysOff) => daysOff.has(date)).length;
        candidateCosts.set(date, dayOffCost({
          before,
          after,
          currentDayOffCount,
          isClosureDay: closures.has(date),
        }));
      }
      const needed = Math.max(0, requiredDaysOff - currentPlanned.size);
      const priorDays = priorDaysForStaff(entry, monthStart);
      const selection = selectDaysOffWithConsecutiveLimit({
        dates,
        candidateCosts,
        fixedNonWorkDates,
        fixedWorkDates,
        requiredCount: needed,
        priorConsecutiveWorkDays: priorConsecutiveWorkDays(entry, monthStart, priorDays),
      });
      for (const date of selection.selected) {
        automaticDaysOff.add(date);
        currentPlanned.add(date);
      }
      if (!selection.fulfilled) {
        unresolvedConstraints.push({
          code: "DAY_OFF_TARGET_UNRESOLVED",
          message: `月${requiredDaysOff}日公休まであと${needed - selection.selected.length}日を安全に割り当てられません。`,
          shortageDays: needed - selection.selected.length,
        });
      }
    }
    for (const preference of input.unclassifiedDayOffPreferences) {
      unresolvedConstraints.push({
        code: "DAY_OFF_PREFERENCE_REQUIRES_REVIEW",
        message: "公休として分類できなかった希望休があります。",
        ...preference,
      });
    }
    const finalDaysOff = plannedDaysOffByStaff.get(entry.id);
    const priorDays = priorDaysForStaff(entry, monthStart);
    const applies = input.employmentType === FULL_TIME;
    const projectedDays = projectedMonthDays(
      entry,
      dates,
      input.existingByDate,
      finalDaysOff,
      input.dayOffPreferences,
      applies,
    );
    const consecutiveWorkWarnings = calculateConsecutiveWorkWarnings(projectedDays, {
      staffId: entry.id,
      priorDays,
    });
    if (consecutiveWorkWarnings.length > 0) {
      unresolvedConstraints.push({
        code: "CONSECUTIVE_WORK_LIMIT_UNRESOLVED",
        message: "既存の勤務指定を維持したまま最大6連勤を満たせません。",
        warnings: consecutiveWorkWarnings,
      });
    }
    staffPlans.push({
      staffId: entry.id,
      staffCode: entry.staffCode,
      staffName: entry.name,
      targetMonth,
      employmentType: input.employmentType,
      requiredDaysOff: applies ? requiredDaysOff : null,
      existingDaysOff: [...input.existingDaysOff].sort(),
      dayOffPreferences: [...input.dayOffPreferences].sort(),
      workTimePreferences: [...input.workTimePreferences].sort(),
      preferredPlannedDaysOff: [...input.preferredPlannedDaysOff].sort(),
      automaticDaysOff: [...automaticDaysOff].sort(),
      finalPlannedDaysOff: [...finalDaysOff].sort(),
      plannedDaysOffCount: finalDaysOff.size,
      differenceFromRequiredDaysOff: applies ? finalDaysOff.size - requiredDaysOff : null,
      unclassifiedDayOffPreferences: input.unclassifiedDayOffPreferences,
      monthlyBaseline: applies ? calculateFullTimeMonthlyBaseline(targetMonth, { requiredDaysOff }) : null,
      consecutiveWorkCheck: {
        maxConsecutiveDays: MAX_CONSECUTIVE_WORK_DAYS,
        valid: consecutiveWorkWarnings.length === 0,
        warnings: consecutiveWorkWarnings,
      },
      unresolvedConstraints,
    });
  }

  const baselineDays = dates.map((date) => {
    return summarizeStaffingForDate(date, slotsByDate.get(date), staff, initialDaysOffByStaff);
  });
  const finalDays = dates.map((date, index) => {
    const final = summarizeStaffingForDate(date, slotsByDate.get(date), staff, plannedDaysOffByStaff);
    const before = baselineDays[index];
    return {
      ...final,
      isClosureDay: closures.has(date),
      plannedDayOffStaffIds: staff
        .filter((entry) => plannedDaysOffByStaff.get(entry.id)?.has(date))
        .map((entry) => entry.id),
      introducedChildcareWorkerShortage:
        Math.max(0, final.totalChildcareWorkerShortage - before.totalChildcareWorkerShortage),
      introducedLicensedNurseryTeacherShortage:
        Math.max(0, final.totalLicensedNurseryTeacherShortage - before.totalLicensedNurseryTeacherShortage),
    };
  });
  const unresolvedConstraints = staffPlans.flatMap((plan) => {
    return plan.unresolvedConstraints.map((constraint) => ({ staffId: plan.staffId, ...constraint }));
  });
  for (const day of finalDays) {
    for (const slot of day.slots) {
      if (slot.childcareWorkerShortage > 0) {
        unresolvedConstraints.push({
          code: "CHILDCARE_STAFF_SHORTAGE_AFTER_DAY_OFF_PLAN",
          date: day.date,
          startTime: slot.startTime,
          shortage: slot.childcareWorkerShortage,
        });
      }
      if (slot.licensedNurseryTeacherShortage > 0) {
        unresolvedConstraints.push({
          code: "LICENSED_STAFF_SHORTAGE_AFTER_DAY_OFF_PLAN",
          date: day.date,
          startTime: slot.startTime,
          shortage: slot.licensedNurseryTeacherShortage,
        });
      }
    }
  }

  return {
    targetMonth,
    requiredDaysOff,
    calendarDays: baseline.calendarDays,
    staffPlans,
    days: finalDays,
    unresolvedConstraints,
  };
}
