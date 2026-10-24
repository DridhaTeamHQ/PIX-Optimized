/* ── Face Lock: the writer's own faces, back in a redrawn picture ────────────

   Reframe hands the whole photograph to gpt-image-1.5 and takes back a redraw
   at the poster's shape. Every pixel of that answer is the model's, faces
   included, and `input_fidelity: high` narrows the drift without closing it:
   two people at a piano came back as near-likenesses on one press and as
   strangers on the next. On a news poster the face is the one part of the
   picture nobody forgives.

   So the real faces go back in. Only the faces. The rest of the redraw — the
   wider setting, the clothes, the light — is what the reviewer paid for, and
   is left exactly as the model drew it.

     1. Find. Every face in the original and in the redraw, each with five
        landmarks, from YuNet on the server's CPU (lib/face-detect.js).
     2. Pair. Usually the model keeps the viewpoint, so one similarity
        transform carries a group of the original's faces onto the redraw's
        (pairFaces). When it does not — a collage redrawn as one scene, each
        person moved on their own — the rest are paired one by one on whether
        they actually line up (pairLeftovers). A face the redraw lost, or a
        person it added, is left alone.
     3. Check. A face is left as drawn, and named in the status line, when a
        paste would look wrong: the model turned the head or changed the
        expression, the two faces cannot be lined up, or the original is too
        small to enlarge that far. A face the model already kept is left as
        drawn too: only what needs correcting is corrected.
     4. Line up. Landmarks place a turned face a little off, which is what
        laid two noses side by side; the fit is finished on the pictures,
        against the redraw's head (refineAlignment).
     5. Replace. The features come from the original outright; around them,
        whatever is skin in both pictures and agrees between them, so the
        wall behind a turned head never comes along. The original face is
        relit to sit in the redraw's light — the broad shading from the
        redraw, the eyes, lips, smile and texture from the original — and
        feathered in inside its own outline.

   Nothing here is paid for and nothing calls out; it is arithmetic on two
   decoded pictures. `sharp` and the detector are passed in, as in
   lib/hd-upscale.js, so the server loads both lazily and still boots on a
   machine that has neither. */

import { decodeRgb } from "./hd-upscale.js";

/* Landmark misfit, in face units (about one eye distance), past which the
   redraw's head is not in the original's pose. Two detections of the same
   face misfit by 0.03–0.06; a head turned 20° moves the nose by ~0.2. */
const POSE_MISFIT = 0.14;
/* The original face would be enlarged past this: visibly softer than the
   redraw around it. A 25px-between-the-eyes face from a screenshot, enlarged
   2.4x, came back as a smudge in the right place — worse than the model's
   stranger. */
const MAX_ENLARGE = 2;
// A face this small in the redraw (eye distance, pixels) is not worth a seam.
const MIN_FACE_PX = 12;
// Structure agreement at which the model kept the face itself. Faithful
// restores score 0.7–0.9 on the same measure in hd-upscale; this is the top.
const KEEP_MATCH = 0.9;
/* How far the head may have turned between the two pictures (faceTurn's
   units) before a pasted face would look one way on a head looking another.
   Two detections of the same pose differ by 0.01–0.09; a redraw that swung a
   three-quarter face towards profile, by 0.2 and more. */
const MAX_TURN_CHANGE = 0.15;
/* How well the two faces' shapes must agree once refineAlignment has lined
   them up. The same person redrawn scores 0.85–0.96; a face the model drew in
   a different shape or at another angle stays under 0.5 however it is moved. */
const MIN_ALIGNED = 0.6;
// How far past the face's oval the alignment search looks, to take in the head.
const ALIGN_REACH = 1.35;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const round3 = (v) => Number(v.toFixed(3));
// The faces are worked one at a time and the server keeps answering between them.
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/* ── Geometry ── */

/* A face's own axes and size, from its five points (right eye, left eye,
   nose, right and left mouth corner). `down` runs from between the eyes to
   the middle of the mouth, so a tilted head gets a tilted oval. `unit` is the
   eye distance a frontal face of this height would have: the eye-to-mouth
   drop survives a turned head and the eye distance does not, so the larger
   reading is the honest one. */
export function faceAxes(points) {
  const eyes = mid(points[0], points[1]);
  const mouth = mid(points[3], points[4]);
  const eye = dist(points[0], points[1]);
  const drop = dist(eyes, mouth);
  const down = drop > 1e-6 ? [(mouth[0] - eyes[0]) / drop, (mouth[1] - eyes[1]) / drop] : [0, 1];
  return { eyes, mouth, eye, drop, unit: Math.max(eye, drop / 1.1), down, across: [-down[1], down[0]] };
}

/* Which way the head is turned, read off where the nose tip sits between the
   eyes: its offset across the face from the point between them, in units of
   the eye-to-mouth drop, which a turn barely changes. 0 is frontal, about
   ±0.3 a three-quarter view; the sign says which side the nose points to. */
export function faceTurn(points) {
  const a = faceAxes(points);
  const n = points[2];
  return a.drop > 1e-6 ? ((n[0] - a.eyes[0]) * a.across[0] + (n[1] - a.eyes[1]) * a.across[1]) / a.drop : 0;
}

/* The furthest a replacement may reach, in face units from the eye line:
   forehead from 0.85 above it, chin to 1.75 below, and across wider on the
   side the face is turned away from — on a three-quarter face the near cheek
   runs well past the eye and the far one barely past the nose. Within it, the
   face's own outline decides (see faceMask); this only stops a skin-coloured
   neck, ear or hand from counting as face. A superellipse, so its corners
   reach the jaw and temples that an ellipse would cut off. */
export function faceOval(points) {
  const a = faceAxes(points);
  const v = Math.max(a.drop / 1.1, 0.7 * a.eye);   // vertical unit
  const h = Math.max(a.eye, 0.55 * v);             // across: the width as turned
  const turn = clamp(faceTurn(points), -0.5, 0.5);
  const shift = -turn * 0.8 * h;                   // away from the nose
  return {
    c: [
      a.eyes[0] + a.down[0] * 0.45 * v + a.across[0] * shift,
      a.eyes[1] + a.down[1] * 0.45 * v + a.across[1] * shift,
    ],
    down: a.down,
    across: a.across,
    A: 1.3 * v,
    B: (1.2 + 0.4 * Math.abs(turn)) * h,
    unit: a.unit,
  };
}

