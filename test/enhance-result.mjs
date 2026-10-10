/* ── Collecting the enhanced picture, instead of posting it home ────────────

   Run: node test/enhance-result.mjs

   The bug this covers cost real money and was invisible from the error:

       ✓ AI reframe done in 53180ms (gpt-image-1.5, 1024x1536, quality=high)
         — $0.3297
       ✗ upscale-image error: Error: aborted … ECONNRESET      (60.002s later)

   gpt-image answered, the picture was billed, and then the ~5MB
   `data:image/png;base64,…` in the JSON could not be flushed inside the
   sixty seconds the platform proxy allows a response. The reviewer was shown
   "Reframe failed: HTTP 502" — a status with no sentence, because what
   actually answered them was the proxy's own error page and there was no
   JSON in it for the client to read a message out of.

   Stage 2 now answers with an address and the bytes are collected separately.
   What is held down here is the part that makes that safe rather than merely
   smaller:

     - the stored payload carries NO image field, so a cache hit cannot hand
       back a token that has already expired;
     - a hit mints a FRESH token for the same bytes;
     - an unknown or expired token is a 404 with a sentence, never a throw;
     - the browser turns the address back into a data: URL before anything
       else sees it — describeMainImage() reads that src to decide whether a
       picture still needs uploading on Save, so a picture left as a URL would
       publish and then lose itself when the token died an hour later.        */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/* Newlines normalised on the way in. These files are edited on Windows and
   carry CRLF; a brace-matching slice looking for "\n}\n" silently finds
   nothing against "\r\n}\r\n" and every assertion downstream then passes or
   fails on an empty string rather than on the code. */
const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), "utf8").replace(/\r\n/g, "\n");
const server = read("..", "server.mjs");
const app = read("..", "public", "app.js");

