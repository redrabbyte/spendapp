-- Email logins become plain usernames: nothing ever confirmed an address, so
-- it bought no assurance over a name. Existing accounts are carried over by
-- deriving a handle from the local part rather than forcing a re-registration.
ALTER TABLE `users` CHANGE `email` `username` varchar(254);--> statement-breakpoint
-- Local part only, stripped of characters usernames disallow, then trimmed of
-- leading/trailing punctuation so the result satisfies the shared regex.
UPDATE `users`
SET `username` = LEFT(
  REGEXP_REPLACE(
    REGEXP_REPLACE(SUBSTRING_INDEX(`username`, '@', 1), '[^A-Za-z0-9._-]', ''),
    '^[._-]+|[._-]+$',
    ''
  ),
  32
)
WHERE `username` IS NOT NULL;--> statement-breakpoint
-- Anything left under the 3-character minimum (or emptied entirely) is padded
-- from its own uuid, which is hex and therefore always allowed.
UPDATE `users`
SET `username` = CONCAT(`username`, LEFT(REPLACE(`id`, '-', ''), 3 - CHAR_LENGTH(`username`)))
WHERE `username` IS NOT NULL AND CHAR_LENGTH(`username`) < 3;--> statement-breakpoint
-- Two addresses sharing a local part (alice@a.com, alice@b.com) collide here
-- and fail the unique index. That is deliberate: with a handful of accounts a
-- loud failure to resolve by hand beats silently merging two identities.
ALTER TABLE `users` MODIFY `username` varchar(32);--> statement-breakpoint
ALTER TABLE `users` RENAME INDEX `users_email_unique` TO `users_username_unique`;
