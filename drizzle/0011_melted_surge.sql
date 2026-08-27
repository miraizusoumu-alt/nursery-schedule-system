CREATE TABLE `staff_weekly_availability_candidates` (
	`work_condition_version_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`candidate_order` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`week_mask` integer DEFAULT 31 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`work_condition_version_id`, `weekday`, `candidate_order`),
	FOREIGN KEY (`work_condition_version_id`) REFERENCES `staff_work_condition_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_staff_availability_candidates_weekday" CHECK("staff_weekly_availability_candidates"."weekday" between 0 and 6),
	CONSTRAINT "chk_staff_availability_candidates_order" CHECK("staff_weekly_availability_candidates"."candidate_order" >= 0),
	CONSTRAINT "chk_staff_availability_candidates_times" CHECK("staff_weekly_availability_candidates"."start_time" < "staff_weekly_availability_candidates"."end_time"),
	CONSTRAINT "chk_staff_availability_candidates_week_mask" CHECK("staff_weekly_availability_candidates"."week_mask" between 1 and 31)
);
