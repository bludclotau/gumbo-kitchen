# Module contract

Gumbo's Kitchen is the LLM control plane for the vibe-hub apps. A module turns a JSON command into an audio file. The model does not see the samples. The engine does not see the database. The orchestrator is the only process that talks to both.

The catalogue stays in Postgres schema `vibe`. Kitchen reads and writes that schema. It does not rename it.

```
prompt → qwen (JSON schema) → validate → vibe-fm → WAV
                                      ↘ vibe.patches
                                        vibe.samples
                                        vibe.llm_calls
                                        vibe.jobs
```

Phase 1 has one module, `fm-synth`. Later modules use the same tables and the same shape.

## Registration

`vibe.modules` holds one row per module.

| column | meaning |
| --- | --- |
| `name` | Stable id, referenced by `jobs.module` and `patches.module`. |
| `kind` | `synth`, `sampler`, `fx`, `sequencer`, or `lyrics`. |
| `version` | Contract version. The current FM module is `1`. |
| `param_schema` | JSON Schema for the object the model is allowed to emit. |
| `endpoint` | Logical program name. `fm-synth` stores `vibe-fm`. The orchestrator resolves that to `VIBE_FM_BIN` (default `engine/vibe-fm`). |

`node src/migrate.mjs` applies the SQL migrations, then upserts `fm-synth` from `schema/fm-synth.json`. That file is the schema the model is constrained to. Re-running the migrator updates the row in place.

## Command

The orchestrator inserts `vibe.jobs.command`:

```json
{ "prompt": "make a bold brassy trumpet chord for 0.50 seconds", "module": "fm-synth" }
```

The worker claims the oldest `pending` row (`FOR UPDATE SKIP LOCKED`), marks it `running`, and routes the prompt. Structured patches go to qwen at `VIBE_QWEN_URL` because that server accepts `response_format.type = json_schema`. Dolphin, at `VIBE_DOLPHIN_URL`, writes names, tags, and lyric text, and it expands a descriptive prompt into one concrete instruction before qwen runs. Neither URL has a default in the code. The model id is `VIBE_QWEN_MODEL` or `VIBE_DOLPHIN_MODEL`.

