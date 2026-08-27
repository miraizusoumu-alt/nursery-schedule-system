import { weekMaskToOrdinals } from "./availability-candidates.mjs";

export const CURRENT_STAFF_CLASSIFICATION_CAPABILITIES = Object.freeze({
  childcareEligibilityConfigured: true,
  nurseryTeacherQualificationsConfigured: true,
});

export const CURRENT_STAFF_CLASSIFICATION_LIMITATIONS = Object.freeze([]);

export function loadStaffCandidateProfiles(database) {
  const nationalHolidays = database.prepare(
    `SELECT holiday_date, name, source
     FROM national_holidays ORDER BY holiday_date`,
  ).all().map((holiday) => ({
    holidayDate: holiday.holiday_date,
    name: holiday.name,
    source: holiday.source,
  }));
  const availableScheduleMonths = database.prepare(
    `SELECT target_month FROM staff_schedule_months
     WHERE current_version_id IS NOT NULL ORDER BY target_month`,
  ).all().map((entry) => entry.target_month);
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
      `SELECT id, valid_from, valid_to, employment_type,
              weekly_minutes_limit, weekly_minutes_limit_type,
              preferred_weekly_work_days_min, weekly_work_days_max,
              daily_work_minutes_min, daily_work_minutes_max, holiday_work_allowed
       FROM staff_work_condition_versions WHERE staff_id = ? ORDER BY valid_from, created_at, id`,
    ).all(staff.id).map((condition) => ({
      id: condition.id,
      validFrom: condition.valid_from,
      validTo: condition.valid_to,
      employmentType: condition.employment_type,
      weeklyMinutesLimit: condition.weekly_minutes_limit,
      weeklyMinutesLimitType: condition.weekly_minutes_limit_type,
      preferredWeeklyWorkDaysMin: condition.preferred_weekly_work_days_min,
      weeklyWorkDaysMax: condition.weekly_work_days_max,
      dailyWorkMinutesMin: condition.daily_work_minutes_min,
      dailyWorkMinutesMax: condition.daily_work_minutes_max,
      holidayWorkAllowed: Boolean(condition.holiday_work_allowed),
      availability: database.prepare(
        `SELECT weekday, available, start_time, end_time
         FROM staff_weekly_availability WHERE work_condition_version_id = ? ORDER BY weekday`,
      ).all(condition.id).map((entry) => {
        const candidateRows = database.prepare(
          `SELECT candidate_order, start_time, end_time, week_mask
           FROM staff_weekly_availability_candidates
           WHERE work_condition_version_id = ? AND weekday = ?
           ORDER BY candidate_order`,
        ).all(condition.id, entry.weekday);
        const candidates = candidateRows.length > 0
          ? candidateRows.map((candidate) => ({
              candidateId: `${condition.id}:${entry.weekday}:${candidate.candidate_order}`,
              candidateOrder: candidate.candidate_order,
              startTime: candidate.start_time,
              endTime: candidate.end_time,
              weekMask: candidate.week_mask,
              weekOrdinals: weekMaskToOrdinals(candidate.week_mask),
            }))
          : entry.available
            ? [{
                candidateId: `${condition.id}:${entry.weekday}:0`,
                candidateOrder: 0,
                startTime: entry.start_time,
                endTime: entry.end_time,
                weekMask: 31,
                weekOrdinals: null,
              }]
            : [];
        return {
          workConditionVersionId: condition.id,
          weekday: entry.weekday,
          available: Boolean(entry.available),
          startTime: candidates[0]?.startTime ?? null,
          endTime: candidates[0]?.endTime ?? null,
          candidates,
        };
      }),
    }));
    const schedulePreferences = database.prepare(
      `SELECT date, preference_type, start_time, end_time
       FROM staff_schedule_preferences WHERE staff_id = ? ORDER BY date`,
    ).all(staff.id).map((entry) => ({
      date: entry.date,
      preferenceType: entry.preference_type,
      startTime: entry.start_time,
      endTime: entry.end_time,
    }));
    const scheduledDays = database.prepare(
      `SELECT d.id, d.date, d.day_type
       FROM staff_schedule_days d
       JOIN staff_schedule_versions v ON v.id = d.version_id
       JOIN staff_schedule_months m
         ON m.id = v.schedule_month_id AND m.current_version_id = v.id
       WHERE d.staff_id = ? ORDER BY d.date, d.id`,
    ).all(staff.id).map((day) => ({
      staffId: staff.id,
      date: day.date,
      dayType: day.day_type,
      segments: database.prepare(
        `SELECT start_time, end_time, activity_type
         FROM staff_schedule_segments WHERE schedule_day_id = ? ORDER BY start_time, end_time, id`,
      ).all(day.id).map((segment) => ({
        startTime: segment.start_time,
        endTime: segment.end_time,
        activityType: segment.activity_type,
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
      nationalHolidays,
      workConditions,
      schedulePreferences,
      scheduledDays,
      availableScheduleMonths,
    };
  });
}
