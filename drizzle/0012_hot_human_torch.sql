CREATE TABLE `national_holidays` (
	`holiday_date` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text NOT NULL,
	`source_last_modified` text NOT NULL,
	`source_data_sha256` text NOT NULL,
	CONSTRAINT "chk_national_holidays_date" CHECK("national_holidays"."holiday_date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "chk_national_holidays_name" CHECK(length(trim("national_holidays"."name")) > 0),
	CONSTRAINT "chk_national_holidays_source" CHECK(length(trim("national_holidays"."source")) > 0)
);
--> statement-breakpoint
ALTER TABLE `staff_work_condition_versions` ADD `holiday_work_allowed` integer DEFAULT true NOT NULL;