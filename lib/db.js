/* ── Supabase Postgres ──
   One lazily-created pool for the whole process, plus the read/write helpers
   the /api/pix routes need.

   The connection string is SUPABASE_POOLER_URL, falling back to
   SUPABASE_DIRECT_CONNECTION_URL (Supabase dashboard → Connect). When neither
   is set the module stays inert and every helper reports "not configured"
   instead of throwing — the app has run without a database since day one and
   must keep working that way. Nothing in the poster pipeline should fail
   because storage is unavailable.

   Note on hosting: the *direct* connection is IPv6-only unless the IPv4 add-on
   is enabled, and it holds a real long-lived socket. That suits this
   long-running Node server (Railway/Docker). A serverless deploy (Netlify,
   Vercel) should use the Transaction pooler URL instead — same code, different
   string. */

import pg from "pg";

const { Pool } = pg;

let pool = null;
let connectionString = "";
let schemaReady = null;

/* Supabase hands out a self-signed chain for the direct host. Verifying it
   needs their CA bundle shipped alongside the app; every Supabase client
   library connects with rejectUnauthorized:false for the same reason. The
   connection is still TLS-encrypted. */
const SSL = { rejectUnauthorized: false };

/**
 * Point the module at a database. Called once at boot with whatever the host
 * exposes — server.mjs reads .env itself, so it passes the value in rather
 * than letting this module guess.
 */
export function configureDb(url) {
  const cleaned = String(url || "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  if (cleaned === connectionString) return isConfigured();
  connectionString = cleaned;
  schemaReady = null;
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
  return isConfigured();
}

export function isConfigured() {
  return Boolean(connectionString || envConnectionString());
}

/* The pooler wins when both are present. `db.<ref>.supabase.co` publishes an
   AAAA record and nothing else, so the direct string is unusable from any
   IPv4-only network — which includes most laptops and plenty of hosts. The
   session pooler is the same database over an IPv4 address. */
export function envConnectionString() {
  return process.env.SUPABASE_POOLER_URL
    || process.env.SUPABASE_DIRECT_CONNECTION_URL
    || process.env.DATABASE_URL
    || process.env.SUPABASE_DB_URL
    || "";
}

function getPool() {
  if (pool) return pool;
  const url = connectionString || envConnectionString();
  if (!url) throw new Error("No database configured. Set SUPABASE_POOLER_URL.");
  connectionString = url;
  pool = new Pool({
    connectionString: url,
    ssl: SSL,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase's pooler hangs up on connections it considers idle, and a NAT
    // in between will drop a silent socket sooner than that. TCP keepalives
    // keep the connection observably alive so the pool hands out live sockets.
    keepAlive: true,
  });
  // A pool error with no listener kills the process. A dropped Postgres
  // connection must never take the poster server down with it.
  pool.on("error", (err) => console.warn("⚠ Postgres pool error:", err.message));
  return pool;
}

/* Errors that mean "this connection was already dead", as opposed to "the
   statement was rejected". They surface on the next query against a socket the
   pool still believed was good, before any SQL reached the server — so the
   statement provably did not run and re-running it cannot double-apply. */
const DEAD_CONNECTION_CODES = new Set([
  "ECONNRESET",   // socket reset under us
  "EPIPE",        // wrote to a closed socket
  "ETIMEDOUT",    // silent drop, usually a NAT idle timeout
  "08006",        // connection_failure
  "08003",        // connection_does_not_exist
  "57P01",        // admin_shutdown — pooler recycled the backend
  "57P02",        // crash_shutdown
  "57P03",        // cannot_connect_now — Supabase still waking up
]);

function isDeadConnection(err) {
  if (DEAD_CONNECTION_CODES.has(err?.code)) return true;
  return /Connection terminated|Client has encountered a connection error|server closed the connection/i
    .test(err?.message || "");
}

export async function query(text, params = []) {
  await ensureSchema();
  return getPool().query(text, params);
}

/**
 * Same as query(), but retries once when the pool hands back a connection that
 * was already dead. ONLY for statements that are safe to run twice — reads.
 * A write must not use this: a timeout is ambiguous about whether it applied,
 * and this cannot tell the difference.
 */
export async function readQuery(text, params = []) {
  await ensureSchema();
  try {
    return await getPool().query(text, params);
  } catch (err) {
    if (!isDeadConnection(err)) throw err;
    console.warn("⚠ stale Postgres connection, retrying read:", err.code || err.message);
    return getPool().query(text, params);
  }
}

/* Health probe — used by /health and by `npm run db:init`. */
export async function ping() {
  if (!isConfigured()) return { configured: false, ok: false, error: "SUPABASE_POOLER_URL not set" };
  try {
    const { rows } = await getPool().query("select now() as at");
    return { configured: true, ok: true, at: rows[0]?.at || null };
  } catch (err) {
    return { configured: true, ok: false, error: describeConnectionError(err) };
  }
}

/* The one common failure here is IPv6: the direct host resolves to an AAAA
   record only, so an IPv4-only network answers ENETUNREACH/EHOSTUNREACH and
   the raw message ("connect ENETUNREACH 2406:da…") tells you nothing about
   the fix. Say what the fix is. */
function describeConnectionError(err) {
  const code = err?.code || "";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "ENOENT" || code === "EAI_AGAIN") {
    return `${err.message} — the direct connection is IPv6-only. On an IPv4 network use the Session pooler URL from the Supabase dashboard (Connect → Session pooler), or enable the IPv4 add-on.`;
  }
  if (code === "28P01") return "Password authentication failed — check the password in the connection string (percent-encode any special characters).";
  return err?.message || String(err);
}

export { describeConnectionError };

/* ── Schema ──
   Created on first use and then memoised, so a fresh Supabase project needs no
   manual migration step. Everything is IF NOT EXISTS, so it is safe to run on
   every boot and safe to run concurrently. */
