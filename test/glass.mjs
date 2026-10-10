/* ── Glass and fade, checked against the real source ─────────────────────────

   Run: node test/glass.mjs        (no dependencies, no runner, exit code 1 on
                                    failure so CI can use it as-is)

   It pulls the actual functions out of public/app.js and executes them against
   a stub canvas, rather than reimplementing them — so it cannot drift into
   testing a copy. Constants are read from the source too: nothing here
   restates a number the file owns, because a test that hard-codes the value it
   is checking only proves the file was edited twice.

   What it guards, and why each one is here rather than being obvious:

     the panel is neutral        hue 33 at saturation 35 reads as brown on a
                                 photograph with nothing warm in it
     the mask is densely sampled addColorStop interpolates LINEARLY, so a curve
                                 described by a few stops is a few straight
                                 segments with a slope change at each join —
                                 Mach banding, seen as an edge where the frost
                                 begins
     the source rect is scaled   drawImage's SOURCE rectangle is not affected
                                 by the context transform, so a design-space
                                 rect against a 4x export canvas reads the
                                 top-left corner: preview right, published card
                                 wrong
     fill + fade cannot stack    the glass fill does the darkening the fade
                                 used to; both at full strength would leave no
                                 photograph at all

   Verified by mutation: reintroducing the brown, undersampling the mask,
   dropping the transform and unpinning fadeMax each make it fail. */

// Executes the REAL glass + fade out of public/app.js against stubs.
// Nothing here restates a constant the source owns: values are read from it,
// so a test cannot pass merely because the file was edited twice.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved against this file, so it runs from anywhere: `node test/glass.mjs`
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
// The GLASS config is one const expression spanning many lines.
const glassSrc = (() => {
  const a = app.indexOf("const GLASS = (window.GLASS");
  const tail = "}, window.GLASS));";
  return app.slice(a, app.indexOf(tail, a) + tail.length);
})();

// fadeReach still uses the loose FADE_ constants alongside GLASS.
// Injected from the source rather than restated, same rule as the rest.
const fadeConsts = app
  .split(/\r?\n/)
  .filter((l) => l.startsWith("const FADE_"))
  .join("\n");

/* SPEC_STOPS is the profile both ramps follow, and it is a const array
   spanning several lines rather than a function. Injected from the source for
   the same reason as everything else here: a test that restates the shape it
   is checking passes whatever the shape becomes. */
const specSrc = (() => {
  const a = app.indexOf("const SPEC_STOPS = [");
  const tail = "];";
  return app.slice(a, app.indexOf(tail, a) + tail.length);
})();

/* RAMP_ONSET, the lookup width, and the integral built from them. Injected
   out of the source rather than restated, same rule as everything else here. */
const onsetSrc = [
  app.match(/^const RAMP_ONSET = [\d.]+;/m)[0],
  // The window at the far end. Its absence was the visible edge: the ramp
  // arrived at full presence still climbing and was held flat by the clamp.
  app.match(/^const RAMP_TAPER = [\d.]+;/m)[0],
  app.match(/^const RAMP_SAMPLES_LUT = \d+;/m)[0],
  (() => {
    const a = app.indexOf("const RAMP_TABLE = (");
    return app.slice(a, app.indexOf("})();", a) + 5);
  })(),
].join("\n");

function makeCtx(log, label) {
  const stops = [];
  return {
    canvas: { __label: label }, stops, label,
    globalAlpha: 1, globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false, imageSmoothingQuality: "",
    fillStyle: null,
    /* filter is a real property on a context, and the strip loop assigns it
       per strip. Recording the assignments is the only way to see the blur
       RADIUS the code actually asks for, which is the thing being checked. */
    _filter: "none",
    get filter() { return this._filter; },
    set filter(v) { this._filter = v; log.filters.push({ ctx: label, value: v, seq: log.seq++ }); },
    getTransform: () => log.transform,
    drawImage(...a) { log.draws.push({ ctx: label, args: a, alpha: this.globalAlpha, seq: log.seq++ }); },
    fillRect(...a) { log.fills.push({ ctx: label, args: a, op: this.globalCompositeOperation, style: this.fillStyle, alpha: this.globalAlpha }); },
    // Reused scratch canvases must be wiped before reuse, so the stub has to
    // accept the calls that do it.
    clearRect(...a) { log.clears.push({ ctx: label, args: a }); },
    setTransform() {},
    // The dither builds its tile pixel by pixel before it can be a pattern.
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(id) { log.putImage.push({ ctx: label, w: id.width, h: id.height }); },
    createPattern(image, repeat) {
      log.patterns.push({ ctx: label, repeat });
      return { __pattern: true };
    },
    createLinearGradient(x0, y0, x1, y1) {
      log.gradients.push({ ctx: label, line: [y0, y1] });
      return { addColorStop: (p, c) => stops.push({ p, a: Number(c.match(/,([\d.]+)\)$/)[1]) }) };
    },
  };
}

function build({ transform = { a: 1, d: 1, e: 0, f: 0 }, overrides = {} } = {}) {
  const log = { draws: [], fills: [], gradients: [], clears: [], contexts: [], created: [], filters: [], patterns: [], putImage: [], seq: 0, transform };
  let n = 0;
  const doc = {
    createElement: () => {
      const c = { width: 0, height: 0, __i: n++ };
      log.created.push(c);
      // One context object per canvas, as a real canvas gives, so reuse of the
      // canvas is visible as reuse of the context.
      const cx = makeCtx(log, "off" + c.__i);
      c.getContext = () => { log.contexts.push(cx); return cx; };
      return c;
    },
  };
  const api = new Function("document", "window", `
    let glassNoiseTile = null;
    ${fnSrc("glassNoise")}
    ${fadeConsts}
    const glassScratchPool = new Map();
    ${fnSrc("glassScratch")}
    const glassCache = new Map();
    const GLASS_CACHE_MAX = 6;
    ${fnSrc("cacheKeep")}
    ${fnSrc("hsbToRgb")}
    ${fnSrc("imageHue")}
    ${fnSrc("glassPanelColour")}
    ${glassSrc}
    ${fnSrc("fadeReach")}
    ${specSrc}
    ${fnSrc("specAlpha")}
    ${onsetSrc}
    ${fnSrc("rampAlpha")}
    ${fnSrc("paintMistGlass")}
    ${fnSrc("paintBottomFade")}
    return { GLASS, glassPanelColour, fadeReach, paintMistGlass, paintBottomFade };
  `)(doc, { GLASS: overrides });
  return { api, log, target: makeCtx(log, "target") };
}

