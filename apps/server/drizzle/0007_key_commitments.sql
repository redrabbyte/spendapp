-- Anchors the first keyring hand-over (design §4.2).
--
-- A wrap is sealed to a public key this server publishes, so nothing in one
-- says a member made it — a device holding no keyring had to take the delivery
-- on trust. A commitment is sealed under the *user's own KEK*, which is derived
-- from their password and has never been here, so this server can store one and
-- cannot forge one. A second device checks what it is handed against these.
--
-- Purely additive: no existing row is read, rewritten or dropped, and a client
-- that has never written a commitment behaves exactly as before. Existing
-- members backfill their own on the next sync, from keys already on the device.
CREATE TABLE `key_commitments` (
	`group_id` char(36) NOT NULL,
	`epoch` int NOT NULL,
	`user_id` char(36) NOT NULL,
	`iv` varchar(32) NOT NULL,
	`ct` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `key_commitments_group_id_epoch_user_id_pk` PRIMARY KEY(`group_id`,`epoch`,`user_id`)
);
--> statement-breakpoint
CREATE INDEX `kc_user_group` ON `key_commitments` (`user_id`,`group_id`);