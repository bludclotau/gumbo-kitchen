export function inspectWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF WAVE file");
  }
  let off = 12;
  let fmt = null;
  let dataSize = -1;
  let dataOffset = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (start > buf.length) break;
    if (id === "fmt " && size >= 16 && start + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      dataSize = size;
      dataOffset = start;
      break;
    }
    const step = 8 + size + (size & 1);
    if (step <= 0) break;
    off += step;
  }
  if (!fmt || dataSize < 0 || dataOffset < 0) throw new Error("wav is missing fmt or data");
  if (fmt.audioFormat !== 1) throw new Error(`unsupported wav encoding ${fmt.audioFormat}`);
  if (![16, 24, 32].includes(fmt.bits)) throw new Error(`unsupported bit depth ${fmt.bits}`);
  const bytesPerFrame = fmt.channels * (fmt.bits / 8);
  if (!Number.isInteger(bytesPerFrame) || bytesPerFrame <= 0) {
    throw new Error("bad wav frame size");
  }
  const frames = Math.floor(dataSize / bytesPerFrame);
  return {
    audioFormat: fmt.audioFormat,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bits: fmt.bits,
    frames,
    duration_s: frames / fmt.sampleRate,
    dataOffset,
  };
}

export function decodeWav(buf) {
  const info = inspectWav(buf);
  const bytesPer = info.channels * (info.bits / 8);
  const samples = new Float32Array(info.frames * info.channels);
  let o = info.dataOffset;
  const end = Math.min(buf.length, info.dataOffset + info.frames * bytesPer);
  let i = 0;
  while (o + bytesPer <= end && i < samples.length) {
    for (let c = 0; c < info.channels; c++) {
      if (info.bits === 16) {
        samples[i++] = buf.readInt16LE(o) / 32768;
        o += 2;
      } else if (info.bits === 24) {
        let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        samples[i++] = v / 8388608;
        o += 3;
      } else {
        samples[i++] = buf.readInt32LE(o) / 2147483648;
        o += 4;
      }
    }
  }
  return {
    samples,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bits: info.bits,
    frames: samples.length / info.channels,
  };
}

export function encodeWav(samples, sampleRate, channels) {
  if (!(sampleRate > 0) || !Number.isInteger(channels) || channels < 1) {
    throw new Error("bad wav format");
  }
  const frames = samples.length / channels;
  if (!Number.isInteger(frames) || frames < 1) throw new Error("wav has no whole frames");
  const dataSize = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    let x = samples[i];
    if (x > 1) x = 1;
    else if (x < -1) x = -1;
    const n = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
    buf.writeInt16LE(n, o);
    o += 2;
  }
  return buf;
}
