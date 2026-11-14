import pg from "pg";
import { config } from "./config.mjs";

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 4,
  idleTimeoutMillis: 10000,
  statement_timeout: 30000,
});

export function query(text, params) {
  return pool.query(text, params);
}
