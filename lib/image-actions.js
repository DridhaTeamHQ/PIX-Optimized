import { query, readQuery } from "./db.js";

/* ── Image-AI audit ──
   Who pressed AI Upscale, Reframe, Free Upscale and Undo, on which post, and
   what came back. The table is created with the rest of the schema in db.js.

   Two writers feed it, and they never record the same press twice:

     the server   every press that reached /api/upscale-image (the paid edit
                  stage) or /api/free-upscale — success, failure, refusal or a
                  limit. It knows the cost and holds the picture, and it keeps
                  recording even if the tab that asked has since closed.
     the browser  only what the server never saw: Undo, which is local, and a
                  paid press that stopped before the paid call (the planning
                  step failed, or there was nothing for the AI to do).

   The browser may not claim a cost, an engine or a result. Those columns are
   only ever filled from the server's own measurements. */

export const IMAGE_ACTIONS = ["ai_upscale", "reframe", "free_upscale", "undo"];
const OUTCOMES = new Set(["success", "failed", "refused", "limit", "skipped"]);
const JOBS = new Set(["restore", "expand", "reframe"]);
// The buttons whose presses can end without reaching the server's audit.
const CLIENT_ACTIONS = new Set(["ai_upscale", "reframe", "undo"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cleanPixId(value) {
  const text = String(value || "").trim();
  return UUID_RE.test(text) ? text.toLowerCase() : null;
}

function cleanText(value, max) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

/* A browser date input's YYYY-MM-DD, and only a real one — "2026-13-45" has
   the shape and would fail in Postgres, taking the whole report with it. */
export function cleanDay(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/* The button a paid call came from, read off the job it ran. Reframe has its
   own button; restore and expand are both the AI Upscale button with a
   different Job selected. */
export function actionForJob(job) {
  return String(job || "").toLowerCase() === "reframe" ? "reframe" : "ai_upscale";
}

/* What the browser is allowed to report. Anything it cannot know honestly,
   or that the server records for itself, is refused rather than trusted. */
export function cleanClientReport(body = {}) {
  const action = String(body?.action || "");
  const outcome = String(body?.outcome || "");
  if (!CLIENT_ACTIONS.has(action) || !OUTCOMES.has(outcome)) return null;
  // Undo cannot fail on the server's side — there is no server side to it.
  if (action === "undo" && outcome !== "success") return null;
  const job = String(body?.job || "").toLowerCase();
  return {
    action,
    job: action === "undo" ? null : (JOBS.has(job) ? job : null),
    outcome,
    pixId: cleanPixId(body?.pixId),
    pageId: cleanText(body?.pageId, 100),
    headline: cleanText(body?.headline, 200),
    error: cleanText(body?.error, 300),
  };
}

function positiveInt(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n : null;
}

export async function recordImageAction(row) {
  const cost = Number(row.costUsd);
  await query(
    `insert into pix_image_actions
       (user_id, user_name, pix_id, page_id, headline, action, job, outcome, engine,
        cost_usd, cached, duration_ms, source_w, source_h, result_w, result_h,
        before_key, result_key, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      cleanText(row.userId, 100),
      cleanText(row.userName, 120),
      cleanPixId(row.pixId),
      cleanText(row.pageId, 100),
      cleanText(row.headline, 200),
      row.action,
      row.job || null,
      row.outcome,
      cleanText(row.engine, 120),
      Number.isFinite(cost) && cost >= 0 ? cost : null,
      Boolean(row.cached),
      positiveInt(row.durationMs),
      positiveInt(row.sourceW),
      positiveInt(row.sourceH),
      positiveInt(row.resultW),
      positiveInt(row.resultH),
      row.beforeKey || null,
      row.resultKey || null,
      cleanText(row.error, 300),
    ]
  );
}

/* Counted the same way in every rollup, so the cards, the people table and the
   post table can never disagree about what a number means. "failed" is a press
   that did not produce a picture; "skipped" is the software declining to spend
   on a picture that had nothing to gain, which is neither. */
const COUNTS_SQL = `
  count(*)::int as presses,
  count(*) filter (where a.action = 'ai_upscale')::int as ai_upscale,
  count(*) filter (where a.action = 'reframe')::int as reframe,
  count(*) filter (where a.action = 'free_upscale')::int as free_upscale,
  count(*) filter (where a.action = 'undo')::int as undo,
  count(*) filter (where a.outcome in ('failed', 'refused', 'limit'))::int as failed,
  count(*) filter (where a.cached)::int as cached,
  coalesce(sum(a.cost_usd), 0)::float as cost_usd,
  max(a.created_at) as last_at`;

const POST_HEADLINE_SQL =
  "coalesce(nullif(p.headline, ''), nullif(p.ai_headline, ''), nullif(p.scraped_title, ''))";

/* The admin report. Days are India calendar days, the same as the rest of the
   dashboard, so "today" here and "today" on Analytics are the same 24 hours.
   `post` narrows only the press log: the totals and tables above it keep
   answering for the whole range, which is the context the log is read in. */
export async function getImageActionReport({
  from = null,
  to = null,
  userId = null,
  action = null,
  post = null,
  limit = 200,
} = {}) {
  const clauses = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };
  if (from) add("a.created_at >= ($?::date::timestamp at time zone 'Asia/Kolkata')", from);
  if (to) add("a.created_at < (($?::date + 1)::timestamp at time zone 'Asia/Kolkata')", to);
  if (userId) add("a.user_id = $?", userId);
  if (action) add("a.action = $?", action);
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";

  const { rows: totalRows } = await readQuery(
    `select ${COUNTS_SQL},
            count(distinct a.pix_id)::int as posts,
            count(distinct a.user_id)::int as people
       from pix_image_actions a ${where}`,
    params
  );

  const { rows: people } = await readQuery(
    `select a.user_id, coalesce(nullif(max(a.user_name), ''), 'Unknown') as user_name, ${COUNTS_SQL}
       from pix_image_actions a ${where}
      group by a.user_id
      order by presses desc, last_at desc
      limit 200`,
    params
  );

  /* Saved posts group by id. An unsaved poster has no id, so its presses group
     by who pressed and the headline they were looking at — the closest thing
     to "the same post" there is until it is saved. */
  const { rows: posts } = await readQuery(
    `with grouped as (
       select coalesce(a.pix_id::text,
                       'unsaved:' || coalesce(a.user_id, '') || ':' || coalesce(a.headline, '')) as post_key,
              max(a.pix_id::text) as pix_id,
              max(a.headline) as press_headline,
              string_agg(distinct coalesce(nullif(a.user_name, ''), 'Unknown'), ', ') as people,
              ${COUNTS_SQL}
         from pix_image_actions a ${where}
        group by 1
     )
     select g.*,
            coalesce(${POST_HEADLINE_SQL}, g.press_headline) as headline,
            p.id is not null as post_exists,
            coalesce(p.approved, false) as approved,
            coalesce(p.rejected, false) as rejected,
            p.published_at,
            p.user_name as writer_name
       from grouped g
       left join pix_posts p on p.id = g.pix_id::uuid
      order by g.last_at desc
      limit 100`,
    params
  );

  const eventParams = [...params];
  const eventClauses = [...clauses];
  const pixId = cleanPixId(post);
  if (pixId) {
    eventParams.push(pixId);
    eventClauses.push(`a.pix_id = $${eventParams.length}`);
  }
  eventParams.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
  const eventWhere = eventClauses.length ? `where ${eventClauses.join(" and ")}` : "";
  const { rows: events } = await readQuery(
    `select a.id, a.created_at, a.user_id, a.user_name, a.pix_id, a.page_id,
            a.action, a.job, a.outcome, a.engine, a.cost_usd::float as cost_usd,
            a.cached, a.duration_ms, a.source_w, a.source_h, a.result_w, a.result_h,
            a.before_key, a.result_key, a.error,
            coalesce(${POST_HEADLINE_SQL}, a.headline) as headline
       from pix_image_actions a
       left join pix_posts p on p.id = a.pix_id
       ${eventWhere}
      order by a.created_at desc
      limit $${eventParams.length}`,
    eventParams
  );

  return { totals: totalRows[0] || null, people, posts, events };
}

/* The retention sweep's worklist: rows whose preview files are older than the
   window. The rows themselves are kept — they are the counts. */
export async function expiredPreviewRows(days, limit = 200) {
  const { rows } = await readQuery(
    `select id, before_key, result_key
       from pix_image_actions
      where created_at < now() - make_interval(days => $1::int)
        and (before_key is not null or result_key is not null)
      order by created_at
      limit $2`,
    [days, limit]
  );
  return rows;
}

export async function clearPreviewKeys(ids) {
  if (!ids.length) return 0;
  const { rowCount } = await query(
    "update pix_image_actions set before_key = null, result_key = null where id = any($1::bigint[])",
    [ids]
  );
  return rowCount;
}
