/* ── The global spend circuit breaker ────────────────────────────────────

   What this is for. `ENHANCE_RATE_MAX` already caps AI Enhance at 40 an hour
   PER USER. With 22 active accounts that is a theoretical 880 presses an hour
   and no ceiling anywhere across the org — the per-user limiter cannot see a
   total, only its own key. This counts the total.

   It is a runaway guard, not a budget. The difference matters, because it
   decides the defaults: a budget is a number you want to spend up to, and a
   runaway guard is a number that normal work never comes near. A stuck tab, a
   retry loop, a script left pointed at the route overnight — those are what
   this stops. A reviewer working hard through a backlog must never meet it,
   and the defaults below are set well above what that reviewer can do by hand.

   It changes nothing about what the models return. Same model, same prompt,
   same parameters, same picture. The only thing it can do is refuse to start
   a call once the window's ceiling is reached, which is why it is safe to put
   in front of work whose quality is not negotiable.

   ── Reserve, then settle ──

   The obvious shape — check the total, make the call, add the cost — has a
   hole exactly where it matters. A loop firing fifty requests before any of
   them returns passes fifty checks against a total that is still zero, and
   the breaker watches the runaway it exists to stop. So a reservation is
   booked BEFORE the call at a conservative estimate, and corrected to the
   measured figure when the call returns. Overshoot is bounded by whatever is
   genuinely in flight rather than by how fast something can loop.

   ── Two windows ──

   A runaway is not always fast. A loop that fires twice a minute costs
   nothing in an hour and a lot by morning, so an hourly ceiling alone would
   let it through every single hour. The daily window is what catches the slow
   one; the hourly is what catches the fast one. A call needs room in both. */

/**
 * @param {{name: string, ms: number, capUsd: number}[]} windows
 *   Each window is a fixed bucket that resets when it expires. A cap of 0 or
 *   less disables that window — spending is still recorded, never refused.
 */
export function createSpendGuard(windows) {
  const buckets = windows.map((w) => ({ ...w, first: 0, usd: 0, calls: 0 }));
  let nextTicket = 1;
  const open = new Map(); // ticket -> { usd, at }, so settle() can correct it

  /* A reservation that is never settled is a permanent charge against every
     window it touched, and enough of them close the route for good. Every
     path SHOULD settle or release — but "should" is how a breaker ends up
     breaking the thing it protects, so anything still open long after the
     longest possible call is given back automatically.

     Five minutes is well past OPENAI_IMAGE_TIMEOUT_MS (180s), so this can
     only ever catch a genuinely abandoned ticket, never a slow one. */
  const RESERVATION_TTL_MS = 5 * 60_000;

  const roll = (b, now) => {
    if (!b.first || now - b.first > b.ms) { b.first = now; b.usd = 0; b.calls = 0; }
  };

  const add = (usd, countCall) => {
    const now = Date.now();
    for (const b of buckets) {
      roll(b, now);
      b.usd += usd;
      if (countCall) b.calls += 1;
    }
  };

  const reapStale = (now) => {
    for (const [ticket, held] of open) {
      if (now - held.at <= RESERVATION_TTL_MS) continue;
      open.delete(ticket);
      add(-held.usd, false);
      console.warn(`\u26a0 spend guard: reservation ${ticket} ($${held.usd}) was never settled \u2014 released`);
    }
  };

  return {
    /**
     * Book `estimateUsd` against every window and say whether the call may
     * start. Returns a ticket to hand to settle() or release().
     *
     * The estimate is deliberately the expensive end of what the call might
     * cost. Under-reserving is the failure that matters — it is the one that
     * lets the burst through — and settle() corrects it moments later either
     * way, so the cost of guessing high is a little pessimism for the length
     * of one call and nothing at all afterwards.
     */
    reserve(estimateUsd = 0) {
      const now = Date.now();
      reapStale(now);
      for (const b of buckets) {
        roll(b, now);
        if (b.capUsd > 0 && b.usd + estimateUsd > b.capUsd) {
          return {
            allowed: false,
            window: b.name,
            spentUsd: Number(b.usd.toFixed(4)),
            capUsd: b.capUsd,
            retryAfterSeconds: Math.max(1, Math.ceil((b.first + b.ms - now) / 1000)),
          };
        }
      }
      const ticket = nextTicket++;
      open.set(ticket, { usd: estimateUsd, at: now });
      add(estimateUsd, true);
      return { allowed: true, ticket };
    },

    /* The call returned and reported what it actually cost. Replace the
       reservation with the measured figure.

       `actualUsd` of null means the response carried no usage block. The
       reservation STAYS in that case rather than being zeroed: a model that
       stops reporting usage must not quietly switch the breaker off, and the
       estimate is the only honest number left. */
    settle(ticket, actualUsd) {
      const held = open.get(ticket);
      if (!held) return;
      open.delete(ticket);
      if (actualUsd === null || actualUsd === undefined || !Number.isFinite(actualUsd)) return;
      add(actualUsd - held.usd, false);
    },

    /* The call never billed — it threw, or OpenAI refused it. Give the
       reservation back so a run of failures cannot lock the route out. */
    release(ticket) {
      const held = open.get(ticket);
      if (!held) return;
      open.delete(ticket);
      add(-held.usd, false);
      for (const b of buckets) b.calls = Math.max(0, b.calls - 1);
    },

    /* Spending that is metered but not gated — the text calls. They are ~600×
       cheaper per call than an image edit, so refusing one saves a fraction of
       a cent while stopping a writer mid-story. They belong in the total so
       the total is true; they do not belong behind the gate. */
    recordUngated(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      add(usd, true);
    },

    /* For /health. Read-only, safe to expose: it is this box's own spend, not
       the account's, and it carries no key material. */
    snapshot() {
      const now = Date.now();
      reapStale(now);
      const out = {};
      for (const b of buckets) {
        roll(b, now);
        out[b.name] = {
          spentUsd: Number(b.usd.toFixed(4)),
          capUsd: b.capUsd > 0 ? b.capUsd : null,
          calls: b.calls,
          windowResetsInSeconds: b.first ? Math.max(0, Math.ceil((b.first + b.ms - now) / 1000)) : 0,
        };
      }
      out.inFlight = open.size;
      return out;
    },
  };
}

/* Per-1M-token rates for the text models this app calls, so a chat completion
   can be priced from the usage block it already returns. Overridable for the
   same reason the image rates are: OpenAI can change them without the code
   noticing, and a stale constant here would quietly understate the total.

   Only gpt-4o-mini is listed because it is the only text model this codebase
   calls — every chat/responses site is hardcoded to it. An unknown model
   prices at the mini rate rather than at zero: wrong by some factor is
   recoverable, silently free is not. */
export function priceTextUsage(usage, rates = {}) {
  if (!usage) return null;
  const inRate = Number(rates.in ?? 0.15);
  const outRate = Number(rates.out ?? 0.60);
  const cachedRate = Number(rates.cached ?? inRate / 2);

  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  const promptAll = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const fresh = Math.max(0, promptAll - cached);
  const out = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);

  const usd = (fresh * inRate + cached * cachedRate + out * outRate) / 1e6;
  return Number.isFinite(usd) ? usd : null;
}
