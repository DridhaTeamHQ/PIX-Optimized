/* ── /api/pix ──
   Transport-free core for the pix library endpoints, so the Node server
   (server.mjs) and the serverless handler (api/pix.js) share one
   implementation instead of drifting apart like the older routes did.

   Every route answers { status, body } and never throws: storage is an
   optional feature of this app, and a database that is down must degrade to
   "not saved" rather than break the editor. */

import { isConfigured, savePix, listPix, getPix, deletePix, setApproval, clearRejection, getUserPixCounts, ping, describeConnectionError } from "./db.js";
import { canReview } from "./auth.js";

/* Caps. A poster is small text; anything far past these is either a runaway
   paste or a data: URL someone tried to smuggle into a text column. */
const LIMITS = {
  article_text: 120_000,
  detail_text: 4_000,
  detail_body: 8_000,
  text: 2_000,
  url: 2_048,
  bullets: 12,
  design: 200_000,   // serialised bytes
};

/* Authorship is deliberately absent: user_login_id and user_name are set from
   the session in handleSave, so a client cannot claim to be someone else. */
const CLIENT_TO_COLUMN = {
  isDraft: "is_draft",
  sourceUrl: "source_url",
  scrapedTitle: "scraped_title",
  articleText: "article_text",
  detailText: "detail_text",
  imageQuery: "image_query",
  sourceImageUrl: "source_image_url",
  aiHeadline: "ai_headline",
  aiBullets: "ai_bullets",
  aiTweet: "ai_tweet",
  aiFlags: "ai_flags",
  headline: "headline",
  detailBody: "detail_body",
  mainImageUrl: "main_image_url",
  mainImageSource: "main_image_source",
  aspectRatio: "aspect_ratio",
  accentColor: "accent_color",
  tag: "tag",
  categoryId: "category_id",
  stateId: "state_id",
  design: "design",
};

/* The two integer columns. Everything else here is text or JSON, so they need
   their own branch in normalise() — running them through clip() would store
   the string "15" in an integer column and Postgres would reject the write. */
const INT_COLUMNS = new Set(["category_id", "state_id"]);

/* The one boolean column a client may set. It needs its own branch for the
   same reason the integers do: clip() stringifies, so `false` was arriving as
   the text "false" and only surviving because Postgres casts it on the way
   into a boolean column. Anything that wanted to READ the value server-side —
   the is_draft downgrade guard in handleSave — saw a string and a truthy one
   at that, which is a trap rather than a working design. */
