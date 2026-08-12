-- Every entry now carries a key of its own (design §4.8). The columns were
-- nullable while old rows were being brought across; a null one afterwards
-- would be an entry nothing could grant and nothing could have written.
--
-- Self-guarding: MySQL refuses MODIFY ... NOT NULL while any row is still null
-- (ERROR 1138) and changes nothing, so running this before a group has finished
-- migrating fails loudly instead of coercing anything to an empty string.
--
-- DDL is not transactional in MySQL, so a refusal can leave the earlier
-- statements applied. Each one is idempotent — a column already NOT NULL is a
-- no-op — so the fix is to finish migrating the entries and run this again.
ALTER TABLE `expenses` MODIFY COLUMN `key_iv` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` MODIFY COLUMN `key_ct` varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `key_iv` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `key_ct` varchar(255) NOT NULL;