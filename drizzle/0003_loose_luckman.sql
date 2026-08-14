CREATE TABLE `basic_usage_pattern_histories` (
	`id` text PRIMARY KEY NOT NULL,
	`basic_usage_pattern_id` text,
	`child_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`changed_by_administrator_id` text NOT NULL,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`basic_usage_pattern_id`) REFERENCES `basic_usage_patterns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`changed_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_basic_usage_pattern_histories_weekday" CHECK("basic_usage_pattern_histories"."weekday" between 1 and 6)
);
--> statement-breakpoint
CREATE INDEX `idx_basic_usage_pattern_histories_child` ON `basic_usage_pattern_histories` (`child_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `family_deadline_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`submission_period_id` text NOT NULL,
	`extended_deadline_at` text NOT NULL,
	`reason` text NOT NULL,
	`administrator_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submission_period_id`) REFERENCES `submission_periods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_family_deadline_extensions_reason" CHECK(length(trim("family_deadline_extensions"."reason")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_deadline_extensions_family_period` ON `family_deadline_extensions` (`family_id`,`submission_period_id`);--> statement-breakpoint
CREATE INDEX `idx_family_deadline_extensions_period` ON `family_deadline_extensions` (`submission_period_id`,`extended_deadline_at`);--> statement-breakpoint
CREATE TABLE `family_submission_version_children` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`child_id` text NOT NULL,
	`child_code_snapshot` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`kana_snapshot` text DEFAULT '' NOT NULL,
	`last_name_snapshot` text,
	`first_name_snapshot` text,
	`last_name_kana_snapshot` text,
	`first_name_kana_snapshot` text,
	`class_name_snapshot` text DEFAULT '' NOT NULL,
	`birth_date_snapshot` text,
	`enrollment_date_snapshot` text,
	`withdrawal_date_snapshot` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `family_submission_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_id`) REFERENCES `children`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_submission_version_children` ON `family_submission_version_children` (`version_id`,`child_id`);--> statement-breakpoint
CREATE INDEX `idx_family_submission_version_children_child` ON `family_submission_version_children` (`child_id`,`version_id`);--> statement-breakpoint
CREATE TABLE `family_submission_version_days` (
	`id` text PRIMARY KEY NOT NULL,
	`version_child_id` text NOT NULL,
	`date` text NOT NULL,
	`usage_status` text NOT NULL,
	`arrival_time` text,
	`departure_time` text,
	`source` text NOT NULL,
	`changed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`version_child_id`) REFERENCES `family_submission_version_children`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_family_submission_version_days_usage_status" CHECK("family_submission_version_days"."usage_status" in ('using', 'off', 'closed', 'not_enrolled')),
	CONSTRAINT "chk_family_submission_version_days_source" CHECK("family_submission_version_days"."source" in ('base', 'weekday', 'daily', 'parent', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_submission_version_days_date` ON `family_submission_version_days` (`version_child_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_family_submission_version_days_date` ON `family_submission_version_days` (`date`,`usage_status`);--> statement-breakpoint
CREATE TABLE `family_submission_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_submission_id` text NOT NULL,
	`family_id` text NOT NULL,
	`submission_period_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`version_type` text DEFAULT 'parent_submission' NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`source_version_id` text,
	`submitted_at` text NOT NULL,
	`created_by_family_account_id` text,
	`created_by_administrator_id` text,
	`reason_text` text,
	`change_summary_json` text,
	`confirmed_at` text,
	`confirmed_by_administrator_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`family_submission_id`) REFERENCES `family_submissions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submission_period_id`) REFERENCES `submission_periods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_version_id`) REFERENCES `family_submission_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_family_account_id`) REFERENCES `family_accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`confirmed_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_family_submission_versions_sequence" CHECK("family_submission_versions"."sequence_number" > 0),
	CONSTRAINT "chk_family_submission_versions_type" CHECK("family_submission_versions"."version_type" in ('parent_submission', 'administrator_revision')),
	CONSTRAINT "chk_family_submission_versions_review_status" CHECK("family_submission_versions"."review_status" in ('pending', 'confirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_family_submission_versions_sequence` ON `family_submission_versions` (`family_submission_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_family_submission_versions_period_status` ON `family_submission_versions` (`submission_period_id`,`review_status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `idx_family_submission_versions_family` ON `family_submission_versions` (`family_id`,`submitted_at`);--> statement-breakpoint
ALTER TABLE `children` ADD `last_name` text;--> statement-breakpoint
ALTER TABLE `children` ADD `first_name` text;--> statement-breakpoint
ALTER TABLE `children` ADD `last_name_kana` text;--> statement-breakpoint
ALTER TABLE `children` ADD `first_name_kana` text;--> statement-breakpoint
ALTER TABLE `family_submissions` ADD `latest_submitted_version_id` text REFERENCES family_submission_versions(id);--> statement-breakpoint
ALTER TABLE `family_submissions` ADD `latest_confirmed_version_id` text REFERENCES family_submission_versions(id);--> statement-breakpoint
ALTER TABLE `family_submissions` ADD `latest_effective_version_id` text REFERENCES family_submission_versions(id);--> statement-breakpoint
ALTER TABLE `submission_periods` ADD `is_parent_target` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submission_periods_single_parent_target` ON `submission_periods` (`is_parent_target`) WHERE "submission_periods"."is_parent_target" = 1;