/* ── HD Upscale: OpenAI detail on the writer's own pixels ────────────────────

   gpt-image cannot copy a photograph. images/edits draws every pixel of
   its answer again, and high input fidelity narrows the drift without
   closing it — so HD Upscale used to hand back a picture in which every face
   had been redrawn: the same people, near enough, and not the same people.
   The upload was also cropped to a model shape and shrunk to 1024px first,
   so the model invented more of each face than it was shown, and the 2x
   enlarge after it denoised the skin to wax and sharpened the edges to halos.

   The model's output is no longer used as the picture. It is used as a
   source of detail for the picture, which is rebuilt from the original:

     1. Align. The restore is registered to the original — scale and shift,
        to a quarter of a pixel — because the model does not promise to keep
        the frame exactly where it was.
     2. Split at the original's own resolution. Everything the original
        already resolves — every face, feature, shape, colour and tone — is
        taken from the ORIGINAL, enlarged with lanczos. Only the band finer
        than the original could record, the part an upscale has to supply
        anyway, is taken from the model, and only as luminance, so no colour
        comes from the model at all.
     3. Gate. Wherever the model's picture disagrees with the original at the
        original's resolution — a redrawn face, a moved eye, different
        lettering — its detail is switched off there and the original is
        kept. Detail the model drew on top of a different structure would
        otherwise sit beside the real edges as a ghost.

   Shrunk back to its original size the result IS the original, to within
   the resampling — that is the property that keeps faces, and the tests in
   test/hd-upscale.mjs hold it down. What the model adds is sharpness above
   that, and only where it agrees with the photograph.

   Everything here runs on the server's own CPU through sharp. It costs
   nothing and calls nothing; the one paid step is the restore that feeds
   it. `sharp` is passed in rather than imported, because the server loads it
   lazily and a machine without it must still boot. */

// The shapes the route asks gpt-image for. A request at any other aspect comes
// back with the difference invented, so the model is only ever shown one.
export const HD_MODEL_SHAPES = [
  { w: 1536, h: 1024, size: "1536x1024" },
  { w: 1024, h: 1536, size: "1024x1536" },
  { w: 1024, h: 1024, size: "1024x1024" },
];

/* How much of the model to keep where it agrees with the photograph, and
   where agreement ends. Levels are 0–255 luminance after the band-pass; a
   denoise or a cleaned JPEG block moves a few levels, a redrawn eyelid tens. */
const GATE_LOW = 5;          // below this the model's structure matches: full detail
const GATE_HIGH = 14;        // above this it does not: no detail, the original stands
const GATE_RELATIVE = 0.15;  // tolerance grows with the local contrast of the original
const MIN_ALIGNMENT = 0.55;  // structure NCC below this: the model did not return this photograph

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/* The smallest enlargement worth making. A photo within a quarter of the HD
   size is already HD: stretching it 1.1x adds no detail anyone can see, and a
   JPEG re-encode on top of that is a small loss for nothing. */
export const HD_MIN_ENLARGE = 1.25;

/* The output size: 2x, never past the long-edge cap, and only when it is a
   real enlargement. Something already past the cap is brought down to it. */
export function hdFinalSize(width, height, longEdge = 3072) {
  const headroom = longEdge / Math.max(width, height);
  const f = headroom >= HD_MIN_ENLARGE ? Math.min(2, headroom) : headroom < 1 ? headroom : 1;
  return f === 1 ? { width, height } : { width: even(width * f), height: even(height * f) };
}

/* What a press on this photograph will do, from its pixel size alone.

   `ai` is true only where the model can add real resolution: its answer has
   to be at least `minGain` times the pixels it was shown. A 1400px photo
   would come back from a 1536px model 1.1x larger — a paid redraw for a
   tenth more pixels — so above that line HD Upscale enlarges for free.

   `crop` is the part of the photograph the model is shown: the largest
   centred rectangle of the shape it can return. It is NOT the result. The
   result is always the whole photograph; outside the crop it is simply the
   original enlarged, with the model's detail faded out towards that edge. */
