import { decodeWav, encodeWav } from "../src/wav.mjs";

export { decodeWav, encodeWav };

const MAX_SECONDS = 180;

export function makeRng(seed) {
  let x = (Number(seed) >>> 0) || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function framesOf(samples, channels) {
  const frames = samples.length / channels;
  if (!Number.isInteger(frames)) throw new Error("buffer is not a whole number of frames");
  return frames;
}

function copySamples(samples) {
  return new Float32Array(samples);
}

function sliceFrames(samples, channels, start, end) {
  const out = new Float32Array((end - start) * channels);
  out.set(samples.subarray(start * channels, end * channels));
  return out;
}

function mixdownMono(samples, channels) {
  if (channels === 1) return samples;
  const frames = framesOf(samples, channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    mono[i] = sum / channels;
  }
  return mono;
}

export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

export function scaleToPeak(samples, target) {
  const peak = peakOf(samples);
  const out = copySamples(samples);
  if (peak < 1e-8) return out;
  const gain = target / peak;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

function guardFrames(frames, sampleRate) {
  if (frames > sampleRate * MAX_SECONDS) throw new Error(`render is longer than ${MAX_SECONDS}s`);
}

export function resample(samples, channels, step) {
  const inFrames = framesOf(samples, channels);
  if (!(step > 0)) throw new Error("resample step must be above 0");
  if (Math.abs(step - 1) < 1e-9) return copySamples(samples);
  const outFrames = Math.max(1, Math.round(inFrames / step));
  guardFrames(outFrames, 48000);
  const out = new Float32Array(outFrames * channels);
  const last = inFrames - 1;
  for (let i = 0; i < outFrames; i++) {
    const pos = i * step;
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    const frac = pos - i0;
    for (let c = 0; c < channels; c++) {
      const a = samples[i0 * channels + c];
      const b = samples[i1 * channels + c];
      out[i * channels + c] = a + (b - a) * frac;
    }
  }
  return out;
}

function resampleToLength(samples, channels, outFrames) {
  const inFrames = framesOf(samples, channels);
  if (outFrames === inFrames) return copySamples(samples);
  return resample(samples, channels, inFrames / outFrames);
}

export function timeStretch(samples, channels, ratio, sampleRate) {
  const inFrames = framesOf(samples, channels);
  if (!(ratio > 0)) throw new Error("stretch ratio must be above 0");
  const outFrames = Math.max(1, Math.round(inFrames * ratio));
  guardFrames(outFrames, sampleRate);
  if (Math.abs(ratio - 1) < 1e-3) return resampleToLength(samples, channels, outFrames);
  const grain = Math.min(Math.max(16, Math.round(sampleRate * 0.04)), Math.floor(inFrames / 2));
  if (grain < 16) return resampleToLength(samples, channels, outFrames);
  const hopOut = Math.max(8, Math.floor(grain / 2));
  const hopIn = Math.max(1, Math.round(hopOut / ratio));
  const out = new Float32Array(outFrames * channels);
  const weight = new Float32Array(outFrames);
  const search = Math.round(sampleRate * 0.01);
  let inPos = 0;
  let outPos = 0;
  let guard = 0;
  while (outPos < outFrames && guard++ < outFrames) {
    let best = Math.max(0, Math.min(inPos, inFrames - grain));
    if (outPos > 0 && search > 0) {
      let bestScore = -Infinity;
      const start = Math.max(0, best - search);
      const end = Math.min(inFrames - grain, best + search);
      const overlap = Math.min(hopOut, grain);
      for (let cand = start; cand <= end; cand++) {
        let score = 0;
        for (let i = 0; i < overlap; i += 4) {
          const di = outPos + i;
          if (di >= outFrames) break;
          score += out[di * channels] * samples[(cand + i) * channels];
        }
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    for (let i = 0; i < grain && outPos + i < outFrames; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, grain - 1));
      const di = outPos + i;
      for (let c = 0; c < channels; c++) {
        out[di * channels + c] += samples[(best + i) * channels + c] * w;
      }
      weight[di] += w;
    }
    outPos += hopOut;
    const next = best + hopIn;
    inPos = next >= inFrames - grain ? inFrames - grain : next;
  }
  for (let i = 0; i < outFrames; i++) {
    const w = weight[i] || 1;
    for (let c = 0; c < channels; c++) out[i * channels + c] /= w;
  }
  return out;
}

function reverseFrames(samples, channels) {
  const frames = framesOf(samples, channels);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < frames; i++) {
    const src = frames - 1 - i;
    for (let c = 0; c < channels; c++) out[i * channels + c] = samples[src * channels + c];
  }
  return out;
}

function onsetFrames(samples, channels, sampleRate) {
  const mono = mixdownMono(samples, channels);
  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const flux = [];
  let prev = 0;
  for (let i = 0; i + win <= mono.length; i += win) {
    let energy = 0;
    for (let j = 0; j < win; j++) energy += mono[i + j] * mono[i + j];
    energy /= win;
    flux.push(Math.max(0, energy - prev));
    prev = energy;
  }
  let mean = 0;
  for (const value of flux) mean += value;
  mean = flux.length ? mean / flux.length : 0;
  const cuts = [0];
  const gap = Math.round(sampleRate * 0.05);
  for (let i = 1; i < flux.length; i++) {
    const frame = i * win;
    if (flux[i] > Math.max(0.0004, mean * 4) && flux[i] >= flux[i - 1] && frame - cuts[cuts.length - 1] >= gap) {
      cuts.push(frame);
    }
  }
  return cuts;
}

function sliceByCount(samples, channels, count) {
  const frames = framesOf(samples, channels);
  if (count > frames) throw new Error(`cannot slice ${frames} frames into ${count}`);
  const base = Math.floor(frames / count);
  const rem = frames % count;
  const out = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const n = base + (i < rem ? 1 : 0);
    out.push(sliceFrames(samples, channels, at, at + n));
    at += n;
  }
  return out;
}

