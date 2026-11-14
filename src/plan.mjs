import { makeRng } from "../engine/dsp.mjs";
import { parseDuration } from "./patch.mjs";

export const NEUTRAL_SAMPLER = {
  op: "capture",
  source_ref: "latest",
  duration_s: 0.5,
  start_s: 0,
  end_s: 0,
  semitones: 0,
  preserve_duration: false,
  stretch: 1,
  slice_mode: "count",
  count: 1,
  beats_per_slice: 1,
  grid_bpm: 120,
  loop_start_s: 0,
  loop_end_s: 0,
  crossfade_s: 0.01,
  grain_size_s: 0.12,
  density: 8,
  position_jitter: 0.2,
  pitch_jitter: 0,
  window: "hann",
};

export const NEUTRAL_SEQUENCER = {
  action: "set_meta",
  render: false,
  bpm: 120,
  key: "",
  gain: 1,
  pan: 0,
  source_ref: "latest",
  steps_per_bar: 8,
  bars: 1,
  placement: "all",
  slice_indices: [],
  velocity: 0.85,
  pitch_offset: 0,
  probability: 1,
  loop: false,
  euclidean_pulses: 0,
  euclidean_steps: 8,
  euclidean_rotate: 0,
};

export const EXAMPLES = [
  {
    prompt: "take that brass chord, slice it into 8, and play slices 1 3 5 7 on the off-beats at 90 bpm",
    plan: {
      use_sampler: true,
      use_sequencer: true,
      sampler: { ...NEUTRAL_SAMPLER, op: "slice", source_ref: "latest", slice_mode: "count", count: 8, duration_s: 0.5 },
      sequencer: {
        ...NEUTRAL_SEQUENCER,
        action: "create_pattern",
        render: true,
        bpm: 90,
        gain: 1,
        pan: 0,
        source_ref: "latest",
        steps_per_bar: 8,
        bars: 1,
        placement: "offbeats",
        slice_indices: [1, 3, 5, 7],
        velocity: 0.85,
      },
    },
  },
  {
    prompt: "granulate the last sample into a slow shimmering pad, 4 seconds",
    plan: {
      use_sampler: true,
      use_sequencer: false,
      sampler: {
        ...NEUTRAL_SAMPLER,
        op: "grain",
        source_ref: "latest",
        duration_s: 4,
        grain_size_s: 0.12,
        density: 8,
        position_jitter: 0.2,
        pitch_jitter: 4,
        window: "hann",
      },
      sequencer: { ...NEUTRAL_SEQUENCER },
    },
  },
  {
    prompt: "add that as a new layer, quieter, panned left, and mix it down",
    plan: {
      use_sampler: false,
      use_sequencer: true,
      sampler: { ...NEUTRAL_SAMPLER },
      sequencer: {
        ...NEUTRAL_SEQUENCER,
        action: "add_layer",
        render: true,
        gain: 0.45,
        pan: -0.7,
        source_ref: "latest",
        placement: "all",
        slice_indices: [],
      },
    },
  },
];

export const PLAN_SYSTEM_PROMPT = [
  "You write one Kitchen plan as JSON. You do not write audio. Fill every key on both objects.",
  "use_sampler and use_sequencer say which side runs. The side that does not run must still be the neutral object.",
  "source_ref latest is the newest sample, root walks parent_id to the top, previous is the parent of the newest.",
  "slice_indices are 1-based pieces from the sampler op in this same plan. Off-beats are an 8th-note grid: steps_per_bar 8 and placement offbeats, which is steps 2 4 6 8.",
  "pan -1 is hard left, 0 is centre, 1 is hard right. Quieter means gain 0.45. render true writes the mixdown. euclidean_pulses 0 turns the euclidean generator off.",
  "A slow shimmering pad is op grain, window hann, grain_size_s 0.12, density 8, position_jitter 0.2, pitch_jitter 4, and duration_s equal to the seconds the user asked for.",
  "Match the example of the same kind of request. Do not copy an example for a different request.",
  "",
  `Neutral sampler: ${JSON.stringify(NEUTRAL_SAMPLER)}`,
  `Neutral sequencer: ${JSON.stringify(NEUTRAL_SEQUENCER)}`,
  "",
  ...EXAMPLES.flatMap((example) => [`Prompt: ${example.prompt}`, JSON.stringify(example.plan), ""]),
].join("\n");

