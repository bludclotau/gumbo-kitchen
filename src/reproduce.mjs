import { createHash, randomInt } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeWav, encodeWav, mixLayers, renderSampler } from "../engine/dsp.mjs";
import { renderWav } from "./engine.mjs";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function renderFm(patch) {
  const dir = await mkdtemp(path.join(tmpdir(), "kitchen-fm-"));
  try {
    const patchPath = path.join(dir, "patch.json");
    const wavPath = path.join(dir, "out.wav");
    await writeFile(patchPath, `${JSON.stringify(patch)}\n`);
    await renderWav(patchPath, wavPath);
    return sha256(await readFile(wavPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function renderProductBuffer(patch, seed, readSample) {
  const sourceId = Number(patch.source_sample_id);
  if (!sourceId) throw new Error("sampler patch has no source_sample_id");
  const source = await readSample(sourceId);
  if (!source?.path) throw new Error(`source sample ${sourceId} has no file`);
  const decoded = decodeWav(await readFile(source.path));
  const buffers = renderSampler(decoded, patch, seed);
  let buffer = buffers[0];
  if (patch.op === "slice") {
    const index = Number(patch.index);
    if (!Number.isInteger(index) || index < 1 || index > buffers.length) {
      throw new Error(`slice index ${patch.index} is outside the re-rendered set`);
    }
    buffer = buffers[index - 1];
  }
  if (!buffer) throw new Error("sampler re-render produced no audio");
  return buffer;
}

async function renderProduct(patch, seed, readSample) {
  const buffer = await renderProductBuffer(patch, seed, readSample);
  return sha256(encodeWav(buffer.samples, buffer.sampleRate, buffer.channels));
}

async function audioFor(id, readSample, preferFloat) {
  const sample = await readSample(id);
  if (!sample?.path) throw new Error(`sample ${id} has no file`);
  if (preferFloat && sample.source === "sampler" && sample.patch && sample.seed != null) {
    return renderProductBuffer(sample.patch, Number(sample.seed), readSample);
  }
  const audio = decodeWav(await readFile(sample.path));
  return { samples: audio.samples, sampleRate: audio.sampleRate, channels: audio.channels };
}

async function renderMixFrom(patch, readSample, preferFloat) {
  const bpm = Number(patch.bpm);
  if (!(bpm > 0)) throw new Error("mix patch has no bpm");
  if (!Array.isArray(patch.layers) || !patch.layers.length) throw new Error("mix patch has no layers");
  const layers = [];
  for (const layer of patch.layers) {
    const pattern = Array.isArray(layer.pattern) ? layer.pattern : [];
    const events = [];
    for (const event of pattern) {
      if (!event.sample_id) throw new Error(`mix step ${event.step} has no sample_id`);
      const audio = await audioFor(Number(event.sample_id), readSample, preferFloat);
      events.push({
        step: Number(event.step),
        steps_per_bar: Number(event.steps_per_bar || 8),
        velocity: Number(event.velocity ?? 1),
        pitch_offset: Number(event.pitch_offset ?? 0),
        played: event.played !== false,
        buffer: audio.samples,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
      });
    }
    let oneShot;
    if (!events.length) {
      if (!layer.sample_id) throw new Error(`mix layer ${layer.position} has no sample`);
      const audio = await audioFor(Number(layer.sample_id), readSample, preferFloat);
      oneShot = audio;
    }
    layers.push({
      gain: Number(layer.gain ?? 1),
      pan: Number(layer.pan ?? 0),
      loop: !!layer.loop,
      fx_chain: layer.fx_chain || [],
      events: events.length ? events : undefined,
      oneShot,
    });
  }
  const mixed = mixLayers({ layers, bpm });
  return sha256(encodeWav(mixed.samples, mixed.sampleRate, mixed.channels));
}

async function renderMix(patch, readSample, storedHash) {
  const fromFiles = await renderMixFrom(patch, readSample, false);
  if (!storedHash || fromFiles === storedHash) return fromFiles;
  const fromFloats = await renderMixFrom(patch, readSample, true);
  if (fromFloats === storedHash) return fromFloats;
  throw new Error(
    `wav hash ${fromFiles} != stored ${storedHash}; float replay ${fromFloats} also differs. The mix patch does not reproduce the file`,
  );
}

export async function rerenderHash(row, readSample) {
  const patch = row.patch;
  const seed = Number(row.seed);
  if (!patch || typeof patch !== "object") throw new Error("stored patch is missing");
  if (!Number.isFinite(seed)) throw new Error("stored seed is missing");
  if (row.source === "synth") return renderFm(patch);
  if (row.source === "sampler") return renderProduct(patch, seed, readSample);
  if (row.source === "sequencer") return renderMix(patch, readSample, row.sha256);
  throw new Error(`no re-render path for source ${row.source}`);
}

export function pickCount(argv) {
  const index = argv.indexOf("--n");
  const raw = index >= 0 ? Number(argv[index + 1]) : 4;
  if (!Number.isInteger(raw) || raw < 1 || raw > 50) throw new Error("--n must be an integer from 1 to 50");
  return raw;
}

export function reportLine(result) {
  if (result.match) {
    const version = result.engine_version || "engine_version missing";
    return `ok ${result.id} ${result.module} ${version}`;
  }
  return `MISMATCH ${result.id} ${result.module}: ${result.cause}`;
}

export function shuffleIds(ids) {
  const copy = [...ids];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
