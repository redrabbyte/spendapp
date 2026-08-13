-- Idempotency was keyed on the mutation id alone (design §4.8).
--
-- The row already carried `user_id` and nothing ever compared it, so "has this
-- been processed?" was a question about the instance rather than about the
-- caller: once any account had used an id, another account's mutation with the
-- same id was answered `applied` and silently dropped.
--
-- Widening the key, not replacing it. No row is deleted or rewritten — every
-- existing row keeps both of its values, and (mutation_id, user_id) cannot
-- collide for rows that were unique on mutation_id alone, so the ADD cannot
-- fail on existing data. Replays already recorded keep working: the same
-- caller retrying still matches its own row.
ALTER TABLE `processed_mutations` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `processed_mutations` ADD PRIMARY KEY(`mutation_id`,`user_id`);