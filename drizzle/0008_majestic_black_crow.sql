CREATE TABLE `staff_schedule_days` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`date` text NOT NULL,
	`day_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `staff_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_schedule_days_date" CHECK("staff_schedule_days"."date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "chk_staff_schedule_days_type" CHECK("staff_schedule_days"."day_type" in ('work', 'day_off', 'paid_leave', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_schedule_days_version_staff_date` ON `staff_schedule_days` (`version_id`,`staff_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_days_version_date` ON `staff_schedule_days` (`version_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_days_staff_date` ON `staff_schedule_days` (`staff_id`,`date`);--> statement-breakpoint
CREATE TABLE `staff_schedule_months` (
	`id` text PRIMARY KEY NOT NULL,
	`target_month` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version_id` text,
	`confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`current_version_id`) REFERENCES `staff_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_schedule_months_target_month" CHECK("staff_schedule_months"."target_month" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]' and substr("staff_schedule_months"."target_month", 6, 2) between '01' and '12'),
	CONSTRAINT "chk_staff_schedule_months_status" CHECK("staff_schedule_months"."status" in ('draft', 'confirmed')),
	CONSTRAINT "chk_staff_schedule_months_confirmation" CHECK(("staff_schedule_months"."status" = 'draft' and "staff_schedule_months"."confirmed_at" is null) or ("staff_schedule_months"."status" = 'confirmed' and "staff_schedule_months"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_schedule_months_target_month` ON `staff_schedule_months` (`target_month`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_months_status` ON `staff_schedule_months` (`status`,`target_month`);--> statement-breakpoint
CREATE TABLE `staff_schedule_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_day_id` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`activity_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`schedule_day_id`) REFERENCES `staff_schedule_days`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_schedule_segments_times" CHECK("staff_schedule_segments"."start_time" glob '[0-2][0-9]:[0-5][0-9]'
          and "staff_schedule_segments"."end_time" glob '[0-2][0-9]:[0-5][0-9]'
          and substr("staff_schedule_segments"."start_time", 4, 2) in ('00', '15', '30', '45')
          and substr("staff_schedule_segments"."end_time", 4, 2) in ('00', '15', '30', '45')
          and "staff_schedule_segments"."start_time" >= '06:30'
          and "staff_schedule_segments"."end_time" <= '20:30'
          and "staff_schedule_segments"."start_time" < "staff_schedule_segments"."end_time"),
	CONSTRAINT "chk_staff_schedule_segments_activity" CHECK("staff_schedule_segments"."activity_type" in ('childcare', 'break', 'administration', 'training', 'meal_service', 'other_work'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_schedule_segments_day_start` ON `staff_schedule_segments` (`schedule_day_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_segments_day_times` ON `staff_schedule_segments` (`schedule_day_id`,`start_time`,`end_time`);--> statement-breakpoint
CREATE TABLE `staff_schedule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_month_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_version_id` text,
	`created_by_administrator_id` text,
	`confirmed_by_administrator_id` text,
	`confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`schedule_month_id`) REFERENCES `staff_schedule_months`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_version_id`) REFERENCES `staff_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`confirmed_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_schedule_versions_number" CHECK("staff_schedule_versions"."version_number" > 0),
	CONSTRAINT "chk_staff_schedule_versions_source" CHECK("staff_schedule_versions"."source" in ('manual', 'auto_generated')),
	CONSTRAINT "chk_staff_schedule_versions_status" CHECK("staff_schedule_versions"."status" in ('draft', 'confirmed')),
	CONSTRAINT "chk_staff_schedule_versions_confirmation" CHECK(("staff_schedule_versions"."status" = 'draft' and "staff_schedule_versions"."confirmed_at" is null) or ("staff_schedule_versions"."status" = 'confirmed' and "staff_schedule_versions"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_schedule_versions_month_number` ON `staff_schedule_versions` (`schedule_month_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_versions_month_status` ON `staff_schedule_versions` (`schedule_month_id`,`status`,`version_number`);