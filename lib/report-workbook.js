import { deflateRawSync } from "node:zlib";

/* ── The daily report as an Excel workbook, with real charts ─────────────────

   The emailed report is an .xlsx with the Breakdown stats laid out as tables
   and three native Excel charts drawn from those same cells:

     Category share     a pie of posts sent per category
     Verdicts           stacked bars per category: approved / rejected / pending
     Top sources        bars of posts per source site

   Native charts — not pictures — so they stay sharp, can be restyled, and
   follow the numbers if someone edits a cell. That is also why this file
   writes the workbook itself: the common Node spreadsheet libraries read and
   write cells but cannot write charts. An .xlsx is a zip of XML parts; the
   parts are written below and zipped with Node's own zlib.

   Colours are the dashboard's: the Category share pie uses the same eight
   hues in the same order as the Analytics pie, and the verdict bars use the
   approved / rejected / pending tones from the status chart. */

export const REPORT_SHEET = "Report";

const PIE_HUES = ["2A78D6", "EB6834", "1BAF7A", "EDA100", "E87BA4", "008300", "6250D6", "E34948"];
const OTHER_HUE = "94A3B8";
const TONES = { approved: "10A879", rejected: "E45E6D", pending: "E79A25", sent: "3979FF" };
const PIE_SLOTS = 8;
const MAX_SOURCES = 15;

/* ── Zip ── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Exported for the tests, which build small workbooks of their own.
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // A fixed timestamp: 1 Jan 2024 00:00. The parts are generated, so there is
  // no meaningful modification time, and a fixed one keeps output identical.
  const dosTime = 0;
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/* ── Cells ── */

