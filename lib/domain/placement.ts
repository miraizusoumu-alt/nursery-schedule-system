import { ageGroups, getMonthDates, minutesToTime, roundDownTime, roundUpTime, timeToMinutes, toDateKey } from "./schedule";
import type { AgeGroup, ChildProfile, ChildUsageSlot, PlacementRule, ScheduleRecord } from "./types";

export function aggregateChildUsage(
  monthKey: string,
  schedules: Record<string, ScheduleRecord>,
  children: ChildProfile[],
  slotMinutes: 15 | 30,
) {
  const slots: ChildUsageSlot[] = [];
  const childrenById = Object.fromEntries(children.map((child) => [child.id, child]));
  getMonthDates(monthKey).forEach((date) => {
    const dateKey = toDateKey(date);
    const dayPlans = Object.values(schedules)
      .filter((schedule) => schedule.targetMonth === monthKey)
      .map((schedule) => ({ schedule, day: schedule.days[dateKey], child: childrenById[schedule.childId] }))
      .filter((item) => item.day?.enabled && !item.day.closed && item.child);

    if (!dayPlans.length) return;
    const first = Math.min(...dayPlans.map((item) => timeToMinutes(roundDownTime(item.day.start, slotMinutes))));
    const last = Math.max(...dayPlans.map((item) => timeToMinutes(roundUpTime(item.day.end, slotMinutes))));

    for (let cursor = first; cursor < last; cursor += slotMinutes) {
      const start = minutesToTime(cursor);
      const end = minutesToTime(cursor + slotMinutes);
      const attending = dayPlans
        .filter((item) => timeToMinutes(item.day.start) < cursor + slotMinutes && timeToMinutes(item.day.end) > cursor)
        .map((item) => ({
          childId: item.child.id,
          name: item.child.name,
          ageGroup: item.child.ageGroup,
          start: item.day.start,
          end: item.day.end,
        }));
      const countsByAgeGroup = Object.fromEntries(
        ageGroups.map((ageGroup) => [ageGroup, attending.filter((child) => child.ageGroup === ageGroup).length]),
      ) as Record<AgeGroup, number>;
      slots.push({ date: dateKey, start, end, countsByAgeGroup, totalChildren: attending.length, children: attending });
    }
  });
  return slots;
}

export function calculateRequiredStaff(slot: ChildUsageSlot, rules: PlacementRule[]) {
  const byAge = ageGroups.reduce((sum, ageGroup) => {
    const count = slot.countsByAgeGroup[ageGroup];
    const matching = rules.filter((rule) => rule.ageGroup === ageGroup);
    const required = matching.reduce(
      (max, rule) => Math.max(max, Math.ceil(count / Math.max(1, rule.childrenPerStaff)) + rule.extraStaff, rule.minStaff),
      0,
    );
    return sum + (count > 0 ? required : 0);
  }, 0);
  const facilityMin = Math.max(0, ...rules.map((rule) => rule.minStaff));
  const requiredQualified = Math.max(1, ...rules.map((rule) => rule.requiredQualified));
  const openingStaff = Math.max(0, ...rules.map((rule) => rule.openingStaff));
  const closingStaff = Math.max(0, ...rules.map((rule) => rule.closingStaff));
  return {
    requiredStaff: Math.max(facilityMin, byAge),
    requiredQualified,
    openingStaff,
    closingStaff,
  };
}
