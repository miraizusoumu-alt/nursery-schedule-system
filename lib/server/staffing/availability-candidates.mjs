export const ALL_WEEK_ORDINALS = Object.freeze([1, 2, 3, 4, 5]);
export const ALL_WEEK_ORDINALS_MASK = 31;

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function timeToMinutes(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)
    || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function weekOrdinalForDate(dateKey) {
  if (!validDateKey(dateKey)) throw new TypeError("第何週かを判定する日付はYYYY-MM-DD形式で指定してください。");
  return Math.floor((Number(dateKey.slice(8, 10)) - 1) / 7) + 1;
}

export function weekOrdinalsToMask(weekOrdinals) {
  if (weekOrdinals === null || weekOrdinals === undefined) return ALL_WEEK_ORDINALS_MASK;
  if (!Array.isArray(weekOrdinals) || weekOrdinals.length === 0) {
    throw new TypeError("適用週は毎週または第1～第5から1つ以上選択してください。");
  }
  const unique = [...new Set(weekOrdinals.map(Number))].sort((left, right) => left - right);
  if (unique.some((ordinal) => !ALL_WEEK_ORDINALS.includes(ordinal))) {
    throw new TypeError("適用週は第1～第5で指定してください。");
  }
  return unique.reduce((mask, ordinal) => mask | (1 << (ordinal - 1)), 0);
}

export function weekMaskToOrdinals(weekMask) {
  const normalized = Number(weekMask);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > ALL_WEEK_ORDINALS_MASK) {
    throw new TypeError("勤務可能時間候補の適用週が正しくありません。");
  }
  if (normalized === ALL_WEEK_ORDINALS_MASK) return null;
  return ALL_WEEK_ORDINALS.filter((ordinal) => (normalized & (1 << (ordinal - 1))) !== 0);
}

function candidateWeekMask(candidate) {
  return candidate?.weekMask === undefined
    ? weekOrdinalsToMask(candidate?.weekOrdinals)
    : Number(candidate.weekMask);
}

function normalizeCandidate(candidate, fallbackOrder, fallbackId) {
  const startTime = candidate?.startTime;
  const endTime = candidate?.endTime;
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  const weekMask = candidateWeekMask(candidate);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    throw new TypeError("勤務可能時間候補の開始・終了時刻が正しくありません。");
  }
  if (!Number.isInteger(weekMask) || weekMask < 1 || weekMask > ALL_WEEK_ORDINALS_MASK) {
    throw new TypeError("勤務可能時間候補の適用週が正しくありません。");
  }
  const candidateOrder = Number.isInteger(candidate?.candidateOrder)
    ? candidate.candidateOrder
    : fallbackOrder;
  return {
    ...candidate,
    candidateId: candidate?.candidateId ?? fallbackId,
    candidateOrder,
    startTime,
    endTime,
    startMinutes,
    endMinutes,
    weekMask,
    weekOrdinals: weekMaskToOrdinals(weekMask),
  };
}

export function availabilityCandidatesForDate(weeklyAvailability, dateKey) {
  if (!validDateKey(dateKey)) throw new TypeError("勤務可能時間候補の日付はYYYY-MM-DD形式で指定してください。");
  if (!weeklyAvailability?.available) return [];
  const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  if (Number(weeklyAvailability.weekday) !== weekday) return [];
  const candidates = Array.isArray(weeklyAvailability.candidates)
    && weeklyAvailability.candidates.length > 0
    ? weeklyAvailability.candidates
    : [{
        candidateId: weeklyAvailability.candidateId ?? `legacy:${weekday}:0`,
        candidateOrder: 0,
        startTime: weeklyAvailability.startTime,
        endTime: weeklyAvailability.endTime,
        weekMask: ALL_WEEK_ORDINALS_MASK,
      }];
  const ordinalMask = 1 << (weekOrdinalForDate(dateKey) - 1);
  return candidates
    .map((candidate, index) => normalizeCandidate(
      candidate,
      index,
      `${weeklyAvailability.workConditionVersionId ?? "legacy"}:${weekday}:${index}`,
    ))
    .filter((candidate) => (candidate.weekMask & ordinalMask) !== 0)
    .sort((left, right) => left.candidateOrder - right.candidateOrder
      || left.startMinutes - right.startMinutes
      || left.endMinutes - right.endMinutes
      || left.candidateId.localeCompare(right.candidateId));
}

export function availabilityCandidateCoversRange(candidate, startTime, endTime) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) return false;
  return startMinutes >= candidate.startMinutes && endMinutes <= candidate.endMinutes;
}

export function availabilityCandidatesCoveringRange(weeklyAvailability, dateKey, startTime, endTime) {
  return availabilityCandidatesForDate(weeklyAvailability, dateKey)
    .filter((candidate) => availabilityCandidateCoversRange(candidate, startTime, endTime));
}
