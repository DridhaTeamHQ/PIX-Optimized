import { describeConnectionError, getPixAnalytics, isConfigured, UNCATEGORISED } from "./db.js";

/* Dates arrive as the browser's native <input type="date"> value. Anything that
   is not a real YYYY-MM-DD is dropped rather than passed to Postgres, so a
   malformed range reads as "no range" instead of erroring the whole panel.
   The shape test alone is not enough — "2025-13-45" matches it and then fails
   in the database — so the value has to survive a round trip through Date. */
function cleanDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/* Source choices are generated from stored URLs and sent back as hostnames.
   Accept only that same narrow shape on the return trip, rather than allowing
   arbitrary text to become a database filter. */
function cleanSource(value) {
  const text = String(value || "").trim().toLowerCase().replace(/^www\./, "");
  if (!text || text.length > 253 || !/^[a-z0-9.-]+$/.test(text)) return null;
  return text;
}

export async function handlePixAnalyticsRequest({ user = null, query = null }) {
  if (!isConfigured()) {
    return {
      status: 503,
      body: { error: "No database configured. Set SUPABASE_POOLER_URL to view analytics." },
    };
  }
  if (!user) {
    return { status: 401, body: { error: "Sign in to view analytics." } };
  }
  /* Two tiers, not one gate.

     QA needs to know the state of the queue they are working — how much is
     waiting, how much they have cleared. They do not need the per-writer
     roster or the reviewer league table: that is management reporting about
     colleagues, and it belongs with the admin who owns the team.

     `scope` decides how much SQL even runs, so the basic view is cheaper as
     well as narrower — the rosters are the expensive part. */
  if (user.role !== "qa" && user.role !== "admin") {
    return { status: 403, body: { error: "Analytics is available to QA and admins." } };
  }
  /* Full for both reviewer roles. This was admin-only on the reasoning that a
     per-writer roster is management reporting about colleagues — but QA is the
     role that actually works the queue, and they need to see whose posts are
     stacking up and whose are being rejected in order to do that. Withholding
     it made QA guess at exactly the thing the panel already knew.

     The role gate above still stands: writers get 403 and never reach here. */
  const scope = "full";

  let from = cleanDate(query?.get("from"));
  let to = cleanDate(query?.get("to"));
  // A backwards range would silently return nothing; read it as the range the
  // user meant rather than making them notice the order of two date pickers.
  if (from && to && from > to) [from, to] = [to, from];

  /* A DailyMattr category id, or the sentinel for posts with no section on
     them. Anything else — including a name, which an older client might send —
     is dropped rather than passed to an integer column. */
  const rawCategory = String(query?.get("category") || "").trim();
  const category = rawCategory === UNCATEGORISED ? UNCATEGORISED
    : /^\d+$/.test(rawCategory) ? rawCategory
    : null;
  const source = cleanSource(query?.get("source"));

  try {
    const analytics = await getPixAnalytics({
      role: user.role,
      scope,
      userLoginId: null,
      approverId: user.id,
      from,
      to,
      category,
      source,
    });
    return {
      status: 200,
      body: {
        role: user.role,
        // The client renders a different screen for each, so it must be told
        // which one it is looking at rather than inferring it from the role.
        scope,
        filters: {
          from,
          to,
          category: category || "all",
          source: source || "all",
          uncategorised: UNCATEGORISED,
        },
        analytics,
      },
    };
  } catch (err) {
    const message = describeConnectionError(err);
    console.warn("⚠ /api/pix-analytics failed:", message);
    return { status: 502, body: { error: message } };
  }
}
