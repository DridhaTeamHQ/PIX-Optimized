/* ── The global spend circuit breaker ────────────────────────────────────────

   Run: node test/spend-guard.mjs

   This is a guard that sits in front of paid work, which makes its failure
   modes asymmetric and both of them bad:

     too loose   it watches the runaway it exists to stop. The interesting
                 case is not "spend exceeds cap" — anything catches that — it
                 is fifty calls launched before the first one returns, which
                 a check-then-add breaker waves through because the total is
                 still zero when all fifty are checked.

     too tight   it refuses work nobody is paying for. A reservation that is
                 never given back is a permanent charge, so a run of FAILED
                 calls — which bill nothing — would close the route on money
                 that was never spent. That is the mode that loses
                 functionality, and it is the one worth most of this file.

   The settle path has a third trap: a response with no usage block must leave
   the reservation standing rather than zeroing it, or a model that quietly
   stops reporting usage switches the breaker off without anybody noticing. */

import { createSpendGuard, priceTextUsage } from "../lib/spend-guard.js";

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

const guard = (capUsd, ms = 60_000) =>
  createSpendGuard([{ name: "test", ms, capUsd }]);

console.log("\nNormal work is never refused");
{
  const g = guard(20);
  let refused = 0;
  // Sixty presses at the real reframe price, one after another, settled
  // honestly. This is a reviewer having a hard day; it must not meet the cap.
  for (let i = 0; i < 60; i++) {
    const r = g.reserve(0.35);
    if (!r.allowed) { refused++; continue; }
    g.settle(r.ticket, 0.12);
  }
  ck("sixty sequential presses all go through", refused === 0, `${refused} refused`);
  ck("total is the measured cost, not the reserved one",
    Math.abs(g.snapshot().test.spentUsd - 7.2) < 0.01,
    `$${g.snapshot().test.spentUsd}`);
}

console.log("\nA burst is caught while it is still in flight");
{
  const g = guard(1);
  // Nothing settles: every one of these is "launched but not yet returned",
  // which is exactly the shape of a loop. A check-then-add guard would allow
  // all fifty, because the spent total never moves until one comes back.
  let allowed = 0;
  for (let i = 0; i < 50; i++) if (g.reserve(0.35).allowed) allowed++;
  ck("the burst is cut off mid-flight", allowed === 2, `${allowed} allowed`);
  ck("nothing in flight is unaccounted for", g.snapshot().inFlight === 2);
}

console.log("\nFailed calls cost nothing and hold nothing");
{
  const g = guard(1);
  // Forty presses that all throw. None of them bills; none may consume
  // headroom. If release() is wrong, the route is shut for an hour on $0.
  for (let i = 0; i < 40; i++) {
    const r = g.reserve(0.35);
    if (r.allowed) g.release(r.ticket);
  }
  const snap = g.snapshot();
  ck("a run of failures leaves the total at zero", Math.abs(snap.test.spentUsd) < 1e-9, `$${snap.test.spentUsd}`);
  ck("and holds no reservation open", snap.inFlight === 0);
  ck("so the next real press is still allowed", g.reserve(0.35).allowed === true);
}

console.log("\nA reply with no usage block leaves the reservation standing");
{
  const g = guard(20);
  const r = g.reserve(0.35);
  g.settle(r.ticket, null);
  ck("unmeasured call still counts as the estimate",
    Math.abs(g.snapshot().test.spentUsd - 0.35) < 1e-9,
    `$${g.snapshot().test.spentUsd}`);
  ck("and does not stay in flight", g.snapshot().inFlight === 0);
}

console.log("\nBoth windows have to have room");
{
  // The slow runaway: never much in any hour, plenty in a day. An hourly
  // ceiling alone never sees it.
  const g = createSpendGuard([
    { name: "hour", ms: 60_000, capUsd: 20 },
    { name: "day", ms: 600_000, capUsd: 5 },
  ]);
  let allowed = 0, refusedBy = null;
  for (let i = 0; i < 40; i++) {
    const r = g.reserve(0.35);
    if (r.allowed) { allowed++; g.settle(r.ticket, 0.35); }
    else { refusedBy = r.window; break; }
  }
  ck("the day cap stops what the hour cap would allow", refusedBy === "day", String(refusedBy));
  ck("and it stops at the right place", allowed === 14, `${allowed} allowed`);
}

console.log("\nA cap of zero meters without ever refusing");
{
  const g = guard(0);
  let refused = 0;
  for (let i = 0; i < 200; i++) {
    const r = g.reserve(0.35);
    if (!r.allowed) refused++; else g.settle(r.ticket, 0.35);
  }
  ck("nothing is refused", refused === 0, `${refused} refused`);
  ck("but the spend is still counted", Math.abs(g.snapshot().test.spentUsd - 70) < 1e-6);
  ck("and the cap reads as absent", g.snapshot().test.capUsd === null);
}

console.log("\nThe window resets");
{
  const g = guard(1, 1);           // a 1ms window
  const first = g.reserve(0.35);
  g.settle(first.ticket, 0.9);
  ck("the window fills", g.snapshot().test.spentUsd > 0.8);
  await new Promise((r) => setTimeout(r, 10));
  ck("and empties once it expires", g.snapshot().test.spentUsd === 0);
  ck("so work resumes", g.reserve(0.35).allowed === true);
}

console.log("\nUngated text spend counts toward the total");
{
  const g = guard(20);
  g.recordUngated(0.0004);
  g.recordUngated(0.0004);
  ck("metered", Math.abs(g.snapshot().test.spentUsd - 0.0008) < 1e-9, `$${g.snapshot().test.spentUsd}`);
  ck("junk is ignored rather than poisoning the total",
    (g.recordUngated(NaN), g.recordUngated(-5), Math.abs(g.snapshot().test.spentUsd - 0.0008) < 1e-9));
}

console.log("\nText is priced from the usage block the reply already carries");
{
  // 1M fresh input + 1M output at the gpt-4o-mini rates = $0.15 + $0.60.
  const usd = priceTextUsage({ prompt_tokens: 1e6, completion_tokens: 1e6 });
  ck("chat-completions spelling", Math.abs(usd - 0.75) < 1e-9, String(usd));

  // The Responses API names the same fields differently.
  const usd2 = priceTextUsage({ input_tokens: 1e6, output_tokens: 1e6 });
  ck("responses spelling", Math.abs(usd2 - 0.75) < 1e-9, String(usd2));

  /* Cached input bills at half. This is the one number worth getting right
     here: the editorial system prompt is a stable 1,768-token prefix on every
     generate call, so if caching is working most of that input is cached, and
     pricing it at the full rate would overstate the total the guard acts on. */
  const usd3 = priceTextUsage({ prompt_tokens: 1e6, prompt_tokens_details: { cached_tokens: 1e6 }, completion_tokens: 0 });
  ck("cached input is half price", Math.abs(usd3 - 0.075) < 1e-9, String(usd3));

  ck("no usage block prices as null", priceTextUsage(null) === null);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
