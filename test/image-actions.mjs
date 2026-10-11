/* ── The AI Usage audit's input rules ────────────────────────────────────────

   Run: node test/image-actions.mjs

   The audit has two writers: the server, which records every press that
   reaches it along with the cost and the picture, and the browser, which
   reports only what the server never sees. These tests hold the line between
   them. If the browser could claim a cost, an engine or a free_upscale press,
   the admin screen's numbers would be whatever a tab said they were — and a
   press the server already recorded would be counted twice. */

import {
  actionForJob, cleanClientReport, cleanDay, cleanPixId, IMAGE_ACTIONS,
} from "../lib/image-actions.js";

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

const PIX = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

console.log("\nThe browser reports only what the server never sees");
{
  const undo = cleanClientReport({ action: "undo", outcome: "success", pixId: PIX, pageId: "p1" });
  ck("undo is accepted", undo?.action === "undo" && undo.outcome === "success");
  ck("undo carries no job", undo?.job === null);
  ck("undo keeps its post", undo?.pixId === PIX && undo.pageId === "p1");

  ck("a failed undo is refused — there is no server side to fail",
    cleanClientReport({ action: "undo", outcome: "failed" }) === null);

  const plan = cleanClientReport({ action: "ai_upscale", outcome: "failed", job: "expand", error: "HTTP 502" });
  ck("a paid press that stopped at planning is accepted", plan?.action === "ai_upscale" && plan.outcome === "failed");
  ck("its job is kept", plan?.job === "expand");

  ck("free_upscale is the server's to record",
    cleanClientReport({ action: "free_upscale", outcome: "success" }) === null);
  ck("an unknown button is refused",
    cleanClientReport({ action: "delete_everything", outcome: "success" }) === null);
  ck("an unknown outcome is refused",
    cleanClientReport({ action: "reframe", outcome: "great" }) === null);
  ck("an empty body is refused", cleanClientReport({}) === null);
  ck("a missing body is refused", cleanClientReport(undefined) === null);
}

console.log("\nThe browser cannot claim what only the server measures");
{
  const r = cleanClientReport({
    action: "reframe", outcome: "skipped",
    costUsd: 99, engine: "made-up", resultKey: "ai-audit/x.jpg", userId: "someone-else", cached: true,
  });
  ck("cost is dropped", !("costUsd" in r));
  ck("engine is dropped", !("engine" in r));
  ck("result picture is dropped", !("resultKey" in r) && !("beforeKey" in r));
  ck("identity is dropped — it comes from the session", !("userId" in r) && !("userName" in r));
  ck("cache flag is dropped", !("cached" in r));
}

console.log("\nFields are bounded and cleaned");
{
  const r = cleanClientReport({
    action: "ai_upscale", outcome: "failed", job: "SOMETHING",
    headline: "x".repeat(500), error: "e".repeat(1000), pageId: "p".repeat(300),
  });
  ck("an unknown job becomes null", r.job === null);
  ck("headline is capped at 200", r.headline.length === 200);
  ck("error is capped at 300", r.error.length === 300);
  ck("page id is capped at 100", r.pageId.length === 100);
  const blank = cleanClientReport({ action: "undo", outcome: "success", headline: "   " });
  ck("a blank headline is null, not an empty string", blank.headline === null);
}

console.log("\nPost ids must be real UUIDs");
{
  ck("a uuid passes", cleanPixId(PIX) === PIX);
  ck("upper case is folded", cleanPixId(PIX.toUpperCase()) === PIX);
  ck("an unsaved post's empty id is null", cleanPixId("") === null);
  ck("anything else is null", cleanPixId("1; drop table pix_posts") === null);
  ck("a number is null", cleanPixId(42) === null);
}

console.log("\nDays must be real calendar days");
{
  ck("a real day passes", cleanDay("2026-10-11") === "2026-10-11");
  ck("the right shape but not a day is refused", cleanDay("2026-13-45") === null);
  ck("29 Feb in a non-leap year is refused", cleanDay("2026-02-29") === null);
  ck("29 Feb in a leap year passes", cleanDay("2028-02-29") === "2028-02-29");
  ck("another format is refused", cleanDay("11-10-2026") === null);
  ck("nothing is null", cleanDay(null) === null);
}

console.log("\nA paid call is credited to the button that made it");
{
  ck("reframe is the Reframe button", actionForJob("reframe") === "reframe");
  ck("restore is AI Upscale", actionForJob("restore") === "ai_upscale");
  ck("expand is AI Upscale with a different Job", actionForJob("expand") === "ai_upscale");
  ck("anything unrecognised is AI Upscale", actionForJob(undefined) === "ai_upscale");
  ck("the four buttons are the report's filter set",
    IMAGE_ACTIONS.join() === "ai_upscale,reframe,free_upscale,undo");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
