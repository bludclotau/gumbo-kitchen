import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export { rootDir };

export const config = {
  db: {
    host: process.env.VIBE_DB_HOST || process.env.WF_DB_HOST || "127.0.0.1",
    port: num(process.env.VIBE_DB_PORT || process.env.WF_DB_PORT, 5432),
    database: process.env.VIBE_DB_NAME || process.env.WF_DB_NAME || "wordfactory",
    user: process.env.VIBE_DB_USER || process.env.WF_DB_USER || "wordfactory",
    password: process.env.VIBE_DB_PASSWORD || process.env.WF_DB_PASSWORD || "",
  },
  qwen: {
    base: (process.env.VIBE_QWEN_URL || "http://10.1.1.122:8081/v1").replace(/\/$/, ""),
    model: process.env.VIBE_QWEN_MODEL || "C:\\llama\\qwen\\qwen.gguf",
    timeoutMs: num(process.env.VIBE_LLM_TIMEOUT_MS, 600000),
  },
  dolphin: {
    base: (process.env.VIBE_DOLPHIN_URL || "http://10.1.1.122:8082/v1").replace(/\/$/, ""),
    model: process.env.VIBE_DOLPHIN_MODEL || "C:\\llama\\dolphin\\dolphin.gguf",
  },
  host: process.env.VIBE_HOST || "0.0.0.0",
  port: num(process.env.VIBE_PORT, 3920),
  fmBin: process.env.VIBE_FM_BIN || path.join(rootDir, "engine", "vibe-fm"),
  rendersDir: process.env.VIBE_RENDERS || path.join(rootDir, "renders"),
  wavbvkeryRoot:
    process.env.VIBE_WAVBVKERY ||
    "/home/snerloc/vibe-hub/ess-eleven-hundred/samples",
  embedding: {
    model: "BAAI/bge-small-en-v1.5",
    dimensions: 384,
  },
};
