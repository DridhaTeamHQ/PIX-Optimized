/* ── Faces, and where their features are ────────────────────────────────────

   YuNet, from the OpenCV Zoo (MIT licence): a 230 KB face detector that
   answers with a box and five landmarks per face — both eyes, the nose tip
   and both mouth corners. Five points are exactly what lining one face up
   with another needs, and that is all Face Lock asks of it (lib/face-lock.js).

   It runs through onnxruntime-node on the server's own CPU, in tens of
   milliseconds a picture. Nothing is uploaded anywhere and nothing is billed.

   Loaded on first use. A machine without the runtime or the model file gets
   `null` from createFaceDetector() rather than a crash: Face Lock is a repair
   laid on top of a reframe, and a reframe without it is still a reframe.

   The decoding below is OpenCV's own (FaceDetectorYN::postProcess, 4.8+),
   transcribed: the model publishes per-cell scores, box offsets and landmark
   offsets at strides 8, 16 and 32, and the input it expects is BGR, 0–255,
   with no mean taken off — cv::dnn::blobFromImage's defaults. */

import { existsSync } from "node:fs";

// The size the model was published at, and a multiple of its coarsest stride.
const INPUT = 640;
const STRIDES = [8, 16, 32];

/* Two passes, because YuNet was trained on faces from about 10px to 300px
   across. Squeezed to 640px a crowd's faces are still in range, but a
   close-up portrait's face is not — so the picture is looked at again at
   half that, where a face that filled the frame is ~300px. The two answers
   are merged, and a face seen by both is kept once. */
const PASS_EDGES = [640, 320];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* Raw model outputs to faces in the picture's own pixels. `f` is the factor
   the picture was resized by on its way into the model; dividing by it puts
   every coordinate back on the original. Exported for the tests, which feed
   it hand-built tensors. */
export function decodeYuNet(outputs, f, { minScore = 0.7, input = INPUT } = {}) {
  const faces = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data;
    const obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data;
    const kps = outputs[`kps_${stride}`]?.data;
    if (!cls || !obj || !bbox || !kps) throw new Error(`YuNet answered without its stride-${stride} outputs`);
    const cols = Math.floor(input / stride), rows = Math.floor(input / stride);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp(cls[i], 0, 1) * clamp(obj[i], 0, 1));
        if (score < minScore) continue;
        const cx = (c + bbox[i * 4]) * stride;
        const cy = (r + bbox[i * 4 + 1]) * stride;
        const w = Math.exp(bbox[i * 4 + 2]) * stride;
        const h = Math.exp(bbox[i * 4 + 3]) * stride;
        const points = [];
        for (let n = 0; n < 5; n++) {
          points.push([
            ((kps[i * 10 + 2 * n] + c) * stride) / f,
            ((kps[i * 10 + 2 * n + 1] + r) * stride) / f,
          ]);
        }
        faces.push({ x: (cx - w / 2) / f, y: (cy - h / 2) / f, w: w / f, h: h / f, score, points });
      }
    }
  }
  return faces;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Best first; anything overlapping a better face by more than `limit` is the same face.
export function suppressOverlaps(faces, limit = 0.3, maxFaces = 12) {
  const kept = [];
  for (const f of [...faces].sort((a, b) => b.score - a.score)) {
    if (kept.some((k) => iou(k, f) > limit)) continue;
    kept.push(f);
    if (kept.length >= maxFaces) break;
  }
  return kept;
}

/* The picture letterboxed into the model's square: resized so its long edge
   is `edge`, laid in the top-left corner, the rest black. Never enlarged past
   2x — a thumbnail's faces do not get more findable by inventing pixels. */
async function toTensor(sharp, rgb, edge) {
  const f = Math.min(2, edge / Math.max(rgb.width, rgb.height));
  const w = clamp(Math.round(rgb.width * f), 1, INPUT);
  const h = clamp(Math.round(rgb.height * f), 1, INPUT);
  const data = await sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
    .resize(w, h, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();
  const plane = INPUT * INPUT;
  const tensor = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = y * INPUT + x;
      tensor[d] = data[s + 2];             // B
      tensor[plane + d] = data[s + 1];     // G
      tensor[2 * plane + d] = data[s];     // R
    }
  }
  // The factor actually applied, per axis rounded: the long edge's is exact.
  return { tensor, f: rgb.width >= rgb.height ? w / rgb.width : h / rgb.height };
}

/* `modelPath` is the .onnx file. Resolves to null when either the runtime or
   the model is missing, and throws only when both are there and still will
   not load — that one is worth a line in the log. */
export async function createFaceDetector({ modelPath, threads = 2, minScore = 0.7 } = {}) {
  if (!modelPath || !existsSync(modelPath)) return null;
  let ort;
  try {
    const mod = await import("onnxruntime-node");
    ort = mod.default ?? mod;
  } catch {
    return null;
  }
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
  });
  const missing = STRIDES.flatMap((s) => [`cls_${s}`, `obj_${s}`, `bbox_${s}`, `kps_${s}`])
    .filter((name) => !session.outputNames.includes(name));
  if (missing.length) throw new Error(`${modelPath} is not YuNet 2023mar (no ${missing.join(", ")})`);
  const inputName = session.inputNames[0];

  // Inference calls on one session are serialised, so two presses landing at
  // once take turns rather than racing for the same threads.
  let queue = Promise.resolve();
  const infer = (tensor) => {
    const next = queue.then(() => session.run({
      [inputName]: new ort.Tensor("float32", tensor, [1, 3, INPUT, INPUT]),
    }));
    queue = next.catch(() => {});
    return next;
  };

  return {
    /* Every face in `rgb` (decodeRgb()'s { data, width, height }), best
       first: { x, y, w, h, score, points: [[x, y] × 5] } in its pixels.
       Points are right eye, left eye, nose tip, right and left mouth corner —
       the subject's right, so the first point is on the picture's left. */
    async detect(sharp, rgb) {
      const found = [];
      for (const edge of PASS_EDGES) {
        const { tensor, f } = await toTensor(sharp, rgb, edge);
        found.push(...decodeYuNet(await infer(tensor), f, { minScore }));
      }
      return suppressOverlaps(found);
    },
  };
}
