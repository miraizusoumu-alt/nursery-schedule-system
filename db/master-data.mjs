import { readFileSync } from "node:fs";

const NATIONAL_HOLIDAY_MIGRATION_PREFIX = "0012_";
const NATIONAL_HOLIDAY_SOURCE_PATH = new URL(
  "./master-data/national-holidays-2026-2027.json",
  import.meta.url,
);

function loadNationalHolidaySnapshot() {
  const snapshot = JSON.parse(readFileSync(NATIONAL_HOLIDAY_SOURCE_PATH, "utf8"));
  if (snapshot.source !== "cabinet_office_japan"
    || snapshot.sourceUrl !== "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"
    || !/^\d{4}-\d{2}-\d{2}T/.test(snapshot.sourceLastModified)
    || !/^[A-F0-9]{64}$/.test(snapshot.sourceDataSha256)
    || JSON.stringify(snapshot.years) !== JSON.stringify([2026, 2027])
    || !Array.isArray(snapshot.holidays)
    || snapshot.holidays.length !== 35) {
    throw new Error("内閣府の祝日マスタースナップショットが正しくありません。");
  }

  const seenDates = new Set();
  let previousDate = "";
  for (const holiday of snapshot.holidays) {
    const year = Number(holiday?.holidayDate?.slice(0, 4));
    const [dateYear, month, day] = (holiday?.holidayDate ?? "").split("-").map(Number);
    const parsed = new Date(Date.UTC(dateYear, month - 1, day));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday?.holidayDate ?? "")
      || !snapshot.years.includes(year)
      || parsed.getUTCFullYear() !== dateYear
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day
      || typeof holiday?.name !== "string"
      || !holiday.name.trim()
      || seenDates.has(holiday.holidayDate)
      || holiday.holidayDate <= previousDate) {
      throw new Error("内閣府の祝日マスターデータに不正または重複した日付があります。");
    }
    seenDates.add(holiday.holidayDate);
    previousDate = holiday.holidayDate;
  }
  return snapshot;
}

export function applyMasterDataForMigration(database, migrationName) {
  if (!migrationName.startsWith(NATIONAL_HOLIDAY_MIGRATION_PREFIX)) return;
  const snapshot = loadNationalHolidaySnapshot();
  const insert = database.prepare(
    `INSERT INTO national_holidays
     (holiday_date, name, source, source_url, source_last_modified, source_data_sha256)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const holiday of snapshot.holidays) {
    insert.run(
      holiday.holidayDate,
      holiday.name,
      snapshot.source,
      snapshot.sourceUrl,
      snapshot.sourceLastModified,
      snapshot.sourceDataSha256,
    );
  }
}