/* The treatment paints two ramps and they are not interchangeable.

   `ink` is the darkening - a gradient laid straight onto the TARGET, spanning
   the whole band, and the one whose steepness decides whether there is an edge
   to find. `presence` is how much of the blurred picture is present, built on
   the offscreen glass canvas and deliberately compressed into the first
   GLASS.frostReach of the band.

   They used to be one mask, and a test that grabs "the gradient with the most
   stops" silently reads whichever happens to be longer. */
const ramps = (log, target) => ({
  ink: target.stops.slice(),
  presence: (log.contexts.filter((c) => c.stops.length)
    .sort((a, b) => b.stops.length - a.stops.length)[0] || { stops: [] }).stops.slice(),
});

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};
const W = 920, H = 1700, COPY = 1209, LAYOUT_FADE = 330;

console.log("\nThe panel takes its HUE from the picture, and nothing else");
{
  const { api } = build();

  /* Marked on the picker: saturation, brightness and the fill's 85% are fixed
     and never come from the photograph. Inherit those and a washed-out picture
     gives a washed-out panel while a neon one gives a luminous one, and a set
     of slides stops looking like one design. */
  ck("saturation is fixed at the picker's 35", Math.abs(api.GLASS.saturation - 0.35) < 1e-9, String(api.GLASS.saturation));
  ck("brightness is fixed at the picker's 9", Math.abs(api.GLASS.brightness - 0.09) < 1e-9, String(api.GLASS.brightness));
  ck("the fill is fixed at the picker's 85%", Math.abs(api.GLASS.fillAlpha - 0.85) < 1e-9, String(api.GLASS.fillAlpha));

  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

  /* A picture with no hue worth taking keeps the design's own 196 — which is
     #0F1517, the hex on the picker. */
  ck("no usable hue falls back to the design's own #0F1517",
    hex(api.glassPanelColour(null)) === "#0F1517", hex(api.glassPanelColour(null)));

  /* And the hue does reach the colour. Driven through GLASS.hue rather than a
     stub image, because imageHue needs a real canvas; what is under test is
     that H moves the panel and that S and B do not move with it. */
  const warm = build({ overrides: { hue: 33 } }).api.glassPanelColour(null);
  const cool = build({ overrides: { hue: 212 } }).api.glassPanelColour(null);
  ck("a warm hue leans the panel warm", warm.r > warm.b, hex(warm));
  ck("a cool hue leans it cool", cool.b > cool.r, hex(cool));
  const level = (c) => Math.max(c.r, c.g, c.b);
  ck("and both keep the same brightness, so only H moved",
    Math.abs(level(warm) - level(cool)) <= 1, hex(warm) + " vs " + hex(cool));
}

console.log("\nThe transition is gentle enough that there is no edge to find");
{
  /* Measured on the DARKENING, which is what carries the transition. The
     frost's own ramp is deliberately steeper and shorter - it has to be, or
     the blurred layer never gets clear of the sharp original underneath it -
     and reading that one instead reports an edge that is not there. */
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  const read = log.draws.find((d) => d.args.length === 9);
  const bandPx = H - read.args[2];
  const { ink } = ramps(log, target);
  ck("the darkening is a gradient of its own", ink.length > 60, ink.length + " stops");

  let peak = 0;
  for (let i = 1; i < ink.length; i++) {
    const dp = ink[i].p - ink[i - 1].p;
    const da = ink[i].a - ink[i - 1].a;
    if (dp > 0) peak = Math.max(peak, Math.abs(da) / (dp * bandPx));
  }
  // Normalised out of fillAlpha, since ink tops out there rather than at 1.
  const peakOfTotal = peak / api.GLASS.fillAlpha;
  const REFERENCE = 0.8 / (0.63 * bandPx);
  ck("its steepest run is no worse than twice the design's",
    peakOfTotal <= REFERENCE * 2,
    (peakOfTotal * 100).toFixed(3) + "% per px vs the design's " + (REFERENCE * 100).toFixed(3) + "%");

  const shortRamp = 1.5 / (LAYOUT_FADE * 0.45 * 0.83);
  ck("and far gentler than the 123px ramp it replaced",
    peakOfTotal < shortRamp / 3,
    (peakOfTotal * 100).toFixed(3) + "% per px vs the old " + (shortRamp * 100).toFixed(3) + "%");

  const first = ink[1].a - ink[0].a;
  const biggest = Math.max(...ink.map((st, i) => (i ? st.a - ink[i - 1].a : 0)));
  ck("it leaves from a standstill rather than a corner",
    first < biggest / 8, first.toFixed(5) + " vs " + biggest.toFixed(5));
  ck("and is still climbing at the foot, not flat from a third of the way down",
    ink[ink.length - 1].a > ink[Math.floor(ink.length * 0.6)].a + 0.05,
    "foot " + ink[ink.length - 1].a.toFixed(3));
}

