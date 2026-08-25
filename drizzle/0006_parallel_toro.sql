PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_closure_days` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'closed' NOT NULL,
	`parent_input_allowed` integer DEFAULT false NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_closure_days`("id", "date", "name", "type", "parent_input_allowed", "note", "created_at", "updated_at") SELECT "id", "date", "name", "type", "parent_input_allowed", "note", "created_at", "updated_at" FROM `closure_days`;--> statement-breakpoint
DROP TABLE `closure_days`;--> statement-breakpoint
ALTER TABLE `__new_closure_days` RENAME TO `closure_days`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_closure_days_date` ON `closure_days` (`date`);--> statement-breakpoint
CREATE INDEX `idx_closure_days_date` ON `closure_days` (`date`);