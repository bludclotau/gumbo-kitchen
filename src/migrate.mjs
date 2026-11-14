import fs from "node:fs/promises";
import path from "node:path";
import { config, rootDir } from "./config.mjs";
import { pool, query } from "./db.mjs";

if (!config.db.password) {
  console.error("Set VIBE_DB_PASSWORD or source the wordfactory env so WF_DB_PASSWORD is set.");
  process.exit(1);
}

const dir = path.join(rootDir, "db", "migrations");
const down = process.argv.includes("--down");

if (down) {
  if (process.env.VIBE_ALLOW_DOWN !== "yes") {
    console.error("Refusing to drop schema vibe. Re-run with VIBE_ALLOW_DOWN=yes if you mean it.");
    process.exit(2);
  }
  const sql = await fs.readFile(path.join(dir, "001_vibe_schema.down.sql"), "utf8");
  await query(sql);
  console.log("dropped schema vibe");
  await pool.end();
  process.exit(0);
}

const files = (await fs.readdir(dir))
  .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
  .sort();

const reg = await query(`SELECT to_regclass('vibe.schema_migrations') AS name`);
const applied = new Set();
if (reg.rows[0].name) {
  const rows = await query(`SELECT filename FROM vibe.schema_migrations`);
  for (const row of rows.rows) applied.add(row.filename);
}

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip ${file}`);
    continue;
  }
  const sql = await fs.readFile(path.join(dir, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(`INSERT INTO vibe.schema_migrations (filename) VALUES ($1)`, [file]);
    await client.query("COMMIT");
    console.log(`applied ${file}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const modules = [
  ["fm-synth", "synth", "vibe-fm", "fm-synth.json"],
  ["sampler", "sampler", "dsp.mjs", "sampler.json"],
  ["sequencer", "sequencer", "dsp.mjs", "sequencer.json"],
];
for (const [name, kind, endpoint, file] of modules) {
  const schema = JSON.parse(await fs.readFile(path.join(rootDir, "schema", file), "utf8"));
  await query(
    `INSERT INTO vibe.modules (name, kind, version, param_schema, endpoint)
     VALUES ($1, $2, '1', $3::jsonb, $4)
     ON CONFLICT (name) DO UPDATE
     SET kind = EXCLUDED.kind,
         version = EXCLUDED.version,
         param_schema = EXCLUDED.param_schema,
         endpoint = EXCLUDED.endpoint`,
    [name, kind, JSON.stringify(schema), endpoint],
  );
  console.log(`registered module ${name}`);
}
await pool.end();