export function planHdUpscale(width, height, { longEdge = 3072, minGain = 1.3 } = {}) {
  const w = Math.round(width), h = Math.round(height);
  if (!(w > 0 && h > 0)) return null;
  if (longEdge / Math.max(w, h) < HD_MIN_ENLARGE) return { skip: true, width: w, height: h };

  // Nearest shape in LOG space, as public/app.js nearestModelShape does: a
  // photograph and the same photograph rotated must resolve alike.
  const aspect = w / h;
  const shape = HD_MODEL_SHAPES.reduce((best, s) =>
    Math.abs(Math.log(s.w / s.h / aspect)) < Math.abs(Math.log(best.w / best.h / aspect)) ? s : best);

  const sa = shape.w / shape.h;
  let cw = w, ch = h;
  if (aspect > sa) cw = Math.min(w, Math.round(h * sa));
  else if (aspect < sa) ch = Math.min(h, Math.round(w / sa));
  const crop = { left: Math.floor((w - cw) / 2), top: Math.floor((h - ch) / 2), width: cw, height: ch };

  /* And only where the model sees most of the photo. Its gain is measured on
     the crop but applied to the whole frame, so a 4:1 banner would be paid
     for to sharpen a quarter of itself and enlarged past the cap. Half the
     photo or more keeps the frame within 3:1 and the work size within 3072. */
  const gain = shape.w / cw;
  const ai = gain >= minGain && (cw * ch) / (w * h) >= 0.5;
  const work = ai ? { width: Math.round(w * gain), height: Math.round(h * gain) } : { width: w, height: h };
  return {
    skip: false,
    ai,
    width: w,
    height: h,
    shape,
    size: shape.size,
    crop,
    gain: Number(gain.toFixed(3)),
    work,
    target: hdFinalSize(work.width, work.height, longEdge),
  };
}

/* Decoded to 8-bit sRGB, three channels, orientation applied. Whatever came
   in — a canvas PNG, a JPEG, a greyscale scan — the arithmetic below sees
   the same layout. */
export async function decodeRgb(sharp, buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels === 3) return { data, width: info.width, height: info.height };
  // Greyscale survives toColourspace as one band on some inputs; widen it.
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0, j = 0; i < info.width * info.height; i++, j += info.channels) {
    out[i * 3] = data[j];
    out[i * 3 + 1] = info.channels >= 3 ? data[j + 1] : data[j];
    out[i * 3 + 2] = info.channels >= 3 ? data[j + 2] : data[j];
  }
  return { data: out, width: info.width, height: info.height };
}

// The model is shown this. PNG, so the crop itself adds no loss.
export async function cropForModel(sharp, rgb, crop) {
  return sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
    .extract(crop)
    .png()
    .toBuffer();
}

/* ── Single-channel helpers. Float32 in, Float32 out; sharp does the
   filtering natively and the arithmetic stays in floats between steps. ── */

function lumaOf(rgb, w, h) {
  const y = new Float32Array(w * h);
  for (let i = 0, j = 0; i < y.length; i++, j += 3) {
    y[i] = 0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2];
  }
  return y;
}

function toBytes(f32, offset = 0) {
  const b = Buffer.alloc(f32.length);
  for (let i = 0; i < f32.length; i++) b[i] = clamp(Math.round(f32[i] + offset), 0, 255);
  return b;
}

/* extractChannel is not optional: handed one-band raw input, sharp answers
   with three (it converts to sRGB on the way out), and a three-times-long
   array read as one band is a picture of noise that still has the right
   type. */
async function fromSharp(pipeline, offset = 0) {
  const { data } = await pipeline.extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const f = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) f[i] = data[i] - offset;
  return f;
}

function gray(sharp, f32, w, h, offset = 0) {
  return sharp(toBytes(f32, offset), { raw: { width: w, height: h, channels: 1 } });
}

async function blur1(sharp, f32, w, h, sigma, offset = 0) {
  return fromSharp(gray(sharp, f32, w, h, offset).blur(Math.max(0.3, sigma)), offset);
}

async function resize1(sharp, f32, w, h, w2, h2) {
  return fromSharp(gray(sharp, f32, w, h).resize(w2, h2, { kernel: "lanczos3", fit: "fill" }));
}

