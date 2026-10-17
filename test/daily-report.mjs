/* ── The daily report: recipients, the schedule, the email and the workbook ──

   Run: node test/daily-report.mjs

   Everything that touches the outside world — the database, DailyMattr,
   Brevo — is passed in, so these run with no network and no account.

   What they guard, and why:

     the recipient file     an admin's CSV or Excel export is whatever their
                            spreadsheet produced: a header or none, commas or
                            semicolons, quoted names, a stray blank row, the
                            same person twice. Each of those must come out as
                            the right list, not a silent miss.
     the 9:00 IST schedule  the report is about YESTERDAY in India, and is
                            due from 9:00 India time — on a server whose own
                            clock is UTC.
     sending once           a server that did not claim the day must never
                            mark it sent or failed; that is how two servers
                            sharing the database send it exactly once.
     one bad address        one failed recipient must not stop the rest.
     the workbook           it must be a real .xlsx with its charts, and only
                            the charts that have data. */

import {
  cleanEmail, parseCsv, parseXlsx, recipientsFromFile, recipientsFromGrid,
} from "../lib/recipient-file.js";
import {
  buildReportData, buildReportEmail, reportDateFor, reportIsDue, reportFilename,
  sendDailyReport, startDailyReportSchedule,
} from "../lib/daily-report.js";
import { buildReportWorkbook, zip } from "../lib/report-workbook.js";
import { brevoConfig, sendBrevoEmail } from "../lib/brevo.js";
import { inflateRawSync } from "node:zlib";

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};
const emails = (list) => list.map((r) => r.email).join(",");

console.log("\nAn address is cleaned or refused");
{
  ck("lower-cased and trimmed", cleanEmail("  Asha.R@Example.COM ") === "asha.r@example.com");
  ck("mailto: is dropped", cleanEmail("mailto:ops@dailymattr.com") === "ops@dailymattr.com");
  ck("angle brackets are dropped", cleanEmail("<ops@dailymattr.com>") === "ops@dailymattr.com");
  ck("no @ is refused", cleanEmail("not an email") === null);
  ck("no domain dot is refused", cleanEmail("a@b") === null);
  ck("a space inside is refused", cleanEmail("a b@c.com") === null);
  ck("empty is refused", cleanEmail("") === null && cleanEmail(undefined) === null);
}

console.log("\nCSV files, as spreadsheets actually write them");
{
  const withHeader = recipientsFromGrid(parseCsv("Name,Email\nAsha,asha@x.com\n,ravi@x.com\n"));
  ck("header row is used", emails(withHeader.recipients) === "asha@x.com,ravi@x.com");
  ck("name is kept", withHeader.recipients[0].name === "Asha");
  ck("a missing name is fine", withHeader.recipients[1].name === null);

  const reversed = recipientsFromGrid(parseCsv("E-mail ID,Full Name\nravi@x.com,Ravi K\n"));
  ck("header synonyms and column order", reversed.recipients[0]?.email === "ravi@x.com" && reversed.recipients[0].name === "Ravi K");

  const semicolons = recipientsFromGrid(parseCsv("﻿name;email\nAsha;asha@x.com\r\n"));
  ck("semicolons, BOM and CRLF", semicolons.recipients[0]?.email === "asha@x.com" && semicolons.recipients[0].name === "Asha");

  const quoted = recipientsFromGrid(parseCsv('name,email\n"Rao, Asha",asha@x.com\n"He said ""hi""",b@x.com\n'));
  ck("quoted comma in a name", quoted.recipients[0]?.name === "Rao, Asha");
  ck("escaped quotes in a name", quoted.recipients[1]?.name === 'He said "hi"');

  const noHeader = recipientsFromGrid(parseCsv("asha@x.com,Asha\nRavi,ravi@x.com\nlone@x.com\n"));
  ck("no header: email found in any column", emails(noHeader.recipients) === "asha@x.com,ravi@x.com,lone@x.com");
  ck("no header: the other cell is the name", noHeader.recipients[0].name === "Asha" && noHeader.recipients[1].name === "Ravi");
  ck("no header: no name is fine", noHeader.recipients[2].name === null);

  const messy = recipientsFromGrid(parseCsv("name,email\nAsha,asha@x.com\n\nBad,not-an-email\nAsha again,ASHA@x.com\nNo mail,\n"));
  ck("only valid, distinct addresses", emails(messy.recipients) === "asha@x.com");
  ck("bad address is reported with its row", messy.skipped.some((s) => s.row === 4 && /valid/i.test(s.reason)));
  ck("duplicate is reported", messy.skipped.some((s) => s.row === 5 && /twice/i.test(s.reason)));
  ck("missing email is reported", messy.skipped.some((s) => s.row === 6 && /no email/i.test(s.reason)));
  ck("blank rows are ignored, not reported", !messy.skipped.some((s) => s.row === 3));
}