function sliceByTransient(samples, channels, sampleRate) {
  const frames = framesOf(samples, channels);
  const cuts = onsetFrames(samples, channels, sampleRate).filter((frame) => frame < frames);
  const bounds = [...cuts, frames];
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] > bounds[i]) out.push(sliceFrames(samples, channels, bounds[i], bounds[i + 1]));
  }
  return out.length ? out : [copySamples(samples)];
}

function sliceByBeats(samples, channels, sampleRate, bpm, beatsPerSlice) {
  const frames = framesOf(samples, channels);
  const framesPer = Math.max(1, Math.round(sampleRate * (60 / bpm) * beatsPerSlice));
  const out = [];
  for (let at = 0; at < frames; at += framesPer) {
    out.push(sliceFrames(samples, channels, at, Math.min(frames, at + framesPer)));
  }
  return out;
}

function loopCrossfade(samples, channels, sampleRate, startS, endS, fadeS) {
  const frames = framesOf(samples, channels);
  let a = Math.round(startS * sampleRate);
  let b = endS > 0 ? Math.round(endS * sampleRate) : frames;
  a = Math.max(0, Math.min(a, frames - 2));
  b = Math.max(a + 2, Math.min(b, frames));
  const regionFrames = b - a;
  const region = sliceFrames(samples, channels, a, b);
  let fade = Math.round(fadeS * sampleRate);
  if (fade < 1) return region;
  fade = Math.min(fade, Math.floor(regionFrames / 2) - 1);
  if (fade < 1) return region;
  // The tail past the loop point is mixed onto the head, so the buffer joins to itself.
  const outFrames = regionFrames - fade;
  const out = new Float32Array(outFrames * channels);
  for (let i = 0; i < outFrames; i++) {
    for (let c = 0; c < channels; c++) out[i * channels + c] = region[i * channels + c];
  }
  for (let k = 0; k < fade; k++) {
    const env = k / fade;
    const head = Math.sin(env * Math.PI / 2);
    const tail = Math.cos(env * Math.PI / 2);
    for (let c = 0; c < channels; c++) {
      out[k * channels + c] = region[k * channels + c] * head + region[(outFrames + k) * channels + c] * tail;
    }
  }
  return out;
}

