import { config } from "./config.mjs";
import { pool, query } from "./db.mjs";
import { pickCount, reportLine, rerenderHash, shuffleIds } from "./reproduce.mjs";

if (!config.db.password) {
  console.error("Set VIBE_DB_PASSWORD or source the wordfactory env so WF_DB_PASSWORD is set.");
  process.exit(1);
}

const n = pickCount(process.argv);
const { rows: ids } = await query(
  `SELECT id
   FROM vibe.samples
   WHERE patch IS NOT NULL
     AND seed IS NOT NULL
     AND source IN ('synth', 'sampler', 'sequencer')
   ORDER BY id`,
);
if (!ids.length) {
  console.error("no rendered samples with a patch and a seed");
  process.exit(1);
}
const chosen = shuffleIds(ids.map((row) => Number(row.id))).slice(0, n);
const { rows } = await query(
  `SELECT id, source, path, sha256, patch, seed, engine_version
   FROM vibe.samples
   WHERE id = ANY($1::bigint[])`,
  [chosen],
);
const byId = new Map(rows.map((row) => [Number(row.id), row]));

async function readSample(id) {
  const { rows: found } = await query(
    `SELECT id, source, path, patch, seed FROM vibe.samples WHERE id = $1`,
    [id],
  );
  return found[0] || null;
}

let failed = 0;
for (const id of chosen) {
  const row = byId.get(id);
  try {
    const hash = await rerenderHash(row, readSample);
    const match = hash === row.sha256;
    const cause = match
      ? null
      : `wav hash ${hash} != stored ${row.sha256}`
        + (row.engine_version ? "" : " (engine_version was not stored on this row)");
    if (!match) failed += 1;
    console.log(reportLine({
      id,
      module: row.source,
      match,
      cause,
      engine_version: row.engine_version,
    }));
  } catch (err) {
    failed += 1;
    console.log(reportLine({
      id,
      module: row.source,
      match: false,
      cause: err.message,
      engine_version: row.engine_version,
    }));
  }
}
await pool.end();
if (failed) {
  console.error(`${failed} of ${chosen.length} re-renders mismatched`);
  process.exit(1);
}
console.log(`reproduce check ok (${chosen.length})`);
