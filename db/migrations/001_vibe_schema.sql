-- vibe schema for the vibe-hub control plane.
-- Idempotent. Creates objects only. Does not alter wordfactory.* or public.*.
-- Apply with: node src/migrate.mjs
--
-- Database: wordfactory (PostgreSQL 16). The wordfactory role can CREATE
-- a schema here and cannot CREATE DATABASE. agent_cluster is left untouched.
--
-- pgvector is not installed on this server (no vector.control under
-- /usr/pgsql-16). samples.embedding is double precision[] of length 384,
-- the width of BAAI/bge-small-en-v1.5. A later migration can cast it to
-- vector(384) after CREATE EXTENSION vector.

CREATE SCHEMA IF NOT EXISTS vibe;

COMMENT ON SCHEMA vibe IS
  'vibe-hub control plane. Audio bytes live on disk. This schema stores patches, jobs, and catalogue rows.';

CREATE TABLE IF NOT EXISTS vibe.schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vibe.modules (
    id bigserial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    kind text NOT NULL,
    version text NOT NULL,
    param_schema jsonb NOT NULL,
    endpoint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT modules_kind_check CHECK (
        kind IN ('synth', 'sampler', 'fx', 'sequencer', 'lyrics')
    ),
    CONSTRAINT modules_name_check CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE TABLE IF NOT EXISTS vibe.samples (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    source text NOT NULL,
    path text NOT NULL UNIQUE,
    sha256 text NOT NULL,
    duration_s numeric NOT NULL,
    sample_rate integer NOT NULL,
    channels integer NOT NULL,
    key text,
    bpm numeric,
    tags text[] NOT NULL DEFAULT '{}',
    prompt text,
    patch jsonb,
    seed bigint,
    parent_id bigint REFERENCES vibe.samples (id) ON DELETE SET NULL,
    embedding double precision[],
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT samples_source_check CHECK (
        source IN ('synth', 'bark', 'wavbvkery', 'sampler', 'import')
    ),
    CONSTRAINT samples_duration_check CHECK (duration_s >= 0),
    CONSTRAINT samples_rate_check CHECK (sample_rate > 0),
    CONSTRAINT samples_channels_check CHECK (channels BETWEEN 1 AND 8),
    CONSTRAINT samples_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT samples_embedding_dim CHECK (
        embedding IS NULL OR cardinality(embedding) = 384
    )
);

COMMENT ON COLUMN vibe.samples.embedding IS
  '384 floats for BAAI/bge-small-en-v1.5. NULL until that model is served. Not pgvector: the extension is not installed on this PostgreSQL 16.';

COMMENT ON COLUMN vibe.samples.key IS
  'Musical key, for example C or F#. NULL when the file does not say.';

COMMENT ON COLUMN vibe.samples.parent_id IS
  'Sample this row was rendered from. Set by later sampler and FX modules.';

CREATE INDEX IF NOT EXISTS samples_source_idx ON vibe.samples (source, created_at DESC);
CREATE INDEX IF NOT EXISTS samples_tags_idx ON vibe.samples USING gin (tags);
CREATE INDEX IF NOT EXISTS samples_sha_idx ON vibe.samples (sha256);
CREATE INDEX IF NOT EXISTS samples_parent_idx ON vibe.samples (parent_id);

CREATE TABLE IF NOT EXISTS vibe.patches (
    id bigserial PRIMARY KEY,
    module text NOT NULL REFERENCES vibe.modules (name),
    name text NOT NULL,
    params jsonb NOT NULL,
    prompt text,
    model text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patches_module_idx ON vibe.patches (module, created_at DESC);

CREATE TABLE IF NOT EXISTS vibe.jobs (
    id bigserial PRIMARY KEY,
    module text NOT NULL REFERENCES vibe.modules (name),
    command jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    node text,
    model text,
    result_sample_id bigint REFERENCES vibe.samples (id) ON DELETE SET NULL,
    patch_id bigint REFERENCES vibe.patches (id) ON DELETE SET NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT jobs_status_check CHECK (
        status IN ('pending', 'running', 'done', 'failed')
    ),
    CONSTRAINT jobs_command_object CHECK (jsonb_typeof(command) = 'object')
);

COMMENT ON COLUMN vibe.jobs.patch_id IS
  'Added so a job points at the exact patch row. The proposed table had only result_sample_id.';

CREATE INDEX IF NOT EXISTS jobs_status_idx ON vibe.jobs (status, id);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON vibe.jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS vibe.compositions (
    id bigserial PRIMARY KEY,
    title text NOT NULL,
    bpm numeric NOT NULL DEFAULT 120,
    key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT compositions_bpm_check CHECK (bpm > 0 AND bpm <= 400)
);

CREATE TABLE IF NOT EXISTS vibe.layers (
    id bigserial PRIMARY KEY,
    composition_id bigint NOT NULL REFERENCES vibe.compositions (id) ON DELETE CASCADE,
    position integer NOT NULL,
    sample_id bigint REFERENCES vibe.samples (id) ON DELETE RESTRICT,
    pattern jsonb NOT NULL DEFAULT '[]'::jsonb,
    fx_chain jsonb NOT NULL DEFAULT '[]'::jsonb,
    gain numeric NOT NULL DEFAULT 1,
    pan numeric NOT NULL DEFAULT 0,
    loop boolean NOT NULL DEFAULT false,
    CONSTRAINT layers_position_unique UNIQUE (composition_id, position),
    CONSTRAINT layers_gain_check CHECK (gain >= 0 AND gain <= 4),
    CONSTRAINT layers_pan_check CHECK (pan >= -1 AND pan <= 1),
    CONSTRAINT layers_pattern_array CHECK (jsonb_typeof(pattern) = 'array'),
    CONSTRAINT layers_fx_array CHECK (jsonb_typeof(fx_chain) = 'array')
);

CREATE INDEX IF NOT EXISTS layers_sample_idx ON vibe.layers (sample_id);

CREATE TABLE IF NOT EXISTS vibe.lyrics (
    id bigserial PRIMARY KEY,
    text text NOT NULL,
    treatment text,
    sample_id bigint REFERENCES vibe.samples (id) ON DELETE SET NULL,
    job_id bigint REFERENCES vibe.jobs (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lyrics_job_idx ON vibe.lyrics (job_id);

CREATE TABLE IF NOT EXISTS vibe.llm_calls (
    id bigserial PRIMARY KEY,
    model text NOT NULL,
    node text NOT NULL,
    prompt text NOT NULL,
    response text NOT NULL,
    latency_ms integer NOT NULL,
    job_id bigint REFERENCES vibe.jobs (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_calls_latency_check CHECK (latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS llm_calls_job_idx ON vibe.llm_calls (job_id, id);

COMMENT ON TABLE vibe.layers IS
  'Empty until the sequencer and FX modules exist. pattern and fx_chain are ready for those commands.';

COMMENT ON TABLE vibe.lyrics IS
  'Empty until the lyrics module exists. A Bark job on the Geekom will fill sample_id and job_id.';
