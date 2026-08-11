import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const submissionPeriods = sqliteTable(
  "submission_periods",
  {
    id: text("id").primaryKey(),
    targetMonth: text("target_month").notNull(),
    deadlineAt: text("deadline_at").notNull(),
    status: text("status").notNull().default("open"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_submission_periods_target_month").on(table.targetMonth),
    check("chk_submission_periods_status", sql`${table.status} in ('draft', 'open', 'closed')`),
  ],
);

export const closureDays = sqliteTable(
  "closure_days",
  {
    id: text("id").primaryKey(),
    submissionPeriodId: text("submission_period_id").notNull().references(() => submissionPeriods.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("closed"),
    parentInputAllowed: integer("parent_input_allowed", { mode: "boolean" }).notNull().default(false),
    note: text("note").notNull().default(""),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_closure_days_period_date").on(table.submissionPeriodId, table.date),
    index("idx_closure_days_date").on(table.date),
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
    lastUpdatedAt: text("last_updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_family_submissions_family_period").on(table.familyId, table.submissionPeriodId),
    index("idx_family_submissions_period_status").on(table.submissionPeriodId, table.status),
    check("chk_family_submissions_status", sql`${table.status} in ('draft', 'submitted', 'overdue')`),
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
