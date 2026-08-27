import { randomUUID } from "node:crypto";
import { AuthError, requirePermission } from "../auth/permissions.mjs";
import { toIso } from "../auth/time.mjs";
import { weekMaskToOrdinals, weekOrdinalsToMask } from "../staffing/availability-candidates.mjs";

const WEEKDAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const EMPLOYMENT_TYPES = new Set(["常勤", "非常勤"]);
export const STAFF_ROLE_DEFINITIONS = Object.freeze([
  { type: "nursery_teacher_role", label: "保育士" },
  { type: "principal", label: "園長" },
  { type: "manager", label: "マネージャー" },
  { type: "meal_service", label: "配膳" },
  { type: "other", label: "その他" },
]);
export const STAFF_QUALIFICATION_DEFINITIONS = Object.freeze([
  { type: "licensed_nursery_teacher", label: "保育士資格" },
  { type: "childcare_support_worker_local_childcare", label: "子育て支援員研修修了（地域保育コース・地域型保育）" },
]);
export const RESPONSIBILITY_CATEGORIES = Object.freeze(STAFF_ROLE_DEFINITIONS.map(({ label }) => label));
const ROLE_TYPE_SET = new Set(STAFF_ROLE_DEFINITIONS.map(({ type }) => type));
const ROLE_TYPE_BY_LABEL = new Map(STAFF_ROLE_DEFINITIONS.map(({ type, label }) => [label, type]));
const QUALIFICATION_TYPE_SET = new Set(STAFF_QUALIFICATION_DEFINITIONS.map(({ type }) => type));
const STAFF_DAY_START_MINUTES = 6 * 60 + 30;
const STAFF_DAY_END_MINUTES = 20 * 60 + 30;

function transaction(database, run) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function requiredText(value, label, maxLength = 100) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new AuthError("INVALID_INPUT", `${label}を入力してください。`);
  if (normalized.length > maxLength) throw new AuthError("INVALID_INPUT", `${label}が長すぎます。`);
  return normalized;
}

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function requiredDate(value, label) {
  const normalized = String(value ?? "").trim();
  if (!validDateKey(normalized)) throw new AuthError("INVALID_DATE", `${label}はYYYY-MM-DD形式で入力してください。`);
  return normalized;
}

function optionalDate(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return requiredDate(normalized, label);
}

function assertDateRange(start, end, label) {
  if (end && end < start) throw new AuthError("INVALID_DATE_RANGE", `${label}の終了日は開始日以後にしてください。`);
}

function rangesOverlapInclusive(startA, endA, startB, endB) {
  return (!endA || startB <= endA) && (!endB || startA <= endB);
}

function previousDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function tokyoDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function timeToMinutes(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || minutes % 15 !== 0) return null;
  const total = hours * 60 + minutes;
  if (total < STAFF_DAY_START_MINUTES || total > STAFF_DAY_END_MINUTES) return null;
  return total;
}

function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new AuthError("INVALID_INPUT", `${label}は1以上の整数で入力してください。`);
  }
  return normalized;
}

function requiredBoundedInteger(value, label, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new AuthError("INVALID_INPUT", `${label}は${minimum}から${maximum}の整数で入力してください。`);
  }
  return normalized;
}

function requiredQuarterHourMinutes(value, label, maximum) {
  const normalized = requiredBoundedInteger(value, label, 15, maximum);
  if (normalized % 15 !== 0) {
    throw new AuthError("INVALID_INPUT", `${label}は15分単位で入力してください。`);
  }
  return normalized;
}

function normalizeStaff(input, existing = null) {
  const name = requiredText(input?.name, "氏名", 100);
  const employmentStartDate = requiredDate(input?.employmentStartDate, "勤務開始日");
  const employmentEndDate = optionalDate(input?.employmentEndDate, "勤務終了日");
  assertDateRange(employmentStartDate, employmentEndDate, "勤務期間");
  const status = String(input?.status ?? existing?.status ?? "active");
  if (!new Set(["active", "inactive"]).has(status)) throw new AuthError("INVALID_STATUS", "職員の状態を確認してください。");
  return { name, employmentStartDate, employmentEndDate, status };
}