/* The features, as a convex polygon: both eyes with their outer corners and
   brows, the nose tip, the mouth and the top of the chin. Everything inside
   is the person and comes from the original outright, whatever colour it is.
   The eye on the side the nose points to is barely widened, because on a
   three-quarter face its outer corner IS the face's edge, and past it is
   whatever stood behind the person. */
export function featureHull(points) {
  const a = faceAxes(points);
  const v = Math.max(a.drop / 1.1, 0.7 * a.eye);
  const [e0, e1, nose, m0, m1] = points;
  const n = (nose[0] - a.eyes[0]) * a.across[0] + (nose[1] - a.eyes[1]) * a.across[1];
  const side = (p) => (p[0] - a.eyes[0]) * a.across[0] + (p[1] - a.eyes[1]) * a.across[1];
  const reach = (p) => (Math.sign(side(p)) === Math.sign(n) ? Math.max(0.05, 0.3 - 0.6 * Math.abs(n) / Math.max(a.eye, 1e-6)) : 0.3);
  const out = (p, q, k) => [p[0] + k * (p[0] - q[0]), p[1] + k * (p[1] - q[1])];
  const up = (p, k) => [p[0] - a.down[0] * k * v, p[1] - a.down[1] * k * v];
  const c0 = out(e0, e1, reach(e0)), c1 = out(e1, e0, reach(e1));
  const chin = [a.mouth[0] + a.down[0] * 0.42 * v, a.mouth[1] + a.down[1] * 0.42 * v];
  return convexHull([
    e0, e1, c0, c1, up(e0, 0.42), up(e1, 0.42), up(c0, 0.38), up(c1, 0.38),
    nose, out(m0, m1, 0.12), out(m1, m0, 0.12), chin,
  ]);
}

// Andrew's monotone chain. Inside points have a non-negative cross product with every edge.
function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Distance to the polygon's edge: negative inside, positive outside.
export function hullDistance(hull, x, y) {
  let inside = hull.length >= 3, best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
    const ex = bx - ax, ey = by - ay;
    if (ex * (y - ay) - ey * (x - ax) < 0) inside = false;
    const t = clamp(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1), 0, 1);
    const d = Math.hypot(x - (ax + t * ex), y - (ay + t * ey));
    if (d < best) best = d;
  }
  return inside ? -best : best;
}

// 0 at the oval's centre, 1 on its edge.
export function ovalRadius(o, x, y) {
  const dx = x - o.c[0], dy = y - o.c[1];
  const along = Math.abs(dx * o.down[0] + dy * o.down[1]) / o.A;
  const side = Math.abs(dx * o.across[0] + dy * o.across[1]) / o.B;
  return Math.cbrt(along * along * along + side * side * side);
}

/* Least-squares similarity, no reflection: dst ≈ [a −b; b a]·src + t.
   Closed form (Umeyama without the SVD a reflection would need). */
export function fitSimilarity(src, dst) {
  const n = Math.min(src.length, dst.length);
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) { msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1]; }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let dot = 0, cross = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - msx, ys = src[i][1] - msy;
    const xd = dst[i][0] - mdx, yd = dst[i][1] - mdy;
    dot += xs * xd + ys * yd;
    cross += xs * yd - ys * xd;
    ss += xs * xs + ys * ys;
  }
  if (!(ss > 1e-9)) return null;
  const a = dot / ss, b = cross / ss;
  return { a, b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy), scale: Math.hypot(a, b) };
}

export const applySimilarity = (T, p) => [T.a * p[0] - T.b * p[1] + T.tx, T.b * p[0] + T.a * p[1] + T.ty];

function invertSimilarity(T) {
  const k = T.a * T.a + T.b * T.b;
  const a = T.a / k, b = -T.b / k;
  return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty), scale: 1 / T.scale };
}

// Root-mean-square distance, in pixels, between T(src) and dst.
export function landmarkMisfit(T, src, dst) {
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    const p = applySimilarity(T, src[i]);
    s += (p[0] - dst[i][0]) ** 2 + (p[1] - dst[i][1]) ** 2;
  }
  return Math.sqrt(s / src.length);
}

/* Which face in the redraw is which face in the original. Returns
   [[originalIndex, redrawIndex], ...].

   Each candidate pair proposes the transform that would carry one onto the
   other; the proposal is scored by how many of the OTHER faces it also lands
   on, at the right size. Two people side by side pair left with left even if
   the model moved them a little, and a hypothesis that swaps them puts the
   second face off the frame and explains nothing.

   Only a group of two or more is trusted on position alone (or the one face
   in each picture). A group of one is any face standing anywhere — every
   candidate explains itself — so the faces it leaves are paired by
   pairLeftovers instead, on whether they actually line up. */
export function pairFaces(originalFaces, redrawFaces) {
  const geo = (f) => faceAxes(f.points);
  const gs = originalFaces.map(geo), gr = redrawFaces.map(geo);
  let best = { pairs: [], cost: Infinity };
  for (let s0 = 0; s0 < originalFaces.length; s0++) {
    for (let r0 = 0; r0 < redrawFaces.length; r0++) {
      const T = fitSimilarity(originalFaces[s0].points, redrawFaces[r0].points);
      if (!T) continue;
      const cand = [];
      for (let i = 0; i < gs.length; i++) {
        const at = applySimilarity(T, gs[i].eyes);
        const size = gs[i].unit * T.scale;
        for (let j = 0; j < gr.length; j++) {
          const off = dist(at, gr[j].eyes) / Math.max(size, 1);
          const ratio = gr[j].unit / Math.max(size, 1e-6);
          if (off < 0.8 && ratio > 0.6 && ratio < 1.6) cand.push({ i, j, off });
        }
      }
      cand.sort((p, q) => p.off - q.off);
      const usedS = new Set(), usedR = new Set(), pairs = [];
      let cost = 0;
      for (const c of cand) {
        if (usedS.has(c.i) || usedR.has(c.j)) continue;
        usedS.add(c.i);
        usedR.add(c.j);
        pairs.push([c.i, c.j]);
        cost += c.off;
      }
      if (pairs.length > best.pairs.length || (pairs.length === best.pairs.length && cost < best.cost)) {
        best = { pairs, cost };
      }
    }
  }
  const alone = originalFaces.length === 1 && redrawFaces.length === 1;
  return best.pairs.length >= 2 || alone ? best.pairs.sort((p, q) => p[0] - q[0]) : [];
}

