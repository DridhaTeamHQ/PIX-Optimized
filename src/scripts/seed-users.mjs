/* Create the Pix accounts.
     npm run users:seed            create any that are missing
     npm run users:seed -- --reset re-set passwords on accounts that exist
     npm run users:list            show who exists (never shows passwords)

   Five content writers and one QA, on shared per-role passwords chosen by the
   team. Override either without editing this file:

     WRITER_PASSWORD=… QA_PASSWORD=… npm run users:seed -- --reset

   Passwords are stored only as scrypt hashes; the plain values live here and
   in whatever the team uses to share them. A shared password cannot be traced
   to a person, so `user_name` on a post says which account saved it, not who
   was at the keyboard. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configureDb, envConnectionString, closeDb } from "../../lib/db.js";
import { createUser, listUsers, setPassword, ensureAuthSchema } from "../../lib/auth.js";

const WRITER_PASSWORD = process.env.WRITER_PASSWORD || "writer@1234";
const QA_PASSWORD = process.env.QA_PASSWORD || "qa@1234";
/* The default admin. Usernames are lowercased and capped at 64 characters,
   so an email address works as one unchanged.

   The password sits here as a fallback, which means anyone who can read this
   repository can sign in as the administrator. Set ADMIN_PASSWORD in the
   environment and this literal is never used. */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin@dridhatechnologies.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Shortly#2025";

const ACCOUNTS = [
  { username: "writer1", role: "writer", displayName: "Content Writer 1", password: WRITER_PASSWORD },
  { username: "writer2", role: "writer", displayName: "Content Writer 2", password: WRITER_PASSWORD },
  { username: "writer3", role: "writer", displayName: "Content Writer 3", password: WRITER_PASSWORD },
  { username: "writer4", role: "writer", displayName: "Content Writer 4", password: WRITER_PASSWORD },
  { username: "writer5", role: "writer", displayName: "Content Writer 5", password: WRITER_PASSWORD },
  { username: "qa1", role: "qa", displayName: "QA Reviewer", password: QA_PASSWORD },
  // The admin owns the team roster and the full analytics. Without one seeded
  // the only route to a first admin account is a shell on the server.
  { username: ADMIN_USERNAME, role: "admin", displayName: "Administrator", password: ADMIN_PASSWORD },
];

loadDotEnv();

const url = envConnectionString();
if (!url) {
  console.error("✗ No connection string set. Add SUPABASE_POOLER_URL to .env (see README).");
  process.exit(1);
}
configureDb(url);

const listOnly = process.argv.includes("--list");
const reset = process.argv.includes("--reset");

try {
  await ensureAuthSchema();
} catch (err) {
  console.error(`✗ Could not reach the database: ${err.message}`);
  await closeDb();
  process.exit(1);
}

if (listOnly) {
  const users = await listUsers();
  if (!users.length) console.log("No accounts yet. Run: npm run users:seed");
  for (const u of users) {
    const seen = u.last_login_at ? `last login ${u.last_login_at.toISOString().slice(0, 16).replace("T", " ")}` : "never signed in";
    console.log(`  ${u.username.padEnd(10)} ${u.role.padEnd(8)} ${u.active ? "active " : "DISABLED"}  ${seen}`);
  }
  await closeDb();
  process.exit(0);
}

const existing = new Set((await listUsers()).map((u) => u.username));
const issued = [];

for (const account of ACCOUNTS) {
  const { password } = account;
  if (existing.has(account.username)) {
    if (!reset) {
      console.log(`· ${account.username} already exists — left alone (use --reset to re-set its password)`);
      continue;
    }
    // Report what actually happened. Reporting "reset" for a username that
    // did not match any row is how a wrong account name hides itself, and you
    // only find out when someone cannot sign in.
    const changed = await setPassword(account.username, password);
    issued.push({ ...account, note: changed ? "password reset" : "NOT FOUND — nothing changed" });
    continue;
  }
  await createUser(account);
  issued.push({ ...account, note: "created" });
}

if (!issued.length) {
  console.log("\nNothing to do. All six accounts already exist.");
} else {
  console.log("");
  console.log(`  ${"USERNAME".padEnd(11)}${"ROLE".padEnd(10)}${"PASSWORD".padEnd(16)}STATUS`);
  for (const u of issued) {
    console.log(`  ${u.username.padEnd(11)}${u.role.padEnd(10)}${u.password.padEnd(16)}${u.note}`);
  }
  console.log("\n  Writers can build and save their own posts.");
  console.log("  QA can open, edit and delete every post.\n");
}

await closeDb();

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
