import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    familyCode: text("family_code").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: text("issued_at"),
    handedOverAt: text("handed_over_at"),
    stopDate: text("stop_date"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_families_family_code").on(table.familyCode),
    index("idx_families_status").on(table.status),
    check("chk_families_status", sql`${table.status} in ('active', 'stopped')`),
  ],
);

export const familyAccounts = sqliteTable(
  "family_accounts",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
    loginId: text("login_id").notNull(),
    passwordHash: text("password_hash"),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
    temporaryPasswordIssuedAt: text("temporary_password_issued_at"),
    passwordChangedAt: text("password_changed_at"),
    credentialVersion: integer("credential_version").notNull().default(1),
    lastLoginAt: text("last_login_at"),
    stoppedAt: text("stopped_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_family_accounts_family_id").on(table.familyId),
    uniqueIndex("uq_family_accounts_login_id").on(table.loginId),
  ],
);

export const children = sqliteTable(
  "children",
  {
    id: text("id").primaryKey(),
    childCode: text("child_code").notNull(),
    name: text("name").notNull(),
    kana: text("kana").notNull().default(""),
    lastName: text("last_name"),
    firstName: text("first_name"),
    lastNameKana: text("last_name_kana"),
    firstNameKana: text("first_name_kana"),
    className: text("class_name").notNull().default(""),
    birthDate: text("birth_date"),
    enrollmentDate: text("enrollment_date"),
    withdrawalDate: text("withdrawal_date"),
    ageGroupOverride: text("age_group_override"),
    status: text("status").notNull().default("enrolled"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_children_child_code").on(table.childCode),
    index("idx_children_enrollment_dates").on(table.enrollmentDate, table.withdrawalDate),
    check("chk_children_status", sql`${table.status} in ('enrolled', 'withdrawn')`),
  ],
);

export const familyChildren = sqliteTable(
  "family_children",
  {
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
    childId: text("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
    relationshipLabel: text("relationship_label").notNull().default("保護者"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    activeFrom: text("active_from"),
    activeTo: text("active_to"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.familyId, table.childId] }),
    index("idx_family_children_child_id").on(table.childId),
  ],
);

export const administrators = sqliteTable(
  "administrators",
  {
    id: text("id").primaryKey(),
    loginId: text("login_id").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("normal"),
    passwordHash: text("password_hash"),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
    temporaryPasswordIssuedAt: text("temporary_password_issued_at"),
    passwordChangedAt: text("password_changed_at"),
    credentialVersion: integer("credential_version").notNull().default(1),
    lastLoginAt: text("last_login_at"),
    status: text("status").notNull().default("active"),
    stoppedAt: text("stopped_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_administrators_login_id").on(table.loginId),
    check("chk_administrators_role", sql`${table.role} in ('normal', 'master')`),
    check("chk_administrators_status", sql`${table.status} in ('active', 'stopped')`),
  ],
);

export const staffMembers = sqliteTable(
  "staff_members",
  {
    id: text("id").primaryKey(),
    staffCode: text("staff_code").notNull(),
    name: text("name").notNull(),
    employmentStartDate: text("employment_start_date").notNull(),
    employmentEndDate: text("employment_end_date"),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_members_staff_code").on(table.staffCode),
    index("idx_staff_members_status_dates").on(table.status, table.employmentStartDate, table.employmentEndDate),
    check("chk_staff_members_code", sql`length(trim(${table.staffCode})) > 0`),
    check("chk_staff_members_name", sql`length(trim(${table.name})) > 0`),
    check("chk_staff_members_status", sql`${table.status} in ('active', 'inactive')`),
    check(
      "chk_staff_members_employment_dates",
      sql`${table.employmentEndDate} is null or ${table.employmentEndDate} >= ${table.employmentStartDate}`,
    ),
  ],
);

export const staffQualifications = sqliteTable(
  "staff_qualifications",
  {
    id: text("id").primaryKey(),
    staffId: text("staff_id").notNull().references(() => staffMembers.id, { onDelete: "restrict" }),
    qualificationType: text("qualification_type").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_qualifications_staff_type_from").on(table.staffId, table.qualificationType, table.validFrom),
    index("idx_staff_qualifications_staff_dates").on(table.staffId, table.validFrom, table.validTo),
    check("chk_staff_qualifications_type", sql`length(trim(${table.qualificationType})) > 0`),
    check("chk_staff_qualifications_dates", sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`),
  ],
);

export const staffRoles = sqliteTable(
  "staff_roles",
  {
    id: text("id").primaryKey(),
    staffId: text("staff_id").notNull().references(() => staffMembers.id, { onDelete: "restrict" }),
    roleType: text("role_type").notNull(),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_roles_staff_type_from").on(table.staffId, table.roleType, table.validFrom),
    index("idx_staff_roles_staff_dates").on(table.staffId, table.validFrom, table.validTo),
    check(
      "chk_staff_roles_type",
      sql`${table.roleType} in ('nursery_teacher_role', 'principal', 'manager', 'meal_service', 'other')`,
    ),
    check("chk_staff_roles_dates", sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`),
  ],
);

export const staffWorkConditionVersions = sqliteTable(
  "staff_work_condition_versions",
  {
    id: text("id").primaryKey(),
    staffId: text("staff_id").notNull().references(() => staffMembers.id, { onDelete: "restrict" }),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    employmentType: text("employment_type").notNull(),
    monthlyMinutesLimit: integer("monthly_minutes_limit"),
    maxConsecutiveDays: integer("max_consecutive_days"),
    weeklyMinutesLimit: integer("weekly_minutes_limit"),
    weeklyMinutesLimitType: text("weekly_minutes_limit_type"),
    preferredWeeklyWorkDaysMin: integer("preferred_weekly_work_days_min"),
    weeklyWorkDaysMax: integer("weekly_work_days_max"),
    dailyWorkMinutesMin: integer("daily_work_minutes_min"),
    dailyWorkMinutesMax: integer("daily_work_minutes_max"),
    createdByAdministratorId: text("created_by_administrator_id").notNull().references(() => administrators.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_work_conditions_staff_from").on(table.staffId, table.validFrom),
    index("idx_staff_work_conditions_staff_dates").on(table.staffId, table.validFrom, table.validTo),
    check("chk_staff_work_conditions_employment_type", sql`length(trim(${table.employmentType})) > 0`),
    check("chk_staff_work_conditions_dates", sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`),
    check("chk_staff_work_conditions_monthly_limit", sql`${table.monthlyMinutesLimit} is null or ${table.monthlyMinutesLimit} > 0`),
    check("chk_staff_work_conditions_consecutive_days", sql`${table.maxConsecutiveDays} is null or ${table.maxConsecutiveDays} > 0`),
  ],
);

export const staffWeeklyAvailability = sqliteTable(
  "staff_weekly_availability",
  {
    workConditionVersionId: text("work_condition_version_id").notNull().references(() => staffWorkConditionVersions.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    available: integer("available", { mode: "boolean" }).notNull().default(false),
    startTime: text("start_time"),
    endTime: text("end_time"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workConditionVersionId, table.weekday] }),
    check("chk_staff_weekly_availability_weekday", sql`${table.weekday} between 0 and 6`),
    check(
      "chk_staff_weekly_availability_times",
      sql`(${table.available} = 0 and ${table.startTime} is null and ${table.endTime} is null)
          or (${table.available} = 1 and ${table.startTime} is not null and ${table.endTime} is not null and ${table.startTime} < ${table.endTime})`,
    ),
  ],
);

export const staffWeeklyAvailabilityCandidates = sqliteTable(
  "staff_weekly_availability_candidates",
  {
    workConditionVersionId: text("work_condition_version_id").notNull().references(() => staffWorkConditionVersions.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    candidateOrder: integer("candidate_order").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    weekMask: integer("week_mask").notNull().default(31),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workConditionVersionId, table.weekday, table.candidateOrder] }),
    check("chk_staff_availability_candidates_weekday", sql`${table.weekday} between 0 and 6`),
    check("chk_staff_availability_candidates_order", sql`${table.candidateOrder} >= 0`),
    check("chk_staff_availability_candidates_times", sql`${table.startTime} < ${table.endTime}`),
    check("chk_staff_availability_candidates_week_mask", sql`${table.weekMask} between 1 and 31`),
  ],
);

export const staffScheduleMonths = sqliteTable(
  "staff_schedule_months",
  {
    id: text("id").primaryKey(),
    targetMonth: text("target_month").notNull(),
    status: text("status").notNull().default("draft"),
    currentVersionId: text("current_version_id").references((): AnySQLiteColumn => staffScheduleVersions.id, { onDelete: "restrict" }),
    confirmedAt: text("confirmed_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_schedule_months_target_month").on(table.targetMonth),
    index("idx_staff_schedule_months_status").on(table.status, table.targetMonth),
    check(
      "chk_staff_schedule_months_target_month",
      sql`${table.targetMonth} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]' and substr(${table.targetMonth}, 6, 2) between '01' and '12'`,
    ),
    check("chk_staff_schedule_months_status", sql`${table.status} in ('draft', 'confirmed')`),
    check(
      "chk_staff_schedule_months_confirmation",
      sql`(${table.status} = 'draft' and ${table.confirmedAt} is null) or (${table.status} = 'confirmed' and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const staffScheduleVersions = sqliteTable(
  "staff_schedule_versions",
  {
    id: text("id").primaryKey(),
    scheduleMonthId: text("schedule_month_id").notNull().references((): AnySQLiteColumn => staffScheduleMonths.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    source: text("source").notNull().default("manual"),
    status: text("status").notNull().default("draft"),
    sourceVersionId: text("source_version_id").references((): AnySQLiteColumn => staffScheduleVersions.id, { onDelete: "restrict" }),
    createdByAdministratorId: text("created_by_administrator_id").references(() => administrators.id, { onDelete: "restrict" }),
    confirmedByAdministratorId: text("confirmed_by_administrator_id").references(() => administrators.id, { onDelete: "restrict" }),
    confirmedAt: text("confirmed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_staff_schedule_versions_month_number").on(table.scheduleMonthId, table.versionNumber),
    index("idx_staff_schedule_versions_month_status").on(table.scheduleMonthId, table.status, table.versionNumber),
    check("chk_staff_schedule_versions_number", sql`${table.versionNumber} > 0`),
    check("chk_staff_schedule_versions_source", sql`${table.source} in ('manual', 'auto_generated')`),
    check("chk_staff_schedule_versions_status", sql`${table.status} in ('draft', 'confirmed')`),
    check(
      "chk_staff_schedule_versions_confirmation",
      sql`(${table.status} = 'draft' and ${table.confirmedAt} is null) or (${table.status} = 'confirmed' and ${table.confirmedAt} is not null)`,
    ),
  ],
);

export const staffScheduleDays = sqliteTable(
  "staff_schedule_days",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id").notNull().references(() => staffScheduleVersions.id, { onDelete: "restrict" }),
    staffId: text("staff_id").notNull().references(() => staffMembers.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    dayType: text("day_type").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_schedule_days_version_staff_date").on(table.versionId, table.staffId, table.date),
    index("idx_staff_schedule_days_version_date").on(table.versionId, table.date),
    index("idx_staff_schedule_days_staff_date").on(table.staffId, table.date),
    check("chk_staff_schedule_days_date", sql`${table.date} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("chk_staff_schedule_days_type", sql`${table.dayType} in ('work', 'day_off', 'paid_leave', 'other')`),
  ],
);

export const staffScheduleSegments = sqliteTable(
  "staff_schedule_segments",
  {
    id: text("id").primaryKey(),
    scheduleDayId: text("schedule_day_id").notNull().references(() => staffScheduleDays.id, { onDelete: "restrict" }),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    activityType: text("activity_type").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_schedule_segments_day_start").on(table.scheduleDayId, table.startTime),
    index("idx_staff_schedule_segments_day_times").on(table.scheduleDayId, table.startTime, table.endTime),
    check(
      "chk_staff_schedule_segments_times",
      sql`${table.startTime} glob '[0-2][0-9]:[0-5][0-9]'
          and ${table.endTime} glob '[0-2][0-9]:[0-5][0-9]'
          and substr(${table.startTime}, 4, 2) in ('00', '15', '30', '45')
          and substr(${table.endTime}, 4, 2) in ('00', '15', '30', '45')
          and ${table.startTime} >= '06:30'
          and ${table.endTime} <= '20:30'
          and ${table.startTime} < ${table.endTime}`,
    ),
    check(
      "chk_staff_schedule_segments_activity",
      sql`${table.activityType} in ('childcare', 'break', 'administration', 'training', 'meal_service', 'other_work')`,
    ),
  ],
);

export const staffSchedulePreferences = sqliteTable(
  "staff_schedule_preferences",
  {
    id: text("id").primaryKey(),
    staffId: text("staff_id").notNull().references(() => staffMembers.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    preferenceType: text("preference_type").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    createdByAdministratorId: text("created_by_administrator_id").notNull().references(() => administrators.id, { onDelete: "restrict" }),
    updatedByAdministratorId: text("updated_by_administrator_id").notNull().references(() => administrators.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_staff_schedule_preferences_staff_date").on(table.staffId, table.date),
    index("idx_staff_schedule_preferences_date").on(table.date, table.staffId),
    check("chk_staff_schedule_preferences_date", sql`${table.date} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("chk_staff_schedule_preferences_type", sql`${table.preferenceType} in ('day_off', 'work_time')`),
    check(
      "chk_staff_schedule_preferences_payload",
      sql`(${table.preferenceType} = 'day_off' and ${table.startTime} is null and ${table.endTime} is null)
          or (${table.preferenceType} = 'work_time'
            and ${table.startTime} glob '[0-2][0-9]:[0-5][0-9]'
            and ${table.endTime} glob '[0-2][0-9]:[0-5][0-9]'
            and substr(${table.startTime}, 4, 2) in ('00', '15', '30', '45')
            and substr(${table.endTime}, 4, 2) in ('00', '15', '30', '45')
            and ${table.startTime} >= '06:30'
            and ${table.endTime} <= '20:30'
            and ${table.startTime} < ${table.endTime})`,
    ),
  ],
);

export const basicUsagePatterns = sqliteTable(
  "basic_usage_patterns",
  {
    id: text("id").primaryKey(),
    childId: text("child_id").notNull().references(() => children.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    arrivalTime: text("arrival_time"),
    departureTime: text("departure_time"),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_basic_usage_patterns_child_weekday").on(table.childId, table.weekday),
    check("chk_basic_usage_patterns_weekday", sql`${table.weekday} between 1 and 6`),
  ],
);

export const basicUsagePatternHistories = sqliteTable(
  "basic_usage_pattern_histories",
  {
    id: text("id").primaryKey(),
    basicUsagePatternId: text("basic_usage_pattern_id").references(() => basicUsagePatterns.id, { onDelete: "set null" }),
    childId: text("child_id").notNull().references(() => children.id, { onDelete: "restrict" }),
    weekday: integer("weekday").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json").notNull(),
    changedByAdministratorId: text("changed_by_administrator_id").notNull().references(() => administrators.id, { onDelete: "restrict" }),
    changedAt: text("changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_basic_usage_pattern_histories_child").on(table.childId, table.changedAt),
    check("chk_basic_usage_pattern_histories_weekday", sql`${table.weekday} between 1 and 6`),
  ],
);

export const submissionPeriods = sqliteTable(
  "submission_periods",
  {
    id: text("id").primaryKey(),
    targetMonth: text("target_month").notNull(),
    deadlineAt: text("deadline_at").notNull(),
    status: text("status").notNull().default("open"),
    isParentTarget: integer("is_parent_target", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_submission_periods_target_month").on(table.targetMonth),
    uniqueIndex("uq_submission_periods_single_parent_target").on(table.isParentTarget).where(sql`${table.isParentTarget} = 1`),
    check("chk_submission_periods_status", sql`${table.status} in ('draft', 'open', 'closed')`),
  ],
);

export const closureDays = sqliteTable(
  "closure_days",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("closed"),
    parentInputAllowed: integer("parent_input_allowed", { mode: "boolean" }).notNull().default(false),
    note: text("note").notNull().default(""),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_closure_days_date").on(table.date),
    index("idx_closure_days_date").on(table.date),
  ],
);

export const familyDeadlineExtensions = sqliteTable(
  "family_deadline_extensions",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "restrict" }),
    submissionPeriodId: text("submission_period_id").notNull().references(() => submissionPeriods.id, { onDelete: "restrict" }),
    extendedDeadlineAt: text("extended_deadline_at").notNull(),
    reason: text("reason").notNull(),
    administratorId: text("administrator_id").notNull().references(() => administrators.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_family_deadline_extensions_family_period").on(table.familyId, table.submissionPeriodId),
    index("idx_family_deadline_extensions_period").on(table.submissionPeriodId, table.extendedDeadlineAt),
    check("chk_family_deadline_extensions_reason", sql`length(trim(${table.reason})) > 0`),
  ],
);

export const familySubmissions = sqliteTable(
  "family_submissions",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "restrict" }),
    submissionPeriodId: text("submission_period_id").notNull().references(() => submissionPeriods.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"),
    submittedAt: text("submitted_at"),
    latestSubmittedVersionId: text("latest_submitted_version_id").references((): AnySQLiteColumn => familySubmissionVersions.id, { onDelete: "restrict" }),
    latestConfirmedVersionId: text("latest_confirmed_version_id").references((): AnySQLiteColumn => familySubmissionVersions.id, { onDelete: "restrict" }),
    latestEffectiveVersionId: text("latest_effective_version_id").references((): AnySQLiteColumn => familySubmissionVersions.id, { onDelete: "restrict" }),
    resubmissionAllowedForVersionId: text("resubmission_allowed_for_version_id").references((): AnySQLiteColumn => familySubmissionVersions.id, { onDelete: "restrict" }),
    lastUpdatedAt: text("last_updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_family_submissions_family_period").on(table.familyId, table.submissionPeriodId),
    index("idx_family_submissions_period_status").on(table.submissionPeriodId, table.status),
    check("chk_family_submissions_status", sql`${table.status} in ('draft', 'submitted', 'overdue')`),
  ],
);

export const familySubmissionVersions = sqliteTable(
  "family_submission_versions",
  {
    id: text("id").primaryKey(),
    familySubmissionId: text("family_submission_id").notNull().references((): AnySQLiteColumn => familySubmissions.id, { onDelete: "restrict" }),
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "restrict" }),
    submissionPeriodId: text("submission_period_id").notNull().references(() => submissionPeriods.id, { onDelete: "restrict" }),
    sequenceNumber: integer("sequence_number").notNull(),
    versionType: text("version_type").notNull().default("parent_submission"),
    reviewStatus: text("review_status").notNull().default("pending"),
    sourceVersionId: text("source_version_id").references((): AnySQLiteColumn => familySubmissionVersions.id, { onDelete: "restrict" }),
    submittedAt: text("submitted_at").notNull(),
    createdByFamilyAccountId: text("created_by_family_account_id").references(() => familyAccounts.id, { onDelete: "set null" }),
    createdByAdministratorId: text("created_by_administrator_id").references(() => administrators.id, { onDelete: "set null" }),
    reasonText: text("reason_text"),
    changeSummaryJson: text("change_summary_json"),
    confirmedAt: text("confirmed_at"),
    confirmedByAdministratorId: text("confirmed_by_administrator_id").references(() => administrators.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_family_submission_versions_sequence").on(table.familySubmissionId, table.sequenceNumber),
    index("idx_family_submission_versions_period_status").on(table.submissionPeriodId, table.reviewStatus, table.submittedAt),
    index("idx_family_submission_versions_family").on(table.familyId, table.submittedAt),
    check("chk_family_submission_versions_sequence", sql`${table.sequenceNumber} > 0`),
    check("chk_family_submission_versions_type", sql`${table.versionType} in ('parent_submission', 'administrator_revision')`),
    check("chk_family_submission_versions_review_status", sql`${table.reviewStatus} in ('pending', 'confirmed')`),
  ],
);

export const familySubmissionVersionChildren = sqliteTable(
  "family_submission_version_children",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id").notNull().references(() => familySubmissionVersions.id, { onDelete: "cascade" }),
    childId: text("child_id").notNull().references(() => children.id, { onDelete: "restrict" }),
    childCodeSnapshot: text("child_code_snapshot").notNull(),
    nameSnapshot: text("name_snapshot").notNull(),
    kanaSnapshot: text("kana_snapshot").notNull().default(""),
    lastNameSnapshot: text("last_name_snapshot"),
    firstNameSnapshot: text("first_name_snapshot"),
    lastNameKanaSnapshot: text("last_name_kana_snapshot"),
    firstNameKanaSnapshot: text("first_name_kana_snapshot"),
    classNameSnapshot: text("class_name_snapshot").notNull().default(""),
    birthDateSnapshot: text("birth_date_snapshot"),
    enrollmentDateSnapshot: text("enrollment_date_snapshot"),
    withdrawalDateSnapshot: text("withdrawal_date_snapshot"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_family_submission_version_children").on(table.versionId, table.childId),
    index("idx_family_submission_version_children_child").on(table.childId, table.versionId),
  ],
);

export const familySubmissionVersionDays = sqliteTable(
  "family_submission_version_days",
  {
    id: text("id").primaryKey(),
    versionChildId: text("version_child_id").notNull().references(() => familySubmissionVersionChildren.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    usageStatus: text("usage_status").notNull(),
    arrivalTime: text("arrival_time"),
    departureTime: text("departure_time"),
    source: text("source").notNull(),
    changed: integer("changed", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_family_submission_version_days_date").on(table.versionChildId, table.date),
    index("idx_family_submission_version_days_date").on(table.date, table.usageStatus),
    check("chk_family_submission_version_days_usage_status", sql`${table.usageStatus} in ('using', 'off', 'closed', 'not_enrolled')`),
    check("chk_family_submission_version_days_source", sql`${table.source} in ('base', 'weekday', 'daily', 'parent', 'admin')`),
  ],
);

export const monthlySchedules = sqliteTable(
  "monthly_schedules",
  {
    id: text("id").primaryKey(),
    childId: text("child_id").notNull().references(() => children.id, { onDelete: "restrict" }),
    submissionPeriodId: text("submission_period_id").notNull().references(() => submissionPeriods.id, { onDelete: "restrict" }),
    familySubmissionId: text("family_submission_id").references(() => familySubmissions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("draft"),
    basePatternSnapshotJson: text("base_pattern_snapshot_json").notNull().default("{}"),
    confirmedAt: text("confirmed_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_monthly_schedules_child_period").on(table.childId, table.submissionPeriodId),
    index("idx_monthly_schedules_period_status").on(table.submissionPeriodId, table.status),
    check("chk_monthly_schedules_status", sql`${table.status} in ('draft', 'submitted', 'admin_pending', 'confirmed')`),
  ],
);

export const dailySchedules = sqliteTable(
  "daily_schedules",
  {
    id: text("id").primaryKey(),
    monthlyScheduleId: text("monthly_schedule_id").notNull().references(() => monthlySchedules.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    usageStatus: text("usage_status").notNull().default("off"),
    arrivalTime: text("arrival_time"),
    departureTime: text("departure_time"),
    source: text("source").notNull().default("base"),
    changed: integer("changed", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_daily_schedules_month_date").on(table.monthlyScheduleId, table.date),
    index("idx_daily_schedules_date_status").on(table.date, table.usageStatus),
    check("chk_daily_schedules_usage_status", sql`${table.usageStatus} in ('using', 'off', 'closed', 'not_enrolled')`),
    check("chk_daily_schedules_source", sql`${table.source} in ('base', 'weekday', 'daily', 'parent', 'admin')`),
  ],
);

export const standardReasons = sqliteTable(
  "standard_reasons",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    hiddenFromOrder: integer("hidden_from_order"),
    ...timestamps,
  },
  (table) => [index("idx_standard_reasons_active_order").on(table.active, table.sortOrder)],
);

export const changeHistories = sqliteTable(
  "change_histories",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    familyId: text("family_id").references(() => families.id, { onDelete: "set null" }),
    childId: text("child_id").references(() => children.id, { onDelete: "set null" }),
    targetMonth: text("target_month"),
    targetDate: text("target_date"),
    fieldName: text("field_name"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    reasonText: text("reason_text"),
    changedAt: text("changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_change_histories_child_month").on(table.childId, table.targetMonth),
    index("idx_change_histories_changed_at").on(table.changedAt),
    index("idx_change_histories_actor").on(table.actorType, table.actorId),
  ],
);

export const changeHistoryReasons = sqliteTable(
  "change_history_reasons",
  {
    id: text("id").primaryKey(),
    changeHistoryId: text("change_history_id").notNull().references(() => changeHistories.id, { onDelete: "cascade" }),
    standardReasonId: text("standard_reason_id").references(() => standardReasons.id, { onDelete: "set null" }),
    reasonNameSnapshot: text("reason_name_snapshot").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [index("idx_change_history_reasons_history").on(table.changeHistoryId)],
);

export const operationLogs = sqliteTable(
  "operation_logs",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    operation: text("operation").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    targetMonth: text("target_month"),
    detailJson: text("detail_json"),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_operation_logs_occurred_at").on(table.occurredAt),
    index("idx_operation_logs_actor").on(table.actorType, table.actorId),
  ],
);

export const standardReasonHistories = sqliteTable(
  "standard_reason_histories",
  {
    id: text("id").primaryKey(),
    standardReasonId: text("standard_reason_id").references(() => standardReasons.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    actorId: text("actor_id"),
    changedAt: text("changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_standard_reason_histories_reason").on(table.standardReasonId),
    index("idx_standard_reason_histories_changed_at").on(table.changedAt),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type").notNull(),
    familyAccountId: text("family_account_id").references(() => familyAccounts.id, { onDelete: "cascade" }),
    administratorId: text("administrator_id").references(() => administrators.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    invalidatedAt: text("invalidated_at"),
    invalidationReason: text("invalidation_reason"),
  },
  (table) => [
    uniqueIndex("uq_auth_sessions_token_hash").on(table.tokenHash),
    index("idx_auth_sessions_family_account").on(table.familyAccountId, table.expiresAt),
    index("idx_auth_sessions_administrator").on(table.administratorId, table.expiresAt),
    index("idx_auth_sessions_expiry").on(table.expiresAt, table.invalidatedAt),
    check("chk_auth_sessions_subject_type", sql`${table.subjectType} in ('family', 'administrator')`),
    check(
      "chk_auth_sessions_subject_reference",
      sql`(${table.subjectType} = 'family' and ${table.familyAccountId} is not null and ${table.administratorId} is null)
          or (${table.subjectType} = 'administrator' and ${table.familyAccountId} is null and ${table.administratorId} is not null)`,
    ),
  ],
);

export const authLoginAttempts = sqliteTable(
  "auth_login_attempts",
  {
    id: text("id").primaryKey(),
    loginScope: text("login_scope").notNull(),
    loginIdHash: text("login_id_hash").notNull(),
    sourceHash: text("source_hash").notNull(),
    success: integer("success", { mode: "boolean" }).notNull().default(false),
    attemptedAt: text("attempted_at").notNull(),
  },
  (table) => [
    index("idx_auth_login_attempts_login").on(table.loginScope, table.loginIdHash, table.attemptedAt),
    index("idx_auth_login_attempts_source").on(table.loginScope, table.sourceHash, table.attemptedAt),
    check("chk_auth_login_attempts_scope", sql`${table.loginScope} in ('family', 'administrator')`),
  ],
);

export const authSettings = sqliteTable(
  "auth_settings",
  {
    key: text("key").primaryKey(),
    valueJson: text("value_json").notNull(),
    updatedByAdministratorId: text("updated_by_administrator_id").references(() => administrators.id, { onDelete: "set null" }),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_auth_settings_updated_by").on(table.updatedByAdministratorId)],
);
