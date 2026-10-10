/* ── Matching the upload to a shape the model can return ─────────────────────

   Run: node test/model-shape.mjs

   gpt-image returns three shapes and no others: 1024x1024, 1024x1536 and
   1536x1024 — aspects 1.000, 0.667 and 1.500. A photograph sent at any other
   aspect CANNOT come back as itself. The model makes up the difference, and
   on an outdoor picture the difference is sky. That is the whole of the "it
   keeps adding clouds" report, and no prompt wording touches it: the shape is
   a property of the request, not of the instructions.

   So a restore crops to the nearest of the three first, and what is cropped is
   exactly the strip that would otherwise have been fabricated. A missing edge
   is honest; an invented one is not.

   This file exists because the decision has now been wrong three times, each
   time somewhere nothing could assert on it. */

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

const line = app.split("\n").find((l) => l.startsWith("const MODEL_SHAPES"));
if (!line) throw new Error("MODEL_SHAPES not found");

const api = new Function(`${line}\n${fnSrc("nearestModelShape")}\nreturn { MODEL_SHAPES, nearestModelShape };`)();

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log("\nThe three shapes are the ones gpt-image actually returns");
{
  ck("there are exactly three", api.MODEL_SHAPES.length === 3, String(api.MODEL_SHAPES.length));
  const s = [...api.MODEL_SHAPES].sort((a, b) => a - b).map((v) => +v.toFixed(3));
  ck("and they are 0.667, 1.000, 1.500",
    s[0] === 0.667 && s[1] === 1 && s[2] === 1.5, JSON.stringify(s));
}

console.log("\nCommon press-photo shapes land where they should");
{
  const cases = [
    ["16:9  landscape", 16 / 9, 1.5],
    ["3:2   landscape", 3 / 2, 1.5],
    ["4:3   landscape", 4 / 3, 1.5],
    ["1:1   square", 1, 1],
    ["9:16  portrait", 9 / 16, 1024 / 1536],
    ["2:3   portrait", 2 / 3, 1024 / 1536],
    ["3:4   portrait", 3 / 4, 1024 / 1536],
  ];
  for (const [name, aspect, want] of cases) {
    const got = api.nearestModelShape(aspect);
    ck(name, near(got, want), `${got.toFixed(3)} wanted ${want.toFixed(3)}`);
  }
}

console.log("\nA photo and the same photo rotated pick mirrored shapes");
{
  /* Ratios are multiplicative, so comparing them LINEARLY is asymmetric: at
     1.22 the square is 0.22 away and the landscape 0.28, but at 1/1.22 = 0.82
     the square is 0.18 away and the portrait 0.15. Linear distance would put
     a photograph and its rotation on differently-proportioned shapes. */
  let ok = true, worst = "";
  for (const a of [1.05, 1.22, 1.35, 1.6, 2.0, 3.0]) {
    const up = api.nearestModelShape(a);
    const down = api.nearestModelShape(1 / a);
    if (!near(up, 1 / down)) { ok = false; worst = `${a}: ${up.toFixed(3)} vs 1/${down.toFixed(3)}`; }
  }
  ck("landscape and portrait resolve as mirrors of each other", ok, worst);
}

console.log("\nThe crop only ever removes what would have been invented");
{
  /* The trim is the difference between the source's shape and the target's,
     and it is always a trim — never a pad. Padding would be the model
     inventing the strip, which is the thing being prevented. */
  let ok = true, worst = "";
  for (const a of [16 / 9, 4 / 3, 1, 3 / 4, 9 / 16, 2.4, 0.4]) {
    const t = api.nearestModelShape(a);
    // Largest rect of a 1000-unit-wide source with the target aspect.
    const w = 1000, h = 1000 / a;
    const cw = a > t ? h * t : w;
    const chh = a < t ? w / t : h;
    if (cw > w + 1e-6 || chh > h + 1e-6) { ok = false; worst = `aspect ${a}`; }
  }
  ck("it never asks for more picture than the source has", ok, worst);

  const kept = (a) => {
    const t = api.nearestModelShape(a);
    const w = 1000, h = 1000 / a;
    const cw = a > t ? h * t : w;
    const chh = a < t ? w / t : h;
    return (cw * chh) / (w * h);
  };
  ck("3:2 and 1:1 lose nothing at all",
    near(kept(1.5), 1) && near(kept(1), 1),
    `${(kept(1.5) * 100).toFixed(1)}% / ${(kept(1) * 100).toFixed(1)}%`);
  ck("16:9 loses about 16%", Math.abs(kept(16 / 9) - 0.84) < 0.02, (kept(16 / 9) * 100).toFixed(1) + "%");
  ck("4:3 loses about 11%", Math.abs(kept(4 / 3) - 0.889) < 0.02, (kept(4 / 3) * 100).toFixed(1) + "%");

  /* An extreme panorama is the one case where the trim is severe, and that is
     correct: 2.4 against 1.5 means 37% of the width cannot survive a shape the
     model can return. The alternative is not keeping it — it is the model
     drawing 37% of the frame. */
  ck("a 2.4 panorama loses a lot, and that is the honest answer",
    kept(2.4) < 0.7, (kept(2.4) * 100).toFixed(1) + "%");
}

console.log("\nDegenerate input cannot crash a paid call");
{
  for (const bad of [0, -1, NaN, Infinity, undefined, null]) {
    const r = api.nearestModelShape(bad);
    ck(`${String(bad)} falls back to the square`, r === 1, String(r));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
