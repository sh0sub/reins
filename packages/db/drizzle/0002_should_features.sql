ALTER TABLE `mandates` ADD `merchant_auto_limits` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `request_messages` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `anomalies` text DEFAULT '[]' NOT NULL;