/* The faces pairFaces left, paired one by one.

   A reframe does not always keep one viewpoint. Handed a collage of two
   photographs, the model drew one scene and put each person where it liked,
   at a size of its own; no single transform explains that, and the boy from
   the second photograph — the largest, best-lit face in the picture — went
   unpaired. Position cannot say who is who here, and a cheap likeness score
   could not either: the redraw changed the faces too much, which is the whole
   complaint. What can is lining them up. `lineUpScore(i, j)` runs the same
   alignment the replacement uses and reports how well the two heads agree —
   0.85 and up for the same person redrawn, under 0.5 for anyone else — and
   pairs are taken best first above `min`. Sizes more than `maxScale` apart
   are not tried at all. */
export async function pairLeftovers(originalFaces, redrawFaces, taken, lineUpScore, { min = 0.6, maxScale = 4 } = {}) {
  const usedS = new Set(taken.map(([i]) => i)), usedR = new Set(taken.map(([, j]) => j));
  const cand = [];
  for (let i = 0; i < originalFaces.length; i++) {
    if (usedS.has(i)) continue;
    for (let j = 0; j < redrawFaces.length; j++) {
      if (usedR.has(j)) continue;
      const T = fitSimilarity(originalFaces[i].points, redrawFaces[j].points);
      if (!T || T.scale < 1 / maxScale || T.scale > maxScale) continue;
      const score = await lineUpScore(i, j);
      if (score >= min) cand.push({ i, j, score });
    }
  }
  cand.sort((p, q) => q.score - p.score);
  const pairs = [];
  for (const c of cand) {
    if (usedS.has(c.i) || usedR.has(c.j)) continue;
    usedS.add(c.i);
    usedR.add(c.j);
    pairs.push([c.i, c.j]);
  }
  return pairs;
}

/* ── Single-channel arithmetic on Float32Arrays, region-sized ── */

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

// One pass along rows (step 1) or columns (step w), edges replicated.
function convolveLine(src, dst, w, h, k, r, horizontal) {
  const n = horizontal ? w : h, lines = horizontal ? h : w, step = horizontal ? 1 : w;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) acc += k[t + r] * src[base + clamp(i + t, 0, n - 1) * step];
      dst[base + i * step] = acc;
    }
  }
}

// A running-sum box, edges replicated. Three of them make a Gaussian.
function boxLine(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h, lines = horizontal ? h : w, step = horizontal ? 1 : w;
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    let acc = 0;
    for (let t = -r; t <= r; t++) acc += src[base + clamp(t, 0, n - 1) * step];
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = acc * norm;
      acc += src[base + clamp(i + r + 1, 0, n - 1) * step] - src[base + clamp(i - r, 0, n - 1) * step];
    }
  }
}

/* Gaussian blur. Exact up to sigma 3; past that, three box passes each way,
   which cost the same at any sigma — the membrane's runs to a third of a
   face, and an exact kernel that wide is a few hundred taps a pixel. */
export function blurF32(src, w, h, sigma) {
  if (!(sigma > 0.25)) return Float32Array.from(src);
  const a = new Float32Array(src.length), b = new Float32Array(src.length);
  if (sigma <= 3) {
    const { k, r } = gaussKernel(sigma);
    convolveLine(src, a, w, h, k, r, true);
    convolveLine(a, b, w, h, k, r, false);
    return b;
  }
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  boxLine(src, a, w, h, r, true); boxLine(a, b, w, h, r, true); boxLine(b, a, w, h, r, true);
  boxLine(a, b, w, h, r, false); boxLine(b, a, w, h, r, false); boxLine(a, b, w, h, r, false);
  return b;
}

function lumaF32(rgb) {
  const y = new Float32Array(rgb.length / 3);
  for (let i = 0, j = 0; i < y.length; i++, j += 3) y[i] = 0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2];
  return y;
}

// Shapes between `fine` and `coarse`: no grain, no tone. What "the same face" compares.
function band(y, w, h, fine, coarse) {
  const a = blurF32(y, w, h, fine), b = blurF32(y, w, h, coarse);
  for (let i = 0; i < a.length; i++) a[i] -= b[i];
  return a;
}