export function planSchema(samplerSchema, sequencerSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["use_sampler", "use_sequencer", "sampler", "sequencer"],
    properties: {
      use_sampler: { type: "boolean" },
      use_sequencer: { type: "boolean" },
      sampler: samplerSchema,
      sequencer: sequencerSchema,
    },
  };
}

function roundKey(obj, key, adjustments, label) {
  const n = Math.round(Number(obj[key]));
  if (n !== Number(obj[key])) adjustments.push(`${label} rounded to ${n}`);
  obj[key] = n;
}

export function normalizePlan(plan, prompt) {
  const next = structuredClone(plan);
  const adjustments = [];
  const sampler = next.sampler;
  const seq = next.sequencer;
  roundKey(sampler, "count", adjustments, "sampler.count");
  roundKey(sampler, "grid_bpm", adjustments, "sampler.grid_bpm");
  roundKey(seq, "steps_per_bar", adjustments, "sequencer.steps_per_bar");
  roundKey(seq, "bars", adjustments, "sequencer.bars");
  roundKey(seq, "euclidean_pulses", adjustments, "sequencer.euclidean_pulses");
  roundKey(seq, "euclidean_steps", adjustments, "sequencer.euclidean_steps");
  roundKey(seq, "euclidean_rotate", adjustments, "sequencer.euclidean_rotate");
  seq.slice_indices = (seq.slice_indices || []).map((value, index) => {
    const n = Math.round(Number(value));
    if (n !== Number(value)) adjustments.push(`slice_indices[${index}] rounded to ${n}`);
    return n;
  });

  const text = String(prompt);
  const into = text.match(/\binto\s+(\d+)\b/i);
  if (into && /\bslice\b/i.test(text)) {
    const n = Number(into[1]);
    if (sampler.count !== n) {
      adjustments.push(`count set to ${n} from the prompt`);
      sampler.count = n;
    }
  }
  const listed = text.match(/\bslices?\s+(\d+(?:\s+\d+)*)/i);
  if (listed) {
    const idx = listed[1].split(/\s+/).map(Number);
    const same = idx.length === seq.slice_indices.length && idx.every((n, i) => n === seq.slice_indices[i]);
    if (!same) {
      adjustments.push(`slice_indices set to [${idx.join(",")}] from the prompt`);
      seq.slice_indices = idx;
    }
  }
  const bpm = text.match(/(\d+(?:\.\d+)?)\s*bpm/i);
  if (bpm && Number(seq.bpm) !== Number(bpm[1])) {
    adjustments.push(`bpm set to ${bpm[1]} from the prompt`);
    seq.bpm = Number(bpm[1]);
  }
  if (/off-beat|offbeat/i.test(text) && seq.steps_per_bar !== 8) {
    adjustments.push("steps_per_bar set to 8 for an 8th-note off-beat grid");
    seq.steps_per_bar = 8;
  }
  if (/off-beat|offbeat/i.test(text) && !/\bbars?\b/i.test(text) && seq.bars !== 1) {
    adjustments.push("bars set to 1");
    seq.bars = 1;
  }
  if (sampler.op === "grain") {
    const asked = parseDuration(text);
    if (asked != null) {
      if (asked < 0.05 || asked > 30) throw new Error(`requested duration ${asked}s is outside 0.05..30`);
      if (Number(sampler.duration_s) !== asked) {
        adjustments.push(`duration_s set to ${asked} from the prompt`);
        sampler.duration_s = asked;
      }
    }
  }
  return { plan: next, adjustments };
}