const SCHEMA_SQL = `
create table if not exists pix_posts (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- who built it (from the Shortly agent session; null when auth is off)
  user_login_id     text,
  user_name         text,

  -- what the scrape returned
  source_url        text,
  scraped_title     text,
  article_text      text,
  detail_text       text,
  image_query       text,
  source_image_url  text,

  -- what the AI writer produced
  ai_headline       text,
  ai_bullets        jsonb not null default '[]'::jsonb,
  ai_tweet          text,
  ai_flags          jsonb not null default '[]'::jsonb,

  -- what the poster actually shows
  headline          text,
  detail_body       text,
  main_image_url    text,
  main_image_source text,
  aspect_ratio      text,
  accent_color      text,
  tag               text,

  -- the full editor snapshot: every slider, offset, filter and video setting,
  -- i.e. everything needed to reopen this pix exactly as it was
  design            jsonb not null default '{}'::jsonb
);

/* QA sign-off. Added with ALTER rather than in the CREATE above so a database
   made before approval existed picks the columns up on the next boot — the
   CREATE only ever runs on an empty schema. */
alter table pix_posts add column if not exists approved          boolean not null default false;
alter table pix_posts add column if not exists approved_at       timestamptz;
alter table pix_posts add column if not exists approved_by       text;
alter table pix_posts add column if not exists approved_by_name  text;

/* QA turn-down. Before these existed a post was either approved or "not
   approved", which conflated two very different things: one QA has looked at
   and refused, and one nobody has reached yet. A review desk needs to tell
   those apart, so rejection is recorded with the same attribution as approval.
   The two FLAGS are mutually exclusive — see setApproval(). The four
   attribution columns beside them are not: they are a record of the last
   approval and the last rejection, so a post can carry both at once when one
   verdict superseded the other. Read the flag to ask what a post's verdict is
   now; read the columns to ask who decided and when. */
alter table pix_posts add column if not exists rejected          boolean not null default false;
/* Drafts. Default false so every row that already exists stays exactly where
   it is — in the queue — rather than a migration silently emptying QA's
   worklist. Only posts saved as a draft from here on sit outside it. */
alter table pix_posts add column if not exists is_draft         boolean not null default false;
/* Every DailyMattr id this row has ever produced, oldest first. published_id
   holds only the latest, and a corrected story is a NEW entry over there —
   their API has no edit — so without this the earlier live copies become
   untraceable the moment one is superseded. Those copies do not disappear
   when we republish; someone has to go and remove them by hand, and this is
   the only record of what to remove. */
alter table pix_posts add column if not exists published_history jsonb not null default '[]'::jsonb;
/* What we sent DailyMattr, and what they said back.

   Their API is write-only: there is no route that answers "what does buzz
   8429 hold". So their response to the POST is the ONLY record of what they
   accepted, and it lived nowhere but a console line that Railway rotates away
   within days. When a story turned up on the app without its video there was
   no way to tell, after the fact, whether the clip had been forwarded and
   dropped or never forwarded at all — the two failures look identical from
   here once the log is gone.

   Stored per publish: the parts we sent (field name, type, byte count) beside
   their verbatim answer. That pair is what separates "they refused the media"
   from "we never sent it". */
alter table pix_posts add column if not exists published_response jsonb;
/* The finished cards, on OUR bucket, for the website.

   DailyMattr stores what we send it in a private S3 bucket that nothing
   outside their app can read, so the website (dailymattr.com/news) had no
   picture of a story except the raw background it was built on. At publish
   the cards are copied to the public pix-media bucket as well, and this holds
   them: [{ url, width, height, sort_order, bytes, type }], poster first. Null
   for every story published before this existed — the site falls back to the
   background picture for those. */
alter table pix_posts add column if not exists web_pages jsonb;
alter table pix_posts add column if not exists rejected_at       timestamptz;
alter table pix_posts add column if not exists rejected_by       text;
alter table pix_posts add column if not exists rejected_by_name  text;

/* Where the story is filed on the DailyMattr side. Chosen by the writer while
   they build the poster and confirmed by QA at publish, so the person with the
   context picks the section rather than QA guessing at review time. Plain
   integers, not a foreign key: the values live in DailyMattr's system, and
   mirroring their table here would only rot.

   The analytics category filter groups on category_id for the same reason: the
   id is what the writer actually chose, so it cannot drift from the name
   DailyMattr shows the way a stored copy of the name would. */
alter table pix_posts add column if not exists category_id  integer;
alter table pix_posts add column if not exists state_id     integer;

/* The publish ledger. Until these existed nothing anywhere recorded that a
   story had gone out, so the same row could be pushed to DailyMattr an
   unlimited number of times — and their integration API is write-only, with no
   delete and no way to look a submission up, so every extra copy had to be
   removed by hand from their portal.

   Three columns, and the distinction between them is the whole point:

     published_at  the CLAIM. Set by claimPublish() before anything leaves this
                   server, so the guard is a conditional UPDATE rather than a
                   read-then-decide — two requests cannot both find it null.
     published_id  the RECEIPT. DailyMattr's buzz id, written only after they
                   answered. Null beside a non-null published_at means a
                   publish was started and never confirmed: the story may or
                   may not be live, which is a state QA has to be told about
                   rather than allowed to resolve by retrying.
     published_by  who claimed it.

   All three default null, so every row that already exists reads as never
   published and nothing in the queue moves when this migration runs. */
alter table pix_posts add column if not exists published_at  timestamptz;
alter table pix_posts add column if not exists published_id  text;
alter table pix_posts add column if not exists published_by  text;

create index if not exists pix_posts_created_at_idx on pix_posts (created_at desc);
create index if not exists pix_posts_category_idx on pix_posts (category_id);
create index if not exists pix_posts_approved_idx on pix_posts (approved, updated_at desc);
create index if not exists pix_posts_rejected_idx on pix_posts (rejected, updated_at desc);
create index if not exists pix_posts_source_url_idx on pix_posts (source_url);
create index if not exists pix_posts_user_idx on pix_posts (user_login_id, created_at desc);
`;

export function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = getPool().query(SCHEMA_SQL).then(
    () => true,
    (err) => {
      // Do not memoise a failure: a transient network error at boot would
      // otherwise poison every later request for the life of the process.
      schemaReady = null;
      throw err;
    }
  );
  return schemaReady;
}

/* ── Columns ──
   The write path is generated from this list so adding a field means touching
   one place. `json: true` columns are stringified before binding.

   Workflow columns are deliberately absent: approved/rejected belong to
   setApproval and published_at/published_id/published_by to claimPublish, so
   an ordinary save — including an autosave the writer never asked for — can
   never withdraw a verdict or clear the record of a story that is already
   live. Adding one of them here would hand that power to the editor. */
const COLUMNS = [
  "user_login_id", "user_name",
  "source_url", "scraped_title", "article_text", "detail_text", "image_query", "source_image_url",
  "ai_headline", { name: "ai_bullets", json: true }, "ai_tweet", { name: "ai_flags", json: true },
  "headline", "detail_body", "main_image_url", "main_image_source",
  "aspect_ratio", "accent_color", "tag",
  "category_id", "state_id", "is_draft",
  { name: "design", json: true },
];

function bindable(col, value) {
  if (typeof col === "string") return value === undefined ? undefined : value;
  return value === undefined ? undefined : JSON.stringify(value ?? null);
}

/**
 * Insert a pix, or update the one with `id`. Only keys present in `fields`
 * are written, so a field the editor could not supply this time never blanks
 * out what is already stored.
 *
 * `ownerId` scopes an update to one user's rows — passed for writers, left
 * null for QA, who may edit anyone's post.
 *
 * `requireOpen` refuses the write when the post's review is settled — approved,
 * or already pushed to DailyMattr. Passed for writers, because for them there
 * is no way back: QA signed off on a version, DailyMattr has that version and
 * its API has no edit, so a later rewrite leaves the row reading "approved by
 * <QA>" over text no reviewer ever saw and the library disagreeing with the
 * public site. Enforced in the same WHERE clause as ownership, and for the same
 * reason — reading the row first and then deciding leaves a window in which the
 * approval lands between the two queries.
 *
 * Only a save with NO `id` can insert. When an `id` is supplied and matches
 * nothing this throws — `PIX_FORBIDDEN` if the row is someone else's,
 * `PIX_SETTLED` if it is approved or published, `PIX_STALE_ID` if it is gone —
 * so a caller holding a stale id is told so rather than handed a second,
 * authorless copy of the post.
 */