function windowGain(shape, i, n) {
  if (n <= 1) return 1;
  const t = i / (n - 1);
  if (shape === "rect") return 1;
  if (shape === "triangle") return 1 - Math.abs(2 * t - 1);
  if (shape === "hann") return 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
  throw new Error(`unknown window ${shape}`);
}

export function granulate(samples, channels, sampleRate, command, seed) {
  const duration = Number(command.duration_s);
  const density = Number(command.density);
  const grainS = Number(command.grain_size_s);
  if (!(duration > 0) || !(density > 0) || !(grainS > 0)) throw new Error("grain needs duration, density, and grain size");
  const outFrames = Math.max(1, Math.round(duration * sampleRate));
  guardFrames(outFrames, sampleRate);
  const inFrames = framesOf(samples, channels);
  const grainFrames = Math.max(8, Math.round(grainS * sampleRate));
  const interval = sampleRate / density;
  const rng = makeRng(seed);
  const out = new Float32Array(outFrames * channels);
  for (let start = 0; start < outFrames; start += interval) {
    const iStart = Math.floor(start);
    const jitter = (rng() * 2 - 1) * Number(command.position_jitter || 0) * inFrames;
    const head = (start / outFrames) * Math.max(0, inFrames - 1);
    const srcPos = head + jitter;
    const semis = (rng() * 2 - 1) * Number(command.pitch_jitter || 0);
    const step = 2 ** (semis / 12);
    for (let i = 0; i < grainFrames; i++) {
      const di = iStart + i;
      if (di >= outFrames) break;
      const pos = srcPos + i * step;
      const wrapped = ((pos % inFrames) + inFrames) % inFrames;
      const i0 = Math.floor(wrapped) % inFrames;
      const i1 = (i0 + 1) % inFrames;
      const frac = wrapped - Math.floor(wrapped);
      const w = windowGain(command.window, i, grainFrames);
      for (let c = 0; c < channels; c++) {
        const a = samples[i0 * channels + c];
        const b = samples[i1 * channels + c];
        out[di * channels + c] += (a + (b - a) * frac) * w;
      }
    }
  }
  const fade = Math.min(outFrames >> 1, Math.round(sampleRate * 0.005));
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] *= w;
      out[(outFrames - 1 - i) * channels + c] *= w;
    }
  }
  if (peakOf(out) < 1e-6) return out;
  return scaleToPeak(out, 0.7);
}

function num(command, key) {
  const n = Number(command[key]);
  if (!Number.isFinite(n)) throw new Error(`sampler command missing ${key}`);
  return n;
}

