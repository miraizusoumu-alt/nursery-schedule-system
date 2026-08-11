CREATE TABLE `auth_login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`login_scope` text NOT NULL,
	`login_id_hash` text NOT NULL,
	`source_hash` text NOT NULL,
	`success` integer DEFAULT false NOT NULL,
	`attempted_at` text NOT NULL,
	CONSTRAINT "chk_auth_login_attempts_scope" CHECK("auth_login_attempts"."login_scope" in ('family', 'administrator'))
);
--> statement-breakpoint
CREATE INDEX `idx_auth_login_attempts_login` ON `auth_login_attempts` (`login_scope`,`login_id_hash`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_login_attempts_source` ON `auth_login_attempts` (`login_scope`,`source_hash`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`family_account_id` text,
	`administrator_id` text,
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
	CONSTRAINT "chk_auth_sessions_subject_type" CHECK("auth_sessions"."subject_type" in ('family', 'administrator')),
	CONSTRAINT "chk_auth_sessions_subject_reference" CHECK(("auth_sessions"."subject_type" = 'family' and "auth_sessions"."family_account_id" is not null and "auth_sessions"."administrator_id" is null)
          or ("auth_sessions"."subject_type" = 'administrator' and "auth_sessions"."family_account_id" is null and "auth_sessions"."administrator_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auth_sessions_token_hash` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_family_account` ON `auth_sessions` (`family_account_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_administrator` ON `auth_sessions` (`administrator_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expiry` ON `auth_sessions` (`expires_at`,`invalidated_at`);--> statement-breakpoint
CREATE TABLE `auth_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by_administrator_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_auth_settings_updated_by` ON `auth_settings` (`updated_by_administrator_id`);--> statement-breakpoint
ALTER TABLE `administrators` ADD `temporary_password_issued_at` text;--> statement-breakpoint
ALTER TABLE `administrators` ADD `password_changed_at` text;--> statement-breakpoint
ALTER TABLE `administrators` ADD `credential_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `administrators` ADD `last_login_at` text;--> statement-breakpoint
ALTER TABLE `family_accounts` ADD `password_changed_at` text;--> statement-breakpoint
ALTER TABLE `family_accounts` ADD `credential_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `family_accounts` ADD `last_login_at` text;