function fnSrc(name) {
  const a = server.indexOf("function " + name);
  if (a < 0) throw new Error("missing function " + name);
  let k = server.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < server.length; j++) {
    if (server[j] === "{") d++;
    else if (server[j] === "}") { d--; if (!d) return server.slice(a, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

let pass = 0, fail = 0;
function ck(label, ok, extra = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`); }
}

/* Read from the source rather than restated here — a test that hard-codes the
   value it checks only proves the file was edited twice. */
const TTL = new Function(
  `return ${server.match(/const ENHANCE_CACHE_TTL_MS = ([^;]+);/)[1].replace(/_/g, "")}`,
)();
const RESULT_PATH = server.match(/const ENHANCE_RESULT_PATH = "([^"]+)"/)[1];

/* A small cap, so eviction is reachable without allocating 96MB in a test.
   The behaviour under the cap is what is being checked, not the number. */
const CAP = 4096;

function build() {
  const sent = [];
  const sendJson = (res, status, payload) => { sent.push({ status, payload }); };
  const api = new Function(
    "randomUUID", "sendJson", "ENHANCE_CACHE_TTL_MS", "ENHANCE_CACHE_MAX_BYTES", `
      const ENHANCE_RESULT_PATH = ${JSON.stringify(RESULT_PATH)};
      const enhanceResults = new Map();
      let enhanceResultBytes = 0;
      const enhanceCache = new Map();
      let enhanceCacheBytes = 0;
      ${fnSrc("publishEnhanceResult")}
      ${fnSrc("handleEnhanceResult")}
      ${fnSrc("enhanceCacheGet")}
      ${fnSrc("enhanceCacheSet")}
      return {
        publishEnhanceResult, handleEnhanceResult, enhanceCacheGet, enhanceCacheSet,
        results: enhanceResults,
        bytes: () => enhanceResultBytes,
        cacheBytes: () => enhanceCacheBytes,
      };
    `,
  )(randomUUID, sendJson, TTL, CAP);
  return { ...api, sent };
}

function mockRes() {
  const r = { status: 0, headers: null, body: null };
  return {
    writeHead(status, headers) { r.status = status; r.headers = headers; },
    end(body) { r.body = body; },
    _: r,
  };
}

const png = (n, fill = 0xAB) => Buffer.alloc(n, fill);

console.log("\nPublishing and collecting");
{
  const api = build();
  const url = api.publishEnhanceResult(png(500));

  ck("the answer is an address, not an image",
     url.startsWith(RESULT_PATH + "/") && !url.startsWith("data:"), url.slice(0, 40));
  ck("and a short one — this is the whole point of the change",
     url.length < 100, url.length + " chars");
  ck("the token is a v4 UUID, so it cannot be guessed or enumerated",
     /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
       .test(url.slice(RESULT_PATH.length + 1)));

  const res = mockRes();
  api.handleEnhanceResult({ url }, res);
  ck("collecting it returns 200", res._.status === 200, String(res._.status));
  ck("as image/png", res._.headers["Content-Type"] === "image/png");
  ck("with a Content-Length matching the bytes", res._.headers["Content-Length"] === 500);
  ck("and the bytes are the ones that went in", Buffer.compare(res._.body, png(500)) === 0);
  ck("cached privately — it is one reviewer's unpublished picture",
     /private/.test(res._.headers["Cache-Control"]));
  ck("and not sniffable into another type",
     res._.headers["X-Content-Type-Options"] === "nosniff");

  // A query string is not part of the token. A cache-buster appended by a
  // browser or a proxy must not turn a live picture into a 404.
  const res2 = mockRes();
  api.handleEnhanceResult({ url: url + "?v=2" }, res2);
  ck("a trailing query string does not break the lookup", res2._.status === 200);
}

console.log("\nMisses answer, they do not throw");
{
  const api = build();
  const res = mockRes();
  api.handleEnhanceResult({ url: `${RESULT_PATH}/${randomUUID()}` }, res);
  ck("an unknown token is a 404 and not a crash", api.sent.length === 1 && api.sent[0].status === 404);
  ck("and it says what to do about it",
     /expired|press enhance again/i.test(api.sent[0].payload.error), api.sent[0].payload.error);

  /* After a redeploy every token in the process is gone. That has to read as
     "press again", not as a fault — the reviewer has done nothing wrong. */
  const api2 = build();
  const url = api2.publishEnhanceResult(png(100));
  api2.results.get(url.slice(RESULT_PATH.length + 1)).at = Date.now() - TTL - 1;
  const res2 = mockRes();
  api2.handleEnhanceResult({ url }, res2);
  ck("an expired token is a 404 too", api2.sent.length === 1 && api2.sent[0].status === 404);
  ck("and it is dropped rather than left to rot", api2.results.size === 0);
}

console.log("\nThe store stays inside its ceiling");
{
  const api = build();
  api.publishEnhanceResult(png(1500, 1));
  api.publishEnhanceResult(png(1500, 2));
  ck("two fit under the cap", api.results.size === 2, api.bytes() + " bytes");
  api.publishEnhanceResult(png(1500, 3));
  ck("a third evicts the oldest rather than growing without limit",
     api.results.size === 2 && api.bytes() <= CAP, `${api.results.size} entries, ${api.bytes()} bytes`);

  /* Expired entries are free to drop, so they go before anything still live
     is evicted — otherwise a slow hour of work discards its own newest
     results to make room for corpses. */
  const api2 = build();
  const stale = api2.publishEnhanceResult(png(1500, 9));
  api2.results.get(stale.slice(RESULT_PATH.length + 1)).at = Date.now() - TTL - 1;
  api2.publishEnhanceResult(png(1500, 8));
  api2.publishEnhanceResult(png(1500, 7));
  ck("the expired one is swept, and both live ones survive",
     api2.results.size === 2 && !api2.results.has(stale.slice(RESULT_PATH.length + 1)),
     api2.results.size + " entries");
}

console.log("\nThe cache holds bytes, and a hit mints a new address");
{
  const api = build();
  const payload = { mode: "reframe", quality: "high", cost: { usd: 0.3297 } };
  api.enhanceCacheSet("k1", payload, png(800));

  const hit = api.enhanceCacheGet("k1");
  ck("a hit returns the entry, not a bare payload", Boolean(hit && hit.payload && hit.png));
  ck("the bytes survive the round trip", Buffer.compare(hit.png, png(800)) === 0);
  ck("the cap is measured on the PNG, not on a base64 string a third larger",
     api.cacheBytes() === 800, api.cacheBytes() + " bytes for an 800-byte image");

  /* The invariant that makes a hit safe. If the stored payload carried the
     URL it was first served under, a hit an hour later would hand back a
     token whose bytes had already been swept — a free result that fails. */
  ck("the STORED payload carries no image field",
     !("image" in hit.payload), JSON.stringify(Object.keys(hit.payload)));

  const a = api.publishEnhanceResult(hit.png);
  const b = api.publishEnhanceResult(hit.png);
  ck("each hit can mint a fresh address for the same bytes", a !== b);

  ck("a miss is null, so the caller pays rather than serving nothing",
     api.enhanceCacheGet("never-stored") === null);

  const api2 = build();
  api2.enhanceCacheSet("k2", { mode: "restore" }, png(CAP * 2));
  ck("an image larger than the whole cache is not stored at all",
     api2.enhanceCacheGet("k2") === null);
}

console.log("\nserver.mjs wires it up");
{
  ck("the result route is registered as a GET",
     /req\.method === "GET" && req\.url\?\.startsWith\(`\$\{ENHANCE_RESULT_PATH\}\/`\)/.test(server));
  ck("it lives under /api/, so the deny-by-default session gate covers it",
     RESULT_PATH.startsWith("/api/"), RESULT_PATH);
  ck("it is not in the public allowlist — a token alone must not be enough",
     !new RegExp(`PUBLIC_API_ROUTES[\\s\\S]{0,400}${RESULT_PATH}`).test(server));
  ck("the paid path caches BEFORE it answers, so a lost response is recoverable",
     server.indexOf("enhanceCacheSet(cacheKey, payload, png)")
       < server.indexOf("return { ...payload, image: publishEnhanceResult(png) }"));
  ck("the base64 is decoded once and carried as bytes",
     /const png = Buffer\.from\(b64, "base64"\)/.test(server));
  ck("no data: URL is built into the payload any more",
     !/image: `data:image\/png;base64,\$\{b64\}`/.test(server));
}

console.log("\napp.js collects it, and restores the data: URL invariant");
{
  ck("runImageAI collects the picture from the address",
     /const imageSrc = await collectEnhancedImage\(data\.image\)/.test(app));
  ck("and loads THAT, not the raw response field",
     /returned\.src = imageSrc;/.test(app) && !/returned\.src = data\.image;/.test(app));

  const fn = app.slice(app.indexOf("async function collectEnhancedImage"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  /* describeMainImage() reads `state.mainImage.src`: a data: URL means the
     picture still has to be uploaded on Save. Left as a token URL it would be
     filed as an address that already exists — and then stop answering. */
  ck("it converts the bytes back into a data: URL", /blobToDataUrl/.test(body));
  ck("a data: URL is passed through, so an older server still works",
     /startsWith\("data:"\)\s*\)\s*return src/.test(body));
  ck("a failed collection reports the server's sentence, not just a status",
     /resp\.json\(\)/.test(body) && /HTTP \$\{resp\.status\}/.test(body));
  ck("blobToDataUrl is shared with canvasToImage rather than duplicated",
     /async function canvasToImage[\s\S]{0,220}await blobToDataUrl\(blob\)/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
