CREATE TABLE `entry_grants` (
	`entry_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`entry_type` varchar(10) NOT NULL,
	`epk` varchar(64) NOT NULL,
	`iv` varchar(32) NOT NULL,
	`ct` varchar(255) NOT NULL,
	`granted_by` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `entry_grants_entry_id_user_id_pk` PRIMARY KEY(`entry_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `expenses` ADD `key_iv` varchar(32);--> statement-breakpoint
ALTER TABLE `expenses` ADD `key_ct` varchar(255);--> statement-breakpoint
ALTER TABLE `payments` ADD `key_iv` varchar(32);--> statement-breakpoint
ALTER TABLE `payments` ADD `key_ct` varchar(255);--> statement-breakpoint
CREATE INDEX `eg_group_user` ON `entry_grants` (`group_id`,`user_id`);