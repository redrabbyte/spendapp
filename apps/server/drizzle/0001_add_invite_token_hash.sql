-- Backfill runs before 0002 makes these NOT NULL and swaps the primary key.
-- SHA2(x, 256) is lowercase hex, which is what createHash('sha256').digest('hex')
-- produces, so a link already handed out still resolves to its row.
ALTER TABLE `invites` ADD `token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `join_requests` ADD `invite_token_hash` varchar(64);--> statement-breakpoint
UPDATE `invites` SET `token_hash` = SHA2(`token`, 256) WHERE `token_hash` IS NULL;--> statement-breakpoint
UPDATE `join_requests` SET `invite_token_hash` = SHA2(`invite_token`, 256) WHERE `invite_token_hash` IS NULL;
