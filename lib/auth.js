/* ── Accounts and sessions ──
   Pix has its own login. There are exactly two roles:

     writer — content writers. Build posts and save them, can re-open and
              re-save their own, and see only their own in the library.
     qa     — everything a writer can do, plus editing and deleting anyone's
              posts, and a library that lists every post.

   Passwords are stored as scrypt hashes, never in any recoverable form.
   Sessions are opaque random tokens kept in Postgres and handed to the
   browser in an HttpOnly cookie: the cookie carries no claims, so a session
   can be revoked by deleting a row and nothing the client holds can be
   forged. */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { query, readQuery, ensureSchema as ensurePixSchema } from "./db.js";

const scrypt = promisify(scryptCb);

/* writer — writes their own posts
   qa     — reviews and publishes everyone's
   admin  — the above, plus the team roster and the full analytics

   Admin is deliberately a superset rather than a separate track: an admin who
   could not approve would have to keep a QA account open beside their own. */
export const ROLES = ["writer", "qa", "admin"];

/* The two roles that may act on anyone's post. Everywhere this matters the
   check used to read `role !== "qa"`, which would have quietly locked admins
   out of their own tool. */
export function canReview(role) { return role === "qa" || role === "admin"; }
export function isAdmin(role) { return role === "admin"; }
export const SESSION_COOKIE = "pix_session";
const SESSION_DAYS = 7;

/* scrypt cost. 16384/8/1 is the Node default and takes ~50-100ms here, which
   is the point: it is the difference between an offline crack of a leaked
   hash taking hours and taking years. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const SCHEMA_SQL = `
create table if not exists pix_users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique,
  password_hash text not null,
  role          text not null default 'writer',
  display_name  text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists pix_sessions (
  -- the sha256 of the cookie value, never the value itself: a leaked database
  -- backup must not hand anyone a working session
  token_hash text primary key,
  user_id    uuid not null references pix_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index if not exists pix_sessions_user_idx on pix_sessions (user_id);
create index if not exists pix_sessions_expiry_idx on pix_sessions (expires_at);
`;

let schemaReady = null;

export function ensureAuthSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = ensurePixSchema()
    .then(() => query(SCHEMA_SQL))
    .then(() => true, (err) => { schemaReady = null; throw err; });
  return schemaReady;
}

/* ── Passwords ── */

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored || "").split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const actual = await scrypt(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ── Users ── */

export async function createUser({ username, password, role = "writer", displayName = null }) {
  await ensureAuthSchema();
  const name = normaliseUsername(username);
  if (!name) throw new Error("A username is required.");
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  // A floor, not a policy. Short passwords are the team's call; what protects
  // them is the scrypt cost and the login throttle, not this number.
  if (!password || password.length < 6) throw new Error("Passwords must be at least 6 characters.");

  const password_hash = await hashPassword(password);
  const { rows } = await query(
    `insert into pix_users (username, password_hash, role, display_name)
     values ($1, $2, $3, $4)
     returning id, username, role, display_name, created_at`,
    [name, password_hash, role, displayName || username]
  );
  return rows[0];
}

export async function listUsers() {
  await ensureAuthSchema();
  const { rows } = await query(
    `select id, username, role, display_name, active, created_at, last_login_at
       from pix_users order by role, username`
  );
  return rows;
}

export async function setPassword(username, password) {
  await ensureAuthSchema();
  // The 6-character floor lives in createUser, so a reset could previously set
  // a 1-character password. Same rule, both doors.
  if (!password || password.length < 6) throw new Error("Passwords must be at least 6 characters.");
  const password_hash = await hashPassword(password);
  const { rowCount } = await query(
    "update pix_users set password_hash = $2 where username = $1",
    [normaliseUsername(username), password_hash]
  );
  return rowCount > 0;
}

/* Disable an account without destroying its history.

   Deleting the row would cascade pix_sessions away and, more importantly,
   orphan every post that writer produced — user_login_id is a bare text
   column, so the posts would survive with an id that resolves to nobody.
   Flipping `active` keeps the audit trail intact.

   Note the effect is not instant: login checks `active` immediately, but an
   existing session is only torn down when sessionUser next runs for that
   cookie, so a signed-in user is cut off on their next request rather than
   mid-page. */
export async function setUserActive(username, active) {
  await ensureAuthSchema();
  const { rows } = await query(
    `update pix_users set active = $2 where username = $1
     returning id, username, role, display_name, active`,
    [normaliseUsername(username), Boolean(active)]
  );
  if (rows[0] && !active) {
    // Revoke live sessions now rather than waiting for the lazy sweep.
    await query("delete from pix_sessions where user_id = $1", [rows[0].id]);
  }
  return rows[0] || null;
}

export async function updateUser(oldUsername, { username, role, displayName }) {
  await ensureAuthSchema();
  const oldName = normaliseUsername(oldUsername);
  const newName = normaliseUsername(username);
  if (!newName) throw new Error("A username is required.");
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);

  const { rows } = await query(
    `update pix_users set username = $2, role = $3, display_name = $4
     where username = $1
     returning id, username, role, display_name, active`,
    [oldName, newName, role, displayName || newName]
  );
  return rows[0] || null;
}

