CREATE TABLE `administrators` (
	`id` text PRIMARY KEY NOT NULL,
	`login_id` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'normal' NOT NULL,
	`password_hash` text,
	`must_change_password` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stopped_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_administrators_role" CHECK("administrators"."role" in ('normal', 'master')),
	CONSTRAINT "chk_administrators_status" CHECK("administrators"."status" in ('active', 'stopped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_administrators_login_id` ON `administrators` (`login_id`);--> statement-breakpoint
CREATE TABLE `basic_usage_patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`child_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`arrival_time` text,
	`departure_time` text,
	`valid_from` text,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_basic_usage_patterns_weekday" CHECK("basic_usage_patterns"."weekday" between 1 and 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_basic_usage_patterns_child_weekday` ON `basic_usage_patterns` (`child_id`,`weekday`);--> statement-breakpoint
CREATE TABLE `change_histories` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`family_id` text,
	`child_id` text,
	`target_month` text,
	`target_date` text,
	`field_name` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`before_json` text,
	`after_json` text,
	`reason_text` text,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_change_histories_child_month` ON `change_histories` (`child_id`,`target_month`);--> statement-breakpoint
CREATE INDEX `idx_change_histories_changed_at` ON `change_histories` (`changed_at`);--> statement-breakpoint
CREATE INDEX `idx_change_histories_actor` ON `change_histories` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE TABLE `change_history_reasons` (
	`change_history_id` text NOT NULL,
	`standard_reason_id` text,
	`reason_name_snapshot` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`change_history_id`, `reason_name_snapshot`),
	FOREIGN KEY (`change_history_id`) REFERENCES `change_histories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`standard_reason_id`) REFERENCES `standard_reasons`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `children` (
	`id` text PRIMARY KEY NOT NULL,
	`child_code` text NOT NULL,
	`name` text NOT NULL,
	`kana` text DEFAULT '' NOT NULL,
	`class_name` text DEFAULT '' NOT NULL,
	`birth_date` text,
	`enrollment_date` text,
	`withdrawal_date` text,
	`age_group_override` text,
	`status` text DEFAULT 'enrolled' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_children_status" CHECK("children"."status" in ('enrolled', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_children_child_code` ON `children` (`child_code`);--> statement-breakpoint
CREATE INDEX `idx_children_enrollment_dates` ON `children` (`enrollment_date`,`withdrawal_date`);--> statement-breakpoint
CREATE TABLE `closure_days` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_period_id` text NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'closed' NOT NULL,
	`parent_input_allowed` integer DEFAULT false NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_period_id`) REFERENCES `submission_periods`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_closure_days_period_date` ON `closure_days` (`submission_period_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_closure_days_date` ON `closure_days` (`date`);--> statement-breakpoint
CREATE TABLE `daily_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`monthly_schedule_id` text NOT NULL,
	`date` text NOT NULL,
	`usage_status` text DEFAULT 'off' NOT NULL,
	`arrival_time` text,
	`departure_time` text,
	`source` text DEFAULT 'base' NOT NULL,
	`changed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`monthly_schedule_id`) REFERENCES `monthly_schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_daily_schedules_usage_status" CHECK("daily_schedules"."usage_status" in ('using', 'off', 'closed', 'not_enrolled')),
	CONSTRAINT "chk_daily_schedules_source" CHECK("daily_schedules"."source" in ('base', 'weekday', 'daily', 'parent', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_daily_schedules_month_date` ON `daily_schedules` (`monthly_schedule_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_daily_schedules_date_status` ON `daily_schedules` (`date`,`usage_status`);--> statement-breakpoint
CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`family_code` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` text,
	`handed_over_at` text,
	`stop_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_families_status" CHECK("families"."status" in ('active', 'stopped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_families_family_code` ON `families` (`family_code`);--> statement-breakpoint
CREATE INDEX `idx_families_status` ON `families` (`status`);--> statement-breakpoint
CREATE TABLE `family_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`login_id` text NOT NULL,
	`password_hash` text,
	`must_change_password` integer DEFAULT true NOT NULL,
	`temporary_password_issued_at` text,
	`stopped_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_accounts_family_id` ON `family_accounts` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_accounts_login_id` ON `family_accounts` (`login_id`);--> statement-breakpoint
CREATE TABLE `family_children` (
	`family_id` text NOT NULL,
	`child_id` text NOT NULL,
	`relationship_label` text DEFAULT '保護者' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active_from` text,
	`active_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`family_id`, `child_id`),
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_family_children_child_id` ON `family_children` (`child_id`);--> statement-breakpoint
CREATE TABLE `family_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`submission_period_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`submitted_at` text,
	`last_updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submission_period_id`) REFERENCES `submission_periods`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_family_submissions_status" CHECK("family_submissions"."status" in ('draft', 'submitted', 'overdue'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_submissions_family_period` ON `family_submissions` (`family_id`,`submission_period_id`);--> statement-breakpoint
CREATE INDEX `idx_family_submissions_period_status` ON `family_submissions` (`submission_period_id`,`status`);--> statement-breakpoint
CREATE TABLE `monthly_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`child_id` text NOT NULL,
	`submission_period_id` text NOT NULL,
	`family_submission_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`base_pattern_snapshot_json` text DEFAULT '{}' NOT NULL,
	`confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submission_period_id`) REFERENCES `submission_periods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`family_submission_id`) REFERENCES `family_submissions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_monthly_schedules_status" CHECK("monthly_schedules"."status" in ('draft', 'submitted', 'admin_pending', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_monthly_schedules_child_period` ON `monthly_schedules` (`child_id`,`submission_period_id`);--> statement-breakpoint
CREATE INDEX `idx_monthly_schedules_period_status` ON `monthly_schedules` (`submission_period_id`,`status`);--> statement-breakpoint
CREATE TABLE `operation_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`operation` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_month` text,
	`detail_json` text,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_operation_logs_occurred_at` ON `operation_logs` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_operation_logs_actor` ON `operation_logs` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE TABLE `standard_reason_histories` (
	`id` text PRIMARY KEY NOT NULL,
	`standard_reason_id` text,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`actor_id` text,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`standard_reason_id`) REFERENCES `standard_reasons`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_standard_reason_histories_reason` ON `standard_reason_histories` (`standard_reason_id`);--> statement-breakpoint
CREATE INDEX `idx_standard_reason_histories_changed_at` ON `standard_reason_histories` (`changed_at`);--> statement-breakpoint
CREATE TABLE `standard_reasons` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`hidden_from_order` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_standard_reasons_active_order` ON `standard_reasons` (`active`,`sort_order`);--> statement-breakpoint
CREATE TABLE `submission_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`target_month` text NOT NULL,
	`deadline_at` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_submission_periods_status" CHECK("submission_periods"."status" in ('draft', 'open', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submission_periods_target_month` ON `submission_periods` (`target_month`);