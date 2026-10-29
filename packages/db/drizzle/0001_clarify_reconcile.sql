CREATE TABLE `request_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`actor` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `request_messages_request` ON `request_messages` (`request_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `payments` ADD `reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `payments` ADD `reconcile_note` text;