export async function deleteUser(username) {
  await ensureAuthSchema();
  const { rowCount } = await query(
    "delete from pix_users where username = $1",
    [normaliseUsername(username)]
  );
  return rowCount > 0;
}

export function normaliseUsername(value) {
  return String(value || "").trim().toLowerCase().slice(0, 64);
}

/* ── Login ──
   A wrong username and a wrong password answer identically, and both pay the
   same scrypt cost, so the endpoint cannot be used to enumerate accounts. */
const DUMMY_HASH_PROMISE = hashPassword("never-matches-anything");

export async function login({ username, password, userAgent = null }) {
  await ensureAuthSchema();
  const name = normaliseUsername(username);

  // readQuery, not query: a dropped pooler connection here would answer a
  // correct password with "Login is unavailable right now" at random.
  const { rows } = await readQuery(
    "select id, username, password_hash, role, display_name, active from pix_users where username = $1",
    [name]
  );
  const user = rows[0];

  const ok = user && user.active
    ? await verifyPassword(String(password || ""), user.password_hash)
    : (await verifyPassword(String(password || ""), await DUMMY_HASH_PROMISE), false);

  if (!ok) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query(
    "insert into pix_sessions (token_hash, user_id, expires_at, user_agent) values ($1, $2, $3, $4)",
    [hashToken(token), user.id, expiresAt, String(userAgent || "").slice(0, 300) || null]
  );
  await query("update pix_users set last_login_at = now() where id = $1", [user.id]);

  return { token, expiresAt, user: publicUser(user) };
}

export async function logout(token) {
  if (!token) return false;
  await ensureAuthSchema();
  const { rowCount } = await query("delete from pix_sessions where token_hash = $1", [hashToken(token)]);
  return rowCount > 0;
}

/** Resolve a cookie value to a user, or null. Expired rows are swept lazily. */
export async function sessionUser(token) {
  if (!token) return null;
  await ensureAuthSchema();
  // Runs on every authenticated request. Treating a dead pooled connection as
  // "no such session" would sign the user out mid-edit for no reason.
  const { rows } = await readQuery(
    `select u.id, u.username, u.role, u.display_name, u.active, s.expires_at
       from pix_sessions s join pix_users u on u.id = s.user_id
      where s.token_hash = $1`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.active || new Date(row.expires_at).getTime() < Date.now()) {
    await query("delete from pix_sessions where token_hash = $1", [hashToken(token)]).catch(() => {});
    return null;
  }
  return publicUser(row);
}

export async function purgeExpiredSessions() {
  await ensureAuthSchema();
  const { rowCount } = await query("delete from pix_sessions where expires_at < now()");
  return rowCount;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name || row.username,
    // An admin outranks QA, so this must not be a test for the literal role —
    // an admin reported as unable to edit others is wrong on its face.
    canEditOthers: canReview(row.role),
  };
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/* ── Cookies ── */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Build the Set-Cookie value for a session.
 *
 * `secure` has to be decided per request rather than hard-coded: the cookie
 * must carry Secure in production (behind Railway's HTTPS proxy) but must not
 * on plain http://localhost, where a Secure cookie is simply discarded and
 * login silently fails.
 */
export function sessionCookie(token, { secure = false, expiresAt = null } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${token ? SESSION_DAYS * 86_400 : 0}`,
  ];
  if (expiresAt) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/* ── Fixed-window counters ──
   In-memory, per key. Not a distributed rate limiter — it exists so a single
   box cannot be walked through a password list at network speed, and so a
   stuck tab cannot walk the OpenAI bill up at the same speed.

   The mechanic is one thing counted in a window; what gets counted differs by
   caller. Login counts FAILURES and clears on success, so a reviewer typing
   their password correctly is never throttled. The enhance limiter counts
   SUCCESSES, because there the successful call is the thing that costs money. */
export function createRateLimiter({ windowMs, max }) {
  const entries = new Map();

  return {
    check(key) {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || now - entry.first > windowMs) return { allowed: true, remaining: max };
      if (entry.count >= max) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.first + windowMs - now) / 1000) };
      }
      return { allowed: true, remaining: max - entry.count };
    },

    record(key) {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || now - entry.first > windowMs) entries.set(key, { first: now, count: 1 });
      else entry.count += 1;

      // Bound the map so a flood of distinct keys cannot grow it without limit.
      if (entries.size > 5_000) {
        for (const [k, v] of entries) {
          if (now - v.first > windowMs) entries.delete(k);
        }
      }
    },

    clear(key) {
      entries.delete(key);
    },
  };
}

/* Login: per username+IP, the realistic threat against six accounts. */
const loginThrottle = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

export function throttleCheck(key) { return loginThrottle.check(key); }
export function throttleRecordFailure(key) { loginThrottle.record(key); }
export function throttleClear(key) { loginThrottle.clear(key); }
