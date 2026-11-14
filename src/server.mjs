import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { config, rootDir } from "./config.mjs";
import { pool, query } from "./db.mjs";
import { requeueAbandoned, startWorker } from "./worker.mjs";

const publicDir = path.join(rootDir, "public");
const SOURCES = new Set(["synth", "bark", "wavbvkery", "sampler", "import", "sequencer"]);
const MODULES = new Set(["fm-synth", "sampler", "sequencer"]);

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jobView(row) {
  const sampleId = row.result_sample_id == null ? null : Number(row.result_sample_id);
  return {
    id: Number(row.id),
    module: row.module,
    prompt: row.command?.prompt || "",
    status: row.status,
    node: row.node,
    model: row.model,
    error: row.error,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    sample: sampleId
      ? {
          id: sampleId,
          name: row.sample_name,
          duration_s: row.duration_s == null ? null : Number(row.duration_s),
          tags: row.tags || [],
          url: `/media/${sampleId}`,
        }
      : null,
  };
}

async function listJobs() {
  const { rows } = await query(
    `SELECT j.id, j.module, j.command, j.status, j.node, j.model, j.error,
            j.created_at, j.started_at, j.finished_at, j.result_sample_id,
            s.name AS sample_name, s.duration_s, s.tags
     FROM vibe.jobs j
     LEFT JOIN vibe.samples s ON s.id = j.result_sample_id
     ORDER BY j.id DESC
     LIMIT 50`,
  );
  return rows.map(jobView);
}

function sampleView(row) {
  return {
    id: Number(row.id),
    name: row.name,
    source: row.source,
    duration_s: Number(row.duration_s),
    sample_rate: row.sample_rate,
    channels: row.channels,
    key: row.key,
    bpm: row.bpm == null ? null : Number(row.bpm),
    tags: row.tags || [],
    prompt: row.prompt,
    seed: row.seed == null ? null : Number(row.seed),
    parent_id: row.parent_id == null ? null : Number(row.parent_id),
    composition_id: row.composition_id == null ? null : Number(row.composition_id),
    created_at: row.created_at,
    url: `/media/${row.id}`,
  };
}

async function listSamples(search) {
  const params = [];
  const where = [];
  if (search.source) {
    params.push(search.source);
    where.push(`source = $${params.length}`);
  }
  if (search.q) {
    params.push(`%${search.q}%`);
    const n = params.length;
    where.push(
      `(name ILIKE $${n} OR coalesce(prompt, '') ILIKE $${n} OR EXISTS (
         SELECT 1 FROM unnest(tags) AS tag WHERE tag ILIKE $${n}
       ))`,
    );
  }
  params.push(300);
  const sql = `SELECT id, name, source, duration_s, sample_rate, channels, key, bpm,
                      tags, prompt, seed, parent_id, composition_id, created_at
               FROM vibe.samples
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, id DESC
               LIMIT $${params.length}`;
  const { rows } = await query(sql, params);
  return rows.map(sampleView);
}

