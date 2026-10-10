/* ── Render coalescing ───────────────────────────────────────────────────────

   Run: node test/render.mjs

   renderPoster() repaints every page and the X preview. Called straight out of
   an input handler that is 5-20ms per keystroke, and a fast typist outruns it:
   the events queue and each one paints a frame nobody will ever see. The
   display refreshes 60 times a second, so more than one paint per frame is
   work thrown away by definition.

   Two halves, and the second is the one that can bite:

     continuous input coalesces   typing, sliders and drags schedule a paint
                                  for the next frame instead of forcing one
     everything else stays sync   the export path, the X preview and the
                                  screen-preview modal paint and then read the
                                  canvas straight back. Defer those and they
                                  read a stale or empty canvas — a published
                                  card missing its last edit, with nothing to
                                  show that anything went wrong.

   So this checks the split as well as the mechanism: it is not enough that
   scheduling works, the right callers have to be using it. */
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

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

console.log("\nA burst of input collapses into one paint");
{
  const frame = [];
  let painted = 0;
  const scheduleRender = new Function("requestAnimationFrame", "renderPoster", "liveCards", "settleRender", `
    let renderScheduled = false;
    ${fnSrc("scheduleRender")}
    return scheduleRender;
  `)((cb) => frame.push(cb), () => { painted++; }, () => new Set(), () => {});

  for (let i = 0; i < 60; i++) scheduleRender();
  ck("60 keystrokes queue a single frame callback", frame.length === 1, frame.length + " callbacks");
  ck("and nothing has painted yet", painted === 0, String(painted));
  frame.forEach((cb) => cb());
  ck("the frame paints exactly once", painted === 1, String(painted));

  // The flag must clear, or the very next keystroke is ignored forever.
  for (let i = 0; i < 5; i++) scheduleRender();
  ck("it re-arms for the next burst", frame.length === 2, frame.length + " callbacks");
  frame[1]();
  ck("which paints once more", painted === 2, String(painted));
}

console.log("\nContinuous input schedules; it does not force a paint");
{
  // The handlers that fire faster than the display refreshes.
  const handlers = [
    ["headline typing",      /headlineEdit\.addEventListener\("input"[\s\S]{0,400}?\}\);/],
    ["detail typing",        /detailEdit\.addEventListener\("input"[\s\S]{0,400}?\}\);/],
    ["story heading typing", /story-heading-edit"\)\?\.addEventListener\("input"[\s\S]{0,200}?\}\);/],
    ["story body typing",    /story-body-edit"\)\?\.addEventListener\("input"[\s\S]{0,200}?\}\);/],
    ["pan X slider",         /imgOffsetX\.addEventListener\("input"[\s\S]{0,200}?\}\);/],
    ["pan Y slider",         /imgOffsetY\.addEventListener\("input"[\s\S]{0,200}?\}\);/],
    ["font size slider",     /fontSizeInput\.addEventListener\("input"[\s\S]{0,200}?\}\);/],
    ["accent colour picker", /accentColorInput\.addEventListener\("input"[\s\S]{0,300}?\}\);/],
    // The pointer ones fire at the mouse's rate, which is faster still.
    ["dragging the poster",  /window\.addEventListener\("mousemove"[\s\S]{0,700}?\}\);/],
    ["dragging video focus", /state\.videoFocus = next;[\s\S]{0,60}?\}/],
    ["video caption typing", /videoCaptionInput\.addEventListener\("input"[\s\S]{0,200}?\}\);/],
  ];
  for (const [label, re] of handlers) {
    const m = app.match(re);
    if (!m) { ck(label + " found", false, "handler not matched"); continue; }
    ck(label + " coalesces", /scheduleRender\(\)/.test(m[0]) && !/[^e]renderPoster\(\)/.test(m[0]),
      m[0].includes("renderPoster()") ? "still forces a paint" : "does not schedule");
  }
}

console.log("\nA scheduled paint covers the page being edited; the rest follow when the hand stops");
{
  /* Every card of every page was repainted for every keystroke and every
     pixel of a drag. A scheduled render now paints the ACTIVE page's cards on
     the frame and leaves the others to a settle timer, so the cost of a drag
     no longer grows with the number of pages in the post. */
  const frame = [];
  const timers = [];
  const paints = [];
  const a = { id: "a" }, b = { id: "b" }, other = { id: "other" };
  const harness = new Function("requestAnimationFrame", "renderPoster", "activePage", "setTimeout", "clearTimeout", `
    let renderScheduled = false;
    const SETTLE_MS = 150;
    let settleTimer = 0;
    ${fnSrc("liveCards")}
    ${fnSrc("settleRender")}
    ${fnSrc("scheduleRender")}
    return { scheduleRender, liveCards };
  `)((cb) => frame.push(cb), (opts) => paints.push(opts), () => ({ cards: [a, b] }),
     (cb) => { timers.push(cb); return timers.length; }, () => {});

  harness.scheduleRender();
  frame.shift()();
  ck("the frame paints only the active page's cards",
    paints.length === 1 && paints[0] && paints[0].cards instanceof Set &&
    paints[0].cards.has(a) && paints[0].cards.has(b) && !paints[0].cards.has(other),
    JSON.stringify(paints[0] && [...(paints[0].cards || [])]));
  ck("and arms a settle timer for everything else", timers.length === 1, timers.length + " timers");
  timers.shift()();
  ck("which paints the lot, with no restriction",
    paints.length === 2 && paints[1] === undefined, JSON.stringify(paints[1]));

  const body = fnSrc("renderPoster");
  ck("renderPoster honours the restriction per card",
    /only && !only\.has\(card\)/.test(body));
  ck("and leaves the X preview to the full paint",
    /if \(!only\) \{[\s\S]{0,200}paintCardInto\(xPreviewCanvas, "x"\)/.test(body));
  ck("a non-Set argument — an Event from a listener — paints everything",
    /opts\.cards instanceof Set \? opts\.cards : null/.test(body));

  const loop = fnSrc("startVideoPreviewLoop");
  ck("playback repaints the video cards, not the whole post",
    /renderPoster\(\{ cards: videoCards\(\) \}\)/.test(loop));
  ck("but settles on the final frame with a full paint",
    /videoPreviewRaf = 0;\s*renderPoster\(\);/.test(loop));
}

console.log("\nPaths that read the canvas back still paint synchronously");
{
  // scheduleRender must not have been pushed into renderPoster itself: the
  // export path calls renderPoster and then reads pixels in the same tick.
  const body = fnSrc("renderPoster");
  ck("renderPoster paints inline, never defers to a frame",
    !/requestAnimationFrame/.test(body) && !/scheduleRender/.test(body));
  ck("the targeted-render fast path is intact",
    /_targetedRender/.test(body), "export paths rely on this");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
