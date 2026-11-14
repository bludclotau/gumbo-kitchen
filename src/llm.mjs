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

export async function completeStructured({ messages, schema, seed, jobId, maxTokens = 500, schemaName = "fm_synth_patch" }) {
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
    return responseText;
  } catch (err) {
    if (!responseText) responseText = String(err.message || err);
    throw err;
  } finally {
    try {
      await query(
        `INSERT INTO vibe.llm_calls (model, node, prompt, response, latency_ms, job_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          config.qwen.model,
          config.qwen.base,
          JSON.stringify(messages),
          responseText.slice(0, 200000),
          Date.now() - started,
          jobId,
        ],
      );
    } catch (logErr) {
      console.error("failed to log llm call", logErr.message);
    }
  }
}
