import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";
import { pool, query } from "./db.mjs";
import { inspectWav } from "./wav.mjs";

if (!config.db.password) {
  console.error("Set VIBE_DB_PASSWORD or source the wordfactory env so WF_DB_PASSWORD is set.");
  process.exit(1);
}

function addWords(tags, text) {
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || word === "wavbvkery" || word === "dreams" || word === "wav") continue;
    if (/^\d+$/.test(word) && word.length <= 2) continue;
    if (/^[a-g]$/.test(word)) continue;
    tags.add(word);
  }
}

function tagsFromRel(rel) {
  const tags = new Set();
  const parts = rel.split(/[\\/]/);
  const file = parts.pop();
  for (const part of parts) addWords(tags, part);
  addWords(tags, file.replace(/\.wav$/i, ""));
  return [...tags];
}

function keyFromName(file) {
  const match = file.match(/\(([A-Ga-g](?:#|b)?)\)/);
  return match ? match[1].toUpperCase() : null;
}

async function wavFiles(dir) {
  const found = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await wavFiles(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) found.push(full);
  }
  return found;
}

const root = config.wavbvkeryRoot;
const files = await wavFiles(root);
let inserted = 0;
let skipped = 0;
for (const file of files) {
  const buf = await fs.readFile(file);
  const info = inspectWav(buf);
  const rel = path.relative(root, file);
  const result = await query(
    `INSERT INTO vibe.samples
       (name, source, path, sha256, duration_s, sample_rate, channels, "key", tags)
     VALUES ($1, 'wavbvkery', $2, $3, $4, $5, $6, $7, $8::text[])
     ON CONFLICT (path) DO NOTHING`,
    [
      path.basename(file, path.extname(file)),
      file,
      createHash("sha256").update(buf).digest("hex"),
      info.duration_s,
      info.sampleRate,
      info.channels,
      keyFromName(path.basename(file)),
      tagsFromRel(rel),
    ],
  );
  if (result.rowCount === 1) inserted += 1;
  else skipped += 1;
}

console.log(`wavbvkery: ${inserted} inserted, ${skipped} already present, ${files.length} files`);
await pool.end();
