// Replays the exact request the CMS's Reframe job sends to gpt-image-1.5,
// straight from this machine, so the model's answer can be looked at without
// a session on the CMS. Costs one image generation (~$0.33 at high).
//
//   node scripts/diag-reframe.mjs prod photo.jpg
//   node scripts/diag-reframe.mjs fidelity-low photo.jpg
//
// The prompt is lifted from server.mjs at run time, so this cannot drift
// from what production sends. Output lands in the current directory.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..") + "/";
const HERE = process.cwd() + "/";

const env = readFileSync(ROOT + ".env", "utf8");
const key = (env.match(/^OPENAI_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!key) throw new Error("no OPENAI_API_KEY in .env");

// The prompt builder, lifted from server.mjs so this cannot drift from it.
const server = readFileSync(ROOT + "server.mjs", "utf8");
function fnSrc(src, name) {
  const a = src.indexOf("function " + name);
  if (a < 0) throw new Error("missing " + name);
  let k = src.indexOf(") {", a) + 2, d = 0;
  for (let j = k; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (!d) return src.slice(a, j + 1); }
  }
}
const buildReframePrompt = new Function(fnSrc(server, "buildReframePrompt") + "\nreturn buildReframePrompt;")();
const model = (server.match(/IMAGE_MODEL_PRIMARY = process\.env\.IMAGE_MODEL \|\| "([^"]+)"/) || [])[1] || "gpt-image-1.5";

const variant = process.argv[2] || "prod";          // prod | fidelity-low
const inputFile = process.argv[3] ? resolve(process.argv[3]) : null;
if (!inputFile) { console.log("usage: node scripts/diag-reframe.mjs <prod|fidelity-low> <photo.png|jpg>"); process.exit(2); }
const prompt = buildReframePrompt("", "9:16", "people");
const quality = "high";
const fidelity = variant === "fidelity-low" ? "low" : "high";

console.log("model       :", model);
console.log("size        : 1024x1536  quality:", quality, " input_fidelity:", fidelity, " background: opaque");
console.log("prompt      :\n" + prompt.split("\n").map((l) => "  | " + l).join("\n"));

const bytes = readFileSync(inputFile);
const mime = inputFile.endsWith(".png") ? "image/png" : "image/jpeg";
const form = new FormData();
form.append("model", model);
form.append("prompt", prompt);
form.append("size", "1024x1536");
form.append("quality", quality);
form.append("input_fidelity", fidelity);
form.append("background", "opaque");
form.append("output_format", "png");
form.append("image", new Blob([bytes], { type: mime }), mime === "image/png" ? "input.png" : "input.jpg");

const t0 = Date.now();
const res = await fetch("https://api.openai.com/v1/images/edits", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}` },
  body: form,
  signal: AbortSignal.timeout(240_000),
});
const ms = Date.now() - t0;
const text = await res.text();
if (!res.ok) { console.log("HTTP", res.status, text.slice(0, 600)); process.exit(1); }
const data = JSON.parse(text);
const b64 = data.data?.[0]?.b64_json;
if (!b64) { console.log("no image in response:", text.slice(0, 400)); process.exit(1); }
const out = HERE + `diag_out_${variant}.png`;
writeFileSync(out, Buffer.from(b64, "base64"));
const u = data.usage || {};
const inTok = u.input_tokens_details?.image_tokens || 0, txt = u.input_tokens_details?.text_tokens || 0, outTok = u.output_tokens || 0;
const usd = (txt * 5 + inTok * 10 + outTok * 40) / 1e6;   // OPENAI_RATE_* defaults from server.mjs
console.log(`done in ${(ms / 1000).toFixed(1)}s → ${out}`);
console.log(`usage: text ${txt}, image-in ${inTok}, out ${outTok} → ~$${usd.toFixed(3)}`);
