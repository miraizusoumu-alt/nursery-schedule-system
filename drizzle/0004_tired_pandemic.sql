CREATE TABLE `staff_members` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_code` text NOT NULL,
	`name` text NOT NULL,
	`employment_start_date` text NOT NULL,
	`employment_end_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_staff_members_code" CHECK(length(trim("staff_members"."staff_code")) > 0),
	CONSTRAINT "chk_staff_members_name" CHECK(length(trim("staff_members"."name")) > 0),
	CONSTRAINT "chk_staff_members_status" CHECK("staff_members"."status" in ('active', 'inactive')),
	CONSTRAINT "chk_staff_members_employment_dates" CHECK("staff_members"."employment_end_date" is null or "staff_members"."employment_end_date" >= "staff_members"."employment_start_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_members_staff_code` ON `staff_members` (`staff_code`);--> statement-breakpoint
CREATE INDEX `idx_staff_members_status_dates` ON `staff_members` (`status`,`employment_start_date`,`employment_end_date`);--> statement-breakpoint
CREATE TABLE `staff_qualifications` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`qualification_type` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_qualifications_type" CHECK(length(trim("staff_qualifications"."qualification_type")) > 0),
	CONSTRAINT "chk_staff_qualifications_dates" CHECK("staff_qualifications"."valid_to" is null or "staff_qualifications"."valid_to" >= "staff_qualifications"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_qualifications_staff_type_from` ON `staff_qualifications` (`staff_id`,`qualification_type`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_staff_qualifications_staff_dates` ON `staff_qualifications` (`staff_id`,`valid_from`,`valid_to`);--> statement-breakpoint
CREATE TABLE `staff_weekly_availability` (
	`work_condition_version_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`available` integer DEFAULT false NOT NULL,
	`start_time` text,
	`end_time` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`work_condition_version_id`, `weekday`),
	FOREIGN KEY (`work_condition_version_id`) REFERENCES `staff_work_condition_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_staff_weekly_availability_weekday" CHECK("staff_weekly_availability"."weekday" between 0 and 6),
	CONSTRAINT "chk_staff_weekly_availability_times" CHECK(("staff_weekly_availability"."available" = 0 and "staff_weekly_availability"."start_time" is null and "staff_weekly_availability"."end_time" is null)
          or ("staff_weekly_availability"."available" = 1 and "staff_weekly_availability"."start_time" is not null and "staff_weekly_availability"."end_time" is not null and "staff_weekly_availability"."start_time" < "staff_weekly_availability"."end_time"))
);
--> statement-breakpoint
CREATE TABLE `staff_work_condition_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`employment_type` text NOT NULL,
	`monthly_minutes_limit` integer,
	`max_consecutive_days` integer,
	`created_by_administrator_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_work_conditions_employment_type" CHECK(length(trim("staff_work_condition_versions"."employment_type")) > 0),
	CONSTRAINT "chk_staff_work_conditions_dates" CHECK("staff_work_condition_versions"."valid_to" is null or "staff_work_condition_versions"."valid_to" >= "staff_work_condition_versions"."valid_from"),
	CONSTRAINT "chk_staff_work_conditions_monthly_limit" CHECK("staff_work_condition_versions"."monthly_minutes_limit" is null or "staff_work_condition_versions"."monthly_minutes_limit" > 0),
	CONSTRAINT "chk_staff_work_conditions_consecutive_days" CHECK("staff_work_condition_versions"."max_consecutive_days" is null or "staff_work_condition_versions"."max_consecutive_days" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_work_conditions_staff_from` ON `staff_work_condition_versions` (`staff_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_staff_work_conditions_staff_dates` ON `staff_work_condition_versions` (`staff_id`,`valid_from`,`valid_to`);