export function renderSampler(decoded, command, seed) {
  const { samples, sampleRate, channels } = decoded;
  const frames = framesOf(samples, channels);
  if (frames < 1) throw new Error("source sample is empty");
  const op = command.op;
  const pack = (buffers) => buffers.map((buffer) => ({ samples: buffer, sampleRate, channels }));
  if (op === "capture") return pack([copySamples(samples)]);
  if (op === "trim") {
    let a = Math.round(num(command, "start_s") * sampleRate);
    let b = num(command, "end_s") > 0 ? Math.round(num(command, "end_s") * sampleRate) : frames;
    a = Math.max(0, Math.min(a, frames));
    b = Math.max(0, Math.min(b, frames));
    if (b - a < 1) throw new Error("trim range is empty");
    return pack([sliceFrames(samples, channels, a, b)]);
  }
  if (op === "normalise" || op === "normalize") return pack([scaleToPeak(samples, 0.89)]);
  if (op === "reverse") return pack([reverseFrames(samples, channels)]);
  if (op === "pitch") {
    const step = 2 ** (num(command, "semitones") / 12);
    let out = resample(samples, channels, step);
    if (command.preserve_duration) out = timeStretch(out, channels, frames / framesOf(out, channels), sampleRate);
    if (command.preserve_duration) out = resampleToLength(out, channels, frames);
    return pack([out]);
  }
  if (op === "stretch") return pack([timeStretch(samples, channels, num(command, "stretch"), sampleRate)]);
  if (op === "slice") {
    const mode = command.slice_mode;
    if (mode === "count") return pack(sliceByCount(samples, channels, Math.round(num(command, "count"))));
    if (mode === "transient") return pack(sliceByTransient(samples, channels, sampleRate));
    if (mode === "beats") {
      return pack(sliceByBeats(samples, channels, sampleRate, num(command, "grid_bpm"), num(command, "beats_per_slice")));
    }
    throw new Error(`unknown slice_mode ${mode}`);
  }
  if (op === "loop") {
    return pack([
      loopCrossfade(
        samples,
        channels,
        sampleRate,
        num(command, "loop_start_s"),
        num(command, "loop_end_s"),
        num(command, "crossfade_s"),
      ),
    ]);
  }
  if (op === "grain") return pack([granulate(samples, channels, sampleRate, command, seed)]);
  throw new Error(`unknown sampler op ${op}`);
}

const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function estimateKey(samples, sampleRate, channels) {
  const mono = mixdownMono(samples, channels);
  if (mono.length < sampleRate * 0.2) return null;
  const max = Math.min(mono.length, sampleRate);
  const scored = [];
  for (let midi = 36; midi <= 84; midi++) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const lag = Math.round(sampleRate / freq);
    if (lag < 8 || lag >= max / 2) continue;
    let corr = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i < max - lag; i += 2) {
      const a = mono[i];
      const b = mono[i + lag];
      corr += a * b;
      e0 += a * a;
      e1 += b * b;
    }
    scored.push({ midi, lag, norm: corr / Math.sqrt(e0 * e1 + 1e-12) });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map((row) => row.norm));
  if (best < 0.55) return null;
  // A sine also matches its subharmonics. Keep the shortest lag that is almost as good.
  const near = scored.filter((row) => row.norm >= best - 0.02).sort((a, b) => a.lag - b.lag);
  return PITCH_NAMES[((near[0].midi % 12) + 12) % 12];
}

export function estimateBpm(samples, sampleRate, channels) {
  const mono = mixdownMono(samples, channels);
  if (mono.length < sampleRate * 2.5) return null;
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const env = [];
  let prev = 0;
  for (let i = 0; i + hop <= mono.length; i += hop) {
    let energy = 0;
    for (let j = 0; j < hop; j += 4) energy += mono[i + j] * mono[i + j];
    env.push(Math.max(0, energy - prev));
    prev = energy;
  }
  const hopSec = hop / sampleRate;
  let best = 0;
  let bestBpm = 0;
  let sum = 0;
  let n = 0;
  for (let bpm = 60; bpm <= 180; bpm++) {
    const lag = Math.round(60 / bpm / hopSec);
    if (lag < 2 || lag >= env.length / 2) continue;
    let corr = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i < env.length - lag; i++) {
      corr += env[i] * env[i + lag];
      e0 += env[i] * env[i];
      e1 += env[i + lag] * env[i + lag];
    }
    const norm = corr / Math.sqrt(e0 * e1 + 1e-12);
    sum += norm;
    n += 1;
    if (norm > best) {
      best = norm;
      bestBpm = bpm;
    }
  }
  if (!n || best < 0.3 || best < sum / n + 0.05) return null;
  return bestBpm;
}

