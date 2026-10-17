import { randomBytes } from "node:crypto";
import { buildReportWorkbook } from "./report-workbook.js";
import { pieSlices, piePng, shareLabel } from "./report-charts.js";

/* ── The daily Breakdown report ──────────────────────────────────────────────

   Every morning at 9:00 India time, the previous day's Breakdown stats go to
   everyone on the report list: a short summary in the email body, and the
   full report — tables and charts — as an attached Excel workbook.

   "The previous day" is read the way the Breakdown page reads a date range,
   through the same getPixAnalytics() query, so the numbers in the email are
   the numbers an admin sees when they pick that day on the dashboard.

   The pieces that touch the outside world — the analytics query, the
   category names, the recipient list, Brevo — are passed in, so this module
   can be tested without a database or a mail account. */

export const REPORT_HOUR_IST = 9;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// India has no daylight saving, so a fixed +5:30 is exact.
function istParts(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    date: ist.toISOString().slice(0, 10),
    hour: ist.getUTCHours(),
  };
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/* The day the report sent at `now` is about: yesterday in India. */
export function reportDateFor(now = new Date()) {
  return addDays(istParts(now).date, -1);
}

/* Due once the day's report hour has passed — and stays due for the rest of
   the day, so a server that was down at 9:00 sends it when it comes back. */
export function reportIsDue(now = new Date()) {
  return istParts(now).hour >= REPORT_HOUR_IST;
}

function longDate(isoDate) {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function shortDate(isoDate) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

function generatedAt(now) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(now);
}

/**
 * The report's content, from one getPixAnalytics() result.
 *
 *   categoryNames  Map of DailyMattr category id (string) → name
 */
export function buildReportData({ date, analytics, categoryNames = new Map(), now = new Date() }) {
  const nameOf = (id) => {
    if (id === null || id === undefined) return "Uncategorised";
    return categoryNames.get(String(id)) || `Category ${id}`;
  };
  const categories = (analytics?.categories || [])
    .map((c) => ({
      name: nameOf(c.category_id),
      sent: Number(c.sent_count) || 0,
      approved: Number(c.approved_count) || 0,
      rejected: Number(c.rejected_count) || 0,
      pending: Number(c.pending_count) || 0,
    }))
    .filter((c) => c.sent > 0)
    .sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
  const sources = (analytics?.sources || [])
    .map((s) => ({ name: String(s.value || ""), posts: Number(s.post_count) || 0 }))
    .filter((s) => s.name && s.posts > 0);

  return {
    date,
    title: "PIX daily report",
    periodLabel: `Posts from ${longDate(date)}`,
    generatedLabel: `Generated ${generatedAt(now)} IST`,
    summary: analytics?.summary || {},
    categories,
    sources,
  };
}

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => new Intl.NumberFormat("en-IN").format(Number(n) || 0);
const pct = (part, whole) => (whole ? `${Math.round((part * 100) / whole)}%` : "0%");

/* ── The email itself ──

   Every stat on the Breakdown page, in the body of the email, so it reads in
   full without the attachment:

     summary        sent, approved, rejected, pending, approval rate, published
     two pies       share of posts sent and of posts approved, by category —
                    images, with their numbers also in a key beside each
     by category    every category: sent, share, approved, share of approved,
                    rejected, pending, approval rate, and the total
     verdicts       a bar per category, split approved / rejected / pending
     top sources    a bar per source, the fifteen biggest

   The bars are table cells, not pictures: every mail client draws a coloured
   cell, including the ones that hold images back. Only the pies, which a
   table cannot draw, are images (lib/report-charts.js). Everything is
   inline-styled tables, because that is what renders the same everywhere. */

const C = {
  ink: "#0f172a", body: "#334155", muted: "#64748b", faint: "#94a3b8",
  line: "#e2e8f0", soft: "#f1f5f9", accent: "#3979ff",
  approved: "#10a879", rejected: "#e45e6d", pending: "#e79a25",
};
const FONT = "Segoe UI,Arial,Helvetica,sans-serif";

