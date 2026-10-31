CREATE TABLE `agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_events_agent` ON `agent_events` (`agent_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `key_rotated_at` integer;