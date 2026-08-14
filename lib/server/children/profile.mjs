function field(record, snakeCase, camelCase) {
  return record?.[snakeCase] ?? record?.[camelCase] ?? null;
}

function displayPart(value) {
  return typeof value === "string" ? value.trim() : "";
}

function dateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function rangeContainsDate(start, end, targetDate) {
  const target = dateKey(targetDate);
  const from = start ? dateKey(start) : null;
  const to = end ? dateKey(end) : null;
  if (!target || (start && !from) || (end && !to)) return false;
  return (!from || from <= target) && (!to || to >= target);
}

function rangeOverlaps(start, end, firstDate, lastDate) {
  const from = start ? dateKey(start) : null;
  const to = end ? dateKey(end) : null;
  if ((start && !from) || (end && !to)) return false;
  return (!from || from <= lastDate) && (!to || to >= firstDate);
}

export function resolveChildIdentity(child) {
  const lastName = displayPart(field(child, "last_name", "lastName"));
  const firstName = displayPart(field(child, "first_name", "firstName"));
  const lastNameKana = displayPart(field(child, "last_name_kana", "lastNameKana"));
  const firstNameKana = displayPart(field(child, "first_name_kana", "firstNameKana"));
  const legacyName = displayPart(field(child, "name", "name"));
  const legacyKana = displayPart(field(child, "kana", "kana"));

  return {
    name: lastName && firstName ? `${lastName} ${firstName}` : legacyName,
    kana: lastNameKana && firstNameKana ? `${lastNameKana} ${firstNameKana}` : legacyKana,
  };
}

export function childActiveOnDate(child, targetDate) {
  return rangeContainsDate(
    field(child, "enrollment_date", "enrollmentDate"),
    field(child, "withdrawal_date", "withdrawalDate"),
    targetDate,
  ) && rangeContainsDate(
    field(child, "family_active_from", "familyActiveFrom"),
    field(child, "family_active_to", "familyActiveTo"),
    targetDate,
  );
}

export function childOverlapsMonth(child, targetMonth) {
  if (typeof targetMonth !== "string" || !/^\d{4}-\d{2}$/.test(targetMonth)) return false;
  const [year, month] = targetMonth.split("-").map(Number);
  const firstDate = `${targetMonth}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDate = `${targetMonth}-${String(lastDay).padStart(2, "0")}`;
  return rangeOverlaps(
    field(child, "enrollment_date", "enrollmentDate"),
    field(child, "withdrawal_date", "withdrawalDate"),
    firstDate,
    lastDate,
  ) && rangeOverlaps(
    field(child, "family_active_from", "familyActiveFrom"),
    field(child, "family_active_to", "familyActiveTo"),
    firstDate,
    lastDate,
  );
}