const BOOL_COLUMNS = new Set(["is_draft"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every route needs a signed-in `user` ({ id, username, role, displayName }).
 * The role decides scope, and it is applied here rather than in the browser:
 *
 *   writer — reads and writes only their own posts
 *   qa     — reads and writes everyone's, and is the only role that can delete
 */
export async function handlePixRequest({ method, path = "/api/pix", query = {}, body = {}, user = null }) {
  if (!isConfigured()) {
    return {
      status: 503,
      body: { error: "No database configured. Set SUPABASE_POOLER_URL to save posts." },
    };
  }
  if (!user) {
    return { status: 401, body: { error: "Sign in to use the post library." } };
  }

  // null = unrestricted (QA). A writer is scoped to rows stamped with their id.
  const ownerId = canReview(user.role) ? null : user.id;

  const cleanPath = String(path || "").replace(/\/+$/, "");
  const approving = cleanPath.endsWith("/approve");
  const counting = cleanPath.endsWith("/stats");

  try {
    /* Deliberately before the role split: this is the signed-in user's own
       tally and every role may read it. Analytics stays QA-and-admin because
       it reports on other people; a writer's own count is not that. */
    if (method === "GET" && counting) {
      const counts = await getUserPixCounts(user.id);
      return { status: 200, body: { counts, role: user.role } };
    }
    if (method === "POST" && approving) return await handleApprove(query.id || body?.id, body, user);
    if (method === "POST") return await handleSave(body, user, ownerId);
    /* `user.id` travels alongside `ownerId` rather than instead of it: ownerId
       is the scope this ROLE is allowed (null for a reviewer, who may read
       anyone's post), while an unsubmitted draft is answerable to one identity
       whatever the role. Two different questions, and collapsing them is what
       let QA read every writer's drafts. */
    if (method === "GET") return query.id ? await handleGetOne(query.id, ownerId, user.id) : await handleList(query, ownerId, user.id);
    if (method === "DELETE") return await handleDelete(query.id || body?.id, user);
    return { status: 405, body: { error: "Method not allowed." } };
  } catch (err) {
    if (err?.code === "PIX_FORBIDDEN") {
      return { status: 403, body: { error: "That post belongs to another writer — only QA can edit it." } };
    }
    /* The row this request was editing is gone — deleted from Review while the
       editor still had it open. 409 rather than 404 because the request itself
       was well-formed and the resource did exist: what changed is the state it
       assumed. The message has to be explicit about the text still on screen,
       because this is terminal for that post — the client cannot retry its way
       out of it, and reloading would take the unsaved work with it. */
    if (err?.code === "PIX_STALE_ID") {
      return {
        status: 409,
        body: { error: "This post no longer exists — it was deleted. Copy your text before reloading." },
      };
    }
    /* The post's review is settled: QA has signed it off, or it is already on
       the public site. 409 rather than 403 — this is not about who is asking
       but about what the post has become, and it is fixable by an action
       (reopening it) rather than permanently barred. The message carries the
       distinction between approved and published, so it is passed through
       rather than replaced with one of ours. */
    if (err?.code === "PIX_SETTLED") {
      return { status: 409, body: { error: err.message, settled: true } };
    }
    if (err?.code === "PIX_CONFLICT") {
      return { status: 409, body: { error: err.message } };
    }
    const message = describeConnectionError(err);
    console.warn("⚠ /api/pix failed:", message);
    return { status: 502, body: { error: message } };
  }
}

async function handleSave(body, user, ownerId) {
  const id = body?.id ? String(body.id) : null;
  if (id && !UUID_RE.test(id)) return { status: 400, body: { error: "Invalid id." } };

  /* A save can hand a post over; it can never take it back.

     `is_draft` arrives straight off the client's `asDraft` intent, and the
     in-editor Save button always sends draft — that is deliberate, so a button
     labelled "Save draft" can never quietly submit. But on a post that has
     ALREADY been handed over it read the other way round and un-submitted it:
     a writer opening a rejected post, fixing it and pressing Save draft flipped
     is_draft back to true, and clearRejection() below requires is_draft = false,
     so the correction never returned to the queue and QA never saw it. The
     writer had done everything right and the post sat under Rejected.

     Dropping the field rather than reading the row first: true is the only
     value that can do harm, and on a row that is genuinely still a draft
     dropping it is a no-op (the column is already true). Withdrawing a
     submission is a verdict change and belongs to QA's Reopen, not to a save. */
  const fields = normalise(body);
  if (id && fields.is_draft === true) delete fields.is_draft;

  if (!canReview(user.role) && !fields.category_id) {
    return { status: 400, body: { error: "Choose a category before saving." } };
  }
  if (!Object.keys(fields).length) {
    return { status: 400, body: { error: "Nothing to save." } };
  }

  // Authorship comes from the session, never from the request body — otherwise
  // any writer could file a post under another account's name.
  if (!id) {
    fields.user_login_id = user.id;
    fields.user_name = user.displayName || user.username;
  } else {
    delete fields.user_login_id;
    delete fields.user_name;
  }

  /* `requireOpen` for the author, not for a reviewer. A writer has no route
     back from an approval — they cannot withdraw a verdict, and DailyMattr's
     API has no edit — so an edit after sign-off silently replaces the text the
     approval stamp still points at. QA keeps the ability to fix an approved
     post because QA is the one who signed it off and the one who can withdraw
     it; locking them out would leave a typo in a live story with nobody able
     to touch it. */
  const row = await savePix(id, fields, { ownerId, requireOpen: Boolean(ownerId) });

  /* A corrected post goes back into the queue. QA's reject dialog says it
     will; until now nothing did, and the article sat under Rejected for ever.
     clearRejection() decides whether this row qualifies (author's own, still
     rejected, not a draft) — see it for what survives the change.

     Deliberately not fired by the background autosave, which is the reason
     `autosave` is on the request at all. Reading "the writer resubmitted" out
     of any save would hand the resubmission to a 2.5s idle timer: opening a
     rejected post and touching one character would push the half-corrected
     article back to QA, which is the same failure the workflow exists to
     avoid — a reviewer reading text that is still being typed. The editor
     also refuses to autosave a writer's non-draft post at all; this half does
     not depend on the client being up to date.

     After the save rather than before, so the return to the queue always
     carries the correction with it: if savePix throws, the post stays
     rejected, which is the truthful state. */
  let resubmitted = false;
  if (id && ownerId && body?.autosave !== true) {
    resubmitted = Boolean(await clearRejection(id, { ownerId }));
  }

  return {
    status: 200,
    body: {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      /* The row's real standing, not the intent that was asked for — the two
         differ whenever the guard above dropped an is_draft downgrade, and the
         client cannot work it out for itself. */
      isDraft: Boolean(row.is_draft),
      // Only ever true when a rejection was actually lifted, so the client can
      // tell the writer their fix is back with QA rather than guessing.
      resubmitted,
      /* `!id` is now the whole test. It used to also allow `row.id !== id`,
         which described savePix forking a supplied id into a fresh row — that
         fall-through is gone, so a save with an id either updates that exact
         row or throws. Leaving the second clause in would imply the fork is
         still a thing this endpoint can do. */
      created: !id,
    },
  };
}

async function handleList(query, ownerId, selfId) {
  const rows = await listPix({
    limit: query.limit,
    offset: query.offset,
    // QA may narrow the list to one author; a writer is pinned to their own.
    userLoginId: ownerId || (query.user ? String(query.user) : null),
    /* Reviewer-only, and deliberately not falling back to `selfId` the way
       `userLoginId` falls back to `ownerId`: a writer asking for one
       reviewer's decisions is asking about other people's posts, which is the
       one thing the ownership scope exists to prevent. Ignored rather than
       refused — an ignored filter returns the writer their own posts, which is
       what they are allowed to see anyway. */
    reviewedBy: ownerId === null && query.reviewer ? String(query.reviewer) : null,
    /* Who is asking, which is a different question from whose posts they asked
       for: drafts are listed for their author alone, and `userLoginId` above is
       a filter QA chooses — pointing it at a writer would otherwise have been
       enough to read that writer's unfinished work. */
    viewerId: selfId,
    // `status` supersedes the older `approved` flag — it can say "rejected",
    // which a boolean cannot. Search is orthogonal and applies either way.
    // A comma list ("awaiting,rejected") selects several statuses at once.
    status: String(query.status ?? query.approved ?? "")
      .split(",")
      .map((s) => parseStatusFilter(s.trim()))
      .filter(Boolean),
    search: query.q || "",
    from: query.from || null,
    to: query.to || null,
  });
  return { status: 200, body: { posts: rows, count: rows.length } };
}

/* Absent means "no filter". `approved=true|false` is still honoured so an old
   client keeps working, but false now means awaiting rather than "anything not
   approved" — a rejected post is finished with, not still in the queue. */
function parseStatusFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "true" || value === true || value === "approved") return "approved";
  if (value === "false" || value === false || value === "awaiting" || value === "pending") return "awaiting";
  if (value === "rejected") return "rejected";
  if (value === "drafts") return "drafts";
  if (value === "published") return "published";
  return null;
}

