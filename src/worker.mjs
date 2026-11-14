import { randomInt } from "node:crypto";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { config } from "./config.mjs";
import { pool, query } from "./db.mjs";
import { renderWav } from "./engine.mjs";
import { completeStructured, parseModelJson } from "./llm.mjs";
import { runKitchen } from "./kitchen.mjs";
import { coerceToSchema, finalizePatch, sampleName, semanticErrors, SYSTEM_PROMPT, tagsForPrompt } from "./patch.mjs";
import { inspectWav } from "./wav.mjs";

const ajv = new Ajv({ allErrors: true, strict: true });

export async function requeueAbandoned() {
  const result = await query(
    `UPDATE vibe.jobs
     SET status = 'pending', started_at = NULL
     WHERE status = 'running'`,
  );
  return result.rowCount ?? 0;
}

async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE vibe.jobs
       SET status = 'running', started_at = now(), error = NULL
       WHERE id = (
         SELECT id FROM vibe.jobs
         WHERE status = 'pending'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
    );
    await client.query("COMMIT");
    return rows[0] || null;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function failJob(id, message) {
  await query(
    `UPDATE vibe.jobs
     SET status = 'failed', error = $2, finished_at = now()
     WHERE id = $1 AND status = 'running'`,
    [id, String(message).slice(0, 2000)],
  );
}

async function loadModule(name) {
  const { rows } = await query(
    `SELECT name, kind, param_schema FROM vibe.modules WHERE name = $1`,
    [name],
  );
  return rows[0] || null;
}

async function askForPatch(job, schema, seed, prompt) {
  const validate = ajv.compile(structuredClone(schema));
  const base = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  let raw = "";
  let lastError = "no attempt";
  const adjustments = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = attempt === 1
      ? base
      : [
          ...base,
          { role: "assistant", content: raw || "{}" },
          { role: "user", content: `That object failed a check: ${lastError}. Return a corrected object.` },
        ];
    try {
      raw = await completeStructured({ messages, schema, seed, jobId: job.id });
    } catch (err) {
      lastError = err.message;
      if (attempt === 2 || /HTTP 400/.test(lastError)) throw err;
      continue;
    }
    try {
      const parsed = parseModelJson(raw);
      adjustments.length = 0;
      const modelObj = coerceToSchema(parsed, schema, "patch", adjustments);
      if (!validate(modelObj)) throw new Error(ajv.errorsText(validate.errors));
      const semantic = semanticErrors(prompt, modelObj);
      if (semantic.length) throw new Error(semantic.join("; "));
      return { modelObj, adjustments: [...adjustments] };
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(lastError);
}

async function catalogue(job, prompt, patch, adjustments, seed) {
  await fs.mkdir(config.rendersDir, { recursive: true });
  const stem = path.join(config.rendersDir, `job-${job.id}`);
  const patchPath = `${stem}.json`;
  const wavPath = `${stem}.wav`;
  await fs.writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`);
  const meta = await renderWav(patchPath, wavPath);
  const buf = await fs.readFile(wavPath);
  const info = inspectWav(buf);
  if (Math.abs(info.duration_s - Number(patch.duration_s)) > 0.001) {
    throw new Error(`rendered ${info.duration_s}s, patch asked for ${patch.duration_s}s`);
  }
  if (info.channels !== 1 || info.sampleRate !== 48000) {
    throw new Error(`unexpected wav format ${info.sampleRate} Hz ${info.channels} ch`);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const name = sampleName(prompt, job.id);
  const tags = tagsForPrompt(prompt);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const patchRow = await client.query(
      `INSERT INTO vibe.patches (module, name, params, prompt, model)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [job.module, name, JSON.stringify(patch), prompt, config.qwen.model],
    );
    const sampleRow = await client.query(
      `INSERT INTO vibe.samples
         (name, source, path, sha256, duration_s, sample_rate, channels, tags, prompt, patch, seed)
       VALUES ($1, 'synth', $2, $3, $4, $5, $6, $7::text[], $8, $9::jsonb, $10)
       RETURNING id`,
      [
        name,
        wavPath,
        sha256,
        info.duration_s,
        info.sampleRate,
        info.channels,
        tags,
        prompt,
        JSON.stringify(patch),
        seed,
      ],
    );
    await client.query(
      `UPDATE vibe.jobs
       SET status = 'done',
           finished_at = now(),
           result_sample_id = $2,
           patch_id = $3,
           node = $4,
           model = $5,
           error = NULL,
           command = command || $6::jsonb
       WHERE id = $1`,
      [
        job.id,
        sampleRow.rows[0].id,
        patchRow.rows[0].id,
        config.qwen.base,
        config.qwen.model,
        JSON.stringify({ seed, adjustments, frames: meta.frames, peak: meta.peak }),
      ],
    );
    await client.query("COMMIT");
    return { sampleId: sampleRow.rows[0].id, info, sha256, meta };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runJob(job) {
  const prompt = String(job.command?.prompt || "").trim();
  if (!prompt) throw new Error("job has no prompt");
  if (job.module === "sampler" || job.module === "sequencer") return runKitchen(job);
  if (job.module !== "fm-synth") throw new Error(`no renderer for module ${job.module}`);
  const moduleRow = await loadModule(job.module);
  if (!moduleRow) throw new Error(`module ${job.module} is not registered`);
  const seed = randomInt(1, 2147483647);
  const asked = await askForPatch(job, moduleRow.param_schema, seed, prompt);
  const { patch, adjustments } = finalizePatch(asked.modelObj, { seed, prompt });
  return catalogue(job, prompt, patch, [...asked.adjustments, ...adjustments], seed);
}

export async function processNext() {
  const job = await claimJob();
  if (!job) return null;
  try {
    const result = await runJob(job);
    console.log(`job ${job.id} done sample ${result.sampleId} ${result.info.duration_s}s peak ${result.meta.peak}`);
  } catch (err) {
    console.error(`job ${job.id} failed: ${err.message}`);
    await failJob(job.id, err.message);
  }
  return job.id;
}

let ticking = false;

export function startWorker() {
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    processNext()
      .catch((err) => console.error("worker", err))
      .finally(() => {
        ticking = false;
      });
  }, 1000);
  return timer;
}
