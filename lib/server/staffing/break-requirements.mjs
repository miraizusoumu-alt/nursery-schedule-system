import { calculateDailyScheduledWorkMinutes, validateScheduleDay } from "./scheduled-work.mjs";

const SIX_HOURS_IN_MINUTES = 6 * 60;
const EIGHT_HOURS_IN_MINUTES = 8 * 60;

export function resolveRequiredBreakMinutes(scheduledWorkMinutes) {
  if (!Number.isInteger(scheduledWorkMinutes) || scheduledWorkMinutes < 0) {
    throw new TypeError("予定労働時間は0以上の整数分で指定してください。");
  }
  if (scheduledWorkMinutes > EIGHT_HOURS_IN_MINUTES) return 60;
  if (scheduledWorkMinutes > SIX_HOURS_IN_MINUTES) return 45;
  return 0;
}

export function resolveDailyBreakRequirements(scheduleSegments) {
  if (!Array.isArray(scheduleSegments)) {
    throw new TypeError("勤務区間を配列で指定してください。");
  }

  const grouped = new Map();
  for (const segment of scheduleSegments) {
    if (!segment?.staffId) throw new TypeError("勤務区間には職員IDを指定してください。");
    validateScheduleDay({ date: segment.date, dayType: "work", segments: [] });
    const key = `${segment.staffId}:${segment.date}`;
    const group = grouped.get(key) ?? {
      staffId: segment.staffId,
      date: segment.date,
      segments: [],
    };
    group.segments.push(segment);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map(({ staffId, date, segments }) => {
      const scheduledWorkMinutes = calculateDailyScheduledWorkMinutes(segments);
      return {
        staffId,
        date,
        scheduledWorkMinutes,
        requiredBreakMinutes: resolveRequiredBreakMinutes(scheduledWorkMinutes),
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date)
      || left.staffId.localeCompare(right.staffId));
}
