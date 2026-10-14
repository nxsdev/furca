CREATE TABLE `change_requests` (
	`id` text PRIMARY KEY,
	`feature_id` text NOT NULL,
	`feature_key` text NOT NULL,
	`environment_id` text NOT NULL,
	`change` text NOT NULL,
	`base` text NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`author_id` text NOT NULL,
	`author_email` text NOT NULL,
	`reviewer_id` text,
	`reviewer_email` text,
	`review_comment` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`reviewed_at` integer,
	CONSTRAINT `fk_change_requests_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_change_requests_environment_id_environments_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `environments` ADD `require_approval` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invitations` ADD `role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
CREATE INDEX `change_requests_status_idx` ON `change_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `change_requests_feature_idx` ON `change_requests` (`feature_id`);--> statement-breakpoint
-- Everyone had full access before roles: existing members and pending invitations become admins, the first account the owner
UPDATE `user` SET `role` = 'admin';--> statement-breakpoint
UPDATE `invitations` SET `role` = 'admin';--> statement-breakpoint
UPDATE `user` SET `role` = 'owner' WHERE `id` = (SELECT `id` FROM `user` ORDER BY `created_at`, `id` LIMIT 1);
