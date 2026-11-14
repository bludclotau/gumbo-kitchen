-- Rolls back phase 2 only. Not run by `node src/migrate.mjs --down` (that drops schema vibe).
-- Destructive: deletes sampler and sequencer samples, their jobs, and every composition.
-- Apply by hand, and only when that is the intention.

DELETE FROM vibe.llm_calls
WHERE job_id IN (SELECT id FROM vibe.jobs WHERE module IN ('sampler', 'sequencer'));

DELETE FROM vibe.jobs WHERE module IN ('sampler', 'sequencer');

DELETE FROM vibe.layers;

DELETE FROM vibe.samples WHERE source IN ('sampler', 'sequencer');

DELETE FROM vibe.patches WHERE module IN ('sampler', 'sequencer');

DELETE FROM vibe.compositions;

DELETE FROM vibe.modules WHERE name IN ('sampler', 'sequencer');

ALTER TABLE vibe.layers DROP COLUMN IF EXISTS stem_path;

DROP INDEX IF EXISTS vibe.samples_composition_idx;

ALTER TABLE vibe.samples DROP COLUMN IF EXISTS composition_id;

ALTER TABLE vibe.samples DROP CONSTRAINT IF EXISTS samples_source_check;
ALTER TABLE vibe.samples ADD CONSTRAINT samples_source_check CHECK (
    source IN ('synth', 'bark', 'wavbvkery', 'sampler', 'import')
);

DELETE FROM vibe.schema_migrations WHERE filename = '002_phase2.sql';