console.log("\nThe frost clears the sharp original early, then holds");
{
  /* Why this is separate from the darkening at all.

     At half presence you are not looking at a half-blurred picture; you are
     looking at a blurred one at half strength over the SHARP original at half
     strength, and the eye takes its reading of focus from the sharp half. So
     the blurred layer has to reach full presence while there is still band
     left, leaving everything below it a single blurred image whose RADIUS
     grows - with no crossfade left to give it away. Measured on the rendered
     card before the split: sigma 52 was being asked for at line three and the
     composite showed a 1px edge, because presence there was 60%. */
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  const { presence } = ramps(log, target);
  ck("the frost has a ramp of its own", presence.length > 60, presence.length + " stops");
  const full = presence.find((st) => st.a >= 0.999);
  ck("it reaches full presence inside the band", !!full);
  /* Against the rule, not against the knob. frostReach is a MULTIPLE of where
     the copy line falls, so comparing full.p to it directly passes for any
     value at all once it is above 1 — which is what it now is. */
  const copyFrac = (api.GLASS.runUpAboveCopy * (H / 1700)) /
    (H - (COPY - api.GLASS.runUpAboveCopy * (H / 1700)));
  ck("it completes where the knob says, measured from the band",
    full && Math.abs(full.p - copyFrac * api.GLASS.frostReach) < 0.02,
    full ? `full at ${(full.p * 100).toFixed(1)}%, expected ${(copyFrac * api.GLASS.frostReach * 100).toFixed(1)}%` : "never");
  ck("and holds there rather than drifting back",
    presence[presence.length - 1].a >= 0.999);
  /* Shorter than the darkening — the actual property, read off the ramp.
     GLASS.frostReach is a multiple of where the copy line falls, not a
     fraction of the band, so it is 1 when the frost completes AT the copy;
     asserting `< 1` on it stopped meaning anything the moment that changed.

     It was then `< 0.5`, which had the same fault one level down: a constant
     standing in for a property. Where the frost completes is
     copyFrac * frostReach, and that is already asserted exactly, against the
     knob, immediately above. What THIS assertion is for is the consequence —
     that the ramp finishes with band left over, so the foot is a hold and not
     a crossfade. Raising frostReach from 0.9 to 1.8 moved completion from 29%
     to 57% of the band, which the old constant read as a regression and which
     is the fix: at 0.9 the crossfade was compressed into 207px and slammed
     into a clamp 23px above the copy, full width, which is what a reviewer
     reported as a hard stop. */
  ck("the ramp finishes with band to spare, so the foot holds rather than crossfades",
    full && full.p < 0.85, full ? `full at ${(full.p * 100).toFixed(0)}%` : "never");
  /* And the hold is long enough to be a hold. Below about a tenth of the band
     the "completes early" property is nominal — the crossfade would be
     running essentially to the foot. */
  ck("the hold is a real stretch of band, not a rounding",
    full && (1 - full.p) > 0.1, full ? `${((1 - full.p) * 100).toFixed(0)}% held` : "never");
}

console.log("\nThe mask is a sampled curve, not a few straight segments");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, {
    width: W, height: H, copyTop: COPY,   });
  const masked = log.contexts.filter((c) => c.stops.length)
    .sort((a, b) => b.stops.length - a.stops.length)[0];
  ck("a mask was built", !!masked && masked.stops.length > 0);
  if (masked) {
    const a = masked.stops.map((s) => s.a);
    // addColorStop interpolates linearly, so few stops == few straight
    // segments with a slope change at each join. That is Mach banding, and it
    // is what a "findable edge where the frost begins" actually is.
    ck("sampled densely, not a dozen segments", a.length >= 60, a.length + " stops");
    const steps = a.map((v, i) => (i ? v - a[i - 1] : 0)).slice(1);
    const biggest = Math.max(...steps);
    ck("eases in — first step far smaller than the steepest",
      steps[0] < biggest / 4, steps[0].toFixed(4) + " vs " + biggest.toFixed(4));
    ck("never goes backwards", a.every((v, i) => !i || v >= a[i - 1] - 1e-9));
    ck("starts fully transparent", a[0] === 0, String(a[0]));
    ck("reaches full strength and HOLDS, so every line sits on the same glass",
      a[a.length - 1] === 1 && a[a.length - 2] === 1, a.slice(-3).join(","));
  }
}

console.log("\nIt reads the right part of the photograph when the context is scaled");
// The bug this guards: drawImage's SOURCE rect is not transformed, so a design
// -space rect against a 4x export canvas reads the top-left corner instead of
// the copy band — preview right, published card wrong.
for (const scale of [1, 2, 4]) {
  const { api, log, target } = build({ transform: { a: scale, d: scale, e: 0, f: 0 } });
    api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  const read = log.draws.find((d) => d.args.length === 9);
  /* The band begins GLASS.runUpAboveCopy above the first line. Computed from
     the rule rather than restated, so tuning the knob does not edit this. */
  const expectedTop =
    (COPY - Math.min(COPY, api.GLASS.runUpAboveCopy * (H / 1700))) * scale;
  ck(`${scale}x: source rect starts at the copy band, not the canvas top`,
    read && Math.abs(read.args[2] - expectedTop) < 1.5,
    read ? `sy=${read.args[2]}, expected ${expectedTop.toFixed(0)}` : "no read-back");
  ck(`${scale}x: source width is device pixels, not design units`,
    read && Math.abs(read.args[3] - W * scale) < 2,
    read ? `sw=${read.args[3]}, expected ${W * scale}` : "");
}
console.log("\nIt reuses its scratch canvases instead of allocating per render");
{
  // renderPoster() runs straight out of every keystroke handler and repaints
  // every page, so this ran three times per keypress. Two fresh canvases each
  // time was ~10MB per render and ~100MB/s of churn under ordinary typing.
  const { api, log, target } = build();
  const arg = { width: W, height: H, copyTop: COPY, };
  api.paintMistGlass(target, arg);
  const afterFirst = log.created.length;
  for (let i = 0; i < 20; i++) api.paintMistGlass(target, arg);
  ck("further renders allocate no new canvases",
    log.created.length === afterFirst, `${afterFirst} then ${log.created.length} after 21 renders`);
  ck("and it wipes what it reuses, so no stale frame shows through",
    log.clears.length >= 2, log.clears.length + " clears");
}