export function applyFxChain(samples, channels, rate, chain) {
  let cur = samples;
  for (const fx of chain || []) {
    if (!fx || typeof fx !== "object") throw new Error("fx_chain entry is not an object");
    if (fx.type === "lowpass" || fx.type === "highpass") cur = filterOnePole(cur, channels, rate, fx);
    else if (fx.type === "delay") cur = delayFx(cur, channels, rate, fx);
    else throw new Error(`unknown fx ${fx.type}`);
  }
  return cur;
}

function filterOnePole(samples, channels, rate, fx) {
  const cutoff = Number(fx.cutoff_hz);
  if (!(cutoff > 0)) throw new Error("filter cutoff_hz must be above 0");
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
  const out = new Float32Array(samples.length);
  const low = new Float32Array(channels);
  const frames = samples.length / channels;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = samples[i * channels + c];
      low[c] += a * (x - low[c]);
      out[i * channels + c] = fx.type === "highpass" ? x - low[c] : low[c];
    }
  }
  return out;
}

function delayFx(samples, channels, rate, fx) {
  const delay = Math.max(1, Math.round(Number(fx.delay_s) * rate));
  const feedback = Math.min(0.9, Math.max(0, Number(fx.feedback) || 0));
  const wet = Math.min(1, Math.max(0, Number(fx.mix)));
  if (!Number.isFinite(wet)) throw new Error("delay mix must be a number");
  const dry = 1 - wet;
  const lines = Array.from({ length: channels }, () => new Float32Array(delay));
  const idx = new Array(channels).fill(0);
  const out = new Float32Array(samples.length);
  const frames = samples.length / channels;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = samples[i * channels + c];
      const y = lines[c][idx[c]];
      lines[c][idx[c]] = x + y * feedback;
      idx[c] = (idx[c] + 1) % delay;
      out[i * channels + c] = x * dry + y * wet;
    }
  }
  return out;
}

function place(dst, dstRate, event) {
  const src = event.buffer;
  const srcChannels = event.channels;
  const srcFrames = framesOf(src, srcChannels);
  const step = (event.sampleRate / dstRate) * 2 ** ((event.pitch_offset || 0) / 12);
  const start = Math.round(event.start_s * dstRate);
  const amp = event.velocity ?? 1;
  const dstFrames = dst.length / 2;
  for (let i = 0; ; i++) {
    const pos = i * step;
    if (pos >= srcFrames) break;
    const di = start + i;
    if (di >= dstFrames) break;
    if (di < 0) continue;
    const i0 = Math.floor(pos);
    const i1 = Math.min(srcFrames - 1, i0 + 1);
    const frac = pos - i0;
    let left;
    let right;
    if (srcChannels === 1) {
      left = src[i0] + (src[i1] - src[i0]) * frac;
      right = left;
    } else {
      left = src[i0 * srcChannels] + (src[i1 * srcChannels] - src[i0 * srcChannels]) * frac;
      right = src[i0 * srcChannels + 1] + (src[i1 * srcChannels + 1] - src[i0 * srcChannels + 1]) * frac;
    }
    dst[di * 2] += left * amp;
    dst[di * 2 + 1] += right * amp;
  }
}

function layerEvents(layer, bpm) {
  if (layer.oneShot) {
    const shot = layer.oneShot;
    const event = {
      start_s: 0,
      buffer: shot.samples,
      sampleRate: shot.sampleRate,
      channels: shot.channels,
      velocity: 1,
      pitch_offset: 0,
    };
    if (!layer.loop) return [event];
    const dur = (shot.samples.length / shot.channels) / shot.sampleRate;
    return { loopEvery: Math.max(dur, 1 / shot.sampleRate), event };
  }
  const events = (layer.events || []).filter((event) => event.played !== false);
  if (!events.length) return [];
  const clock = events[0].steps_per_bar || 8;
  const maxStep = Math.max(...events.map((event) => event.step));
  const bars = Math.max(1, Math.ceil(maxStep / clock));
  const barS = bars * 4 * 60 / bpm;
  const mapped = events.map((event) => ({
    start_s: (event.step - 1) * (60 / bpm) * (4 / clock),
    buffer: event.buffer,
    sampleRate: event.sampleRate,
    channels: event.channels,
    velocity: event.velocity,
    pitch_offset: event.pitch_offset || 0,
  }));
  if (!layer.loop) return mapped;
  return { loopEvery: barS, events: mapped };
}

