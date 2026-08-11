PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_change_history_reasons` (
	`id` text PRIMARY KEY NOT NULL,
	`change_history_id` text NOT NULL,
	`standard_reason_id` text,
	`reason_name_snapshot` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`change_history_id`) REFERENCES `change_histories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`standard_reason_id`) REFERENCES `standard_reasons`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_change_history_reasons`("id", "change_history_id", "standard_reason_id", "reason_name_snapshot", "sort_order") SELECT lower(hex(randomblob(16))), "change_history_id", "standard_reason_id", "reason_name_snapshot", "sort_order" FROM `change_history_reasons`;--> statement-breakpoint
DROP TABLE `change_history_reasons`;--> statement-breakpoint
ALTER TABLE `__new_change_history_reasons` RENAME TO `change_history_reasons`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_change_history_reasons_history` ON `change_history_reasons` (`change_history_id`);
