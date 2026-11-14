import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { config } from "./config.mjs";
import { coerceToSchema, finalizePatch, parseDuration, semanticErrors, tagsForPrompt } from "./patch.mjs";
import { inspectWav } from "./wav.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const prompt = "make a bold brassy trumpet chord for 0.50 seconds";
assert(parseDuration(prompt) === 0.5, "duration parse");
assert(semanticErrors(prompt, { notes: [{}, {}], modulator: { index: 1, index_env_amount: 0.2 } }).length >= 2, "semantic rejects a thin one-note brass patch");
assert(semanticErrors(prompt, {
  notes: [{}, {}, {}],
  modulator: { index: 4, index_env_amount: 1 },
}).length === 0, "semantic accepts a brass chord");
const finalized = finalizePatch({
  duration_s: 2,
  gain: 0.3,
  notes: [],
  modulator: { release: 1.2 },
  carrier: { release: 0.1 },
}, { seed: 9, prompt });
assert(finalized.patch.duration_s === 0.5, "prompt duration wins");
assert(finalized.patch.seed === 9 && finalized.patch.sample_rate === 48000, "seed and rate injected");
assert(finalized.patch.modulator.release <= 0.5 * 0.45 + 0.001, "release fits the buffer");
assert(tagsForPrompt(prompt).includes("trumpet") && tagsForPrompt(prompt).includes("brass"), "tags");
const velocityNotes = [];
const coerced = coerceToSchema(
  { notes: [{ velocity: 127 }, { velocity: 64 }] },
  { type: "object", properties: { notes: { type: "array", items: { type: "object", properties: { velocity: { type: "number", minimum: 0.15, maximum: 1 } } } } } },
  "patch",
  velocityNotes,
);
assert(coerced.notes[0].velocity === 1 && Math.abs(coerced.notes[1].velocity - 0.504) < 0.001, "MIDI velocity maps into 0..1");
assert(velocityNotes.length === 2, "velocity mapping is recorded");

const self = spawnSync(config.fmBin, ["self-test"], { encoding: "utf8" });
if (self.status !== 0) {
  console.error(self.stdout);
  console.error(self.stderr);
  process.exit(self.status || 1);
}

const schemaPath = fileURLToPath(new URL("../schema/fm-synth.json", import.meta.url));
const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-fm-"));
const patchPath = path.join(dir, "patch.json");
const wavPath = path.join(dir, "out.wav");
const patch = {
  duration_s: 0.5,
  gain: 0.35,
  seed: 11,
  sample_rate: 48000,
  notes: [
    { midi: 60, velocity: 0.95 },
    { midi: 64, velocity: 0.9 },
    { midi: 67, velocity: 0.85 },
  ],
  modulator: {
    ratio: 1, detune_cents: 0, index: 4.2, index_env_amount: 1,
    attack: 0.01, decay: 0.08, sustain: 0.5, release: 0.12, level: 1,
  },
  carrier: {
    ratio: 1, detune_cents: 4, attack: 0.015, decay: 0.1, sustain: 0.6, release: 0.15, level: 0.9,
  },
  lfo: { rate_hz: 0, depth: 0, target: "off" },
};
const modelPatch = { ...patch };
delete modelPatch.seed;
delete modelPatch.sample_rate;
if (!validate(modelPatch)) {
  throw new Error(`fixture rejected by schema: ${JSON.stringify(validate.errors)}`);
}
await fs.writeFile(patchPath, JSON.stringify(patch));
const rendered = spawnSync(config.fmBin, ["render", "-o", wavPath, patchPath], { encoding: "utf8" });
if (rendered.status !== 0) {
  console.error(rendered.stdout);
  console.error(rendered.stderr);
  process.exit(rendered.status || 1);
}
const meta = JSON.parse(rendered.stdout.trim().split("\n").pop());
const info = inspectWav(await fs.readFile(wavPath));
assert(meta.status === "ok" && meta.frames === 24000, "engine reports 24000 frames");
assert(Math.abs(info.duration_s - 0.5) < 0.0001, "wav is 0.50s");
assert(info.channels === 1 && info.sampleRate === 48000 && info.bits === 16, "mono 48 kHz 16-bit");
await fs.rm(dir, { recursive: true, force: true });
console.log("self-check ok");
