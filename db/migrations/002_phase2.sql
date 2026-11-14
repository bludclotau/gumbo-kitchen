-- Phase 2. Idempotent. Does not edit 001 and does not touch wordfactory.* or agent_cluster.
-- The source check is the one object this migration replaces. Phase 1 created it
-- with no sequencer value, and a mixdown has to be stored as source = sequencer.

ALTER TABLE vibe.samples DROP CONSTRAINT IF EXISTS samples_source_check;
ALTER TABLE vibe.samples ADD CONSTRAINT samples_source_check CHECK (
    source IN ('synth', 'bark', 'wavbvkery', 'sampler', 'import', 'sequencer')
);

ALTER TABLE vibe.samples
    ADD COLUMN IF NOT EXISTS composition_id bigint REFERENCES vibe.compositions (id) ON DELETE SET NULL;

COMMENT ON COLUMN vibe.samples.composition_id IS
  'Set on a sequencer mixdown. Null for every other source.';

CREATE INDEX IF NOT EXISTS samples_composition_idx ON vibe.samples (composition_id);

ALTER TABLE vibe.layers
    ADD COLUMN IF NOT EXISTS stem_path text;

COMMENT ON COLUMN vibe.layers.stem_path IS
  'Solo preview WAV under renders/. Replaced when the composition is mixed again. Not a sample row.';
