CREATE TABLE `activity` (
	`id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`version` bigint NOT NULL DEFAULT 0,
	`actor_id` char(36) NOT NULL,
	`type` varchar(40) NOT NULL,
	`entity_type` varchar(20) NOT NULL,
	`entity_id` char(36) NOT NULL,
	`payload` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `activity_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` char(36) NOT NULL,
	`expense_id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`version` bigint NOT NULL DEFAULT 0,
	`deleted_at` datetime(3),
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `expense_splits` (
	`expense_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`paid_minor` bigint NOT NULL,
	`owed_minor` bigint NOT NULL,
	CONSTRAINT `expense_splits_expense_id_user_id_pk` PRIMARY KEY(`expense_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`description` varchar(200) NOT NULL,
	`category` varchar(40) NOT NULL,
	`note` text NOT NULL,
	`expense_date` date NOT NULL,
	`currency` char(3) NOT NULL,
	`amount_minor` bigint NOT NULL,
	`split_meta` json NOT NULL,
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_by` char(36) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` bigint NOT NULL DEFAULT 0,
	`deleted_at` datetime(3),
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`day` date NOT NULL,
	`base` char(3) NOT NULL,
	`quote` char(3) NOT NULL,
	`rate` decimal(18,8) NOT NULL,
	CONSTRAINT `fx_rates_day_base_quote_pk` PRIMARY KEY(`day`,`base`,`quote`)
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`joined_at` datetime(3) NOT NULL,
	`left_at` datetime(3),
	`version` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `group_members_group_id_user_id_pk` PRIMARY KEY(`group_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` char(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`default_currency` char(3) NOT NULL,
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`last_version` bigint NOT NULL DEFAULT 0,
	`version` bigint NOT NULL DEFAULT 0,
	`deleted_at` datetime(3),
	CONSTRAINT `groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`token` varchar(43) NOT NULL,
	`group_id` char(36) NOT NULL,
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`expires_at` datetime(3),
	`revoked_at` datetime(3),
	CONSTRAINT `invites_token` PRIMARY KEY(`token`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`from_user` char(36) NOT NULL,
	`to_user` char(36) NOT NULL,
	`currency` char(3) NOT NULL,
	`amount_minor` bigint NOT NULL,
	`settles_currency` char(3),
	`rate` decimal(18,8),
	`settled_minor` bigint,
	`paid_on` date NOT NULL,
	`note` text NOT NULL,
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` bigint NOT NULL DEFAULT 0,
	`deleted_at` datetime(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `processed_mutations` (
	`mutation_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `processed_mutations_mutation_id` PRIMARY KEY(`mutation_id`)
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`endpoint_hash` char(64) NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` varchar(255) NOT NULL,
	`auth` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`last_success_at` datetime(3),
	`fail_count` int NOT NULL DEFAULT 0,
	CONSTRAINT `push_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `push_subscriptions_endpoint_hash_unique` UNIQUE(`endpoint_hash`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` char(64) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`user_agent` varchar(255),
	CONSTRAINT `sessions_id_hash` PRIMARY KEY(`id_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email` varchar(254),
	`password_hash` varchar(255),
	`google_sub` varchar(64),
	`display_name` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `users_google_sub_unique` UNIQUE(`google_sub`)
);
--> statement-breakpoint
CREATE INDEX `act_group_version` ON `activity` (`group_id`,`version`);--> statement-breakpoint
CREATE INDEX `a_group_version` ON `attachments` (`group_id`,`version`);--> statement-breakpoint
CREATE INDEX `a_expense` ON `attachments` (`expense_id`);--> statement-breakpoint
CREATE INDEX `e_group_version` ON `expenses` (`group_id`,`version`);--> statement-breakpoint
CREATE INDEX `gm_user` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `p_group_version` ON `payments` (`group_id`,`version`);