export function planErrors(prompt, plan) {
  const errors = [];
  const text = String(prompt).toLowerCase();
  const samplerWord = /\b(slices?|granulat|grains?|shimmer|trims?|normali[sz]|revers|pitch|stretch|loops?|captur)/.test(text);
  const seqWord = /off-beat|offbeat|\bbpm\b|\blayer\b|mix it down|mixdown|mix down|\bpattern\b/.test(text);
  const grain = /granulat|grain|shimmer/.test(text);
  if (samplerWord && !plan.use_sampler) errors.push("use_sampler must be true");
  if (!samplerWord && plan.use_sampler) errors.push("use_sampler must be false");
  if (seqWord && !plan.use_sequencer) errors.push("use_sequencer must be true");
  if (!seqWord && plan.use_sequencer) errors.push("use_sequencer must be false");
  if (/\bslice\b/.test(text)) {
    if (plan.sampler.op !== "slice") errors.push('slice needs sampler.op "slice"');
    if (/\binto\s+\d+/.test(text) && plan.sampler.slice_mode !== "count") errors.push('slice_mode must be "count"');
    const into = text.match(/\binto\s+(\d+)\b/);
    if (into && Number(plan.sampler.count) !== Number(into[1])) errors.push(`count must be ${into[1]}`);
  }
  if (grain) {
    if (plan.sampler.op !== "grain") errors.push('granulate needs sampler.op "grain"');
    if (plan.use_sequencer) errors.push("granulate does not use the sequencer");
    const asked = parseDuration(prompt);
    if (asked != null && Number(plan.sampler.duration_s) !== asked) errors.push(`duration_s must be ${asked}`);
    if (!(plan.sampler.density >= 4 && plan.sampler.density <= 12)) errors.push("a slow pad needs density from 4 to 12");
    if (!(plan.sampler.grain_size_s >= 0.05 && plan.sampler.grain_size_s <= 0.25)) {
      errors.push("a shimmering pad needs grain_size_s from 0.05 to 0.25");
    }
    if (!(plan.sampler.pitch_jitter > 0)) errors.push("shimmer needs pitch_jitter above 0, use 4");
    if (plan.sampler.window !== "hann") errors.push('shimmering pad uses window "hann"');
  }
  if (/off-beat|offbeat/.test(text)) {
    if (plan.sequencer.placement !== "offbeats") errors.push('placement must be "offbeats"');
    if (Number(plan.sequencer.steps_per_bar) !== 8) errors.push("steps_per_bar must be 8");
    if (!/\bbars?\b/.test(text) && Number(plan.sequencer.bars) !== 1) errors.push("bars must be 1");
    if (!["create_pattern", "add_layer"].includes(plan.sequencer.action)) {
      errors.push('off-beats need action "create_pattern"');
    }
    const listed = text.match(/\bslices?\s+(\d+(?:\s+\d+)*)/);
    if (listed) {
      const want = listed[1].split(/\s+/).map(Number);
      const got = (plan.sequencer.slice_indices || []).map(Number);
      if (want.length !== got.length || want.some((n, i) => n !== got[i])) {
        errors.push(`slice_indices must be [${want.join(",")}]`);
      }
    }
  }
  const bpm = text.match(/(\d+(?:\.\d+)?)\s*bpm/);
  if (bpm && Number(plan.sequencer.bpm) !== Number(bpm[1])) errors.push(`bpm must be ${bpm[1]}`);
  if (/mix it down|mixdown|mix down|off-beat|offbeat|\bplay\b/.test(text) && !plan.sequencer.render) {
    errors.push("render must be true");
  }
  if (/new layer/.test(text) && plan.sequencer.action !== "add_layer") errors.push('action must be "add_layer"');
  const adds = plan.use_sequencer && ["add_layer", "create_pattern"].includes(plan.sequencer.action);
  if (/\bquieter\b|\bsofter\b/.test(text) && !(Number(plan.sequencer.gain) <= 0.6)) {
    errors.push("quieter needs gain at or below 0.6, use 0.45");
  }
  if (adds && !/\bquieter\b|\bsofter\b|\blouder\b/.test(text) && !(Number(plan.sequencer.gain) >= 0.8)) {
    errors.push("gain must stay at or above 0.8 when the prompt does not ask for a level change");
  }
  if (/panned left|pan(?:ned)? left|to the left/.test(text) && !(Number(plan.sequencer.pan) < 0)) {
    errors.push("panned left needs pan below 0, use -0.7");
  }
  if (adds && !/\b(left|right)\b/.test(text) && Number(plan.sequencer.pan) !== 0) {
    errors.push("pan must be 0 when the prompt does not ask for a side");
  }
  if (/last sample|that brass|that chord/.test(text) && plan.use_sampler && plan.sampler.source_ref !== "latest") {
    errors.push('source_ref must be "latest"');
  }
  if (/add that/.test(text) && plan.sequencer.source_ref !== "latest") errors.push('source_ref must be "latest"');
  if (plan.use_sampler && plan.sampler.op === "slice" && plan.use_sequencer) {
    for (const n of plan.sequencer.slice_indices || []) {
      if (n < 1 || n > plan.sampler.count) errors.push(`slice index ${n} is outside 1..${plan.sampler.count}`);
    }
  }
  return errors;
}