console.log("\nExcel files");
{
  // A workbook shaped like the ones Excel writes: shared strings, a rich-text
  // run, a number cell, and the sheet found through the workbook's relations.
  const files = [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: '<workbook xmlns:r="r"><sheets><sheet name="People" sheetId="1" r:id="rId7"/></sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/people.xml"/></Relationships>' },
    { name: "xl/sharedStrings.xml", data: '<sst><si><t>Email</t></si><si><t>Name</t></si><si><t>asha@x.com</t></si><si><r><t>Asha </t></r><r><t>R&amp;D</t></r></si><si><t>ravi@x.com</t></si></sst>' },
    {
      name: "xl/worksheets/people.xml",
      data: '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>'
        + '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3"><v>42</v></c></row>'
        + "</sheetData></worksheet>",
    },
  ];
  const book = zip(files);
  const grid = parseXlsx(book);
  ck("shared strings and rich text", grid[1][1] === "Asha R&D", JSON.stringify(grid));
  ck("a number cell", grid[2][2] === "42");
  const fromFile = recipientsFromFile(book, "people.xlsx");
  ck("recipients from the sheet the relations point at", emails(fromFile.recipients) === "asha@x.com,ravi@x.com");
  ck("name from the sheet", fromFile.recipients[0].name === "Asha R&D" && fromFile.recipients[1].name === null);

  const sniffed = recipientsFromFile(book, "renamed.csv");
  ck("format follows the bytes, not the file name", sniffed.recipients.length === 2);

  let xlsError = "";
  try { recipientsFromFile(Buffer.from("not a zip"), "old.xls"); } catch (err) { xlsError = err.message; }
  ck("old binary .xls is refused with what to do instead", /\.xlsx or \.csv/.test(xlsError), xlsError);

  let junk = "";
  try { parseXlsx(Buffer.from("PK\u0003\u0004 not really")); } catch (err) { junk = err.message; }
  ck("a damaged workbook says so", /not a valid|damaged/i.test(junk), junk);
}

console.log("\nThe schedule runs on India time");
{
  // 08:59 IST on 17 Oct is 03:29 UTC.
  ck("not due at 08:59 IST", !reportIsDue(new Date("2026-10-17T03:29:00Z")));
  ck("due at 09:00 IST", reportIsDue(new Date("2026-10-17T03:30:00Z")));
  ck("still due later that day", reportIsDue(new Date("2026-10-17T15:00:00Z")));
  ck("reports on yesterday in India", reportDateFor(new Date("2026-10-17T03:30:00Z")) === "2026-10-16");
  // 01:30 IST on the 17th is still the 16th in UTC — the report is about the 16th either way.
  ck("past IST midnight while UTC is still the day before", reportDateFor(new Date("2026-10-16T20:00:00Z")) === "2026-10-16");
  ck("month boundary", reportDateFor(new Date("2026-11-01T04:00:00Z")) === "2026-10-31");
  ck("file name carries the day", reportFilename("2026-10-16") === "PIX-report-2026-10-16.xlsx");
}

