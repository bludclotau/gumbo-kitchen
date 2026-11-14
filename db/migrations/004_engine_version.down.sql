-- Rolls back the engine version column only. Not run by `node src/migrate.mjs --down`.
-- Apply by hand, and only when that is the intention.

ALTER TABLE vibe.samples DROP COLUMN IF EXISTS engine_version;

DELETE FROM vibe.schema_migrations WHERE filename = '004_engine_version.sql';