async function compositionView(id) {
  const params = [];
  const where = id ? "WHERE id = $1" : "";
  if (id) params.push(id);
  const { rows } = await query(
    `SELECT id, title, bpm, key, created_at
     FROM vibe.compositions ${where}
     ORDER BY id DESC
     LIMIT 1`,
    params,
  );
  if (!rows[0]) return null;
  const comp = rows[0];
  const layers = await query(
    `SELECT l.id, l.position, l.sample_id, l.pattern, l.gain, l.pan, l.loop, l.stem_path,
            s.name AS sample_name
     FROM vibe.layers l
     LEFT JOIN vibe.samples s ON s.id = l.sample_id
     WHERE l.composition_id = $1
     ORDER BY l.position`,
    [comp.id],
  );
  const mixes = await query(
    `SELECT id, name, parent_id, duration_s
     FROM vibe.samples
     WHERE composition_id = $1 AND source = 'sequencer'
     ORDER BY id DESC`,
    [comp.id],
  );
  const latest = mixes.rows[0] || null;
  let chain = [];
  if (latest) {
    const walked = await query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id, 0 AS depth FROM vibe.samples WHERE id = $1
         UNION ALL
         SELECT s.id, s.parent_id, c.depth + 1
         FROM vibe.samples s
         JOIN chain c ON s.id = c.parent_id
         WHERE c.depth < 16
       )
       SELECT id FROM chain ORDER BY depth`,
      [latest.id],
    );
    chain = walked.rows.map((row) => Number(row.id));
  }
  return {
    id: Number(comp.id),
    title: comp.title,
    bpm: Number(comp.bpm),
    key: comp.key,
    created_at: comp.created_at,
    layers: layers.rows.map((row) => ({
      id: Number(row.id),
      position: Number(row.position),
      sample_id: row.sample_id == null ? null : Number(row.sample_id),
      sample_name: row.sample_name,
      gain: Number(row.gain),
      pan: Number(row.pan),
      loop: row.loop,
      steps: Array.isArray(row.pattern) ? row.pattern.length : 0,
      audio: row.stem_path ? `/api/layers/${row.id}/audio` : null,
    })),
    mixdown: latest
      ? {
          id: Number(latest.id),
          name: latest.name,
          parent_id: latest.parent_id == null ? null : Number(latest.parent_id),
          duration_s: Number(latest.duration_s),
          url: `/media/${latest.id}`,
        }
      : null,
    mixdowns: mixes.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      parent_id: row.parent_id == null ? null : Number(row.parent_id),
      duration_s: Number(row.duration_s),
      url: `/media/${row.id}`,
    })),
    chain,
  };
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(res, rel) {
  const file = path.join(publicDir, rel);
  const resolved = path.resolve(file);
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  fs.readFile(resolved, (err, buf) => {
    if (err) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(resolved),
      "Content-Length": buf.length,
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

async function allowedSamplePath(filePath) {
  const real = await fsp.realpath(filePath);
  const roots = [];
  for (const root of [config.rendersDir, config.wavbvkeryRoot]) {
    try {
      roots.push(await fsp.realpath(root));
    } catch {
      /* root not created yet */
    }
  }
  return roots.some((root) => real === root || real.startsWith(root + path.sep));
}

function serveAudio(req, res, filePath, size) {
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "Content-Length": size });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  end = Math.min(end, size - 1);
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": end - start + 1,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveStatic(res, "index.html");
      return;
    }
    if (req.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/styles.css")) {
      serveStatic(res, url.pathname.slice(1));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      const mods = await query(`SELECT name FROM vibe.modules ORDER BY name`);
      sendJson(res, 200, {
        ok: true,
        name: "gumbo-kitchen",
        schema: "vibe",
        module: "fm-synth",
        modules: mods.rows.map((row) => row.name),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/composition") {
      const id = url.searchParams.get("id");
      sendJson(res, 200, { composition: await compositionView(id ? Number(id) : null) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/compositions") {
      const raw = await readBody(req);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "body is not JSON" });
          return;
        }
      }
      const title = String(body.title || "Kitchen").trim().slice(0, 80) || "Kitchen";
      const { rows } = await query(
        `INSERT INTO vibe.compositions (title) VALUES ($1) RETURNING id, title, bpm, key, created_at`,
        [title],
      );
      sendJson(res, 201, { composition: await compositionView(Number(rows[0].id)) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      sendJson(res, 200, { jobs: await listJobs() });
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
    if (req.method === "GET" && jobMatch) {
      const { rows } = await query(
        `SELECT j.id, j.module, j.command, j.status, j.node, j.model, j.error,
                j.created_at, j.started_at, j.finished_at, j.result_sample_id,
                s.name AS sample_name, s.duration_s, s.tags
         FROM vibe.jobs j
         LEFT JOIN vibe.samples s ON s.id = j.result_sample_id
         WHERE j.id = $1`,
        [jobMatch[1]],
      );
      if (!rows[0]) {
        sendJson(res, 404, { error: "job not found" });
        return;
      }
      const calls = await query(
        `SELECT id, model, node, latency_ms, attempt, error, created_at
         FROM vibe.llm_calls WHERE job_id = $1 ORDER BY id`,
        [jobMatch[1]],
      );
      sendJson(res, 200, {
        job: jobView(rows[0]),
        calls: calls.rows.map((row) => ({
          id: Number(row.id),
          model: row.model,
          node: row.node,
          latency_ms: row.latency_ms,
          attempt: row.attempt == null ? null : Number(row.attempt),
          error: row.error,
          created_at: row.created_at,
        })),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { error: "body is not JSON" });
        return;
      }
      const prompt = String(body.prompt || "").trim();
      const moduleName = body.module ? String(body.module) : (body.composition_id ? "sampler" : "fm-synth");
      if (!prompt || prompt.length > 2000) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }
      if (!MODULES.has(moduleName)) {
        sendJson(res, 400, { error: "unknown module" });
        return;
      }
      let compositionId = null;
      if (body.composition_id != null && body.composition_id !== "") {
        compositionId = Number(body.composition_id);
        if (!Number.isInteger(compositionId) || compositionId <= 0) {
          sendJson(res, 400, { error: "bad composition id" });
          return;
        }
        const found = await query(`SELECT id FROM vibe.compositions WHERE id = $1`, [compositionId]);
        if (!found.rows[0]) {
          sendJson(res, 400, { error: "composition not found" });
          return;
        }
      }
      const command = { prompt, module: moduleName };
      if (compositionId) command.composition_id = compositionId;
      const sourceSample = Number(body.source_sample_id);
      const sourceJob = Number(body.source_job_id);
      if (Number.isInteger(sourceSample) && sourceSample > 0) command.source_sample_id = sourceSample;
      if (Number.isInteger(sourceJob) && sourceJob > 0) command.source_job_id = sourceJob;
      const { rows } = await query(
        `INSERT INTO vibe.jobs (module, command)
         VALUES ($1, $2::jsonb)
         RETURNING id, status, created_at`,
        [moduleName, JSON.stringify(command)],
      );
      sendJson(res, 201, {
        id: Number(rows[0].id),
        status: rows[0].status,
        created_at: rows[0].created_at,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/samples") {
      const source = url.searchParams.get("source") || "";
      const q = (url.searchParams.get("q") || "").replace(/[%_\\]/g, "").trim().slice(0, 80);
      if (source && !SOURCES.has(source)) {
        sendJson(res, 400, { error: "unknown source" });
        return;
      }
      sendJson(res, 200, { samples: await listSamples({ source, q }) });
      return;
    }
    const layerAudio = url.pathname.match(/^\/api\/layers\/(\d+)\/audio$/);
    if (req.method === "GET" && layerAudio) {
      const { rows } = await query(`SELECT stem_path FROM vibe.layers WHERE id = $1`, [layerAudio[1]]);
      if (!rows[0]?.stem_path) {
        sendJson(res, 404, { error: "layer has no stem yet" });
        return;
      }
      const real = await fsp.realpath(rows[0].stem_path);
      const root = await fsp.realpath(config.rendersDir);
      if (real !== root && !real.startsWith(root + path.sep)) {
        sendJson(res, 403, { error: "stem path is outside renders" });
        return;
      }
      const stat = await fsp.stat(real);
      serveAudio(req, res, real, stat.size);
      return;
    }
    const mediaMatch = url.pathname.match(/^\/media\/(\d+)$/);
    if (req.method === "GET" && mediaMatch) {
      const { rows } = await query(`SELECT path FROM vibe.samples WHERE id = $1`, [mediaMatch[1]]);
      if (!rows[0]) {
        sendJson(res, 404, { error: "sample not found" });
        return;
      }
      if (!(await allowedSamplePath(rows[0].path))) {
        sendJson(res, 403, { error: "sample path is outside the allowed roots" });
        return;
      }
      const stat = await fsp.stat(rows[0].path);
      serveAudio(req, res, rows[0].path, stat.size);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "server error" });
  }
});

if (!config.db.password) {
  console.error("Set VIBE_DB_PASSWORD or source the wordfactory env so WF_DB_PASSWORD is set.");
  process.exit(1);
}

await fs.promises.mkdir(config.rendersDir, { recursive: true });
const requeued = await requeueAbandoned();
if (requeued) console.log(`requeued ${requeued} running job(s)`);
startWorker();
server.listen(config.port, config.host, () => {
  console.log(`Gumbo's Kitchen listening on http://${config.host}:${config.port}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
