-- Stores the renderer identity next to the patch and seed. Idempotent.
-- Existing rows stay NULL. This migration does not rewrite them.

ALTER TABLE vibe.samples
    ADD COLUMN IF NOT EXISTS engine_version text;

COMMENT ON COLUMN vibe.samples.engine_version IS
  'Renderer that wrote the WAV, for example vibe-fm 1 or dsp 1. Null on rows rendered before this column existed.';
