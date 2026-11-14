import { spawn } from "node:child_process";
import { config } from "./config.mjs";

export function renderWav(patchPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.fmBin, ["render", "-o", outPath, patchPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop() || "";
      let meta = null;
      try {
        meta = JSON.parse(line);
      } catch {
        meta = null;
      }
      if (code !== 0 || !meta || meta.status !== "ok") {
        reject(new Error(meta?.msg || stderr.trim() || stdout.trim() || `vibe-fm exited ${code}`));
        return;
      }
      resolve(meta);
    });
  });
}
