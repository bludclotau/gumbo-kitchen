import { FM_ENGINE } from "./versions.mjs";

const HINTS = ["trumpet", "brass", "horn", "chord", "bold", "soft", "bass", "bell", "pad", "lead", "pluck"];

export function coerceToSchema(value, schema, path, adjustments) {
  if (!schema || typeof schema !== "object") return value;
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const out = { ...value };
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        out[key] = coerceToSchema(out[key], prop, `${path}.${key}`, adjustments);
      }
    }
    return out;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return value.map((item, index) => coerceToSchema(item, schema.items || {}, `${path}[${index}]`, adjustments));
  }
  if (schema.type === "number" && typeof value === "number" && Number.isFinite(value)) {
    let next = value;
    if (path.endsWith(".velocity") && next > 1 && next <= 127) {
      const mapped = Math.round((next / 127) * 1000) / 1000;
      adjustments.push(`${path} ${next} read as MIDI velocity, stored as ${mapped}`);
      next = mapped;
    }
    if (typeof schema.minimum === "number" && next < schema.minimum) {
      adjustments.push(`${path} ${next} raised to ${schema.minimum}`);
      next = schema.minimum;
    }
    if (typeof schema.maximum === "number" && next > schema.maximum) {
      adjustments.push(`${path} ${next} lowered to ${schema.maximum}`);
      next = schema.maximum;
    }
    return next;
  }
  return value;
}

export function parseDuration(prompt) {
  const match = String(prompt).match(/(\d+(?:\.\d+)?)\s*(?:seconds|second|secs|sec)\b/i);
  if (!match) return null;
  return Number(match[1]);
}

export function semanticErrors(prompt, patch) {
  const errors = [];
  const text = String(prompt).toLowerCase();
  const notes = Array.isArray(patch?.notes) ? patch.notes : [];
  if (/\bchord\b/.test(text) && notes.length !== 3) {
    errors.push("a chord needs exactly 3 notes");
  }
  const brass = /\b(trumpet|brass|horn|brassy)\b/.test(text);
  if (brass) {
    const index = Number(patch?.modulator?.index);
    const amount = Number(patch?.modulator?.index_env_amount);
    if (!(amount >= 0.85)) {
      errors.push("brass needs modulator.index_env_amount >= 0.85 so the index follows the amp envelope");
    }
    if (!(index >= 2.5)) {
      errors.push("brass needs modulator.index >= 2.5");
    }
  }
  return errors;
}

export function finalizePatch(modelPatch, { seed, prompt }) {
  const patch = structuredClone(modelPatch);
  const adjustments = [];
  const asked = parseDuration(prompt);
  if (asked != null) {
    if (asked < 0.05 || asked > 8) {
      throw new Error(`requested duration ${asked}s is outside 0.05..8`);
    }
    if (Number(patch.duration_s) !== asked) {
      adjustments.push(`duration_s set to ${asked} from the prompt`);
      patch.duration_s = asked;
    }
  }
  const cap = Number(patch.duration_s) * 0.45;
  for (const name of ["modulator", "carrier"]) {
    const op = patch[name];
    if (op && op.release > cap) {
      op.release = Math.max(0.001, Math.round(cap * 1000) / 1000);
      adjustments.push(`${name}.release shortened to ${op.release} so it finishes inside the buffer`);
    }
  }
  patch.sample_rate = 48000;
  patch.seed = seed;
  patch.engine = FM_ENGINE;
  return { patch, adjustments };
}

export function tagsForPrompt(prompt) {
  const lower = String(prompt).toLowerCase();
  const tags = ["fm", "synth"];
  for (const word of HINTS) {
    if (lower.includes(word)) tags.push(word);
  }
  return tags;
}

export function sampleName(prompt, jobId) {
  const slug = String(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `${slug || "fm"}-${jobId}`;
}

export const SYSTEM_PROMPT = `You fill an FM synthesizer patch. Output JSON only. The server enforces the schema.

Sound model: two operators on each voice. The modulator sine is the carrier's phase deviation, in radians. The carrier ADSR is the loudness envelope. index_env_amount is how much of the modulation index follows that loudness envelope. 1 means the index rises and falls with loudness, which is the brass sound. At most three notes, all struck together.

Trumpet, horn, or brass: modulator ratio 1, carrier ratio 1, index from 3 to 5, index_env_amount from 0.85 to 1, carrier attack under 0.04 seconds, carrier sustain under 0.7, both levels near 1, gain near 0.35. A chord is exactly three MIDI notes in a close voicing, with high velocity.

duration_s is the length in seconds and must match a length the user states. velocity is a fraction from 0.15 to 1, not a MIDI value from 1 to 127. Set lfo depth to 0 and target to "off" unless the user asks for vibrato. Vibrato uses target "pitch" and depth at most 0.2.`;
