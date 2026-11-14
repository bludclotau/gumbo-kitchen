export const FM_ENGINE = "vibe-fm 1";
export const DSP_ENGINE = "dsp 1";

export function engineForSource(source) {
  if (source === "synth") return FM_ENGINE;
  if (source === "sampler" || source === "sequencer") return DSP_ENGINE;
  return null;
}