/* The verdict is QA's alone — it is the whole point of the role. */
async function handleApprove(id, body, user) {
  if (!canReview(user.role)) {
    return { status: 403, body: { error: "Only QA can approve or reject posts." } };
  }
  if (!id || !UUID_RE.test(String(id))) return { status: 400, body: { error: "Invalid id." } };

  // { rejected: true } turns a post down. Otherwise the default is to approve,
  // and { approved: false } withdraws the verdict back to awaiting review.
  const rejected = Boolean(body?.rejected);
  const approved = rejected ? false : (body?.approved === undefined ? true : Boolean(body.approved));
  const row = await setApproval(String(id), {
    approved,
    rejected,
    byId: user.id,
    byName: user.displayName || user.username,
  });
  if (!row) return { status: 404, body: { error: "Not found." } };
  return {
    status: 200,
    body: {
      id: row.id,
      approved: row.approved,
      approvedAt: row.approved_at,
      approvedByName: row.approved_by_name,
      rejected: row.rejected,
      rejectedAt: row.rejected_at,
      rejectedByName: row.rejected_by_name,
    },
  };
}

async function handleGetOne(id, ownerId, selfId) {
  if (!UUID_RE.test(String(id))) return { status: 400, body: { error: "Invalid id." } };
  const row = await getPix(String(id));
  // A writer asking for someone else's post gets the same answer as for a
  // post that does not exist — the library should not confirm what it holds.
  if (!row || (ownerId && row.user_login_id !== ownerId)) {
    return { status: 404, body: { error: "Not found." } };
  }
  /* Same for anyone else's unsubmitted draft, reviewer included. Scoping the
     list was not enough on its own: an id is all this route needs, and the
     analytics screen, a bookmark and a browser history entry all carry one, so
     without this a reviewer could still open a draft in the editor and — since
     publishing auto-approves — push an article the writer never handed in to a
     write-only external API.

     The test matches the one listPix uses (SUBMITTED_SQL) rather than reading
     is_draft alone: a row that carries a verdict has left the drafts stage
     however the flag reads, and refusing those would 404 posts the queue is
     still listing. */
  const stillDraft = row.is_draft && !row.approved && !row.rejected;
  // An authorless draft — a row from before the INSERT fall-through was closed
  // — belongs to nobody, so it is nobody's to open. Compared as strings and
  // only when both sides exist, or two nulls would read as a match.
  const author = row.user_login_id ? String(row.user_login_id) : null;
  if (stillDraft && (!author || !selfId || author !== String(selfId))) {
    return { status: 404, body: { error: "Not found." } };
  }
  return { status: 200, body: { post: row } };
}

