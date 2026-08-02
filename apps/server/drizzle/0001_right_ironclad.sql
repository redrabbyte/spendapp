ALTER TABLE `expenses` MODIFY COLUMN `expense_date` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `rate_to_default` decimal(18,8);