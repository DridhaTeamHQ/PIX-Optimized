import { isConfigured, query } from "./db.js";

/* ── Who receives the daily report, and which days have gone out ─────────────

   pix_report_recipients   the list admins manage. One row per address,
                           stored lower-cased and unique, so adding someone
                           who is already there is a no-op, not a duplicate.
   pix_report_runs         one row per report day. It is the claim that stops
                           the same day going out twice: the local server and
                           the Railway one share this database, and each
                           checks the clock every few minutes. Whichever
                           inserts the day's row first sends it; the other
                           finds it already taken.

   Created on first use, the same way the other tables are. */

const SCHEMA_SQL = `
create table if not exists pix_report_recipients (
  id          bigserial primary key,
  email       text not null,
  name        text,
  added_by    text,
  created_at  timestamptz not null default now()
);
create unique index if not exists pix_report_recipients_email_idx on pix_report_recipients (email);

create table if not exists pix_report_runs (
  report_date   date primary key,
  claimed_at    timestamptz not null default now(),
  attempts      integer not null default 1,
  sent_at       timestamptz,
  sent_count    integer not null default 0,
  failed_count  integer not null default 0,
  error         text
);
`;

let schemaReady = null;

function ensureReportSchema() {
  if (schemaReady) return schemaReady;
  // No parameters, so pg sends it as a simple query and both statements run.
  schemaReady = query(SCHEMA_SQL).then(
    () => true,
    (err) => {
      schemaReady = null;
      throw err;
    }
  );
  return schemaReady;
}

async function run(text, params = []) {
  await ensureReportSchema();
  return query(text, params);
}

export function reportsAvailable() {
  return isConfigured();
}

export async function listRecipients() {
  const { rows } = await run(
    `select id, email, name, added_by, created_at
       from pix_report_recipients
      order by created_at desc, id desc`
  );
  return rows;
}

/**
 * Add people to the list. `people` is [{ email, name }] with emails already
 * cleaned (lib/recipient-file.js cleanEmail). Someone already on the list is
 * left as they are — their name is not overwritten by a later upload.
 *
 * Returns { added: rows, existing: [emails] }.
 */
export async function addRecipients(people, addedBy = null) {
  if (!people.length) return { added: [], existing: [] };
  const emails = people.map((p) => p.email);
  const names = people.map((p) => p.name || null);
  const { rows } = await run(
    `insert into pix_report_recipients (email, name, added_by)
     select e, n, $3 from unnest($1::text[], $2::text[]) as t(e, n)
     on conflict (email) do nothing
     returning id, email, name, added_by, created_at`,
    [emails, names, addedBy]
  );
  const added = new Set(rows.map((r) => r.email));
  return { added: rows, existing: emails.filter((e) => !added.has(e)) };
}

/* Change someone's address or name. Returns the updated row, null when the
   id is gone, or throws with code 23505 when the new address belongs to
   someone else already on the list. */
export async function updateRecipient(id, { email, name }) {
  const { rows } = await run(
    `update pix_report_recipients
        set email = $2, name = $3
      where id = $1
      returning id, email, name, added_by, created_at`,
    [id, email, name]
  );
  return rows[0] || null;
}

export async function deleteRecipient(id) {
  const { rows } = await run(
    "delete from pix_report_recipients where id = $1 returning id, email",
    [id]
  );
  return rows[0] || null;
}

/* Take the day's report for sending. Returns the run row when this caller
   now owns it, or null when it has been sent, or another server is already
   sending it.

   A run whose send failed outright is not stuck forever: after half an hour
   it can be claimed again, up to three attempts, so a Brevo outage at 9:00
   is retried rather than costing the day's report. */
export async function claimReportRun(reportDate) {
  const { rows } = await run(
    `insert into pix_report_runs (report_date) values ($1)
     on conflict (report_date) do update
        set claimed_at = now(), attempts = pix_report_runs.attempts + 1, error = null
      where pix_report_runs.sent_at is null
        and pix_report_runs.attempts < 3
        and pix_report_runs.claimed_at < now() - interval '30 minutes'
     returning *`,
    [reportDate]
  );
  return rows[0] || null;
}

/* Close the day's run. `sent` false means nothing went out, which leaves the
   run open for a retry; any successful send closes it, so someone who did
   get the report is never sent it twice. */
export async function finishReportRun(reportDate, { sentCount = 0, failedCount = 0, error = null }) {
  await run(
    `update pix_report_runs
        set sent_at = case when $2 > 0 then now() else null end,
            sent_count = $2, failed_count = $3, error = $4
      where report_date = $1`,
    [reportDate, sentCount, failedCount, error]
  );
}

export async function lastReportRun() {
  const { rows } = await run(
    `select report_date::text as report_date, claimed_at, attempts, sent_at, sent_count, failed_count, error
       from pix_report_runs
      order by report_date desc
      limit 1`
  );
  return rows[0] || null;
}
