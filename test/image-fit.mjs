/* ── Fitting a photograph into the frame ─────────────────────────────────────

   Run: node test/image-fit.mjs

   Zoom multiplies the COVER scale — the scale at which the picture fills the
   frame and the overflow is cropped. A 16:9 photograph on a 9:16 poster loses
   about 68% of itself that way. Fit is the other scale: the largest the
   picture can be with all of it inside the frame, letterboxed against the
   backdrop.

   Two things have to hold, and both have been wrong here:

     fit must actually fit      the zoom control carries whole percentages, and
                               rounding UP puts the picture back over the edge
                               it was just fitted inside — 27.7 becomes 28 and
                               overflows by 11px, one crop short of doing its job
     a small photo centres      clamping exists to stop a pan dragging an empty
                               edge into frame, and only means anything while
                               the picture is bigger than the frame. Applied
                               below that, min runs past max and clamp()
                               collapses to the maximum, pinning the photograph
                               into the top-left corner instead of the middle */
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
const HEADROOM = Number(app.match(/^const IMAGE_PAN_HEADROOM = ([\d.]+)/m)[1]);
// applyZoom clamps to ZOOM_MIN, so it is also the floor on Fit.
const ZOOM_MIN = Number(app.match(/^const ZOOM_MIN = (\d+);/m)[1]);

const FRAME_W = 920, FRAME_H = 1700;   // the 9:16 poster

// fitZoomFor reads the live canvas; the draw helper needs a ctx and a clamp.
function makeApi() {
  const drawn = [];
  const api = new Function("canvas", "ctx", "clamp", "IMAGE_PAN_HEADROOM", "buildFilterString", "drawn", "ZOOM_MIN", `
    ${fnSrc("fitZoomFor")}
    ${fnSrc("deviceFilter")}
    ${fnSrc("drawCoverImage")}
    return { fitZoomFor, drawCoverImage };
  `)(
    { width: FRAME_W, height: FRAME_H },
    { save() {}, restore() {}, set filter(v) {}, drawImage: (...a) => drawn.push(a) },
    (v, min, max) => Math.min(max, Math.max(min, v)),
    HEADROOM,
    () => "none",
    drawn,
    ZOOM_MIN,
  );
  return { api, drawn };
}

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

console.log("\nFit puts the whole picture inside the frame, whatever its shape");
{
  const { api } = makeApi();
  const shapes = [
    ["16:9 landscape", 1600, 900],
    ["4:3 landscape", 1200, 900],
    ["1:1 square", 1000, 1000],
    ["9:16 portrait", 900, 1600],
    ["small landscape", 640, 360],
    ["very wide panorama", 3000, 600],
  ];
  for (const [label, w, h] of shapes) {
    const zoom = api.fitZoomFor({ width: w, height: h });
    const cover = Math.max(FRAME_W / w, FRAME_H / h) * HEADROOM;
    const scale = cover * (zoom / 100);
    const dw = w * scale, dh = h * scale;
    ck(`${label} fits (${zoom}%)`,
      dw <= FRAME_W + 0.5 && dh <= FRAME_H + 0.5,
      `drawn ${Math.round(dw)}x${Math.round(dh)} in ${FRAME_W}x${FRAME_H}`);
  }
}

console.log("\nA fitted photograph is centred, not pinned to a corner");
{
  const { api, drawn } = makeApi();
  const img = { width: 1600, height: 900 };
  const zoom = api.fitZoomFor(img);
  api.drawCoverImage(img, 0, 0, FRAME_W, FRAME_H, { x: 0, y: 0 }, zoom / 100);
  const [, dx, dy, dw, dh] = drawn[drawn.length - 1];
  const above = dy, below = FRAME_H - (dy + dh);
  const left = dx, right = FRAME_W - (dx + dw);
  ck("equal black above and below", Math.abs(above - below) <= 1, `${above.toFixed(0)} vs ${below.toFixed(0)}`);
  ck("equal black left and right", Math.abs(left - right) <= 1, `${left.toFixed(0)} vs ${right.toFixed(0)}`);
  ck("it is letterboxed, not filling", above > 1, `${above.toFixed(0)}px of backdrop`);
}

console.log("\nFilling the frame still crops, and still cannot show the backdrop");
{
  const { api, drawn } = makeApi();
  const img = { width: 1600, height: 900 };
  api.drawCoverImage(img, 0, 0, FRAME_W, FRAME_H, { x: 0, y: 0 }, 1);   // 100% = cover
  const [, dx, dy, dw, dh] = drawn[drawn.length - 1];
  ck("covers the frame completely", dw >= FRAME_W && dh >= FRAME_H, `${Math.round(dw)}x${Math.round(dh)}`);
  ck("no gap at any edge", dx <= 0 && dy <= 0 && dx + dw >= FRAME_W && dy + dh >= FRAME_H);
}

console.log("\nA pan on an oversized picture is still held inside the frame");
{
  const { api, drawn } = makeApi();
  const img = { width: 1600, height: 900 };
  // Shove it far past the edge; the clamp must still bite while it is bigger.
  api.drawCoverImage(img, 0, 0, FRAME_W, FRAME_H, { x: 5000, y: 5000 }, 1);
  const [, dx, dy, dw, dh] = drawn[drawn.length - 1];
  ck("cannot be dragged off to reveal the backdrop",
    dx <= 0 && dy <= 0 && dx + dw >= FRAME_W && dy + dh >= FRAME_H,
    `x ${dx.toFixed(0)}, y ${dy.toFixed(0)}`);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
