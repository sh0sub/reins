CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_key_hash_unique` ON `agents` (`key_hash`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`stage` text NOT NULL,
	`decision` text NOT NULL,
	`risk` integer,
	`reason_en` text,
	`reason_ko` text,
	`details` text,
	`actor` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `decisions_request` ON `decisions` (`request_id`);--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`monthly_limit_cents` integer NOT NULL,
	`auto_approve_limit_cents` integer NOT NULL,
	`per_tx_cap_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`allowed_merchants` text DEFAULT '[]' NOT NULL,
	`blocked_merchants` text DEFAULT '[]' NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`purpose` text NOT NULL,
	`valid_from` integer,
	`valid_until` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mandates_agent_version` ON `mandates` (`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`strategy` text NOT NULL,
	`status` text NOT NULL,
	`paypal_order_id` text,
	`capture_id` text,
	`payout_batch_id` text,
	`approve_url` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`error` text,
	`reconciled` text DEFAULT 'unchecked' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_request_id_unique` ON `payments` (`request_id`);--> statement-breakpoint
CREATE INDEX `payments_order` ON `payments` (`paypal_order_id`);--> statement-breakpoint
CREATE INDEX `payments_batch` ON `payments` (`payout_batch_id`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`agent_id` text NOT NULL,
	`mandate_id` text,
	`client_request_id` text NOT NULL,
	`merchant` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`items` text NOT NULL,
	`reason` text NOT NULL,
	`category` text,
	`status` text DEFAULT 'reviewing' NOT NULL,
	`final_decision` text,
	`risk` integer,
	`reason_en` text,
	`reason_ko` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_seq_unique` ON `requests` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `requests_idempotency` ON `requests` (`agent_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `requests_agent_created` ON `requests` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_status` ON `requests` (`status`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`resource_id` text,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`processed_at` integer,
	`outcome` text
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'My workspace' NOT NULL,
	`paypal_env` text DEFAULT 'fake' NOT NULL,
	`merchant_email` text,
	`payment_mode` text DEFAULT 'supervised' NOT NULL,
	`vault_id` text,
	`telegram_chat_id` text,
	`telegram_link_token` text,
	`connected_at` integer
);
