/* ── Face Lock: the original faces back in a redraw ─────────────────────────

   Run: node test/face-lock.mjs

   Reframe hands back gpt-image-1.5's redraw, and in the redraw every face was
   drawn again: the reviewers compared a reframe with its source and saw two
   different people. lib/face-lock.js lays the original faces back in. What is
   held down here, on scenes whose right answer is known:

     - the face that comes back is the ORIGINAL's — its mouth, its eyes, its
       mole — not the one the model drew, and nothing outside the face moves;
     - it arrives in the redraw's light, with no seam at its edge;
     - a head the model turned is left as drawn and counted, not forced;
     - a face the model already kept is left alone;
     - faces are paired by where they are, and an extra person is ignored;
     - YuNet's outputs decode to the right boxes and landmarks;
     - the server runs it on Reframe and AI Upscale and nowhere else, and the
       status line says what happened.

   The detector is faked with the known landmarks: what is under test is the
   pairing and the repair, not YuNet. */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { decodeRgb } from "../lib/hd-upscale.js";
import {
  lockFaces, pairFaces, fitSimilarity, applySimilarity, landmarkMisfit, faceOval, ovalRadius, blurF32,
} from "../lib/face-lock.js";
import { decodeYuNet, suppressOverlaps } from "../lib/face-detect.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), "utf8").replace(/\r\n/g, "\n");
const server = read("..", "server.mjs");
const app = read("..", "public", "app.js");

function fnSrc(src, name) {
  const a = src.indexOf("function " + name);
  if (a < 0) throw new Error("missing function " + name);
  let k = src.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

let pass = 0, fail = 0;
function ck(label, ok, extra = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`); }
}

/* ── A face, in its own units ──
   Eye centres at (±40, 0), nose tip (0, 40), mouth corners (±30, 85). The
   mole on the cheek, the brown eyes and the smile are this person; the
   redraw gets blue eyes, a frown and no mole. */
const LANDMARKS = [[-40, 0], [40, 0], [0, 40], [-30, 85], [30, 85]];
function face({ redrawn = false, skin = "#e0ac88" } = {}) {
  const iris = redrawn ? "#3a5a8a" : "#2a1a0a";
  const mouth = redrawn ? "M -30 95 Q 0 70 30 95" : "M -30 85 Q 0 105 30 85";
  const eyeDy = redrawn ? 4 : 0;
  return `
    <ellipse cx="0" cy="40" rx="120" ry="150" fill="${skin}"/>
    <path d="M -130 -30 Q 0 -190 130 -30 L 130 -80 Q 0 -200 -130 -80 Z" fill="#3b2412"/>
    <path d="M -62 -24 Q -40 -36 -18 -26" stroke="#3b2412" stroke-width="6" fill="none"/>
    <path d="M 18 -26 Q 40 -36 62 -24" stroke="#3b2412" stroke-width="6" fill="none"/>
    <ellipse cx="-40" cy="${eyeDy}" rx="22" ry="11" fill="#fff"/><circle cx="-40" cy="${eyeDy}" r="8" fill="${iris}"/>
    <ellipse cx="40" cy="${eyeDy}" rx="22" ry="11" fill="#fff"/><circle cx="40" cy="${eyeDy}" r="8" fill="${iris}"/>
    <path d="M 0 5 L -10 40 L 10 40" stroke="#9b6a4c" stroke-width="4" fill="none"/>
    <path d="${mouth}" stroke="#8b2a2a" stroke-width="8" fill="none" stroke-linecap="round"/>
    ${redrawn ? "" : '<circle cx="-55" cy="55" r="7" fill="#7a4a30"/>'}`;
}

// The original: a landscape news still, the face at (400, 200), life size.
// `wall` stands a bright wall against the right cheek, as behind a turned head.
const OW = 800, OH = 450;
const ORIGINAL_AT = { x: 400, y: 200, s: 1 };
function originalSvg({ wall = false } = {}) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OW}" height="${OH}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7d9cc4"/><stop offset="1" stop-color="#e8dcc8"/></linearGradient></defs>
    <rect width="${OW}" height="${OH}" fill="url(#g)"/>
    <rect x="40" y="300" width="250" height="150" fill="#2b2b2b"/>
    <g transform="translate(${ORIGINAL_AT.x} ${ORIGINAL_AT.y}) scale(${ORIGINAL_AT.s})">${face()}
      ${wall ? '<rect x="75" y="-10" width="80" height="130" fill="#eef3f8"/>' : ""}</g>
  </svg>`);
}

