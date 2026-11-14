import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import {
  applyFxChain,
  decodeWav,
  encodeWav,
  estimateBpm,
  estimateKey,
  mixLayers,
  renderSampler,
} from "../engine/dsp.mjs";
import { EXAMPLES, bjorklund, buildPattern, gridHits, normalizePlan, planErrors, planSchema } from "./plan.mjs";
import { rootDir } from "./config.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function rms(samples, channels, start, end, channel) {
  let energy = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const s = samples[i * channels + channel];
    energy += s * s;
    n += 1;
  }
  return Math.sqrt(energy / Math.max(1, n));
}

const tone = new Float32Array(1000);
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * i) / 50) * 0.5;
const decoded = { samples: tone, sampleRate: 1000, channels: 1 };

const captured = renderSampler(decoded, { op: "capture" }, 1)[0];
assert(captured.samples.length === tone.length, "capture length");
assert(captured.samples[1] === tone[1], "capture copies");

const reversed = renderSampler(decoded, { op: "reverse" }, 1)[0].samples;
assert(reversed[0] === tone[tone.length - 1] && reversed[tone.length - 1] === tone[0], "reverse");

const trimmed = renderSampler(decoded, { op: "trim", start_s: 0.1, end_s: 0.3 }, 1)[0];
assert(trimmed.samples.length === 200, `trim length ${trimmed.samples.length}`);

const normal = renderSampler(decoded, { op: "normalise" }, 1)[0].samples;
let peak = 0;
for (const value of normal) peak = Math.max(peak, Math.abs(value));
assert(Math.abs(peak - 0.89) < 0.002, `normalise peak ${peak}`);

const pitched = renderSampler(decoded, { op: "pitch", semitones: 12, preserve_duration: false }, 1)[0];
assert(pitched.samples.length === 500, `pitch length ${pitched.samples.length}`);
const held = renderSampler(decoded, { op: "pitch", semitones: 12, preserve_duration: true }, 1)[0];
assert(held.samples.length === tone.length, `pitch hold length ${held.samples.length}`);

const stretched = renderSampler(decoded, { op: "stretch", stretch: 2 }, 1)[0];
assert(stretched.samples.length === 2000, `stretch length ${stretched.samples.length}`);
const stretchedAgain = renderSampler(decoded, { op: "stretch", stretch: 2 }, 1)[0];
assert(stretched.samples.every((value, i) => value === stretchedAgain.samples[i]), "stretch is deterministic");

const slices = renderSampler(decoded, { op: "slice", slice_mode: "count", count: 8 }, 1);
assert(slices.length === 8 && slices.every((slice) => slice.samples.length === 125), "slice by count");

const clicks = new Float32Array(2000);
clicks[0] = 1;
clicks[1000] = 1;
const transients = renderSampler(
  { samples: clicks, sampleRate: 1000, channels: 1 },
  { op: "slice", slice_mode: "transient" },
  1,
);
assert(transients.length >= 2, `transients ${transients.length}`);

const beat = renderSampler(
  { samples: new Float32Array(2000), sampleRate: 1000, channels: 1 },
  { op: "slice", slice_mode: "beats", grid_bpm: 120, beats_per_slice: 1 },
  1,
);
assert(beat.length === 4 && beat[0].samples.length === 500, `beat slices ${beat.length}`);

const looped = renderSampler(
  decoded,
  { op: "loop", loop_start_s: 0, loop_end_s: 0, crossfade_s: 0.05 },
  1,
)[0];
assert(looped.samples.length < tone.length && looped.samples.length > 0, "loop crossfade shortens");

const grainA = renderSampler(
  decoded,
  { op: "grain", duration_s: 0.4, grain_size_s: 0.08, density: 8, position_jitter: 0.2, pitch_jitter: 4, window: "hann" },
  99,
)[0];
const grainB = renderSampler(
  decoded,
  { op: "grain", duration_s: 0.4, grain_size_s: 0.08, density: 8, position_jitter: 0.2, pitch_jitter: 4, window: "hann" },
  99,
)[0];
assert(grainA.samples.length === 400, `grain length ${grainA.samples.length}`);
assert(grainA.samples.every((value, i) => value === grainB.samples[i]), "grain is deterministic");
let grainPeak = 0;
for (const value of grainA.samples) grainPeak = Math.max(grainPeak, Math.abs(value));
assert(grainPeak > 0.5 && grainPeak <= 0.71, `grain peak ${grainPeak}`);

const rate = 8000;
const sine = new Float32Array(rate);
for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / rate);
assert(estimateKey(sine, rate, 1) === "A", `key ${estimateKey(sine, rate, 1)}`);

const clock = new Float32Array(48000 * 4);
for (let beatIndex = 0; beatIndex < 8; beatIndex++) clock[beatIndex * 24000] = 1;
const bpm = estimateBpm(clock, 48000, 1);
assert(bpm != null && Math.abs(bpm - 120) <= 2, `bpm ${bpm}`);
assert(estimateBpm(tone, 1000, 1) == null, "short audio has no bpm");

