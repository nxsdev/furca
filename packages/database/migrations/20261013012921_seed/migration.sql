-- Default environments with random public SDK keys
INSERT INTO `environments` (`id`, `key`, `name`, `sdk_key`, `sort_order`) VALUES
  ('env_production', 'production', 'Production', 'sdk-' || lower(hex(randomblob(12))), 0),
  ('env_development', 'development', 'Development', 'sdk-' || lower(hex(randomblob(12))), 1);
--> statement-breakpoint
-- Built-in event store (D1). Cannot be deleted
INSERT INTO `data_sources` (`id`, `name`, `type`, `config`, `credentials`, `exposure_sql`) VALUES
  ('builtin', 'Built-in event store', 'builtin', NULL, NULL, '');