function layerDuration(layer, bpm) {
  if (layer.oneShot && !layer.events?.length) {
    const shot = layer.oneShot;
    return (shot.samples.length / shot.channels) / shot.sampleRate;
  }
  const events = layer.events || [];
  if (!events.length) return 0;
  const clock = events[0].steps_per_bar || 8;
  const maxStep = Math.max(...events.map((event) => event.step));
  const bars = Math.max(1, Math.ceil(maxStep / clock));
  let seconds = bars * 4 * 60 / bpm;
  for (const event of events) {
    if (event.played === false) continue;
    const start = (event.step - 1) * (60 / bpm) * (4 / clock);
    const dur = (event.buffer.length / event.channels / event.sampleRate) / 2 ** ((event.pitch_offset || 0) / 12);
    seconds = Math.max(seconds, start + dur);
  }
  return seconds;
}

function panCopy(bus, gain, pan) {
  const angle = ((Number(pan) + 1) * Math.PI) / 4;
  const left = Math.cos(angle) * Number(gain);
  const right = Math.sin(angle) * Number(gain);
  const out = new Float32Array(bus.length);
  for (let i = 0; i < bus.length / 2; i++) {
    out[i * 2] = bus[i * 2] * left;
    out[i * 2 + 1] = bus[i * 2 + 1] * right;
  }
  return out;
}

function renderBus(layer, frames, bpm, rate) {
  const bus = new Float32Array(frames * 2);
  const spec = layerEvents(layer, bpm);
  const lengthS = frames / rate;
  if (Array.isArray(spec)) {
    for (const event of spec) place(bus, rate, event);
    return bus;
  }
  if (spec.event) {
    for (let at = 0; at < lengthS; at += spec.loopEvery) {
      place(bus, rate, { ...spec.event, start_s: at });
    }
    return bus;
  }
  for (let at = 0; at < lengthS; at += spec.loopEvery) {
    for (const event of spec.events) place(bus, rate, { ...event, start_s: event.start_s + at });
  }
  return bus;
}

export function mixLayers({ layers, bpm, sampleRate = 48000, lengthS = 0 }) {
  if (!(bpm > 0)) throw new Error("mix bpm must be above 0");
  if (!layers?.length) throw new Error("mix has no layers");
  let seconds = lengthS;
  if (!(seconds > 0)) seconds = Math.max(0.05, ...layers.map((layer) => layerDuration(layer, bpm)));
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  guardFrames(frames, sampleRate);
  const master = new Float32Array(frames * 2);
  const stems = [];
  for (const layer of layers) {
    const dry = renderBus(layer, frames, bpm, sampleRate);
    const fxed = applyFxChain(dry, 2, sampleRate, layer.fx_chain || []);
    const stemmed = panCopy(fxed, layer.gain ?? 1, layer.pan ?? 0);
    stems.push(stemmed);
    for (let i = 0; i < master.length; i++) master[i] += stemmed[i];
  }
  let peak = 0;
  for (let i = 0; i < master.length; i++) {
    const x = Math.max(-1, Math.min(1, master[i]));
    master[i] = x;
    if (Math.abs(x) > peak) peak = Math.abs(x);
  }
  for (const stem of stems) {
    for (let i = 0; i < stem.length; i++) stem[i] = Math.max(-1, Math.min(1, stem[i]));
  }
  return {
    samples: master,
    stems,
    sampleRate,
    channels: 2,
    frames,
    peak,
    duration_s: frames / sampleRate,
  };
}