function esc(value) {
  return String(value ?? "")
    // Characters XML 1.0 cannot carry at all, which a scraped source name
    // could in principle contain.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Style ids — indexes into cellXfs in stylesXml().
const S = { plain: 0, title: 1, header: 2, text: 3, int: 4, pct: 5, note: 6, section: 7, totalText: 8, totalInt: 9, totalPct: 10 };

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<fonts count="5">
<font><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="18"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="13"/><color rgb="FF3979FF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF3979FF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="3" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/* A sheet built row by row. Cells are written inline — a string as an inline
   string, a number as a number — so there is no shared-strings part to keep
   in step. */
class Sheet {
  constructor() {
    this.rows = [];
  }

  // 1-based row number the next row() call will write.
  get next() {
    return this.rows.length + 1;
  }

  row(cells = [], height = null) {
    this.rows.push({ cells, height });
    return this.rows.length;
  }

  xml(cols, drawing) {
    const body = this.rows.map(({ cells, height }, r) => {
      const n = r + 1;
      const cellXml = cells.map((cell, c) => {
        if (cell === null || cell === undefined) return "";
        const { v, s = S.plain } = typeof cell === "object" ? cell : { v: cell };
        const ref = `${colLetter(c)}${n}`;
        if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${s}"/>`;
        if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join("");
      const ht = height ? ` ht="${height}" customHeight="1"` : "";
      return `<row r="${n}"${ht}>${cellXml}</row>`;
    }).join("");
    const colXml = cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>
<cols>${colXml}</cols>
<sheetData>${body}</sheetData>
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
${drawing ? '<drawing r:id="rId1"/>' : ""}
</worksheet>`;
  }
}

/* ── Charts ── */

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function range(col, from, to) {
  return `'${REPORT_SHEET}'!$${col}$${from}:$${col}$${to}`;
}

function strRef(ref, values) {
  return `<c:strRef><c:f>${esc(ref)}</c:f><c:strCache><c:ptCount val="${values.length}"/>${
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache></c:strRef>`;
}

function numRef(ref, values) {
  return `<c:numRef><c:f>${esc(ref)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join("")}</c:numCache></c:numRef>`;
}

function fill(hex) {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
}

function textProps(size = 1000, colour = "475569", bold = false) {
  return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
}

function chartTitle(text) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1300" b="1"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
}

function chartSpace(inner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
<c:roundedCorners val="0"/>
<c:chart>${inner}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr>
${textProps(1000)}
</c:chartSpace>`;
}

/* Every slice is labelled with its count over its percentage, outside the
   pie with a leader line — inside, a thin slice's two lines would not fit,
   and white text inside a pale slice would not read.

   No number format on the labels: a label's format applies to BOTH parts of
   it, so "#,##0" printed the percentage as 0. Left alone, Excel shows the
   count as the cell has it and the share in its own 0% format. */
function pieChartXml({ title, seriesName = "Posts", labels, values, hues, catRef, valRef }) {
  const points = hues.map((hex, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fill(hex)}<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join("");
  return chartSpace(`${chartTitle(title)}
<c:plotArea><c:layout/>
<c:pieChart><c:varyColors val="1"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${esc(seriesName)}</c:v></c:tx>${points}
<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${textProps(1000, "334155", true)}<c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:separator>
</c:separator><c:showLeaderLines val="1"/></c:dLbls>
<c:cat>${strRef(catRef, labels)}</c:cat><c:val>${numRef(valRef, values)}</c:val>
</c:ser><c:firstSliceAng val="0"/></c:pieChart>
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>
</c:plotArea>
<c:legend><c:legendPos val="r"/><c:overlay val="0"/>${textProps(1000, "334155")}</c:legend>`);
}

/* Horizontal bars, largest at the top. Excel draws a bar chart's categories
   bottom-up, so the category axis runs maxMin and the value axis is moved to
   cross at the maximum category — which, with that axis reversed, is the
   bottom edge where a reader expects the scale. */
function barChartXml({ title, labels, series, catRef, stacked = false, showValues = false }) {
  const ser = series.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx><c:spPr>${fill(s.hue)}</c:spPr><c:invertIfNegative val="0"/>${
    showValues ? `<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${textProps(900, "334155")}<c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` : ""
  }<c:cat>${strRef(catRef, labels)}</c:cat><c:val>${numRef(s.ref, s.values)}</c:val></c:ser>`).join("");
  return chartSpace(`${chartTitle(title)}
<c:plotArea><c:layout/>
<c:barChart><c:barDir val="bar"/><c:grouping val="${stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>${ser}
<c:gapWidth val="60"/>${stacked ? '<c:overlap val="100"/>' : ""}<c:axId val="5001"/><c:axId val="5002"/></c:barChart>
<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln></c:spPr>${textProps(1000, "334155")}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>
<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${textProps(900, "64748B")}<c:crossAx val="5001"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>
</c:plotArea>
${series.length > 1 ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${textProps(1000, "334155")}</c:legend>` : ""}`);
}

function drawingXml(anchors) {
  const frames = anchors.map((a, i) => `<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${a.col + a.cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row + a.rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${esc(a.name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame>
<xdr:clientData/>
</xdr:twoCellAnchor>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${frames}</xdr:wsDr>`;
}

function rels(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
}

/* ── The report ── */

/**
 * Build the report workbook.
 *
 * `report` is the shape buildReportData() in lib/daily-report.js returns:
 *   { title, periodLabel, generatedLabel, summary, categories, sources }
 * with categories as [{ name, sent, approved, rejected, pending }] sorted
 * largest first, and sources as [{ name, posts }].
 *
 * Returns the .xlsx as a Buffer.
 */
export function buildReportWorkbook(report) {
  const sheet = new Sheet();
  const summary = report.summary || {};
  const categories = report.categories || [];
  const sources = (report.sources || []).slice(0, MAX_SOURCES);
  const totalSent = categories.reduce((sum, c) => sum + c.sent, 0);

  sheet.row([{ v: report.title || "PIX report", s: S.title }], 30);
  sheet.row([{ v: report.periodLabel || "", s: S.note }]);
  sheet.row([{ v: report.generatedLabel || "", s: S.note }]);
  sheet.row([]);

  // Summary
  sheet.row([{ v: "Summary", s: S.section }], 22);
  sheet.row([{ v: "Metric", s: S.header }, { v: "Value", s: S.header }]);
  const sent = Number(summary.sent_count) || 0;
  sheet.row([{ v: "Posts sent", s: S.text }, { v: sent, s: S.int }]);
  sheet.row([{ v: "Approved", s: S.text }, { v: Number(summary.approved_count) || 0, s: S.int }]);
  sheet.row([{ v: "Rejected", s: S.text }, { v: Number(summary.rejected_count) || 0, s: S.int }]);
  sheet.row([{ v: "Pending review", s: S.text }, { v: Number(summary.pending_count) || 0, s: S.int }]);
  sheet.row([{ v: "Approval rate", s: S.text }, { v: sent ? (Number(summary.approved_count) || 0) / sent : 0, s: S.pct }]);
  sheet.row([{ v: "Published to DailyMattr", s: S.text }, { v: Number(summary.published_count) || 0, s: S.int }]);
  sheet.row([]);

  // By category
  sheet.row([{ v: "By category", s: S.section }], 22);
  /* Columns A–F are what the charts read (D–F feed the verdict bars), so the
     two rate columns go after them rather than between. "Share of approved"
     is the category's slice of the approved pie; "Approval rate" is how many
     of the category's own sent posts were approved — the two answer
     different questions and are easy to mix up, so both are spelled out. */
  const totalApproved = categories.reduce((s, c) => s + c.approved, 0);
  sheet.row(["Category", "Posts sent", "Share", "Approved", "Rejected", "Pending", "Share of approved", "Approval rate"]
    .map((v) => ({ v, s: S.header })));
  const catFirst = sheet.next;
  for (const c of categories) {
    sheet.row([
      { v: c.name, s: S.text },
      { v: c.sent, s: S.int },
      { v: totalSent ? c.sent / totalSent : 0, s: S.pct },
      { v: c.approved, s: S.int },
      { v: c.rejected, s: S.int },
      { v: c.pending, s: S.int },
      { v: totalApproved ? c.approved / totalApproved : 0, s: S.pct },
      { v: c.sent ? c.approved / c.sent : 0, s: S.pct },
    ]);
  }
  const catLast = sheet.next - 1;
  if (categories.length) {
    const sum = (key) => categories.reduce((s, c) => s + c[key], 0);
    sheet.row([
      { v: "Total", s: S.totalText },
      { v: totalSent, s: S.totalInt },
      { v: totalSent ? 1 : 0, s: S.totalPct },
      { v: sum("approved"), s: S.totalInt },
      { v: sum("rejected"), s: S.totalInt },
      { v: sum("pending"), s: S.totalInt },
      { v: totalApproved ? 1 : 0, s: S.totalPct },
      { v: totalSent ? totalApproved / totalSent : 0, s: S.totalPct },
    ]);
  } else {
    sheet.row([{ v: "No posts were sent in this period.", s: S.note }]);
  }
  sheet.row([]);

  /* Two pies, like the Breakdown page: each category's share of the posts
     sent, and its share of the posts approved.

     Each takes at most eight slices. With more categories the smallest by
     posts sent fold into "Other" in BOTH pies, and a category keeps the same
     colour in both — the hues are handed out from the sent ranking and the
     approved pie borrows them. A folded pie reads its own small table, so the
     full category list above stays whole.

     The approved pie always reads a table of its own: sorted by approvals,
     and without the categories that had none, which would otherwise sit in
     the pie as empty slices carrying a stray "0, 0%" label. */
  let pie = null;
  let approvedPie = null;
  if (categories.length) {
    const folds = categories.length > PIE_SLOTS;
    const named = folds ? categories.slice(0, PIE_SLOTS - 1) : categories;
    const rest = folds ? categories.slice(PIE_SLOTS - 1) : [];
    const hueOf = new Map(named.map((c, i) => [c.name, PIE_HUES[i]]));
    const otherLabel = `Other (${rest.length} ${rest.length === 1 ? "category" : "categories"})`;
    const chartTable = (heading, valueHeader, slices) => {
      sheet.row([{ v: heading, s: S.section }], 22);
      sheet.row([{ v: "Category", s: S.header }, { v: valueHeader, s: S.header }]);
      const first = sheet.next;
      for (const [name, n] of slices) sheet.row([{ v: name, s: S.text }, { v: n, s: S.int }]);
      const last = sheet.next - 1;
      sheet.row([]);
      return { catRef: range("A", first, last), valRef: range("B", first, last) };
    };

    if (!folds) {
      pie = {
        labels: categories.map((c) => c.name),
        values: categories.map((c) => c.sent),
        hues: categories.map((c) => hueOf.get(c.name)),
        catRef: range("A", catFirst, catLast),
        valRef: range("B", catFirst, catLast),
      };
    } else {
      const slices = [...named.map((c) => [c.name, c.sent]), [otherLabel, rest.reduce((s, c) => s + c.sent, 0)]];
      pie = {
        labels: slices.map(([name]) => name),
        values: slices.map(([, n]) => n),
        hues: slices.map(([name]) => hueOf.get(name) || OTHER_HUE),
        ...chartTable("Sent pie (chart data)", "Posts sent", slices),
      };
    }

    const approvedSlices = named
      .filter((c) => c.approved > 0)
      .sort((a, b) => b.approved - a.approved)
      .map((c) => [c.name, c.approved]);
    const restApproved = rest.reduce((s, c) => s + c.approved, 0);
    if (restApproved) approvedSlices.push([otherLabel, restApproved]);
    if (approvedSlices.length) {
      approvedPie = {
        labels: approvedSlices.map(([name]) => name),
        values: approvedSlices.map(([, n]) => n),
        hues: approvedSlices.map(([name]) => hueOf.get(name) || OTHER_HUE),
        ...chartTable("Approved pie (chart data)", "Approved", approvedSlices),
      };
    }
  }

  // Top sources
  sheet.row([{ v: "Top sources", s: S.section }], 22);
  sheet.row([{ v: "Source", s: S.header }, { v: "Posts", s: S.header }]);
  const srcFirst = sheet.next;
  for (const s of sources) sheet.row([{ v: s.name, s: S.text }, { v: s.posts, s: S.int }]);
  const srcLast = sheet.next - 1;
  if (!sources.length) sheet.row([{ v: "No sources in this period.", s: S.note }]);

  /* Charts sit to the right of the tables, from column J, stacked down the
     sheet. Each is only added when it has something to draw — a chart over
     an empty range opens in Excel as a blank frame. */
  const charts = [];
  const anchors = [];
  let chartRow = 4;
  const addChart = (xml, name, rows) => {
    charts.push(xml);
    anchors.push({ name, col: 9, row: chartRow, cols: 8, rows });
    chartRow += rows + 1;
  };
  if (approvedPie) {
    // Sent first, approved straight under it, so the two read as a pair.
    addChart(pieChartXml({ title: "Sent to QA by category", seriesName: "Posts sent", ...pie }), "Sent to QA by category", 20);
    addChart(pieChartXml({ title: "Approved by QA by category", seriesName: "Approved", ...approvedPie }), "Approved by QA by category", 20);
  } else if (pie) {
    addChart(pieChartXml({ title: "Sent to QA by category", seriesName: "Posts sent", ...pie }), "Sent to QA by category", 20);
  }
  if (pie) {
    const catRef = range("A", catFirst, catLast);
    const labels = categories.map((c) => c.name);
    addChart(barChartXml({
      title: "Verdicts by category",
      labels,
      catRef,
      stacked: true,
      series: [
        { name: "Approved", hue: TONES.approved, ref: range("D", catFirst, catLast), values: categories.map((c) => c.approved) },
        { name: "Rejected", hue: TONES.rejected, ref: range("E", catFirst, catLast), values: categories.map((c) => c.rejected) },
        { name: "Pending", hue: TONES.pending, ref: range("F", catFirst, catLast), values: categories.map((c) => c.pending) },
      ],
    }), "Verdicts by category", Math.max(14, Math.min(28, 6 + categories.length * 1.4 | 0)));
  }
  if (sources.length) {
    addChart(barChartXml({
      title: "Top sources",
      labels: sources.map((s) => s.name),
      catRef: range("A", srcFirst, srcLast),
      showValues: true,
      series: [{ name: "Posts", hue: TONES.sent, ref: range("B", srcFirst, srcLast), values: sources.map((s) => s.posts) }],
    }), "Top sources", Math.max(12, Math.min(26, 5 + sources.length * 1.2 | 0)));
  }

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${charts.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}
${charts.map((_, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join("\n")}
</Types>`,
    },
    { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "xl/workbook.xml"]]) },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><bookViews><workbookView/></bookViews><sheets><sheet name="${REPORT_SHEET}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "styles", "styles.xml"]]),
    },
    { name: "xl/styles.xml", data: stylesXml() },
    { name: "xl/worksheets/sheet1.xml", data: sheet.xml([32, 12, 9, 11, 11, 11, 17, 14, 3], charts.length > 0) },
  ];
  if (charts.length) {
    files.push(
      { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels([["rId1", "drawing", "../drawings/drawing1.xml"]]) },
      { name: "xl/drawings/drawing1.xml", data: drawingXml(anchors) },
      { name: "xl/drawings/_rels/drawing1.xml.rels", data: rels(charts.map((_, i) => [`rId${i + 1}`, "chart", `../charts/chart${i + 1}.xml`])) },
      ...charts.map((xml, i) => ({ name: `xl/charts/chart${i + 1}.xml`, data: xml })),
    );
  }
  return zip(files);
}
