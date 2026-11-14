-- Records each model try. Idempotent. Does not drop or rewrite existing rows.
-- Older calls get attempt 1 and a null error, which is the backfill default.

ALTER TABLE vibe.llm_calls
    ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

ALTER TABLE vibe.llm_calls
    ADD COLUMN IF NOT EXISTS error text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'llm_calls_attempt_check'
    ) THEN
        ALTER TABLE vibe.llm_calls
            ADD CONSTRAINT llm_calls_attempt_check CHECK (attempt >= 1);
    END IF;
END $$;

COMMENT ON COLUMN vibe.llm_calls.attempt IS
  '1-based try for this job. A failed schema check is sent back, up to 3 tries.';

COMMENT ON COLUMN vibe.llm_calls.error IS
  'Validator or transport error for this try. Null when the reply was accepted.';