export async function savePix(id, fields = {}, { ownerId = null, requireOpen = false } = {}) {
  await ensureSchema();

  const names = [];
  const values = [];
  for (const col of COLUMNS) {
    const name = typeof col === "string" ? col : col.name;
    const bound = bindable(col, fields[name]);
    if (bound === undefined) continue;
    names.push(name);
    values.push(bound);
  }

  if (id) {
    const sets = names.map((n, i) => `${n} = $${i + 2}`);
    sets.push("updated_at = now()");
    // Ownership is enforced in the WHERE clause, not by reading the row first
    // and deciding: a check-then-write leaves a window where the row changes
    // hands between the two queries.
    const params = [id, ...values];
    let ownership = "";
    if (ownerId) {
      params.push(ownerId);
      ownership = ` and user_login_id = $${params.length}`;
    }
    // No placeholders, so it costs nothing to append; the probe below is what
    // turns a zero-row result into the right message.
    const settled = requireOpen ? " and approved = false and published_at is null" : "";
    const { rows } = await getPool().query(
      `update pix_posts set ${sets.join(", ")} where id = $1${ownership}${settled} returning id, created_at, updated_at, is_draft`,
      params
    );
    if (rows[0]) return rows[0];

    /* No row updated: the id is stale, the row belongs to someone else, or —
       with requireOpen — its review is settled. All three are errors, and this
       branch must end in one — an id was supplied,
       so the caller is editing a row that is supposed to exist already. It is
       never an instruction to create one.

       Falling through to the INSERT below is what used to happen, and it made
       a row nobody could work with. handleSave() strips user_login_id and
       user_name whenever an id is present (pix-api.js), because an id is
       supposed to mean UPDATE — so the created row had a NULL author, showed
       in QA's queue as "Unknown writer", counted towards nobody's tally, and
       could never be scoped to a writer again. The client then adopted the new
       id, and every later autosave failed the ownership clause and 403'd, so
       the writer typed on into a post that could not be saved. Worse for a
       post QA had deliberately deleted or rejected: approved/rejected are not
       in COLUMNS, so the resurrected copy came back default-false and re-
       entered the review queue on its way to an irreversible publish.

       The probe runs unconditionally. It used to be inside `if (ownerId)`,
       which meant reviewers — ownerId is null for QA and admin — skipped
       straight past it into the INSERT, so the one role that can delete was
       also the role the fall-through hit silently. */
    const { rows: existing } = await getPool().query(
      "select id, user_login_id, approved, published_at from pix_posts where id = $1",
      [id]
    );
    if (!existing[0]) {
      const err = new Error("This post no longer exists.");
      err.code = "PIX_STALE_ID";
      throw err;
    }
    /* Ownership is answered first: "that is not your post" is the more
       fundamental refusal, and telling a writer their colleague's post is
       "already approved" would confirm a row they are not entitled to know
       about. */
    if (ownerId && existing[0].user_login_id !== ownerId) {
      const err = new Error("This post belongs to someone else.");
      err.code = "PIX_FORBIDDEN";
      throw err;
    }
    if (requireOpen && (existing[0].approved || existing[0].published_at)) {
      const err = new Error(
        existing[0].published_at
          ? "This post is already published — ask QA to take it back before editing."
          : "This post has been approved — ask QA to reopen it before editing."
      );
      err.code = "PIX_SETTLED";
      throw err;
    }
    /* Nothing above explains it, so the row changed between the UPDATE and this
       read — a verdict landing in that window, most likely. Given its own code
       rather than borrowed from PIX_FORBIDDEN, whose message names another
       writer and would be a plain lie here. */
    const err = new Error("This post changed while it was being saved — reload it and try again.");
    err.code = "PIX_CONFLICT";
    throw err;
  }

  const placeholders = names.map((_, i) => `$${i + 1}`);
  const { rows } = await getPool().query(
    `insert into pix_posts (${names.join(", ")}) values (${placeholders.join(", ")})
     returning id, created_at, updated_at, is_draft`,
    values
  );
  return rows[0];
}

/* "Handed over": either the draft flag is off, or a verdict proves it was once
   handed over anyway. The second half is for rows that predate setApproval
   clearing is_draft — an approved, published story that still carries the flag
   would otherwise be invisible in every list AND uncounted in every rollup
   while sitting on the public site.

   One definition, used by the queue in listPix and by the analytics counts
   below, because the bug they came from was the two disagreeing: the dashboard
   read "12 pending" beside a list of 7 rows, since only listPix knew drafts
   existed. Anything that changes what "sent" means has to change both. */
const SUBMITTED_SQL = "(is_draft = false or approved = true or rejected = true)";

/* List view. article_text is the biggest column by far and nothing in a list
   needs it, so it is left out and only its length reported.

   `userLoginId` is the filter — whose posts to list — and `viewerId` is the
   session asking. They are separate because a reviewer sets the first freely
   (the Writers screen lists one author with ?user=<id>) while the second is
   the only identity a draft is ever revealed to. */
