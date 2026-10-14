CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`secret_hash` text NOT NULL UNIQUE,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `namespaces` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_groups` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`conditions` text NOT NULL,
	`attribute` text DEFAULT '' NOT NULL,
	`values` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`format` text NOT NULL,
	`events` text NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_delivered_at` integer,
	`last_status` integer,
	`last_error` text
);
--> statement-breakpoint
ALTER TABLE `events` ADD `properties` text;--> statement-breakpoint
ALTER TABLE `experiments` ADD `dimensions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `namespace` text;--> statement-breakpoint
ALTER TABLE `exposures` ADD `dimensions` text;--> statement-breakpoint
-- Existing event metrics get an empty property filter list (EventSource.filters is required)
UPDATE `metrics` SET `definition` = json_set(`definition`, '$.numerator.filters', json('[]'))
  WHERE json_extract(`definition`, '$._tag') = 'event' AND json_type(`definition`, '$.numerator.filters') IS NULL;--> statement-breakpoint
UPDATE `metrics` SET `definition` = json_set(`definition`, '$.denominator.filters', json('[]'))
  WHERE json_extract(`definition`, '$._tag') = 'event' AND json_type(`definition`, '$.denominator') = 'object'
    AND json_type(`definition`, '$.denominator.filters') IS NULL;
