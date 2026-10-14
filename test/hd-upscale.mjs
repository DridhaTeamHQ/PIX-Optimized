/* ── HD Upscale: OpenAI detail on the writer's own pixels ───────────────────

   Run: node test/hd-upscale.mjs

   HD Upscale used to hand back gpt-image-1.5's restore as the picture, and
   the restore is a redraw: faces came back as near-likenesses. The browser
   also cropped the photo to a model shape and shrank it to 1024px first, and
   the enlarge after it waxed the skin and haloed the edges.

   lib/hd-upscale.js now rebuilds the picture from the original and takes only
   the model's finer detail, where the model agrees with the photograph. What
   is held down here is the property that keeps faces, measured on a scene
   whose true high-resolution version is known:

     - shrunk back to its own size, the result is the original;
     - it is closer to the truth than the original enlarged on its own;
     - a model that redrew a face (eyes moved, mouth turned) has its face
       ignored: there the result IS the original enlarged;
     - a model that shifted, rescaled, brightened or contrasted the frame is
       registered and corrected for, and no colour comes from it;
     - a model that answered with a different picture is not used at all;
     - outside the part the model was shown, nothing of it appears;
     - the browser sends the whole photograph, uncropped, at its own size,
       and agrees with the server about when the model runs.

   The fake "model" answers are renderings of the same vector scene at the
   model's size, edited, so every case has a known right answer. */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  planHdUpscale, hdFinalSize, decodeRgb, cropForModel, hdDetailTransfer, hdFinish, hdDetailScale, HD_MODEL_SHAPES,
} from "../lib/hd-upscale.js";

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

/* ── The scene: sky, a brick wall with lettering, a face, fine stripes ── */
const SW = 1536, SH = 1024;
function scene({ eyesDx = 0, frown = false, transform = "", tone = "" } = {}) {
  const mouth = frown ? "M 645 640 Q 700 610 755 640" : "M 650 630 Q 700 660 750 630";
  const windows = Array.from({ length: 12 }, (_, i) =>
    `<rect x="${990 + (i % 4) * 110}" y="${210 + Math.floor(i / 4) * 150}" width="70" height="100" fill="#223" stroke="#eee" stroke-width="5"/>`).join("");
  const stripes = Array.from({ length: 40 }, (_, i) =>
    `<line x1="${110 + i * 11}" y1="160" x2="${110 + i * 11}" y2="440" stroke="#123" stroke-width="2.5"/>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a8fd0"/><stop offset="1" stop-color="#d9e6f2"/></linearGradient>
    <pattern id="brick" width="32" height="16" patternUnits="userSpaceOnUse"><rect width="32" height="16" fill="#8a4b32"/><path d="M0 0H32M0 8H32M8 0V8M24 8V16" stroke="#d8c3b0" stroke-width="1.5"/></pattern>
  </defs>
  <g ${transform ? `transform="${transform}"` : ""} ${tone}>
    <rect width="${SW}" height="${SH}" fill="url(#sky)"/>
    <rect x="950" y="150" width="500" height="874" fill="url(#brick)"/>${windows}
    <text x="975" y="750" font-family="Arial" font-weight="bold" font-size="75" fill="#ffd400">PIXIE NEWS</text>
    <rect x="0" y="850" width="${SW}" height="174" fill="#556b2f"/>
    <ellipse cx="700" cy="550" rx="165" ry="210" fill="#e0ac88"/>
    <path d="M535 500 Q700 260 865 500 L865 430 Q700 280 535 430 Z" fill="#3b2412"/>
    <ellipse cx="${635 + eyesDx}" cy="520" rx="30" ry="16" fill="#fff"/><circle cx="${635 + eyesDx}" cy="520" r="12" fill="#2a1a0a"/>
    <ellipse cx="${765 + eyesDx}" cy="520" rx="30" ry="16" fill="#fff"/><circle cx="${765 + eyesDx}" cy="520" r="12" fill="#2a1a0a"/>
    <path d="M700 530 L685 590 L715 590" stroke="#9b6a4c" stroke-width="5" fill="none"/>
    <path d="${mouth}" stroke="#8b2a2a" stroke-width="11" fill="none" stroke-linecap="round"/>
    <rect x="100" y="150" width="450" height="300" fill="none" stroke="#fff" stroke-width="3"/>${stripes}
  </g></svg>`);
}
const render = (svg, w, h) => sharp(svg).resize(w, h, { kernel: "lanczos3", fit: "fill" }).png().toBuffer();