export async function listPix({ limit = 50, offset = 0, userLoginId = null, reviewedBy = null, viewerId = null, status = null, search = "", from = null, to = null } = {}) {
  await ensureSchema();
  const params = [Math.min(Number(limit) || 50, 200), Number(offset) || 0];
  const clauses = [];
  if (userLoginId) {
    params.push(userLoginId);
    clauses.push(`user_login_id = $${params.length}`);
  }

  /* Who DECIDED a post, as opposed to who wrote it. Without this the Writers
     screen had only one question it could ask about a person — what have they
     authored — so opening a QA account asked for their posts, got none, and
     told an admin that a reviewer with hundreds of verdicts to their name had
     never done anything. Publishing is in the OR because it is its own act:
     approving clears a post, publishing is what sends it out, and a reviewer
     who only ever pressed Publish is still someone who worked on it. */
  if (reviewedBy) {
    params.push(reviewedBy);
    const p = `$${params.length}`;
    clauses.push(`(approved_by = ${p} or rejected_by = ${p} or published_by = ${p})`);
  }
  // "awaiting" is the absence of both verdicts, not simply `not approved` —
  // that older reading swept rejected posts back into the review queue.
  /* A draft belongs to the person who wrote it and to nobody else.

     The editor tells the writer "QA cannot see it until you press Submit", and
     that sentence was false in both directions. The drafts filter carried no
     ownership condition at all, so QA's Drafts tab returned every writer's
     unfinished work — readable, editable, and one Publish away from an
     irreversible push to DailyMattr. Meanwhile the writer's own list excluded
     drafts unconditionally, so the one role the feature is for could not find
     what it had saved.

     Both halves are the same rule: `viewerId` is the only identity a draft is
     ever shown to, whatever the role. Scoping on `userLoginId` instead would
     not have fixed it — a reviewer sets that freely with ?user=<id>. */
  const own = () => {
    params.push(viewerId);
    return `user_login_id = $${params.length}`;
  };

  /* Several statuses at once ("awaiting,rejected") are OR'd: each keeps the
     exact condition it has as a single tab, so ticking two never lists a row
     that neither tab would have listed on its own. A lone status takes the
     single-tab path below unchanged. */
  const statuses = [...new Set((Array.isArray(status) ? status : [status]).filter(Boolean))];
  if (statuses.length > 1) {
    const STATUS_SQL = {
      approved: "approved = true",
      rejected: "rejected = true",
      awaiting: `${SUBMITTED_SQL} and approved = false and rejected = false`,
      published: `${SUBMITTED_SQL} and published_at is not null`,
    };
    const ors = statuses.map((s) => {
      if (s === "drafts") return viewerId ? `(is_draft = true and ${own()})` : "false";
      return STATUS_SQL[s] ? `(${STATUS_SQL[s]})` : "false";
    });
    clauses.push(`(${ors.join(" or ")})`);
    status = null;
  } else {
    status = statuses[0] || null;
  }
  const multi = statuses.length > 1;

  if (multi) {
    // Handled above.
  } else if (status === "drafts") {
    // No session to compare against means no drafts — never everybody's.
    clauses.push(viewerId ? `is_draft = true and ${own()}` : "false");
  } else if (!status && viewerId) {
    /* "All", read by the author: their own drafts belong in it. Only here —
       awaiting, approved and rejected are the queue's states, and a draft has
       not entered the queue, so listing one under them would say it is with QA
       when QA cannot see it. */
    clauses.push(`(${SUBMITTED_SQL} or ${own()})`);
  } else {
    /* "Still a draft" is the exclusion, not "was saved as one" — see
       SUBMITTED_SQL: a row with a verdict has left the drafts stage by
       definition, and hiding an already-published one would leave QA no way to
       see that it went out.

       The old `status !== "all-including-drafts"` escape hatch is gone with
       this branch. parseStatusFilter never produced that string, so it was
       dead: the "give the author their drafts back" case it was written for is
       the branch above, decided on the session rather than on a sentinel the
       client would have had to send. */
    clauses.push(SUBMITTED_SQL);
  }

  if (status === "approved") clauses.push("approved = true");
  else if (status === "rejected") clauses.push("rejected = true");
  else if (status === "awaiting") clauses.push("approved = false and rejected = false");
  /* Published is not a verdict, which is why it is not folded into the three
     above: publishing auto-approves, so every published post is ALSO approved
     and was indistinguishable in a list of them. That is the whole reason it
     needed its own filter — after sending a story out there was no way to find
     it again except by scrolling the Approved tab and guessing, and a
     correction has to start by reopening the exact post that went out.

     `published_at`, not `published_id`: the claim is what says a post left the
     building. A row holding the claim with no id is the unconfirmed case, and
     hiding it here would drop the one post QA most needs to see. */
  else if (status === "published") clauses.push("published_at is not null");

  /* Search runs in SQL rather than over the fetched rows, because the list is
     capped at 100: a client-side filter would only ever search the first page
     and quietly miss everything older. Matching here also reaches columns the
     list does not select — ai_headline and scraped_title sit inside a
     coalesce, so a post whose headline was edited is still findable by the
     title it was scraped under.

     %, _ and \ are escaped so a headline containing them is matched
     literally instead of behaving as a wildcard. */
  const term = String(search || "").trim().slice(0, 120);
  if (term) {
    params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    clauses.push(
      `(headline ilike ${p} or ai_headline ilike ${p} or scraped_title ilike ${p}` +
      ` or user_name ilike ${p} or source_url ilike ${p} or tag ilike ${p})`
    );
  }

  /* Date range filters on the same clock the list sorts by (and each row
     prints), so "published on the 3rd" on the Published tab means exactly
     that. `from` is inclusive, `to` exclusive; the client sends the bounds of
     the reader's local days as instants, so no timezone is guessed here. */
  const DATE_COLUMN = {
    published: "published_at",
    approved: "approved_at",
    rejected: "rejected_at",
    awaiting: "updated_at",
    drafts: "updated_at",
  };
  const dateColumn = DATE_COLUMN[status] || "created_at";
  for (const [bound, op] of [[from, ">="], [to, "<"]]) {
    if (!bound) continue;
    const at = new Date(bound);
    if (Number.isNaN(at.getTime())) continue;
    params.push(at.toISOString());
    clauses.push(`${dateColumn} ${op} $${params.length}`);
  }

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";

  /* A list is ordered by the time of the thing it is a list OF.

     Every tab used to be `created_at desc`, which is when the post was
     WRITTEN. For a queue of new work that is right; for a history of what has
     happened to it, it is the wrong clock entirely. Measured against the live
     library: of 177 published posts, 114 sat in the wrong position under
     created_at and one was 32 rows from where it belonged — publish an old
     draft today and it lands in the middle of last month, which is exactly
     where nobody looks for the thing they have just done.

     Each verdict tab therefore sorts by its own timestamp. All stays on
     created_at: it is the one list that is not a history of anything in
     particular, and sorting it by last activity made it reorder under the
     reader — approve a post and it jumps to the top, so the row you were
     about to reach has moved. A list you work down has to hold still.

     `nulls last` carries the rows that predate their own timestamp column —
     posts approved before approved_at existed, publishes made before the
     ledger did. They are real entries and belong at the END of a history; a
     bare `desc` puts nulls at the front, which is the one place they must
     not be. */
  const ORDER_BY = {
    published: "published_at desc nulls last, created_at desc",
    approved: "approved_at desc nulls last, created_at desc",
    rejected: "rejected_at desc nulls last, created_at desc",
    /* Not histories but workbenches — lists of what is in hand right now — so
       the useful clock is when the post was last touched. It also floats a
       writer's correction of a rejected post back to the top, which is the one
       thing QA is actually waiting on. */
    awaiting: "updated_at desc",
    drafts: "updated_at desc",
  };
  const orderBy = ORDER_BY[status] || "created_at desc";

  const { rows } = await getPool().query(
    `select id, created_at, updated_at, user_login_id, user_name, source_url,
            coalesce(headline, ai_headline, scraped_title) as headline,
            main_image_url, aspect_ratio, accent_color, tag,
            category_id, state_id,
            jsonb_array_length(ai_bullets) as bullet_count,
            length(coalesce(article_text, '')) as article_chars,
            approved, approved_at, approved_by_name,
            rejected, rejected_at, rejected_by_name,
            is_draft,
            /* The publish record. Absent from this list until now, so a row
               that was live on DailyMattr was drawn identically to one that
               had merely been approved — the list could not say which posts
               had gone out, and published_history (the ids of the copies still
               up, which a correction has to name so somebody can delete them)
               was readable nowhere in the app at all. */
            published_at, published_id, published_history
       from pix_posts ${where}
      order by ${orderBy}
      limit $1 offset $2`,
    params
  );
  return rows;
}

/* Category sentinel for posts filed before the writer picked a section, or
   saved while the DailyMattr list was unreachable. A string, so it can never
   collide with a real category_id. */
export const UNCATEGORISED = "__none__";