async function handleDelete(id, user) {
  if (!id || !UUID_RE.test(String(id))) return { status: 400, body: { error: "Invalid id." } };
  if (!canReview(user.role)) {
    return { status: 403, body: { error: "Only QA can delete posts." } };
  }
  const gone = await deletePix(String(id));
  return gone ? { status: 200, body: { deleted: true } } : { status: 404, body: { error: "Not found." } };
}

/* Health detail for /health — never throws. */
export async function pixStorageHealth() {
  return ping();
}

/* ── Normalisation ──
   Client keys are camelCase and every one is optional; only keys actually
   present become columns to write. */
function normalise(body) {
  const out = {};
  for (const [clientKey, column] of Object.entries(CLIENT_TO_COLUMN)) {
    if (!(clientKey in body)) continue;
    const value = body[clientKey];

    if (column === "ai_bullets") {
      out[column] = toStringArray(value, LIMITS.bullets, LIMITS.text);
      continue;
    }
    if (column === "ai_flags") {
      out[column] = toStringArray(value, LIMITS.bullets, LIMITS.text);
      continue;
    }
    if (column === "design") {
      out[column] = toDesign(value);
      continue;
    }
    if (BOOL_COLUMNS.has(column)) {
      // Only an explicit true is true — a stray "1" or "yes" is not an intent
      // this endpoint should guess at.
      out[column] = value === true || value === "true";
      continue;
    }
    if (INT_COLUMNS.has(column)) {
      // "" clears the column; anything non-numeric is treated as "not set"
      // rather than an error, so a stale value cannot pin a post to the wrong
      // section.
      const n = Number(value);
      out[column] = Number.isInteger(n) && n > 0 ? n : null;
      continue;
    }
    if (column.endsWith("_url")) {
      const url = toUrl(value);
      // undefined means "not storable" (a data: URL). Leave the column out
      // entirely so an export of an AI-enhanced image does not erase the
      // address of the image it was enhanced from.
      if (url !== undefined) out[column] = url;
      continue;
    }

    const cap = LIMITS[column] || LIMITS.text;
    out[column] = clip(value, cap);
  }
  return out;
}

function clip(value, max) {
  if (value === null || value === undefined) return null;
  // Postgres text columns reject NUL bytes outright; scraped HTML occasionally
  // carries one. Strip rather than let a whole save fail on it.
  const text = String(value).replace(/\u0000/g, "").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/* A base64 data: URL is an entire image — hundreds of KB of it. Those belong
   in object storage, not in a text column. Answers undefined for one so the
   caller can leave the column untouched. */
function toUrl(value) {
  const text = clip(value, LIMITS.url);
  if (!text) return null;
  if (/^data:/i.test(text)) return undefined;   // keep whatever is stored
  if (!/^https?:\/\//i.test(text)) return null;
  return text;
}

function toStringArray(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clip(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function toDesign(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let serialised;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return {};
  }
  // Guard against an accidental data: URL or a whole canvas snapshot landing
  // in the snapshot blob.
  if (serialised.length > LIMITS.design) {
    console.warn(`⚠ /api/pix: design snapshot was ${serialised.length} bytes — stored empty.`);
    return {};
  }
  return value;
}