async function resizeRgb(img, w, h) {
  const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(w, h, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer();
  return { data, width: w, height: h };
}
function psnr(a, b, r = { x: 0, y: 0, w: a.width, h: a.height }) {
  let se = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const j = (y * a.width + x) * 3;
    for (let c = 0; c < 3; c++) { const d = a.data[j + c] - b.data[j + c]; se += d * d; n++; }
  }
  return 10 * Math.log10(255 * 255 / (se / n || 1e-9));
}
function meanAbs(a, b, r) {
  let s = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const j = (y * a.width + x) * 3;
    for (let c = 0; c < 3; c++) { s += Math.abs(a.data[j + c] - b.data[j + c]); n++; }
  }
  return s / n;
}
function meanChannel(img, c) {
  let s = 0;
  for (let i = c; i < img.data.length; i += 3) s += img.data[i];
  return s / (img.data.length / 3);
}

console.log("\nplanHdUpscale — what a press does, from the size alone");
{
  const p = planHdUpscale(600, 400);
  ck("600x400: the model runs, shown the whole photo at 3:2", p.ai && p.size === "1536x1024"
    && p.crop.left === 0 && p.crop.top === 0 && p.crop.width === 600 && p.crop.height === 400, JSON.stringify(p));
  ck("600x400: worked at the model's 2.56x, finished at 3072x2048", p.gain === 2.56
    && p.work.width === 1536 && p.target.width === 3072 && p.target.height === 2048, JSON.stringify(p));

  const wide = planHdUpscale(1280, 720);
  ck("1280x720: the model is shown a centred 3:2 crop…", wide.ai && wide.crop.width === 1080 && wide.crop.left === 100,
    JSON.stringify(wide.crop));
  ck("…but the result is the whole 16:9 frame, not the crop", wide.target.width / wide.target.height > 1.77
    && wide.target.width / wide.target.height < 1.78, JSON.stringify(wide.target));

  const near = planHdUpscale(1400, 933);
  ck("1400x933: a 1536px answer is 1.1x — not worth paying for, free enlarge", !near.ai && near.target.width === 2800,
    JSON.stringify(near));
  ck("1000x1000: a 1024 square answer adds nothing — free", !planHdUpscale(1000, 1000).ai);
  ck("700x700: a 1024 square answer is 1.46x — the model runs at 1024x1024", (() => {
    const q = planHdUpscale(700, 700); return q.ai && q.size === "1024x1024";
  })());
  const tall = planHdUpscale(683, 1024);
  ck("683x1024 portrait: the model runs at 1024x1536", tall.ai && tall.size === "1024x1536", JSON.stringify(tall));
  ck("3000x2000: already HD — skipped, nothing spent", planHdUpscale(3000, 2000).skip === true);
  ck("a 4:1 banner is not paid for: the model would see a quarter of it", [[1600, 400], [2400, 600], [600, 2400], [2400, 30]]
    .every(([a, b]) => !planHdUpscale(a, b).ai));
  ck("no output ever passes the 3072 cap", [[1200, 400], [1400, 400], [2400, 300], [2000, 200], [2400, 30], [400, 1200], [1280, 720], [50, 800]]
    .every(([a, b]) => { const q = planHdUpscale(a, b); return q.skip || Math.max(q.target.width, q.target.height) <= 3072; }));
  ck("a photo and the same photo rotated resolve to mirrored shapes", [[1220, 1000], [900, 700], [640, 1000]].every(([a, b]) => {
    const p1 = planHdUpscale(a, b), p2 = planHdUpscale(b, a);
    return p1.shape.w === p2.shape.h && p1.shape.h === p2.shape.w && p1.ai === p2.ai;
  }));
  ck("every model size the plan asks for is one gpt-image sells", [[300, 200], [500, 900], [800, 800], [1200, 500]]
    .every(([a, b]) => HD_MODEL_SHAPES.some((s) => s.size === planHdUpscale(a, b).size)));
  ck("2600x1733 is within a quarter of HD — skipped, not stretched 1.18x", planHdUpscale(2600, 1733).skip === true);
  ck("the finish never stretches by a sliver", hdFinalSize(2600, 1733).width === 2600 && hdFinalSize(2400, 1600).width === 3072);
}

