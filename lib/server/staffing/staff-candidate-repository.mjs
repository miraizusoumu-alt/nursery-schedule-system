export const CURRENT_STAFF_CLASSIFICATION_CAPABILITIES = Object.freeze({
  childcareEligibilityConfigured: true,
  nurseryTeacherQualificationsConfigured: true,
});

export const CURRENT_STAFF_CLASSIFICATION_LIMITATIONS = Object.freeze([]);

export function loadStaffCandidateProfiles(database) {
  const staffRows = database.prepare(
    `SELECT id, staff_code, name, employment_start_date, employment_end_date, status
     FROM staff_members ORDER BY staff_code, id`,
  ).all();
  return staffRows.map((staff) => {
    const assignedRoles = database.prepare(
      `SELECT role_type, valid_from, valid_to
       FROM staff_roles WHERE staff_id = ? ORDER BY valid_from, role_type, id`,
    ).all(staff.id).map((entry) => ({
      type: entry.role_type,
      validFrom: entry.valid_from,
      validTo: entry.valid_to,
    }));
    const validQualifications = database.prepare(
      `SELECT qualification_type, valid_from, valid_to
       FROM staff_qualifications WHERE staff_id = ? ORDER BY valid_from, qualification_type, id`,
    ).all(staff.id).map((entry) => ({
      type: entry.qualification_type,
      validFrom: entry.valid_from,
      validTo: entry.valid_to,
    }));
    const workConditions = database.prepare(
      `SELECT id, valid_from, valid_to, employment_type
       FROM staff_work_condition_versions WHERE staff_id = ? ORDER BY valid_from, created_at, id`,
    ).all(staff.id).map((condition) => ({
      id: condition.id,
      validFrom: condition.valid_from,
      validTo: condition.valid_to,
      employmentType: condition.employment_type,
      availability: database.prepare(
        `SELECT weekday, available, start_time, end_time
         FROM staff_weekly_availability WHERE work_condition_version_id = ? ORDER BY weekday`,
      ).all(condition.id).map((entry) => ({
        weekday: entry.weekday,
        available: Boolean(entry.available),
        startTime: entry.start_time,
        endTime: entry.end_time,
      })),
    }));
    return {
      id: staff.id,
      staffCode: staff.staff_code,
      name: staff.name,
      employmentStartDate: staff.employment_start_date,
      employmentEndDate: staff.employment_end_date,
      status: staff.status,
      assignedRoles,
      validQualifications,
      workConditions,
    };
  });
}