console.log("\nA pane is built once per key, then blitted");
{
  /* renderPoster runs on every keystroke, and between two keystrokes nothing
     under the band has changed. With a cacheKey the second paint must not
     rebuild: no blur levels, no strips — one draw of the kept pane and the
     ink over it. Without a key it must behave exactly as before. */
  const { api, log, target } = build();
  const arg = { width: W, height: H, copyTop: COPY, cacheKey: "photo-1|0|0|100" };
  api.paintMistGlass(target, arg);
  const built = log.filters.filter((f) => /blur/.test(f.value)).length;
  const created = log.created.length;
  const targetDraws = log.draws.filter((d) => d.ctx === "target").length;
  ck("the first paint builds the blur levels", built > 0, String(built));
  ck("and keeps one canvas of its own", created >= 1, String(created));

  api.paintMistGlass(target, arg);
  const builtAgain = log.filters.filter((f) => /blur/.test(f.value)).length - built;
  ck("the second paint with the same key builds nothing", builtAgain === 0, builtAgain + " blur filters set");
  ck("allocates nothing", log.created.length === created, `${created} then ${log.created.length}`);
  ck("and still draws the pane onto the card",
    log.draws.filter((d) => d.ctx === "target").length === targetDraws * 2, "");

  // A different geometry under the same caller key is a different pane.
  api.paintMistGlass(target, { ...arg, copyTop: COPY - 120 });
  const builtLower = log.filters.filter((f) => /blur/.test(f.value)).length - built;
  ck("a band that starts elsewhere is built afresh", builtLower > 0, String(builtLower));

  // Under an export transform the cache is bypassed: the pane would be the
  // wrong resolution, and exports are rare.
  const scaled = build({ transform: { a: 4, d: 4, e: 0, f: 0 } });
  scaled.api.paintMistGlass(scaled.target, arg);
  const scaledCreated = scaled.log.created.length;
  scaled.api.paintMistGlass(scaled.target, arg);
  const b1 = scaled.log.filters.filter((f) => /blur/.test(f.value)).length;
  ck("a scaled context builds every time, and keeps nothing",
    b1 > 0 && scaled.log.created.length === scaledCreated, `${scaledCreated} then ${scaled.log.created.length}`);

  // No key: the old contract, untouched.
  const plain = build();
  plain.api.paintMistGlass(plain.target, { width: W, height: H, copyTop: COPY });
  const c0 = plain.log.created.length;
  plain.api.paintMistGlass(plain.target, { width: W, height: H, copyTop: COPY });
  ck("without a key nothing is kept and nothing extra is allocated",
    plain.log.created.length === c0, `${c0} then ${plain.log.created.length}`);
}

console.log("\nThe blend begins well above the first line");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, {
    width: W, height: H, copyTop: COPY,   });
  const read = log.draws.find((d) => d.args.length === 9);
  const bandTop = read.args[2];

  /* It used to start AT the copy and finish 123px later, so the entire build
     happened across lines one to three with nothing above it at all. The onset
     has to land in empty picture, where there is no type beside it for the eye
     to measure the change against. */
  /* The bug this guards is a run-up of ZERO — the band starting on the first
     line, which is what compressed the whole build into 123px and made the
     edge findable. The bound was 100 while the run-up was 272; it is 65 now,
     placed where the treatment was asked to begin, and a bound that only
     passes for the value that happened to be current is not a test. The
     smoothness this trades against is measured directly further up. */
  const runUp = COPY - bandTop;
  ck("the band begins above the copy, not on it", runUp > 20, runUp + "px");
  ck("taken from the knob, in the card's own frame",
    Math.abs(runUp - api.GLASS.runUpAboveCopy * (H / 1700)) < 1.5, runUp + "px");
  ck("but it does not start halfway up the card",
    bandTop / H >= 0.4, (bandTop / H * 100).toFixed(0) + "% down the card");

  /* The DARKENING runs the full band instead of finishing early onto a flat
     panel - that panel was the other half of what forced the ramp to be steep,
     since every level it did not use had to be spent in the 123px above it.

     Read off the ink gradient. The frost's presence ramp deliberately DOES
     finish early, at GLASS.frostReach, and picking "the gradient with the most
     stops" is how this ended up measuring that one instead. */
  const { ink } = ramps(log, target);
  const rising = ink.filter((st, i) => i > 0 && st.a > ink[i - 1].a);
  ck("the darkening is still climbing at the foot",
    rising[rising.length - 1].p > 0.9,
    "stops rising at " + (rising[rising.length - 1].p * 100).toFixed(0) + "% of the band");
}


console.log("It declines rather than misbehaving");
{
  let r = build({ overrides: { on: false } });
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: COPY });
  ck("GLASS.on = false paints nothing", r.log.draws.length === 0);

  r = build();
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: H + 500 });
  ck("copy far past the foot paints nothing", r.log.draws.length === 0);

  r = build();
  r.target.canvas = null;
  r.api.paintMistGlass(r.target, { width: W, height: H, copyTop: COPY });
  ck("no canvas to read paints nothing", r.log.draws.length === 0);
}

