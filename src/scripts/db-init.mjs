/* Create (or verify) the pix_posts table in Supabase.
     npm run db:init

   The server creates the schema on first use anyway, so this script exists
   for the moment you actually want the answer: is the connection string
   right, is the host reachable, does the table exist, how many rows are in
   it. Run it once after setting SUPABASE_DIRECT_CONNECTION_URL. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configureDb, ensureSchema, ping, query, closeDb, describeConnectionError, envConnectionString } from "../../lib/db.js";

loadDotEnv();

const url = envConnectionString();
if (!url) {
  console.error("✗ No connection string set (checked the environment and .env).");
  console.error("  Supabase dashboard → Connect → Session pooler → URI  (SUPABASE_POOLER_URL),");
  console.error("  or Direct connection → URI (SUPABASE_DIRECT_CONNECTION_URL, IPv6-only).");
  process.exit(1);
}
configureDb(url);

// Log the host only — never the password that sits in the same string.
try {
  const parsed = new URL(url);
  console.log(`→ ${parsed.hostname}:${parsed.port || 5432}/${parsed.pathname.replace(/^\//, "") || "postgres"} as ${parsed.username}`);
} catch {
  console.warn("⚠ SUPABASE_DIRECT_CONNECTION_URL is not a valid URI. If the password contains @ : / or #, percent-encode it.");
}

const health = await ping();
if (!health.ok) {
  console.error(`✗ Could not connect: ${health.error}`);
  await closeDb();
  process.exit(1);
}
console.log(`✓ Connected (server time ${health.at?.toISOString?.() || health.at})`);

try {
  await ensureSchema();
  console.log("✓ Table pix_posts is ready");

  const { rows } = await query(
    `select count(*)::int as posts,
            count(distinct user_login_id)::int as authors,
            max(created_at) as latest
       from pix_posts`
  );
  const { posts, authors, latest } = rows[0];
  console.log(`  ${posts} saved pix from ${authors} account(s)${latest ? `, latest ${latest.toISOString()}` : ""}`);
} catch (err) {
  console.error(`✗ Schema setup failed: ${describeConnectionError(err)}`);
  await closeDb();
  process.exit(1);
}

await closeDb();

/* Minimal KEY=VALUE reader. server.mjs parses .env the same way rather than
   depending on dotenv's side effects; this keeps the script standalone. */
function loadDotEnv() {
  for (const file of [join(process.cwd(), ".env"), join(process.cwd(), "..", ".env")]) {
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
        if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
      }
      return;
    } catch { /* unreadable .env — fall back to the real environment */ }
  }
}
