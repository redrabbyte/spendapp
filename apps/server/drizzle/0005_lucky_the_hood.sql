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
ALTER TABLE `group_members` ADD `role` varchar(16) DEFAULT 'member' NOT NULL;--> statement-breakpoint
CREATE INDEX `jr_group_status` ON `join_requests` (`group_id`,`status`);--> statement-breakpoint
-- Every existing group needs an admin or nobody could ever approve a join.
-- The creator is the natural choice.
UPDATE `group_members` gm
	JOIN `groups` g ON g.id = gm.group_id
	SET gm.role = 'admin'
	WHERE gm.user_id = g.created_by;--> statement-breakpoint
-- Groups whose creator has since left would be left with no admin at all, so
-- promote the earliest-joined remaining member. A tie promotes both, which is
-- harmless. The derived table is materialised, so reading group_members while
-- updating it is allowed here.
UPDATE `group_members` gm
	JOIN (
		SELECT gm2.group_id, MIN(gm2.joined_at) AS first_joined
		FROM `group_members` gm2
		LEFT JOIN `group_members` adm
			ON adm.group_id = gm2.group_id AND adm.role = 'admin' AND adm.left_at IS NULL
		WHERE gm2.left_at IS NULL AND adm.user_id IS NULL
		GROUP BY gm2.group_id
	) pick ON pick.group_id = gm.group_id AND pick.first_joined = gm.joined_at
	SET gm.role = 'admin'
	WHERE gm.left_at IS NULL;
