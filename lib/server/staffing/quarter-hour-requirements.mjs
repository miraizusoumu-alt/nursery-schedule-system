const DEFAULT_SHIFT_START_MINUTES = 6 * 60 + 30;
const DEFAULT_SHIFT_END_MINUTES = 20 * 60 + 30;
const DEFAULT_REQUIREMENT_START_MINUTES = 7 * 60;
const DEFAULT_REQUIREMENT_END_MINUTES = 20 * 60;

function timeToMinutes(value, step, label) {
  if (typeof value !== "string" || !/^\d{1,2}:\d{2}$/.test(value)) {
    throw new TypeError(`${label}はHH:mm形式で指定してください。`);
  }
  const [hours, minutes] = value.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || minutes % step !== 0) {
    throw new TypeError(`${label}は${step}分単位で指定してください。`);
  }
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label}は0以上の整数で指定してください。`);
  return value;
}

function sourceSlot(date, time, requirement, withinRequirementRange) {
  return {
    date,
    time,
    requiredChildcareWorkers: requirement?.requiredChildcareWorkers ?? 0,
    requiredLicensedNurseryTeachers: requirement?.requiredLicensedNurseryTeachers ?? 0,
    withinRequirementRange,
  };
}

export function aggregateStaffingRequirementsToQuarterHours(requirements, options = {}) {
  if (!Array.isArray(requirements)) throw new TypeError("5分単位の必要人数を配列で指定してください。");

  const shiftStart = timeToMinutes(options.shiftStartTime ?? "06:30", 15, "シフト開始時刻");
  const shiftEnd = timeToMinutes(options.shiftEndTime ?? "20:30", 15, "シフト終了時刻");
  const requirementStart = timeToMinutes(options.requirementStartTime ?? "07:00", 5, "必要人数開始時刻");
  const requirementEnd = timeToMinutes(options.requirementEndTime ?? "20:00", 5, "必要人数終了時刻");
  if (shiftStart >= shiftEnd || requirementStart > requirementEnd) throw new RangeError("時間範囲が正しくありません。");

  const byDate = new Map();
  for (const entry of requirements) {
    const date = String(entry?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("日付はYYYY-MM-DD形式で指定してください。");
    const minutes = timeToMinutes(entry?.time, 5, "5分枠時刻");
    const requiredChildcareWorkers = nonNegativeInteger(entry?.requiredChildcareWorkers, "必要保育従事者数");
    const requiredLicensedNurseryTeachers = nonNegativeInteger(
      entry?.requiredLicensedNurseryTeachers,
      "必要保育士資格者数",
    );
    if (requiredLicensedNurseryTeachers > requiredChildcareWorkers) {
      throw new RangeError("必要保育士資格者数は必要保育従事者数を超えられません。");
    }
    const entries = byDate.get(date) ?? new Map();
    if (entries.has(minutes)) throw new TypeError(`${date} ${entry.time}の必要人数が重複しています。`);
    entries.set(minutes, { requiredChildcareWorkers, requiredLicensedNurseryTeachers });
    byDate.set(date, entries);
  }

  const quarterHours = [];
  for (const date of [...byDate.keys()].sort()) {
    const entries = byDate.get(date);
    for (let minute = requirementStart; minute <= requirementEnd; minute += 5) {
      if (!entries.has(minute)) throw new TypeError(`${date} ${minutesToTime(minute)}の5分必要人数がありません。`);
    }
    for (let start = shiftStart; start < shiftEnd; start += 15) {
      const sourceFiveMinuteSlots = [start, start + 5, start + 10].map((minute) => {
        const withinRequirementRange = minute >= requirementStart && minute <= requirementEnd;
        return sourceSlot(date, minutesToTime(minute), withinRequirementRange ? entries.get(minute) : null, withinRequirementRange);
      });
      const requiredChildcareWorkers = Math.max(...sourceFiveMinuteSlots.map((entry) => entry.requiredChildcareWorkers));
      const requiredLicensedNurseryTeachers = Math.max(
        ...sourceFiveMinuteSlots.map((entry) => entry.requiredLicensedNurseryTeachers),
      );
      quarterHours.push({
        date,
        startTime: minutesToTime(start),
        endTime: minutesToTime(start + 15),
        requiredChildcareWorkers,
        requiredLicensedNurseryTeachers,
        sourceFiveMinuteSlots,
        maxRequirementReason: {
          childcareWorkerTimes: sourceFiveMinuteSlots
            .filter((entry) => entry.requiredChildcareWorkers === requiredChildcareWorkers)
            .map((entry) => entry.time),
          licensedNurseryTeacherTimes: sourceFiveMinuteSlots
            .filter((entry) => entry.requiredLicensedNurseryTeachers === requiredLicensedNurseryTeachers)
            .map((entry) => entry.time),
        },
      });
    }
  }
  return quarterHours;
}

export const STAFF_SHIFT_TIME_RANGE = Object.freeze({
  startTime: minutesToTime(DEFAULT_SHIFT_START_MINUTES),
  endTime: minutesToTime(DEFAULT_SHIFT_END_MINUTES),
  childRequirementStartTime: minutesToTime(DEFAULT_REQUIREMENT_START_MINUTES),
  childRequirementEndTime: minutesToTime(DEFAULT_REQUIREMENT_END_MINUTES),
});