console.log("\nThe browser agrees with the server about when the model runs");
{
  const MODEL_SHAPES = [1, 1024 / 1536, 1536 / 1024];
  // eslint-disable-next-line no-new-func
  const factory = new Function("MODEL_SHAPES", `
    ${fnSrc(app, "nearestModelShape")}
    const HD_AI_MIN_GAIN = ${/const HD_AI_MIN_GAIN = ([\d.]+);/.exec(app)?.[1]};
    const HD_LONG_EDGE = ${/const HD_LONG_EDGE = (\d+);/.exec(app)?.[1]};
    const HD_MIN_ENLARGE = ${/const HD_MIN_ENLARGE = ([\d.]+);/.exec(app)?.[1]};
    ${fnSrc(app, "hdUsesAI")}
    return hdUsesAI;`);
  const hdUsesAI = factory(MODEL_SHAPES);
  ck("the browser's 'Already HD' line is the server's", /const HD_MIN_ENLARGE = ([\d.]+);/.exec(app)?.[1] === "1.25"
    && /export const HD_MIN_ENLARGE = 1\.25;/.test(read("..", "lib", "hd-upscale.js")));
  const serverGain = Number(/const HD_AI_MIN_GAIN = ([\d.]+);/.exec(server)?.[1]);
  ck("the browser's gain line is the server's default", serverGain === 1.3, String(serverGain));
  let disagree = [];
  for (let w = 120; w <= 3200; w += 37) {
    for (const r of [0.5, 0.66, 0.75, 0.9, 1, 1.2, 1.33, 1.5, 1.78, 2.2]) {
      const h = Math.round(w / r);
      const p = planHdUpscale(w, h);
      if (hdUsesAI(w, h) !== Boolean(p && !p.skip && p.ai)) disagree.push(`${w}x${h}`);
    }
  }
  ck("hdUsesAI matches planHdUpscale on 860 sizes", disagree.length === 0, disagree.slice(0, 8).join(", "));
}