// Zero-mean band-pass: the picture's structure without its tone, so a model
// that brightened or warmed the photograph still registers against it.
async function bandPass(sharp, y, w, h, sigma) {
  const low = await blur1(sharp, y, w, h, sigma);
  const bp = new Float32Array(y.length);
  let mean = 0;
  for (let i = 0; i < y.length; i++) { bp[i] = y[i] - low[i]; mean += bp[i]; }
  mean /= y.length;
  for (let i = 0; i < y.length; i++) bp[i] -= mean;
  return bp;
}

/* The picture's shapes at a scale between grain and tone: blurred at `fine`
   (which takes out sensor grain and JPEG noise) minus blurred at `coarse`
   (which takes out tone), zero-mean. What a verdict on "the same picture"
   should compare — on a dark, grainy photo the finest band is mostly grain,
   and a faithful restore that cleaned it scored as a different picture. */
async function shapes(sharp, y, w, h, fine, coarse) {
  const a = await blur1(sharp, y, w, h, fine);
  const b = await blur1(sharp, y, w, h, coarse);
  const out = new Float32Array(y.length);
  let mean = 0;
  for (let i = 0; i < y.length; i++) { out[i] = a[i] - b[i]; mean += out[i]; }
  mean /= y.length;
  for (let i = 0; i < y.length; i++) out[i] -= mean;
  return out;
}

/* Normalised cross-correlation of `a` against `b` sampled through a scale
   about the centre and a shift, both images the same size. Bilinear, and
   only over the overlap. */
function nccAt(a, b, w, h, s, dx, dy, stride) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  let sab = 0, saa = 0, sbb = 0, n = 0, total = 0;
  for (let y = 0; y < h; y += stride) {
    const yr = cy + s * (y - cy) + dy;
    for (let x = 0; x < w; x += stride) {
      total++;
      const xr = cx + s * (x - cx) + dx;
      if (yr < 0 || yr > h - 1 || xr < 0 || xr > w - 1) continue;
      const x0 = xr | 0, y0 = yr | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
      const fx = xr - x0, fy = yr - y0;
      const r0 = y0 * w, r1 = y1 * w;
      const v = (b[r0 + x0] * (1 - fx) + b[r0 + x1] * fx) * (1 - fy)
              + (b[r1 + x0] * (1 - fx) + b[r1 + x1] * fx) * fy;
      const u = a[y * w + x];
      sab += u * v; saa += u * u; sbb += v * v; n++;
    }
  }
  if (n < total * 0.6 || !saa || !sbb) return -1;
  return sab / Math.sqrt(saa * sbb);
}

/* Searches yield to the event loop after every row of candidates. They are
   plain JavaScript, and run whole they held the server for up to a second at
   a time — every other reviewer's request, /health and the editor's saves
   waited behind one HD press. */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

async function searchAt(a, b, w, h, scales, shiftsX, shiftsY, stride) {
  let best = { s: 1, dx: 0, dy: 0, ncc: -2 };
  for (const s of scales) {
    for (const dy of shiftsY) {
      for (const dx of shiftsX) {
        const ncc = nccAt(a, b, w, h, s, dx, dy, stride);
        if (ncc > best.ncc) best = { s, dx, dy, ncc };
      }
      await breathe();
    }
  }
  return best;
}

const range = (center, half, step) => {
  const out = [];
  for (let v = center - half; v <= center + half + 1e-9; v += step) out.push(Number(v.toFixed(5)));
  return out;
};

/* Every comparison band-passes at no finer than `origSigma` ORIGINAL pixels,
   whatever the level. The original has no structure finer than its own
   pixels — at 120x80 the 512px level's 2.5px band was a fifth of one — and a
   band it does not have is a band in which a perfect restore and a wrong one
   score alike. */
async function levelPair(sharp, yo, yr, w, h, rw, rh, lw, lh, origPx) {
  const sigma = Math.max(2.5, 1.5 * origPx * lw / w);
  const lo = await resize1(sharp, yo, w, h, lw, lh);
  const lr = await resize1(sharp, yr, rw, rh, lw, lh);
  return [await bandPass(sharp, lo, lw, lh, sigma), await bandPass(sharp, lr, lw, lh, sigma)];
}

