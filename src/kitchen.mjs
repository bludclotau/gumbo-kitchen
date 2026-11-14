import { createHash, randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { config } from "./config.mjs";
import { pool, query } from "./db.mjs";
import {
  decodeWav,
  encodeWav,
  estimateBpm,
  estimateKey,
  mixLayers,
  renderSampler,
} from "../engine/dsp.mjs";
import { completeStructured, parseModelJson } from "./llm.mjs";
import { coerceToSchema } from "./patch.mjs";
import { PLAN_SYSTEM_PROMPT, buildPattern, normalizePlan, planErrors, planSchema } from "./plan.mjs";
import { inspectWav } from "./wav.mjs";

const ajv = new Ajv({ allErrors: true, strict: true });

const SKIP_TAGS = new Set([
  "sampler", "sequencer", "mixdown", "mix", "slice", "grain", "capture", "trim",
  "normalise", "normalize", "reverse", "pitch", "stretch", "loop", "short", "mid", "long",
]);

function slug(value) {
  return String(value || "sample")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "sample";
}

function durationTag(duration) {
  if (duration < 1) return "short";
  if (duration >= 4) return "long";
  return "mid";
}

function tagsFor(parentTags, { source, op, duration, key, bpm }) {
  const tags = [source, op, durationTag(duration)];
  if (op === "mix") tags.push("mixdown");
  for (const tag of parentTags || []) {
    if (SKIP_TAGS.has(tag) || String(tag).startsWith("bpm-")) continue;
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (key) {
    const keyTag = String(key).toLowerCase();
    if (!tags.includes(keyTag)) tags.push(keyTag);
  }
  if (bpm != null) tags.push(`bpm-${Math.round(Number(bpm))}`);
  return tags;
}

function artefactName(parentName, op, index, jobId) {
  const base = slug(parentName);
  if (op === "slice") return `${base}-slice-${String(index).padStart(2, "0")}`;
  if (op === "mix") return `${base}-mix-${jobId}`;
  return `${base}-${op}-${jobId}`;
}

async function loadModule(name) {
  const { rows } = await query(`SELECT name, param_schema FROM vibe.modules WHERE name = $1`, [name]);
  if (!rows[0]) throw new Error(`module ${name} is not registered`);
  return rows[0];
}

async function askPlan(job, schema, seed, prompt) {
  const validate = ajv.compile(structuredClone(schema));
  const base = [
    { role: "system", content: PLAN_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  let raw = "";
  let lastError = "no attempt";
  const adjustments = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const messages = attempt === 1
      ? base
      : [
          ...base,
          { role: "assistant", content: raw || "{}" },
          {
            role: "user",
            content: `That object failed a check: ${lastError}. Return a corrected object with every required key.`,
          },
        ];
    try {
      console.log(`job ${job.id} kitchen attempt ${attempt}`);
      raw = await completeStructured({
        messages,
        schema,
        seed,
        jobId: job.id,
        maxTokens: 900,
        schemaName: "kitchen_plan",
      });
    } catch (err) {
      lastError = String(err.message || err).slice(0, 800);
      if (attempt === 3 || /HTTP 400|timeout|aborted|ECONNREFUSED/i.test(lastError)) throw err;
      continue;
    }
    try {
      const parsed = parseModelJson(raw);
      adjustments.length = 0;
      const modelObj = coerceToSchema(parsed, schema, "plan", adjustments);
      const normalized = normalizePlan(modelObj, prompt);
      adjustments.push(...normalized.adjustments);
      if (!validate(normalized.plan)) throw new Error(ajv.errorsText(validate.errors));
      const semantic = planErrors(prompt, normalized.plan);
      if (semantic.length) throw new Error(semantic.join("; "));
      return { plan: normalized.plan, adjustments: [...adjustments] };
    } catch (err) {
      lastError = String(err.message || err).slice(0, 800);
      if (attempt === 3) throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

function mapSample(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    path: row.path,
    tags: row.tags || [],
    name: row.name,
    key: row.key,
    bpm: row.bpm == null ? null : Number(row.bpm),
    source: row.source,
  };
}

async function sampleById(id) {
  const { rows } = await query(
    `SELECT id, parent_id, path, tags, name, key, bpm, source FROM vibe.samples WHERE id = $1`,
    [id],
  );
  const row = mapSample(rows[0]);
  if (!row) throw new Error(`sample ${id} not found`);
  return row;
}

export async function resolveSource(spec, job) {
  const command = job?.command || {};
  if (command.source_sample_id) return sampleById(command.source_sample_id);
  if (command.source_job_id) {
    const { rows } = await query(`SELECT result_sample_id FROM vibe.jobs WHERE id = $1`, [command.source_job_id]);
    if (!rows[0]?.result_sample_id) throw new Error(`job ${command.source_job_id} has no sample`);
    return sampleById(rows[0].result_sample_id);
  }
  const ref = spec?.source_ref || "latest";
  const { rows } = await query(
    `SELECT id, parent_id, path, tags, name, key, bpm, source
     FROM vibe.samples ORDER BY id DESC LIMIT 1`,
  );
  const latest = mapSample(rows[0]);
  if (!latest) throw new Error("no samples in the catalogue");
  if (ref === "latest") return latest;
  if (ref === "previous") {
    if (!latest.parentId) throw new Error("latest sample has no parent");
    return sampleById(latest.parentId);
  }
  if (ref === "root") {
    let row = latest;
    while (row.parentId) row = await sampleById(row.parentId);
    return row;
  }
  throw new Error(`unknown source_ref ${ref}`);
}

function productPatch(command, sourceId, index, seed) {
  const patch = {
    op: command.op,
    source_sample_id: sourceId,
    source_ref: command.source_ref,
    seed,
  };
  if (command.op === "slice") {
    patch.slice_mode = command.slice_mode;
    patch.count = command.count;
    patch.index = index;
    patch.beats_per_slice = command.beats_per_slice;
    patch.grid_bpm = command.grid_bpm;
  } else if (command.op === "grain") {
    Object.assign(patch, {
      duration_s: command.duration_s,
      grain_size_s: command.grain_size_s,
      density: command.density,
      position_jitter: command.position_jitter,
      pitch_jitter: command.pitch_jitter,
      window: command.window,
      normalised_peak: 0.7,
    });
  } else if (command.op === "trim") {
    patch.start_s = command.start_s;
    patch.end_s = command.end_s;
  } else if (command.op === "pitch") {
    patch.semitones = command.semitones;
    patch.preserve_duration = !!command.preserve_duration;
  } else if (command.op === "stretch") {
    patch.stretch = command.stretch;
  } else if (command.op === "loop") {
    patch.loop_start_s = command.loop_start_s;
    patch.loop_end_s = command.loop_end_s;
    patch.crossfade_s = command.crossfade_s;
  }
  return patch;
}

async function writeAudio(file, samples, sampleRate, channels) {
  const buf = encodeWav(samples, sampleRate, channels);
  await fs.writeFile(file, buf);
  const info = inspectWav(buf);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { info, sha256 };
}

const audioCache = new Map();

async function loadAudio(id) {
  if (audioCache.has(id)) return audioCache.get(id);
  const row = await sampleById(id);
  const decoded = decodeWav(await fs.readFile(row.path));
  const audio = { ...decoded, sampleId: row.id, tags: row.tags, name: row.name, key: row.key, bpm: row.bpm };
  audioCache.set(id, audio);
  return audio;
}

function statedBpm(prompt) {
  const match = String(prompt).match(/(\d+(?:\.\d+)?)\s*bpm/i);
  return match ? Number(match[1]) : null;
}

function statedKey(prompt) {
  const match = String(prompt).match(/\b(?:key\s+(?:of\s+)?|in\s+)([A-G](?:#|b)?)\b/i);
  if (!match) return null;
  const letter = match[1][0].toUpperCase();
  const mark = match[1][1] === "#" ? "#" : match[1][1] && match[1][1].toLowerCase() === "b" ? "b" : "";
  return letter + mark;
}

function storedPattern(events) {
  return (events || []).map((event) => ({
    step: event.step,
    steps_per_bar: event.steps_per_bar,
    sample_id: event.sample_id,
    velocity: event.velocity,
    pitch_offset: event.pitch_offset,
    probability: event.probability,
    played: event.played,
  }));
}

async function hydrateLayer(row) {
  const pattern = Array.isArray(row.pattern) ? row.pattern : [];
  const events = [];
  for (const event of pattern) {
    if (!event.sample_id) continue;
    const audio = await loadAudio(event.sample_id);
    events.push({
      step: Number(event.step),
      steps_per_bar: Number(event.steps_per_bar || 8),
      velocity: Number(event.velocity ?? 1),
      pitch_offset: Number(event.pitch_offset ?? 0),
      probability: Number(event.probability ?? 1),
      played: event.played !== false,
      buffer: audio.samples,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      sample_id: Number(event.sample_id),
    });
  }
  const layer = {
    id: Number(row.id),
    position: Number(row.position),
    gain: Number(row.gain),
    pan: Number(row.pan),
    loop: !!row.loop,
    fx_chain: Array.isArray(row.fx_chain) ? row.fx_chain : [],
    sampleId: row.sample_id == null ? null : Number(row.sample_id),
    events: pattern.length ? events : null,
    oneShot: null,
    pattern,
  };
  if (!pattern.length && layer.sampleId) {
    const audio = await loadAudio(layer.sampleId);
    layer.oneShot = audio;
  }
  return layer;
}

export async function runKitchen(job) {
  const prompt = String(job.command?.prompt || "").trim();
  if (!prompt) throw new Error("job has no prompt");
  const samplerMod = await loadModule("sampler");
  const sequencerMod = await loadModule("sequencer");
  const schema = planSchema(samplerMod.param_schema, sequencerMod.param_schema);
  const seed = randomInt(1, 2147483647);
  const asked = await askPlan(job, schema, seed, prompt);
  const plan = asked.plan;
  const adjustments = [...asked.adjustments];

  await fs.mkdir(config.rendersDir, { recursive: true });
  let source = null;
  const rendered = [];
  if (plan.use_sampler) {
    source = await resolveSource(plan.sampler, job);
    const decoded = decodeWav(await fs.readFile(source.path));
    const buffers = renderSampler(decoded, plan.sampler, seed);
    buffers.forEach((buffer, index) => {
      rendered.push({
        ...buffer,
        index: index + 1,
        patch: productPatch(plan.sampler, source.id, index + 1, seed),
        parentTags: source.tags,
        parentName: source.name,
        parentId: source.id,
      });
    });
    if (plan.sampler.op === "grain") {
      const got = rendered[0].samples.length / rendered[0].channels / rendered[0].sampleRate;
      if (Math.abs(got - Number(plan.sampler.duration_s)) > 0.001) {
        throw new Error(`grain rendered ${got}s, plan asked for ${plan.sampler.duration_s}s`);
      }
    }
  }

  let compositionId = job.command?.composition_id ? Number(job.command.composition_id) : null;
  let comp = null;
  let layers = [];
  if (plan.use_sequencer && compositionId) {
    const { rows } = await query(
      `SELECT id, title, bpm, key FROM vibe.compositions WHERE id = $1`,
      [compositionId],
    );
    if (!rows[0]) throw new Error(`composition ${compositionId} not found`);
    comp = {
      id: Number(rows[0].id),
      title: rows[0].title,
      bpm: Number(rows[0].bpm),
      key: rows[0].key,
    };
    const layerRows = await query(
      `SELECT id, position, sample_id, pattern, fx_chain, gain, pan, loop
       FROM vibe.layers WHERE composition_id = $1 ORDER BY position`,
      [compositionId],
    );
    layers = [];
    for (const row of layerRows.rows) layers.push(await hydrateLayer(row));
  }

  let bpm = comp ? comp.bpm : Number(plan.sequencer.bpm);
  let mixKey = comp?.key || null;
  if (plan.use_sequencer) {
    const askedBpm = statedBpm(prompt);
    if (askedBpm != null) bpm = Number(plan.sequencer.bpm);
    else if (!layers.length) bpm = Number(plan.sequencer.bpm);
    else adjustments.push(`bpm left at ${bpm} because the prompt did not state a tempo`);
    const askedKey = statedKey(prompt);
    if (askedKey) mixKey = askedKey;
  }

  const seq = plan.sequencer;
  const wantsGrid = plan.use_sequencer && (
    (seq.slice_indices || []).length > 0 || Number(seq.euclidean_pulses) > 0
  );
  let newLayer = null;
  const action = seq.action;
  if (plan.use_sequencer && (action === "add_layer" || action === "create_pattern" || action === "edit_pattern")) {
    let oneShot = null;
    let events = null;
    if (wantsGrid) {
      if (!rendered.length && action !== "edit_pattern") {
        throw new Error("the pattern names slices but this plan did not render any");
      }
      const built = buildPattern({
        placement: seq.placement,
        stepsPerBar: seq.steps_per_bar,
        bars: seq.bars,
        sliceIndices: seq.slice_indices || [],
        velocity: seq.velocity,
        pitchOffset: seq.pitch_offset,
        probability: seq.probability,
        pulses: seq.euclidean_pulses,
        euclideanSteps: seq.euclidean_steps,
        rotateBy: seq.euclidean_rotate,
        seed,
        productCount: rendered.length,
      });
      events = built.map((event) => {
        const buffer = rendered[event.product_index - 1];
        return {
          ...event,
          buffer: buffer.samples,
          sampleRate: buffer.sampleRate,
          channels: buffer.channels,
        };
      });
    } else if (action !== "edit_pattern") {
      if (rendered.length === 1) oneShot = rendered[0];
      else {
        const row = await resolveSource(seq, job);
        oneShot = await loadAudio(row.id);
      }
    }

    if (action === "edit_pattern") {
      const target = layers[layers.length - 1];
      if (!target) throw new Error("no layer to edit");
      target.gain = Number(seq.gain);
      target.pan = Number(seq.pan);
      target.loop = !!seq.loop;
      if (events) {
        target.events = events;
        target.oneShot = null;
        target.pattern = [];
      }
      newLayer = target;
    } else {
      const position = layers.length ? Math.max(...layers.map((layer) => layer.position)) + 1 : 0;
      newLayer = {
        id: null,
        position,
        gain: Number(seq.gain),
        pan: Number(seq.pan),
        loop: !!seq.loop,
        fx_chain: [],
        sampleId: oneShot?.sampleId || null,
        events,
        oneShot: oneShot && !events ? oneShot : null,
        pattern: [],
      };
      layers.push(newLayer);
    }
  }

  const moduleName = plan.use_sequencer ? "sequencer" : "sampler";
  const writtenProducts = [];
  for (const item of rendered) {
    const piece = String(item.index).padStart(2, "0");
    if (item.patch.op === "slice" || rendered.length > 1) {
      item.file = path.join(config.rendersDir, `job-${job.id}-slice-${piece}.wav`);
    } else if (plan.use_sequencer) {
      item.file = path.join(config.rendersDir, `job-${job.id}-${item.patch.op}.wav`);
    } else {
      item.file = path.join(config.rendersDir, `job-${job.id}.wav`);
    }
    const saved = await writeAudio(item.file, item.samples, item.sampleRate, item.channels);
    const key = estimateKey(item.samples, item.sampleRate, item.channels);
    const bpmGuess = estimateBpm(item.samples, item.sampleRate, item.channels);
    item.saved = saved;
    item.key = key;
    item.bpm = bpmGuess;
    item.tags = tagsFor(item.parentTags, {
      source: "sampler",
      op: item.patch.op,
      duration: saved.info.duration_s,
      key,
      bpm: bpmGuess,
    });
    item.name = artefactName(item.parentName, item.patch.op, item.index, job.id);
    writtenProducts.push(item);
  }

  let mix = null;
  if (plan.use_sequencer && seq.render) {
    if (!layers.length) throw new Error("composition has no layers to mix");
    const mixed = mixLayers({
      layers: layers.map((layer) => ({
        gain: layer.gain,
        pan: layer.pan,
        loop: layer.loop,
        fx_chain: layer.fx_chain,
        events: layer.events || undefined,
        oneShot: layer.oneShot
          ? {
              samples: layer.oneShot.samples,
              sampleRate: layer.oneShot.sampleRate,
              channels: layer.oneShot.channels,
            }
          : undefined,
      })),
      bpm,
    });
    const mixPath = path.join(config.rendersDir, `job-${job.id}.wav`);
    const saved = await writeAudio(mixPath, mixed.samples, mixed.sampleRate, mixed.channels);
    for (let i = 0; i < layers.length; i++) {
      layers[i].stemFile = path.join(
        config.rendersDir,
        `job-${job.id}-layer-${layers[i].position}.wav`,
      );
      await writeAudio(layers[i].stemFile, mixed.stems[i], mixed.sampleRate, 2);
    }
    const guessedKey = mixKey || estimateKey(mixed.samples, mixed.sampleRate, mixed.channels);
    mix = { mixed, saved, path: mixPath, key: guessedKey, bpm };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (plan.use_sequencer) {
      if (!compositionId) {
        const inserted = await client.query(
          `INSERT INTO vibe.compositions (title, bpm, key) VALUES ('Kitchen', $1, $2) RETURNING id`,
          [bpm, mixKey],
        );
        compositionId = Number(inserted.rows[0].id);
      } else {
        await client.query(
          `UPDATE vibe.compositions SET bpm = $2, key = COALESCE($3, key) WHERE id = $1`,
          [compositionId, bpm, mixKey],
        );
      }
    }

    const productIds = [];
    for (const item of writtenProducts) {
      const row = await client.query(
        `INSERT INTO vibe.samples
           (name, source, path, sha256, duration_s, sample_rate, channels, key, bpm, tags, prompt, patch, seed, parent_id)
         VALUES ($1, 'sampler', $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::jsonb, $12, $13)
         RETURNING id`,
        [
          item.name,
          item.file,
          item.saved.sha256,
          item.saved.info.duration_s,
          item.saved.info.sampleRate,
          item.saved.info.channels,
          item.key,
          item.bpm,
          item.tags,
          prompt,
          JSON.stringify(item.patch),
          seed,
          item.parentId,
        ],
      );
      const id = Number(row.rows[0].id);
      item.id = id;
      productIds.push(id);
    }

    for (const layer of layers) {
      for (const event of layer.events || []) {
        if (event.product_index) event.sample_id = productIds[event.product_index - 1];
      }
      if (layer.oneShot && !layer.oneShot.sampleId && productIds.length === 1) {
        layer.oneShot.sampleId = productIds[0];
      }
      if (!layer.sampleId) {
        layer.sampleId = layer.oneShot?.sampleId
          || layer.events?.find((event) => event.sample_id)?.sample_id
          || null;
      }
      layer.pattern = layer.events ? storedPattern(layer.events) : (layer.pattern || []);
      for (const event of layer.pattern) {
        if (!event.sample_id) throw new Error(`step ${event.step} has no sample`);
      }
    }

    const dirty = new Set(layers.filter((layer) => layer.stemFile || layer.id == null || layer === newLayer));
    for (const layer of dirty) {
      if (layer.id) {
        await client.query(
          `UPDATE vibe.layers
           SET sample_id = COALESCE($2, sample_id),
               pattern = $3::jsonb,
               gain = $4,
               pan = $5,
               loop = $6,
               stem_path = COALESCE($7, stem_path)
           WHERE id = $1`,
          [
            layer.id,
            layer.sampleId,
            JSON.stringify(layer.pattern || []),
            layer.gain,
            layer.pan,
            layer.loop,
            layer.stemFile || null,
          ],
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO vibe.layers
             (composition_id, position, sample_id, pattern, fx_chain, gain, pan, loop, stem_path)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
           RETURNING id`,
          [
            compositionId,
            layer.position,
            layer.sampleId,
            JSON.stringify(layer.pattern || []),
            JSON.stringify(layer.fx_chain || []),
            layer.gain,
            layer.pan,
            layer.loop,
            layer.stemFile || null,
          ],
        );
        layer.id = Number(inserted.rows[0].id);
      }
    }

    let mixId = null;
    if (mix) {
      const mixParent = productIds[0]
        || newLayer?.oneShot?.sampleId
        || newLayer?.sampleId
        || null;
      const parentTags = productIds.length
        ? writtenProducts[0].tags
        : (newLayer?.oneShot?.tags || []);
      const parentName = productIds.length
        ? writtenProducts[0].name
        : (newLayer?.oneShot?.name || "mix");
      const mixPatch = {
        op: "mix",
        composition_id: compositionId,
        bpm: mix.bpm,
        key: mix.key,
        seed,
        parent_sample_id: mixParent,
        layers: layers.map((layer) => ({
          id: layer.id,
          position: layer.position,
          sample_id: layer.sampleId,
          gain: layer.gain,
          pan: layer.pan,
          loop: layer.loop,
          pattern: layer.pattern || [],
        })),
      };
      const mixTags = tagsFor(parentTags, {
        source: "sequencer",
        op: "mix",
        duration: mix.saved.info.duration_s,
        key: mix.key,
        bpm: mix.bpm,
      });
      const mixRow = await client.query(
        `INSERT INTO vibe.samples
           (name, source, path, sha256, duration_s, sample_rate, channels, key, bpm, tags, prompt, patch, seed, parent_id, composition_id)
         VALUES ($1, 'sequencer', $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::jsonb, $12, $13, $14)
         RETURNING id`,
        [
          artefactName(parentName, "mix", 0, job.id),
          mix.path,
          mix.saved.sha256,
          mix.saved.info.duration_s,
          mix.saved.info.sampleRate,
          mix.saved.info.channels,
          mix.key,
          mix.bpm,
          mixTags,
          prompt,
          JSON.stringify(mixPatch),
          seed,
          mixParent,
          compositionId,
        ],
      );
      mixId = Number(mixRow.rows[0].id);
    }

    const sampleIds = [...productIds, ...(mixId ? [mixId] : [])];
    const resultId = mixId || productIds[productIds.length - 1];
    if (!resultId) throw new Error("plan produced no sample");
    const resultInfo = mix ? mix.saved.info : writtenProducts[writtenProducts.length - 1].saved.info;
    const peak = mix ? mix.mixed.peak : null;
    const storedPlan = {
      ...plan,
      seed,
      composition_id: compositionId,
      sample_ids: sampleIds,
    };
    const patchRow = await client.query(
      `INSERT INTO vibe.patches (module, name, params, prompt, model)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [moduleName, `job-${job.id}`, JSON.stringify(storedPlan), prompt, config.qwen.model],
    );
    await fs.writeFile(
      path.join(config.rendersDir, `job-${job.id}.json`),
      `${JSON.stringify(storedPlan, null, 2)}\n`,
    );
    await client.query(
      `UPDATE vibe.jobs
       SET status = 'done',
           module = $2,
           finished_at = now(),
           result_sample_id = $3,
           patch_id = $4,
           node = $5,
           model = $6,
           error = NULL,
           command = command || $7::jsonb
       WHERE id = $1`,
      [
        job.id,
        moduleName,
        resultId,
        patchRow.rows[0].id,
        config.qwen.base,
        config.qwen.model,
        JSON.stringify({
          seed,
          adjustments,
          composition_id: compositionId,
          sample_ids: sampleIds,
          peak,
          frames: resultInfo.frames,
        }),
      ],
    );
    await client.query("COMMIT");
    console.log(`job ${job.id} ${moduleName} sample ${resultId} ids ${sampleIds.join(",")}`);
    return {
      sampleId: resultId,
      info: resultInfo,
      meta: { peak: peak ?? 0, frames: resultInfo.frames },
      sha256: mix ? mix.saved.sha256 : writtenProducts[writtenProducts.length - 1].saved.sha256,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

