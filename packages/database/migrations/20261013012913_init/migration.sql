CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`before` text,
	`after` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`credentials` text,
	`exposure_sql` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`sdk_key` text NOT NULL UNIQUE,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`environment_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`value` real,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`hypothesis` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`feature_id` text NOT NULL,
	`environment_ids` text NOT NULL,
	`analysis_environment_id` text NOT NULL,
	`hash_attribute` text NOT NULL,
	`variations` text NOT NULL,
	`phases` text NOT NULL,
	`coverage` real NOT NULL,
	`weights` text NOT NULL,
	`conditions` text NOT NULL,
	`data_source_id` text NOT NULL,
	`primary_metric_id` text,
	`secondary_metric_ids` text NOT NULL,
	`guardrail_metric_ids` text NOT NULL,
	`stats` text NOT NULL,
	`plan` text NOT NULL,
	`decision` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`stopped_at` integer,
	CONSTRAINT `fk_experiments_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`)
);
--> statement-breakpoint
CREATE TABLE `exposures` (
	`environment_id` text NOT NULL,
	`experiment_key` text NOT NULL,
	`variation_key` text NOT NULL,
	`user_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	CONSTRAINT `exposures_pk` PRIMARY KEY(`environment_id`, `experiment_key`, `user_id`, `variation_key`)
);
--> statement-breakpoint
CREATE TABLE `feature_environments` (
	`feature_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`rules` text NOT NULL,
	CONSTRAINT `feature_environments_pk` PRIMARY KEY(`feature_id`, `environment_id`),
	CONSTRAINT `fk_feature_environments_feature_id_features_id_fk` FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_feature_environments_environment_id_environments_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`description` text DEFAULT '' NOT NULL,
	`value_type` text NOT NULL,
	`default_value` text NOT NULL,
	`tags` text NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer
);
--> statement-breakpoint
CREATE TABLE `metrics` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`data_source_id` text NOT NULL,
	`definition` text NOT NULL,
	`inverse` integer DEFAULT false NOT NULL,
	`window_hours` real,
	`delay_hours` real DEFAULT 0 NOT NULL,
	`capping` text NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `result_snapshots` (
	`id` text PRIMARY KEY,
	`experiment_id` text NOT NULL,
	`phase_index` integer NOT NULL,
	`computed_at` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`health` text,
	`metrics` text NOT NULL,
	CONSTRAINT `fk_result_snapshots_experiment_id_experiments_id_fk` FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL UNIQUE,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	CONSTRAINT `fk_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `events_name_user_ts_idx` ON `events` (`environment_id`,`name`,`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`environment_id`,`ts`);--> statement-breakpoint
CREATE INDEX `experiments_feature_idx` ON `experiments` (`feature_id`);--> statement-breakpoint
CREATE INDEX `exposures_experiment_time_idx` ON `exposures` (`environment_id`,`experiment_key`,`first_seen_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_idx` ON `invitations` (`token`);--> statement-breakpoint
CREATE INDEX `result_snapshots_experiment_idx` ON `result_snapshots` (`experiment_id`,`computed_at`);--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);