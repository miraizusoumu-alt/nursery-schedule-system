CREATE TABLE `staff_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`role_type` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_staff_roles_type" CHECK("staff_roles"."role_type" in ('nursery_teacher_role', 'principal', 'manager', 'meal_service', 'other')),
	CONSTRAINT "chk_staff_roles_dates" CHECK("staff_roles"."valid_to" is null or "staff_roles"."valid_to" >= "staff_roles"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_staff_roles_staff_type_from` ON `staff_roles` (`staff_id`,`role_type`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_staff_roles_staff_dates` ON `staff_roles` (`staff_id`,`valid_from`,`valid_to`);