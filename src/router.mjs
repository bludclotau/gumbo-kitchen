function isConcreteCommand(text) {
  const timed = /\d+(?:\.\d+)?\s*(?:s\b|sec\b|secs\b|seconds?\b)/.test(text);
  const instrument = /\b(trumpet|brass|chord|pad|bass|lead|bell|pluck|kick|snare|hat|synth|organ|string|flute|saw|square|piano|horn)\b/.test(text);
  const sampler = /\b(slices?|granulat\w*|grains?|trims?|normali[sz]\w*|revers\w*|pitch\w*|stretch\w*|loops?|captur\w*)\b/.test(text)
    && /\d/.test(text);
  const sequence = /off-?beats?|\d+(?:\.\d+)?\s*bpm|\blayers?\b|mix it down|mixdown|mix down|\bpattern\b/.test(text);
  return (timed && instrument) || sampler || sequence;
}

export function routePrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  const lyric = /\b(lyrics?|verses?|choruses?|hooks?)\b/.test(text);
  const naming = /\b(names?|titles?|tags?)\b/.test(text)
    && /\b(this|it|sample|track|call|give|suggest|add)\b/.test(text);
  if ((lyric || naming) && !isConcreteCommand(text)) {
    let purpose = "name";
    if (lyric) purpose = "lyric";
    else if (/\btags?\b/.test(text)) purpose = "tags";
    return { kind: "text", purpose };
  }
  if (!isConcreteCommand(text)) return { kind: "expand" };
  return { kind: "qwen" };
}

export const EXPAND_PROMPT = [
  "Rewrite the request as one concrete instruction for an audio renderer.",
  "If it is a tone, name the instrument, say chord or note, and give a duration in seconds.",
  "If it edits a sample, name one operation (slice, granulate, trim, reverse, pitch, stretch, or loop) and the numbers it needs.",
  "If it is a pattern or a mix, give the bpm or the layer change, the level, and the pan.",
  "Reply with one sentence and no JSON.",
].join(" ");
