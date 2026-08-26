import {
  countsAsScheduledWorkDay,
  evaluateConsecutiveWorkLimitForDate,
} from "./scheduled-work.mjs";

function activeOnDate(period, date) {
  return period.validFrom <= date && (!period.validTo || date <= period.validTo);
}

function weekdayNumber(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function timeToMinutes(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || minutes % 15 !== 0) return null;
  return hours * 60 + minutes;
}

function activeTypes(records, date) {
  return (records ?? [])
    .filter((role) => activeOnDate(role, date))
    .map((role) => role.type);
}

export function resolveStaffEffectiveAvailability({ weeklyAvailability, preference }) {
  if (preference?.preferenceType === "day_off") {
    return { source: "preference", available: false, startTime: null, endTime: null };
  }
  if (preference?.preferenceType === "work_time") {
    return {
      source: "preference",
      available: true,
      startTime: preference.startTime,
      endTime: preference.endTime,
    };
  }
  return weeklyAvailability?.available
    ? {
        source: "weekly",
        available: true,
        startTime: weeklyAvailability.startTime,
        endTime: weeklyAvailability.endTime,
      }
    : { source: "weekly", available: false, startTime: null, endTime: null };
}

function evaluateStaffForQuarterHourSlot(staff, slot, options = {}) {
  const slotStart = timeToMinutes(slot?.startTime);
  const slotEnd = timeToMinutes(slot?.endTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot?.date ?? "") || slotStart === null || slotEnd === null || slotEnd - slotStart !== 15) {
    throw new TypeError("職員候補判定にはYYYY-MM-DDの日付と15分枠を指定してください。");
  }

  const isEmployedOnDate = staff.employmentStartDate <= slot.date
    && (!staff.employmentEndDate || slot.date <= staff.employmentEndDate);
  const isActive = staff.status === "active";
  const isActiveOnDate = isEmployedOnDate && isActive;
  const activeConditions = (staff.workConditions ?? []).filter((condition) => activeOnDate(condition, slot.date));
  const workCondition = activeConditions.length === 1 ? activeConditions[0] : null;
  const weeklyAvailability = workCondition?.availability?.find((entry) => entry.weekday === weekdayNumber(slot.date)) ?? null;
  const preference = options.usePreferences
    ? (staff.schedulePreferences ?? []).find((entry) => entry.date === slot.date) ?? null
    : null;
  const effectiveAvailability = resolveStaffEffectiveAvailability({ weeklyAvailability, preference });
  const isAvailableOnWeekday = Boolean(weeklyAvailability?.available);
  const isAvailableForDate = Boolean(effectiveAvailability.available);
  const availableStart = timeToMinutes(effectiveAvailability.startTime);
  const availableEnd = timeToMinutes(effectiveAvailability.endTime);
  const isWithinAvailableTime = isAvailableForDate
    && availableStart !== null
    && availableEnd !== null
    && slotStart >= availableStart
    && slotEnd <= availableEnd;

  const assignedRoles = activeTypes(staff.assignedRoles, slot.date);
  const validQualifications = activeTypes(staff.validQualifications, slot.date);
  const isLicensedNurseryTeacher = validQualifications.includes("licensed_nursery_teacher");
  const isEligibleChildcareWorker = isLicensedNurseryTeacher
    || validQualifications.includes("childcare_support_worker_local_childcare");
  const requiredRoleTypes = options.requiredRoleTypes ?? slot.requiredRoleTypes ?? [];
  const requiredQualificationTypes = options.requiredQualificationTypes ?? slot.requiredQualificationTypes ?? [];
  const meetsRequiredRoleConditions = requiredRoleTypes.every((type) => assignedRoles.includes(type));
  const meetsRequiredQualificationConditions = requiredQualificationTypes.every((type) => validQualifications.includes(type));
  const existingScheduleDay = (staff.scheduledDays ?? []).find((day) => day.date === slot.date) ?? null;
  const hasProtectedNonWorkSchedule = Boolean(existingScheduleDay)
    && !countsAsScheduledWorkDay(existingScheduleDay);
  const consecutiveWork = options.enforceConsecutiveWorkLimit
    ? evaluateConsecutiveWorkLimitForDate(staff.scheduledDays ?? [], slot.date, {
        staffId: staff.id,
        priorDays: options.priorDays ?? [],
      })
    : {
        proposedDate: slot.date,
        startDate: slot.date,
        endDate: slot.date,
        consecutiveDays: null,
        maxConsecutiveDays: null,
        violatesLimit: false,
      };
  const exclusionReasons = [];
  if (!isEmployedOnDate) exclusionReasons.push("NOT_EMPLOYED_ON_DATE");
  if (!isActive) exclusionReasons.push("INACTIVE");
  if (activeConditions.length === 0) exclusionReasons.push("NO_ACTIVE_WORK_CONDITION");
  if (activeConditions.length > 1) exclusionReasons.push("AMBIGUOUS_WORK_CONDITION");
  if (preference?.preferenceType === "day_off") exclusionReasons.push("PREFERENCE_DAY_OFF");
  else if (preference?.preferenceType === "work_time" && !isWithinAvailableTime) exclusionReasons.push("OUTSIDE_PREFERENCE_TIME");
  else if (workCondition && !isAvailableOnWeekday) exclusionReasons.push("WEEKDAY_NOT_AVAILABLE");
  else if (isAvailableOnWeekday && !isWithinAvailableTime) exclusionReasons.push("OUTSIDE_AVAILABLE_TIME");
  if (!isEligibleChildcareWorker) exclusionReasons.push("NO_VALID_CHILDCARE_CREDENTIAL");
  if (!meetsRequiredRoleConditions) exclusionReasons.push("MISSING_REQUIRED_ROLE");
  if (!meetsRequiredQualificationConditions) exclusionReasons.push("MISSING_REQUIRED_QUALIFICATION");
  if (hasProtectedNonWorkSchedule) exclusionReasons.push("EXISTING_NON_WORK_DAY");
  if (consecutiveWork.violatesLimit) exclusionReasons.push("CONSECUTIVE_WORK_LIMIT");

  const eligible = isActiveOnDate
    && Boolean(workCondition)
    && isAvailableForDate
    && isWithinAvailableTime
    && isEligibleChildcareWorker
    && meetsRequiredRoleConditions
    && meetsRequiredQualificationConditions
    && !hasProtectedNonWorkSchedule
    && !consecutiveWork.violatesLimit;
  const licensedExclusionReasons = [...exclusionReasons];
  if (!isLicensedNurseryTeacher) licensedExclusionReasons.push("LICENSE_NOT_VALID");

  return {
    staffId: staff.id,
    staffCode: staff.staffCode,
    staffName: staff.name,
    employmentType: workCondition?.employmentType ?? null,
    assignedRoles,
    validQualifications,
    isEmployedOnDate,
    isActiveOnDate,
    isAvailableOnWeekday,
    isAvailableForDate,
    isWithinAvailableTime,
    effectiveAvailability,
    hasDayOffPreference: preference?.preferenceType === "day_off",
    hasWorkTimePreference: preference?.preferenceType === "work_time",
    preferenceType: preference?.preferenceType ?? "none",
    isEligibleChildcareWorker,
    isLicensedNurseryTeacher,
    meetsRequiredRoleConditions,
    meetsRequiredQualificationConditions,
    existingScheduleDayType: existingScheduleDay?.dayType ?? null,
    hasProtectedNonWorkSchedule,
    violatesConsecutiveWorkLimit: consecutiveWork.violatesLimit,
    consecutiveWork,
    preliminaryEligible: isActiveOnDate
      && Boolean(workCondition)
      && isAvailableForDate
      && isWithinAvailableTime
      && meetsRequiredRoleConditions
      && meetsRequiredQualificationConditions
      && !consecutiveWork.violatesLimit,
    eligible,
    automaticPlacementEligible: eligible,
    licensedEligible: eligible && isLicensedNurseryTeacher,
    exclusionReasons,
    licensedExclusionReasons,
  };
}