const ANALYTICS = {
  summary: { sent_count: 12, approved_count: 7, rejected_count: 2, pending_count: 3, published_count: 6 },
  categories: [
    { category_id: 2, sent_count: 3, approved_count: 2, rejected_count: 0, pending_count: 1 },
    { category_id: 1, sent_count: 7, approved_count: 4, rejected_count: 1, pending_count: 2 },
    { category_id: null, sent_count: 2, approved_count: 1, rejected_count: 1, pending_count: 0 },
    { category_id: 9, sent_count: 0, approved_count: 0, rejected_count: 0, pending_count: 0 },
  ],
  sources: [{ value: "ndtv.com", post_count: 5 }, { value: "", post_count: 3 }],
};
const NAMES = new Map([["1", "Sports"], ["2", "Tech <AI> & More"]]);

console.log("\nReport data and the email");
{
  const data = buildReportData({ date: "2026-10-16", analytics: ANALYTICS, categoryNames: NAMES, now: new Date("2026-10-17T03:30:00Z") });
  ck("categories named and sorted largest first", data.categories.map((c) => c.name).join("|") === "Sports|Tech <AI> & More|Uncategorised");
  ck("empty categories dropped", data.categories.length === 3);
  ck("blank sources dropped", data.sources.length === 1 && data.sources[0].name === "ndtv.com");
  const unnamed = buildReportData({ date: "2026-10-16", analytics: ANALYTICS });
  ck("unknown names fall back to the id", unnamed.categories[0].name === "Category 1");

  const email = buildReportEmail(data);
  ck("subject names the day", email.subject === "PIX daily report — 16 Oct 2026", email.subject);
  ck("category names are escaped in HTML", email.html.includes("Tech &lt;AI&gt; &amp; More") && !email.html.includes("<AI>"));
  ck("share is shown", email.html.includes("58%"));
  ck("plain-text part has the numbers", email.text.includes("Posts sent: 12") && email.text.includes("Sports: 7 (58%) · 4 (57%)"));
  ck("approved column in the email", email.html.includes(">Approved</td>") && email.html.includes(">4</td>"));
  ck("says the workbook is attached", /attached as an Excel file/.test(email.text));

  const empty = buildReportEmail(buildReportData({ date: "2026-10-16", analytics: { summary: {}, categories: [], sources: [] } }));
  ck("an empty day still makes a readable email", email.html && /No posts were sent/.test(empty.html));
}