export function bjorklund(pulses, steps) {
  const pattern = new Array(Math.max(0, steps)).fill(0);
  if (pulses <= 0 || steps <= 0) return pattern;
  const n = Math.min(Math.round(pulses), steps);
  let bucket = 0;
  for (let i = 0; i < steps; i++) {
    bucket += n;
    if (bucket >= steps) {
      bucket -= steps;
      pattern[i] = 1;
    }
  }
  return pattern;
}

function rotate(list, amount) {
  const n = list.length;
  if (!n) return [];
  const k = ((Math.round(amount) % n) + n) % n;
  return list.slice(k).concat(list.slice(0, k));
}

export function gridHits({ placement, stepsPerBar, bars, pulses = 0, euclideanSteps = 8, rotateBy = 0 }) {
  if (pulses > 0) {
    const steps = Math.max(1, Math.round(euclideanSteps));
    const pat = rotate(bjorklund(pulses, steps), rotateBy);
    const hits = [];
    for (let bar = 0; bar < bars; bar++) {
      pat.forEach((on, i) => {
        if (on) hits.push(bar * steps + i + 1);
      });
    }
    return { hits, clock: steps };
  }
  const hits = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let step = 1; step <= stepsPerBar; step++) {
      const on = placement === "all"
        || placement === "custom"
        || (placement === "beats" && step % 2 === 1)
        || (placement === "offbeats" && step % 2 === 0);
      if (on) hits.push(bar * stepsPerBar + step);
    }
  }
  return { hits, clock: stepsPerBar };
}

export function buildPattern(opts) {
  const pulses = Number(opts.pulses) || 0;
  let hits;
  let clock;
  if (opts.placement === "custom" && pulses <= 0) {
    hits = (opts.sliceIndices || []).map((n) => Math.round(Number(n)));
    clock = opts.stepsPerBar;
  } else {
    const grid = gridHits({
      placement: opts.placement,
      stepsPerBar: opts.stepsPerBar,
      bars: opts.bars,
      pulses,
      euclideanSteps: opts.euclideanSteps,
      rotateBy: opts.rotateBy,
    });
    hits = grid.hits;
    clock = grid.clock;
  }
  const rng = makeRng((opts.seed || 1) + 17);
  return hits.map((step, hitIndex) => {
    let sampleId = null;
    let productIndex = null;
    if (opts.productCount) {
      const sliceNo = opts.placement === "custom"
        ? (hitIndex % opts.productCount) + 1
        : (opts.sliceIndices.length ? opts.sliceIndices[hitIndex % opts.sliceIndices.length] : (hitIndex % opts.productCount) + 1);
      if (sliceNo < 1 || sliceNo > opts.productCount) {
        throw new Error(`slice index ${sliceNo} is outside 1..${opts.productCount}`);
      }
      productIndex = sliceNo;
    } else if (opts.sampleId) {
      sampleId = opts.sampleId;
    }
    const probability = Number(opts.probability);
    const played = probability >= 1 ? true : rng() < probability;
    return {
      step,
      steps_per_bar: clock,
      sample_id: sampleId,
      product_index: productIndex,
      velocity: opts.velocity,
      pitch_offset: opts.pitchOffset,
      probability,
      played,
    };
  });
}