export function evaluateStaffEligibilityForQuarterHourSlot(staff, slot) {
  return evaluateStaffForQuarterHourSlot(staff, slot);
}

export function evaluateStaffAutomaticPlacementEligibilityForQuarterHourSlot(staff, slot, options = {}) {
  return evaluateStaffForQuarterHourSlot(staff, slot, {
    ...options,
    usePreferences: true,
    enforceConsecutiveWorkLimit: true,
  });
}

export function connectRequirementWithStaffCandidates(requirement, evaluations, capabilities) {
  const childcareReady = capabilities?.childcareEligibilityConfigured === true;
  const licensedReady = childcareReady && capabilities?.nurseryTeacherQualificationsConfigured === true;
  const eligibleStaff = childcareReady ? evaluations.filter((entry) => entry.eligible) : null;
  const eligibleLicensedStaff = licensedReady ? evaluations.filter((entry) => entry.licensedEligible) : null;
  const eligibleChildcareWorkerCount = eligibleStaff?.length ?? null;
  const eligibleLicensedNurseryTeacherCount = eligibleLicensedStaff?.length ?? null;
  return {
    ...requirement,
    childcareCandidateAssessmentStatus: childcareReady ? "READY" : "NOT_CONFIGURED",
    licensedCandidateAssessmentStatus: licensedReady ? "READY" : "NOT_CONFIGURED",
    eligibleChildcareWorkerCount,
    eligibleLicensedNurseryTeacherCount,
    childcareWorkerShortage: eligibleChildcareWorkerCount === null
      ? null
      : Math.max(0, requirement.requiredChildcareWorkers - eligibleChildcareWorkerCount),
    licensedNurseryTeacherShortage: eligibleLicensedNurseryTeacherCount === null
      ? null
      : Math.max(0, requirement.requiredLicensedNurseryTeachers - eligibleLicensedNurseryTeacherCount),
    preliminaryEligibleStaff: evaluations.filter((entry) => entry.preliminaryEligible),
    eligibleStaff,
    eligibleLicensedStaff,
    staffEvaluations: evaluations,
  };
}
