const TOKYO_TIME_ZONE = "Asia/Tokyo";

export function toIso(now) {
  return now.toISOString();
}

export function addMinutes(now, minutes) {
  return new Date(now.getTime() + minutes * 60_000);
}

export function tokyoDateKey(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isStopDateEffective(stopDate, now) {
  return typeof stopDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stopDate) && tokyoDateKey(now) >= stopDate;
}

export function isStartDateReached(startDate, now) {
  return typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || tokyoDateKey(now) >= startDate;
}

export function isIsoDate(value) {
  if (value === null || value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
