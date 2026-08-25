CREATE TABLE `staff_schedule_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`date` text NOT NULL,
	`preference_type` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`created_by_administrator_id` text NOT NULL,
	`updated_by_administrator_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by_administrator_id`) REFERENCES `administrators`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_schedule_preferences_date" CHECK("staff_schedule_preferences"."date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "chk_staff_schedule_preferences_type" CHECK("staff_schedule_preferences"."preference_type" in ('day_off', 'work_time')),
	CONSTRAINT "chk_staff_schedule_preferences_payload" CHECK(("staff_schedule_preferences"."preference_type" = 'day_off' and "staff_schedule_preferences"."start_time" is null and "staff_schedule_preferences"."end_time" is null)
          or ("staff_schedule_preferences"."preference_type" = 'work_time'
            and "staff_schedule_preferences"."start_time" glob '[0-2][0-9]:[0-5][0-9]'
            and "staff_schedule_preferences"."end_time" glob '[0-2][0-9]:[0-5][0-9]'
            and substr("staff_schedule_preferences"."start_time", 4, 2) in ('00', '15', '30', '45')
            and substr("staff_schedule_preferences"."end_time", 4, 2) in ('00', '15', '30', '45')
            and "staff_schedule_preferences"."start_time" >= '06:30'
            and "staff_schedule_preferences"."end_time" <= '20:30'
            and "staff_schedule_preferences"."start_time" < "staff_schedule_preferences"."end_time"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_schedule_preferences_staff_date` ON `staff_schedule_preferences` (`staff_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_staff_schedule_preferences_date` ON `staff_schedule_preferences` (`date`,`staff_id`);