function weightedNcc(a, b, wt) {
  let sw = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { sw += wt[i]; ma += wt[i] * a[i]; mb += wt[i] * b[i]; }
  if (!(sw > 0)) return 0;
  ma /= sw; mb /= sw;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const u = a[i] - ma, v = b[i] - mb;
    sab += wt[i] * u * v; saa += wt[i] * u * u; sbb += wt[i] * v * v;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

function weightedMedian(values, wt) {
  const idx = [];
  let total = 0;
  for (let i = 0; i < values.length; i++) if (wt[i] > 0.02) { idx.push(i); total += wt[i]; }
  if (!idx.length) return 0;
  idx.sort((p, q) => values[p] - values[q]);
  let acc = 0;
  for (const i of idx) { acc += wt[i]; if (acc >= total / 2) return values[i]; }
  return values[idx[idx.length - 1]];
}

/* ── Skin ──
   Whether a pixel is this face's skin, judged against the face itself: the
   median colour of patches every face has — under each eye, the bridge of the
   nose, the chin, the forehead — in YCbCr, where skin of any tone clusters
   tightly in Cb/Cr and light mostly moves Y. Each picture is judged against
   its own face, so a redraw that warmed the skin is still skin to itself.
   Darker than the median is allowed further than brighter: a cheek in shadow
   is face, a lit wall behind it is not. */
function yccOf(r, g, b) {
  return [
    0.299 * r + 0.587 * g + 0.114 * b,
    128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  ];
}

function skinModel(rgb, valid, box, points) {
  const a = faceAxes(points);
  const v = Math.max(a.drop / 1.1, 0.7 * a.eye);
  const at = (p, k) => [p[0] + a.down[0] * k * v, p[1] + a.down[1] * k * v];
  const spots = [at(points[0], 0.45), at(points[1], 0.45), at(a.eyes, 0.18), at(a.mouth, 0.38), at(a.eyes, -0.6)];
  const rad = Math.max(1.5, 0.12 * a.unit);
  const Y = [], Cb = [], Cr = [];
  for (const [sx, sy] of spots) {
    const y0 = Math.max(0, Math.floor(sy - rad) - box.y), y1 = Math.min(box.h - 1, Math.ceil(sy + rad) - box.y);
    const x0 = Math.max(0, Math.floor(sx - rad) - box.x), x1 = Math.min(box.w - 1, Math.ceil(sx + rad) - box.x);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * box.w + x;
        if (Math.hypot(box.x + x - sx, box.y + y - sy) > rad || (valid && valid[i] < 0.99)) continue;
        const [yy, cb, cr] = yccOf(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        Y.push(yy); Cb.push(cb); Cr.push(cr);
      }
    }
  }
  if (Y.length < 8) return null;
  const med = (arr) => Float32Array.from(arr).sort()[arr.length >> 1];
  const y0 = med(Y), cb0 = med(Cb), cr0 = med(Cr);
  const madY = med(Y.map((t) => Math.abs(t - y0)));
  const madC = med(Cb.map((t, k) => Math.hypot(t - cb0, Cr[k] - cr0)));
  return { y: y0, cb: cb0, cr: cr0, sc: Math.max(6, 3 * madC), dark: Math.max(60, 3 * madY), bright: Math.max(40, 3 * madY) };
}

// Blurs Cb and Cr in place, keeping each pixel's Y.
function smoothChroma(rgb, w, h, sigma) {
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) [Y[i], Cb[i], Cr[i]] = yccOf(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const cb = blurF32(Cb, w, h, sigma), cr = blurF32(Cr, w, h, sigma);
  for (let i = 0; i < n; i++) {
    const u = cb[i] - 128, v = cr[i] - 128;
    rgb[i * 3] = Y[i] + 1.402 * v;
    rgb[i * 3 + 1] = Y[i] - 0.344136 * u - 0.714136 * v;
    rgb[i * 3 + 2] = Y[i] + 1.772 * u;
  }
}

function skinLikelihood(m, r, g, b) {
  const [y, cb, cr] = yccOf(r, g, b);
  const dc = Math.hypot(cb - m.cb, cr - m.cr) / m.sc;
  const dy = (y - m.y) / (y < m.y ? m.dark : m.bright);
  return Math.exp(-0.5 * (dc * dc + dy * dy));
}

/* ── Resampling ── */