export async function getPixAnalytics({
  role = "writer",
  // "full" builds the per-writer roster and the reviewer league table;
  // "basic" skips both. QA gets the state of the queue, an admin gets the
  // reporting about who produced it.
  scope = "full",
  userLoginId = null,
  approverId = null,
  from = null,
  to = null,
  category = null,
  source = null,
} = {}) {
  await ensureSchema();

  /* One filter set shared by every rollup below: the role scope, the QA-chosen
     date range, and the category. Built with running placeholder numbers so a
     query can append its own params afterwards without renumbering. */
  const clauses = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };

  /* Only a writer is scoped to their own rows. Written as "not a reviewer"
     rather than "not qa": with the literal string, adding the admin role
     silently pinned every admin rollup to user_login_id = null, which matches
     no row at all — the whole dashboard read zero while the data was fine.

     Not imported from auth.js on purpose: auth.js imports this module, and
     the cycle would leave one of them half-initialised at load. */
  const scopedToSelf = role !== "qa" && role !== "admin";
  if (scopedToSelf) add("user_login_id = $?", userLoginId);
  if (from) add("created_at >= $?::date", from);
  // Inclusive of the whole end day — a range of 1st→1st has to return the 1st.
  if (to) add("created_at < ($?::date + interval '1 day')", to);
  if (category === UNCATEGORISED) clauses.push("category_id is null");
  else if (category) add("category_id = $?", Number(category));

  /* Sources are presented as hostnames, not full article URLs. This folds
     http/https, paths, ports and a leading www into one stable source key. */
  const sourceHostSql = `regexp_replace(lower(split_part(split_part(regexp_replace(source_url,
    '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '/', 1), ':', 1)), '^www[.]', '')`;
  const sourceClauses = [...clauses, "source_url is not null", "btrim(source_url) <> ''"];
  const sourceWhere = `where ${sourceClauses.join(" and ")}`;
  const { rows: sourceRows } = await getPool().query(
    `select ${sourceHostSql} as value, count(*)::int as post_count
       from pix_posts
       ${sourceWhere}
      group by 1
     having ${sourceHostSql} <> ''
      order by post_count desc, value asc`,
    params
  );

  if (source) add(`${sourceHostSql} = $?`, source);

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  // For queries that add their own conditions to the same WHERE.
  const and = clauses.length ? `${clauses.join(" and ")} and ` : "";

  /* Daily activity is deliberately independent of the historical date-range
     picker: "Today" must continue to mean the current India calendar day.
     It still follows identity, category and source so those filters remain
     useful across the whole dashboard. */
  const dailyClauses = [];
  const dailyParams = [];
  const addDaily = (sql, value) => {
    dailyParams.push(value);
    dailyClauses.push(sql.replace("$?", `$${dailyParams.length}`));
  };
  if (scopedToSelf) addDaily("user_login_id = $?", userLoginId);
  if (category === UNCATEGORISED) dailyClauses.push("category_id is null");
  else if (category) addDaily("category_id = $?", Number(category));
  if (source) addDaily(`${sourceHostSql} = $?`, source);

  const dailyWhere = dailyClauses.length ? `where ${dailyClauses.join(" and ")}` : "";
  const todayStartSql = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
  const tomorrowStartSql = `(${todayStartSql} + interval '1 day')`;
  /* Drafts are excluded from the counts, never from the shared `clauses`.
     Putting the predicate in `clauses` would also strip drafts out of the
     sources rollup and the reviewer CTE, which answer questions ("where do our
     stories come from", "who decided what") that have nothing to do with queue
     state. What has to match the lists is every figure that says "sent" or
     "pending": those are read side by side with the Review list, and a draft
     has not been sent to anyone. */
  const { rows: dailyRows } = await getPool().query(
    `select count(*) filter (
              where created_at >= ${todayStartSql} and created_at < ${tomorrowStartSql}
                and ${SUBMITTED_SQL}
            )::int as sent_count,
            /* Decisions taken today, on the timestamps alone — deliberately
               not gated on the approved/rejected boolean. This card is a log
               of the day's activity, not a snapshot of current verdicts, so a
               post rejected this morning and approved this afternoon belongs
               in both figures: both calls really were made today. Adding the
               boolean would make the afternoon's approval retroactively erase
               the morning's rejection from the tile. */
            count(*) filter (
              where approved_at >= ${todayStartSql} and approved_at < ${tomorrowStartSql}
            )::int as approved_count,
            count(*) filter (
              where rejected_at >= ${todayStartSql} and rejected_at < ${tomorrowStartSql}
            )::int as rejected_count,
            count(*) filter (
              where created_at >= ${todayStartSql} and created_at < ${tomorrowStartSql}
                and not approved and not rejected and ${SUBMITTED_SQL}
            )::int as pending_count,
            to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') as day_key,
            ${tomorrowStartSql} as next_reset_at
       from pix_posts
       ${dailyWhere}`,
    dailyParams
  );

  const summaryParams = [...params, approverId || userLoginId || null];
  const meIndex = summaryParams.length;
  const { rows: summaryRows } = await getPool().query(
    /* Same rule as the daily card: "sent" and "pending" are the queue's own
       words, so they count what the queue holds. approved/rejected need no
       predicate — a verdict implies the post was handed over — and the
       approval RATE has to divide by the same population it counts, or drafts
       silently drag it down. */
    `select count(*) filter (where ${SUBMITTED_SQL})::int as sent_count,
            count(*) filter (where approved)::int as approved_count,
            count(*) filter (where rejected)::int as rejected_count,
            count(*) filter (where not approved and not rejected and ${SUBMITTED_SQL})::int as pending_count,
            round(coalesce((count(*) filter (where approved)) * 100.0 / nullif(count(*) filter (where ${SUBMITTED_SQL}), 0), 0))::int as approval_rate,
            round(coalesce(extract(epoch from avg(case when approved_at is not null then approved_at - created_at end)) / 3600.0, 0)::numeric, 1) as avg_approval_hours,
            count(distinct user_login_id) filter (where ${SUBMITTED_SQL})::int as active_writers,
            count(distinct approved_by) filter (where approved_by is not null)::int as active_qas,
            count(*) filter (where approved_by = $${meIndex})::int as approved_by_me_count
       from pix_posts
       ${where}`,
    summaryParams
  );

  let writers = [];
  let qas = [];

  if (scope === "full" && (role === "qa" || role === "admin")) {
    const { rows: writerRows } = await getPool().query(
      /* Every figure on this roster is output — what a writer handed over —
         so every one of them is filtered the same way. The Writers screen
         renders this table directly above a list of the same writer's posts
         fetched from /api/pix, which excludes drafts, so an unfiltered count
         here put two different totals for one person on one screen.

         The HAVING keeps a writer who has only ever saved drafts off the board
         rather than listing them with a row of zeros: they have not published
         anything to report on, and their unfinished work is nobody else's
         business. */
      `select coalesce(nullif(user_name, ''), 'Unknown writer') as user_name,
              user_login_id,
              count(*) filter (where ${SUBMITTED_SQL})::int as sent_count,
              count(*) filter (where approved)::int as approved_count,
              count(*) filter (where rejected)::int as rejected_count,
              count(*) filter (where not approved and not rejected and ${SUBMITTED_SQL})::int as pending_count,
              round(coalesce((count(*) filter (where approved)) * 100.0 / nullif(count(*) filter (where ${SUBMITTED_SQL}), 0), 0))::int as approval_rate,
              count(*) filter (
                where created_at >= ${todayStartSql} and created_at < ${tomorrowStartSql}
                  and ${SUBMITTED_SQL}
              )::int as today_count,
              -- Output over the last seven days, which is the figure anyone
              -- actually asks for: a lifetime total says who has been here
              -- longest, not who is producing now.
              count(*) filter (where created_at >= now() - interval '7 days'
                                 and ${SUBMITTED_SQL})::int as week_count,
              count(*) filter (where created_at >= now() - interval '14 days'
                                 and created_at <  now() - interval '7 days'
                                 and ${SUBMITTED_SQL})::int as prev_week_count,
              max(created_at) filter (where ${SUBMITTED_SQL}) as last_post_at
         from pix_posts
         ${where}
        group by user_login_id, user_name
       having count(*) filter (where ${SUBMITTED_SQL}) > 0
        order by sent_count desc, approved_count desc, last_post_at desc
        /* Everyone, not a top ten. This is two lists in one payload: the
           Analytics roster, which shows a leaderboard and slices to ten
           itself, and the Writers screen, which merges these counts into a
           roster of every account by id. A ten-row cap served the first and
           broke the second — a writer in eleventh place was indistinguishable
           from one who had never written, and read "no posts yet" next to
           twenty-two posts. The cap stays high enough to bound a runaway
           payload and nothing more. */
        limit 200`,
      params
    );
    writers = writerRows;

    const { rows: qaRows } = await getPool().query(
      /* Both verdicts, folded into one row per reviewer. A union rather than a
         filter over pix_posts because a reviewer who has only ever rejected
         still belongs on this list, and grouping by approved_by alone would
         drop them.

         Keyed on the attribution column, not on the `approved`/`rejected`
         boolean. The boolean is the post's CURRENT verdict, so keying on it
         credited only whoever decided last: a rejection later overturned by a
         second reviewer stopped counting the moment it was overturned, and the
         first reviewer's row silently shrank. setApproval now keeps both
         attributions, and this is the query that has to read them for that to
         mean anything. A withdrawn verdict still counts here, which is
         deliberate and matches getUserPixCounts — the reviewer did read the
         post and did make a call. */
      `with decisions as (
         select approved_by as user_login_id, approved_by_name as user_name,
                'approved' as decision, approved_at as decided_at
           from pix_posts
          where ${and}approved_by is not null
         union all
         select rejected_by, rejected_by_name, 'rejected', rejected_at
           from pix_posts
          where ${and}rejected_by is not null
         union all
         /* Publishing, as its own decision. Approving and publishing are not
            the same act — a reviewer can clear a dozen posts and send none of
            them — and until the ledger existed there was no way to tell them
            apart, because publishing auto-approved and left only the approval
            behind. This counts what the ledger has actually seen, so it is
            right from the ledger forward and silent about everything before
            it, rather than inferring publishes from approvals. */
         /* The name is taken only when the publisher IS the approver. There is
            no published_by_name column, and borrowing approved_by_name
            unconditionally labelled the row with whoever had cleared the post
            rather than whoever sent it: a reviewer whose publishes were all of
            other people's approvals appeared on this board under a colleague's
            name. Null here instead, and let max(user_name) below take the name
            from that reviewer's own approve/reject rows. */
         select published_by,
                case when published_by = approved_by then approved_by_name end,
                'published', published_at
           from pix_posts
          where ${and}published_at is not null and published_by is not null
       )
       /* Grouped by identity alone, with the name picked per group: a reviewer
          who has since been renamed is still one person, and grouping on the
          name as well would split their record in two. */
       select coalesce(nullif(max(user_name), ''), 'Unknown QA') as user_name,
              user_login_id,
              count(*) filter (where decision = 'published')::int as published_count,
              count(*) filter (where decision = 'approved')::int as approved_count,
              count(*) filter (where decision = 'rejected')::int as rejected_count,
              count(*) filter (
                where decided_at >= ${todayStartSql} and decided_at < ${tomorrowStartSql}
              )::int as today_count,
              /* Weekly, the same as the writer roster. Without these the QA
                 table rendered "undefined" where the writers table showed a
                 number — the two lists are read side by side and have to
                 answer the same question. */
              count(*) filter (where decided_at >= now() - interval '7 days')::int as week_count,
              count(*) filter (where decided_at >= now() - interval '14 days'
                                 and decided_at <  now() - interval '7 days')::int as prev_week_count,
              max(decided_at) filter (where decision = 'approved') as latest_approval_at,
              max(decided_at) as latest_decision_at
         from decisions
        group by user_login_id
        order by approved_count desc, rejected_count desc, latest_decision_at desc
        -- Same reasoning as the writer roster above: capped to bound the
        -- payload, not to make a top ten.
        limit 200`,
      params
    );
    qas = qaRows;
  }

  /* Recent posts with their author.

     The leaderboards answer "who is producing" but nothing here answered
     "who wrote THAT one" — the payload carried no post rows at all, so a
     content item on the analytics screen had nothing to click through to.
     This is the per-item view: same coalesce as the review list so an edited
     headline still shows, and the author fields the boards only ever used as
     GROUP BY keys.

     Drafts are left out of it. This panel is not a table of numbers: each row
     is a button that opens the post in the reviewer's editor, so listing a
     draft here handed every QA and admin a click-through to a writer's
     unfinished work — headline, author, source and thumbnail — with no filter
     or URL trick involved, and labelled "Pending", which asserts QA is waiting
     on something the writer has not handed in. Analytics is only ever read by
     qa and admin (pix-analytics.js gates it), so there is no author case to
     preserve here; the author reads their drafts in My posts. */
  const recentWhere = `where ${[...clauses, SUBMITTED_SQL].join(" and ")}`;
  const { rows: recentRows } = await getPool().query(
    `select id,
            created_at,
            coalesce(headline, ai_headline, scraped_title) as headline,
            coalesce(nullif(user_name, ''), 'Unknown writer') as user_name,
            user_login_id,
            source_url,
            main_image_url,
            approved,
            approved_at,
            approved_by_name
       from pix_posts
      ${recentWhere}
      order by created_at desc
      limit 30`,
    params
  );

  return {
    recent: recentRows,
    summary: summaryRows[0] || {
      sent_count: 0,
      approved_count: 0,
      rejected_count: 0,
      pending_count: 0,
      approval_rate: 0,
      avg_approval_hours: 0,
      active_writers: 0,
      active_qas: 0,
      approved_by_me_count: 0,
    },
    writers,
    qas,
    sources: sourceRows,
    daily: {
      ...(dailyRows[0] || {
        sent_count: 0,
        approved_count: 0,
        rejected_count: 0,
        pending_count: 0,
        day_key: null,
        next_reset_at: null,
      }),
      timezone: "Asia/Kolkata",
    },
  };
}

