CREATE TABLE `staff_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`login_id` text NOT NULL,
	`password_hash` text,
	`temporary_password_issued_at` text,
	`password_changed_at` text,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`last_login_at` text,
	`disabled_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_accounts_staff_id` ON `staff_accounts` (`staff_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_accounts_login_id` ON `staff_accounts` (`login_id`);--> statement-breakpoint
CREATE INDEX `idx_staff_accounts_disabled_at` ON `staff_accounts` (`disabled_at`);--> statement-breakpoint
CREATE TABLE `staff_preference_draft_days` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`date` text NOT NULL,
	`preference_type` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `staff_preference_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_staff_preference_draft_days_date" CHECK("staff_preference_draft_days"."date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "chk_staff_preference_draft_days_type" CHECK("staff_preference_draft_days"."preference_type" in ('day_off', 'work_time')),
	CONSTRAINT "chk_staff_preference_draft_days_payload" CHECK(("staff_preference_draft_days"."preference_type" = 'day_off' and "staff_preference_draft_days"."start_time" is null and "staff_preference_draft_days"."end_time" is null)
          or ("staff_preference_draft_days"."preference_type" = 'work_time'
            and "staff_preference_draft_days"."start_time" glob '[0-2][0-9]:[0-5][0-9]'
            and "staff_preference_draft_days"."end_time" glob '[0-2][0-9]:[0-5][0-9]'
            and substr("staff_preference_draft_days"."start_time", 4, 2) in ('00', '15', '30', '45')
            and substr("staff_preference_draft_days"."end_time", 4, 2) in ('00', '15', '30', '45')
            and "staff_preference_draft_days"."start_time" >= '06:30'
            and "staff_preference_draft_days"."end_time" <= '20:30'
            and "staff_preference_draft_days"."start_time" < "staff_preference_draft_days"."end_time"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_preference_draft_days_submission_date` ON `staff_preference_draft_days` (`submission_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_staff_preference_draft_days_date` ON `staff_preference_draft_days` (`date`,`submission_id`);--> statement-breakpoint
CREATE TABLE `staff_preference_submission_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`target_month` text NOT NULL,
	`deadline_at` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by_administrator_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_preference_submission_periods_month" CHECK("staff_preference_submission_periods"."target_month" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]' and substr("staff_preference_submission_periods"."target_month", 6, 2) between '01' and '12'),
	CONSTRAINT "chk_staff_preference_submission_periods_status" CHECK("staff_preference_submission_periods"."status" in ('draft', 'open', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_preference_submission_periods_month` ON `staff_preference_submission_periods` (`target_month`);--> statement-breakpoint
CREATE INDEX `idx_staff_preference_submission_periods_status` ON `staff_preference_submission_periods` (`status`,`target_month`);--> statement-breakpoint
CREATE TABLE `staff_preference_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_period_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`base_preferences_hash` text NOT NULL,
	`submitted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_period_id`) REFERENCES `staff_preference_submission_periods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_preference_submissions_status" CHECK("staff_preference_submissions"."status" in ('draft', 'submitted')),
	CONSTRAINT "chk_staff_preference_submissions_revision" CHECK("staff_preference_submissions"."revision" > 0),
	CONSTRAINT "chk_staff_preference_submissions_submitted_at" CHECK(("staff_preference_submissions"."status" = 'draft' and "staff_preference_submissions"."submitted_at" is null)
          or ("staff_preference_submissions"."status" = 'submitted' and "staff_preference_submissions"."submitted_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_preference_submissions_period_staff` ON `staff_preference_submissions` (`submission_period_id`,`staff_id`);--> statement-breakpoint
CREATE INDEX `idx_staff_preference_submissions_staff_status` ON `staff_preference_submissions` (`staff_id`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auth_login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`login_scope` text NOT NULL,
	`login_id_hash` text NOT NULL,
	`source_hash` text NOT NULL,
	`success` integer DEFAULT false NOT NULL,
	`attempted_at` text NOT NULL,
	CONSTRAINT "chk_auth_login_attempts_scope" CHECK("__new_auth_login_attempts"."login_scope" in ('family', 'administrator', 'staff'))
);
--> statement-breakpoint
INSERT INTO `__new_auth_login_attempts`("id", "login_scope", "login_id_hash", "source_hash", "success", "attempted_at") SELECT "id", "login_scope", "login_id_hash", "source_hash", "success", "attempted_at" FROM `auth_login_attempts`;--> statement-breakpoint
DROP TABLE `auth_login_attempts`;--> statement-breakpoint
ALTER TABLE `__new_auth_login_attempts` RENAME TO `auth_login_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_auth_login_attempts_login` ON `auth_login_attempts` (`login_scope`,`login_id_hash`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_login_attempts_source` ON `auth_login_attempts` (`login_scope`,`source_hash`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `__new_auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`family_account_id` text,
	`administrator_id` text,
	`staff_account_id` text,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`credential_version` integer NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`invalidated_at` text,
	`invalidation_reason` text,
	FOREIGN KEY (`family_account_id`) REFERENCES `family_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`staff_account_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_auth_sessions_subject_type" CHECK("__new_auth_sessions"."subject_type" in ('family', 'administrator', 'staff')),
	CONSTRAINT "chk_auth_sessions_subject_reference" CHECK(("__new_auth_sessions"."subject_type" = 'family' and "__new_auth_sessions"."family_account_id" is not null and "__new_auth_sessions"."administrator_id" is null and "__new_auth_sessions"."staff_account_id" is null)
          or ("__new_auth_sessions"."subject_type" = 'administrator' and "__new_auth_sessions"."family_account_id" is null and "__new_auth_sessions"."administrator_id" is not null and "__new_auth_sessions"."staff_account_id" is null)
          or ("__new_auth_sessions"."subject_type" = 'staff' and "__new_auth_sessions"."family_account_id" is null and "__new_auth_sessions"."administrator_id" is null and "__new_auth_sessions"."staff_account_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_auth_sessions`("id", "subject_type", "family_account_id", "administrator_id", "staff_account_id", "token_hash", "csrf_token_hash", "credential_version", "issued_at", "expires_at", "last_seen_at", "invalidated_at", "invalidation_reason") SELECT "id", "subject_type", "family_account_id", "administrator_id", NULL, "token_hash", "csrf_token_hash", "credential_version", "issued_at", "expires_at", "last_seen_at", "invalidated_at", "invalidation_reason" FROM `auth_sessions`;--> statement-breakpoint
DROP TABLE `auth_sessions`;--> statement-breakpoint
ALTER TABLE `__new_auth_sessions` RENAME TO `auth_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auth_sessions_token_hash` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_family_account` ON `auth_sessions` (`family_account_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_administrator` ON `auth_sessions` (`administrator_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_staff_account` ON `auth_sessions` (`staff_account_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expiry` ON `auth_sessions` (`expires_at`,`invalidated_at`);--> statement-breakpoint
CREATE TABLE `__new_staff_schedule_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`date` text NOT NULL,
	`preference_type` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`created_by_administrator_id` text,
	`updated_by_administrator_id` text,
	`created_by_staff_account_id` text,
	`updated_by_staff_account_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_staff_account_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by_staff_account_id`) REFERENCES `staff_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_schedule_preferences_date" CHECK("__new_staff_schedule_preferences"."date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "chk_staff_schedule_preferences_type" CHECK("__new_staff_schedule_preferences"."preference_type" in ('day_off', 'work_time')),
	CONSTRAINT "chk_staff_schedule_preferences_payload" CHECK(("__new_staff_schedule_preferences"."preference_type" = 'day_off' and "__new_staff_schedule_preferences"."start_time" is null and "__new_staff_schedule_preferences"."end_time" is null)
          or ("__new_staff_schedule_preferences"."preference_type" = 'work_time'
            and "__new_staff_schedule_preferences"."start_time" glob '[0-2][0-9]:[0-5][0-9]'
            and "__new_staff_schedule_preferences"."end_time" glob '[0-2][0-9]:[0-5][0-9]'
            and substr("__new_staff_schedule_preferences"."start_time", 4, 2) in ('00', '15', '30', '45')
            and substr("__new_staff_schedule_preferences"."end_time", 4, 2) in ('00', '15', '30', '45')
            and "__new_staff_schedule_preferences"."start_time" >= '06:30'
            and "__new_staff_schedule_preferences"."end_time" <= '20:30'
            and "__new_staff_schedule_preferences"."start_time" < "__new_staff_schedule_preferences"."end_time")),
	CONSTRAINT "chk_staff_schedule_preferences_created_by" CHECK(("__new_staff_schedule_preferences"."created_by_administrator_id" is not null and "__new_staff_schedule_preferences"."created_by_staff_account_id" is null)
          or ("__new_staff_schedule_preferences"."created_by_administrator_id" is null and "__new_staff_schedule_preferences"."created_by_staff_account_id" is not null)),
	CONSTRAINT "chk_staff_schedule_preferences_updated_by" CHECK(("__new_staff_schedule_preferences"."updated_by_administrator_id" is not null and "__new_staff_schedule_preferences"."updated_by_staff_account_id" is null)
          or ("__new_staff_schedule_preferences"."updated_by_administrator_id" is null and "__new_staff_schedule_preferences"."updated_by_staff_account_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_staff_schedule_preferences`("id", "staff_id", "date", "preference_type", "start_time", "end_time", "created_by_administrator_id", "updated_by_administrator_id", "created_by_staff_account_id", "updated_by_staff_account_id", "created_at", "updated_at") SELECT "id", "staff_id", "date", "preference_type", "start_time", "end_time", "created_by_administrator_id", "updated_by_administrator_id", NULL, NULL, "created_at", "updated_at" FROM `staff_schedule_preferences`;--> statement-breakpoint
DROP TABLE `staff_schedule_preferences`;--> statement-breakpoint
ALTER TABLE `__new_staff_schedule_preferences` RENAME TO `staff_schedule_preferences`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_schedule_preferences_staff_date` ON `staff_schedule_preferences` (`staff_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_preferences_date` ON `staff_schedule_preferences` (`date`,`staff_id`);