async function shrinkRgb(sharp, rgb, f) {
  const w = Math.max(1, Math.round(rgb.width * f)), h = Math.max(1, Math.round(rgb.height * f));
  const data = await sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
    .resize(w, h, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();
  return { data, width: w, height: h };
}

/* The original carried into the redraw's frame over `box`. `inv` maps a
   redraw pixel to an original pixel and `post` from there to `img`, which is
   the original or a shrunk copy of it. Catmull-Rom, the crispest a resample
   gets without inventing anything. `valid` fades out over `fade` image pixels
   where the face runs off the original's edge, so the redraw is kept there
   rather than a smear of the last row. */
function warpRegion(img, inv, post, box, fade) {
  const { data, width: W, height: H } = img;
  const n = box.w * box.h;
  const out = new Float32Array(n * 3);
  const valid = new Float32Array(n);
  const wx = new Float64Array(4), wy = new Float64Array(4);
  const weights = (t, w) => {
    const t2 = t * t, t3 = t2 * t;
    w[0] = -0.5 * t3 + t2 - 0.5 * t;
    w[1] = 1.5 * t3 - 2.5 * t2 + 1;
    w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    w[3] = 0.5 * t3 - 0.5 * t2;
  };
  for (let y = 0; y < box.h; y++) {
    const qy = box.y + y;
    for (let x = 0; x < box.w; x++) {
      const qx = box.x + x;
      const px = post.kx * (inv.a * qx - inv.b * qy + inv.tx) + post.ox;
      const py = post.ky * (inv.b * qx + inv.a * qy + inv.ty) + post.oy;
      const edge = Math.min(px, W - 1 - px, py, H - 1 - py);
      if (edge < 0) continue;
      const i = y * box.w + x;
      valid[i] = clamp(edge / fade, 0, 1);
      const x0 = Math.floor(px), y0 = Math.floor(py);
      weights(px - x0, wx);
      weights(py - y0, wy);
      let r = 0, g = 0, b = 0;
      for (let m = 0; m < 4; m++) {
        const row = clamp(y0 - 1 + m, 0, H - 1) * W;
        for (let k = 0; k < 4; k++) {
          const wgt = wy[m] * wx[k];
          const j = (row + clamp(x0 - 1 + k, 0, W - 1)) * 3;
          r += wgt * data[j]; g += wgt * data[j + 1]; b += wgt * data[j + 2];
        }
      }
      out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
    }
  }
  return { rgb: out, valid };
}

/* ── Lining up ── */

// D after T: p ↦ D(T(p)).
function composeSimilarity(D, T) {
  return {
    a: D.a * T.a - D.b * T.b,
    b: D.a * T.b + D.b * T.a,
    tx: D.a * T.tx - D.b * T.ty + D.tx,
    ty: D.b * T.tx + D.a * T.ty + D.ty,
    scale: D.scale * T.scale,
  };
}

/* Five landmarks put a frontal face within a pixel or two, and a turned one
   up to a third of an eye's width off: YuNet's nose point on a three-quarter
   face stops short of the real tip. An original face laid in on that shows
   two noses and two outlines — the ghost. So the fit is finished on the
   pictures themselves: the original face nudged — shifted, scaled, turned a
   few degrees about its own centre — to where its shapes best agree with
   the redraw's, by normalised cross-correlation of band-passed luminance
   over the face, as hdDetailTransfer registers a whole photograph.

   They are different faces, which is the whole problem, but their eyes,
   nose, mouth, outline and hairline sit in one place, and that place is
   where the original belongs on the redraw's head. Only ever a nudge: a
   third of a face unit, a tenth in scale, eight degrees. Kept only when it
   agrees clearly better than the landmarks did. */
async function refineAlignment(yW, valid, yR, box, oval, scale) {
  const unit = oval.unit;
  const fine = Math.max(1, 0.7 * scale), coarse = Math.max(3 * fine, 0.25 * unit);
  const bW = band(yW, box.w, box.h, fine, coarse);
  const bR = band(yR, box.w, box.h, fine, coarse);
  const cx = oval.c[0] - box.x, cy = oval.c[1] - box.y;
  const stride = Math.max(1, Math.round(Math.sqrt((box.w * box.h) / 3000)));
  /* Two regions. The search reaches past the face's own edge, to the jaw,
     the hairline and the cheek's outline: the head is what the original has
     to sit on, and inside the face the two pictures differ by design —
     searched there alone, it slid the original's eyes onto the model's. But
     the verdict on the pose found is the face's alone: past the head is
     whatever the model put behind it, and a TV screen it redrew dragged a
     face it had kept almost exactly down to 0.49. */
  const sample = (reach) => {
    const out = [];
    for (let y = 0; y < box.h; y += stride) {
      for (let x = 0; x < box.w; x += stride) {
        const r = ovalRadius(oval, box.x + x, box.y + y);
        if (r < reach) out.push(x, y, bR[y * box.w + x], 1 - smoothstep(reach - 0.25, reach, r));
      }
    }
    return out;
  };
  const searchPts = sample(ALIGN_REACH), facePts = sample(1);
  // NCC with the original moved by D: D(p) = c + s·R(th)(p − c) + d, read back through its inverse.
  const score = (s, th, dx, dy, pts = searchPts) => {
    const co = Math.cos(th) / s, si = Math.sin(th) / s;
    let total = 0, sw = 0, su = 0, sv = 0, suu = 0, svv = 0, suv = 0;
    for (let k = 0; k < pts.length; k += 4) {
      const w = pts[k + 3];
      total += w;
      const qx = pts[k] - cx - dx, qy = pts[k + 1] - cy - dy;
      const px = cx + co * qx + si * qy, py = cy - si * qx + co * qy;
      if (px < 0 || py < 0 || px > box.w - 1 || py > box.h - 1) continue;
      const x0 = px | 0, y0 = py | 0;
      const x1 = Math.min(x0 + 1, box.w - 1), y1 = Math.min(y0 + 1, box.h - 1);
      const i00 = y0 * box.w + x0, i01 = y0 * box.w + x1, i10 = y1 * box.w + x0, i11 = y1 * box.w + x1;
      if (valid[i00] < 0.5 || valid[i11] < 0.5) continue;
      const fx = px - x0, fy = py - y0;
      const u = (bW[i00] * (1 - fx) + bW[i01] * fx) * (1 - fy) + (bW[i10] * (1 - fx) + bW[i11] * fx) * fy;
      const v = pts[k + 2];
      sw += w; su += w * u; sv += w * v; suu += w * u * u; svv += w * v * v; suv += w * u * v;
    }
    if (sw < 0.7 * total) return -1;
    const mu = su / sw, mv = sv / sw;
    const vu = suu / sw - mu * mu, vv = svv / sw - mv * mv;
    return vu > 0 && vv > 0 ? (suv / sw - mu * mv) / Math.sqrt(vu * vv) : -1;
  };

  const base = score(1, 0, 0, 0);
  let best = { s: 1, th: 0, dx: 0, dy: 0, ncc: base };
  const step = 0.05 * unit, deg = Math.PI / 180;
  for (const th of [-8, -4, 0, 4, 8]) {
    for (const s of [0.9, 0.95, 1, 1.05, 1.1]) {
      for (let iy = -6; iy <= 6; iy++) {
        for (let ix = -6; ix <= 6; ix++) {
          const v = score(s, th * deg, ix * step, iy * step);
          if (v > best.ncc) best = { s, th: th * deg, dx: ix * step, dy: iy * step, ncc: v };
        }
      }
    }
    await breathe();
  }
  const c0 = best;
  for (const dth of [-2, -1, 0, 1, 2]) {
    for (const ds of [-0.025, -0.0125, 0, 0.0125, 0.025]) {
      for (let iy = -4; iy <= 4; iy++) {
        for (let ix = -4; ix <= 4; ix++) {
          const s = c0.s + ds, th = c0.th + dth * deg, dx = c0.dx + (ix * step) / 4, dy = c0.dy + (iy * step) / 4;
          const v = score(s, th, dx, dy);
          if (v > best.ncc) best = { s, th, dx, dy, ncc: v };
        }
      }
    }
  }
  await breathe();

  /* A nudge has to buy something. Correcting a landmark error lifts the
     agreement by 0.09–0.55 on real redraws; a gain under 0.06 is the search
     sliding the original's features onto the model's, which differ on
     purpose — on a face whose landmarks were exact it moved the eyes 4px
     towards a redraw that had moved them 6px. */
  const moved = best.ncc > base + 0.06;
  const pose = moved ? best : { s: 1, th: 0, dx: 0, dy: 0 };
  const a = pose.s * Math.cos(pose.th), b = pose.s * Math.sin(pose.th);
  const [Cx, Cy] = oval.c;
  return {
    D: { a, b, tx: Cx + pose.dx - (a * Cx - b * Cy), ty: Cy + pose.dy - (b * Cx + a * Cy), scale: pose.s },
    moved,
    // The face's own agreement, before and at the pose kept.
    before: score(1, 0, 0, 0, facePts),
    after: score(pose.s, pose.th, pose.dx, pose.dy, facePts),
    shift: Math.hypot(pose.dx, pose.dy) / unit,
  };
}

/* ── One face ── */

/* The original face (`sPoints` in `source`) carried into the redraw's frame
   through T and lined up with the redraw's head: the region it occupies, the
   original's pixels warped into it, the redraw's pixels under it, and how
   well the two agree. Shared by pairing, which only wants the agreement, and
   by transplant, which goes on to lay the face in. Null when the face falls
   off the redraw. */
async function lineUp(sharp, source, shrunk, result, T, sPoints) {
  const first = faceOval(sPoints.map((p) => applySimilarity(T, p)));
  // Room for refineAlignment to move the face by up to a third of a unit.
  const margin = 0.35 * first.unit;
  const hx = Math.abs(first.A * first.down[0]) + Math.abs(first.B * first.across[0]) + margin;
  const hy = Math.abs(first.A * first.down[1]) + Math.abs(first.B * first.across[1]) + margin;
  const x0 = clamp(Math.floor(first.c[0] - hx) - 2, 0, result.width);
  const x1 = clamp(Math.ceil(first.c[0] + hx) + 2, 0, result.width);
  const y0 = clamp(Math.floor(first.c[1] - hy) - 2, 0, result.height);
  const y1 = clamp(Math.ceil(first.c[1] + hy) + 2, 0, result.height);
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (box.w < 8 || box.h < 8) return null;

  /* A face the redraw made smaller is sampled from the original shrunk with
     lanczos first. Bicubic straight off the full-size original would alias:
     every second eyelash, every other strand of hair. */
  let img = source, post = { kx: 1, ky: 1, ox: 0, oy: 0 };
  if (T.scale < 0.85) {
    const f = Math.round(T.scale * 20) / 20;
    if (!shrunk.has(f)) shrunk.set(f, await shrinkRgb(sharp, source, f));
    img = shrunk.get(f);
    const kx = img.width / source.width, ky = img.height / source.height;
    post = { kx, ky, ox: 0.5 * kx - 0.5, oy: 0.5 * ky - 0.5 };
  }
  const perImagePx = T.scale / post.kx;   // redraw pixels per sampled pixel
  const warpWith = (TT) => warpRegion(img, invertSimilarity(TT), post, box, Math.max(1, 3 / perImagePx));
  let { rgb: warped, valid } = warpWith(T);

  const n = box.w * box.h;
  const res = new Float32Array(n * 3);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const j = ((box.y + y) * result.width + box.x + x) * 3, i = (y * box.w + x) * 3;
      res[i] = result.data[j]; res[i + 1] = result.data[j + 1]; res[i + 2] = result.data[j + 2];
    }
  }

  const fit = await refineAlignment(lumaF32(warped), valid, lumaF32(res), box, first, T.scale);
  if (fit.moved) {
    T = composeSimilarity(fit.D, T);
    ({ rgb: warped, valid } = warpWith(T));
  }
  return {
    T, box, n, warped, valid, res,
    aligned: { moved: fit.moved, shift: round3(fit.shift), before: round3(fit.before), after: round3(fit.after) },
  };
}