export async function getPix(id) {
  await ensureSchema();
  const { rows } = await getPool().query("select * from pix_posts where id = $1", [id]);
  return rows[0] || null;
}

/**
 * QA sign-off. Separate from savePix because approving is not editing: it
 * must not touch a single field of the post itself, and it is the one write
 * a writer can never perform.
 */
/* One person's own tally, for the header chip every role can see.

   Deliberately not part of getPixAnalytics: that is management reporting and
   is gated to QA and admins, whereas this is a writer's own count of their own
   work and has to be readable by the writer. Both numbers are computed for
   everyone and the caller shows whichever fits the role — a reviewer who also
   writes gets a truthful answer to either question.

   "Today" is the IST day, matching the roster and the daily card. The database
   runs in UTC, so date_trunc('day', now()) is midnight UTC — 5:30am in Delhi.
   Between midnight and 5:30 the header chip was counting the previous day's
   work as today's while analytics, which already handled this, disagreed.
   Two numbers for the same question on the same screen.

   "Week" is the trailing seven days rather than a calendar week, matching the
   roster counts elsewhere, so the two never disagree on a Monday. */
export async function getUserPixCounts(userId) {
  await ensureSchema();
  const id = String(userId || "");
  const { rows } = await getPool().query(
    /* "Written" means handed over, so drafts are out — the chip sits in the
       header above the same person's list of posts and the two have to agree.
       Counting drafts made the chip read one higher than anything the writer
       could point at, and for a reviewer it inflated the queue they were
       looking at with work nobody had sent them.

       The reviewed_* filters need no such predicate: a verdict can only be
       given to a post that was submitted. */
    `select
       count(*) filter (where user_login_id = $1 and ${SUBMITTED_SQL}
                          and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata')
                                             at time zone 'Asia/Kolkata'))::int as written_today,
       count(*) filter (where user_login_id = $1 and ${SUBMITTED_SQL})::int as written_total,
       count(*) filter (where user_login_id = $1 and ${SUBMITTED_SQL}
                          and created_at >= now() - interval '7 days')::int as written_week,
       /* "When did I decide this one" — each timestamp is taken only if the
          matching attribution is mine. A plain greatest(approved_at,
          rejected_at) was safe only while setApproval nulled the losing
          verdict; now that both survive, a post I rejected on Monday and
          somebody else approved today would read as work I did today. */
       /* Published, from the ledger — the only record of who actually sent a
          story to the public site.

          It begins where published_by does, which is later than this app: for
          most of its life publishing auto-approved and left no separate mark,
          so anything from before the ledger counts as reviewed and not as
          published. Today and this week are therefore accurate; an all-time
          published total is not, and the UI has to say which is which rather
          than present a short number as a complete one. */
       count(*) filter (where published_by = $1
                          and published_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata')
                                               at time zone 'Asia/Kolkata'))::int as published_today,
       count(*) filter (where published_by = $1
                          and published_at >= now() - interval '7 days')::int as published_week,
       count(*) filter (where published_by = $1)::int as published_total,
       count(*) filter (where (approved_by = $1 or rejected_by = $1)
                          and greatest(coalesce(case when approved_by = $1 then approved_at end, 'epoch'::timestamptz),
                                       coalesce(case when rejected_by = $1 then rejected_at end, 'epoch'::timestamptz))
                              >= (date_trunc('day', now() at time zone 'Asia/Kolkata')
                                  at time zone 'Asia/Kolkata'))::int as reviewed_today,
       count(*) filter (where approved_by = $1 or rejected_by = $1)::int as reviewed_total,
       count(*) filter (where (approved_by = $1 or rejected_by = $1)
                          and greatest(coalesce(case when approved_by = $1 then approved_at end, 'epoch'::timestamptz),
                                       coalesce(case when rejected_by = $1 then rejected_at end, 'epoch'::timestamptz))
                              >= now() - interval '7 days')::int as reviewed_week
     from pix_posts`,
    [id]
  );
  return rows[0] || { written_today: 0, written_week: 0, written_total: 0,
                      reviewed_today: 0, reviewed_week: 0, reviewed_total: 0,
                      published_today: 0, published_week: 0, published_total: 0 };
}

