import { config } from "./config.mjs";
import { query } from "./db.mjs";

export function parseModelJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("model output is not a JSON object");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

export async function markCallError(id, error) {
  if (!id) return;
  await query(
    `UPDATE vibe.llm_calls SET error = $2 WHERE id = $1`,
    [id, String(error).slice(0, 2000)],
  );
}

async function insertCall({ model, node, messages, responseText, latencyMs, jobId, attempt, error }) {
  const { rows } = await query(
    `INSERT INTO vibe.llm_calls (model, node, prompt, response, latency_ms, job_id, attempt, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      model,
      node,
      JSON.stringify(messages),
      String(responseText || "").slice(0, 200000),
      latencyMs,
      jobId,
      attempt,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
  return Number(rows[0].id);
}

export async function completeStructured({
  messages,
  schema,
  seed,
  jobId,
  attempt = 1,
  maxTokens = 500,
  schemaName = "fm_synth_patch",
}) {
  if (!config.qwen.base || !config.qwen.model) {
    throw new Error("Set VIBE_QWEN_URL and VIBE_QWEN_MODEL");
  }
  const body = {
    model: config.qwen.model,
    temperature: 0.2,
    seed,
    max_tokens: maxTokens,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };
  const started = Date.now();
  let responseText = "";
  let thrown = null;
  try {
    const res = await fetch(`${config.qwen.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.qwen.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      responseText = raw.slice(0, 8000);
      throw new Error(`qwen HTTP ${res.status}: ${raw.slice(0, 400)}`);
    }
    const parsed = JSON.parse(raw);
    responseText = String(parsed?.choices?.[0]?.message?.content ?? "");
    if (!responseText) throw new Error("qwen returned an empty message");
  } catch (err) {
    if (!responseText) responseText = String(err.message || err);
    thrown = err;
  }
  let callId = null;
  try {
    callId = await insertCall({
      model: config.qwen.model,
      node: config.qwen.base,
      messages,
      responseText,
      latencyMs: Date.now() - started,
      jobId,
      attempt,
      error: thrown ? String(thrown.message || thrown) : null,
    });
  } catch (logErr) {
    console.error("failed to log llm call", logErr.message);
  }
  if (thrown) {
    thrown.callId = callId;
    throw thrown;
  }
  return { id: callId, text: responseText };
}
