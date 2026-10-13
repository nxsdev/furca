ALTER TABLE `exposures` ADD `phase` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_exposures` (
	`environment_id` text NOT NULL,
	`experiment_key` text NOT NULL,
	`variation_key` text NOT NULL,
	`user_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`phase` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `exposures_pk` PRIMARY KEY(`environment_id`, `experiment_key`, `phase`, `user_id`, `variation_key`)
);
--> statement-breakpoint
INSERT INTO `__new_exposures`(`environment_id`, `experiment_key`, `variation_key`, `user_id`, `first_seen_at`) SELECT `environment_id`, `experiment_key`, `variation_key`, `user_id`, `first_seen_at` FROM `exposures`;--> statement-breakpoint
DROP TABLE `exposures`;--> statement-breakpoint
ALTER TABLE `__new_exposures` RENAME TO `exposures`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `exposures_experiment_time_idx`;--> statement-breakpoint
CREATE INDEX `exposures_time_idx` ON `exposures` (`environment_id`,`first_seen_at`);