export async function setApproval(id, { approved, rejected = false, byId = null, byName = null }) {
  await ensureSchema();
  /* Approving and rejecting are opposite verdicts on the same post, so setting
     one always clears the other. Clearing both is how a post goes back to
     awaiting review — the state it starts in.

     That mutual exclusion lives entirely in the two BOOLEANS, and they are the
     only thing the queue reads: listPix filters on `approved` / `rejected`
     above, so every status tab behaves exactly as before.

     The attribution columns are not part of that state. They record the last
     time this post was approved or rejected and by whom, so they are written
     when their verdict is set and never cleared — note the `else <column>`
     below, which is the whole change. Nulling the loser meant QA-B approving a
     post QA-A had rejected on Monday deleted A's name, A's timestamp and A's
     credit for the review: A's tally dropped overnight, A vanished from the
     reviewer leaderboard for a decision they did make, and — on a system whose
     publish step cannot be undone — the row kept no evidence at all that the
     article had once been turned down. Carrying a superseded verdict beside
     the current one is the far cheaper of the two errors. */
  /* Approval resolves a draft, and only approval does.
     Publishing auto-approves, so QA publishing straight from the Drafts tab
     used to leave the row approved AND is_draft — and every reviewer status in
     listPix excludes drafts, so a live article was absent from All, Awaiting,
     Approved and Rejected at once. It existed on the public site and nowhere in
     the review UI.

     Written as a CASE rather than a flat `is_draft = false` because this is
     also the withdraw-verdict route ({approved:false, rejected:false}) and the
     row-level Reject button, which QA can press on a writer's unfinished draft.
     Clearing the flag there would be a one-way door: savePixToLibrary only
     honours asDraft when the post is already a draft, so nothing in the UI can
     put it back. Rejecting or withdrawing leaves the draft a draft. */
  const isApproved = Boolean(approved);
  const isRejected = !isApproved && Boolean(rejected);
  const { rows } = await getPool().query(
    `update pix_posts
        set approved = $2,
            approved_at = case when $2 then now() else approved_at end,
            approved_by = case when $2 then $4 else approved_by end,
            approved_by_name = case when $2 then $5 else approved_by_name end,
            is_draft = case when $2 then false else is_draft end,
            rejected = $3,
            rejected_at = case when $3 then now() else rejected_at end,
            rejected_by = case when $3 then $4 else rejected_by end,
            rejected_by_name = case when $3 then $5 else rejected_by_name end
      where id = $1
      returning id, approved, approved_at, approved_by_name,
                rejected, rejected_at, rejected_by_name`,
    [id, isApproved, isRejected, byId, byName]
  );
  return rows[0] || null;
}

/**
 * A rejected post, corrected by its author and handed back to the queue.
 *
 * QA's reject dialog promises "It goes back to the writer as rejected. They can
 * edit it and it returns to the queue", and nothing performed the second half:
 * `rejected` is written only by setApproval, which writers cannot call, so a
 * corrected article stayed parked under Rejected — the tab QA treats as
 * finished — and was never re-read. The awaiting filter is `approved = false
 * and rejected = false`, so clearing the boolean is the whole return trip.
 *
 * Only the boolean. rejected_at, rejected_by and rejected_by_name stay exactly
 * as they were, on purpose: they are the record that this article was once
 * turned down and by whom, which is the history the verdict columns were
 * separated from the state to preserve. QA reopening the post can still see it
 * came back from a rejection rather than arriving fresh.
 *
 * Scoped to the author in the WHERE clause, and to a row that is actually
 * rejected and actually submitted — a draft has not been handed back to
 * anybody. Answers the row when it moved, null when nothing did, so the caller
 * can tell the writer that their correction is with QA again.
 */
