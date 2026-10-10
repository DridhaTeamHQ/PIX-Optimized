/* ── The server half of AI Enhance: cache identity and output shape ─────────

   Run: node test/enhance-params.mjs

   Every other test in this directory drives client geometry. Nothing covered
   the server, and the gap had a cost: `enhanceCacheKey` was handed the
   `{ buffer, mime }` wrapper that `readEnhanceEdit` resolves, passed it
   straight to `hash.update()`, and threw

       ERR_INVALID_ARG_TYPE — The "data" argument must be of type string or an
       instance of Buffer, TypedArray, or DataView. Received an instance of
       Object

   before OpenAI was ever called. Every masked expand 500d. The feature could
   not have worked on any deploy, and the first assertion below is three lines
   long.

   The second half holds down the output shape. `size` is chosen in the plan
   stage, the browser composites its frame at exactly that size, and stage 2
   validates it again on the way back — three places that have to agree. If
   they ever stop agreeing the model rescales the composite, which is the one
   thing compositing exists to prevent, so what is asserted is that every size
   the plan can emit is a size stage 2 will accept.                          */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const server = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"),
  "utf8",
);

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

/* Read from the source rather than restated here — a test that hard-codes the
   value it checks only proves the file was edited twice. */
const ENHANCE_SIZES = new Set(
  JSON.parse(
    server.match(/^const ENHANCE_SIZES = new Set\((\[[^\]]+\])\);/m)[1].replace(/'/g, '"'),
  ),
);

const api = new Function(
  "createHash", "ENHANCE_SIZES", `
    ${fnSrc("enhanceCacheKey")}
    return { enhanceCacheKey };
  `,
)(createHash, ENHANCE_SIZES);

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

const IMAGE = Buffer.from("pretend png bytes, long enough to be an image");
const MASK = Buffer.from("pretend mask bytes");
const PARTS = { job: "expand", amount: "moderate", subject: "people", size: "1024x1536" };

console.log("\nThe cache key survives a mask — the crash that made expand unreachable");
{
  // Exactly what readEnhanceEdit() resolves: bytes in a wrapper, not bytes.
  const wrapper = { buffer: MASK, mime: "image/png" };
  let threw = null, key = null;
  try { key = api.enhanceCacheKey(IMAGE, wrapper, PARTS); } catch (e) { threw = e; }
  ck("a { buffer, mime } wrapper does not throw",
     !threw, threw ? `${threw.code}: ${String(threw.message).split("\n")[0]}` : "");
  ck("and returns a sha256 hex digest",
     typeof key === "string" && /^[0-9a-f]{64}$/.test(key), String(key));

  const raw = api.enhanceCacheKey(IMAGE, MASK, PARTS);
  ck("a wrapper and its raw buffer are the same request",
     raw === key, `${String(raw).slice(0, 16)} vs ${String(key).slice(0, 16)}`);

  const none = api.enhanceCacheKey(IMAGE, null, PARTS);
  ck("masked and unmasked are NOT the same request",
     none !== key, "the mask is in the key precisely so these differ");

  const other = api.enhanceCacheKey(IMAGE, Buffer.from("a different mask"), PARTS);
  ck("two different masks are two different requests", other !== key);

  /* The tempting one-liner, held to the wall. `mask.buffer || mask` reads as
     "unwrap if wrapped" and is wrong twice over: a real Buffer's .buffer is
     the 64KB pooled ArrayBuffer it was allocated from, which hash.update()
     rejects outright — so it reintroduces the crash by another route. */
  let poolThrew = null;
  try { createHash("sha256").update(MASK.buffer); } catch (e) { poolThrew = e; }
  ck("hash.update() really does reject a raw ArrayBuffer",
     Boolean(poolThrew), "if this ever passes, the `mask.buffer || mask` trap is gone");
}
/* ── The shapes the route asks gpt-image-1.5 for ─────────────────────────

   Three fixed shapes is all this model family sells, so these functions are
   a mapping and not a negotiation. What is worth holding down is that the
   mapping does not drift: `size` is chosen in the plan stage, the browser
   composites its frame at exactly that size, and stage 2 validates it again
   on the way back. If those three ever disagree the model rescales the
   composite, which is the one thing compositing exists to prevent.        */

const RATIO_VALUES = new Function(
  // Evaluated, not JSON.parsed: the source writes these as arithmetic
  // (`"9:16": 9 / 16`), which is readable and is not valid JSON.
  "return " + server.match(/^const RATIO_VALUES = (\{[^}]+\});/m)[1],
)();

const sizes = new Function("ENHANCE_SIZES", "RATIO_VALUES", `
  ${fnSrc("sizeForExpand")}
  ${fnSrc("sizeForRatio")}
  return { sizeForExpand, sizeForRatio };
`)(ENHANCE_SIZES, RATIO_VALUES);

console.log("\nExpand asks for the shape nearest the poster");
for (const [ratio, want] of [
  ["9:16", "1024x1536"], ["4:5", "1024x1536"],
  ["1:1", "1024x1024"], ["16:9", "1536x1024"],
]) {
  const got = sizes.sizeForExpand(ratio, "landscape");
  ck(`${ratio} -> ${want}`, got === want, got);
  ck(`  and ${got} is a shape the model sells`, ENHANCE_SIZES.has(got));
}
ck("no poster ratio falls back to the source's orientation",
   sizes.sizeForExpand("", "landscape") === "1536x1024" &&
   sizes.sizeForExpand("", "portrait") === "1024x1536");

