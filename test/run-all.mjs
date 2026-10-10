/* ── Run every test file, and fail if any of them does ───────────────────────

   Run: npm test

   The suites were being written and then not run. Each one is a standalone
   script, so `node test/glass.mjs` worked and nothing tied them together —
   which meant a change could break one and the break would sit there until
   somebody happened to invoke that file by hand. A frostReach regression did
   exactly that.

   This discovers the files rather than listing them, so a new suite is
   covered by existing, not by remembering to add it here. run-all itself is
   skipped, or it would recurse. */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
  .sort();

if (!files.length) {
  console.error("No test files found in test/ — that is itself a failure.");
  process.exit(1);
}

let failed = 0;
let totalPassed = 0;
const broken = [];

for (const file of files) {
  const r = spawnSync(process.execPath, [join(here, file)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");

  // Each suite ends with "N passed, M failed".
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const passed = m ? Number(m[1]) : 0;
  const fails = m ? Number(m[2]) : null;
  totalPassed += passed;

  /* A non-zero exit with no summary line means the suite THREW rather than
     failed an assertion — a missing function, a syntax error. That is worse
     than a failed check, not better, so it is reported separately and the
     output is shown; a silent green run past a crashed suite is how a broken
     harness hides a broken feature. */
  const crashed = fails === null;
  const bad = crashed || fails > 0 || r.status !== 0;

  if (bad) {
    failed++;
    broken.push(file);
    console.log(`\n✗ ${file} ${crashed ? "CRASHED" : `— ${fails} failed`}`);
    console.log(out.trim().split("\n").slice(-25).join("\n"));
  } else {
    console.log(`✓ ${file.padEnd(24)} ${passed} passed`);
  }
}

console.log(
  `\n${files.length} suites, ${totalPassed} checks passed` +
  (failed ? `, ${failed} suite(s) failing: ${broken.join(", ")}` : ", all green"),
);
process.exit(failed ? 1 : 0);