The request uses llama.cpp constrained decoding:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "fm_synth_patch", "strict": true, "schema": "<modules.param_schema>" }
  }
}
```

Every call, including a failed HTTP call, is inserted into `vibe.llm_calls` with the model id, the node URL, the messages, the response text, `latency_ms`, `job_id`, `attempt`, and `error`. `attempt` starts at 1. `error` is null when that reply was accepted.

The returned object is checked three times:

1. Numeric repair. This llama.cpp build constrains shape (types, required keys, enums, no extra keys) and does not enforce `minimum` or `maximum`. A velocity from 2 to 127 is read as MIDI and divided by 127. Any other number outside its schema range is clamped. Each change is recorded.
2. Ajv against `param_schema` on the repaired object.
3. A short musical check when the prompt asks for it. A chord must be three notes. Trumpet, brass, or horn must set `modulator.index` to at least 2.5 and `index_env_amount` to at least 0.85.

When the repaired object still fails, the validator text is sent back to the model. That loop runs at most three times. The job then fails with the last error. `llm_calls.response` keeps each reply. A timeout or a refused connection stops the loop immediately. An HTTP 400 from the schema grammar is retried, because that is the node rejecting the reply.

## What the engine adds

The model does not choose the seed or the sample rate. After validation the orchestrator writes the render document:

- `seed` — random 31-bit integer, stored on the sample and inside the patch.
- `engine` — `vibe-fm 1` for FM. The same text is stored on `samples.engine_version`. The C engine ignores the extra key.
- `sample_rate` — always `48000`.
- `duration_s` — if the prompt states a length (`0.50 seconds`), that length replaces the model's value. Outside `0.05..8` the job fails.
- operator `release` — shortened only when it is longer than 45% of `duration_s`, so the release ends inside the buffer.

Those edits are listed on `jobs.command.adjustments`. `llm_calls.response` keeps the model's own JSON. `samples.patch` and `patches.params` keep the document that was rendered.

## Engine invocation

```
vibe-fm render -o <wav> <patch.json>
```

Stdout is one JSON line:

```json
{"status":"ok","path":"...","frames":24000,"sample_rate":48000,"channels":1,"duration_s":0.500000,"seed":7,"peak":0.42}
```

A bad patch prints `{"status":"error","msg":"..."}` and exits non-zero. The WAV is mono 16-bit PCM. The same patch and seed render the same samples on this machine.

The orchestrator hashes the file (SHA-256), checks the duration, and inserts, in one transaction:

- `vibe.patches` — module, name, params, prompt, model.
- `vibe.samples` — `source = 'synth'`, path, hash, duration, rate, channels, tags, prompt, patch, seed.
- `vibe.jobs` — `status = 'done'`, `result_sample_id`, `patch_id`, node, model.

Tags for a synth render are `fm`, `synth`, plus prompt words such as `trumpet`, `brass`, and `chord`.

## FM synth parameters

`schema/fm-synth.json` is the full schema. The sound model:

- Up to three voices, struck together. This is a chord, not a sequence.
- Two operators per voice. The modulator sine is the carrier's phase deviation in radians.
- The carrier ADSR is the amplitude envelope.
- `index_env_amount` chooses which envelope scales the modulation index:

```
follow = (1 - amount) * modulator_adsr + amount * carrier_adsr
index_now = index * modulator.level * follow
```

`amount` 1 is the brass case: the index follows the loudness envelope. `amount` 0 follows the modulator's own ADSR.

- `lfo.target` is `off`, `pitch` (±100 cents at depth 1), `index`, or `amp`.
- Output is the sum of the voices, times `gain`, then `tanh`.

Gumbo's `fmpair_tick` (`gumbo-sampler/dsp/ftbl.c`) adds the modulator to a 0..1 wavetable cycle, so its index is not this index. The radian definition matches `mod-tracker/public/audio/fm-dsp.js`. The live Gumbo graph is one monophonic pair inside a realtime rack. This module is a separate offline binary in that C lineage, built for a stored patch rather than a line-oriented bot session.

`vibe-fm self-test` checks parse, determinism, the 0.50 s frame count, three-voice polyphony, and that `index_env_amount` 1 actually opens the index with the amplitude envelope.

## Samples row

| column | who fills it |
| --- | --- |
| `source` | `synth` for FM. `wavbvkery` for the imported kit. `sampler` and `sequencer` for phase 2. Later: `bark`, `import`. |
| `path` | Absolute WAV path. Unique. The web player only serves paths under `renders/` or the wavbvkery root. |
| `sha256` | Hash of the file bytes. |
| `duration_s`, `sample_rate`, `channels` | From the WAV. |
| `key`, `bpm` | Null for FM renders. The 808 filenames that say `(c)` are stored as key `C`. |
| `tags` | Folder and filename words for the kit. Prompt words for synth. |
| `prompt`, `patch`, `seed` | The originating prompt, the exact render document, and the seed. Null for imported kit files. |
| `parent_id` | The sample a sampler or sequencer render was made from. Null for FM and the imported kit. |
| `embedding` | Null. See below. |

## Embedding

There is no embedding server on the llama host. Qwen's hidden size is 3584 and Dolphin's is 2048. Those are decoder widths, and both servers advertise only `completion`, so they are the wrong thing to store.

The column is 384 `double precision` values, the width of **BAAI/bge-small-en-v1.5**. That model is small enough to serve later with llama.cpp `--embeddings`, and 384 is a practical width for an index over prompts and tags.

pgvector is not installed. PostgreSQL 16 here is the PGDG build (`/usr/pgsql-16`). `CREATE EXTENSION vector` fails because `vector.control` is absent, and this account cannot install packages or become the `postgres` superuser. `agent_cluster` has no vector columns either. After `pgvector_16` is installed and `CREATE EXTENSION vector` has been run, a new migration can change `samples.embedding` to `vector(384)`. Until then the check constraint only allows NULL or 384 floats.

## Jobs

`status` is `pending`, `running`, `done`, or `failed`.

On startup the orchestrator sets any `running` row back to `pending`. Run one orchestrator. A second process would reclaim a job the first process is still rendering.

`patch_id` is extra relative to the sketch. It points at the patch row even if you only have the job.

## Phase 2

Sampler and sequencer are registered from `schema/sampler.json` and `schema/sequencer.json`. A composition prompt is one constrained call. The object has both parameter objects plus `use_sampler` and `use_sequencer`, because slice ids do not exist until the sampler has run. The side that does not run is still filled with a neutral object so the grammar stays one shape.

The orchestrator resolves `latest`, `root`, and `previous`. `jobs.command.source_sample_id` or `source_job_id` wins when a caller already knows the row. It runs the sampler, then the sequencer. Every operation inserts a new `vibe.samples` row. `parent_id` points at the input. The command that produced the row is `samples.patch`. A mixdown uses `source = sequencer` and `samples.composition_id`.

`engine/dsp.mjs` is the sampler and the mixer. It is deterministic: seeded xorshift, no `Math.random`. Sampler ops keep the source rate and channel count. The mix is 48000 Hz stereo. It applies each layer's gain, pan, and `fx_chain` (`lowpass`, `highpass`, `delay`). The chain is not in the model schema. An empty chain is the normal case. Per-layer playback is a solo stem under `renders/`, stored on `layers.stem_path`.

Off-beats are the even steps of an 8th-note grid (`steps_per_bar` 8). A pattern is a JSON array of step objects on `layers.pattern`. Euclidean rhythms are three numbers on the sequencer command and are resolved before the mix, including probability. The mixer only sees steps marked `played`.

Stated counts, slice lists, tempos, and durations are copied from the instruction the model was given. The raw model JSON stays on `vibe.llm_calls`. A failed check is sent back to qwen, at most three calls. `db/migrations/003_llm_call_attempts.sql` adds `attempt` and `error`. `004_engine_version.sql` adds `samples.engine_version`. Sampler and mix rows store `dsp 1`. Older rows keep a null version and are not rewritten.

`npm run reproduce-check` re-renders a random set of rows from the stored patch and seed and compares WAV hashes. A slice mix that was summed from float buffers is replayed from those patches. A later mix that was summed from catalogue WAVs is replayed from those files.

`db/migrations/002_phase2.sql` adds `samples.composition_id`, `layers.stem_path`, and the `sequencer` source value. That source check is the one phase-1 constraint this migration replaces. `002_phase2.down.sql` removes the phase-2 rows and columns. The migrator's `--down` flag still drops the whole `vibe` schema and does not run that file by itself.

## Later modules

They fit the same contract. None of them need a new table.

- **Sampler and sequencer.** Built. See Phase 2.
- **FX module.** `kind = fx` is still unused. The mixer already runs a short `fx_chain`. A later module can fill that chain from the model.
- **Lyrics audio.** `kind = lyrics` is still unused. A prompt that asks for a lyric, a name, or tags is answered by dolphin and stored on `vibe.lyrics` with the job id. It does not render a WAV. Bark on the Geekom is still the path for a sung take.

A composition is a title, a bpm, and a key. A layer is a position, a sample, a pattern, an FX chain, gain, pan, and loop. Phase 2 fills those rows. Lyric text is filled when a prompt asks for it. Sung audio is still later.

## Run

```bash
cd /home/snerloc/vibe-hub/gumbo-kitchen
make -C engine test
npm install
set -a && source ../cyberrave-wordfactory/.env && set +a
node src/migrate.mjs
node src/import-wavbvkery.mjs
node src/self-check.mjs
node src/dsp-self-check.mjs
node src/reproduce-check.mjs --n 4
node src/server.mjs
```

`VIBE_QWEN_URL`, `VIBE_QWEN_MODEL`, `VIBE_DOLPHIN_URL`, and `VIBE_DOLPHIN_MODEL` come from the environment. This repo's gitignored `.env` is the place for them. The user service loads that file.

The page is `http://10.1.1.106:3920/`. The down migration drops schema `vibe` only. It runs only with `node src/migrate.mjs --down` and `VIBE_ALLOW_DOWN=yes`.