/* Lays the original face (`sPoints` in `source`) into `outRgb`, the redraw's
   pixels, through T. `rPoints` are the same face's landmarks in the redraw;
   `lined` is lineUp's answer for this pair when pairing already ran it.
   Returns what it did, for the stats. */
async function transplant(sharp, source, shrunk, result, outRgb, T, sPoints, rPoints, { lined = null } = {}) {
  const L = lined || await lineUp(sharp, source, shrunk, result, T, sPoints);
  if (!L) return { action: "skipped", reason: "off the edge of the picture" };
  const { box, n, warped, valid, res, aligned } = L;
  T = L.T;
  const yR = lumaF32(res);
  /* Lined up as well as it can be and still not agreeing: the model drew a
     differently shaped face, or the same one at another angle. A paste would
     put one face's outline across the other's — left as drawn, and named. */
  if (aligned.after < MIN_ALIGNED) return { action: "skipped", reason: "the redraw's face could not be lined up with the original", aligned };

  /* An original face enlarged past its own resolution carries its JPEG's
     colour blocks with it, magnified into blotches. Colour is smoothed at
     the size of an original pixel, brightness left alone: the eye reads
     sharpness from brightness, and these blocks are all in the colour. */
  if (T.scale > 1.25) smoothChroma(warped, box.w, box.h, 0.6 * T.scale);
  const mapped = sPoints.map((p) => applySimilarity(T, p));
  const oval = faceOval(mapped);
  const hull = featureHull(mapped);
  const unit = oval.unit;

  /* What is replaced. The features outright (featureHull), and around them
     whatever is face in BOTH pictures — skin in the original and skin in the
     redraw — inside the outer limit. Not an oval: an oval on a turned head
     reaches past the nose into the wall behind it, and pasted that wall in as
     a white streak down the cheek. Where only one picture has skin — a
     hairline the model moved, a jaw it widened — the redraw is kept, so the
     head keeps one outline rather than two.

     Skin colour alone is not enough: a pale, washed-out original has a face
     the colour of the wall behind it. So a pixel outside the features must
     also AGREE between the two pictures, once their overall difference in
     colour is taken out — skin against skin passes, the wall where the
     redraw has a cheek does not.

     Small holes are closed (grown, then shrunk back), so a mole, a bindi or a
     shadowed dimple goes with the face instead of staying the model's. The
     feather then runs INSIDE that outline, never past it. */
  const skinO = skinModel(warped, valid, box, mapped);
  const skinR = skinModel(res, null, box, rPoints);
  const core = new Float32Array(n), both = new Float32Array(n), limit = new Float32Array(n);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x, X = box.x + x, Y = box.y + y;
      // Feathered INWARD: on a turned face the nose tip is the outline, and a
      // feather past it laid the wall behind the nose in as a white blob.
      core[i] = (1 - smoothstep(-0.12 * unit, 0, hullDistance(hull, X, Y))) * valid[i];
      limit[i] = (1 - smoothstep(0.85, 1, ovalRadius(oval, X, Y))) * valid[i];
      if (limit[i] <= 0 || !skinO || !skinR) continue;
      const pO = skinLikelihood(skinO, warped[i * 3], warped[i * 3 + 1], warped[i * 3 + 2]);
      const pR = skinLikelihood(skinR, res[i * 3], res[i * 3 + 1], res[i * 3 + 2]);
      both[i] = smoothstep(0.15, 0.45, pO) * smoothstep(0.15, 0.45, pR) * limit[i];
    }
  }
  /* Lit like the redraw. The original was taken under its own light — warm
     stage lamps, a flash, a grade — and the redraw has the scene's. Matched
     over the skin both pictures share outside the features, channel by
     channel: the original's mean moved to the redraw's, its contrast eased
     towards the redraw's. A linear map, so every shape and proportion of the
     face is untouched; only the light on it changes. Without it the face read
     as a cut-out, and its skin disagreed with the redraw's so widely that
     only the feature polygon was laid in, straight edges and all. */
  {
    let sw = 0;
    const mo = [0, 0, 0], mr = [0, 0, 0], vo = [0, 0, 0], vr = [0, 0, 0];
    const w = (i) => both[i] * (1 - core[i]);
    for (let i = 0; i < n; i++) {
      const wi = w(i);
      if (!wi) continue;
      sw += wi;
      for (let c = 0; c < 3; c++) { mo[c] += wi * warped[i * 3 + c]; mr[c] += wi * res[i * 3 + c]; }
    }
    if (sw > 40) {
      for (let c = 0; c < 3; c++) { mo[c] /= sw; mr[c] /= sw; }
      for (let i = 0; i < n; i++) {
        const wi = w(i);
        if (!wi) continue;
        for (let c = 0; c < 3; c++) {
          vo[c] += wi * (warped[i * 3 + c] - mo[c]) ** 2;
          vr[c] += wi * (res[i * 3 + c] - mr[c]) ** 2;
        }
      }
      for (let c = 0; c < 3; c++) {
        const k = vo[c] > 1 ? clamp(Math.sqrt(vr[c] / vo[c]), 0.75, 1.25) : 1;
        for (let i = 0; i < n; i++) warped[i * 3 + c] = (warped[i * 3 + c] - mo[c]) * k + mr[c];
      }
    }
  }

  const offset = [0, 1, 2].map((c) => {
    const d = new Float32Array(n), w = new Float32Array(n);
    for (let i = 0; i < n; i++) { d[i] = res[i * 3 + c] - warped[i * 3 + c]; w[i] = both[i] * (1 - core[i]); }
    return weightedMedian(d, w);
  });
  const delta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < 3; c++) { const e = res[i * 3 + c] - warped[i * 3 + c] - offset[c]; s += e * e; }
    delta[i] = Math.sqrt(s / 3);
  }
  const deltaS = blurF32(delta, box.w, box.h, Math.max(0.8, 0.04 * unit));
  const face = new Float32Array(n);
  for (let i = 0; i < n; i++) face[i] = both[i] * (1 - smoothstep(18, 40, deltaS[i]));
  const closeBy = 0.08 * unit;
  const grown = blurF32(face, box.w, box.h, closeBy).map((t) => smoothstep(0.1, 0.3, t));
  const closed = blurF32(grown, box.w, box.h, closeBy);
  const whole = new Float32Array(n);
  for (let i = 0; i < n; i++) whole[i] = Math.max(core[i], smoothstep(0.7, 0.9, closed[i]) * limit[i]);
  const soft = blurF32(whole, box.w, box.h, Math.max(0.8, 0.035 * unit));
  const alpha = new Float32Array(n), ring = new Float32Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    alpha[i] = Math.max(core[i], smoothstep(0.5, 0.95, soft[i]) * whole[i]);
    // The membrane is measured where the two pictures meet: the feather.
    ring[i] = 4 * alpha[i] * (1 - alpha[i]) * valid[i];
    area += alpha[i];
  }
  if (area < 64) return { action: "skipped", reason: "off the edge of the original" };

  /* Does the redraw's face already agree with the original's? Compared as
     shapes at the original's own resolution — finer than that, the redraw
     has detail the original never had, and coarser, only lighting. */
  const yW = lumaF32(warped);
  const fine = Math.max(0.8, 0.7 * T.scale);
  const coarse = Math.max(3 * fine, 0.15 * oval.unit);
  const bW = band(yW, box.w, box.h, fine, coarse);
  const bR = band(yR, box.w, box.h, fine, coarse);
  const match = weightedNcc(bW, bR, alpha);
  if (match >= KEEP_MATCH) return { action: "kept", match: round3(match), aligned };

  /* The membrane. What the redraw's light does along the oval's edge, spread
     smoothly inward and added to the original face, so it arrives in the new
     picture's light without taking the new picture's face. Measured on the
     ring just inside the edge — cheek, forehead, chin — and robustly: where
     the redraw has hair or shadow the original does not, that pixel's say is
     discounted rather than painted across the skin. */
  const dY = new Float32Array(n);
  for (let i = 0; i < n; i++) dY[i] = yR[i] - yW[i];
  const med = weightedMedian(dY, ring);
  const wt = new Float32Array(n);
  let sw = 0;
  for (let i = 0; i < n; i++) {
    const z = (dY[i] - med) / 28;
    wt[i] = ring[i] * Math.exp(-z * z);
    sw += wt[i];
  }
  const sigmaM = 0.45 * oval.unit;
  const den = blurF32(wt, box.w, box.h, sigmaM);
  const EPS = 0.03;
  const corrected = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const num = new Float32Array(n);
    let g = 0;
    for (let i = 0; i < n; i++) {
      const d = res[i * 3 + c] - warped[i * 3 + c];
      num[i] = wt[i] * d;
      g += num[i];
    }
    g = sw > 1 ? g / sw : 0;
    const numB = blurF32(num, box.w, box.h, sigmaM);
    for (let i = 0; i < n; i++) {
      const m = clamp((numB[i] + EPS * g) / (den[i] + EPS), -64, 64);
      corrected[i * 3 + c] = warped[i * 3 + c] + m;
    }
  }

  /* The redraw's shading, the original's face. Matching averages and edges
     leaves the original's own fall of light inside: a boy lit hard from the
     front kept a bright centre and dark edges, and sat on the redraw's evenly
     lit head as a glowing oval. So the face is split by scale: everything
     coarser than a third of a face unit — the light across it — is taken from
     the redraw, everything finer — eyes, brows, lips, the shape of the smile,
     the skin's own texture — stays the original's. Blurred over the face only
     (a masked blur), so the wall behind the head does not leak into either. */
  {
    const sigmaL = Math.max(1, 0.3 * unit);
    const den2 = blurF32(alpha, box.w, box.h, sigmaL);
    for (let c = 0; c < 3; c++) {
      const o = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) { o[i] = alpha[i] * corrected[i * 3 + c]; r[i] = alpha[i] * res[i * 3 + c]; }
      const ob = blurF32(o, box.w, box.h, sigmaL), rb = blurF32(r, box.w, box.h, sigmaL);
      for (let i = 0; i < n; i++) {
        if (den2[i] > 1e-3) corrected[i * 3 + c] += (rb[i] - ob[i]) / den2[i];
      }
    }
  }

  /* No detail is borrowed from the model's face. It used to be — the
     model's finest band, gated by agreement as hdDetailTransfer gates it —
     and on a real redraw it drew the model's lash lines beside the
     original's and a bright rim round the face. With enlargement capped at
     2x a plain resample is the honest answer: a touch soft, and the person. */
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      const a = alpha[i];
      if (a <= 0.002) continue;
      const j = ((box.y + y) * result.width + box.x + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = a * corrected[i * 3 + c] + (1 - a) * res[i * 3 + c];
        outRgb[j + c] = clamp(Math.round(v), 0, 255);
      }
    }
  }
  return { action: "replaced", match: round3(match), aligned };
}

