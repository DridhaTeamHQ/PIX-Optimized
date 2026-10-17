import { inflateRawSync } from "node:zlib";

/* ── Report recipients from a CSV or Excel file ──────────────────────────────

   An admin can add the people who receive the daily report in bulk by
   uploading a spreadsheet. Every row needs an email; a name is optional.

   Both formats are read here rather than through a package. A CSV is text,
   and an .xlsx is a zip of XML files — Node's own zlib inflates the zip, and
   the two or three XML parts that hold the first sheet are read with a few
   regular expressions. That avoids four new dependencies for what is, in the
   end, a list of email addresses. The old binary .xls format is not
   supported: the admin is told to save the file as .xlsx or .csv instead.

   The columns are found the way a person would find them. If an early row
   has a cell that reads "email" (or "e-mail", "mail id", …) that row is the
   header, and the email and name columns are the ones it names. Without a
   header, each row's email is whichever cell looks like an address, and its
   name is the first other cell with text in it. */

export const MAX_RECIPIENT_ROWS = 5000;
// An .xlsx inflates to many times its size; a few MB of XML is already a
// very large address list, and anything past this is not a recipient file.
const MAX_INFLATED_BYTES = 20 * 1024 * 1024;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[a-z]{2,}$/i;
const EMAIL_HEADER_RE = /^(e-?mail|mail)(\s*(id|address|addr))?$/i;
const NAME_HEADER_RE = /^((full|first|recipient|contact|person)\s*)?name$/i;

/* An address as it should be stored: trimmed, lower-cased, with a pasted
   "mailto:" or angle brackets removed — or null when it is not an address. */
export function cleanEmail(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^<(.*)>$/, "$1")
    .trim()
    .toLowerCase();
  return text.length <= 254 && EMAIL_RE.test(text) ? text : null;
}

export function cleanName(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : null;
}

/* ── CSV ── */

// Comma, semicolon (what Excel writes in many European locales) or tab —
// whichever the first line uses most.
function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function parseCsv(input) {
  const text = String(input ?? "").replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/* ── XLSX ── */

function zipReader(buf) {
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file is not a valid .xlsx workbook.");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("This .xlsx workbook is damaged.");
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }

  return (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    const l = entry.localOffset;
    if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error("This .xlsx workbook is damaged.");
    const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
    const data = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data.toString("utf8");
    if (entry.method === 8) {
      return inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
    }
    throw new Error("This .xlsx workbook uses a compression method that cannot be read.");
  };
}

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Every <t> run inside one shared string or inline string, joined — rich
// text splits a single cell's words across several runs.
function textRuns(xml) {
  let out = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref || "")?.[0]?.toUpperCase() || "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// The first sheet in the workbook's own order, which is the tab Excel opens on.
function firstSheetPath(read) {
  const workbook = read("xl/workbook.xml");
  const rels = read("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook);
    if (sheet) {
      for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
        const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
        if (id === sheet[1] && target) {
          return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
        }
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

export function parseXlsx(buf) {
  const read = zipReader(buf);
  const sheetXml = read(firstSheetPath(read));
  if (!sheetXml) throw new Error("This workbook has no sheet that can be read.");

  const sharedXml = read("xl/sharedStrings.xml") || "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));

  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    const body = rowMatch[1] || "";
    for (const cell of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const inner = cell[2] || "";
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || "n";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textRuns(inner);
      else if (raw !== undefined) value = decodeXml(raw);
      const index = ref ? columnIndex(ref) : row.length;
      row[index] = value;
    }
    rows.push(Array.from(row, (v) => v ?? ""));
    if (rows.length > MAX_RECIPIENT_ROWS + 10) break;
  }
  return rows;
}

/* ── Rows to recipients ── */

function findHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, 5); r++) {
    const cells = grid[r].map((c) => String(c ?? "").trim());
    const emailCol = cells.findIndex((c) => EMAIL_HEADER_RE.test(c) || /\be-?mail\b/i.test(c));
    if (emailCol === -1 || cleanEmail(cells[emailCol])) continue;
    const nameCol = cells.findIndex((c, i) => i !== emailCol && NAME_HEADER_RE.test(c));
    return { row: r, emailCol, nameCol };
  }
  return null;
}

/**
 * The recipients a grid of cells describes.
 *
 * Returns every distinct valid address with its name (or null), plus the
 * rows that were passed over and why, so the admin can fix their file
 * rather than wonder where someone went.
 */
export function recipientsFromGrid(grid) {
  const header = findHeader(grid);
  const recipients = [];
  const skipped = [];
  const seen = new Set();

  for (let r = header ? header.row + 1 : 0; r < grid.length; r++) {
    const cells = (grid[r] || []).map((c) => String(c ?? "").trim());
    if (!cells.some(Boolean)) continue;
    const line = r + 1;

    let email = null;
    let name = null;
    if (header) {
      email = cleanEmail(cells[header.emailCol]);
      name = header.nameCol >= 0 ? cleanName(cells[header.nameCol]) : null;
      if (!email && cells[header.emailCol]) {
        skipped.push({ row: line, value: cells[header.emailCol], reason: "Not a valid email address" });
        continue;
      }
    } else {
      const emailAt = cells.findIndex((c) => cleanEmail(c));
      email = emailAt >= 0 ? cleanEmail(cells[emailAt]) : null;
      name = cleanName(cells.find((c, i) => i !== emailAt && c && !c.includes("@")));
    }

    if (!email) {
      skipped.push({ row: line, value: cells.filter(Boolean).join(", ").slice(0, 80), reason: "No email address" });
      continue;
    }
    if (seen.has(email)) {
      skipped.push({ row: line, value: email, reason: "Listed twice in this file" });
      continue;
    }
    seen.add(email);
    recipients.push({ email, name });
    if (recipients.length > MAX_RECIPIENT_ROWS) {
      throw new Error(`A file can add at most ${MAX_RECIPIENT_ROWS} people at a time.`);
    }
  }
  return { recipients, skipped };
}

/* The whole path from an uploaded file to recipients. The format is decided
   by the file's own bytes first — an .xlsx always starts with the zip
   signature "PK" — and by its name only when that is not conclusive. */
export function recipientsFromFile(buffer, filename = "") {
  const name = String(filename || "").toLowerCase();
  const isZip = buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
  if (name.endsWith(".xls") && !isZip) {
    throw new Error("Old .xls files cannot be read. Save it as .xlsx or .csv and upload that.");
  }
  const grid = isZip ? parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
  return recipientsFromGrid(grid);
}
