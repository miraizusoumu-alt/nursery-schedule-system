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

export function evaluateStaffEligibilityForQuarterHourSlot(staff, slot) {
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
  const availability = workCondition?.availability?.find((entry) => entry.weekday === weekdayNumber(slot.date)) ?? null;
  const isAvailableOnWeekday = Boolean(availability?.available);
  const availableStart = timeToMinutes(availability?.startTime);
  const availableEnd = timeToMinutes(availability?.endTime);
  const isWithinAvailableTime = isAvailableOnWeekday
    && availableStart !== null
    && availableEnd !== null
    && slotStart >= availableStart
    && slotEnd <= availableEnd;

  const assignedRoles = activeTypes(staff.assignedRoles, slot.date);
  const validQualifications = activeTypes(staff.validQualifications, slot.date);
  const isLicensedNurseryTeacher = validQualifications.includes("licensed_nursery_teacher");
  const isEligibleChildcareWorker = isLicensedNurseryTeacher
    || validQualifications.includes("childcare_support_worker_local_childcare");
  const exclusionReasons = [];
  if (!isEmployedOnDate) exclusionReasons.push("NOT_EMPLOYED_ON_DATE");
  if (!isActive) exclusionReasons.push("INACTIVE");
  if (activeConditions.length === 0) exclusionReasons.push("NO_ACTIVE_WORK_CONDITION");
  if (activeConditions.length > 1) exclusionReasons.push("AMBIGUOUS_WORK_CONDITION");
  if (workCondition && !isAvailableOnWeekday) exclusionReasons.push("WEEKDAY_NOT_AVAILABLE");
  if (isAvailableOnWeekday && !isWithinAvailableTime) exclusionReasons.push("OUTSIDE_AVAILABLE_TIME");
  if (!isEligibleChildcareWorker) exclusionReasons.push("NO_VALID_CHILDCARE_CREDENTIAL");

  const eligible = isActiveOnDate
    && Boolean(workCondition)
    && isAvailableOnWeekday
    && isWithinAvailableTime
    && isEligibleChildcareWorker;
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
    isWithinAvailableTime,
    isEligibleChildcareWorker,
    isLicensedNurseryTeacher,
    preliminaryEligible: isActiveOnDate && Boolean(workCondition) && isAvailableOnWeekday && isWithinAvailableTime,
    eligible,
    licensedEligible: eligible && isLicensedNurseryTeacher,
    exclusionReasons,
    licensedExclusionReasons,
  };
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