const round = encodeWav(tone, 1000, 1);
const back = decodeWav(round);
assert(back.frames === 1000 && back.sampleRate === 1000, "wav round trip header");
assert(Math.abs(back.samples[10] - tone[10]) < 1 / 32767, "wav round trip sample");

const alt = new Float32Array(400);
for (let i = 0; i < alt.length; i++) alt[i] = i % 2 ? -1 : 1;
const low = applyFxChain(alt, 1, 48000, [{ type: "lowpass", cutoff_hz: 400 }]);
let altEnergy = 0;
let lowEnergy = 0;
for (let i = 0; i < alt.length; i++) {
  altEnergy += alt[i] * alt[i];
  lowEnergy += low[i] * low[i];
}
assert(lowEnergy < altEnergy * 0.5, "lowpass removes the buzz");

const impulse = new Float32Array(50);
impulse[0] = 1;
const delayed = mixLayers({
  bpm: 120,
  sampleRate: 1000,
  lengthS: 0.05,
  layers: [{
    gain: 1,
    pan: -1,
    loop: false,
    fx_chain: [{ type: "delay", delay_s: 0.01, feedback: 0, mix: 1 }],
    oneShot: { samples: impulse, sampleRate: 1000, channels: 1 },
  }],
});
assert(Math.abs(delayed.samples[0]) < 0.001, "delay is wet");
assert(delayed.samples[10 * 2] > 0.9, `delayed left ${delayed.samples[20]}`);
assert(Math.abs(delayed.samples[10 * 2 + 1]) < 0.001, "hard left has no right");

assert(bjorklund(3, 8).reduce((sum, n) => sum + n, 0) === 3, "euclidean pulses");
assert(gridHits({ placement: "offbeats", stepsPerBar: 8, bars: 1 }).hits.join(",") === "2,4,6,8", "offbeats");

const pattern = buildPattern({
  placement: "offbeats",
  stepsPerBar: 8,
  bars: 1,
  sliceIndices: [1, 3, 5, 7],
  velocity: 0.85,
  pitchOffset: 0,
  probability: 1,
  pulses: 0,
  euclideanSteps: 8,
  rotateBy: 0,
  seed: 1,
  productCount: 8,
});
assert(pattern.map((event) => event.product_index).join(",") === "1,3,5,7", "slice map");
assert(pattern.every((event) => event.played && event.steps_per_bar === 8), "pattern flags");

const ajv = new Ajv({ allErrors: true, strict: true });
const samplerSchema = JSON.parse(await fs.readFile(path.join(rootDir, "schema", "sampler.json"), "utf8"));
const sequencerSchema = JSON.parse(await fs.readFile(path.join(rootDir, "schema", "sequencer.json"), "utf8"));
const validate = ajv.compile(planSchema(samplerSchema, sequencerSchema));
for (const example of EXAMPLES) {
  const normalized = normalizePlan(example.plan, example.prompt);
  assert(validate(normalized.plan), `${example.prompt}: ${ajv.errorsText(validate.errors)}`);
  const errors = planErrors(example.prompt, normalized.plan);
  assert(!errors.length, `${example.prompt}: ${errors.join("; ")}`);
}

const trumpet = decodeWav(await fs.readFile(path.join(rootDir, "renders", "job-2.wav")));
assert(Math.abs(trumpet.frames / trumpet.sampleRate - 0.5) < 0.001, "trumpet is 0.50s");
const pieces = renderSampler(trumpet, { op: "slice", slice_mode: "count", count: 8 }, 1);
const events = pattern.map((event) => ({
  ...event,
  buffer: pieces[event.product_index - 1].samples,
  sampleRate: trumpet.sampleRate,
  channels: trumpet.channels,
}));
const mixed = mixLayers({
  bpm: 90,
  layers: [{ gain: 1, pan: 0, loop: false, fx_chain: [], events }],
});
assert(mixed.frames === 128000 && mixed.channels === 2, `mix frames ${mixed.frames}`);
const down = rms(mixed.samples, 2, 0, 3000, 0);
const off = rms(mixed.samples, 2, 16000, 19000, 0);
assert(off > 0.01 && off > down * 5, `offbeat rms ${off} downbeat ${down}`);

const pad = new Float32Array(48000 * 4);
for (let i = 0; i < pad.length; i++) pad[i] = 0.5;
const stacked = mixLayers({
  bpm: 90,
  layers: [
    { gain: 1, pan: 0, loop: false, fx_chain: [], events },
    { gain: 0.45, pan: -0.7, loop: false, fx_chain: [], oneShot: { samples: pad, sampleRate: 48000, channels: 1 } },
  ],
});
assert(stacked.frames === 192000, `stacked frames ${stacked.frames}`);
let left = 0;
let right = 0;
for (let i = 0; i < stacked.frames; i++) {
  left += stacked.samples[i * 2] ** 2;
  right += stacked.samples[i * 2 + 1] ** 2;
}
assert(left > right * 1.5, `left ${left} right ${right}`);

console.log("dsp self-check ok");