export async function clearRejection(id, { ownerId = null } = {}) {
  await ensureSchema();
  if (!id || !ownerId) return null;
  const { rows } = await getPool().query(
    `update pix_posts
        set rejected = false
      where id = $1 and user_login_id = $2 and rejected = true and is_draft = false
      returning id, rejected, rejected_at, rejected_by_name`,
    [id, ownerId]
  );
  return rows[0] || null;
}

/**
 * Take the exclusive right to publish this post, or refuse.
 *
 * Answers { claimed, row }. On a claim, `row` is the fresh claim. On a refusal
 * `row` is the current post (or null if the id matches nothing) so the caller
 * can say WHY — already published, published-but-unconfirmed, or rejected.
 *
 * The guard is the WHERE clause, not a read followed by a decision. Reading
 * first and branching on what came back is check-then-act: two QA users on the
 * same queue entry, or one QA and one stale browser tab, both see
 * published_at IS NULL and both reach the DailyMattr POST. A conditional
 * UPDATE is settled by the database — exactly one of them gets a row back —
 * and it holds across processes, which matters because this app ships a
 * Dockerfile, railway.json, vercel.json and netlify.toml and may well be
 * running as more than one instance. savePix() already enforces ownership the
 * same way, for the same reason.
 *
 * `rejected = false` is part of the same condition rather than a separate
 * check for the same reason, and because it must be settled BEFORE anything
 * irreversible happens: publishing a rejected post used to be allowed and the
 * auto-approve on the way out erased the rejecting reviewer's name, timestamp
 * and credit, leaving a live story with no record it had ever been turned
 * down. Withdraw the rejection in Review first — that path already exists and
 * records the change.
 */
export async function claimPublish(id, { byId = null, republish = false } = {}) {
  await ensureSchema();

  /* `republish` is a deliberate second send, not a retry.

     The default WHERE refuses any row that already carries a claim, which is
     what stops an accidental double-publish — a reload, a stray click, a
     retry after a timeout. But a story that needs correcting has nowhere else
     to go: DailyMattr cannot edit an entry, so the only way to fix one is to
     publish a corrected copy and have the old one removed by hand over there.
     Refusing that outright would mean a typo on the public site is permanent.

     So the caller may lift the guard, and when it does the current id is
     archived into published_history first — otherwise superseding a story
     would erase the handle for the copy that is still live. Rejected posts
     are still refused either way: a republish is a correction, not a route
     around a verdict. */
  const guard = republish ? "" : " and published_at is null";
  const { rows } = await getPool().query(
    `update pix_posts
        set published_at = now(),
            published_by = $2,
            published_history = case
              when published_id is null then published_history
              else published_history || jsonb_build_array(jsonb_build_object(
                     'id', published_id,
                     'at', to_char(published_at, 'YYYY-MM-DD"T"HH24:MI:SSZ'),
                     'by', published_by))
            end,
            published_id = case when $3 then null else published_id end
      where id = $1${guard} and rejected = false
      returning id, published_at, published_by, published_history`,
    [id, byId, republish]
  );
  if (rows[0]) return { claimed: true, row: rows[0] };

  const { rows: existing } = await getPool().query(
    `select id, published_at, published_id, published_by,
            rejected, rejected_at, rejected_by_name
       from pix_posts where id = $1`,
    [id]
  );
  return { claimed: false, row: existing[0] || null };
}

/**
 * Write DailyMattr's buzz id onto a claim once they have answered.
 *
 * Separate from the claim because it happens on the other side of an
 * irreversible action, and the two must not share a failure mode: the claim
 * has to be committed BEFORE the POST or it guards nothing, and the id cannot
 * exist until after it. A failure here therefore costs the receipt, never the
 * guard — published_at is already stored, so a second publish is still
 * refused; only the handle for finding the story in DailyMattr's portal is
 * missing, which is why the caller logs it loudly rather than swallowing it.
 */
export async function recordPublishedId(id, publishedId, receipt = null) {
  await ensureSchema();
  const { rows } = await getPool().query(
    /* published_history comes back too, so the editor can show which earlier
       copies are still on the public site without a reload. claimPublish() has
       just archived the superseded id into it and this is the first read after
       that, so it is the only cheap moment to hand it over.

       The receipt is written in the same statement as the id it belongs to: a
       second UPDATE could fail on its own and leave a buzz id with no record
       of what produced it, which is the state this column exists to prevent. */
    `update pix_posts
        set published_id = $2,
            published_response = coalesce($3::jsonb, published_response)
      where id = $1
      returning id, published_at, published_id, published_history`,
    [
      id,
      publishedId == null ? null : String(publishedId),
      receipt == null ? null : JSON.stringify(receipt),
    ]
  );
  return rows[0] || null;
}

/* Record where the finished cards were copied for the website.

   Written after the publish receipt, never in the same statement: the copy
   is best-effort and a failure in it must not be able to cost the buzz id.
   Replaces the whole list — a republish renders fresh cards, and the old
   objects stay in the bucket unreferenced rather than risking a live page
   pointing at a deleted file. */
export async function recordWebPages(id, pages) {
  if (!id || !Array.isArray(pages)) return false;
  await ensureSchema();
  const { rowCount } = await getPool().query(
    "update pix_posts set web_pages = $2::jsonb where id = $1",
    [id, JSON.stringify(pages)]
  );
  return rowCount > 0;
}

/* Record an attempt that did NOT produce a buzz id.

   A refusal is a response too, and the one hardest to reconstruct later: the
   post is not live, the log line is gone within days, and the row otherwise
   carries no trace that anyone ever tried. Deliberately does not touch
   published_id or published_at — this is evidence, not a receipt of
   publication. */
export async function recordPublishAttempt(id, receipt) {
  if (!id || receipt == null) return false;
  await ensureSchema();
  const { rowCount } = await getPool().query(
    "update pix_posts set published_response = $2::jsonb where id = $1",
    [id, JSON.stringify(receipt)]
  );
  return rowCount > 0;
}

/**
 * Give the claim back, for a publish that provably never reached DailyMattr.
 *
 * `published_id is null` is a safety catch, not an optimisation: a row that
 * already carries a buzz id is live on the public site, and no failure path
 * may un-publish it. The caller is responsible for the harder half — only
 * release when the attempt DEFINITELY failed. A timeout, a reset connection or
 * an upstream 5xx means DailyMattr may have stored the post anyway, and
 * releasing there would hand QA a Publish button that produces a second live
 * copy of a story nobody can delete.
 */
export async function releasePublishClaim(id) {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `update pix_posts set published_at = null, published_by = null
      where id = $1 and published_id is null`,
    [id]
  );
  return rowCount > 0;
}

export async function deletePix(id, { ownerId = null } = {}) {
  await ensureSchema();
  const { rowCount } = ownerId
    ? await getPool().query("delete from pix_posts where id = $1 and user_login_id = $2", [id, ownerId])
    : await getPool().query("delete from pix_posts where id = $1", [id]);
  return rowCount > 0;
}

export async function closeDb() {
  if (!pool) return;
  const p = pool;
  pool = null;
  schemaReady = null;
  await p.end().catch(() => {});
}