console.log("\nThe workbook");
{
  const parts = (buf) => {
    // Names of the parts in a zip, from its central directory.
    const names = [];
    let eocd = buf.length - 22;
    while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
      const len = buf.readUInt16LE(p + 28);
      names.push(buf.toString("utf8", p + 46, p + 46 + len));
      p += 46 + len + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return names;
  };
  const data = buildReportData({ date: "2026-10-16", analytics: ANALYTICS, categoryNames: NAMES });
  const book = buildReportWorkbook(data);
  const names = parts(book);
  ck("is a zip", book.readUInt32LE(0) === 0x04034b50);
  ck("has four charts: sent pie, approved pie, verdicts, sources",
    [1, 2, 3, 4].every((n) => names.includes(`xl/charts/chart${n}.xml`)) && !names.includes("xl/charts/chart5.xml"), names.join(" "));
  ck("has the drawing that places them", names.includes("xl/drawings/drawing1.xml"));

  const grid = parseXlsx(book);
  const flat = grid.map((r) => r.join("|"));
  ck("title cell", grid[0][0] === "PIX daily report");
  ck("category row with its numbers", flat.some((r) => r.startsWith("Sports|7|")), flat.join("\n"));
  ck("characters XML reserves survive", flat.some((r) => r.startsWith("Tech <AI> & More|3|")));
  ck("total row", flat.some((r) => r.startsWith("Total|12|1|")));

  const emptyBook = buildReportWorkbook(buildReportData({ date: "2026-10-16", analytics: { summary: {}, categories: [], sources: [] } }));
  const emptyNames = parts(emptyBook);
  ck("no data, no charts — an empty range opens as a blank frame", !emptyNames.some((n) => n.startsWith("xl/charts/")));
  ck("…and no drawing pointing at them", !emptyNames.includes("xl/drawings/drawing1.xml"));

  // More categories than hues: the pie reads its own folded table.
  const many = Array.from({ length: 11 }, (_, i) => ({ category_id: i + 1, sent_count: 20 - i, approved_count: 0, rejected_count: 0, pending_count: 20 - i }));
  const manyBook = buildReportWorkbook(buildReportData({ date: "2026-10-16", analytics: { summary: {}, categories: many, sources: [] } }));
  const manyGrid = parseXlsx(manyBook).map((r) => r.join("|"));
  ck("folded pie table with Other", manyGrid.some((r) => r.startsWith("Other (4 categories)|")), manyGrid.join("\n"));
  // Read the pie chart's XML straight out of the zip and count its slices.
  const pieXml = (() => {
    let eocd = manyBook.length - 22;
    while (manyBook.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    let p = manyBook.readUInt32LE(eocd + 16);
    for (let n = manyBook.readUInt16LE(eocd + 10); n > 0; n--) {
      const len = manyBook.readUInt16LE(p + 28);
      const name = manyBook.toString("utf8", p + 46, p + 46 + len);
      const local = manyBook.readUInt32LE(p + 42);
      if (name === "xl/charts/chart1.xml") {
        const start = local + 30 + manyBook.readUInt16LE(local + 26) + manyBook.readUInt16LE(local + 28);
        return inflateRawSync(manyBook.subarray(start, start + manyBook.readUInt32LE(p + 20))).toString("utf8");
      }
      p += 46 + len + manyBook.readUInt16LE(p + 30) + manyBook.readUInt16LE(p + 32);
    }
    return "";
  })();
  ck("pie has at most eight slices", (pieXml.match(/<c:dPt>/g) || []).length === 8);
  ck("slices show count and percentage", pieXml.includes('<c:showVal val="1"/>') && pieXml.includes('<c:showPercent val="1"/>'));
  ck("no number format that would zero the percentage", !/<c:dLbls><c:numFmt/.test(pieXml));
  ck("the eighth slice is grey", pieXml.includes('<c:idx val="7"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="94A3B8"/>'));
}

console.log("\nSending");
{
  const sent = [];
  const deps = {
    getAnalytics: async () => ANALYTICS,
    getCategoryNames: async () => { throw new Error("DailyMattr down"); },
    send: async (m) => {
      if (m.to.email === "bad@x.com") throw new Error("Brevo 400. invalid email");
      sent.push(m);
    },
  };
  const result = await sendDailyReport({
    date: "2026-10-16",
    recipients: [{ email: "a@x.com", name: "A" }, { email: "bad@x.com" }, { email: "c@x.com" }],
    deps,
  });
  ck("one failure does not stop the rest", result.sentCount === 2 && result.failedCount === 1);
  ck("the failure names the address", result.failures[0]?.email === "bad@x.com");
  ck("one email per person", sent.every((m) => m.to.email && !Array.isArray(m.to)));
  ck("each carries the workbook", sent.every((m) => m.attachments?.[0]?.name === "PIX-report-2026-10-16.xlsx"
    && m.attachments[0].content.readUInt32LE(0) === 0x04034b50));
  ck("DailyMattr being down still sends, with ids", sent[0].text.includes("Category 1"));
}

console.log("\nEvery stat is in the email body, with the charts");
{
  const many = Array.from({ length: 11 }, (_, i) => ({
    category_id: i + 1, sent_count: 20 - i, approved_count: 10 - Math.min(i, 9), rejected_count: 1, pending_count: 9 - i + Math.min(i, 9),
  }));
  const data = buildReportData({
    date: "2026-10-16",
    analytics: { summary: { sent_count: 165, approved_count: 56, rejected_count: 11, pending_count: 98, published_count: 50 }, categories: many, sources: Array.from({ length: 20 }, (_, i) => ({ value: `site${i}.com`, post_count: 30 - i })) },
  });
  const plain = buildReportEmail(data);
  ck("every category is in the table, not just the top few", ["Category 1", "Category 6", "Category 11"].every((n) => plain.html.includes(`>${n}</td>`)));
  ck("approval rate and published are in the summary", plain.html.includes("Approval rate") && plain.html.includes("Published to DailyMattr"));
  ck("verdict bars are drawn with table cells", plain.html.includes("Verdicts by category") && plain.html.includes(`background:#10a879;height:12px`));
  ck("top sources capped at fifteen", plain.html.includes(">site14.com</td>") && !plain.html.includes(">site15.com</td>"));
  ck("no pie images without uploaded charts", !plain.html.includes("<img"));
  ck("…but the pie keys and their numbers are still there", plain.html.includes("Sent to QA") && plain.html.includes("Approved by QA"));
  ck("folded categories are named under Other", /Category 8, Category 9, Category 10, Category 11/.test(plain.html));

  const withPies = buildReportEmail(data, { pieUrls: { sent: "https://cdn.example/s.png", approved: "https://cdn.example/a.png" } });
  ck("pie images when uploaded", withPies.html.includes('src="https://cdn.example/s.png"') && withPies.html.includes('src="https://cdn.example/a.png"'));
  ck("each pie image describes its numbers for readers without images", /alt="Sent to QA: Category 1 20 \(/.test(withPies.html));
  ck("plain-text part carries the category stats too", plain.text.includes("Category 1: 20") && plain.text.includes("site0.com: 30"));

  const uploads = [];
  const okDeps = {
    getAnalytics: async () => ANALYTICS,
    getCategoryNames: async () => NAMES,
    send: async (m) => { okDeps.sentHtml = m.html; },
    uploadChart: async (key, png) => { uploads.push({ key, png }); return `https://cdn.example/${key}`; },
  };
  const ok = await sendDailyReport({ date: "2026-10-16", recipients: [{ email: "a@x.com" }], deps: okDeps });
  ck("both pies are rendered and uploaded once", uploads.length === 2 && uploads.every((u) => u.png.readUInt32BE(0) === 0x89504e47));
  ck("the upload names carry the day and an unguessable part", uploads.every((u) => /^reports\/2026-10-16-[0-9a-f]{16}-(sent|approved)\.png$/.test(u.key)), uploads.map((u) => u.key).join(" "));
  ck("the sent email shows them", ok.chartsIncluded && okDeps.sentHtml.includes("https://cdn.example/reports/2026-10-16-"));

  const quietLog = { warn() {}, log() {} };
  const failDeps = {
    ...okDeps,
    log: quietLog,
    send: async (m) => { failDeps.sentHtml = m.html; },
    uploadChart: async () => { throw new Error("storage down"); },
  };
  const failed = await sendDailyReport({ date: "2026-10-16", recipients: [{ email: "a@x.com" }], deps: failDeps });
  ck("a failed chart upload still sends the email", failed.sentCount === 1 && !failed.chartsIncluded);
  ck("…without broken images", !failDeps.sentHtml.includes("<img"));
}

console.log("\nThe schedule sends once, and only what it claimed");
{
  const due = () => new Date("2026-10-17T04:00:00Z");
  const early = () => new Date("2026-10-17T03:00:00Z");
  const quiet = { log() {}, warn() {} };
  const make = (overrides = {}) => {
    const calls = { claim: 0, finish: [], send: 0 };
    const deps = {
      isReady: () => true,
      listRecipients: async () => [{ email: "a@x.com" }],
      claimRun: async (date) => { calls.claim++; calls.claimedDate = date; return { report_date: date }; },
      finishRun: async (date, r) => { calls.finish.push({ date, ...r }); },
      getAnalytics: async () => ANALYTICS,
      getCategoryNames: async () => NAMES,
      send: async () => { calls.send++; },
      ...overrides,
    };
    return { deps, calls };
  };

  {
    const { deps, calls } = make();
    const s = startDailyReportSchedule(deps, { log: quiet, clock: early, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("before 9:00 IST nothing happens", calls.claim === 0 && calls.send === 0);
  }
  {
    const { deps, calls } = make();
    const s = startDailyReportSchedule(deps, { log: quiet, clock: due, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("after 9:00 the day is claimed and sent", calls.claim === 1 && calls.send === 1);
    ck("it claims yesterday", calls.claimedDate === "2026-10-16");
    ck("the run is closed with the count", calls.finish[0]?.sentCount === 1);
  }
  {
    const { deps, calls } = make({ claimRun: async () => null });
    const s = startDailyReportSchedule(deps, { log: quiet, clock: due, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("a day already claimed elsewhere is not sent again", calls.send === 0 && calls.finish.length === 0);
  }
  {
    const { deps, calls } = make({ listRecipients: async () => [] });
    const s = startDailyReportSchedule(deps, { log: quiet, clock: due, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("an empty list claims nothing, so a later addition still gets the day", calls.claim === 0);
  }
  {
    const { deps, calls } = make({ claimRun: async () => { throw new Error("db down"); } });
    const s = startDailyReportSchedule(deps, { log: quiet, clock: due, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("a failed claim never writes to a run it does not own", calls.finish.length === 0);
  }
  {
    const { deps, calls } = make({ getAnalytics: async () => { throw new Error("query failed"); } });
    const s = startDailyReportSchedule(deps, { log: quiet, clock: due, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("a failure after claiming leaves the run open for a retry", calls.finish[0]?.sentCount === 0 && /query failed/.test(calls.finish[0]?.error));
  }
  {
    const { deps, calls } = make({ isReady: () => false });
    const s = startDailyReportSchedule(deps, { log: quiet, clock: due, intervalMs: 1e9 });
    await s.tick(); s.stop();
    ck("no email configured: nothing is claimed", calls.claim === 0);
  }
}

console.log("\nBrevo");
{
  const missing = brevoConfig({ BREVO_API_KEY: "" });
  ck("missing key is reported", !missing.ready && missing.missing.includes("BREVO_API_KEY"));
  ck("sender name defaults", brevoConfig({ BREVO_API_KEY: "k", BREVO_SENDER_EMAIL: "s@x.com" }).senderName === "PIX");

  const config = brevoConfig({ BREVO_API_KEY: "key-123", BREVO_SENDER_EMAIL: "reports@x.com", BREVO_SENDER_NAME: "PIX Reports" });
  let request = null;
  const okFetch = async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ messageId: "<m1>" }), { status: 201 }); };
  const id = await sendBrevoEmail(config, {
    to: { email: "a@x.com", name: "A" }, subject: "S", html: "<p>h</p>", text: "t",
    attachments: [{ name: "r.xlsx", content: Buffer.from("PK") }],
  }, { fetchImpl: okFetch });
  const body = JSON.parse(request.init.body);
  ck("returns the message id", id === "<m1>");
  ck("key goes in the api-key header", request.init.headers["api-key"] === "key-123");
  ck("one recipient per message", body.to.length === 1 && body.to[0].email === "a@x.com");
  ck("sender from the environment", body.sender.email === "reports@x.com" && body.sender.name === "PIX Reports");
  ck("attachment is base64", body.attachment[0].name === "r.xlsx" && body.attachment[0].content === Buffer.from("PK").toString("base64"));

  let err = "";
  try {
    await sendBrevoEmail(config, { to: { email: "a@x.com" }, subject: "S", html: "h" },
      { fetchImpl: async () => new Response(JSON.stringify({ message: "Key not found" }), { status: 401 }) });
  } catch (e) { err = e.message; }
  ck("a bad key says so, with Brevo's reason", /BREVO_API_KEY/.test(err) && /Key not found/.test(err), err);

  let notReady = "";
  try { await sendBrevoEmail(missing, { to: { email: "a@x.com" } }); } catch (e) { notReady = e.message; }
  ck("unconfigured send refuses before calling out", /not configured/.test(notReady));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