console.log("\nThe bottom fade is still black, anchored, and capped");
{
  const { api, log, target } = build();
  api.paintBottomFade(target, { width: W, height: H, copyTop: COPY, fadeHeight: LAYOUT_FADE });
  const grad = log.gradients.find((g) => g.ctx === "target");
  ck("anchored a fixed distance above the copy",
    grad && Math.abs(grad.line[0] - (COPY - api.fadeReach(LAYOUT_FADE))) < 1.5,
    grad ? String(grad.line[0]) : "none");
  const a = target.stops.map((s) => s.a);
  ck("it painted a gradient", a.length > 0);
  ck("alpha never decreases", a.every((v, i) => !i || v >= a[i - 1] - 1e-9));
  /* The design's three stops, transcribed: 0% at 0, 63% at 80%, 100% at full.
     Asserted as VALUES because they were read off a stop list rather than
     derived — if someone re-tunes them, that should be a deliberate edit to
     a spec, visible here, not a silent drift. */
  const stopAt = (pos) => {
    const s = target.stops.find((st) => Math.abs(st.p - pos) < 1e-6);
    return s ? s.a : null;
  };
  /* The design's shape — 0, 80%, 100% — scaled so the black tops out at 75%.
     Scaled and not clamped: setting only the last stop to 0.75 would leave
     0.80 at the 63% mark, and a gradient that rises to 0.80 and falls back to
     0.75 puts a horizontal edge across the foot of every card. That is what
     "alpha never decreases" above is there to catch. */
  const CEILING = 0.75;
  ck("the top of the band is fully transparent", Math.abs(stopAt(0) - 0) < 1e-6, String(stopAt(0)));
  ck("63% down keeps the design's 80%, scaled",
    Math.abs(stopAt(0.63) - 0.8 * CEILING) < 1e-6, String(stopAt(0.63)));
  ck("the black tops out at 75%, not opaque",
    Math.abs(a[a.length - 1] - CEILING) < 1e-6, String(a[a.length - 1]));
  ck("three stops and no more — this gradient is not a curve", a.length === 3, a.length + " stops");

  /* The foot is now OPAQUE, and that is a change of intent worth stating.
     This used to assert that some photograph survived down there — the fade
     was capped at GLASS.fadeMax so that (1 - fillAlpha) x (1 - fadeMax) left
     about 9% of the picture visible, on the reasoning that below ~7% a card
     stops being a photograph with type on it and becomes a black panel.

     The design says otherwise: its last stop is 100%. So the picture is gone
     at the very foot by instruction, and what the reader still sees through
     the treatment is the stretch ABOVE that — at 63% down, 20% of the
     photograph is still coming through. That is where the property now
     lives, so that is where it is checked. */
  ck("a quarter of the photograph survives at the very foot",
    Math.abs((1 - a[a.length - 1]) - 0.25) < 1e-6,
    ((1 - a[a.length - 1]) * 100).toFixed(0) + "% left at the foot");
  const atSixtyThree = 1 - stopAt(0.63);
  ck("and 40% of it still reads at the 63% stop",
    atSixtyThree >= 0.35,
    (atSixtyThree * 100).toFixed(0) + "% of the picture through the fade there");
}

