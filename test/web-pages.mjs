/* ── Cards copied to our bucket for the website ─────────────────────────────

   Run: node test/web-pages.mjs

   Two things are checked. First the header reader: the website reserves each
   card's box from the recorded width and height, so a wrong size is a page
   that jumps as pictures load, and a missing one is a box of the wrong shape.
   Second the copy itself, with a fake uploader: which parts are copied, in
   what order, under what key, and what is recorded — the things that are
   easy to get quietly wrong and impossible to see from the publish dialog. */

import { imageSize } from "../lib/image-size.js";
import { copyCardsToWeb, webCardKey, isPictureCard } from "../lib/web-cards.js";

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + (d ? " — " + d : "")); }
};

/* ── synthetic headers ──────────────────────────────────────────────────── */

function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

/* SOI, an APP0 segment to skip over, then SOF0 carrying the size. */
function jpegHeader(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(9, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

function webpVP8X(w, h) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0); b.write("WEBP", 8); b.write("VP8X", 12);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

function webpVP8L(w, h) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0); b.write("WEBP", 8); b.write("VP8L", 12);
  b[20] = 0x2f;
  b.writeUInt32LE(((h - 1) << 14) | (w - 1), 21);
  return b;
}

function webpVP8(w, h) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0); b.write("WEBP", 8); b.write("VP8 ", 12);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
}

console.log("imageSize");
{
  const cases = [
    ["png 920x1700", pngHeader(920, 1700)],
    ["jpeg 920x1700 (after APP0)", jpegHeader(920, 1700)],
    ["webp VP8X 920x1700", webpVP8X(920, 1700)],
    ["webp VP8L 920x1700", webpVP8L(920, 1700)],
    ["webp VP8 920x1700", webpVP8(920, 1700)],
  ];
  for (const [name, buf] of cases) {
    const s = imageSize(buf);
    ck(name, s && s.width === 920 && s.height === 1700, JSON.stringify(s));
  }
  ck("garbage -> null", imageSize(Buffer.from("not an image at all, sorry")) === null);
  ck("too short -> null", imageSize(Buffer.from([0xff, 0xd8])) === null);
  ck("jpeg with no frame -> null", imageSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(12)])) === null);
}

console.log("\nwhich parts are cards");
{
  const jpg = { fieldName: "media_page_1", page: 1, contentType: "image/jpeg", buffer: jpegHeader(920, 1700) };
  const mp4 = { fieldName: "media_page_3", page: 3, contentType: "video/mp4", buffer: Buffer.alloc(64) };
  ck("a jpeg part is a card", isPictureCard(jpg));
  ck("a video part is not", !isPictureCard(mp4));
  ck("an empty buffer is not", !isPictureCard({ contentType: "image/png", buffer: Buffer.alloc(0) }));
  ck("a missing part is not", !isPictureCard(undefined));
}

console.log("\nweb key");
{
  const k = webCardKey("11111111-2222-3333-4444-555555555555", 2, "image/jpeg", "abc");
  ck("path is web/<pix>/<slot>-<id><ext>", k === "web/11111111-2222-3333-4444-555555555555/2-abc.jpg", k);
  ck("unknown type gets no extension", webCardKey("p", 1, "application/octet-stream", "x") === "web/p/1-x");
  ck("random part differs per call", webCardKey("p", 1, "image/png") !== webCardKey("p", 1, "image/png"));
}

console.log("\ncopyCardsToWeb");
{
  const uploaded = [];
  const upload = async (key, body, type) => { uploaded.push({ key, bytes: body.length, type }); return "https://bucket.test/" + key; };
  const files = [
    { fieldName: "media_page_2", page: 2, contentType: "image/jpeg", buffer: jpegHeader(920, 1700) },
    { fieldName: "media_page_1", page: 1, contentType: "image/png", buffer: pngHeader(920, 1700) },
    { fieldName: "media_page_3", page: 3, contentType: "video/mp4", buffer: Buffer.alloc(100) },
  ];
  const pages = await copyCardsToWeb({ pixId: "pix-1", files, upload });
  ck("only the two pictures are copied", pages.length === 2 && uploaded.length === 2, JSON.stringify(pages));
  ck("poster (page 1) comes first whatever the input order", pages[0].sort_order === 1 && pages[1].sort_order === 2);
  ck("url is what the uploader returned", pages[0].url === "https://bucket.test/" + uploaded[0].key);
  ck("keys carry the slot and the type", /^web\/pix-1\/1-[0-9a-f-]+\.png$/.test(uploaded[0].key) && /^web\/pix-1\/2-[0-9a-f-]+\.jpg$/.test(uploaded[1].key), uploaded.map((u) => u.key).join(" "));
  ck("size is recorded", pages[0].width === 920 && pages[0].height === 1700 && pages[1].width === 920);
  ck("bytes and type are recorded", pages[0].bytes === 33 && pages[0].type === "image/png");

  const none = await copyCardsToWeb({ pixId: "pix-2", files: [files[2]], upload });
  ck("video-only publish copies nothing", none.length === 0);

  let threw = false;
  try { await copyCardsToWeb({ pixId: "", files, upload }); } catch { threw = true; }
  ck("no pix id is refused", threw);

  let failed = false;
  const flaky = async (key) => { if (key.startsWith("web/pix-3/2-")) throw new Error("bucket said no"); return "https://bucket.test/" + key; };
  try { await copyCardsToWeb({ pixId: "pix-3", files, upload: flaky }); } catch (e) { failed = /bucket said no/.test(e.message); }
  ck("one failed upload fails the batch (all-or-nothing)", failed);

  const unsized = await copyCardsToWeb({ pixId: "pix-4", files: [{ page: 1, contentType: "image/jpeg", buffer: Buffer.from("xx") }], upload });
  ck("unreadable header -> no width/height, still recorded", unsized.length === 1 && !("width" in unsized[0]) && unsized[0].url);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