console.log("\nhdDetailTransfer — the rebuild, against a known truth");
const truth = await decodeRgb(sharp, await render(scene(), SW, SH));
const original = await decodeRgb(sharp, await sharp(await render(scene(), 600, 400)).jpeg({ quality: 72 }).toBuffer());
const plan = planHdUpscale(original.width, original.height);
const upOnly = await resizeRgb(original, plan.work.width, plan.work.height);
const face = { x: 560, y: 470, w: 280, h: 200 };
const windows = { x: 100, y: 150, w: 450, h: 300 };
const run = async (svg) => hdDetailTransfer(sharp, original, await render(svg, plan.shape.w, plan.shape.h), plan);
const baseRoundTrip = psnr(await resizeRgb(upOnly, original.width, original.height), original);
const basePsnr = psnr(upOnly, truth);
{
  const r = await run(scene());
  ck("a faithful answer is used across most of the photo", !r.stats.rejected && r.stats.detailShare > 0.6,
    JSON.stringify(r.stats));
  const back = psnr(await resizeRgb(r, original.width, original.height), original);
  ck("shrunk back to its own size, the result is the original", back >= baseRoundTrip - 0.5,
    `${back.toFixed(2)} dB vs lanczos round trip ${baseRoundTrip.toFixed(2)}`);
  const gained = psnr(r, truth);
  ck("closer to the truth than the original enlarged alone", gained > basePsnr + 1,
    `${gained.toFixed(2)} dB vs ${basePsnr.toFixed(2)}`);
  ck("…and most of all in the fine detail", psnr(r, truth, windows) > psnr(upOnly, truth, windows) + 2,
    `${psnr(r, truth, windows).toFixed(2)} vs ${psnr(upOnly, truth, windows).toFixed(2)}`);
}
{
  const r = await run(scene({ transform: "translate(768 512) scale(1.012) translate(-768 -512) translate(4.5 -3)" }));
  const a = r.stats.alignment;
  ck("a frame the model rescaled and shifted is registered", Math.abs(a.scale - 1.012) < 0.003
    && Math.abs(a.dx - 4.5) <= 1 && Math.abs(a.dy + 3) <= 1, JSON.stringify(a));
  ck("…and still gains detail rather than ghosting", psnr(r, truth) > basePsnr + 1,
    `${psnr(r, truth).toFixed(2)} vs ${basePsnr.toFixed(2)}`);
}
{
  const r = await run(scene({ eyesDx: 11, frown: true, transform: "translate(2.5 2)" }));
  const kept = meanAbs(r, upOnly, face);
  ck("a REDRAWN face is ignored: there the result is the original enlarged", kept < 0.6, `mean diff ${kept.toFixed(2)}`);
  ck("…while the rest of the photo still takes the detail", r.stats.detailShare > 0.5
    && psnr(r, truth, windows) > psnr(upOnly, truth, windows) + 2, JSON.stringify(r.stats));
}
{
  const r = await run(scene({ tone: `style="filter: brightness(1.1) contrast(1.2) saturate(1.3)"` }));
  const drift = Math.max(...[0, 1, 2].map((c) => Math.abs(meanChannel(r, c) - meanChannel(upOnly, c))));
  ck("a model that brightened and saturated the frame lends it no colour", drift < 1, `drift ${drift.toFixed(2)}`);
  ck("…and its detail is still used", !r.stats.rejected && r.stats.detailShare > 0.4, JSON.stringify(r.stats));
}
{
  /* Found on real photographs: the model returns the same picture with its
     own fine texture everywhere — pores, grain, fabric — which never matches
     an enlarged original. Judged at full size that read as "a different
     picture" and threw good answers away (NCC 0.3–0.5). */
  const clean = await render(scene(), plan.shape.w, plan.shape.h);
  let seed = 7;
  const noise = Buffer.alloc(plan.shape.w * plan.shape.h * 3);
  const base = await sharp(clean).removeAlpha().raw().toBuffer();
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    noise[i] = Math.max(0, Math.min(255, base[i] + ((seed >>> 16) % 161) - 80));
  }
  const grainy = await sharp(noise, { raw: { width: plan.shape.w, height: plan.shape.h, channels: 3 } }).png().toBuffer();
  const r = await hdDetailTransfer(sharp, original, grainy, plan);
  ck("a faithful answer covered in invented texture is still recognised as this photo",
    !r.stats.rejected && r.stats.alignment.structure >= 0.55, JSON.stringify(r.stats.alignment));
  ck("…and clearly so, not on the margin", r.stats.alignment.structure >= 0.7, JSON.stringify(r.stats.alignment));
}
{
  /* Also found on real photographs: the original's own grain drags the
     contrast slope to 0.6–0.7, and dividing the detail by it oversharpened
     by half again. The model's detail may be damped, never amplified. */
  const o = await sharp(await render(scene(), 600, 400)).removeAlpha().raw().toBuffer();
  let seed = 11;
  for (let i = 0; i < o.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    o[i] = Math.max(0, Math.min(255, o[i] + ((seed >>> 16) % 71) - 35));
  }
  const grainy = await decodeRgb(sharp, await sharp(o, { raw: { width: 600, height: 400, channels: 3 } }).jpeg({ quality: 80 }).toBuffer());
  const r = await hdDetailTransfer(sharp, grainy, await render(scene(), plan.shape.w, plan.shape.h), plan);
  ck("a grainy original pulls the contrast slope as low as real photos do", r.stats.contrast < 0.8, String(r.stats.contrast));
  const scales = [0.3, 0.62, 0.7, 0.8, 0.95, 1, 1.1, 1.25, 1.6, NaN].map(hdDetailScale);
  ck("…and the detail is never amplified, whatever the slope", scales.every((v) => v > 0 && v <= 1), scales.join(", "));
  ck("…but a model that boosted contrast is damped back", Math.abs(hdDetailScale(1.2) - 1 / 1.2) < 1e-9
    && Math.abs(hdDetailScale(2) - 1 / 1.25) < 1e-9);
}
{
  /* Found in review: sharp's lanczos enlarge sits half a pixel off centre,
     and registering the restore against it placed the detail half a pixel
     off — doubled edges, 6-7 dB lost. The scene here is rendered straight at
     both sizes, so the right registration is exactly (0,0). */
  const r = await run(scene());
  const a = r.stats.alignment;
  ck("an exactly aligned restore is registered at (0,0), not half a pixel off",
    Math.abs(a.dx) <= 0.25 && Math.abs(a.dy) <= 0.25 && Math.abs(a.scale - 1) <= 0.001, JSON.stringify(a));
}
{
  // Found in review: below ~240px a PERFECT restore was rejected after being paid for.
  const tiny = await decodeRgb(sharp, await render(scene(), 180, 120));
  const tp = planHdUpscale(180, 120);
  const r = await hdDetailTransfer(sharp, tiny, await render(scene(), tp.shape.w, tp.shape.h), tp);
  ck("a small photo's perfect restore is accepted, not refused after payment", !r.stats.rejected, JSON.stringify(r.stats));
}
{
  // Found in review: a 1% frame drift fell between coarse scale bins and was refused or misplaced.
  const mid = await decodeRgb(sharp, await render(scene(), 683, 455));
  const mp = planHdUpscale(683, 455);
  const answer = await render(scene({ transform: "translate(768 512) scale(0.99) translate(-768 -512) translate(-5 6)" }), mp.shape.w, mp.shape.h);
  const r = await hdDetailTransfer(sharp, mid, answer, mp);
  ck("a restore drifted by 1% is found and used", !r.stats.rejected && Math.abs(r.stats.alignment.scale - 0.99) < 0.004,
    JSON.stringify(r.stats.alignment));
}
{
  // Found in review: a crop 1px narrower than the photo faded the detail along the photo's own edge.
  // Shifted so the fine stripes run right up to the left edge.
  const edgeScene = scene({ transform: "translate(-105 0)" });
  const odd = await decodeRgb(sharp, await render(edgeScene, 601, 400));
  const op = planHdUpscale(601, 400);
  const r = await hdDetailTransfer(sharp, odd, await render(edgeScene, op.shape.w, op.shape.h), op);
  const oddUp = await resizeRgb(odd, op.work.width, op.work.height);
  const edge = meanAbs(r, oddUp, { x: 0, y: 170, w: 10, h: 250 });
  const inner = meanAbs(r, oddUp, { x: 40, y: 170, w: 10, h: 250 });
  ck("detail reaches the photo's real edge when the crop touches it", edge > inner * 0.6,
    `edge ${edge.toFixed(2)} vs inside ${inner.toFixed(2)}`);
}
{
  /* Found in review: the alignment ran for up to a second without yielding,
     stalling every other request on the server. */
  let worst = 0, last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 1);
  await run(scene());
  clearInterval(tick);
  ck("the rebuild never holds the event loop for long", worst < 250, `longest stall ${worst} ms`);
}
{
  const other = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}"><rect width="${SW}" height="${SH}" fill="#345"/><circle cx="450" cy="350" r="250" fill="#c33"/><text x="150" y="900" font-size="150" fill="#fff">SOMETHING ELSE</text></svg>`);
  const r = await run(other);
  ck("a different picture is rejected outright", r.stats.rejected && r.stats.detailShare === 0, JSON.stringify(r.stats));
  ck("…and the result is exactly the original enlarged", Buffer.compare(r.data, upOnly.data) === 0);
}
{
  // 16:9: the model is shown only the centre 3:2.
  const wideOrig = await decodeRgb(sharp, await render(scene(), 1280 / 2, 720 / 2));
  const wp = planHdUpscale(wideOrig.width, wideOrig.height);
  const crop = await cropForModel(sharp, wideOrig, wp.crop);
  const cm = await sharp(crop).metadata();
  ck("the model's copy is the crop, at its own pixels — never shrunk", cm.width === wp.crop.width && cm.height === wp.crop.height,
    `${cm.width}x${cm.height} vs ${JSON.stringify(wp.crop)}`);
  const answer = await render(scene({ tone: `style="filter: brightness(1.05)"` }), wp.shape.w, wp.shape.h);
  const r = await hdDetailTransfer(sharp, wideOrig, answer, wp);
  const wideUp = await resizeRgb(wideOrig, wp.work.width, wp.work.height);
  const edge = Math.floor(wp.crop.left * wp.work.width / wideOrig.width) - 1;
  ck("the result keeps the whole 16:9 frame", r.width === wp.work.width && r.height === wp.work.height);
  ck("outside what the model was shown, nothing of it appears",
    meanAbs(r, wideUp, { x: 0, y: 0, w: edge, h: r.height }) === 0
    && meanAbs(r, wideUp, { x: r.width - edge, y: 0, w: edge, h: r.height }) === 0);
}