/* ── The whole job ──

   `source` is the picture the model was shown, `result` its answer, both as
   encoded bytes; `detector` is createFaceDetector()'s. Returns { png, stats }:
   `png` is the corrected picture, or null when nothing needed changing — the
   caller keeps the model's bytes as they are, untouched by a re-encode. */
export async function lockFaces(sharp, source, result, { detector } = {}) {
  const t0 = Date.now();
  const original = await decodeRgb(sharp, source);
  const redraw = await decodeRgb(sharp, result);
  const originalFaces = await detector.detect(sharp, original);
  const redrawFaces = await detector.detect(sharp, redraw);

  const stats = {
    original: originalFaces.length,
    redraw: redrawFaces.length,
    paired: 0,
    replaced: 0,
    kept: 0,
    // Paired, but could not be put back: these are the faces to look at.
    skipped: 0,
    // Paired, and too small in the redraw to be worth a seam: nobody's face.
    ignored: 0,
    faces: [],
    ms: 0,
  };
  const outRgb = Buffer.from(redraw.data);
  const shrunk = new Map();

  /* Who is who: the group that one viewpoint explains, then the rest by
     lining each candidate up. A lineUp that passes is kept for the transplant
     rather than run twice; one that fails keeps only its score. */
  const lined = new Map();
  const lineUpPair = async (i, j) => {
    const key = `${i},${j}`;
    if (!lined.has(key)) {
      const T = fitSimilarity(originalFaces[i].points, redrawFaces[j].points);
      const L = T ? await lineUp(sharp, original, shrunk, redraw, T, originalFaces[i].points) : null;
      lined.set(key, L && L.aligned.after >= MIN_ALIGNED ? L : { aligned: L?.aligned ?? { after: -1 } });
    }
    return lined.get(key);
  };
  const grouped = pairFaces(originalFaces, redrawFaces);
  const leftovers = await pairLeftovers(originalFaces, redrawFaces, grouped,
    async (i, j) => (await lineUpPair(i, j)).aligned.after, { min: MIN_ALIGNED });
  const pairs = [...grouped, ...leftovers].sort((p, q) => p[0] - q[0]);

  for (const [si, ri] of pairs) {
    stats.paired++;
    const sp = originalFaces[si].points, rp = redrawFaces[ri].points;
    const T = fitSimilarity(sp, rp);
    const unit = faceAxes(rp).unit;
    const misfit = T ? landmarkMisfit(T, sp, rp) / Math.max(unit, 1) : Infinity;
    /* The misfit alone let a turn through: five points fitted with four
       degrees of freedom absorb much of a head swinging round. Where the nose
       sits between the eyes does not. */
    const turned = Math.abs(faceTurn(sp) - faceTurn(rp));
    const base = {
      x: Math.round(redrawFaces[ri].x),
      y: Math.round(redrawFaces[ri].y),
      scale: T ? round3(T.scale) : null,
      misfit: round3(Math.min(misfit, 99)),
      turn: round3(turned),
    };
    let did;
    if (!T) did = { action: "skipped", reason: "landmarks could not be fitted" };
    else if (unit < MIN_FACE_PX) did = { action: "ignored", reason: "too small to matter" };
    else if (turned > MAX_TURN_CHANGE) did = { action: "skipped", reason: "the redraw turned the head" };
    else if (misfit > POSE_MISFIT) did = { action: "skipped", reason: "the redraw changed the pose or expression" };
    else if (T.scale > MAX_ENLARGE) did = { action: "skipped", reason: "the original face is too small to enlarge this far" };
    else {
      const L = lined.get(`${si},${ri}`);
      did = await transplant(sharp, original, shrunk, redraw, outRgb, T, sp, rp, { lined: L?.box ? L : null });
    }
    stats.faces.push({ ...base, ...did });
    if (did.action === "replaced") stats.replaced++;
    else if (did.action === "kept") stats.kept++;
    else if (did.action === "ignored") stats.ignored++;
    else stats.skipped++;
    await breathe();
  }

  stats.ms = Date.now() - t0;
  if (!stats.replaced) return { png: null, stats };
  const png = await sharp(outRgb, { raw: { width: redraw.width, height: redraw.height, channels: 3 } })
    .png()
    .toBuffer();
  return { png, stats };
}