function sectionTitle(title, note = "") {
  return `<div style="font-size:15px;font-weight:700;color:${C.ink};">${esc(title)}</div>
    ${note ? `<div style="font-size:12px;color:${C.muted};margin:2px 0 10px;">${esc(note)}</div>` : `<div style="height:8px;"></div>`}`;
}

/* A horizontal bar of coloured cells. `parts` is [[colour, value]]; `scale`
   is the value a full-width bar stands for. Empty parts take no cell, and
   the rest of the width is a pale track. */
function barCells(parts, scale) {
  const cells = [];
  let used = 0;
  for (const [colour, value] of parts) {
    if (!value || !scale) continue;
    const width = Math.max(1, Math.round((value / scale) * 100));
    used += width;
    cells.push(`<td width="${width}%" style="background:${colour};height:12px;font-size:0;line-height:0;">&nbsp;</td>`);
  }
  if (used < 100) cells.push(`<td width="${100 - used}%" style="background:${C.soft};height:12px;font-size:0;line-height:0;">&nbsp;</td>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;"><tr>${cells.join("")}</tr></table>`;
}

function pieBlock(title, slices, url, noun) {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  const key = slices.map((s) => `
    <tr>
      <td width="14" style="padding:4px 0;"><div style="width:10px;height:10px;border-radius:3px;background:${s.hue};"></div></td>
      <td style="padding:4px 6px;font-size:12px;color:${C.body};">${esc(s.name)}${s.members.length ? `<div style="font-size:11px;color:${C.faint};">${esc(s.members.join(", "))}</div>` : ""}</td>
      <td align="right" style="padding:4px 0;font-size:12px;font-weight:700;color:${C.ink};">${fmt(s.count)}</td>
      <td align="right" width="44" style="padding:4px 0;font-size:12px;color:${C.muted};">${esc(shareLabel(s.share))}</td>
    </tr>`).join("");
  const image = url
    ? `<img src="${esc(url)}" width="240" height="240" alt="${esc(title)}: ${slices.map((s) => `${s.name} ${s.count} (${shareLabel(s.share)})`).join(", ")}" style="display:block;width:240px;height:240px;margin:0 auto 10px;border:0;">`
    : "";
  return `
    <div style="font-size:13px;font-weight:700;color:${C.ink};margin-bottom:8px;">${esc(title)}</div>
    ${total ? `${image}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${key}
      <tr><td></td><td style="padding:6px 6px 0;border-top:1px solid ${C.line};font-size:12px;font-weight:700;color:${C.ink};">Total</td>
        <td align="right" style="padding:6px 0 0;border-top:1px solid ${C.line};font-size:12px;font-weight:700;color:${C.ink};">${fmt(total)}</td>
        <td align="right" style="padding:6px 0 0;border-top:1px solid ${C.line};font-size:12px;color:${C.muted};">100%</td></tr>
    </table>` : `<div style="font-size:12px;color:${C.muted};">No posts ${esc(noun)} on this day.</div>`}`;
}

export function buildReportEmail(data, { pieUrls = null, slices = pieSlices(data.categories) } = {}) {
  const s = data.summary || {};
  const sent = Number(s.sent_count) || 0;
  const approved = Number(s.approved_count) || 0;
  const tiles = [
    ["Posts sent", fmt(sent), C.accent],
    ["Approved", fmt(approved), C.approved],
    ["Rejected", fmt(s.rejected_count), C.rejected],
    ["Pending review", fmt(s.pending_count), C.pending],
    ["Approval rate", pct(approved, sent), C.approved],
    ["Published to DailyMattr", fmt(s.published_count), C.accent],
  ];
  const cats = data.categories;
  const totalCat = cats.reduce((sum, c) => sum + c.sent, 0);
  const totalApproved = cats.reduce((sum, c) => sum + c.approved, 0);
  const sources = data.sources.slice(0, 15);

  const tile = ([label, value, colour]) => `
    <td width="33%" style="padding:5px;">
      <div style="border:1px solid ${C.line};border-top:3px solid ${colour};border-radius:8px;padding:10px 12px;">
        <div style="font-size:11px;color:${C.muted};">${esc(label)}</div>
        <div style="font-size:21px;font-weight:700;color:${C.ink};">${esc(value)}</div>
      </div>
    </td>`;
  const tilesHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${tiles.slice(0, 3).map(tile).join("")}</tr><tr>${tiles.slice(3).map(tile).join("")}</tr></table>`;

  const th = (label, align = "right") =>
    `<td align="${align}" style="padding:6px 6px;border-bottom:1px solid ${C.line};background:${C.soft};font-size:11px;font-weight:700;color:${C.muted};">${label}</td>`;
  const td = (value, { align = "right", bold = false, colour = C.ink } = {}) =>
    `<td align="${align}" style="padding:6px 6px;border-bottom:1px solid ${C.soft};font-size:12px;color:${colour};${bold ? "font-weight:700;" : ""}">${value}</td>`;
  const categoryTable = cats.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate;">
      <tr>${th("Category", "left")}${th("Sent")}${th("Share")}${th("Approved")}${th("Share")}${th("Rejected")}${th("Pending")}${th("Approval rate")}</tr>
      ${cats.map((c) => `<tr>
        ${td(esc(c.name), { align: "left" })}${td(fmt(c.sent), { bold: true })}${td(esc(shareLabel(totalCat ? c.sent / totalCat : 0)), { colour: C.muted })}
        ${td(fmt(c.approved), { bold: true })}${td(esc(shareLabel(totalApproved ? c.approved / totalApproved : 0)), { colour: C.muted })}
        ${td(fmt(c.rejected))}${td(fmt(c.pending))}${td(pct(c.approved, c.sent), { colour: C.muted })}
      </tr>`).join("")}
      <tr>
        ${td("Total", { align: "left", bold: true })}${td(fmt(totalCat), { bold: true })}${td("100%", { colour: C.muted })}
        ${td(fmt(totalApproved), { bold: true })}${td("100%", { colour: C.muted })}
        ${td(fmt(cats.reduce((n, c) => n + c.rejected, 0)), { bold: true })}${td(fmt(cats.reduce((n, c) => n + c.pending, 0)), { bold: true })}
        ${td(pct(totalApproved, totalCat), { bold: true })}
      </tr>
    </table>` : `<div style="font-size:12px;color:${C.muted};">No posts were sent on this day.</div>`;

  const maxSent = Math.max(0, ...cats.map((c) => c.sent));
  const swatch = (colour, label) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colour};margin:0 4px 0 10px;"></span>${label}`;
  const verdictBars = cats.length ? `
    <div style="font-size:11px;color:${C.muted};margin:-4px 0 8px;">${swatch(C.approved, "Approved")}${swatch(C.rejected, "Rejected")}${swatch(C.pending, "Pending")}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${cats.map((c) => `<tr>
        <td width="120" style="padding:5px 8px 5px 0;font-size:12px;color:${C.body};">${esc(c.name)}</td>
        <td style="padding:5px 0;">${barCells([[C.approved, c.approved], [C.rejected, c.rejected], [C.pending, c.pending]], maxSent)}</td>
        <td width="110" align="right" style="padding:5px 0 5px 8px;font-size:12px;color:${C.ink};"><b>${fmt(c.sent)}</b> <span style="color:${C.muted};">· ${pct(c.approved, c.sent)} approved</span></td>
      </tr>`).join("")}
    </table>` : "";

  const maxSource = Math.max(0, ...sources.map((src) => src.posts));
  const sourceBars = sources.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${sources.map((src) => `<tr>
        <td width="190" style="padding:4px 8px 4px 0;font-size:12px;color:${C.body};">${esc(src.name)}</td>
        <td style="padding:4px 0;">${barCells([[C.accent, src.posts]], maxSource)}</td>
        <td width="40" align="right" style="padding:4px 0 4px 8px;font-size:12px;font-weight:700;color:${C.ink};">${fmt(src.posts)}</td>
      </tr>`).join("")}
    </table>` : `<div style="font-size:12px;color:${C.muted};">No sources on this day.</div>`;

  const row = (inner, pad = "16px 24px 4px") => `<tr><td style="padding:${pad};">${inner}</td></tr>`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid ${C.line};border-radius:12px;font-family:${FONT};">
${row(`<div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:${C.accent};text-transform:uppercase;">PIX daily report</div>
  <div style="font-size:20px;font-weight:700;color:${C.ink};margin-top:4px;">${esc(longDate(data.date))}</div>
  <div style="font-size:12px;color:${C.muted};margin-top:4px;">${esc(data.generatedLabel || "")} · The same stats and charts are attached as an Excel file.</div>`, "24px 24px 8px")}
${row(tilesHtml, "8px 19px 4px")}
${cats.length ? row(`${sectionTitle("Category share", "Each category's share of the posts sent to QA, and of the posts QA approved. A category has the same colour in both.")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="50%" valign="top" style="padding-right:12px;">${pieBlock("Sent to QA", slices.sent, pieUrls?.sent, "sent")}</td>
    <td width="50%" valign="top" style="padding-left:12px;">${pieBlock("Approved by QA", slices.approved, pieUrls?.approved, "approved")}</td>
  </tr></table>`) : ""}
${row(`${sectionTitle("By category", "Approval rate is the share of a category's own sent posts that QA approved.")}${categoryTable}`)}
${cats.length ? row(`${sectionTitle("Verdicts by category", "Each bar is the category's posts sent, split by where they stand now.")}${verdictBars}`) : ""}
${row(`${sectionTitle("Top sources", sources.length ? `Posts per source site — the ${sources.length} biggest.` : "")}${sourceBars}`)}
${row(`<div style="font-size:11px;color:${C.faint};border-top:1px solid ${C.line};padding-top:14px;">
  Statuses are as of when this report was made. You receive this because a PIX admin added you to the daily report list — ask a PIX admin to remove you.</div>`, "18px 24px 24px")}
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    `PIX daily report — ${longDate(data.date)}`,
    data.generatedLabel || "",
    "",
    ...tiles.map(([label, value]) => `${label}: ${value}`),
    "",
    "By category — sent (share) · approved (share) · rejected · pending · approval rate:",
    ...(cats.length
      ? cats.map((c) => `  ${c.name}: ${fmt(c.sent)} (${pct(c.sent, totalCat)}) · ${fmt(c.approved)} (${pct(c.approved, totalApproved)}) · ${fmt(c.rejected)} · ${fmt(c.pending)} · ${pct(c.approved, c.sent)}`)
      : ["  No posts were sent on this day."]),
    "",
    "Top sources:",
    ...(sources.length ? sources.map((src) => `  ${src.name}: ${fmt(src.posts)}`) : ["  None"]),
    "",
    "The same stats and charts are attached as an Excel file.",
  ].join("\n");

  return {
    subject: `PIX daily report — ${shortDate(data.date)}`,
    html,
    text,
  };
}

export function reportFilename(date) {
  return `PIX-report-${date}.xlsx`;
}

/* The two pie images, uploaded where the email can reach them. The names
   carry a random part so one day's charts cannot be guessed from another's.
   Any failure here leaves the email without its pictures, never unsent:
   every number on a pie is also in the key beside it and in the tables. */
async function uploadPies(date, slices, deps) {
  if (!deps.uploadChart || !slices.sent.length) return null;
  try {
    const token = randomBytes(8).toString("hex");
    const [sentPng, approvedPng] = await Promise.all([
      piePng(slices.sent),
      slices.approved.length ? piePng(slices.approved) : null,
    ]);
    const sent = await deps.uploadChart(`reports/${date}-${token}-sent.png`, sentPng);
    const approved = approvedPng ? await deps.uploadChart(`reports/${date}-${token}-approved.png`, approvedPng) : null;
    return { sent, approved };
  } catch (err) {
    (deps.log || console).warn(`⚠ report pie charts could not be uploaded, sending without them: ${err.message}`);
    return null;
  }
}

/**
 * Build the report for `date` and send it to each recipient, one email each.
 *
 * deps: getAnalytics(date), getCategoryNames(), send({ to, subject, html, text, attachments }),
 *       uploadChart(key, pngBuffer) → public URL   (optional — no pie images without it)
 *
 * One failed address does not stop the rest. Returns
 * { sentCount, failedCount, failures: [{ email, error }], chartsIncluded }.
 */
export async function sendDailyReport({ date, recipients, deps, now = new Date() }) {
  const [analytics, categoryNames] = await Promise.all([
    deps.getAnalytics(date),
    deps.getCategoryNames().catch(() => new Map()),
  ]);
  const data = buildReportData({ date, analytics, categoryNames, now });
  const slices = pieSlices(data.categories);
  const pieUrls = await uploadPies(date, slices, deps);
  const email = buildReportEmail(data, { pieUrls, slices });
  const workbook = buildReportWorkbook(data);
  const attachments = [{ name: reportFilename(date), content: workbook }];

  let sentCount = 0;
  const failures = [];
  for (const person of recipients) {
    try {
      await deps.send({ to: { email: person.email, name: person.name || undefined }, ...email, attachments });
      sentCount++;
    } catch (err) {
      failures.push({ email: person.email, error: err.message || String(err) });
    }
  }
  return { sentCount, failedCount: failures.length, failures, chartsIncluded: Boolean(pieUrls) };
}

/**
 * The 9:00 IST schedule.
 *
 * Checks the clock every few minutes rather than setting one long timer, so a
 * restart, a sleeping laptop or a clock change cannot make it miss the day.
 * Whether the day has gone out is kept in the database (claimRun), not in
 * memory, so two servers sharing the database — local and Railway — still
 * send it once between them.
 *
 * deps: isReady(), listRecipients(), claimRun(date), finishRun(date, result),
 *       plus everything sendDailyReport needs. log is console-like.
 */
export function startDailyReportSchedule(deps, { intervalMs = 5 * 60 * 1000, log = console, clock = () => new Date() } = {}) {
  let busy = false;
  const tick = async () => {
    const now = clock();
    if (busy || !deps.isReady() || !reportIsDue(now)) return;
    busy = true;
    const date = reportDateFor(now);
    let claimed = false;
    try {
      // Nobody on the list: nothing to claim. If an admin adds someone later
      // in the day, the next tick still sends that day's report.
      const recipients = await deps.listRecipients();
      if (!recipients.length) return;
      if (!(await deps.claimRun(date))) return;
      claimed = true;
      const result = await sendDailyReport({ date, recipients, deps, now });
      const error = result.failures.length
        ? result.failures.slice(0, 5).map((f) => `${f.email}: ${f.error}`).join("; ")
        : null;
      await deps.finishRun(date, { ...result, error });
      if (result.sentCount) log.log(`✓ daily report for ${date} sent to ${result.sentCount} of ${recipients.length}`);
      if (result.failedCount) log.warn(`⚠ daily report for ${date} failed for ${result.failedCount}: ${error}`);
    } catch (err) {
      log.warn(`⚠ daily report for ${date} could not be sent: ${err.message}`);
      // Only a run this server claimed is its to close. Left open, it is
      // retried once its claim is half an hour old.
      if (claimed) {
        try { await deps.finishRun(date, { sentCount: 0, failedCount: 0, error: err.message }); } catch { /* retried after the claim ages */ }
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // First look shortly after boot, not immediately: the database and the
  // DailyMattr login are still warming up at that point.
  const first = setTimeout(tick, 30_000);
  first.unref?.();
  return { tick, stop: () => { clearInterval(timer); clearTimeout(first); } };
}
