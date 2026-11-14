-- Rolls back the attempt log only. Not run by `node src/migrate.mjs --down`.
-- Apply by hand, and only when that is the intention.

ALTER TABLE vibe.llm_calls DROP CONSTRAINT IF EXISTS llm_calls_attempt_check;
ALTER TABLE vibe.llm_calls DROP COLUMN IF EXISTS error;
ALTER TABLE vibe.llm_calls DROP COLUMN IF EXISTS attempt;

DELETE FROM vibe.schema_migrations WHERE filename = '003_llm_call_attempts.sql';