/* Where the model put the photograph, and whether it is this photograph.

   Coarse to fine: a wide search on a ~160px thumbnail, narrowed on ~512px,
   settled to a quarter pixel at full size. The scale window at 512px is wider
   than one coarse step, so a model that drifted the frame by 1% is not forced
   onto the nearest coarse bin and then refused.

   The full-size step compares the original enlarged with the restore put
   through the same round trip the band split uses — down to the crop's own
   pixels and back up. Two reasons. Sharp's lanczos enlarge sits half an
   output pixel off its geometric centre; registered against the enlarged
   original directly, the restore was placed half a pixel off, and the split
   turned that into doubled, embossed edges (6-7 dB lost against the right
   pose). Round-tripped, both sides carry the same offset and the right answer
   is (0,0). And the round trip leaves only detail the original resolves, so
   the search is not steered by the model's invented texture — at gain 2.5 and
   above that walked it to the edge of its window.

   `structure` is the NCC at the pose finally chosen, on the picture's shapes
   (see shapes()) at the original's own scale. It says whether the model returned THIS photograph.
   Faithful real restores score 0.7-0.9 on it; a different picture under 0.1. */
async function alignRestore(sharp, yo, rw, rh, yr, Rw, Rh, crop) {
  const origPx = rw / crop.width;   // work pixels per original pixel
  const fit = (edge) => {
    const f = Math.min(1, edge / Math.max(rw, rh));
    return [Math.max(16, Math.round(rw * f)), Math.max(16, Math.round(rh * f))];
  };

  const [cw, ch] = fit(160);
  const [ca, cb] = await levelPair(sharp, yo, yr, rw, rh, Rw, Rh, cw, ch, origPx);
  const reachX = Math.round(cw * 0.05), reachY = Math.round(ch * 0.05);
  let best = await searchAt(ca, cb, cw, ch, range(1, 0.05, 0.01), range(0, reachX, 1), range(0, reachY, 1), 1);

  const [mw, mh] = fit(512);
  const [ma, mb] = await levelPair(sharp, yo, yr, rw, rh, Rw, Rh, mw, mh, origPx);
  let k = mw / cw;
  best = await searchAt(ma, mb, mw, mh, range(best.s, 0.0125, 0.0025),
    range(best.dx * k, 3, 1), range(best.dy * k, 3, 1), 1);

  const grid = await resize1(sharp, yr, Rw, Rh, rw, rh);
  const roundTrip = await resize1(sharp,
    await resize1(sharp, grid, rw, rh, crop.width, crop.height), crop.width, crop.height, rw, rh);
  const sigma = Math.max(2, 1.5 * origPx);
  const fa = await bandPass(sharp, yo, rw, rh, sigma);
  const fb = await bandPass(sharp, roundTrip, rw, rh, sigma);
  const stride = Math.max(2, Math.round(Math.max(rw, rh) / 384));
  k = rw / mw;
  let cx = best.dx * k, cy = best.dy * k;
  // Re-centred while the best pose sits on the window's edge: an edge pick
  // means the answer is outside it.
  for (let pass = 0; pass < 3; pass++) {
    best = await searchAt(fa, fb, rw, rh, range(best.s, 0.002, 0.001),
      range(cx, 1.5, 0.25), range(cy, 1.5, 0.25), stride);
    const onEdge = Math.abs(best.dx - cx) > 1.49 || Math.abs(best.dy - cy) > 1.49;
    if (!onEdge) break;
    cx = best.dx; cy = best.dy;
  }
  const sa = await shapes(sharp, yo, rw, rh, Math.max(1, origPx), 4 * origPx);
  const sb = await shapes(sharp, roundTrip, rw, rh, Math.max(1, origPx), 4 * origPx);
  const structure = nccAt(sa, sb, rw, rh, best.s, best.dx, best.dy, 1);
  return { ...best, ncc: structure, structure, grid };   // dx/dy in region pixels, s about the region's centre
}