console.log("\nhdFinish — the enlarge and the file");
{
  const r = await run(scene());
  const jpeg = await hdFinish(sharp, r, plan.target, { detail: true });
  const m = await sharp(jpeg).metadata();
  ck("JPEG at the target size", m.format === "jpeg" && m.width === plan.target.width && m.height === plan.target.height,
    `${m.format} ${m.width}x${m.height}`);
  ck("colour kept at full resolution (4:4:4, not 4:2:0)", m.chromaSubsampling === "4:4:4", m.chromaSubsampling);
  ck("small enough to carry (< 4 MB at 3072px)", jpeg.length < 4 * 1048576, `${(jpeg.length / 1048576).toFixed(2)} MB`);
}

console.log("\nThe route and the button");
{
  const handler = fnSrc(server, "handleHdUpscale");
  ck("the server rebuilds on the original instead of returning the restore",
    handler.includes("hdDetailTransfer(") && handler.includes("cropForModel(") && !handler.includes("upscaleLocally("));
  ck("the restore uses HD's own prompt", handler.includes("restorePrompt: buildHdRestorePrompt()"));
  ck("the headline never reaches the prompt or the cache key", !/runEnhanceEdit\(\{[^}]*headline/s.test(handler));
  ck("sharp is checked before anything is spent",
    handler.indexOf("loadSharp()") < handler.indexOf("enhanceSpendGate(") && handler.indexOf("loadSharp()") > 0);
  const prompt = fnSrc(server, "buildHdRestorePrompt");
  ck("HD's prompt does not ask the model to invent pores or a better camera",
    !/pores|DSLR|higher-end camera/i.test(prompt));
  const edit = fnSrc(server, "runEnhanceEdit");
  ck("runEnhanceEdit honours a restore prompt, and it is in the cache key",
    /restorePrompt \|\| buildEnhancePrompt/.test(edit) && /quality, composited, prompt/.test(edit));

  const client = fnSrc(app, "runHdUpscale");
  ck("the browser sends the whole photo at its own size",
    /c\.width = w;\s*c\.height = h;/.test(client) && /drawImage\(img, 0, 0, w, h\)/.test(client));
  ck("…with no crop to a model shape and no 1024px shrink",
    !client.includes("RESTORE_UPLOAD_PX") && !client.includes("nearestModelShape"));
  ck("a picture changed during the job is not overwritten",
    client.indexOf("imageOnPage(owner) !== img") > 0
    && client.indexOf("imageOnPage(owner) !== img") < client.indexOf('commitFieldToPage(owner, "mainImage", out)'));
  ck("the focal point carries over instead of being guessed again", /out\.__focalPoint = \{/.test(client));
  ck("the undo slot is taken only once a result is confirmed for this page",
    client.indexOf("rememberImageBeforeAI(owner, img)") > client.indexOf("imageOnPage(owner) !== img")
    && client.indexOf("rememberImageBeforeAI(owner, img)") < client.indexOf('commitFieldToPage(owner, "mainImage", out)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