function normalizeQualification(input) {
  const qualificationType = requiredText(input?.qualificationType, "資格・研修", 100);
  if (!QUALIFICATION_TYPE_SET.has(qualificationType)) {
    throw new AuthError("INVALID_QUALIFICATION_TYPE", "資格・研修を選択肢から選んでください。");
  }
  const validFrom = requiredDate(input?.validFrom, "資格・研修の有効開始日");
  const validTo = optionalDate(input?.validTo, "資格・研修の有効終了日");
  assertDateRange(validFrom, validTo, "資格・研修の有効期間");
  return { qualificationType, validFrom, validTo };
}

function normalizeRoleType(value) {
  const normalized = requiredText(value, "担当区分", 100);
  const roleType = ROLE_TYPE_SET.has(normalized) ? normalized : ROLE_TYPE_BY_LABEL.get(normalized);
  if (!roleType) throw new AuthError("INVALID_RESPONSIBILITY_CATEGORY", "担当区分を選択肢から選んでください。");
  return roleType;
}

function normalizeRole(input) {
  const roleType = normalizeRoleType(input?.roleType);
  const validFrom = requiredDate(input?.validFrom, "担当区分の有効開始日");
  const validTo = optionalDate(input?.validTo, "担当区分の有効終了日");
  assertDateRange(validFrom, validTo, "担当区分の有効期間");
  return { roleType, validFrom, validTo };
}

function normalizeResponsibilities(input) {
  if (!Array.isArray(input?.responsibilityTypes) || input.responsibilityTypes.length === 0) {
    throw new AuthError("INVALID_RESPONSIBILITY_CATEGORY", "担当区分を1つ以上選んでください。");
  }
  const responsibilityTypes = [...new Set(input.responsibilityTypes.map(normalizeRoleType))];
  const validFrom = requiredDate(input?.validFrom, "担当区分の有効開始日");
  const validTo = optionalDate(input?.validTo, "担当区分の有効終了日");
  assertDateRange(validFrom, validTo, "担当区分の有効期間");
  return { responsibilityTypes, validFrom, validTo };
}

function normalizeAvailability(input) {
  if (!Array.isArray(input) || input.length !== WEEKDAYS.length) {
    throw new AuthError("INVALID_AVAILABILITY", "日曜日から土曜日までの勤務可能時間を入力してください。");
  }
  const seen = new Set();
  const normalized = input.map((entry) => {
    const weekday = Number(entry?.weekday);
    if (!WEEKDAYS.includes(weekday) || seen.has(weekday)) {
      throw new AuthError("INVALID_WEEKDAY", "曜日の指定が正しくありません。");
    }
    seen.add(weekday);
    const available = entry?.available === true;
    if (!available) {
      return { weekday, available: false, startTime: null, endTime: null, candidates: [] };
    }
    const rawCandidates = Array.isArray(entry?.candidates) && entry.candidates.length > 0
      ? entry.candidates
      : [{ startTime: entry?.startTime, endTime: entry?.endTime, weekOrdinals: null }];
    const duplicateKeys = new Set();
    const candidates = rawCandidates.map((candidate, candidateOrder) => {
      const startTime = String(candidate?.startTime ?? "");
      const endTime = String(candidate?.endTime ?? "");
      const startMinutes = timeToMinutes(startTime);
      const endMinutes = timeToMinutes(endTime);
      if (startMinutes === null || endMinutes === null) {
        throw new AuthError("INVALID_TIME", "勤務可能時間候補は6:30～20:30の15分単位で入力してください。");
      }
      if (startMinutes >= endMinutes) {
        throw new AuthError("INVALID_TIME_RANGE", "勤務可能時間候補の終了は開始より後にしてください。");
      }
      let weekMask;
      try {
        weekMask = weekOrdinalsToMask(candidate?.weekOrdinals);
      } catch {
        throw new AuthError("INVALID_AVAILABILITY_WEEK", "勤務可能時間候補の適用週は毎週または第1～第5から選択してください。");
      }
      const duplicateKey = `${startTime}:${endTime}:${weekMask}`;
      if (duplicateKeys.has(duplicateKey)) {
        throw new AuthError("DUPLICATE_AVAILABILITY_CANDIDATE", "同じ勤務可能時間候補が重複しています。");
      }
      duplicateKeys.add(duplicateKey);
      return {
        candidateOrder,
        startTime,
        endTime,
        weekMask,
        weekOrdinals: weekMaskToOrdinals(weekMask),
      };
    });
    return {
      weekday,
      available: true,
      startTime: candidates[0].startTime,
      endTime: candidates[0].endTime,
      candidates,
    };
  });
  return normalized.sort((a, b) => a.weekday - b.weekday);
}

