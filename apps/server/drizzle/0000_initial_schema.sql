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
	`key_epoch` int NOT NULL,
	`created_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`version` bigint NOT NULL DEFAULT 0,
	`deleted_at` datetime(3),
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`key_epoch` int NOT NULL,
	`iv` varchar(32) NOT NULL,
	`ct` text NOT NULL,
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
CREATE TABLE `group_keys` (
	`group_id` char(36) NOT NULL,
	`epoch` int NOT NULL,
	`user_id` char(36) NOT NULL,
	`epk` varchar(64) NOT NULL,
	`iv` varchar(32) NOT NULL,
	`ct` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `group_keys_group_id_epoch_user_id_pk` PRIMARY KEY(`group_id`,`epoch`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`joined_at` datetime(3) NOT NULL,
	`left_at` datetime(3),
	`role` varchar(16) NOT NULL DEFAULT 'member',
	`alias_of` char(36),
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
	`max_uses` int NOT NULL DEFAULT 1,
	`use_count` int NOT NULL DEFAULT 0,
	`share_history` boolean NOT NULL DEFAULT true,
	CONSTRAINT `invites_token` PRIMARY KEY(`token`)
);
--> statement-breakpoint
CREATE TABLE `join_requests` (
	`group_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`invite_token` varchar(43) NOT NULL,
	`claim_member_id` char(36),
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`requested_at` datetime(3) NOT NULL,
	`decided_by` char(36),
	`decided_at` datetime(3),
	CONSTRAINT `join_requests_group_id_user_id_pk` PRIMARY KEY(`group_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`key_epoch` int NOT NULL,
	`iv` varchar(32) NOT NULL,
	`ct` text NOT NULL,
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
	`username` varchar(32),
	`password_hash` varchar(255),
	`kdf_salt` varchar(64),
	`kdf_params` json,
	`public_key` varchar(64),
	`wrapped_private_key` text,
	`display_name` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`privacy_accepted_at` datetime(3),
	`privacy_version` varchar(64),
	`deleted_at` datetime(3),
	`is_placeholder` boolean NOT NULL DEFAULT false,
	`placeholder_group_id` char(36),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE INDEX `act_group_version` ON `activity` (`group_id`,`version`);--> statement-breakpoint
CREATE INDEX `a_group_version` ON `attachments` (`group_id`,`version`);--> statement-breakpoint
CREATE INDEX `a_expense` ON `attachments` (`expense_id`);--> statement-breakpoint
CREATE INDEX `e_group_version` ON `expenses` (`group_id`,`version`);--> statement-breakpoint
CREATE INDEX `gk_user_group` ON `group_keys` (`user_id`,`group_id`);--> statement-breakpoint
CREATE INDEX `gm_user` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `jr_group_status` ON `join_requests` (`group_id`,`status`);--> statement-breakpoint
CREATE INDEX `p_group_version` ON `payments` (`group_id`,`version`);