console.log("\nRestore follows the SOURCE, never the poster");
{
  ck("a landscape source", sizes.sizeForRatio("", "landscape", 1536, 864) === "1536x1024");
  ck("a portrait source", sizes.sizeForRatio("", "portrait", 864, 1536) === "1024x1536");
  /* The square guard, and it is not cosmetic: the browser only ever reports
     "landscape" or "portrait" (rawW >= rawH), so without this a square logo
     was billed at 1536x1024 AND asked to grow sideways. */
  ck("a square source takes the square shape, which is also the cheapest",
     sizes.sizeForRatio("", "landscape", 1000, 1000) === "1024x1024");
  ck("and near-square counts as square",
     sizes.sizeForRatio("", "landscape", 1020, 1000) === "1024x1024");
  ck("an unknown source is left to the model rather than guessed from the poster",
     sizes.sizeForRatio("", "", 0, 0) === "auto");
}

console.log("\nEvery size the plan can emit is one stage 2 will accept back");
{
  const emitted = new Set();
  for (const r of ["9:16", "4:5", "1:1", "16:9", ""]) {
    for (const o of ["landscape", "portrait", ""]) {
      emitted.add(sizes.sizeForExpand(r, o));
      emitted.add(sizes.sizeForRatio(r, o, 1536, 864));
      emitted.add(sizes.sizeForRatio(r, o, 1000, 1000));
    }
  }
  for (const size of emitted) {
    ck(`the plan can emit "${size}", and stage 2 keeps it`,
       ENHANCE_SIZES.has(size),
       "stage 2 would coerce this to auto and let the model rescale the composite");
  }
}

/* ── Reframe: the job that regenerates ───────────────────────────────────

   Expand pins the original and bolts a generated margin to it. Every failure
   this route shipped was a failure of that bolt — the doubled subject, the
   framed print, the smeared sky. Reframe hands the model the picture and asks
   for it at the poster's shape, which is what the same model does well when it
   is asked plainly, and what the reviewer picked after comparing the two.

   It regenerates, so the things that keep it honest are worth pinning:
   it asks for the POSTER's shape (not the source's), it sends no mask (there
   is nothing to pin), and its prompt stays SHORT — the long one is not more
   careful, it is more contradictory, and contradiction is what makes a model
   hedge by handing back what it was given.                                  */

const REFRAME_SRC = (() => {
  const a = server.indexOf("function buildReframePrompt");
  if (a < 0) throw new Error("buildReframePrompt is gone");
  return fnSrc("buildReframePrompt");
})();

const reframe = new Function(`${REFRAME_SRC}\nreturn buildReframePrompt;`)();

console.log("\nReframe asks for the poster's shape, not the source's");
{
  // Same resolver as expand: the poster is the point of the job.
  ck("9:16 poster -> a portrait frame",
     sizes.sizeForExpand("9:16", "landscape") === "1024x1536",
     sizes.sizeForExpand("9:16", "landscape"));
  ck("...even though the SOURCE is landscape, which is the whole point",
     sizes.sizeForRatio("", "landscape", 1280, 873) === "1536x1024",
     "restore still follows the source; reframe must not");
}

console.log("\nThe reframe prompt stays short and says the load-bearing things");
{
  const p = reframe("two men on a street at golden hour", "9:16", "people");
  const lines = p.split("\n").filter((l) => l.trim()).length;

  ck(`it is short (${lines} non-empty lines, expand is ~60)`, lines <= 15, String(lines));
  ck("it names the target shape", /9:16/.test(p), p.slice(0, 80));
  ck("it carries the vision stage's description",
     /two men on a street at golden hour/.test(p));
  ck("it asks to keep the subjects the same people",
     /same people|recognisably themselves/i.test(p) && /same faces/i.test(p));
  ck("it forbids inventing people", /Do not add people/i.test(p));
  ck("it forbids NEW text and watermarks", /Do not add people or NEW text, captions, logos or watermarks/.test(p));
  for (const subject of ["people", "scene", "graphic"]) {
    const signage = reframe("a factory with a Coca-Cola sign", "9:16", subject);
    ck(`${subject}: existing branding on buildings is protected`,
       /Preserve all existing logos, brand names/.test(signage) && /including those on buildings/.test(signage));
    ck(`${subject}: no blanket ban on existing lettering`,
       !/No text, captions, logos|Write no words/.test(signage) && /Never erase, replace or simplify/.test(signage));
  }
  ck("changed instructions cannot reuse an old result", api.enhanceCacheKey(IMAGE, null, { ...PARTS, prompt: "old prompt" }) !== api.enhanceCacheKey(IMAGE, null, { ...PARTS, prompt: p }));
  /* The ghost, named once. This prompt has no mask and no paste-back behind
     it, so the only thing standing between it and a photo-print-in-a-scene is
     this sentence. */
  ck("it forbids the picture-in-a-picture that has bitten twice",
     /picture-in-picture|picture inside a picture/i.test(p) && /border/i.test(p) && /one continuous image/i.test(p));
  /* Short on purpose. "Upscale and reframe it to 9:16" typed at ChatGPT beat
     every long brief this route has carried; the long ones argue with
     themselves and the model hedges. */
  ck("it opens with what a person would type", /^Upscale this image and reframe it to a 9:16 ratio\./.test(p), p.slice(0, 60));
  ck("and stays short", p.split("\n").filter(Boolean).length <= 12, p.split("\n").filter(Boolean).length + " lines");
  ck("it does NOT tell the model to place the image smaller in the frame",
     !/place the supplied|smaller within the output frame/i.test(p),
     "that sentence is what drew the framed print");

  const g = reframe("the boAt wordmark", "9:16", "graphic");
  ck("a graphic is told to keep its letterforms, not its face",
     /letterforms/i.test(g) && !/faces, expressions/i.test(g));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