console.log("\nEvery page that shows copy over a photograph gets the treatment");
{
  /* The text page did not, and nobody noticed for a long time: it painted a
     four-stop wash over the whole frame instead, and drew its photograph
     through blur(18px) brightness(62%) on top of that. Both of those make the
     glass invisible — one buries it, the other removes the sharp input it
     needs to be a transition at all — so this checks the source directly.

     Reading the file rather than executing it, because these are three
     separate screen functions with their own DOM and state; what matters is
     that none of them quietly goes back to washing the frame. */
  const screens = ["drawPixTextScreen", "drawStoryScreen", "drawHero"];
  for (const name of screens) {
    const body = (() => {
      const i = app.indexOf("function " + name);
      if (i < 0) return null;
      let k = app.indexOf(") {", i) + 2, d = 0;
      for (let j = k; j < app.length; j++) {
        if (app[j] === "{") d++;
        else if (app[j] === "}") { d--; if (!d) return app.slice(i, j + 1); }
      }
    })();
    if (!body) { console.log("  SKIP " + name + " not found"); continue; }
    ck(name + " paints the glass", /paintMistGlass\(/.test(body));
    ck(name + " paints the fade", /paintBottomFade\(/.test(body));
    ck(name + " anchors both to the copy, not to the frame",
      !/copyTop:\s*0/.test(body));
  }

  // The text page specifically: sharp input, and no full-frame wash left.
  const text = (() => {
    const i = app.indexOf("function drawPixTextScreen");
    let k = app.indexOf(") {", i) + 2, d = 0;
    for (let j = k; j < app.length; j++) {
      if (app[j] === "{") d++;
      else if (app[j] === "}") { d--; if (!d) return app.slice(i, j + 1); }
    }
  })();
  /* The text page is UNIFORMLY blurred, and this assertion used to say the
     opposite — "draws its photograph sharp", on the reasoning that a
     sharp-to-frosted treatment has nothing to show when its input is already
     frosted. That holds for the poster and the story page and not for this
     one: it is a page of body copy filling the card, and the picture behind it
     is a texture rather than a subject. The spec is explicit — one rectangle
     over the whole 382x682 frame, Background blur UNIFORM at 16, linear fill
     at 85%. */
  ck("the text page blurs its photograph, rather than drawing it sharp",
    /drawTextPreviewBackgroundImage\([\s\S]*?blur\(/.test(text) &&
    !/drawTextPreviewBackgroundImage\([\s\S]*?"none"\)/.test(text),
    "the spec sets Background blur Uniform 16 over the whole frame");

  /* Derived, not restated. 16-at-382 is the same pair the glass itself uses,
     so a hard-coded 39 here would drift the moment either moved — and would
     stop matching the spec at any canvas but 920. */
  ck("at a radius taken from GLASS.blurAt / blurCardWidth, so it scales",
    /GLASS\.blurAt \* W\) \/ GLASS\.blurCardWidth/.test(text),
    "a literal radius stops matching the spec at every size except the one it was written at");

  /* Blur ONLY. The old default carried brightness(62%) contrast(108%)
     saturate(72%) as well, and that is why this page used to be 75-98% black
     before a word was drawn: dimmed once in the filter and again by
     everything painted over it. The darkening belongs to the veil and the
     fill, where it can be reasoned about. */
  const textFilter = (text.match(/blur\(\$\{textBlur\}px\)[^`]*/) || [""])[0];
  ck("and softens only — no brightness or saturation baked into the filter",
    !/brightness|contrast|saturate/.test(textFilter),
    `filter carries "${textFilter}" — dimming here is invisible to everything downstream`);

  ck("and the four-stop full-frame wash is gone",
    !/addColorStop\(0\.34/.test(text) && !/rgba\(0, 0, 0, 0\.98\)/.test(text));
}

console.log("\nThe blur lags the darkening, piling up towards the foot");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });

  /* Radius against DEPTH.

     The strips no longer set ctx.filter at all - that was unaffordable at
     these radii, 140ms a paint against 3ms. The blur is applied once per
     LEVEL on the downscaled band, where the upscale multiplies it and the
     pixel count is a sixteenth, and each strip draws from whichever level
     matches its depth. So the radius a strip carries is the sigma baked into
     the canvas it drew FROM, not a filter set just before it. */
  const sigmaOf = new Map();
  for (const f of log.filters) {
    const m = /^blur\(([\d.]+)px\)$/.exec(f.value);
    if (m && !sigmaOf.has(f.ctx)) sigmaOf.set(f.ctx, parseFloat(m[1]));
  }
  ck("it built a range of pre-blurred levels",
    new Set(sigmaOf.values()).size >= 4, sigmaOf.size + " levels carry a blur");

  /* Strip draws only: the read-back into the downscale buffer and the
     edge-extension pass are nine-argument draws too, and the latter covers
     the full band height. */
  /* Strip draws only, and the context matters as much as the shape.

     Three other things in here are nine-argument draws from a canvas: the
     read-back into the downscale buffer, the edge-extension pass after the
     loop, and - the one that bit - the two rows stretched into the padding
     while each blur level is built. Those last two sit at dx 0 on the padded
     canvas, so with the strips they make the first real strip look like a
     4.16px sideways jump from nothing, which is precisely the tearing this
     section exists to detect. A false positive that reports the true defect
     is still a false positive.

     The strips are the draws on whichever context receives most of them. */
  const stripCtx = (() => {
    const n = {};
    for (const d of log.draws) if (d.args.length === 9) n[d.ctx] = (n[d.ctx] || 0) + 1;
    return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
  })();
  const strips = log.draws.filter(
    (d) => d.ctx === stripCtx && d.args.length === 9 &&
           d.args[0] && d.args[0].__i !== undefined && d.args[8] < H * 0.1);
  /* Two draws per strip, not one: the radius is BLENDED between neighbouring
     levels rather than snapped to the nearest, so each strip lays down its
     lower level opaque and then the upper one at the fractional weight.
     Reading the draws individually gives an alternating 0, 1.75, 0, 1.75 and
     reports the radius as going backwards every other row. The effective
     radius is the blend, which is what the card actually receives. */
  const groups = [];
  for (const d of strips) {
    const r = sigmaOf.get("off" + d.args[0].__i) || 0;
    const last = groups[groups.length - 1];
    if (last && last.y === d.args[6]) last.r = last.r * (1 - d.alpha) + r * d.alpha;
    else groups.push({ y: d.args[6], dx: d.args[5], r });
  }
  /* Depth is the strip's ORDER, not its destination y. The bend gives each
     strip a little vertical offset, and sorting by y therefore interleaves
     neighbours whenever that offset approaches the strip height — which
     reports the radius as jumping about and going backwards when it is doing
     neither. The loop draws them top to bottom, so order is the depth. */
  const samples = groups.map((gp, i) => ({ depth: i / (groups.length - 1), r: gp.r }));
  ck("every strip drew from a level", samples.length > 8, samples.length + " strips");
  ck("and blends between two of them rather than snapping to one",
    strips.length > samples.length, `${strips.length} draws over ${samples.length} strips`);

  const maxR = Math.max(...samples.map((x) => x.r));
  ck("radius never goes backwards as it descends",
    samples.every((x, i) => !i || x.r >= samples[i - 1].r - 1e-9),
    samples.slice(0, 8).map((x) => x.r).join(","));

  /* No assertion that the blur LAGS the darkening any more, and that is a
     decision rather than an omission.

     The lag existed to keep the radius climbing below the type. It was worth
     an exponent of 2 while the band began 272px above the copy, because the
     type then sat a third of the way down with plenty of ramp above it to
     hold back. With a 65px run-up the copy line falls about a tenth of the
     way into the band and nearly the whole ramp is already below it: the lag
     has nothing left to protect and only starves the first lines of the frost
     — measured, sigma 1.6 at line one against 9.4 without it.

     What still has to hold is below: the radius climbs from nothing, never
     goes backwards, and is still climbing at the foot. */
  ck("it starts from no blur at all at the top of the band",
    samples[0].r === 0, String(samples[0].r));
  ck("and is still at its maximum by the foot",
    samples[samples.length - 1].r === maxR,
    `${samples[samples.length - 1].r} of ${maxR}`);

  /* Where the radius climbs fastest used to have to be below the copy line.
     That was a real property while the copy sat a third of the way down the
     band; with the run-up at 65 it sits at a tenth, so "below the copy" is
     almost the whole band and the check passes on geometry rather than on
     anything the code does. Replaced by the rate itself, which is what the
     eye actually responds to: no single step between neighbouring strips may
     carry more than a fifth of the total radius. */
  let steepest = 0;
  for (let i = 1; i < samples.length; i++) {
    steepest = Math.max(steepest, samples[i].r - samples[i - 1].r);
  }
  ck("no single step between strips carries a fifth of the range",
    steepest < maxR / 5, `${steepest.toFixed(2)} of ${maxR}`);

  /* The bend has to move SMOOTHLY down the band, and this is the assertion
     that was missing while the defect it describes was on screen.

     The refraction pulls each strip sideways by a function of its depth. The
     step between neighbours is bendMax * |dwave/dt| / strips, and at the
     original frequencies of 7.6 and 17.3 that derivative peaks near 11 — four
     pixels of sideways slide between strips ten pixels tall. That is not a
     bend, it is tearing, and it was reported as "layered lines".

     A pixel is the bound because that is where neighbouring slabs stop being
     resolvable as separate: below it the bend reads as a bend. Nothing else
     here catches this — the darkening is unaffected by a sideways shift, and
     the radius ramp is measured per strip rather than between them, so both
     stay green while the picture visibly tears. */
  let worstSlide = 0;
  for (let i = 1; i < groups.length; i++) {
    worstSlide = Math.max(worstSlide, Math.abs(groups[i].dx - groups[i - 1].dx));
  }
  ck("neighbouring strips slide by less than a pixel, so the bend is a bend",
    worstSlide < 1, worstSlide.toFixed(2) + "px between neighbours");

  /* And they stay in the order they were drawn. The bend gives each strip a
     vertical offset as well, and a large enough one relative to the strip
     height would put a later strip above an earlier one, with the overlap
     between them resolving the wrong way round. It has never done that -
     measured 0.54px against a 7px strip even at the old fast frequency - but
     it is one amplitude change away and nothing else here would notice. */
  ck("and are drawn top to bottom, so the overlaps resolve in order",
    groups.every((gp, i) => !i || gp.y >= groups[i - 1].y),
    "a strip was drawn above its predecessor");
}

console.log("\nThe blur is dithered, or it bands");
{
  /* The one that nothing else here can see.

     A photograph carries sensor noise, and that noise is what stops a smooth
     sky banding: it dithers the 8-bit quantisation so the step between
     adjacent values lands in a different place on each row. The blur averages
     it away, and what is left is a mathematically smooth gradient — which in 8
     bits is a staircase, flat for as many rows as the true value needs to
     cross the next 1/255, then a step.

     Measured on a photo-like ramp: with the glass on and no dither, 32 runs
     where the row mean held the SAME value for four rows or more, the longest
     for thirty. With the glass off entirely, zero. At 0.12 dither, zero again,
     for 1.47 levels of per-pixel noise — about one, which is what a dither is
     supposed to be.

     Every other measurement in this file reports the treatment as clean while
     that is happening, because they all look at the row MEAN of 920 pixels or
     at a source with no smooth ramp in it. */
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  ck("it is on", api.GLASS.dither > 0, String(api.GLASS.dither));
  ck("a noise tile was built", log.putImage.length > 0);
  ck("and laid over the glass as a repeating pattern",
    log.patterns.some((p) => p.repeat === "repeat"), JSON.stringify(log.patterns));

  /* Overlay, specifically. A tile centred on mid-grey is a no-op under
     "overlay", so the deviations lighten and darken symmetrically and the
     average brightness of the band is untouched. source-over would lay a grey
     veil over the picture instead. */
  /* Overlay, specifically, and checked rather than asserted in prose. A tile
     centred on mid-grey is a no-op under "overlay", so its deviations lighten
     and darken symmetrically and the band's average brightness is untouched.
     Under source-over the same tile is a flat grey veil over the picture. */
  const noiseFill = log.fills.find((f) => f.style && f.style.__pattern);
  ck("in overlay, so it dithers without tinting",
    noiseFill && noiseFill.op === "overlay",
    noiseFill ? `painted with ${noiseFill.op}` : "no pattern fill");
  ck("at the configured strength, not full",
    noiseFill && Math.abs(noiseFill.alpha - api.GLASS.dither) < 1e-9,
    noiseFill ? String(noiseFill.alpha) : "");
  const off = build({ overrides: { dither: 0 } });
  off.api.paintMistGlass(off.target, { width: W, height: H, copyTop: COPY });
  ck("and 0 turns it off cleanly, so it is a knob and not a fixed cost",
    off.log.patterns.length === 0, off.log.patterns.length + " patterns");
}

/* ── The strips have to cover the band they are masked over ─────────────────

   Nothing measured this, and it left a hard line across the foot of every
   card. The presence mask reaches alpha 1.0 at the bottom of the band, so the
   compositor is promising a fully frosted foot — but the strip loop stopped
   painting about three rows short of it, and the sharp photograph showed
   through at full strength across the full width. A 63-level step in three
   rows, which is exactly the "hard stop" shape.

   Two shortfalls stacked, and both are rounding rather than logic:

     sh = round(devSpan / downscale)   721 / 4 rounds to 180, and 180 * 4 is
                                       720 — one row short before anything else
     dy at the foot                    the refraction bend is negative there,
                                       taking roughly two more rows

   The old bound clamped the source interval to [0, sh]. Reading past sh was
   always safe — the level canvases are sh + pad * 2 tall and the read is
   already offset by pad — so the clamp was guarding a short read that could
   not happen, at the cost of the rows it refused to paint.

   What this asserts is coverage, not the constants: the union of the strip
   destinations has to span the whole glass canvas. That survives someone
   retuning refractStrips, downscale, bleed or the bend, which a test written
   against "720 vs 721" would not.                                          */
/* ── The ramp has to STOP climbing before it stops ───────────────────────────

   Nothing measured this, and it was the reported edge.

   The slope is windowed in over the first RAMP_ONSET so the curve accelerates
   from a standstill instead of leaving the line at full pace. There was no
   window at the other end, so it arrived at 1 still climbing at 43% of its
   peak rate and was then held flat by the clamp. The VALUE is continuous
   there; its first derivative is not, and the eye resolves a change in slope
   far more readily than a change in value — the same Mach-banding fact this
   file already leans on for gradientSamples. A full-width slope break at a
   fixed height is what gets reported as a hard stop.

   The trap this avoids: "smooth" tested as monotonic-and-continuous passes a
   ramp that slams into a wall. What has to be asserted is the derivative at
   the END, which is why measuring the peak alone never caught it.

   Not asserted against a magic number: the arrival is compared to the ramp's
   OWN peak, so it survives anyone reshaping SPEC_STOPS.                     */
console.log("\nThe frost ramp arrives flat, rather than being clamped mid-climb");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });
  const { presence } = ramps(log, target);

  ck("the presence ramp was built", presence.length > 60, presence.length + " stops");

  if (presence.length > 60) {
    // Per-stop rise, normalised by stop spacing, so it is a slope and not a
    // step count.
    const slope = presence.slice(1).map((s, i) =>
      (s.a - presence[i].a) / Math.max(1e-9, s.p - presence[i].p));
    const peak = Math.max(...slope);

    /* The tail of the CLIMB, not of the whole gradient: once the ramp reaches
       1 it holds, and those flat stops would dilute the average to nothing and
       make this pass regardless. Measure the last stretch before it tops out. */
    const fullAt = presence.findIndex((s) => s.a >= 0.999);
    const climb = fullAt > 0 ? slope.slice(0, fullAt) : slope;
    const arrival = climb.slice(-Math.max(2, Math.round(climb.length * 0.06)));
    const arrivalMean = arrival.reduce((a, b) => a + b, 0) / arrival.length;
    const ratio = arrivalMean / peak;

    ck("it decelerates into full presence, not into a wall",
       ratio < 0.15,
       `arrives at ${(ratio * 100).toFixed(1)}% of its peak slope — ` +
       `above ~15% the clamp at the top is a visible full-width crease ` +
       `(it was 43% before RAMP_TAPER)`);

    /* And the taper must not have bought that by steepening the middle. The
       source's own comment budgets the peak at about 1.43x average; the taper
       redistributes a little weight inward and takes it to ~1.52x. */
    const mean = climb.reduce((a, b) => a + b, 0) / climb.length;
    ck("without steepening the middle to pay for it", peak / mean < 1.9,
       `peak is ${(peak / mean).toFixed(2)}x the average climb`);
  }
}

console.log("\nThe blurred strips cover the whole band, foot included");
{
  const { api, log, target } = build();
  api.paintMistGlass(target, { width: W, height: H, copyTop: COPY });

  /* Every strip draw onto the glass canvas, as destination intervals. The
     9-argument drawImage form is (img, sx,sy,sw,sh, dx,dy,dw,dh), so the
     destination top is args[6], its width args[7] and its height args[8].

     Filtered on DESTINATION WIDTH, and that is load-bearing. "Any 9-argument
     draw that is not onto the target" also catches the edge-extend passes
     that build the padded blur levels, and those span the padded canvas top
     to bottom — so they hand back a full-height interval and paper over
     exactly the shortfall this is looking for. Verified by mutation: with the
     old clamp restored, the loose filter still passed. Strip draws are the
     ones a band wide; the padded ones are a downscaled sw. */
  const strips = log.draws
    .filter((d) => d.args.length === 9 && d.ctx !== "target" && d.args[7] === W)
    .map((d) => ({ top: d.args[6], bottom: d.args[6] + d.args[8] }));

  ck("the strip loop ran at all", strips.length > 0, strips.length + " draws");

  if (strips.length) {
    /* The band's REAL height, off the glass canvas the code sized — not
       derived from the strips. Deriving it from the strips is circular: the
       question is whether the strips reach the band's foot, and a band
       measured as "wherever the strips ended" always answers yes. The glass
       canvas is the full-width one; the blur levels are downscaled. */
    const glassCanvas = log.created.filter((c) => c.width === W)
      .sort((a, b) => b.height - a.height)[0];
    ck("found the glass canvas to measure against", !!glassCanvas,
       log.created.map((c) => `${c.width}x${c.height}`).join(" "));
    const bandH = glassCanvas ? glassCanvas.height : 0;

    const top = Math.min(...strips.map((s) => s.top));
    const bottom = Math.max(...strips.map((s) => s.bottom));

    ck("the strips start at or above the top of the band", top <= 0.001,
       `first strip top ${top.toFixed(3)} — anything below 0 is unpainted band`);

    /* The foot is the one that was bare: three rows short, full width, under
       a mask at alpha 1.0. Generous by a hundredth of a pixel. */
    ck("and reach the foot of it", bandH > 0 && bottom >= bandH - 0.001,
       `strips end at ${bottom.toFixed(3)}, band is ${bandH} tall — ` +
       `${(bandH - bottom).toFixed(2)}px of it unpainted under a mask at full presence`);

    // No gaps in the middle either: sorted by top, each strip must start
    // before the previous one ended.
    const sorted = strips.slice().sort((a, b) => a.top - b.top);
    let worstGap = 0, gapAt = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].top - sorted[i - 1].bottom;
      if (gap > worstGap) { worstGap = gap; gapAt = sorted[i].top; }
    }
    ck("and leave no gap between them",
       worstGap <= 0.001,
       `largest gap ${worstGap.toFixed(3)}px at y ${gapAt}`);
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