// The redraw: portrait, a new setting, the same face 1.5x larger at (512, 600).
const RW = 1024, RH = 1536;
const REDRAW_AT = { x: 512, y: 600, s: 1.5 };
function redrawSvg({ redrawn = true, at = REDRAW_AT } = {}) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${RW}" height="${RH}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9b9a4"/><stop offset="1" stop-color="#4a3a2c"/></linearGradient></defs>
    <rect width="${RW}" height="${RH}" fill="url(#g)"/>
    <rect x="0" y="1100" width="${RW}" height="436" fill="#1d1410"/>
    <rect x="80" y="80" width="200" height="300" fill="#f4efe6" stroke="#8a7a66" stroke-width="6"/>
    <g transform="translate(${at.x} ${at.y}) scale(${at.s})">${face({ redrawn })}</g>
  </svg>`);
}

const place = (at, pts = LANDMARKS) => pts.map(([u, v]) => [at.x + at.s * u, at.y + at.s * v]);
const ORIGINAL_POINTS = place(ORIGINAL_AT);
const REDRAW_POINTS = place(REDRAW_AT).map(([x, y], i) => [x + (i % 2 ? 0.8 : -0.6), y + (i % 3 ? -0.5 : 0.7)]);

const png = (svg) => sharp(svg).png().toBuffer();
const asFace = (points) => ({ x: points[0][0] - 50, y: points[0][1] - 50, w: 150, h: 200, score: 0.95, points });
// The detector, faked: each picture's faces by its width.
const detectorFor = (byWidth) => ({ async detect(_sharp, rgb) { return (byWidth[rgb.width] || []).map(asFace); } });

function meanAbs(a, b, r) {
  let s = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const j = (y * a.width + x) * 3;
    for (let c = 0; c < 3; c++) { s += Math.abs(a.data[j + c] - b.data[j + c]); n++; }
  }
  return s / n;
}
function meanDiff(a, b, r) {
  let s = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const j = (y * a.width + x) * 3;
    for (let c = 0; c < 3; c++) { s += a.data[j + c] - b.data[j + c]; n++; }
  }
  return s / n;
}
const px = (img, x, y) => { const j = (Math.round(y) * img.width + Math.round(x)) * 3; return [img.data[j], img.data[j + 1], img.data[j + 2]]; };

// Eyes to mouth, cheek to cheek, inside the part that is replaced outright.
const core = (() => {
  const [x0, y0] = [REDRAW_AT.x + REDRAW_AT.s * -50, REDRAW_AT.y + REDRAW_AT.s * -15];
  const [x1, y1] = [REDRAW_AT.x + REDRAW_AT.s * 50, REDRAW_AT.y + REDRAW_AT.s * 95];
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
})();
// Generously round the face: nothing outside this may change.
const around = (() => {
  const [x0, y0] = [REDRAW_AT.x + REDRAW_AT.s * -200, REDRAW_AT.y + REDRAW_AT.s * -200];
  const [x1, y1] = [REDRAW_AT.x + REDRAW_AT.s * 200, REDRAW_AT.y + REDRAW_AT.s * 280];
  return { x0, y0, x1, y1 };
})();

console.log("\nGeometry");
{
  const T0 = { a: 1.7 * Math.cos(0.1), b: 1.7 * Math.sin(0.1), tx: 30, ty: -12 };
  const src = [[10, 20], [90, 25], [50, 60], [20, 100], [80, 104]];
  const dst = src.map((p) => applySimilarity(T0, p));
  const T = fitSimilarity(src, dst);
  ck("a similarity is recovered from five landmarks", Math.abs(T.scale - 1.7) < 1e-6
    && Math.abs(T.tx - 30) < 1e-6 && Math.abs(T.ty + 12) < 1e-6 && landmarkMisfit(T, src, dst) < 1e-6, JSON.stringify(T));

  const o = faceOval(REDRAW_POINTS);
  const mole = [REDRAW_AT.x + REDRAW_AT.s * -55, REDRAW_AT.y + REDRAW_AT.s * 55];
  const eyeCorner = [REDRAW_AT.x + REDRAW_AT.s * -62, REDRAW_AT.y];
  const hair = [REDRAW_AT.x, REDRAW_AT.y + REDRAW_AT.s * -110];
  const ear = [REDRAW_AT.x + REDRAW_AT.s * -125, REDRAW_AT.y + REDRAW_AT.s * 30];
  ck("the oval takes the eyes and the cheek outright", ovalRadius(o, ...mole) < 0.75 && ovalRadius(o, ...eyeCorner) < 0.75,
    `${ovalRadius(o, ...mole).toFixed(2)}, ${ovalRadius(o, ...eyeCorner).toFixed(2)}`);
  ck("…and stops short of the hairline and the ear", ovalRadius(o, ...hair) > 1 && ovalRadius(o, ...ear) > 1,
    `${ovalRadius(o, ...hair).toFixed(2)}, ${ovalRadius(o, ...ear).toFixed(2)}`);

  const flat = new Float32Array(50 * 40).fill(7);
  ck("the blur keeps a flat field flat at every width", [0.6, 2, 3, 9, 25].every((s) =>
    blurF32(flat, 50, 40, s).every((v) => Math.abs(v - 7) < 1e-4)));
}

console.log("\nPairing");
{
  const T = { a: 1.5, b: 0, tx: -88, ty: 300 };
  const left = place({ x: 250, y: 200, s: 0.8 }), right = place({ x: 560, y: 210, s: 0.8 });
  const stranger = place({ x: 900, y: 1300, s: 0.6 });
  const pairs = pairFaces(
    [left, right].map(asFace),
    [right.map((p) => applySimilarity(T, p)), stranger, left.map((p) => applySimilarity(T, p))].map(asFace),
  );
  ck("two people pair left with left, right with right", JSON.stringify(pairs) === "[[0,2],[1,0]]", JSON.stringify(pairs));
  ck("a person the redraw added is not paired with anyone", !pairs.some(([, r]) => r === 1));
  ck("no faces, no pairs", pairFaces([], [asFace(left)]).length === 0 && pairFaces([asFace(left)], []).length === 0);
}

console.log("\nYuNet decoding");
{
  const outputs = {};
  for (const s of [8, 16, 32]) {
    const n = (640 / s) ** 2;
    outputs[`cls_${s}`] = { data: new Float32Array(n) };
    outputs[`obj_${s}`] = { data: new Float32Array(n) };
    outputs[`bbox_${s}`] = { data: new Float32Array(n * 4) };
    outputs[`kps_${s}`] = { data: new Float32Array(n * 10) };
  }
  const i = 5 * 40 + 7;    // stride 16, row 5, column 7
  outputs.cls_16.data[i] = 0.81; outputs.obj_16.data[i] = 1;
  outputs.bbox_16.data.set([0.5, 0.25, Math.log(4), Math.log(6)], i * 4);
  outputs.kps_16.data.set([0.2, 0.3, 0, 0, 0, 0, 0, 0, 0, 0], i * 10);
  outputs.cls_8.data[3] = 0.3; outputs.obj_8.data[3] = 0.3;   // a weak cell, under the bar
  const faces = decodeYuNet(outputs, 0.5);
  const f = faces[0] || {};
  ck("one face, scored sqrt(cls × obj)", faces.length === 1 && Math.abs(f.score - 0.9) < 1e-6, JSON.stringify(faces));
  ck("its box is back in the picture's own pixels", Math.abs(f.x - 176) < 1e-4 && Math.abs(f.y - 72) < 1e-4
    && Math.abs(f.w - 128) < 1e-4 && Math.abs(f.h - 192) < 1e-4, JSON.stringify(f));
  ck("…and so are its landmarks", Math.abs(f.points?.[0][0] - 230.4) < 1e-3 && Math.abs(f.points?.[0][1] - 169.6) < 1e-3,
    JSON.stringify(f.points?.[0]));
  const kept = suppressOverlaps([
    { x: 0, y: 0, w: 100, h: 100, score: 0.8 }, { x: 10, y: 5, w: 100, h: 100, score: 0.95 }, { x: 300, y: 0, w: 80, h: 80, score: 0.7 },
  ]);
  ck("a face seen twice is kept once, the better one", kept.length === 2 && kept[0].score === 0.95);
}

console.log("\nlockFaces — the original face, back in the redraw");
const original = await png(originalSvg());
const redraw = await png(redrawSvg());
const truth = await decodeRgb(sharp, await png(redrawSvg({ redrawn: false })));
const redrawRgb = await decodeRgb(sharp, redraw);
const detector = detectorFor({ [OW]: [ORIGINAL_POINTS], [RW]: [REDRAW_POINTS] });
{
  const { png: out, stats } = await lockFaces(sharp, original, redraw, { detector });
  ck("one face found, paired and replaced", out && stats.original === 1 && stats.redraw === 1
    && stats.paired === 1 && stats.replaced === 1, JSON.stringify(stats));
  const r = await decodeRgb(sharp, out);
  ck("the picture keeps the redraw's size", r.width === RW && r.height === RH);
  const now = meanAbs(r, truth, core), before = meanAbs(redrawRgb, truth, core);
  ck("the face is the original's, not the model's", now < 7 && now < before * 0.5,
    `${now.toFixed(2)} from the true face, the redraw was ${before.toFixed(2)} — ${JSON.stringify(stats.faces[0])}`);
  const iris = px(r, REDRAW_AT.x + REDRAW_AT.s * -40, REDRAW_AT.y);
  ck("brown eyes, not the model's blue", iris[2] < 70 && iris[2] <= iris[0] + 10, JSON.stringify(iris));
  const mole = px(r, REDRAW_AT.x + REDRAW_AT.s * -55, REDRAW_AT.y + REDRAW_AT.s * 55);
  ck("the mole the model dropped is back", mole[0] < 160, JSON.stringify(mole));
  let changed = 0;
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    if (x >= around.x0 && x < around.x1 && y >= around.y0 && y < around.y1) continue;
    const j = (y * RW + x) * 3;
    if (r.data[j] !== redrawRgb.data[j] || r.data[j + 1] !== redrawRgb.data[j + 1] || r.data[j + 2] !== redrawRgb.data[j + 2]) changed++;
  }
  ck("nothing outside the face changes — not one pixel", changed === 0, `${changed} pixels`);
}
{
  // The redraw relit the whole scene 18 levels brighter.
  const brighter = await sharp(redraw).removeAlpha().linear(1, 18).png().toBuffer();
  const lit = await decodeRgb(sharp, brighter);
  const { png: out, stats } = await lockFaces(sharp, original, brighter, { detector });
  const r = await decodeRgb(sharp, out);
  const shift = meanDiff(r, truth, core);
  ck("the face arrives in the redraw's light", stats.replaced === 1 && Math.abs(shift - 18) < 5,
    `${shift.toFixed(1)} levels brighter than the original face, the scene was 18`);
  // Along the oval's edge the result must meet the redraw: no seam.
  const o = faceOval(REDRAW_POINTS);
  let seam = 0, n = 0;
  for (let y = Math.round(o.c[1] - 200); y < o.c[1] + 200; y++) for (let x = Math.round(o.c[0] - 200); x < o.c[0] + 200; x++) {
    const rad = ovalRadius(o, x, y);
    if (rad < 0.97 || rad > 1.0) continue;
    const j = (y * RW + x) * 3;
    for (let c = 0; c < 3; c++) { seam += Math.abs(r.data[j + c] - lit.data[j + c]); n++; }
  }
  ck("no seam where the original face meets the redraw", n > 100 && seam / n < 4, `${(seam / n).toFixed(2)} levels`);
}
{
  /* The detector put the redraw's landmarks a sixth of a face to the right,
     as YuNet's do on a turned face. The face must still land on the head. */
  const off = REDRAW_POINTS.map(([x, y]) => [x + 18, y]);
  const { png: out, stats } = await lockFaces(sharp, original, redraw, {
    detector: detectorFor({ [OW]: [ORIGINAL_POINTS], [RW]: [off] }),
  });
  const r = out && await decodeRgb(sharp, out);
  const now = r ? meanAbs(r, truth, core) : Infinity;
  const shift = stats.faces[0]?.aligned?.shift ?? 0;
  ck("a landmark error is corrected on the pictures themselves", stats.faces[0]?.aligned?.moved
    && Math.abs(shift - 0.15) < 0.03, `moved ${shift} of a face unit, the error was 0.15 — ${JSON.stringify(stats.faces[0])}`);
  ck("…so the face lands on the head, not beside it", now < meanAbs(redrawRgb, truth, core) * 0.6,
    `${now.toFixed(2)} from the true face, the redraw was ${meanAbs(redrawRgb, truth, core).toFixed(2)}`);
}
{
  /* A bright wall against the original's right cheek, where the redraw has
     cheek: skin colour, agreement and the feature polygon must all keep the
     wall out. That white streak down a turned face was the first ghost. */
  const { png: out, stats } = await lockFaces(sharp, await png(originalSvg({ wall: true })), redraw, { detector });
  const r = out && await decodeRgb(sharp, out);
  const cheek = (() => {
    const [x0, y0] = [REDRAW_AT.x + REDRAW_AT.s * 85, REDRAW_AT.y + REDRAW_AT.s * 20];
    const [x1, y1] = [REDRAW_AT.x + REDRAW_AT.s * 110, REDRAW_AT.y + REDRAW_AT.s * 70];
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  })();
  const there = r ? meanAbs(r, redrawRgb, cheek) : Infinity;
  ck("the wall behind a face is never pasted onto the redraw's cheek", stats.replaced === 1 && there < 6,
    `${there.toFixed(2)} levels from the redraw's cheek`);
}
{
  // The redraw drew the face 2.5x the original's size: too far to enlarge.
  const big = { x: 512, y: 700, s: 2.5 };
  const { png: out, stats } = await lockFaces(sharp, original, await png(redrawSvg({ at: big })), {
    detector: detectorFor({ [OW]: [ORIGINAL_POINTS], [RW]: [place(big)] }),
  });
  ck("a face that would be enlarged past 2x is left as drawn and named", out === null && stats.skipped === 1
    && /too small to enlarge/.test(stats.faces[0]?.reason || ""), JSON.stringify(stats.faces[0]));
}
{
  // The model turned the head: nose and mouth swung sideways, one eye foreshortened.
  const turned = REDRAW_POINTS.map(([x, y], i) => [x + [30, -12, 90, 50, 45][i], y]);
  const { png: out, stats } = await lockFaces(sharp, original, redraw, {
    detector: detectorFor({ [OW]: [ORIGINAL_POINTS], [RW]: [turned] }),
  });
  ck("a turned head is not pasted over, it is counted", out === null && stats.skipped === 1 && stats.replaced === 0,
    JSON.stringify(stats.faces));
}
{
  // The model kept the face: the redraw's face is the original's.
  const { png: out, stats } = await lockFaces(sharp, original, await png(redrawSvg({ redrawn: false })), { detector });
  ck("a face the model already kept is left as drawn", out === null && stats.kept === 1, JSON.stringify(stats.faces));
}
{
  const { png: out, stats } = await lockFaces(sharp, original, redraw, { detector: detectorFor({}) });
  ck("no faces: nothing is touched", out === null && stats.original === 0 && stats.replaced === 0);
}