// The restore's luminance resampled onto the region's grid through the
// alignment. `valid` marks pixels the restore actually covers.
function warpLuma(yrGrid, rw, rh, align) {
  const out = new Float32Array(rw * rh);
  const valid = new Uint8Array(rw * rh);
  const cx = (rw - 1) / 2, cy = (rh - 1) / 2;
  for (let y = 0; y < rh; y++) {
    const yr = cy + align.s * (y - cy) + align.dy;
    for (let x = 0; x < rw; x++) {
      const xr = cx + align.s * (x - cx) + align.dx;
      const i = y * rw + x;
      if (yr < 0 || yr > rh - 1 || xr < 0 || xr > rw - 1) continue;
      const x0 = xr | 0, y0 = yr | 0;
      const x1 = x0 + 1 < rw ? x0 + 1 : x0, y1 = y0 + 1 < rh ? y0 + 1 : y0;
      const fx = xr - x0, fy = yr - y0;
      out[i] = (yrGrid[y0 * rw + x0] * (1 - fx) + yrGrid[y0 * rw + x1] * fx) * (1 - fy)
             + (yrGrid[y1 * rw + x0] * (1 - fx) + yrGrid[y1 * rw + x1] * fx) * fy;
      valid[i] = 1;
    }
  }
  return { out, valid };
}

/* How much of the model's detail to use, from the contrast slope between its
   structure and the original's. Only ever damping: a model that boosted
   contrast has its detail brought back down, but a slope under 1 — which is
   what the original's own grain produces, 0.6–0.7 on real news photos — never
   turns into a boost. Dividing by it was a 50% oversharpen. */
export function hdDetailScale(slope) {
  return 1 / Math.max(1, clamp(Number(slope) || 1, 0.8, 1.25));
}

/* The whole job. `original` is decodeRgb()'s result, `restored` the model's
   answer for plan.crop. Returns the rebuilt photograph at plan.work size as
   raw RGB, and what happened, for the status line and the log. */
