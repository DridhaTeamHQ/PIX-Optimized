/* ── Auto: reading a photograph and adjusting it, for nothing ────────────────

   Run: node test/auto-tone.mjs

   The Auto chip sets brightness, contrast and saturation from the picture's
   own histogram. It calls no API, which is the point of it — most of what
   people press AI Enhance for is a tone problem, and tone is arithmetic.

   The whole risk in a control like this is that it fires when it should not.
   An auto-levels that normalises every photograph to the same midpoint does
   not fix faults, it removes intentions: a high-key studio portrait on white
   is SUPPOSED to sit bright. That failure was real here — before the
   deadbands, a properly exposed press photo measured a median of 166 and this
   asked to darken it 8%.

   So most of what is checked below is the button doing NOTHING. */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const app = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"),
  "utf8",
);

function fnSrc(name) {
  const a = app.indexOf("function " + name);
  if (a < 0) throw new Error("missing function " + name);
  let k = app.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < app.length; j++) {
    if (app[j] === "{") d++;
    else if (app[j] === "}") { d--; if (!d) return app.slice(a, j + 1); }
  }
}

function constSrc(name) {
  const a = app.indexOf("const " + name + " = {");
  if (a < 0) throw new Error("missing const " + name);
  let d = 0;
  for (let j = app.indexOf("{", a); j < app.length; j++) {
    if (app[j] === "{") d++;
    else if (app[j] === "}") { d--; if (!d) return app.slice(a, j + 2); }
  }
}

/* analysePhoto needs a canvas; autoFilterFor does not — it only reads the tone
   object. So the analyser is stubbed and the DECISIONS are what is tested,
   which is where every bug in this has been. */
const api = new Function(`
  ${constSrc("AUTO_TONE")}
  let __tone = null;
  function analysePhoto() { return __tone; }
  ${fnSrc("autoFilterFor")}
  return { AUTO_TONE, autoFilterFor, setTone: (t) => { __tone = t; } };
`)();

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};
const run = (tone) => { api.setTone(tone); return api.autoFilterFor({}); };
const untouched = (r) => r.brightness === 100 && r.contrast === 100 && r.saturation === 100;
const show = (r) => `B ${r.brightness} C ${r.contrast} S ${r.saturation}`;

console.log("\nA photograph that is already fine is left alone");
{
  // A properly exposed press photo: full range, bright but not blown, normal
  // colour. Measured off a real Getty still.
  const r = run({ p01: 10, median: 166, p99: 227, chroma: 0.143, counted: 4096 });
  ck("nothing is changed at all", untouched(r), show(r));

  const midGrey = run({ p01: 20, median: 128, p99: 235, chroma: 0.19, counted: 4096 });
  ck("nor on a textbook-neutral one", untouched(midGrey), show(midGrey));
}

console.log("\nHigh-key and low-key exposure are choices, not faults");
{
  const highKey = run({ p01: 60, median: 172, p99: 250, chroma: 0.15, counted: 4096 });
  ck("a bright studio portrait is not darkened", highKey.brightness === 100, show(highKey));

  const lowKey = run({ p01: 2, median: 92, p99: 240, chroma: 0.15, counted: 4096 });
  ck("a deliberately dark frame is not lifted", lowKey.brightness === 100, show(lowKey));
}

console.log("\nA genuinely flat picture is lifted, and only halfway");
{
  const flat = run({ p01: 49, median: 92, p99: 110, chroma: 0.018, counted: 4096 });
  ck("contrast is raised", flat.contrast > 100, show(flat));
  ck("but capped, so it cannot look processed",
    flat.contrast <= api.AUTO_TONE.contrast[1], String(flat.contrast));
  ck("brightness is raised too, since the span was dark",
    flat.brightness > 100, String(flat.brightness));

  /* Half the distance, never all of it. The measurement is a 64px thumbnail
     and a heuristic: a correction that lands short leaves a photograph that
     still wants a nudge, one that overshoots leaves somebody undoing it. */
  const span = 110 - 49;
  const full = (api.AUTO_TONE.spanTarget / span) * 100;
  const half = 100 + (full - 100) * api.AUTO_TONE.strength;
  ck("and it is half the correction, not the whole one",
    Math.abs(flat.contrast - Math.min(api.AUTO_TONE.contrast[1], Math.round(half))) <= 1,
    flat.contrast + " vs " + Math.round(half));
}

console.log("\nSaturation only ever goes up, and never on greyscale");
{
  const washed = run({ p01: 20, median: 128, p99: 235, chroma: 0.06, counted: 4096 });
  ck("a washed-out colour photo gets some back", washed.saturation > 100, show(washed));
  ck("capped", washed.saturation <= api.AUTO_TONE.saturation[1], String(washed.saturation));

  const vivid = run({ p01: 20, median: 128, p99: 235, chroma: 0.45, counted: 4096 });
  ck("a vivid one is never CUT — that would override a choice",
    vivid.saturation === 100, show(vivid));

  const grey = run({ p01: 20, median: 128, p99: 235, chroma: 0.004, counted: 4096 });
  ck("and a black-and-white photograph is not colourised",
    grey.saturation === 100, show(grey));
}

console.log("\nDegenerate pictures are not 'corrected' into something");
{
  // A solid colour has no tonal information; expanding it just pushes the one
  // tone present away from mid-grey.
  const solid = run({ p01: 138, median: 138, p99: 138, chroma: 0, counted: 4096 });
  ck("a flat field is left exactly as it is", untouched(solid), show(solid));

  ck("an unreadable picture yields no adjustment at all",
    (api.setTone(null), api.autoFilterFor({})) === null);
}

console.log("\nEvery output stays inside its stated range");
{
  const cases = [
    { p01: 0, median: 4, p99: 8, chroma: 0.9, counted: 9 },
    { p01: 250, median: 253, p99: 255, chroma: 0.0001, counted: 9 },
    { p01: 0, median: 128, p99: 255, chroma: 0.5, counted: 9 },
  ];
  let ok = true, worst = "";
  for (const c of cases) {
    const r = run(c);
    const inRange =
      r.brightness >= api.AUTO_TONE.brightness[0] && r.brightness <= api.AUTO_TONE.brightness[1] &&
      r.contrast   >= api.AUTO_TONE.contrast[0]   && r.contrast   <= api.AUTO_TONE.contrast[1] &&
      r.saturation >= api.AUTO_TONE.saturation[0] && r.saturation <= api.AUTO_TONE.saturation[1];
    if (!inRange) { ok = false; worst = show(r); }
  }
  ck("including the extremes that would divide by nearly nothing", ok, worst);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