function normalizeWorkCondition(input) {
  const validFrom = requiredDate(input?.validFrom, "勤務条件の有効開始日");
  const validTo = optionalDate(input?.validTo, "勤務条件の有効終了日");
  assertDateRange(validFrom, validTo, "勤務条件の有効期間");
  const employmentType = requiredText(input?.employmentType, "雇用区分", 50);
  if (!EMPLOYMENT_TYPES.has(employmentType)) {
    throw new AuthError("INVALID_EMPLOYMENT_TYPE", "雇用区分は常勤または非常勤を選択してください。");
  }
  if (input?.holidayWorkAllowed !== undefined && typeof input.holidayWorkAllowed !== "boolean") {
    throw new AuthError("INVALID_INPUT", "祝日の勤務可否を確認してください。");
  }
  const holidayWorkAllowed = input?.holidayWorkAllowed !== false;
  let partTimeConditions = {
    weeklyMinutesLimit: null,
    weeklyMinutesLimitType: null,
    preferredWeeklyWorkDaysMin: null,
    weeklyWorkDaysMax: null,
    dailyWorkMinutesMin: null,
    dailyWorkMinutesMax: null,
  };
  if (employmentType === "非常勤") {
    const weeklyMinutesLimit = requiredQuarterHourMinutes(
      input?.weeklyMinutesLimit,
      "週勤務時間上限",
      7 * 8 * 60,
    );
    const weeklyMinutesLimitType = String(input?.weeklyMinutesLimitType ?? "");
    if (!new Set(["inclusive", "exclusive"]).has(weeklyMinutesLimitType)) {
      throw new AuthError("INVALID_INPUT", "週勤務時間上限は「以内」または「未満」を選択してください。");
    }
    if (weeklyMinutesLimitType === "exclusive" && weeklyMinutesLimit < 30) {
      throw new AuthError("INVALID_INPUT", "「未満」の週勤務時間上限は30分以上で入力してください。");
    }
    const preferredWeeklyWorkDaysMin = requiredBoundedInteger(
      input?.preferredWeeklyWorkDaysMin,
      "週希望最低勤務日数",
      1,
      7,
    );
    const weeklyWorkDaysMax = requiredBoundedInteger(input?.weeklyWorkDaysMax, "週最大勤務日数", 1, 7);
    const dailyWorkMinutesMin = requiredQuarterHourMinutes(input?.dailyWorkMinutesMin, "1日最低勤務時間", 8 * 60);
    const dailyWorkMinutesMax = requiredQuarterHourMinutes(input?.dailyWorkMinutesMax, "1日最大勤務時間", 8 * 60);
    if (preferredWeeklyWorkDaysMin > weeklyWorkDaysMax) {
      throw new AuthError("INVALID_INPUT", "週希望最低勤務日数は週最大勤務日数以下にしてください。");
    }
    if (dailyWorkMinutesMin > dailyWorkMinutesMax) {
      throw new AuthError("INVALID_INPUT", "1日最低勤務時間は1日最大勤務時間以下にしてください。");
    }
    const effectiveWeeklyLimit = weeklyMinutesLimitType === "exclusive"
      ? weeklyMinutesLimit - 15
      : weeklyMinutesLimit;
    if (preferredWeeklyWorkDaysMin * dailyWorkMinutesMin > effectiveWeeklyLimit) {
      throw new AuthError(
        "INVALID_INPUT",
        "週希望最低勤務日数と1日最低勤務時間が週勤務時間上限内に収まりません。",
      );
    }
    partTimeConditions = {
      weeklyMinutesLimit,
      weeklyMinutesLimitType,
      preferredWeeklyWorkDaysMin,
      weeklyWorkDaysMax,
      dailyWorkMinutesMin,
      dailyWorkMinutesMax,
    };
  }
  return {
    validFrom,
    validTo,
    employmentType,
    monthlyMinutesLimit: optionalPositiveInteger(input?.monthlyMinutesLimit, "月間勤務時間上限（分）"),
    maxConsecutiveDays: optionalPositiveInteger(input?.maxConsecutiveDays, "連続勤務日数上限"),
    holidayWorkAllowed,
    ...partTimeConditions,
    availability: normalizeAvailability(input?.availability),
  };
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

export function createStaffManagementService({ database, now = () => new Date() }) {
  function currentDate() {
    return now();
  }

  function requireStaff(staffId) {
    const staff = database.prepare(
      `SELECT id, staff_code, name, employment_start_date, employment_end_date, status, created_at, updated_at
       FROM staff_members WHERE id = ?`,
    ).get(staffId);
    if (!staff) throw new AuthError("NOT_FOUND", "職員が見つかりません。", 404);
    return staff;
  }

  function requireStaffRole(staffId, roleId) {
    const role = database.prepare(
      `SELECT id, staff_id, role_type, valid_from, valid_to, created_at, updated_at
       FROM staff_roles WHERE id = ? AND staff_id = ?`,
    ).get(roleId, staffId);
    if (!role) throw new AuthError("NOT_FOUND", "担当区分が見つかりません。", 404);
    return role;
  }

  function requireStaffQualification(staffId, qualificationId) {
    const qualification = database.prepare(
      `SELECT id, staff_id, qualification_type, valid_from, valid_to, created_at, updated_at
       FROM staff_qualifications WHERE id = ? AND staff_id = ?`,
    ).get(qualificationId, staffId);
    if (!qualification) throw new AuthError("NOT_FOUND", "資格・研修が見つかりません。", 404);
    return qualification;
  }

  function assertRolePeriodAvailable(staffId, roleType, validFrom, validTo, excludedId = null) {
    const overlapping = database.prepare(
      `SELECT id, valid_from, valid_to FROM staff_roles
       WHERE staff_id = ? AND role_type = ? AND (? IS NULL OR id <> ?)` ,
    ).all(staffId, roleType, excludedId, excludedId)
      .some((entry) => rangesOverlapInclusive(validFrom, validTo, entry.valid_from, entry.valid_to));
    if (overlapping) throw new AuthError("OVERLAPPING_STAFF_ROLE", "同じ担当区分に重複する有効期間があります。", 409);
  }

  function assertQualificationPeriodAvailable(staffId, qualificationType, validFrom, validTo, excludedId = null) {
    const overlapping = database.prepare(
      `SELECT id, valid_from, valid_to FROM staff_qualifications
       WHERE staff_id = ? AND qualification_type = ? AND (? IS NULL OR id <> ?)` ,
    ).all(staffId, qualificationType, excludedId, excludedId)
      .some((entry) => rangesOverlapInclusive(validFrom, validTo, entry.valid_from, entry.valid_to));
    if (overlapping) throw new AuthError("OVERLAPPING_STAFF_QUALIFICATION", "同じ資格・研修に重複する有効期間があります。", 409);
  }

  function writeOperation(actor, operation, targetId, detail) {
    database.prepare(
      `INSERT INTO operation_logs
       (id, actor_type, actor_id, operation, target_type, target_id, target_month, detail_json, occurred_at)
       VALUES (?, ?, ?, ?, 'staff_member', ?, NULL, ?, ?)`,
    ).run(randomUUID(), actor.type, actor.id, operation, targetId, safeJson(detail), toIso(currentDate()));
  }

  function nextStaffCode() {
    const codes = database.prepare(
      "SELECT staff_code FROM staff_members WHERE staff_code LIKE 'ST%'",
    ).all();
    let highestNumber = 0;
    for (const { staff_code: code } of codes) {
      const match = /^ST(\d+)$/.exec(code);
      if (!match) continue;
      const number = Number(match[1]);
      if (Number.isSafeInteger(number) && number > highestNumber) highestNumber = number;
    }
    let number = highestNumber + 1;
    while (true) {
      const code = `ST${String(number).padStart(4, "0")}`;
      if (!database.prepare("SELECT 1 FROM staff_members WHERE staff_code = ?").get(code)) return code;
      number += 1;
    }
  }

  function staffManagement(actor) {
    requirePermission(actor, "staff:manage");
    const today = tokyoDateKey(currentDate());
    const staff = database.prepare(
      `SELECT id, staff_code, name, employment_start_date, employment_end_date, status, created_at, updated_at
       FROM staff_members ORDER BY status, staff_code, id`,
    ).all();
    return {
      staff: staff.map((entry) => {
        const roles = database.prepare(
          `SELECT id, role_type, valid_from, valid_to, created_at, updated_at
           FROM staff_roles WHERE staff_id = ? ORDER BY valid_from, role_type, id`,
        ).all(entry.id);
        const qualifications = database.prepare(
          `SELECT id, qualification_type, valid_from, valid_to, created_at, updated_at
           FROM staff_qualifications WHERE staff_id = ? ORDER BY valid_from, qualification_type, id`,
        ).all(entry.id).filter((qualification) => QUALIFICATION_TYPE_SET.has(qualification.qualification_type));
        const conditions = database.prepare(
          `SELECT wc.id, wc.valid_from, wc.valid_to, wc.employment_type,
                  wc.monthly_minutes_limit, wc.max_consecutive_days,
                  wc.weekly_minutes_limit, wc.weekly_minutes_limit_type,
                  wc.preferred_weekly_work_days_min, wc.weekly_work_days_max,
                  wc.daily_work_minutes_min, wc.daily_work_minutes_max,
                  wc.holiday_work_allowed,
                  wc.created_by_administrator_id, a.display_name AS created_by_administrator_name,
                  wc.created_at, wc.updated_at
           FROM staff_work_condition_versions wc
           JOIN administrators a ON a.id = wc.created_by_administrator_id
           WHERE wc.staff_id = ? ORDER BY wc.valid_from, wc.created_at, wc.id`,
        ).all(entry.id).map((condition) => ({
          id: condition.id,
          validFrom: condition.valid_from,
          validTo: condition.valid_to,
          employmentType: condition.employment_type,
          monthlyMinutesLimit: condition.monthly_minutes_limit,
          maxConsecutiveDays: condition.max_consecutive_days,
          weeklyMinutesLimit: condition.weekly_minutes_limit,
          weeklyMinutesLimitType: condition.weekly_minutes_limit_type,
          preferredWeeklyWorkDaysMin: condition.preferred_weekly_work_days_min,
          weeklyWorkDaysMax: condition.weekly_work_days_max,
          dailyWorkMinutesMin: condition.daily_work_minutes_min,
          dailyWorkMinutesMax: condition.daily_work_minutes_max,
          holidayWorkAllowed: Boolean(condition.holiday_work_allowed),
          createdByAdministratorName: condition.created_by_administrator_name,
          createdAt: condition.created_at,
          updatedAt: condition.updated_at,
          availability: database.prepare(
            `SELECT weekday, available, start_time, end_time
             FROM staff_weekly_availability WHERE work_condition_version_id = ? ORDER BY weekday`,
          ).all(condition.id).map((row) => {
            const candidateRows = database.prepare(
              `SELECT candidate_order, start_time, end_time, week_mask
               FROM staff_weekly_availability_candidates
               WHERE work_condition_version_id = ? AND weekday = ?
               ORDER BY candidate_order`,
            ).all(condition.id, row.weekday);
            const candidates = candidateRows.length > 0
              ? candidateRows.map((candidate) => ({
                  candidateOrder: candidate.candidate_order,
                  startTime: candidate.start_time,
                  endTime: candidate.end_time,
                  weekOrdinals: weekMaskToOrdinals(candidate.week_mask),
                }))
              : row.available
                ? [{ candidateOrder: 0, startTime: row.start_time, endTime: row.end_time, weekOrdinals: null }]
                : [];
            return {
              weekday: row.weekday,
              available: Boolean(row.available),
              startTime: candidates[0]?.startTime ?? null,
              endTime: candidates[0]?.endTime ?? null,
              candidates,
            };
          }),
        }));
        const currentCondition = conditions.find((condition) => condition.validFrom <= today && (!condition.validTo || today <= condition.validTo)) ?? null;
        return {
          id: entry.id,
          staffCode: entry.staff_code,
          name: entry.name,
          employmentStartDate: entry.employment_start_date,
          employmentEndDate: entry.employment_end_date,
          status: entry.status,
          createdAt: entry.created_at,
          updatedAt: entry.updated_at,
          roles: roles.map((role) => ({
            id: role.id,
            roleType: role.role_type,
            validFrom: role.valid_from,
            validTo: role.valid_to,
            createdAt: role.created_at,
            updatedAt: role.updated_at,
          })),
          qualifications: qualifications.map((qualification) => ({
            id: qualification.id,
            qualificationType: qualification.qualification_type,
            validFrom: qualification.valid_from,
            validTo: qualification.valid_to,
            createdAt: qualification.created_at,
            updatedAt: qualification.updated_at,
          })),
          conditions,
          currentCondition,
        };
      }),
    };
  }

  function createStaff(actor, input) {
    requirePermission(actor, "staff:manage");
    const profile = normalizeStaff(input);
    const staffId = randomUUID();
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      const staffCode = nextStaffCode();
      database.prepare(
        `INSERT INTO staff_members
         (id, staff_code, name, employment_start_date, employment_end_date, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(staffId, staffCode, profile.name, profile.employmentStartDate, profile.employmentEndDate, profile.status, timestamp, timestamp);
      writeOperation(actor, "staff_member.created", staffId, { staffCode, ...profile, performedAt: timestamp });
    });
    return staffManagement(actor);
  }

  function updateStaff(actor, staffId, input) {
    requirePermission(actor, "staff:manage");
    const existing = requireStaff(staffId);
    const profile = normalizeStaff(input, existing);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE staff_members
         SET name = ?, employment_start_date = ?, employment_end_date = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(profile.name, profile.employmentStartDate, profile.employmentEndDate, profile.status, timestamp, staffId);
      writeOperation(actor, "staff_member.updated", staffId, {
        before: {
          staffCode: existing.staff_code,
          name: existing.name,
          employmentStartDate: existing.employment_start_date,
          employmentEndDate: existing.employment_end_date,
          status: existing.status,
        },
        after: { staffCode: existing.staff_code, ...profile },
        performedAt: timestamp,
      });
    });
    return staffManagement(actor);
  }

  function addQualification(actor, staffId, input) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const qualification = normalizeQualification(input);
    assertQualificationPeriodAvailable(
      staffId,
      qualification.qualificationType,
      qualification.validFrom,
      qualification.validTo,
    );
    const qualificationId = randomUUID();
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `INSERT INTO staff_qualifications
         (id, staff_id, qualification_type, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(qualificationId, staffId, qualification.qualificationType, qualification.validFrom, qualification.validTo, timestamp, timestamp);
      writeOperation(actor, "staff_qualification.created", staffId, { qualificationId, ...qualification, performedAt: timestamp });
    });
    return staffManagement(actor);
  }

  function updateQualification(actor, staffId, qualificationId, input) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const existing = requireStaffQualification(staffId, qualificationId);
    const qualification = normalizeQualification(input);
    assertQualificationPeriodAvailable(
      staffId,
      qualification.qualificationType,
      qualification.validFrom,
      qualification.validTo,
      qualificationId,
    );
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE staff_qualifications
         SET qualification_type = ?, valid_from = ?, valid_to = ?, updated_at = ?
         WHERE id = ? AND staff_id = ?`,
      ).run(
        qualification.qualificationType,
        qualification.validFrom,
        qualification.validTo,
        timestamp,
        qualificationId,
        staffId,
      );
      writeOperation(actor, "staff_qualification.updated", staffId, {
        qualificationId,
        before: {
          qualificationType: existing.qualification_type,
          validFrom: existing.valid_from,
          validTo: existing.valid_to,
        },
        after: qualification,
        performedAt: timestamp,
      });
    });
    return staffManagement(actor);
  }

  function deleteQualification(actor, staffId, qualificationId) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const existing = requireStaffQualification(staffId, qualificationId);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare("DELETE FROM staff_qualifications WHERE id = ? AND staff_id = ?").run(qualificationId, staffId);
      writeOperation(actor, "staff_qualification.deleted", staffId, {
        qualificationId,
        qualificationType: existing.qualification_type,
        validFrom: existing.valid_from,
        validTo: existing.valid_to,
        performedAt: timestamp,
      });
    });
    return staffManagement(actor);
  }

  function addResponsibilities(actor, staffId, input) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const responsibilities = normalizeResponsibilities(input);
    const timestamp = toIso(currentDate());
    const created = [];
    transaction(database, () => {
      for (const roleType of responsibilities.responsibilityTypes) {
        const duplicate = database.prepare(
          `SELECT id FROM staff_roles
           WHERE staff_id = ? AND role_type = ? AND valid_from = ?`,
        ).get(staffId, roleType, responsibilities.validFrom);
        if (duplicate) continue;
        assertRolePeriodAvailable(staffId, roleType, responsibilities.validFrom, responsibilities.validTo);
        const roleId = randomUUID();
        database.prepare(
          `INSERT INTO staff_roles
           (id, staff_id, role_type, valid_from, valid_to, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          roleId, staffId, roleType,
          responsibilities.validFrom, responsibilities.validTo, timestamp, timestamp,
        );
        created.push({ roleId, roleType });
      }
      if (created.length) {
        writeOperation(actor, "staff_responsibilities.created", staffId, {
          responsibilities: created,
          validFrom: responsibilities.validFrom,
          validTo: responsibilities.validTo,
          performedAt: timestamp,
        });
      }
    });
    return staffManagement(actor);
  }

  function updateRole(actor, staffId, roleId, input) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const existing = requireStaffRole(staffId, roleId);
    const role = normalizeRole(input);
    assertRolePeriodAvailable(staffId, role.roleType, role.validFrom, role.validTo, roleId);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare(
        `UPDATE staff_roles SET role_type = ?, valid_from = ?, valid_to = ?, updated_at = ?
         WHERE id = ? AND staff_id = ?`,
      ).run(role.roleType, role.validFrom, role.validTo, timestamp, roleId, staffId);
      writeOperation(actor, "staff_role.updated", staffId, {
        roleId,
        before: { roleType: existing.role_type, validFrom: existing.valid_from, validTo: existing.valid_to },
        after: role,
        performedAt: timestamp,
      });
    });
    return staffManagement(actor);
  }

  function deleteRole(actor, staffId, roleId) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const existing = requireStaffRole(staffId, roleId);
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      database.prepare("DELETE FROM staff_roles WHERE id = ? AND staff_id = ?").run(roleId, staffId);
      writeOperation(actor, "staff_role.deleted", staffId, {
        roleId,
        roleType: existing.role_type,
        validFrom: existing.valid_from,
        validTo: existing.valid_to,
        performedAt: timestamp,
      });
    });
    return staffManagement(actor);
  }

  function createWorkConditionVersion(actor, staffId, input) {
    requirePermission(actor, "staff:manage");
    requireStaff(staffId);
    const condition = normalizeWorkCondition(input);
    const conditionId = randomUUID();
    const timestamp = toIso(currentDate());
    transaction(database, () => {
      const existing = database.prepare(
        `SELECT id, valid_from, valid_to FROM staff_work_condition_versions
         WHERE staff_id = ? ORDER BY valid_from, created_at, id`,
      ).all(staffId);
      const closable = existing.filter((entry) => entry.valid_to === null && entry.valid_from < condition.validFrom).at(-1) ?? null;
      const closedAt = closable ? previousDate(condition.validFrom) : null;
      for (const entry of existing) {
        const effectiveEnd = entry.id === closable?.id ? closedAt : entry.valid_to;
        if (rangesOverlapInclusive(condition.validFrom, condition.validTo, entry.valid_from, effectiveEnd)) {
          throw new AuthError("OVERLAPPING_WORK_CONDITION", "同じ職員の勤務条件に重複する有効期間があります。", 409);
        }
      }
      if (closable) {
        database.prepare(
          "UPDATE staff_work_condition_versions SET valid_to = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL",
        ).run(closedAt, timestamp, closable.id);
      }
      database.prepare(
        `INSERT INTO staff_work_condition_versions
         (id, staff_id, valid_from, valid_to, employment_type, monthly_minutes_limit,
          max_consecutive_days, weekly_minutes_limit, weekly_minutes_limit_type,
          preferred_weekly_work_days_min, weekly_work_days_max, daily_work_minutes_min,
          daily_work_minutes_max, holiday_work_allowed, created_by_administrator_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        conditionId, staffId, condition.validFrom, condition.validTo, condition.employmentType,
        condition.monthlyMinutesLimit, condition.maxConsecutiveDays,
        condition.weeklyMinutesLimit, condition.weeklyMinutesLimitType,
        condition.preferredWeeklyWorkDaysMin, condition.weeklyWorkDaysMax,
        condition.dailyWorkMinutesMin, condition.dailyWorkMinutesMax,
        condition.holidayWorkAllowed ? 1 : 0,
        actor.id, timestamp, timestamp,
      );
      const insertAvailability = database.prepare(
        `INSERT INTO staff_weekly_availability
         (work_condition_version_id, weekday, available, start_time, end_time, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertAvailabilityCandidate = database.prepare(
        `INSERT INTO staff_weekly_availability_candidates
         (work_condition_version_id, weekday, candidate_order, start_time, end_time, week_mask, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const availability of condition.availability) {
        insertAvailability.run(
          conditionId,
          availability.weekday,
          availability.available ? 1 : 0,
          availability.startTime,
          availability.endTime,
          timestamp,
        );
        for (const candidate of availability.candidates) {
          insertAvailabilityCandidate.run(
            conditionId,
            availability.weekday,
            candidate.candidateOrder,
            candidate.startTime,
            candidate.endTime,
            candidate.weekMask,
            timestamp,
          );
        }
      }
      writeOperation(actor, "staff_work_condition.created", staffId, {
        conditionId,
        closedPreviousConditionId: closable?.id ?? null,
        ...condition,
        performedAt: timestamp,
      });
    });
    return staffManagement(actor);
  }

  return {
    addQualification,
    addResponsibilities,
    createStaff,
    createWorkConditionVersion,
    deleteQualification,
    deleteRole,
    staffManagement,
    updateQualification,
    updateRole,
    updateStaff,
  };
}