export async function hdDetailTransfer(sharp, original, restored, plan) {
  const { width: W, height: H } = original;
  const { width: Wk, height: Hk } = plan.work;
  const kx = Wk / W, ky = Hk / H;

  // The original, enlarged. Outside the model's crop this is the result.
  const up = await sharp(original.data, { raw: { width: W, height: H, channels: 3 } })
    .resize(Wk, Hk, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();

  // The crop's place in the enlarged frame.
  const rx = clamp(Math.round(plan.crop.left * kx), 0, Wk - 1);
  const ry = clamp(Math.round(plan.crop.top * ky), 0, Hk - 1);
  const rw = clamp(Math.round(plan.crop.width * kx), 2, Wk - rx);
  const rh = clamp(Math.round(plan.crop.height * ky), 2, Hk - ry);

  const yUp = lumaOf(up, Wk, Hk);
  const yo = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) yo.set(yUp.subarray((ry + y) * Wk + rx, (ry + y) * Wk + rx + rw), y * rw);

  const R = await decodeRgb(sharp, restored);
  const yr = lumaOf(R.data, R.width, R.height);

  const align = await alignRestore(sharp, yo, rw, rh, yr, R.width, R.height, plan.crop);
  const stats = {
    alignment: {
      structure: Number(align.structure.toFixed(3)),
      scale: Number(align.s.toFixed(4)),
      dx: Number(align.dx.toFixed(2)),
      dy: Number(align.dy.toFixed(2)),
    },
    detailShare: 0,
    rejected: false,
  };
  if (!(align.structure >= MIN_ALIGNMENT)) {
    // The model returned something that is not this photograph. Nothing of it
    // is used; the press still gets the clean enlarge.
    stats.rejected = true;
    return { data: up, width: Wk, height: Hk, stats };
  }

  const { out: yal, valid } = warpLuma(align.grid, rw, rh, align);

  /* The split. `yp` is the restore with everything finer than the original
     could record taken out — down to the crop's own pixel size and back. The
     difference is the model's detail and nothing else. */
  const yp = await resize1(sharp,
    await resize1(sharp, yal, rw, rh, plan.crop.width, plan.crop.height),
    plan.crop.width, plan.crop.height, rw, rh);

  /* The gate compares structure, not tone: both band-passed at a couple of
     original pixels, and the model's contrast matched to the original's by
     one global gain first, so a restore that is uniformly crisper or flatter
     is not mistaken for a different picture. */
  const sigmaB = 2.5 * kx;
  const bo = await bandPass(sharp, yo, rw, rh, sigmaB);
  const bp = await bandPass(sharp, yp, rw, rh, sigmaB);
  let num = 0, den = 0;
  for (let i = 0; i < bo.length; i++) if (valid[i]) { num += bo[i] * bp[i]; den += bo[i] * bo[i]; }
  /* A regression slope, so the original's own JPEG noise drags it low
     (0.6–0.7 on real news photos the model returned faithfully). Clamped for
     the gate; and the detail is only ever damped by it, never amplified — a
     1/0.62 boost was a 60% oversharpen. */
  const slope = den ? num / den : 1;
  const gainK = clamp(slope, 0.8, 1.25);
  const detailScale = hdDetailScale(slope);
  stats.contrast = Number(slope.toFixed(3));

  const diff = new Float32Array(rw * rh);
  const mag = new Float32Array(rw * rh);
  for (let i = 0; i < diff.length; i++) {
    diff[i] = valid[i] ? Math.abs(bp[i] - gainK * bo[i]) : 255;
    mag[i] = Math.abs(bo[i]);
  }
  const sigmaS = Math.max(1, 1.5 * kx);
  const diffS = await blur1(sharp, diff, rw, rh, sigmaS);
  const magS = await blur1(sharp, mag, rw, rh, sigmaS);

  // Faded to nothing at the crop's edge, so the model's sharpness does not
  // stop along a line where the original-only margin begins.
  const feather = Math.max(4, Math.round(0.03 * Math.min(rw, rh)));
  // Each side on its own: a crop one pixel narrower than the photo still
  // touches the frame on one side, and that side is the photo's real edge.
  const fade = (d, inside) => (inside ? smoothstep(0, feather, d) : 1);
  const left = rx > 0, right = rx + rw < Wk, top = ry > 0, bottom = ry + rh < Hk;
  const gate = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const ey = fade(y, top) * fade(rh - 1 - y, bottom);
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      if (!valid[i]) continue;
      const ex = fade(x, left) * fade(rw - 1 - x, right);
      const slack = GATE_RELATIVE * magS[i];
      gate[i] = (1 - smoothstep(GATE_LOW + slack, GATE_HIGH + slack, diffS[i])) * ex * ey;
    }
  }
  // Softened so a speckled verdict does not print as a speckled texture.
  const gateS = await blur1(sharp, gate.map((g) => g * 255), rw, rh, Math.max(1, kx));

  const outRgb = Buffer.from(up);
  let share = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      const g = valid[i] ? clamp(gateS[i] / 255, 0, 1) : 0;
      share += g;
      if (g <= 0.002) continue;
      // Luminance only, the same amount on R, G and B: no colour from the model.
      const d = g * (yal[i] - yp[i]) * detailScale;
      const j = ((ry + y) * Wk + rx + x) * 3;
      outRgb[j] = clamp(Math.round(outRgb[j] + d), 0, 255);
      outRgb[j + 1] = clamp(Math.round(outRgb[j + 1] + d), 0, 255);
      outRgb[j + 2] = clamp(Math.round(outRgb[j + 2] + d), 0, 255);
    }
  }
  stats.detailShare = Number((share / (Wk * Hk)).toFixed(3));
  return { data: outRgb, width: Wk, height: Hk, stats };
}

/* The last step for every press: lanczos to the HD size, a light sharpen,
   and a JPEG that keeps colour at full resolution.

   No denoise. The free enlarge's hqdn3d was tuned for soft JPEG thumbnails
   and turned skin to wax on everything else. And the sharpen is a fraction of
   that chain's: a rebuilt picture already carries the model's detail, and
   sharpening it hard again is what drew halos round eyes and hairlines. 4:4:4
   because 4:2:0 halves colour resolution, which smears lips and skin edges. */
export async function hdFinish(sharp, raw, target, { detail = false } = {}) {
  let pipe = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 3 } });
  if (target.width !== raw.width || target.height !== raw.height) {
    pipe = pipe.resize(target.width, target.height, { kernel: "lanczos3", fit: "fill" });
  }
  pipe = detail
    ? pipe.sharpen({ sigma: 0.7, m1: 0.3, m2: 0.7 })
    : pipe.sharpen({ sigma: 1, m1: 0.5, m2: 1.1 });
  return pipe.jpeg({ quality: 93, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
}