console.log("\nThe server and the status line");
{
  ck("Face Lock runs on Reframe and the plain restore", /if \(job === "reframe" \|\| \(job === "restore" && !restorePrompt\)\)/.test(server)
    && /await faceLockResult\(buffer, png, job\)/.test(server));
  ck("…before the cache, so a repeat press is corrected too",
    server.indexOf("await faceLockResult(buffer, png, job)") < server.indexOf("enhanceCacheSet(cacheKey, payload, png)"));
  ck("the answer says what it did", /\n    faces,\n  \};/.test(server));
  ck("FACE_LOCK=0 switches it off", /const faceLockOff = \/\^\(0\|false\|no\|off\)\$\/i\.test\(env\("FACE_LOCK"\)\)/.test(server));
  ck("the Docker image carries the model", /COPY models \.\/models/.test(read("..", "Dockerfile")));
  ck("the model file is in the repo", existsSync(join(here, "..", "models", "face_detection_yunet_2023mar.onnx")),
    "download it — see models/README.md");
  ck("the runtime is a dependency", /"onnxruntime-node"/.test(read("..", "package.json")), "npm install onnxruntime-node");

  // eslint-disable-next-line no-new-func
  const faceLockNote = new Function(`${fnSrc(app, "faceLockNote")}\nreturn faceLockNote;`)();
  ck("silent without faces", faceLockNote(null) === "" && faceLockNote({ original: 0, redraw: 2 }) === "");
  ck("both faces back", faceLockNote({ original: 2, redraw: 2, paired: 2, replaced: 1, kept: 1, skipped: 0 })
    === " Faces match the original (2 of 2).");
  ck("a face it could not put back is named", /1 face could not be restored from the original and was left as the AI drew it — check before publishing/.test(
    faceLockNote({ original: 2, redraw: 2, paired: 2, replaced: 1, kept: 0, skipped: 1 })));
  ck("faces that could not be paired are named", /could not be matched/.test(
    faceLockNote({ original: 1, redraw: 1, paired: 0, replaced: 0, kept: 0, skipped: 0 })));
  ck("the success line carries it", /faceLockNote\(data\.faces\)/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
