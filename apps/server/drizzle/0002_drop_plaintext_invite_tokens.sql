ALTER TABLE `invites` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `invites` MODIFY COLUMN `token_hash` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `join_requests` MODIFY COLUMN `invite_token_hash` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `invites` ADD PRIMARY KEY(`token_hash`);--> statement-breakpoint
ALTER TABLE `invites` DROP COLUMN `token`;--> statement-breakpoint
ALTER TABLE `join_requests` DROP COLUMN `invite_token`;