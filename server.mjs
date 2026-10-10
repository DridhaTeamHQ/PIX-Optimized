import http from "node:http";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { TwitterApi } from "twitter-api-v2";
import Busboy from "busboy";
import {
  suggestRegister, registerRules, assessTone, rectifyInstruction,
} from "./lib/editorial-tone.js";
import {
  configureDb, isConfigured as dbConfigured, ping as dbPing,
  getPix, setApproval,
  claimPublish, recordPublishedId, recordPublishAttempt, releasePublishClaim, readQuery,
  recordWebPages,
} from "./lib/db.js";
import {
  SESSION_COOKIE, parseCookies, sessionCookie, clearedSessionCookie,
  login, logout, sessionUser, purgeExpiredSessions,
  throttleCheck, throttleRecordFailure, throttleClear, createRateLimiter,
  ROLES, canReview, createUser, listUsers, setPassword, setUserActive, normaliseUsername, isAdmin, updateUser, deleteUser,
} from "./lib/auth.js";
import { handlePixRequest } from "./lib/pix-api.js";
import { createSpendGuard, priceTextUsage } from "./lib/spend-guard.js";
import { handlePixAnalyticsRequest } from "./lib/pix-analytics.js";
import {
  configureStorage, isStorageConfigured, uploadMedia, pingStorage,
  createSignedUploadUrl, statMedia, deleteMedia,
} from "./lib/storage.js";
import { copyCardsToWeb } from "./lib/web-cards.js";
import {
  fetchDailyMattrMeta, getDailyMattrConfig, publishDailyMattrBuzzContent,
} from "./lib/dailymattr.js";
import {
  ScrapeValidationError, fetchPublicHtml, fetchPublicImage, parseScrapeArticleResult, parseScrapeRequest,
} from "./lib/scrape-security.js";
import {
  extractBestArticleImage,
  upgradeImageToHighestQuality as upgradeScrapedImage,
} from "./lib/scrape.js";

const root = join(process.cwd(), "public");
const port = Number(process.env.PORT || 3000);
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const TEXT_DETAIL_CHAR_LIMIT = 500;

function readSecrets() {
  // Try reading .env as JSON from project dir or parent dir
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", ".env")
  ];
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf-8").trim();
        // Support JSON format: { "pexelsApiKey": "..." }
        if (raw.startsWith("{")) return JSON.parse(raw);
        // Support KEY=VALUE format
        const obj = {};
        for (const line of raw.split("\n")) {
          const match = line.match(/^\s*([A-Za-z_]+)\s*[:=]\s*"?([^"]*)"?\s*$/);
          if (match) obj[match[1]] = match[2];
        }
        return obj;
      }
    } catch { /* ignore */ }
  }
  return {};
}

const secrets = readSecrets();

/**
 * Read a secret from the environment, defensively.
 *
 * Pasting into a hosting dashboard very easily carries a trailing newline, a
 * stray space, or the surrounding quotes from a .env line. Any of those goes
 * straight into an Authorization header and the provider answers 401 — which
 * reads as "my key is wrong" when the key is fine. Strip them here so a
 * cosmetic paste error can't masquerade as a bad credential.
 */
function env(name, ...aliases) {
  for (const key of [name, ...aliases]) {
    const raw = process.env[key] ?? secrets[key];
    if (raw == null) continue;
    const cleaned = String(raw).trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

/* ── Every outbound call gets a deadline ─────────────────────────────────
   fetch() has no default timeout. A request that never answers never
   rejects, so the handler awaiting it never returns and the Railway worker
   that was serving it is held until the platform reaps the whole request —
   which on a small plan is a meaningful share of the capacity, taken out by
   one slow upstream.

   Two ceilings, because the two kinds of call are not comparable: a chat
   completion that has not answered in a minute is not going to, while image
   generation legitimately runs 30-90 seconds and is given three.

   The AbortError is translated on the way out. "The operation was aborted"
   in a log tells whoever is reading it nothing about which call, or that a
   deadline rather than a fault is what happened. */
const OPENAI_TEXT_TIMEOUT_MS = Number(env("OPENAI_TEXT_TIMEOUT_MS") || 60_000);
const OPENAI_IMAGE_TIMEOUT_MS = Number(env("OPENAI_IMAGE_TIMEOUT_MS") || 180_000);

async function fetchWithDeadline(url, options = {}, ms = OPENAI_TEXT_TIMEOUT_MS, label = "request") {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      const e = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      e.status = 504;
      e.timedOut = true;
      throw e;
    }
    throw err;
  }
}

function dailyMattrConfig() {
  return getDailyMattrConfig({
    DAILYMATTR_BASE_URL: env("DAILYMATTR_BASE_URL", "DAILYMATTR_API_BASE_URL"),
    DAILYMATTR_API_KEY: env("DAILYMATTR_API_KEY"),
    DAILYMATTR_EMAIL: env("DAILYMATTR_EMAIL", "DAILYMATTR_USERNAME"),
    DAILYMATTR_PASSWORD: env("DAILYMATTR_PASSWORD"),
  });
}

// Warn loudly if a value needed cleaning — otherwise this silently papers
// over a misconfiguration the user should fix at the source.
for (const name of ["OPENAI_API_KEY", "UPSCALER_SECRET", "PEXELS_API_KEY", "FAL_KEY"]) {
  const raw = process.env[name] ?? secrets[name];
  if (raw != null && String(raw) !== env(name)) {
    console.warn(`⚠ ${name} had surrounding whitespace or quotes — trimmed. Fix it in the dashboard.`);
  }
}
const pexelsApiKey = env("PEXELS_API_KEY", "pexelsApiKey");
if (pexelsApiKey) {
  console.log(`✓ Pexels API key loaded (${pexelsApiKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ No Pexels API key found. Stock images will not work.");
  console.warn("  Checked: .env in project dir and parent dir, or PEXELS_API_KEY env var.");
}

/* ── Supabase Postgres (saved pix library) ──
   Optional. Without it every /api/pix call answers 503 and the editor simply
   never saves — nothing else changes. The connection is verified in the
   background so a slow or unreachable database cannot delay the listen(). */
configureDb(env("SUPABASE_POOLER_URL", "SUPABASE_DIRECT_CONNECTION_URL", "DATABASE_URL", "SUPABASE_DB_URL"));
if (dbConfigured()) {
  dbPing().then((r) => {
    if (r.ok) console.log("✓ Supabase Postgres connected — posts will be saved to pix_posts");
    else console.warn(`⚠ Supabase Postgres unreachable: ${r.error}`);
  });
} else {
  console.warn("⚠ No SUPABASE_DIRECT_CONNECTION_URL — scraped posts will not be saved.");
}

/* ── Supabase Storage (uploaded images and video) ──
   Without it, uploads still work in the editor but cannot be saved: a data:
   URL has no address to put in a row. /api/media then answers 503 and the
   post is stored with everything except its image. */
configureStorage({
  url: env("SUPABASE_URL"),
  serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"),
});
if (isStorageConfigured()) {
  pingStorage().then((r) => {
    if (r.ok) console.log(`✓ Supabase Storage ready (buckets: ${r.buckets.join(", ") || "none yet"})`);
    else console.warn(`⚠ Supabase Storage unreachable: ${r.error}`);
  });
} else {
  console.warn("⚠ No SUPABASE_SERVICE_ROLE_KEY — uploaded images and videos will not be saved.");
}

/* ── Twitter / X (OAuth 1.0a) ── */
const twitterCfg = {
  appKey:       env("TWITTER_API_KEY"),
  appSecret:    env("TWITTER_API_SECRET"),
  accessToken:  env("TWITTER_ACCESS_TOKEN"),
  accessSecret: env("TWITTER_ACCESS_SECRET"),
};
const twitterClient = (twitterCfg.appKey && twitterCfg.accessToken)
  ? new TwitterApi(twitterCfg)
  : null;
if (twitterClient) {
  console.log(`✓ Twitter API ready (key ${twitterCfg.appKey.slice(0, 6)}…)`);
} else {
  console.warn("⚠ Twitter keys missing — /api/twitter/post will return 503.");
}

/* ── OpenAI (for AI tweet captions) ── */
// Enhance routing. There is no free path: the self-hosted upscaler and the
// local resampler were both deleted in 4376ef6, so gpt-image is the only
// engine and every press is billed. DISABLE_GPT_IMAGE is now the only way to
// stop the route spending money — it makes the route a hard 503 rather than
// a silent fallback.
const gptImageDisabled = /^(1|true|yes)$/i.test(env("DISABLE_GPT_IMAGE"));

/* Read the quality actually in force rather than hardcoding a figure. It is
   the difference between ~$0.016 and ~$0.25 a click, and a fixed number in a
   log line goes stale the moment someone edits the variable — which is how
   you end up reassured by a message that is quietly wrong. */
function enhanceCostLabel() {
  const q = (process.env.IMAGE_QUALITY || "medium").toLowerCase();
  const rq = (process.env.IMAGE_QUALITY_REFRAME || "high").toLowerCase();
  // Measured, not the price-table figure: input_fidelity=high bills the
  // uploaded photograph (~6.5k image tokens) on top of the output.
  const rper = { low: "~$0.02", medium: "~$0.12", high: "~$0.33" }[rq] || "cost unknown";
  if (rq !== q) return `restore quality=${q}, reframe quality=${rq} (${rper} each)`;
  // gpt-image-1.5 list price at the portrait/landscape shapes this route asks
  // for (1024x1536 / 1536x1024). Square is cheaper; these are the figures that
  // matter because sizeForRatio() follows the source and rarely returns square.
  const per = { low: "~$0.013", medium: "~$0.05", high: "~$0.20" }[q] || "cost unknown";
  return `quality=${q}, ${per} each`;
}
/* ── The model ladder ──────────────────────────────────────────────────────

   The route runs on gpt-image-1.5, falling back to gpt-image-1 for an account
   that does not have it. That is the whole ladder, deliberately: one model
   family, one parameter set, one kind of picture.

   It is worth writing down that both rungs are on OpenAI's deprecations page
   with a shutdown date of 1 Dec 2026. Nothing here needs to act on that today
   and nothing here does — but the date is real, and when it arrives this route
   returns 502 on every press until a newer model is put in.

   Which is why the ids are read from the environment rather than written into
   the call. It costs two lines and it is the difference between that day being
   a variable edit on the host and an emergency deploy. Set IMAGE_MODEL to
   change what runs; the boot log states what it resolved to, and the `engine`
   field of every response says which rung actually served. */
/* One model, and only this one.

   gpt-image-1.5 — default snapshot gpt-image-1.5-2025-12-16. OpenAI's model
   page lists v1/images/edits as supported and exactly three output sizes,
   1024x1024 / 1024x1536 / 1536x1024, so 1536 on the long edge is the MODEL's
   ceiling and not a choice made here.

   No second rung. A fallback meant a press could be served by a different
   model and reported as this one. */
const IMAGE_MODEL_PRIMARY = process.env.IMAGE_MODEL || "gpt-image-1.5";

if (gptImageDisabled) {
  console.log("Restore & Upscale is switched off (DISABLE_GPT_IMAGE).");
} else {
  console.log(`Restore & Upscale: ${IMAGE_MODEL_PRIMARY} only (` + enhanceCostLabel() + `). No other model is called.`);
}

const openaiApiKey = env("OPENAI_API_KEY");
if (openaiApiKey) {
  // Log a fingerprint, never the key. Prefix + length + last 4 is enough to
  // tell "the wrong key is deployed" apart from "the key is revoked" without
  // putting a live credential in the logs.
  const shape = `${openaiApiKey.slice(0, 8)}…${openaiApiKey.slice(-4)} len=${openaiApiKey.length}`;
  console.log(`✓ OpenAI API key loaded (${shape})`);
  if (!/^sk-[A-Za-z0-9_-]+$/.test(openaiApiKey)) {
    console.warn("⚠ OPENAI_API_KEY doesn't look like an OpenAI key (expected sk-… with no spaces).");
  }
} else {
  console.warn("⚠ OPENAI_API_KEY missing — AI features will return 503.");
}

const STOPWORDS = new Set([
  "THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS", "WILL", "WOULD", "SHOULD", "COULD",
  "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT", "UNDER", "OVER", "INTO", "ONTO", "WITHIN", "WITHOUT", "THROUGH",
  "THEIR", "THEY", "THEM", "THERE", "THEN", "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "BEING",
  "MORE", "MOST", "VERY", "JUST", "ONLY", "ALSO", "NEWS", "LIVE", "BBC", "NEW", "SOME", "SUCH", "YOUR", "OUR",
  "AGAINST", "DURING", "WHILE", "WHERE", "WHEN", "WHAT", "WHICH", "WHO", "WHOM", "WHY", "HOW"
]);


const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

/* ── Asset versioning ──
   index.html referenced "./app.js" with no version. That is fine while the
   server sends cache headers, but anything cached BEFORE those headers
   existed was stored with no Cache-Control and no Last-Modified at all, and
   browsers cache such responses heuristically — they can serve them for days
   without ever revalidating. Those users silently run an old app.js against
   a new index.html and simply never receive new features.

   Stamping the URL with a hash of the file's own mtime+size means a changed
   asset is a changed URL, which no cache can satisfy from an old entry. */
function assetVersion(...relPaths) {
  let sig = "";
  for (const rel of relPaths) {
    try {
      const st = statSync(join(root, rel));
      sig += `${rel}:${st.mtimeMs}:${st.size};`;
    } catch { /* missing asset — fall through to a stable default */ }
  }
  return createHash("sha1").update(sig).digest("hex").slice(0, 8);
}

// Computed once per process. The files cannot change under a running
// container, and `node --watch` restarts the process on edit in dev.
const ASSET_V = assetVersion("app.js", "styles.css");
const assetMtimeMs = ["app.js", "styles.css"].reduce((newest, rel) => {
  try { return Math.max(newest, statSync(join(root, rel)).mtimeMs); } catch { return newest; }
}, 0);
console.log(`\u2713 asset version ${ASSET_V}`);

function withAssetVersion(html) {
  return html
    .replace(/(<script[^>]+src=")\.\/app\.js(")/g, `$1./app.js?v=${ASSET_V}$2`)
    .replace(/(<link[^>]+href=")\.\/styles\.css(")/g, `$1./styles.css?v=${ASSET_V}$2`);
}

/* ── Who may call /api/* ──
   The only thing that used to stand between the open internet and
   OPENAI_API_KEY, FAL_KEY, the upscaler and yt-dlp was the browser's login
   screen — and curl does not run app.js. The reasoning was already written
   down for the media upload ("an open upload endpoint backed by that key is a
   free file host for anyone who finds it") but never applied to the routes
   that spend money: /api/generate-article, /api/generate-caption,
   /api/analyze-image, /api/flux-image, /api/upscale-image, /api/stock-images
   and /api/google-images all bill a third party per call, /api/video/clip
   spawns yt-dlp and ffmpeg per call, and /api/twitter/post writes to the org's
   X account. Anyone who knew the hostname could run any of them.

   The check lives here rather than in fourteen handlers so it is deny-by-
   default: a route added later is protected before its author thinks about
   auth, and forgetting to allowlist something surfaces as a 401 in
   development instead of as a bill. Handlers that already do their own
   currentUser() check keep it — it costs nothing (the lookup is memoised per
   request) and states each route's own rule where a reader will look for it.

   Only /api/* is matched. /health and /healthz must answer for the platform
   healthcheck — Railway fails the deploy if that path 401s — and every static
   asset must stay open or the browser cannot fetch the login page it needs in
   order to get a session at all. Neither is /api/*, so neither is touched. */
const PUBLIC_API_ROUTES = new Set([
  // How a session is obtained; gating it would make signing in impossible.
  "/api/auth/login",
  // Must work with a dead or already-expired session, otherwise a user
  // holding a stale cookie has no way to clear it.
  "/api/auth/logout",
  // The boot probe (app.js initAuth). It answers its own 401 when signed out
  // and a 503 when the database is unreachable, and the login screen tells
  // those two apart — a blanket 401 here would report an outage as "sign in".
  "/api/auth/me",
]);

/* ── Routes only a reviewer may spend money on ──
   AI Enhance bills gpt-image per call, and it used to be offered to everyone
   who could open the editor. That meant the bill was driven by how many posts
   were WRITTEN, when the only enhanced image that ever reaches DailyMattr is
   one on a post that was approved — every enhance on a story that was later
   rejected, or rewritten, or enhanced twice while the writer compared results,
   was paid for and thrown away.

   Moving it behind the review gate ties the spend to what actually ships.
   Enforced here and not only by hiding the button: the button is a courtesy,
   this is the control. A writer's session posting straight to the endpoint —
   by habit, by a stale tab, or by curl — is refused. */
const REVIEWER_ONLY_API_ROUTES = new Set([
  "/api/upscale-image",
]);

const server = http.createServer(async (req, res) => {
  /* Compare the path alone. Most of these routes carry their arguments in the
     query string and are matched with startsWith() below (/api/image?url=…,
     /api/flux-image?query=…), so testing req.url against the allowlist would
     miss every one of them. */
  const apiPath = req.url?.split("?")[0] || "";
  if (apiPath.startsWith("/api/") && !PUBLIC_API_ROUTES.has(apiPath)) {
    const user = await currentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Sign in to use PIXIE." });
      return;
    }
    // 403, not 401: the session is fine, the role is not. Reporting this as
    // "sign in" would send a writer round the login screen forever.
    if (REVIEWER_ONLY_API_ROUTES.has(apiPath) && !canReview(user.role)) {
      sendJson(res, 403, {
        error: "AI Enhance is done by QA at review time — save the post with the image as it is.",
      });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/api/scrape") {
    await handleScrape(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/scrape-article") {
    await handleScrapeArticle(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/image?")) {
    await handleImageProxy(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/auth/login") {
    await handleLogin(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/auth/logout") {
    await handleLogout(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/auth/me") {
    await handleMe(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/video/resolve") {
    await handleVideoResolve(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/video/preview?")) {
    await handleVideoPreview(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/video/clip") {
    await handleVideoClip(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/stock-images?")) {
    await handleStockImages(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/google-images?")) {
    await handleGoogleImages(req, res);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/flux-image?")) {
    await handleFluxImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/analyze-image") {
    await handleAnalyzeImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/twitter/post") {
    await handleTwitterPost(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-caption") {
    await handleGenerateCaption(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-article") {
    await handleGenerateArticle(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/upscale-image") {
    await handleUpscaleImage(req, res);
    return;
  }

  /* Collecting the picture that call just made. Under /api/, so the gate
     above has already required a session; the token in the path is what
     narrows that to the one reviewer who paid for this particular picture.
     Not in REVIEWER_ONLY_API_ROUTES because that Set matches whole paths and
     this one ends in a UUID — and there is nothing to spend here anyway. */
  if (req.method === "GET" && req.url?.startsWith(`${ENHANCE_RESULT_PATH}/`)) {
    handleEnhanceResult(req, res);
    return;
  }

  /* Direct-to-Storage upload. /api/media/sign hands the browser a one-shot
     URL, the browser sends the bytes straight to Supabase, and
     /api/media/confirm verifies the object arrived before any post is allowed
     to reference it. The bytes never touch this container. */
  /* Removing an object from the bucket. Admin only, and refused outright for
     anything a post still points at. */
  if (req.method === "POST" && req.url?.startsWith("/api/media/cleanup")) {
    await handleMediaCleanup(req, res);
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/api/media")) {
    await handleMediaDelete(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/media/sign") {
    await handleMediaSign(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/media/confirm") {
    await handleMediaConfirm(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/media") {
    await handleMediaUpload(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/dailymattr/meta") {
    await handleDailyMattrMeta(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/dailymattr/publish") {
    await handleDailyMattrPublish(req, res);
    return;
  }

  // Matched on the path alone — the analytics filters ride in the query string.
  if (req.method === "GET" && req.url?.split("?")[0] === "/api/pix-analytics") {
    await handlePixAnalytics(req, res);
    return;
  }

  if (req.url?.startsWith("/api/users")) {
    await handleUsers(req, res);
    return;
  }

  if (req.url?.startsWith("/api/pix")) {
    await handlePix(req, res);
    return;
  }

  // Railway (and any other platform healthcheck) pings this.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      features: {
        openai: Boolean(env("OPENAI_API_KEY")),
        gptImageFallback: !gptImageDisabled,
        // Video works when both binaries are on PATH; cookies are what make
        // YouTube reliable from a datacenter IP.
        ffmpeg: Boolean(ffmpegAvailable),
        ytdlp: Boolean(ytdlpAvailable),
        ytdlpCookies: Boolean(cookieFilePath),
        jsRuntime: Boolean(jsRuntimeAvailable),
        ytdlpProxy: Boolean(ytdlpProxy),
        pexels: Boolean(pexelsApiKey),
        database: dbConfigured(),
        storage: isStorageConfigured(),
      },
      /* What this box has spent since it booted, against the ceilings in
         force. Here because the alternative is reading Railway logs: the
         per-call figures were already measured and logged, but nothing added
         them up anywhere you could look. A number you can curl is the
         difference between noticing a runaway and hearing about it from the
         billing page a week later. */
      spend: spendGuard.snapshot(),
    });
    return;
  }

  // Static file serving — URL-decode so paths with %20 (spaces) etc. resolve.
  let urlPath = req.url === "/" ? "/index.html" : req.url;
  // Drop any query string before disk lookup
  const qIdx = urlPath.indexOf("?");
  if (qIdx >= 0) urlPath = urlPath.slice(0, qIdx);
  try { urlPath = decodeURIComponent(urlPath); } catch { /* leave as-is */ }
  const safePath = normalize(urlPath).replace(/^([.][.][/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  // ── Caching ──
  // On Vercel the CDN handled this. Serving directly, we have to: without
  // it every page load re-downloads app.js (~180 KB) and the logos.
  //
  // Assets that carry no content hash (app.js, styles.css, index.html) get
  // `no-cache`, which means "revalidate every time" — NOT "don't store".
  // Combined with Last-Modified the browser sends If-Modified-Since and we
  // answer 304 with an empty body: the bytes are saved, and a deploy can
  // never serve stale code. Images and fonts are immutable in practice and
  // get a real max-age.
  const stat = statSync(filePath);
  const ext = extname(filePath).toLowerCase();

  // For HTML the response also depends on ASSET_V, which tracks app.js and
  // styles.css. Validating on index.html's own mtime alone would return 304
  // after a JS-only change, leaving the client on cached HTML that still
  // points at the previous asset URL — the exact staleness this is meant to
  // prevent. Advertise the newest mtime of the three instead.
  const mtimeMs = ext === ".html" ? Math.max(stat.mtimeMs, assetMtimeMs) : stat.mtimeMs;
  const lastModified = new Date(mtimeMs).toUTCString();

  const ims = req.headers["if-modified-since"];
  if (ims && Date.parse(ims) >= Math.floor(mtimeMs / 1000) * 1000) {
    res.writeHead(304, { "Last-Modified": lastModified });
    res.end();
    return;
  }

  const immutable = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2"];
  const cacheControl = immutable.includes(ext)
    ? "public, max-age=86400"
    : "no-cache";

  // HTML is rewritten in flight to carry the asset version, so its length
  // differs from the file on disk — read it rather than streaming.
  if (ext === ".html") {
    const body = Buffer.from(withAssetVersion(readFileSync(filePath, "utf-8")), "utf-8");
    res.writeHead(200, {
      "Content-Type": types[ext],
      "Content-Length": body.length,
      "Last-Modified": lastModified,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Last-Modified": lastModified,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`PIXIE running at http://localhost:${port}`);
});

// Railway sends SIGTERM on redeploy. Without this the process is killed
// outright and in-flight requests (a 5-minute AI enhance, say) die with it.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`${signal} received — finishing in-flight requests…`);
    server.close(() => process.exit(0));
    // Don't hang forever if a client keeps the socket open.
    setTimeout(() => process.exit(0), 15000).unref();
  });
}

/* ── Web Image Search (multi-source, high quality) ── */

// Strip CDN resize parameters to get original full-resolution images
function upgradeImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);

    // Cloudinary: remove transformation path segments
    if (u.hostname.includes("cloudinary.com") || u.hostname.includes("res.cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/c_\w+,[^/]+/g, "").replace(/\/w_\d+[^/]*/g, "").replace(/\/h_\d+[^/]*/g, "");
      return u.toString();
    }

    // imgix: remove resize params, set high quality
    if (u.hostname.includes("imgix.net")) {
      u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      u.searchParams.set("q", "100");
      return u.toString();
    }

    // WordPress/Jetpack: strip resize params
    if (u.searchParams.has("resize") || u.searchParams.has("w") || u.searchParams.has("fit")) {
      u.searchParams.delete("resize"); u.searchParams.delete("w"); u.searchParams.delete("h");
      u.searchParams.delete("fit"); u.searchParams.delete("crop");
      return u.toString();
    }

    // Generic: remove common resize params
    for (const key of ["width", "height", "w", "h", "quality", "q", "resize", "size", "maxwidth", "maxheight"]) {
      u.searchParams.delete(key);
    }

    // YouTube: upgrade to maxresdefault
    if (u.hostname.includes("ytimg.com") && u.pathname.includes("hqdefault")) {
      return imageUrl.replace("hqdefault", "maxresdefault");
    }

    return u.toString();
  } catch {
    return imageUrl;
  }
}

// Skip low-quality URLs (favicons, icons, tiny thumbnails)
function isLikelyHighQuality(url) {
  const lower = url.toLowerCase();
  if (lower.includes("favicon")) return false;
  if (lower.includes("/icon")) return false;
  if (lower.match(/\b(16|24|32|48|64|72|96)x\1\b/)) return false;
  if (lower.includes("thumbnail") && !lower.includes("maxresdefault")) return false;
  if (lower.includes("logo") && !lower.includes("article")) return false;
  return true;
}

async function handleGoogleImages(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    if (!query) {
      sendJson(res, 400, { error: "A search query is required." });
      return;
    }

    let images = [];

    // Source 1: Bing (cloud-friendly)
    images = await tryBingImages(query, 8);

    // Source 2: Google (fallback — works locally, may be blocked on cloud)
    if (!images.length) {
      images = await tryGoogleImages(query, 8);
    }

    // Source 3: DuckDuckGo (last resort)
    if (!images.length) {
      images = await tryDuckDuckGoImages(query, 8);
    }

    sendJson(res, 200, { images, source: images.length ? "web" : "none" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image search failed." });
  }
}


/* ═══════════════════════ Slide 2 video (yt-dlp + ffmpeg) ═══════════════════════

   Runs in-process rather than as a separate service. The split used to exist
   because Vercel caps serverless request bodies at 4.5 MB, so a 20-200 MB
   video upload could never transit a function — the browser had to POST
   straight to a second host, which needed a shared secret, HMAC tokens and
   CORS. On Railway that cap doesn't exist, so all of that is gone: these are
   ordinary same-origin routes.

   Branding is NOT drawn here. The browser renders the exact overlay it shows
   in the live preview to a transparent PNG and uploads it alongside the clip;
   ffmpeg only composites. That keeps fonts and layout identical to what the
   user approved on screen, and means design changes never touch this file.

   Env:
     YTDLP_COOKIES     base64 Netscape cookies.txt — required for YouTube from
                       a datacenter IP, and for most of Instagram
     MAX_CLIP_SECONDS  output length cap (default 90)
     MAX_UPLOAD_BYTES  local upload cap (default 300 MB)
*/

const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 90);
const MAX_VIDEO_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const RESOLVE_TIMEOUT_MS = 60_000;
const CLIP_TIMEOUT_MS = 600_000;

// Railway's variable UI is single-line, so the cookies file is passed base64.
// Written once at startup; yt-dlp reads it from disk.
const COOKIE_FILE = join(tmpdir(), "pix-ytdlp-cookies.txt");
const cookieFilePath = (() => {
  const raw = (env("YTDLP_COOKIES")).trim();
  if (!raw) return "";
  try {
    // Accept either base64 or the file pasted verbatim.
    const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(raw) && !raw.includes("\t");
    const data = looksBase64 ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf-8");
    if (data.length < 20) return "";
    writeFileSync(COOKIE_FILE, data);
    return COOKIE_FILE;
  } catch {
    return "";
  }
})();

if (cookieFilePath) {
  console.log("✓ yt-dlp cookies loaded");
} else {
  console.warn("⚠ No YTDLP_COOKIES — YouTube may bot-check this server and Instagram will mostly fail.");
}

// Probe the two binaries once at startup so /health can report a misbuilt
// image directly, instead of every export failing with a confusing ENOENT.
/* yt-dlp needs a JavaScript runtime to solve YouTube's challenge. The Docker
   image puts deno on PATH; locally it is more polite to keep a copy in
   ./.bin than to modify the developer's PATH, so point yt-dlp at it
   explicitly when that copy exists. Without a runtime, the web-based player
   clients fail outright and cookies make extraction worse rather than
   better. */
const LOCAL_DENO = (() => {
  for (const name of ["deno.exe", "deno"]) {
    const p = join(process.cwd(), ".bin", name);
    if (existsSync(p)) return p;
  }
  return "";
})();
if (LOCAL_DENO) console.log("✓ using local deno at .bin");

// Declared BEFORE the availability probe below: that probe runs during
// module evaluation, so a const declared further down is still in its
// temporal dead zone when the probe reads it. The throw happened inside
// an async IIFE, so it surfaced as a late unhandled rejection rather than
// a clean startup error, which made it look unrelated to this line.
let ffmpegAvailable = false;
let ytdlpAvailable = false;
let jsRuntimeAvailable = false;
(async () => {
  const [ff, yt, deno] = await Promise.all([
    run("ffmpeg", ["-version"], 10_000),
    run("yt-dlp", ["--version"], 10_000),
    run(LOCAL_DENO || "deno", ["--version"], 10_000),
  ]);
  ffmpegAvailable = ff.code === 0;
  ytdlpAvailable = yt.code === 0;
  jsRuntimeAvailable = deno.code === 0;

  if (ffmpegAvailable && ytdlpAvailable) {
    console.log(`✓ Video ready (yt-dlp ${yt.stdout.toString().trim()})`);
  } else {
    if (!ffmpegAvailable) console.warn("⚠ ffmpeg not found — video export will fail.");
    if (!ytdlpAvailable) console.warn("⚠ yt-dlp not found — link fetching will fail.");
  }

  // This combination is a trap, so it gets its own warning.
  //
  // Authenticated YouTube requests are served formats whose URLs must be
  // deciphered by running YouTube's JavaScript. Anonymous requests get
  // simpler ones. So without a JS runtime, adding cookies makes extraction
  // FAIL where it previously worked: measured locally, android_vr resolves
  // fine with no cookies and fails with "Requested format is not available"
  // once cookies are supplied. Cookies and deno are a package deal.
  if (!jsRuntimeAvailable) {
    if (cookieFilePath) {
      console.warn(
        "⚠ YTDLP_COOKIES is set but no JS runtime (deno) was found. Authenticated " +
        "YouTube extraction REQUIRES one — every fetch will fail with \"Requested " +
        "format is not available\". Deploy the current Dockerfile, or unset YTDLP_COOKIES."
      );
    } else {
      console.warn("⚠ No JS runtime (deno) — YouTube extraction is limited and cookies will not work.");
    }
  }
})();

/* ── YouTube client fallback ──
   YouTube bot-checks datacenter IPs, which is what any cloud host is. Which
   "player client" yt-dlp impersonates changes how often that happens, and no
   single one is reliable — so rather than failing on the first block, try a
   ladder. Cookies remain the dependable fix, but this clears a good share of
   requests without them.

   The empty first entry is yt-dlp's own default (currently android_vr-led),
   which is fastest when it works. android_vr and tv_embedded are the two
   clients that need no JS challenge, so they still work even if the deno
   runtime is missing from the image. */
const YOUTUBE_CLIENT_LADDER = ["", "android_vr", "tv_embedded", "web_safari", "mweb"];

/* A proxy is the only thing that actually fixes the root cause. YouTube
   blocks by IP reputation, and every cloud host — Railway included — sits in
   a flagged datacenter range. Cookies work around it by proving there's an
   account behind the request; a residential proxy removes the reason for the
   challenge in the first place, with nothing to expire and no account to
   ban. Accepts any yt-dlp proxy URL:
     http://user:pass@host:port   socks5://user:pass@host:port          */
const ytdlpProxy = env("YTDLP_PROXY");
if (ytdlpProxy) {
  // Never log the proxy URL itself — it usually carries credentials.
  let host = "configured";
  try { host = new URL(ytdlpProxy).host.replace(/^.*@/, ""); } catch { /* keep generic */ }
  console.log(`✓ yt-dlp proxy enabled (${host})`);
}


function ytdlpArgs(extra, client = "") {
  const base = ["--no-playlist", "--no-warnings"];
  if (LOCAL_DENO) base.push("--js-runtimes", `deno:${LOCAL_DENO}`);
  if (ytdlpProxy) base.push("--proxy", ytdlpProxy);
  if (cookieFilePath) base.push("--cookies", cookieFilePath);
  if (client) base.push("--extractor-args", `youtube:player_client=${client}`);
  return base.concat(extra);
}

// Only bot-checks and format-availability failures are worth another client;
// a private or deleted video will fail identically every time, and retrying
// just burns a minute.
function worthRetryingWithAnotherClient(stderr) {
  const low = String(stderr || "").toLowerCase();
  return low.includes("sign in to confirm")
      || low.includes("not a bot")
      || low.includes("requested format is not available")
      || low.includes("failed to extract")
      || low.includes("unable to extract")
      || low.includes("http error 403")
      || low.includes("http error 429");
}

/**
 * Run yt-dlp, walking the client ladder while the failure looks like a
 * block rather than a genuinely missing video. Non-YouTube URLs get one
 * attempt — the player_client arg means nothing to other extractors.
 */
async function runYtdlp(extra, timeoutMs) {
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(extra.join(" "));
  const ladder = isYouTube ? YOUTUBE_CLIENT_LADDER : [""];
  let last = null;

  for (const client of ladder) {
    const r = await run("yt-dlp", ytdlpArgs(extra, client), timeoutMs);
    if (r.code === 0) {
      if (client) console.log(`✓ yt-dlp succeeded with player_client=${client}`);
      return r;
    }
    last = r;
    if (r.timedOut) break;
    if (!worthRetryingWithAnotherClient(r.stderr || r.stdout)) break;
    if (client !== ladder[ladder.length - 1]) {
      console.warn(`⚠ yt-dlp blocked on client "${client || "default"}" — trying the next one`);
    }
  }
  return last;
}

// Spawn a binary, capture stdout/stderr, enforce a wall-clock timeout.
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err.message)) });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);

    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(e.message)) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

// yt-dlp's stderr is a wall of text; turn the known failures into something
// the user can actually act on.
function friendlyYtdlpError(stderr) {
  const text = String(stderr || "");
  const low = text.toLowerCase();
  if (low.includes("sign in to confirm") || low.includes("not a bot")) {
    return "YouTube blocked this server as automated — cloud IPs are flagged by default. " +
           "Fix it with YTDLP_COOKIES (cookies from a throwaway logged-in account) or " +
           "YTDLP_PROXY (a residential proxy). Uploading a file works either way.";
  }
  if (low.includes("login required") || low.includes("requested content is not available")) {
    return "This content requires a login. Set YTDLP_COOKIES with cookies from an account that can view it.";
  }
  if (low.includes("private video")) return "That video is private.";
  if (low.includes("video unavailable") || low.includes("removed")) return "That video is unavailable or has been removed.";
  if (low.includes("unsupported url")) return "That link isn't a supported video URL.";
  if (low.includes("rate-limit") || low.includes("429")) return "The source is rate-limiting this server. Try again in a few minutes.";
  if (low.includes("enoent")) return "yt-dlp is not installed on this server.";
  const lines = text.trim().split("\n").filter(Boolean);
  return (lines[lines.length - 1] || "Download failed.").slice(0, 300);
}

async function handleVideoResolve(req, res) {
  try {
    const body = await readJson(req);
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      sendJson(res, 400, { error: "A http(s) URL is required." });
      return;
    }

    const r = await runYtdlp(["--dump-single-json", "--skip-download", url], RESOLVE_TIMEOUT_MS);
    if (r.timedOut) { sendJson(res, 504, { error: "Resolving the video timed out." }); return; }
    if (r.code !== 0) { sendJson(res, 502, { error: friendlyYtdlpError(r.stderr || r.stdout) }); return; }

    let info;
    try {
      info = JSON.parse(r.stdout.toString("utf-8"));
    } catch {
      sendJson(res, 502, { error: "Could not parse video metadata." });
      return;
    }

    sendJson(res, 200, {
      title: info.title || "",
      duration: info.duration || 0,
      thumbnail: info.thumbnail || "",
      uploader: info.uploader || info.channel || "",
      extractor: info.extractor_key || "",
      width: info.width || 0,
      height: info.height || 0,
      webpage_url: info.webpage_url || url,
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Resolve failed." });
  }
}


/* ── Scrubbable preview for linked videos ──
   A browser can't play a YouTube/Instagram *page* URL, so a linked video
   used to show only a poster: you picked trim points blind, against a video
   you couldn't watch. That makes trimming guesswork.

   So the server fetches a small copy and streams it back same-origin. Kept
   deliberately low-res — this exists to be scrubbed, not to be the output;
   the export still downloads full quality separately.

   Direct CDN URLs aren't an option: YouTube's googlevideo links are bound to
   the IP that requested them (ours, not the viewer's) and Instagram's are
   CORS-restricted. Proxying is what makes it play at all. */

// Preview doubles as the export source (see handleVideoClip), so this is a
// real quality knob, not just scrubbing resolution. 720 upscales acceptably
// to the 1080-wide output and downloads far faster than 4K.
const PREVIEW_HEIGHT = Number(process.env.VIDEO_QUALITY || 720);
const PREVIEW_DIR = join(tmpdir(), "pix-preview");
const PREVIEW_TTL_MS = 60 * 60 * 1000;          // 1 hour
const PREVIEW_MAX_BYTES = 120 * 1024 * 1024;
mkdirSync(PREVIEW_DIR, { recursive: true });

// One in-flight download per URL — a <video> element will happily fire
// several overlapping range requests the moment it gets a src.
const previewInFlight = new Map();

function previewPathFor(url) {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 20);
  return join(PREVIEW_DIR, `${key}.mp4`);
}

// Evict old previews so /tmp doesn't grow without bound.
function sweepPreviewCache() {
  try {
    for (const name of readdirSync(PREVIEW_DIR)) {
      const p = join(PREVIEW_DIR, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > PREVIEW_TTL_MS) rmSync(p, { force: true });
      } catch { /* raced with another sweep */ }
    }
  } catch { /* dir vanished */ }
}
setInterval(sweepPreviewCache, 15 * 60 * 1000).unref();

async function ensurePreviewFile(url) {
  const dest = previewPathFor(url);
  if (existsSync(dest) && statSync(dest).size > 1000) return dest;
  if (previewInFlight.has(dest)) return previewInFlight.get(dest);

  const job = (async () => {
    // The temp name MUST end in .mp4. yt-dlp derives the merge container
    // from the output extension, so a ".part" suffix makes a DASH merge
    // write its result elsewhere and the existence check below fails —
    // which looked exactly like a download failure while progressive
    // (single-file) downloads kept working.
    const tmp = dest.replace(/\.mp4$/, ".downloading.mp4");
    const r = await runYtdlp([
      // Order matters: YouTube's progressive (single-file) streams top out at
      // 360p, so asking for "best single file" quietly gets you 360p. Prefer
      // the DASH video+audio pair, which is where 720p actually lives, and
      // fall back to progressive only if the merge isn't possible.
      "-f", `bv*[ext=mp4][height<=${PREVIEW_HEIGHT}]+ba[ext=m4a]/bv*[height<=${PREVIEW_HEIGHT}]+ba/b[ext=mp4][height<=${PREVIEW_HEIGHT}]/b[ext=mp4]/b`,
      "--merge-output-format", "mp4",
      "-o", tmp,
      url,
    ], 180_000);
    if (r.code !== 0 || !existsSync(tmp)) {
      try { rmSync(tmp, { force: true }); } catch {}
      throw new Error(friendlyYtdlpError(r.stderr || r.stdout));
    }
    if (statSync(tmp).size > PREVIEW_MAX_BYTES) {
      rmSync(tmp, { force: true });
      throw new Error("Preview copy is too large.");
    }
    renameSync(tmp, dest);
    return dest;
  })().finally(() => previewInFlight.delete(dest));

  previewInFlight.set(dest, job);
  return job;
}

/**
 * GET /api/video/preview?u=<encoded page url>
 * Streams the cached preview copy, honouring Range so the <video> element
 * can seek. Without range support scrubbing doesn't work at all in Safari.
 */
async function handleVideoPreview(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const target = (requestUrl.searchParams.get("u") || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      sendJson(res, 400, { error: "A http(s) URL is required." });
      return;
    }

    let file;
    try {
      file = await ensurePreviewFile(target);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Could not build a preview." });
      return;
    }

    const size = statSync(file).size;
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: error.message || "Preview failed." });
  }
}

// Stream a multipart body to disk. Buffering a 300 MB upload in memory would
// put the whole container at risk, so files go straight to /tmp and only the
// small text fields are kept in memory.
function receiveClipUpload(req, dir) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const pending = [];
    let aborted = null;

    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 2, fileSize: MAX_VIDEO_UPLOAD_BYTES } });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    bb.on("field", (name, value) => { fields[name] = value; });

    bb.on("file", (name, stream, info) => {
      if (name !== "video" && name !== "overlay") { stream.resume(); return; }
      const dest = join(dir, name === "video" ? "source.bin" : "overlay.png");
      files[name] = { path: dest, name: info.filename || "", bytes: 0 };
      const ws = createWriteStream(dest);
      const done = new Promise((res2, rej2) => {
        stream.on("data", (d) => { files[name].bytes += d.length; });
        stream.on("limit", () => { aborted = `${name} exceeds the ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1048576)} MB limit`; });
        ws.on("finish", res2);
        ws.on("error", rej2);
      });
      pending.push(done);
      stream.pipe(ws);
    });

    bb.on("error", reject);
    bb.on("close", async () => {
      try {
        await Promise.all(pending);
        if (aborted) { reject(new Error(aborted)); return; }
        resolve({ fields, files });
      } catch (err) { reject(err); }
    });

    req.pipe(bb);
  });
}

async function handleVideoClip(req, res) {
  const job = randomUUID().replace(/-/g, "");
  const dir = join(tmpdir(), `pix-clip-${job}`);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "out.mp4");

  try {
    const { fields, files } = await receiveClipUpload(req, dir);

    const start = Number(fields.start || 0);
    const end = Number(fields.end || 0);
    const width = Math.trunc(Number(fields.width || 1080));
    const height = Math.trunc(Number(fields.height || 1920));
    const mute = String(fields.mute || "") === "true";
    // Where the preview framed the crop, normalised 0..1. Defaults to centre
    // so an older client that does not send these still behaves as before.
    const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
    const focusX = clamp01(Number(fields.focusX));
    const focusY = clamp01(Number(fields.focusY));
    const url = String(fields.url || "").trim();

    const duration = Math.round((end - start) * 1000) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) {
      sendJson(res, 400, { error: "End must be after start." });
      return;
    }
    if (duration > MAX_CLIP_SECONDS) {
      sendJson(res, 400, { error: `Clip is ${duration.toFixed(0)}s; the limit is ${MAX_CLIP_SECONDS}s.` });
      return;
    }
    if (!(width > 0 && height > 0) || width % 2 || height % 2) {
      sendJson(res, 400, { error: "Width and height must be positive even numbers." });
      return;
    }
    if (!url && !files.video) {
      sendJson(res, 400, { error: "Supply either a url or a video file." });
      return;
    }

    // Source: local upload, or fetch with yt-dlp.
    let srcPath;
    if (files.video) {
      if (files.video.bytes < 1000) { sendJson(res, 400, { error: "Empty or invalid video file." }); return; }
      srcPath = files.video.path;
    } else {
      // Scrubbing already pulled this exact video down. Re-downloading it
      // wastes a minute and — because two fetches of the same media in quick
      // succession look like scraping — reliably earns an HTTP 403 from
      // YouTube. Reuse the cached copy when it's there.
      const cached = previewPathFor(url);
      if (existsSync(cached) && statSync(cached).size > 1000) {
        srcPath = cached;
        console.log("✓ clip reusing the cached preview download");
      } else {
        srcPath = join(dir, "source.mp4");
        const dl = await runYtdlp([
          "-f", `bv*[ext=mp4][height<=${PREVIEW_HEIGHT}]+ba[ext=m4a]/b[ext=mp4][height<=${PREVIEW_HEIGHT}]/b[ext=mp4]/b`,
          "--merge-output-format", "mp4",
          "-o", srcPath,
          url,
        ], CLIP_TIMEOUT_MS);
        if (dl.timedOut) { sendJson(res, 504, { error: "Downloading the video timed out." }); return; }
        if (dl.code !== 0 || !existsSync(srcPath)) {
          sendJson(res, 502, { error: friendlyYtdlpError(dl.stderr || dl.stdout) });
          return;
        }
      }
    }

    // Scale-to-cover + centre-crop to the target frame, then composite the
    // overlay. `-ss` before `-i` seeks fast; accuracy still holds because we
    // re-encode. `0:a?` makes audio optional so silent sources don't fail.
    // scale-to-cover leaves one axis overflowing; crop that overflow at the
    // offset the user framed rather than always centring. in_w/in_h are the
    // POST-scale dimensions, so (in_w-out_w) is exactly the slack available,
    // which keeps the expression valid whatever the source resolution.
    const cover =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}:(in_w-${width})*${focusX.toFixed(4)}:(in_h-${height})*${focusY.toFixed(4)},` +
      `setsar=1`;
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", srcPath];
    let filter;
    if (files.overlay && files.overlay.bytes > 0) {
      args.push("-i", files.overlay.path);
      filter = `[0:v]${cover}[bg];[1:v]scale=${width}:${height}[ov];[bg][ov]overlay=0:0[v]`;
    } else {
      filter = `[0:v]${cover}[v]`;
    }
    args.push("-t", String(duration), "-filter_complex", filter, "-map", "[v]");
    if (mute) args.push("-an");
    else args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "128k");
    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",      // required for Safari / iOS playback
      "-movflags", "+faststart",  // metadata up front so it streams
      outPath,
    );

    const enc = await run("ffmpeg", args, CLIP_TIMEOUT_MS);
    if (enc.timedOut) { sendJson(res, 504, { error: "Encoding timed out." }); return; }
    if (enc.code !== 0) {
      const tail = enc.stderr.toString("utf-8").slice(-300);
      const msg = /enoent/i.test(tail) ? "ffmpeg is not installed on this server." : `Encoding failed: ${tail}`;
      sendJson(res, 500, { error: msg });
      return;
    }

    const stat = statSync(outPath);
    if (stat.size < 1000) { sendJson(res, 500, { error: "The encoder produced an empty file." }); return; }

    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "X-Clip-Duration": String(duration),
      "Content-Disposition": 'attachment; filename="clip.mp4"',
    });
    createReadStream(outPath).pipe(res);
    res.on("close", () => rmSync(dir, { recursive: true, force: true }));
    return;   // cleanup happens on stream close, not in finally
  } catch (error) {
    if (!res.headersSent) {
      const message = error.message || "Clip failed.";
      const status = /exceeds the .* limit/i.test(message)
        ? 413
        : /^(Malformed upload:|Unexpected end of form)/i.test(message)
          ? 400
          : 500;
      sendJson(res, status, { error: message });
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/* Uploaded media → Supabase Storage → a URL the row can hold.
   
   Signed-in users only: this writes to a bucket with the service_role key,
   and an open upload endpoint backed by that key is a free file host for
   anyone who finds it. */
/* ── Direct-to-Storage upload ───────────────────────────────────────────────

   Two calls around an upload this server never sees the bytes of:

     POST /api/media/sign     -> { uploadUrl, key }
     ...browser PUTs the file straight to Supabase Storage...
     POST /api/media/confirm  -> { url, bytes }

   The split exists so that "stored" is something this server has checked
   rather than something the browser asserts. The old single-shot route
   buffered the whole file in memory here and answered with a URL the moment
   the forward succeeded; when that leg failed after Storage had already
   written the object, the bytes stayed in the bucket with nothing pointing at
   them. Twenty-seven clips in this bucket are that failure.

   The signed URL is scoped to one object path under the caller's own folder,
   so a writer cannot aim an upload at someone else's prefix. */
async function handleMediaSign(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to upload media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  let body = {};
  try {
    body = await readJson(req, { limit: 10_000 });
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const contentType = String(body.contentType || "application/octet-stream").slice(0, 100);
  const filename = String(body.filename || "").slice(0, 200);

  try {
    // Path is built here, never from anything the browser sent: a filename off
    // a client is attacker-controlled and has no business steering a key.
    const key = `${user.id}/${randomUUID()}${extensionFor(contentType, filename)}`;
    const signed = await createSignedUploadUrl(key);
    sendJson(res, 200, { uploadUrl: signed.uploadUrl, key: signed.key });
  } catch (err) {
    console.warn("⚠ could not sign an upload:", err.message);
    sendJson(res, 502, { error: err.message || "Could not prepare the upload." });
  }
}

async function handleMediaConfirm(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to upload media." });
    return;
  }

  let body = {};
  try {
    body = await readJson(req, { limit: 10_000 });
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const key = String(body.key || "");
  /* Confirm only within the caller's own folder. Without this, a signed-in
     writer could ask the server to vouch for any object in the bucket and
     attach someone else's video to their post. */
  if (!key || !key.startsWith(`${user.id}/`) || key.includes("..")) {
    sendJson(res, 400, { error: "That upload does not belong to this account." });
    return;
  }

  try {
    const stat = await statMedia(key);
    if (!stat.ok) {
      // The reference is refused, so the post cannot record a video that is
      // not there — which is the whole point of this round trip.
      sendJson(res, 404, {
        error: "The upload did not arrive in storage. Nothing was saved — please try again.",
      });
      return;
    }
    if (!stat.bytes) {
      sendJson(res, 422, { error: "The upload arrived empty. Please try again." });
      return;
    }
    console.log(`✓ media confirmed ${Math.round(stat.bytes / 1024)} KB → ${key}`);
    sendJson(res, 200, { url: stat.url, bytes: stat.bytes, contentType: stat.contentType });
  } catch (err) {
    console.warn("⚠ could not confirm an upload:", err.message);
    sendJson(res, 502, { error: err.message || "Could not confirm the upload." });
  }
}

/* Delete one stored object.
 
   Two guards, because this is the only irreversible thing in the media path
   and Storage keeps no undo:
 
     1. Admin only. QA can delete a POST, but a post is a row and the bytes it
        points at may be shared with another; removing media is a different
        act with a different blast radius.
     2. Refused if any post still references the key. An admin reaching for
        this is tidying up, not trying to break a live story, so the server
        checks rather than trusting the caller to have checked. This is the
        guard that makes the endpoint safe to leave in place. */
const MEDIA_KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/i;

/* Sweep the bucket for objects no post points at.
 
   The orphan question is a join between storage.objects and pix_posts, and
   both live in the same database — so it is answered here in one query rather
   than by shuttling twelve hundred object names to a client and back.
 
   Matching is on the file's own uuid, not its full path. A stored picture can
   be referenced through the image proxy, where the path arrives percent-encoded
   and the '/' is '%2F'; a path match would miss that and call a live image an
   orphan. The uuid survives any encoding.
 
   Defaults to a dry run. Deleting is the caller's explicit decision, and the
   list it returns is exactly what a confirm=true call will remove. */
async function handleMediaCleanup(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to manage media." });
    return;
  }
  if (!isAdmin(user.role)) {
    sendJson(res, 403, { error: "Only an admin can clean up stored media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  const params = new URL(req.url, "http://localhost").searchParams;
  const confirm = params.get("confirm") === "true";
  const limit = Math.min(Math.max(Number(params.get("limit") || 500), 1), 2000);

  let rows;
  try {
    ({ rows } = await readQuery(
      `with objs as (
         select o.name, (o.metadata->>'size')::bigint as bytes,
                regexp_replace(split_part(o.name, '/', 2), '\.[a-z0-9]+$', '') as fid
           from storage.objects o
          where o.bucket_id = 'pix-media'
       )
       select name, bytes from objs o
        where o.fid <> ''
          and not exists (
            select 1 from pix_posts p
             where p.design::text like '%' || o.fid || '%'
                or coalesce(p.main_image_url, '')   like '%' || o.fid || '%'
                or coalesce(p.source_image_url, '') like '%' || o.fid || '%'
                or coalesce(p.published_history::text, '') like '%' || o.fid || '%')
        order by o.name
        limit $1`,
      [limit]
    ));
  } catch (err) {
    console.warn("⚠ cleanup scan failed:", err.message);
    sendJson(res, 502, { error: `Could not scan for orphans: ${err.message}` });
    return;
  }

  const bytes = rows.reduce((sum, r) => sum + Number(r.bytes || 0), 0);
  if (!confirm) {
    sendJson(res, 200, {
      dryRun: true, found: rows.length, bytes,
      sample: rows.slice(0, 10).map((r) => r.name),
    });
    return;
  }

  let deleted = 0;
  const failures = [];
  for (const row of rows) {
    try {
      await deleteMedia(row.name);
      deleted += 1;
    } catch (err) {
      failures.push({ name: row.name, error: err.message });
    }
  }
  console.log(`✓ media cleanup by ${user.username}: ${deleted} deleted, ${failures.length} failed`);
  sendJson(res, 200, { dryRun: false, found: rows.length, deleted, bytes, failures: failures.slice(0, 10) });
}

async function handleMediaDelete(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to manage media." });
    return;
  }
  if (!isAdmin(user.role)) {
    sendJson(res, 403, { error: "Only an admin can delete stored media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  const key = new URL(req.url, "http://localhost").searchParams.get("key") || "";
  // Shape-checked rather than merely escaped: every key this app writes is
  // <uuid>/<uuid>.<ext>, so anything else is not ours to delete.
  if (!MEDIA_KEY_RE.test(key)) {
    sendJson(res, 400, { error: "That is not a valid media key." });
    return;
  }

  try {
    /* Every column a media URL can be reached from, not just design.
 
       design alone is the video-shaped question. An image is also reachable
       through main_image_url and source_image_url, and a published story
       records what it sent in published_history — so checking design only
       would happily delete the picture off the front of a live post. If a new
       column ever carries a URL, it belongs in this list. */
    const { rows } = await readQuery(
      `select id from pix_posts
        where design::text like $1
           or coalesce(main_image_url, '') like $1
           or coalesce(source_image_url, '') like $1
           or coalesce(published_history::text, '') like $1
        limit 1`,
      [`%${key}%`]
    );
    if (rows.length) {
      sendJson(res, 409, {
        error: `Still in use by post ${rows[0].id}. Nothing was deleted.`,
        postId: rows[0].id,
      });
      return;
    }
  } catch (err) {
    // A reference check that could not run is not a licence to delete.
    console.warn("⚠ could not check media references:", err.message);
    sendJson(res, 503, { error: "Could not verify whether this file is in use. Nothing was deleted." });
    return;
  }

  try {
    await deleteMedia(key);
    console.log(`✓ media deleted by ${user.username}: ${key}`);
    sendJson(res, 200, { deleted: true, key });
  } catch (err) {
    console.warn("⚠ media delete failed:", err.message);
    sendJson(res, 502, { error: err.message || "Could not delete that file." });
  }
}

async function handleMediaUpload(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to upload media." });
    return;
  }
  if (!isStorageConfigured()) {
    sendJson(res, 503, { error: "Media storage is not configured on this server." });
    return;
  }

  let payload;
  try {
    payload = await readMediaUpload(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Upload failed." });
    return;
  }

  if (!payload.buffer?.length) {
    sendJson(res, 400, { error: "No file received." });
    return;
  }

  try {
    const key = `${user.id}/${randomUUID()}${extensionFor(payload.contentType, payload.filename)}`;
    const url = await uploadMedia(key, payload.buffer, payload.contentType);
    console.log(`✓ media ${Math.round(payload.buffer.length / 1024)} KB → ${key}`);
    sendJson(res, 200, { url, bytes: payload.buffer.length, contentType: payload.contentType });
  } catch (err) {
    console.warn("⚠ media upload failed:", err.message);
    sendJson(res, 502, { error: err.message || "Could not store that file." });
  }
}

/* Buffered rather than streamed: Storage wants a length, and the cap below is
   well inside what a request body can hold in memory. */
const MAX_MEDIA_BYTES = Number(env("MAX_MEDIA_BYTES") || 0) || 314_572_800;

function readMediaUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_MEDIA_BYTES } });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    const chunks = [];
    let contentType = "application/octet-stream";
    let filename = "";
    let tooBig = false;

    bb.on("file", (name, stream, info) => {
      if (name !== "file") { stream.resume(); return; }
      contentType = info.mimeType || contentType;
      filename = info.filename || "";
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => { tooBig = true; });
    });

    bb.on("error", reject);
    bb.on("close", () => {
      if (tooBig) {
        reject(new Error(`File exceeds the ${Math.round(MAX_MEDIA_BYTES / 1048576)} MB limit.`));
        return;
      }
      resolve({ buffer: Buffer.concat(chunks), contentType, filename });
    });

    req.pipe(bb);
  });
}

/* The extension is cosmetic — it only makes the object readable in the
   Supabase dashboard — so a guess from the MIME type is enough, and a name
   from the browser is never trusted for anything but its suffix. */
function extensionFor(contentType, filename) {
  const known = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/gif": ".gif", "image/avif": ".avif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  };
  if (known[contentType]) return known[contentType];
  const match = String(filename || "").match(/(\.[a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

/* Saved pix library — see lib/pix-api.js for the routes and lib/db.js for the
   schema. Storage is optional, so this never propagates an error: a failed
   save answers with a message the editor shows in the status line and then
   carries on. */
async function handlePix(req, res) {
  const parsed = new URL(req.url, "http://localhost");
  const query = Object.fromEntries(parsed.searchParams);
  let body = {};
  if (req.method === "POST" || req.method === "DELETE") {
    try {
      body = await readJson(req, { limit: 2_000_000 });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Invalid JSON body." });
      return;
    }
  }
  const user = await currentUser(req);
  const result = await handlePixRequest({ method: req.method, path: parsed.pathname, query, body, user });
  sendJson(res, result.status, result.body);
}

/* ── Auth ──
   Pix has its own accounts (see lib/auth.js). Sessions are opaque tokens in an
   HttpOnly cookie; every /api/pix call resolves one before doing anything. */

/* DailyMattr integration.
   The browser sends exported slide PNGs here; this server adds the external
   credentials and forwards the publish request so the API key never reaches
   the client. */
/* Which categories QA may publish into, and in what order.

   DailyMattr offers 12; Shortly uses a subset, and the dropdown reads better
   in editorial priority than in whatever order their API returns. The names
   here are matched case-insensitively against their list and the IDs always
   come from them — we never hard-code an ID, so if they renumber anything
   this keeps working.

   A name we ask for that they do not offer is skipped with a warning rather
   than guessed at: sending an invented category_id would file the story under
   the wrong section, which is worse than not offering it.

   Override with DAILYMATTR_CATEGORIES="Entertainment,Technology,…", or set it
   empty to show everything they offer. */
const DAILYMATTR_CATEGORY_ORDER = (
  env("DAILYMATTR_CATEGORIES") ||
  "Entertainment,Technology,Lifestyle,State,International,National,Finance,Sports"
).split(",").map((s) => s.trim()).filter(Boolean);

let warnedMissingCategories = false;

function applyCategoryPolicy(categories) {
  if (!DAILYMATTR_CATEGORY_ORDER.length) return categories;

  const byName = new Map(categories.map((c) => [String(c.name).trim().toLowerCase(), c]));
  const kept = [];
  const missing = [];
  for (const name of DAILYMATTR_CATEGORY_ORDER) {
    const hit = byName.get(name.toLowerCase());
    if (hit) kept.push(hit);
    else missing.push(name);
  }

  if (missing.length && !warnedMissingCategories) {
    warnedMissingCategories = true;
    console.warn(`⚠ DailyMattr does not offer: ${missing.join(", ")} — not shown to QA. Ask them to add it, or drop it from DAILYMATTR_CATEGORIES.`);
  }
  // Never hand QA an empty dropdown; if nothing matched, their names have
  // changed and showing all of them beats showing none.
  return kept.length ? kept : categories;
}

async function handleDailyMattrMeta(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to use the DailyMattr integration." });
    return;
  }
  /* Readable by writers as well as reviewers. Writers choose the section their
     story belongs in while they build it — they have the context, reviewers would be
     guessing at review time — and to offer that choice they need the list.
     Publishing stays reviewer-only; this is reference data, not an action. */

  try {
    const meta = await fetchDailyMattrMeta(dailyMattrConfig());
    sendJson(res, 200, { ...meta, categories: applyCategoryPolicy(meta.categories) });
  } catch (err) {
    console.warn("⚠ DailyMattr meta failed:", err.message);
    sendJson(res, 502, { error: err.message || "Could not load DailyMattr options." });
  }
}

// 25 MB was fine while page 2 was always a PNG. Slide 2 can be a trimmed MP4,
// which clears that easily, so the default is raised. DailyMattr has not told
// us their own per-file limit yet — if they reject a large clip, lower this
// rather than assuming the encode failed.
const MAX_DAILYMATTR_MEDIA_BYTES = Number(env("MAX_DAILYMATTR_MEDIA_BYTES") || 0) || 64 * 1024 * 1024;

/* Shrink a clip so DailyMattr will take it, without a visible quality drop.

   We publish H.264 at CRF 20 with preset veryfast, which for a 31s 1080x1996
   clip came to 12.58 MB — accepted by their API with success:true and then
   not stored. Their per-file limit is undocumented; 10 MB is the usual one.

   The technique is capped CRF: -crf drives quality as normal while
   -maxrate/-bufsize impose a ceiling the encoder cannot cross. Easy footage
   stays governed by CRF and comes out well under the cap; difficult footage
   hits the cap instead of ballooning. One pass, so no doubling of encode time.

   Measured on that exact 12.58 MB clip, targeting 9 MB:
     7.54 MB, SSIM 0.9935, PSNR 43.84 dB  (>40 dB is the usual
     visually-lossless threshold, and this is a second-generation encode, so
     the real figure from source is better)
   A 90s clip — the longest we allow — came out at 7.67 MB against the same
   ceiling, so the bound holds at the worst case, not just the average.

   Set DAILYMATTR_TARGET_VIDEO_MB=0 to disable. */
// Mirrors the one in lib/pix-api.js; validating here keeps a malformed id
// from ever reaching a query.
const PIX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Stands in for DailyMattr's buzz id when they accept a post but return
   nothing we can read as one. Stored so published_id is non-null, which is the
   flag separating "confirmed live" from "sent, outcome unknown" everywhere
   else — a null there makes a publish we watched succeed look like one that
   may never have happened. */
/* Their answer, bounded. A response we cannot store is worse than a trimmed
   one, and the interesting part — any media list, any error detail — is short
   next to the content echo. Kept as JSON when it fits and as a marked-up
   string when it does not, so a reader always knows which they are looking
   at. */
function truncateForStorage(value, limit = 8000) {
  if (value == null) return null;
  let text;
  try { text = JSON.stringify(value); } catch { return { unserialisable: String(value).slice(0, limit) }; }
  if (text.length <= limit) return value;
  return { truncated: true, bytes: text.length, head: text.slice(0, limit) };
}

const PUBLISH_ID_MISSING = "(accepted, no id returned)";

const DAILYMATTR_TARGET_VIDEO_BYTES =
  Math.round(Number(env("DAILYMATTR_TARGET_VIDEO_MB") || 9) * 1024 * 1024);
const COMPRESS_CRF = String(env("DAILYMATTR_VIDEO_CRF") || 23);
const COMPRESS_TIMEOUT_MS = 600_000;
const COMPRESS_AUDIO_BPS = 128_000;

/* Bring a clip under DailyMattr's cap, or refuse the publish.

   Every failure here used to `return file` — the ORIGINAL, oversized. That is
   the quietest way to lose a video: DailyMattr accepts the post, drops the
   clip it will not store, and answers 200 with a buzz id. Our side records a
   successful publish, QA sees "published", and the story is live on the app
   without its video. Nothing in the response says so, their API is write-only
   so it cannot be checked afterwards, and the post cannot be corrected — only
   republished as a second copy.

   So this now throws instead. The caller runs it in its own try precisely
   because a throw here provably means nothing was sent, which leaves the post
   unpublished, the claim released, and QA holding an actionable message. A
   refused publish costs a retry; a silently clipless one costs the video.

   The output is also VERIFIED against the cap rather than merely compared
   against the input: -maxrate is a rate-control hint, not a guarantee, so
   "smaller than it was" was never the same as "small enough". */
async function compressForDailyMattr(file) {
  if (DAILYMATTR_TARGET_VIDEO_BYTES <= 0) return file;
  if (!/^video\//i.test(file.contentType || "")) return file;
  if (file.buffer.length <= DAILYMATTR_TARGET_VIDEO_BYTES) return file;

  const mb = (n) => (n / 1048576).toFixed(1);
  const capMb = mb(DAILYMATTR_TARGET_VIDEO_BYTES);
  const tooBig = (why) => new Error(
    `the ${mb(file.buffer.length)} MB video could not be brought under DailyMattr's ${capMb} MB limit (${why}). ` +
    `Shorten the trim range on the Video page and publish again.`,
  );

  /* No encoder, no way to shrink it — and no reason to pretend otherwise by
     sending a file we know will be dropped. */
  if (!ffmpegAvailable) {
    throw tooBig("ffmpeg is not installed on this server");
  }

  const job = randomUUID().replace(/-/g, "");
  const dir = join(tmpdir(), `pix-compress-${job}`);
  mkdirSync(dir, { recursive: true });
  const inPath = join(dir, "in.mp4");

  try {
    writeFileSync(inPath, file.buffer);

    const probe = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inPath,
    ], 30_000);
    const duration = Number(probe.stdout.toString("utf-8").trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw tooBig("its duration could not be read");
    }

    /* Two passes at most. The first aims at the cap; if rate control overshoots
       — which it does on high-motion footage — the second aims at whatever
       fraction of the cap the first actually achieved. Beyond that the clip is
       genuinely too long for the budget and the honest answer is to say so
       rather than grind. */
    let best = null;
    let aim = DAILYMATTR_TARGET_VIDEO_BYTES;

    for (let pass = 1; pass <= 2; pass += 1) {
      const outPath = join(dir, `out-${pass}.mp4`);
      // 0.92 leaves headroom for container overhead and rate-control overshoot;
      // without it the result lands slightly OVER the number we promised.
      const budgetBps = (aim * 8 * 0.92) / duration;
      const maxrate = Math.max(200_000, Math.round(budgetBps - COMPRESS_AUDIO_BPS));

      const t0 = Date.now();
      const enc = await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inPath,
        "-c:v", "libx264", "-preset", "slow", "-crf", COMPRESS_CRF,
        "-maxrate", String(maxrate), "-bufsize", String(maxrate * 2),
        "-c:a", "aac", "-b:a", "128k",
        "-pix_fmt", "yuv420p",      // required for Safari / iOS playback
        "-movflags", "+faststart",  // metadata up front so it streams
        outPath,
      ], COMPRESS_TIMEOUT_MS);

      if (enc.code !== 0 || !existsSync(outPath)) {
        throw tooBig(`ffmpeg failed: ${enc.stderr.toString("utf-8").slice(-160) || `exit ${enc.code}`}`);
      }

      const shrunk = readFileSync(outPath);
      if (!shrunk.length) throw tooBig("the encoder produced an empty file");
      if (!best || shrunk.length < best.length) best = shrunk;

      console.log(
        `· compress pass ${pass} ${file.fieldName}: ${mb(file.buffer.length)} MB → ${mb(shrunk.length)} MB ` +
        `(${duration.toFixed(1)}s, crf ${COMPRESS_CRF}, maxrate ${Math.round(maxrate / 1000)}k, ${Date.now() - t0}ms)`,
      );

      if (shrunk.length <= DAILYMATTR_TARGET_VIDEO_BYTES) {
        console.log(`✓ compressed ${file.fieldName} to ${mb(shrunk.length)} MB, under the ${capMb} MB cap`);
        return { ...file, buffer: shrunk };
      }

      // Overshot. Aim the next pass proportionally lower.
      aim = Math.max(
        Math.round(DAILYMATTR_TARGET_VIDEO_BYTES * 0.5),
        Math.round(aim * (DAILYMATTR_TARGET_VIDEO_BYTES / shrunk.length) * 0.9),
      );
    }

    throw tooBig(`the closest encode was still ${mb(best.length)} MB`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

/* The publish route used to be one big try whose catch answered 502 "Could not
   publish" for everything — the encode, the upload, the logging, the approval
   write and the response send alike. That is what let a failure AFTER
   DailyMattr had accepted the post be reported to QA as a failed publish.

   runDailyMattrPublish() now classifies its own failures and always answers,
   so this wrapper exists only to stop an unforeseen throw becoming an
   unhandled rejection (the http.createServer callback has no catch of its
   own). It reports the outcome as unknown, because by definition it does not
   know where the throw came from. */
async function handleDailyMattrPublish(req, res) {
  try {
    await runDailyMattrPublish(req, res);
  } catch (err) {
    console.error("✗ DailyMattr publish handler crashed:", err);
    if (res.headersSent || res.writableEnded) return;
    sendJson(res, 500, {
      error: "The publish failed in an unexpected way and this server cannot tell whether the post reached DailyMattr. Check their portal before publishing again.",
      indeterminate: true,
    });
  }
}

async function runDailyMattrPublish(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to publish to DailyMattr." });
    return;
  }
  // Publishing is the last editorial gate before content is live on
  // shortlyindia.com, so it belongs to review roles alone. Use the shared
  // capability check so a new review role cannot see the panel and get a 403.
  if (!canReview(user.role)) {
    sendJson(res, 403, { error: "Only QA or admin can publish to DailyMattr." });
    return;
  }

  let payload;
  try {
    payload = await readDailyMattrPublish(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Invalid DailyMattr publish request." });
    return;
  }

  if (!payload.contentEn) {
    sendJson(res, 400, { error: "A caption is required." });
    return;
  }
  if (!payload.categoryId) {
    sendJson(res, 400, { error: "Choose a category before publishing." });
    return;
  }
  if (!payload.files.length) {
    sendJson(res, 400, { error: "At least one media file is required." });
    return;
  }
  if (payload.sourceUrl) {
    try {
      const source = new URL(payload.sourceUrl);
      if (!/^https?:$/.test(source.protocol)) throw new Error("unsupported protocol");
    } catch {
      sendJson(res, 400, { error: "Source URL must be a valid HTTP or HTTPS URL." });
      return;
    }
  }

  /* DailyMattr requires a state whenever the category is "State" — a regional
     story filed against no region is rejected at their end. Checked here so it
     fails before the video encode and the upload rather than after several
     megabytes have gone over the wire, and matched by NAME against their live
     list so it survives them renumbering the category. */
  try {
    const meta = await fetchDailyMattrMeta(dailyMattrConfig());
    const stateCategory = (meta.categories || []).find((c) => /^state$/i.test(String(c.name).trim()));
    if (stateCategory && String(payload.categoryId) === String(stateCategory.id) && !payload.stateId) {
      sendJson(res, 400, { error: "The State category needs a state. Choose one before publishing." });
      return;
    }
  } catch (err) {
    // Their lookup being unreachable must not block a publish that would
    // otherwise succeed — DailyMattr will still enforce its own rule.
    console.warn("⚠ could not check the State rule, continuing:", err.message);
  }
  const mediaValidationError = validateDailyMattrMedia(payload.files);
  if (mediaValidationError) {
    sendJson(res, 400, { error: mediaValidationError });
    return;
  }

  /* ── Claim the publish before anything can be sent ──
     DailyMattr's integration API is write-only: no delete, no lookup, no
     idempotency key. A second POST for the same post is a second live story on
     shortlyindia.com that can only be removed by hand from their portal, and
     until this claim existed nothing anywhere recorded that a row had already
     gone out — so a bookmarked editor tab, a browser refresh, or two QA users
     working the same queue entry all produced one.

     Taken here, before the encode and the upload, for two reasons: the window
     between "decided to publish" and "sent" is minutes long on a compressed
     clip, and a claim taken after the send guards nothing. */
  let claimed = false;
  if (payload.pixId) {
    let claim;
    try {
      /* `republish` lifts the already-published guard, and only that guard —
         the rejection check below still applies, because a republish is a
         correction and not a way around a verdict. It has to arrive as an
         explicit field: the whole value of the claim is that an accidental
         second send (a reload, a stray click, a retry after a timeout) is
         refused, and that only survives if the deliberate case is a different
         request rather than the same one tried twice. */
      claim = await claimPublish(payload.pixId, {
        byId: user.id,
        republish: payload.republish === true,
      });
    } catch (err) {
      /* The database being unreachable must NOT degrade into publishing
         unguarded. Everywhere else in this app storage is optional and a
         failure costs a saved row; here it would cost a duplicate on a public
         site, which is the one loss that cannot be undone. */
      console.warn(`⚠ could not claim the publish for ${payload.pixId}: ${err.message}`);
      sendJson(res, 503, {
        error: "The post library is unreachable, so this publish cannot be checked against earlier ones. Nothing was sent — try again once storage is back.",
        indeterminate: false,
      });
      return;
    }

    if (!claim.claimed) {
      const row = claim.row;
      if (!row) {
        sendJson(res, 404, { error: "That post is no longer in the library. Nothing was sent.", indeterminate: false });
        return;
      }
      if (row.rejected) {
        /* Refused outright rather than offered an override. Publishing a
           rejected post used to be allowed and the auto-approve below then
           erased rejected_by, rejected_at and rejected_by_name — the live
           story kept no trace it had been turned down, and the reviewer lost
           the credit for the decision. Withdrawing the rejection is one click
           in Review ("Undo reject"), it is recorded, and it makes the
           override a deliberate, attributable act instead of a flag on an
           upload nobody sees. */
        const who = row.rejected_by_name || "a reviewer";
        const when = row.rejected_at ? new Date(row.rejected_at).toISOString() : "";
        sendJson(res, 409, {
          error: `This post was rejected by ${who}${when ? ` on ${when}` : ""}. Nothing was sent. Withdraw the rejection in Review ("Undo reject") before publishing.`,
          indeterminate: false,
          rejected: true,
          rejectedByName: row.rejected_by_name || null,
          rejectedAt: row.rejected_at || null,
        });
        return;
      }
      /* The claim's WHERE clause is `published_at is null and rejected =
         false`, so reaching here with neither set means the row changed
         between the UPDATE and this read — another request released a claim,
         or a rejection was withdrawn. Nothing was sent and the next attempt
         will be decided on the settled state, so say exactly that rather than
         guessing at one of the two messages below. */
      if (!row.published_at) {
        sendJson(res, 409, {
          error: "This post's status changed while the publish was being checked. Nothing was sent — reload the post and try again.",
          indeterminate: false,
        });
        return;
      }
      /* published_at set with published_id still null is the unconfirmed case:
         an earlier attempt reached DailyMattr and never heard back, so nobody
         knows whether the story is live. Refusing is the only safe answer —
         the alternative is a blind retry that may well duplicate it. */
      const when = new Date(row.published_at).toISOString();
      sendJson(res, 409, {
        error: row.published_id
          ? `Already published to DailyMattr as ID ${row.published_id} on ${when}. Nothing was sent — publishing again would put a second copy on the live site, and their API has no delete.`
          : `A publish of this post was started on ${when} and never confirmed, so it may already be live. Nothing was sent. Check the DailyMattr portal before doing anything else.`,
        indeterminate: false,
        alreadyPublished: true,
        publishedId: row.published_id || null,
        publishedAt: row.published_at,
        unconfirmed: !row.published_id,
      });
      return;
    }
    claimed = true;
  }
  /* No pixId means QA built the poster without ever saving it, so there is no
     row to claim and this one publish is unguarded. Accepted knowingly rather
     than blocked: the library row is what makes the guard possible, and
     refusing here would break the ad-hoc poster workflow. The exposure is one
     browser session — nothing persists an unsaved poster, so the duplicate
     needs the same tab and a second deliberate click. */

  /* Compression is entirely local — temp files and ffmpeg — so a throw from it
     provably means nothing was sent. Kept in its own try for exactly that
     reason: folded in with the publish call below it would be classified as
     indeterminate and would lock the post out of publishing for no reason. */
  try {
    // Applies to every video part whatever its origin — a freshly rendered
    // clip, the stored copy from our bucket, or a file QA attached by hand.
    payload.files = await Promise.all(payload.files.map(compressForDailyMattr));
  } catch (err) {
    console.warn("⚠ DailyMattr publish failed before sending (media preparation):", err.message);
    if (claimed) await releasePublishClaim(payload.pixId).catch(() => {});
    sendJson(res, 502, {
      error: `The media could not be prepared: ${err.message || "unknown error"}. Nothing was sent.`,
      indeterminate: false,
    });
    return;
  }

  /* Log what actually goes out, per file. "3 files" alone cannot answer the
     only question that matters when something is missing at the other end —
     WHICH file, and was it a video? Without the type and size here there is
     no way to tell "we never attached the clip" from "we sent it and
     DailyMattr dropped it". */
  const manifest = payload.files
    .map((f) => `${f.fieldName}=${f.contentType} ${(f.buffer.length / 1048576).toFixed(2)}MB "${f.filename}"`)
    .join(", ");
  const videoCount = payload.files.filter((f) => /^video\//i.test(f.contentType || "")).length;
  console.log(
    `→ DailyMattr publish by ${user.username}: ${payload.files.length} file(s), ${videoCount} video — ${manifest}`,
  );
  /* The same manifest as data, to be stored beside their answer. The log line
     above is for whoever is watching at the time; this is for whoever asks a
     week later why a story has no video. */
  const sentParts = payload.files.map((f) => ({
    field: f.fieldName,
    type: f.contentType || null,
    bytes: f.buffer.length,
    filename: f.filename || null,
  }));

  /* The irreversible call, alone in its own try so its failure can be
     classified rather than lumped in with everything else in the handler. */
  let result;
  try {
    result = await publishDailyMattrBuzzContent(payload, dailyMattrConfig());
  } catch (err) {
    const neverSent = publishDefinitelyNotSent(err);
    console.warn(
      `⚠ DailyMattr publish failed (${neverSent ? "nothing sent" : "OUTCOME UNKNOWN"}, ` +
      `status=${err?.status ?? "n/a"}) for ${payload.pixId || "unsaved poster"}: ${err.message}`,
    );

    /* Keep the evidence. A refusal is a response, and the indeterminate case —
       sent, no usable answer — is the single hardest state to reconstruct a
       week later, because the row looks untouched and the log has rotated.
       Best-effort: this must never turn a publish failure into a 500. */
    if (payload.pixId) {
      await recordPublishAttempt(payload.pixId, {
        at: new Date().toISOString(),
        by: user.username,
        outcome: neverSent ? "refused-before-storing" : "outcome-unknown",
        status: err?.status ?? null,
        error: String(err?.message || "").slice(0, 2000),
        details: Array.isArray(err?.details) ? err.details.slice(0, 8) : undefined,
        sent: sentParts,
        response: truncateForStorage(err?.rawPayload ?? null),
      }).catch((e) => console.warn("⚠ could not record the failed attempt:", e.message));
    }

    if (neverSent) {
      // Provably nothing was stored at their end, so hand the claim back and
      // let QA fix the problem and publish again.
      if (claimed) await releasePublishClaim(payload.pixId).catch(() => {});
      sendJson(res, 502, {
        error: err.message || "Could not publish to DailyMattr.",
        /* The per-field refusals, listed rather than run together into the
           sentence above. Without these the dialog could only say that the
           post was refused, never which slide or which field caused it, and
           "fix the problem and publish again" is not an instruction anyone
           can follow when the problem was never named. */
        details: Array.isArray(err.details) && err.details.length ? err.details.slice(0, 8) : undefined,
        // The headline without the field lines glued on, so a dialog that
        // lists them as rows does not also print them inside its sentence.
        summary: err.summary || undefined,
        indeterminate: false,
      });
      return;
    }

    /* Unknown: the request left this server and no usable answer came back — a
       reset connection, a gateway 504, a body timeout on a slow media
       endpoint. DailyMattr may have created the story. The claim is
       deliberately KEPT so a retry is refused rather than silently doubling a
       live post, and the response says so instead of the old "Nothing was
       sent — publish again", which is what turned this into duplicates. */
    sendJson(res, 409, {
      error: (err.message || "The connection to DailyMattr failed.")
        + " The post may already be live — this was sent and no confirmation came back."
        + " Check the DailyMattr portal before publishing again.",
      indeterminate: true,
    });
    return;
  }

  // Their response is the only record of what they accepted. Log it whole:
  // a 200 that quietly stored fewer items than we sent is exactly the
  // failure we are chasing, and it is invisible without this.
  // 600 chars cut off before the interesting part — their content_en echo
  // alone eats most of it, and any media list they return comes after.
  console.log(`✓ DailyMattr accepted (id=${result.publishedId ?? "none"}): ${JSON.stringify(result.response).slice(0, 4000)}`);

  /* Turn the claim into a receipt. The claim itself is already committed, so
     the duplicate guard holds whatever happens here — what a failure costs is
     the buzz id, which is the only handle anyone has for pulling the story
     from DailyMattr's portal later. That is worth an error-level log and a
     line in the response rather than the silent warn the approval below gets. */
  let publishRecord = { ok: false, reason: "post not saved" };
  if (payload.pixId) {
    try {
      /* A confirmed publish must never be recorded as an unconfirmed one.
         published_id is what tells those apart, so when DailyMattr answers 200
         without an id we can recognise (it normally returns buzz_id), the
         column takes this marker rather than staying null — otherwise the row
         reads "sent, never confirmed" and every later reader is told the story
         may not be live when we watched them accept it. */
      /* The receipt, written in the same statement as the id.

         `sent` is what left this server, part by part; `response` is their
         verbatim answer. Together they answer the question their write-only
         API cannot be asked afterwards: when a story appears without its
         video, was the clip forwarded and dropped, or never forwarded?

         Their answer is capped rather than trusted whole — the content_en
         echo alone can be large, and this column exists to be readable, not
         to mirror their payload. */
      const receipt = {
        at: new Date().toISOString(),
        by: user.username,
        buzzId: result.publishedId ?? null,
        sent: sentParts,
        videoBytes: sentParts.filter((f) => /^video\//i.test(f.type || ""))
          .reduce((n, f) => n + f.bytes, 0) || null,
        response: truncateForStorage(result.response),
      };
      const row = await recordPublishedId(
        payload.pixId,
        result.publishedId ?? PUBLISH_ID_MISSING,
        receipt,
      );
      publishRecord = row
        ? {
            ok: true,
            publishedId: row.published_id,
            publishedAt: row.published_at,
            // The superseded copies still on the public site, so a republish
            // can name what is left to delete without waiting for a reload.
            publishedHistory: row.published_history || [],
          }
        : { ok: false, reason: "post not found" };
    } catch (err) {
      console.error(
        `✗ PUBLISHED but the DailyMattr id was not recorded on ${payload.pixId} ` +
        `(buzz id ${result.publishedId ?? "none"}): ${err.message}`,
      );
      publishRecord = { ok: false, reason: err.message };
    }
  }

  /* Copy the finished cards to our own bucket, for the website.

     DailyMattr keeps what was just sent in a private S3 bucket that the public
     site cannot read from, so the only public copy of a finished card is the
     one made here. Best-effort and after the receipt: the story is already
     live, so nothing in this may be reported as a failed publish. A miss costs
     the website its cards for this one story — it shows the background picture
     instead — and is logged at error level so it gets noticed. */
  let webCopy = { ok: false, reason: "post not saved" };
  if (payload.pixId) {
    try {
      const pages = await copyCardsToWeb({ pixId: payload.pixId, files: payload.files });
      if (!pages.length) {
        webCopy = { ok: false, reason: "no picture cards in this publish" };
      } else {
        const saved = await recordWebPages(payload.pixId, pages);
        webCopy = saved ? { ok: true, pages: pages.length } : { ok: false, reason: "post not found" };
        if (saved) console.log(`✓ ${pages.length} card(s) copied to the web bucket for ${payload.pixId}`);
      }
    } catch (err) {
      console.error(`✗ PUBLISHED but the cards were not copied for the website (${payload.pixId}): ${err.message}`);
      webCopy = { ok: false, reason: err.message };
    }
  }

  /* Publishing IS approval — QA would otherwise have to remember a second
     click for a decision they have already made by sending the story live.

     Deliberately in its own guard, outside anything that could be reported as
     a failed publish. The DailyMattr publish has already happened and cannot
     be undone; if an approval write threw and was reported as a publish
     error, QA would assume nothing was sent and publish again — posting the
     story to the live site twice. A failed approval must cost a checkbox,
     never a duplicate.

     Only approves a post that is not already approved, so re-publishing
     does not rewrite the original approver's name or reset approved_at
     (which would skew the approval-time figures on the analytics screen). */
  let approval = null;
  if (payload.pixId) {
    try {
      const current = await getPix(payload.pixId);
      if (!current) {
        approval = { ok: false, reason: "post not found" };
      } else if (current.approved) {
        approval = { ok: true, alreadyApproved: true };
      } else {
        const row = await setApproval(payload.pixId, {
          approved: true,
          byId: user.id,
          byName: user.displayName || user.username,
        });
        approval = row ? { ok: true, approvedAt: row.approved_at } : { ok: false, reason: "post not found" };
        if (row) console.log(`✓ auto-approved ${payload.pixId} on publish by ${user.username}`);
      }
    } catch (err) {
      console.warn(`⚠ published but could not auto-approve ${payload.pixId}: ${err.message}`);
      approval = { ok: false, reason: err.message };
    }
  } else {
    // Unsaved poster: nothing in the library to mark.
    approval = { ok: false, reason: "post not saved" };
  }

  sendJson(res, 200, { ...result, approval, publishRecord, webCopy });
}

/**
 * Did this failure provably never reach DailyMattr?
 *
 * Only "yes" is safe to act on, because "yes" is what lets the server release
 * the publish claim and tell QA to try again. Everything unrecognised
 * therefore answers no: the cost of a false "yes" is a duplicate live story
 * that cannot be deleted, and the cost of a false "no" is a post that has to
 * be checked by hand in their portal.
 *
 * The markers come from lib/dailymattr.js; see the note there for why the HTTP
 * status could not previously be read at all.
 */
function publishDefinitelyNotSent(err) {
  if (err?.beforeSend) return true;
  if (err?.upstreamRejected) {
    const status = Number(err.status);
    /* A 4xx is DailyMattr having looked at the request and declined it, so
       nothing was stored. The three exceptions are 4xx codes that mean "not
       now" rather than "no" — a 408 or 429 can be raised by an intermediary
       that already forwarded the body, and 425 is explicitly "retry later". */
    return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
  }
  // transportFailed, an upstream 5xx, or something with no marker at all.
  return false;
}

function readDailyMattrPublish(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: 5, fileSize: MAX_DAILYMATTR_MEDIA_BYTES, fields: 12 },
      });
    } catch (err) {
      reject(new Error("Malformed upload: " + err.message));
      return;
    }

    const fields = {};
    const files = [];
    let tooBig = false;
    let tooMany = false;
    let invalidMediaField = false;

    bb.on("field", (name, value) => {
      fields[name] = String(value || "").trim();
    });

    bb.on("file", (name, stream, info) => {
      const pageMatch = /^media_page_([1-5])$/i.exec(name);
      if (!pageMatch) {
        if (/^media_page_/i.test(name)) invalidMediaField = true;
        stream.resume();
        return;
      }

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { tooBig = true; });
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return;
        files.push({
          fieldName: name,
          page: Number(pageMatch[1]),
          filename: info.filename || `${name}${extensionFor(info.mimeType, info.filename)}`,
          contentType: info.mimeType || "application/octet-stream",
          buffer,
        });
      });
    });

    bb.on("filesLimit", () => { tooMany = true; });
    bb.on("error", reject);
    bb.on("close", () => {
      if (tooBig) {
        reject(new Error(`A DailyMattr media file exceeds the ${Math.round(MAX_DAILYMATTR_MEDIA_BYTES / 1048576)} MB limit.`));
        return;
      }
      if (tooMany) {
        reject(new Error("A maximum of five media files can be published."));
        return;
      }
      if (invalidMediaField) {
        reject(new Error("Media fields must be media_page_1 through media_page_5."));
        return;
      }
      resolve({
        contentEn: fields.content_en || "",
        categoryId: fields.category_id || "",
        keywords: fields.keywords || "",
        stateId: fields.state_id || "",
        sourceUrl: fields.source_url || "",
        // Which library row this poster came from, so publishing can approve
        // it. Empty when QA built the poster without ever saving it.
        pixId: PIX_UUID_RE.test(String(fields.pix_id || "")) ? String(fields.pix_id) : "",
        /* Deliberate second send of a story that is already live. Compared
           against the exact string so a stray "false"/"0" cannot enable it —
           this is the one field that unlocks putting a second copy on a site
           we cannot delete from. */
        republish: fields.republish === "true",
        files: files.sort((a, b) => a.page - b.page),
      });
    });

    req.pipe(bb);
  });
}

function validateDailyMattrMedia(files) {
  if (files.length > 5) return "A maximum of five media files can be published.";

  const pages = files.map((file) => file.page);
  if (new Set(pages).size !== pages.length) return "Each media output can only be supplied once.";

  const kindOf = (file) => {
    const type = String(file.contentType || "").toLowerCase();
    if (/^image\/(jpeg|png|webp)$/.test(type)) return "image";
    if (/^video\/(mp4|quicktime)$/.test(type)) return "video";
    return "unsupported";
  };
  const kinds = files.map(kindOf);
  if (kinds.includes("unsupported")) return "Media must be JPG, PNG, WEBP, MP4 or MOV.";
  return "";
}

/* ═══════════════════════ Writer accounts (QA only) ═══════════════════════

   Accounts could previously only be made by running `npm run users:seed`,
   which creates a fixed roster of six and nothing else — there was no way to
   add a seventh writer without shell access to the server. QA manages the
   team, so QA gets the screen.

   Deliberately narrow: create, reset a password, enable/disable. No delete —
   user_login_id on pix_posts is a bare text column with no foreign key, so
   removing a row would leave every post that writer produced pointing at an
   id that resolves to nobody. Disabling keeps the audit trail. */
async function handleUsers(req, res) {
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to manage accounts." });
    return;
  }
  /* The roster belongs to the admin, not to QA.

     One exception, and it is the difference between a policy and a locked
     door: if no admin account exists yet, QA may still manage accounts. The
     alternative is a system where the only way to make the first admin is a
     shell on the server, and where tightening this rule would have locked the
     existing team out of their own tool the moment it deployed. The exception
     closes by itself the instant an admin exists. */
  if (!isAdmin(user.role)) {
    const adminExists = (await listUsers()).some((u) => u.role === "admin" && u.active);
    if (adminExists || user.role !== "qa") {
      sendJson(res, 403, { error: "Only an admin can manage accounts." });
      return;
    }
    console.warn(`⚠ no admin account yet — allowing ${user.username} (qa) to manage accounts`);
  }
  if (!dbConfigured()) {
    sendJson(res, 503, { error: "The database is not configured." });
    return;
  }

  const parsed = new URL(req.url, `http://localhost:${port}`);
  const path = parsed.pathname.replace(/\/+$/, "");

  try {
    if (req.method === "GET" && path === "/api/users") {
      const rows = await listUsers();
      sendJson(res, 200, {
        users: rows.map((r) => ({
          id: r.id,
          username: r.username,
          role: r.role,
          displayName: r.display_name,
          active: r.active,
          createdAt: r.created_at,
          lastLoginAt: r.last_login_at,
        })),
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    const body = await readJson(req, { limit: 10_000 });

    if (path === "/api/users") {
      const username = normaliseUsername(body?.username);
      const password = String(body?.password || "");
      const role = String(body?.role || "writer");
      const displayName = String(body?.displayName || "").trim() || null;

      if (!username) { sendJson(res, 400, { error: "A username is required." }); return; }
      if (!ROLES.includes(role)) { sendJson(res, 400, { error: `Role must be one of: ${ROLES.join(", ")}` }); return; }
      if (password.length < 6) { sendJson(res, 400, { error: "Passwords must be at least 6 characters." }); return; }

      try {
        const created = await createUser({ username, password, role, displayName });
        console.log(`✓ ${user.username} created ${role} account "${created.username}"`);
        sendJson(res, 201, {
          user: {
            id: created.id, username: created.username, role: created.role,
            displayName: created.display_name, active: true, createdAt: created.created_at,
          },
        });
      } catch (err) {
        // The unique constraint is the only thing stopping duplicates, and it
        // surfaces as a raw Postgres 23505 — translate it before QA sees it.
        if (err?.code === "23505") sendJson(res, 409, { error: `"${username}" already exists.` });
        else throw err;
      }
      return;
    }

    if (path === "/api/users/password") {
      const username = normaliseUsername(body?.username);
      const password = String(body?.password || "");
      if (password.length < 6) { sendJson(res, 400, { error: "Passwords must be at least 6 characters." }); return; }
      const changed = await setPassword(username, password);
      if (!changed) { sendJson(res, 404, { error: `No account named "${username}".` }); return; }
      console.log(`✓ ${user.username} reset the password for "${username}"`);
      sendJson(res, 200, { ok: true, username });
      return;
    }

    if (path === "/api/users/active") {
      const username = normaliseUsername(body?.username);
      const active = Boolean(body?.active);
      // Locking yourself out mid-session is the one mistake this screen can
      // make irreversible from the UI — there would be no QA left to undo it.
      if (username === normaliseUsername(user.username) && !active) {
        sendJson(res, 400, { error: "You cannot disable your own account." });
        return;
      }
      const row = await setUserActive(username, active);
      if (!row) { sendJson(res, 404, { error: `No account named "${username}".` }); return; }
      console.log(`✓ ${user.username} ${active ? "enabled" : "disabled"} "${username}"`);
      sendJson(res, 200, { user: { username: row.username, role: row.role, active: row.active } });
      return;
    }

    if (path === "/api/users/update") {
      const oldUsername = normaliseUsername(body?.oldUsername);
      const username = normaliseUsername(body?.username);
      const role = String(body?.role || "writer");
      const displayName = String(body?.displayName || "").trim() || null;
      if (!username) { sendJson(res, 400, { error: "A username is required." }); return; }
      try {
        const row = await updateUser(oldUsername, { username, role, displayName });
        if (!row) { sendJson(res, 404, { error: `No account named "${oldUsername}".` }); return; }
        console.log(`✓ ${user.username} updated "${oldUsername}" to "${username}"`);
        sendJson(res, 200, { user: { username: row.username, role: row.role, active: row.active, displayName: row.display_name } });
      } catch (err) {
        if (err?.code === "23505") sendJson(res, 409, { error: `"${username}" already exists.` });
        else throw err;
      }
      return;
    }

    if (path === "/api/users/delete") {
      const username = normaliseUsername(body?.username);
      if (username === normaliseUsername(user.username)) {
        sendJson(res, 400, { error: "You cannot delete your own account." });
        return;
      }
      const deleted = await deleteUser(username);
      if (!deleted) { sendJson(res, 404, { error: `No account named "${username}".` }); return; }
      console.log(`✓ ${user.username} deleted "${username}"`);
      sendJson(res, 200, { ok: true, username });
      return;
    }

    sendJson(res, 404, { error: "Unknown users route." });
  } catch (err) {
    console.warn("⚠ user management failed:", err.message);
    sendJson(res, 500, { error: err.message || "Could not complete that." });
  }
}

async function handlePixAnalytics(req, res) {
  const user = await currentUser(req);
  const query = new URL(req.url, "http://localhost").searchParams;
  const result = await handlePixAnalyticsRequest({ user, query });
  sendJson(res, result.status, result.body);
}

/* Where the resolved session is parked for the rest of the request. A Symbol
   so it cannot collide with anything Node puts on the request object, and so
   nothing that enumerates the request picks it up. */
const REQUEST_USER = Symbol("pixSessionUser");

/* Resolved at most once per request. sessionUser() is a database round trip,
   and since the /api/* gate above resolves the session before dispatching,
   every handler that asks again would otherwise cost a second query — on
   /api/pix that is two per autosave, per open editor. `undefined` means "not
   looked up yet"; null is a real answer meaning nobody is signed in, so the
   check has to be against undefined rather than falsiness. */
async function currentUser(req) {
  if (req[REQUEST_USER] !== undefined) return req[REQUEST_USER];
  let user = null;
  try {
    const cookies = parseCookies(req.headers.cookie);
    user = await sessionUser(cookies[SESSION_COOKIE]);
  } catch (err) {
    // The caller cannot tell this apart from "not signed in", so the user just
    // gets bounced to the login screen. Name it in the log as what it is.
    console.warn(`⚠ session lookup failed (user will appear signed out): ${err.code || "no-code"} ${err.message}`);
    user = null;
  }
  req[REQUEST_USER] = user;
  return user;
}

/* Railway terminates TLS in front of the app, so req.socket is plain HTTP and
   only the forwarded header reveals the real scheme. Getting this wrong drops
   the cookie: Secure on http, or a session cookie sent in the clear. */
function requestIsSecure(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (forwarded) return forwarded === "https";
  return Boolean(req.socket?.encrypted);
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

async function handleLogin(req, res) {
  if (!dbConfigured()) {
    sendJson(res, 503, { error: "No database configured — logins are unavailable." });
    return;
  }

  let body;
  try {
    body = await readJson(req, { limit: 10_000 });
  } catch {
    sendJson(res, 400, { error: "Invalid request." });
    return;
  }

  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    sendJson(res, 400, { error: "Enter your username and password." });
    return;
  }

  const key = `${clientKey(req)}:${username.toLowerCase()}`;
  const gate = throttleCheck(key);
  if (!gate.allowed) {
    sendJson(res, 429, {
      error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minute(s).`,
    });
    return;
  }

  try {
    const session = await login({ username, password, userAgent: req.headers["user-agent"] });
    if (!session) {
      throttleRecordFailure(key);
      // One message for both a bad username and a bad password: naming which
      // was wrong tells an attacker which accounts exist.
      sendJson(res, 401, { error: "Incorrect username or password." });
      return;
    }

    throttleClear(key);
    res.setHeader("Set-Cookie", sessionCookie(session.token, {
      secure: requestIsSecure(req),
      expiresAt: session.expiresAt,
    }));
    sendJson(res, 200, { user: session.user });
  } catch (err) {
    // Log the code too. "Login is unavailable right now" is all the user gets,
    // so without this an intermittent failure leaves nothing to diagnose from.
    console.warn(`⚠ login failed for "${username}": ${err.code || "no-code"} ${err.message}`);
    sendJson(res, 503, { error: "Login is unavailable right now." });
  }
}

async function handleLogout(req, res) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    await logout(cookies[SESSION_COOKIE]);
  } catch { /* clearing the cookie is what matters */ }
  res.setHeader("Set-Cookie", clearedSessionCookie({ secure: requestIsSecure(req) }));
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res) {
  if (!dbConfigured()) {
    sendJson(res, 503, { error: "No database configured — logins are unavailable." });
    return;
  }
  const user = await currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Not signed in." });
    return;
  }
  sendJson(res, 200, { user });
}

async function handleFluxImage(req, res) {
  try {
    const falKey = env("FAL_KEY", "falKey");
    if (!falKey) {
      sendJson(res, 503, { error: "FAL_KEY is missing." });
      return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    const context = requestUrl.searchParams.get("context")?.trim() || "";
    if (!query) {
      sendJson(res, 400, { error: "A prompt is required." });
      return;
    }

    const prompt = buildFluxPrompt(query, context);
    const result = await runFalFlux(falKey, prompt);
    const images = (result.images || [])
      .map((image, index) => {
        const url = image.url;
        return {
          id: `flux-${result.seed || Date.now()}-${index}`,
          alt: query,
          preview: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          image: url,
          imageProxy: url ? `/api/image?url=${encodeURIComponent(url)}` : null,
          source: "flux",
        };
      })
      .filter((image) => image.preview && image.imageProxy);

    if (!images.length) {
      sendJson(res, 502, { error: "Flux returned no images." });
      return;
    }

    sendJson(res, 200, { images, source: "flux" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Flux image generation failed." });
  }
}

async function handleAnalyzeImage(req, res) {
  try {
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) {
      sendJson(res, 503, { error: "OPENAI_API_KEY is missing." });
      return;
    }

    const body = await readJson(req, { limit: 8_000_000 });
    const imageData = (body.imageData || "").trim();
    if (!imageData || !imageData.startsWith("data:image/")) {
      sendJson(res, 400, { error: "A base64 image data URL is required." });
      return;
    }

    const analysis = await analyzeImageWithOpenAI(apiKey, imageData);
    sendJson(res, 200, { analysis });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image analysis failed." });
  }
}

async function analyzeImageWithOpenAI(apiKey, imageData) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Analyze this product image for a poster background generator.",
              "Use OCR/text recognition carefully. Also identify repeated patterns, product type, packaging shape, colors, materials, logos, labels, icons, and visible brand cues.",
              "Return only compact JSON with these keys:",
              "visibleText: exact text strings you can read,",
              "productType: short product category,",
              "brandCues: short array,",
              "patterns: short array of visual patterns or repeated motifs,",
              "colors: short array,",
              "promptHints: one concise sentence for image generation.",
              "If no text is readable, visibleText must be an empty array. Do not guess unreadable text.",
            ].join(" "),
          },
          { type: "input_image", image_url: imageData, detail: "high" },
        ],
      }],
      max_output_tokens: 500,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || `OpenAI returned ${response.status}`;
    throw new Error(detail);
  }

  /* The Responses API reports usage under the same key with different field
     names; priceTextUsage() reads both spellings. */
  meterText(payload);
  const text = extractOpenAIOutputText(payload).trim();
  try {
    return normalizeImageAnalysis(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
  } catch {
    return normalizeImageAnalysis({ promptHints: text });
  }
}

function extractOpenAIOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function normalizeImageAnalysis(value) {
  const arrayOfStrings = (items) => Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    visibleText: arrayOfStrings(value.visibleText),
    productType: String(value.productType || "").trim().slice(0, 120),
    brandCues: arrayOfStrings(value.brandCues),
    patterns: arrayOfStrings(value.patterns),
    colors: arrayOfStrings(value.colors),
    promptHints: String(value.promptHints || "").trim().slice(0, 500),
  };
}

function buildFluxPrompt(query, context = "") {
  const parts = [
    "Create a high-quality editorial news background image.",
    `Subject: ${query}.`,
  ];
  if (context) {
    parts.push(`Use these product-image recognition details as visual guidance: ${context}.`);
    parts.push("Respect any readable product text exactly if it appears, and preserve the identified pattern/motif style without inventing fake labels.");
  }
  parts.push(
    "Photorealistic, dramatic but natural lighting, sharp focus, premium newsroom/social poster style.",
    "Do not add unrelated text, captions, fake logos, or watermarks.",
  );
  return parts.join(" ");
}

async function runFalFlux(falKey, prompt) {
  const response = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: {
      "Authorization": `Key ${falKey}`,
      "Content-Type": "application/json",
      "X-Fal-Store-IO": "0",
    },
    body: JSON.stringify({
      prompt,
      image_size: "portrait_16_9",
      num_images: 1,
      enable_safety_checker: true,
      output_format: "jpeg",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || payload.error || `fal returned ${response.status}`;
    throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg || item.message || String(item)).join("; ") : detail);
  }
  return payload;
}

async function tryBingImages(query, max) {
  try {
    // filterui:imagesize-wallpaper = extra large images only
    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-wallpaper&form=IRFLTR&first=1`;
    const response = await fetch(bingUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) return [];
    const html = await response.text();

    const results = [];
    const seen = new Set();
    const matches = html.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi);
    for (const m of matches) {
      if (results.length >= max) break;
      let url = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
      if (url.includes("bing.com") || url.includes("bing.net") || url.includes("microsoft.com")) continue;
      if (!isLikelyHighQuality(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const upgraded = upgradeImageUrl(url);
      results.push({
        id: results.length,
        alt: "Related Image",
        preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "bing"
      });
    }

    // If wallpaper size returned nothing, try large
    if (!results.length) {
      const fallbackUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large&form=IRFLTR&first=1`;
      const fbRes = await fetch(fallbackUrl, {
        headers: { "user-agent": USER_AGENT, "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }
      });
      if (fbRes.ok) {
        const fbHtml = await fbRes.text();
        const fbMatches = fbHtml.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/gi);
        for (const m of fbMatches) {
          if (results.length >= max) break;
          let url = m[1].replace(/\\u002f/gi, "/").replace(/\\u0026/gi, "&");
          if (url.includes("bing.com") || url.includes("bing.net") || url.includes("microsoft.com")) continue;
          if (!isLikelyHighQuality(url)) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          const upgraded = upgradeImageUrl(url);
          results.push({
            id: results.length,
            alt: "Related Image",
            preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
            image: upgraded,
            imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
            source: "bing"
          });
        }
      }
    }

    return results;
  } catch { return []; }
}

async function tryGoogleImages(query, max) {
  try {
    // tbs=isz:lt,islt:2mp = images larger than 2 megapixels
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&tbs=isz:lt,islt:2mp`;
    const response = await fetch(googleUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (!response.ok) return [];
    const html = await response.text();

    const results = [];
    const seen = new Set();
    const scriptMatches = html.matchAll(/\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",[0-9]+,[0-9]+\]/gi);
    for (const m of scriptMatches) {
      if (results.length >= max) break;
      let url = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\/\//g, "//");
      if (url.includes("gstatic.com") || url.includes("google.com") || url.includes("googleapis.com")) continue;
      if (url.includes("x-raw-image")) continue;
      if (!isLikelyHighQuality(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const upgraded = upgradeImageUrl(url);
      results.push({
        id: results.length,
        alt: "Google Image",
        preview: `/api/image?url=${encodeURIComponent(upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "google"
      });
    }
    return results;
  } catch { return []; }
}

async function tryDuckDuckGoImages(query, max) {
  try {
    const tokenRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { "user-agent": USER_AGENT }
    });
    if (!tokenRes.ok) return [];
    const tokenHtml = await tokenRes.text();
    const vqd = tokenHtml.match(/vqd=([\d-]+)/)?.[1];
    if (!vqd) return [];

    const ddgUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=size:Large&p=1`;
    const ddgRes = await fetch(ddgUrl, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" }
    });
    if (!ddgRes.ok) return [];
    const data = await ddgRes.json();

    return (data.results || []).filter(r => isLikelyHighQuality(r.image || "")).slice(0, max).map((r, i) => {
      const upgraded = upgradeImageUrl(r.image);
      return {
        id: i,
        alt: r.title || "DuckDuckGo Image",
        preview: `/api/image?url=${encodeURIComponent(r.thumbnail || upgraded)}`,
        image: upgraded,
        imageProxy: `/api/image?url=${encodeURIComponent(upgraded)}`,
        source: "duckduckgo"
      };
    });
  } catch { return []; }
}

async function handleScrape(req, res) {
  try {
    const { url: targetUrl } = parseScrapeRequest(await readJson(req, { limit: 10_000 }));
    const { html, finalUrl } = await fetchPublicHtml(targetUrl, { userAgent: USER_AGENT });
    const candidates = extractItems(html, new URL(finalUrl));
    const items = await enrichItems(candidates);
    sendJson(res, 200, { items });
  } catch (error) {
    sendScrapeError(res, error, "Scrape failed.");
  }
}

async function handleScrapeArticle(req, res) {
  try {
    const { url: targetUrl } = parseScrapeRequest(await readJson(req, { limit: 10_000 }));
    const { html, finalUrl } = await fetchPublicHtml(targetUrl, { userAgent: USER_AGENT });

    // Extract title: og:title > twitter:title > <title> tag
    let title = extractMetaContent(html, ["og:title", "twitter:title"]);
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? cleanupText(stripTags(titleMatch[1])) : "";
    }
    // Strip any leftover HTML tags and clean up
    title = cleanupText(stripTags(title));
    // Clean up common suffixes like " - BBC News", " | Times of India"
    title = title.replace(/\s*[-|–—]\s*[^-|–—]{2,30}$/i, "").trim();

    // Evaluate every useful declaration instead of trusting the first social
    // tag, which is often a logo, placeholder or low-resolution thumbnail.
    let image = extractBestArticleImage(html, finalUrl, { title });
    if (image) {
      image = upgradeScrapedImage(image);
      try {
        const selected = new URL(image);
        console.log(`[scrape] selected article image ${selected.hostname}${selected.pathname}`);
      } catch { /* already validated by the selector */ }
    } else {
      console.warn(`[scrape] no usable article image found for ${new URL(finalUrl).hostname}`);
    }

    if (!title) {
      sendJson(res, 422, { error: "Could not extract a title from this page." });
      return;
    }

    const metaDescription = extractMetaContent(html, ["og:description", "twitter:description", "description"]);
    const articleText = extractArticleText(html, title);

    // Entity-focused image search query via gpt-4o-mini (fail-soft). The old
    // client-side keyword extractor produced garbage like "KARAN JOHARS
    // DHARMA PRODUCTIONS SEALS" → sports photos for a Bollywood story.
    const imageQuery = await buildImageSearchQuery(title, articleText);

    const result = parseScrapeArticleResult({
      title: cleanupText(title),
      image: image || null,
      imageProxy: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
      sourceUrl: finalUrl,
      articleText,
      detailText: limitCharacters(articleText || metaDescription || title, TEXT_DETAIL_CHAR_LIMIT),
      imageQuery,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendScrapeError(res, error, "Article scrape failed.");
  }
}

function sendScrapeError(res, error, fallback) {
  const status = error instanceof ScrapeValidationError ? error.status : 500;
  sendJson(res, status, { error: error?.message || fallback });
}

/* Ask gpt-4o-mini for a 3-6 word image-search query: the names/entities a
   photo editor would search for. ~$0.0001, fails soft to "". */
async function buildImageSearchQuery(title, articleText = "") {
  if (!openaiApiKey || !title) return "";
  try {
    const r = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content:
            "You pick image-search queries for news posters. Given the story below, output ONLY a 3-6 word search query — the specific people, places or things a photo editor would search to find a fitting photo. Prefer full person names. No numbers, currencies, quotes or filler words.\n\n" +
            `Headline: ${title}\n` +
            (articleText ? `Article: ${articleText.slice(0, 500)}` : ""),
        }],
        temperature: 0.2,
        max_tokens: 24,
      }),
    });
    if (!r.ok) return "";
    const data = await r.json();
    meterText(data);
    const q = (data?.choices?.[0]?.message?.content || "")
      .replace(/["'\n]/g, " ").replace(/\s+/g, " ").trim();
    if (q) console.log(`✓ image query: "${q}"`);
    return q.slice(0, 80);
  } catch {
    return "";
  }
}

async function handleStockImages(req, res) {
  try {
    if (!pexelsApiKey) {
      sendJson(res, 503, { error: "Pexels API key is missing." });
      return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const query = requestUrl.searchParams.get("query")?.trim();
    if (!query) {
      sendJson(res, 400, { error: "A search query is required." });
      return;
    }

    const pexelsUrl = new URL("https://api.pexels.com/v1/search");
    pexelsUrl.searchParams.set("query", query);
    pexelsUrl.searchParams.set("per_page", "6");
    pexelsUrl.searchParams.set("orientation", "portrait");

    const response = await fetch(pexelsUrl, {
      headers: {
        Authorization: pexelsApiKey,
        "user-agent": USER_AGENT
      }
    });

    if (!response.ok) {
      sendJson(res, 502, { error: `Pexels returned ${response.status}.` });
      return;
    }

    const payload = await response.json();
    const images = (payload.photos || []).map((photo) => ({
      id: photo.id,
      alt: photo.alt || query,
      photographer: photo.photographer || "Pexels",
      pageUrl: photo.url,
      preview: photo.src?.medium || photo.src?.large || photo.src?.original,
      image: photo.src?.large2x || photo.src?.large || photo.src?.original,
      imageProxy: photo.src?.large2x || photo.src?.large || photo.src?.original
        ? `/api/image?url=${encodeURIComponent(photo.src?.large2x || photo.src?.large || photo.src?.original)}`
        : null
    })).filter((item) => item.preview && item.imageProxy);

    sendJson(res, 200, { images });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Image search failed." });
  }
}

async function handleImageProxy(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const target = requestUrl.searchParams.get("url");
    if (!target) {
      sendJson(res, 400, { error: "Image URL is required." });
      return;
    }

    const { buffer, contentType } = await fetchPublicImage(target, { userAgent: USER_AGENT });
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(buffer);
  } catch (error) {
    const status = error instanceof ScrapeValidationError ? error.status : 500;
    sendJson(res, status, { error: error.message || "Image proxy failed." });
  }
}

function extractItems(html, baseUrl) {
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const items = [];
  const seen = new Set();

  for (const match of matches) {
    const href = match[1]?.trim();
    const rawInner = match[2] ?? "";
    const title = cleanupText(stripTags(rawInner));
    if (!href || !looksLikeHeadline(title)) {
      continue;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (!looksLikeArticleUrl(absoluteUrl, baseUrl)) {
      continue;
    }

    const normalizedKey = `${normalizeText(title)}|${normalizeUrl(absoluteUrl)}`;
    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    items.push({
      title: trimTitle(title),
      url: absoluteUrl,
      image: extractImageUrl(rawInner, baseUrl)
    });

    if (items.length >= 16) {
      break;
    }
  }

  return items;
}

async function enrichItems(items) {
  const enriched = [];

  for (const item of items) {
    const next = { ...item };
    try {
      const { html, finalUrl } = await fetchPublicHtml(item.url, { userAgent: USER_AGENT });
      const metaTitle = extractMetaContent(html, ["og:title", "twitter:title"]);
      const metaImage = extractBestArticleImage(html, finalUrl, { title: metaTitle || next.title });
      if (metaTitle && looksLikeHeadline(metaTitle)) {
        next.title = trimTitle(cleanupText(metaTitle));
      }
      if (metaImage) {
        next.image = upgradeScrapedImage(metaImage);
      }
    } catch {
    }

    next.posterText = next.posterText || buildPosterText(next.title, "", "");
    next.keywords = next.keywords?.length ? next.keywords : extractKeywords(next.title, next.posterText);
    next.imageProxy = next.image ? `/api/image?url=${encodeURIComponent(next.image)}` : null;
    enriched.push(next);
  }

  return enriched.filter((item, index, array) => array.findIndex((candidate) => normalizeUrl(candidate.url) === normalizeUrl(item.url)) === index);
}

function extractMetaContent(html, names) {
  for (const name of names) {
    const propertyRegex = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const contentFirstRegex = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]*>`, "i");
    const match = html.match(propertyRegex) || html.match(contentFirstRegex);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

function extractImageUrl(htmlChunk, baseUrl) {
  const src = findAttributeValue(htmlChunk, ["src", "data-src", "data-lazy-src", "data-original"]);
  const srcset = findAttributeValue(htmlChunk, ["srcset", "data-srcset"]);
  const candidate = src || firstSrcFromSet(srcset);
  return candidate ? resolveMaybeRelative(candidate, baseUrl) : null;
}

function findAttributeValue(htmlChunk, names) {
  for (const name of names) {
    const regex = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
    const match = htmlChunk.match(regex);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function resolveMaybeRelative(value, baseUrl) {
  try {
    return new URL(value.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function firstSrcFromSet(value) {
  if (!value) {
    return null;
  }
  return value.split(",")[0]?.trim().split(/\s+/)[0] || null;
}

function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanupText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&hellip;/gi, "...");
}

function upgradeImageToHighestQuality(imageUrl) {
  try {
    const u = new URL(imageUrl);
    const host = u.hostname;

    // --- Cloudinary ---
    if (host.includes("cloudinary.com")) {
      // Replace upload transformations with just w_auto,q_auto:best
      u.pathname = u.pathname.replace(/\/upload\/[^/]+\//, "/upload/q_auto:best,f_auto/");
      return u.toString();
    }

    // --- imgix ---
    if (host.includes("imgix.net") || u.searchParams.has("ixid")) {
      u.searchParams.delete("w");
      u.searchParams.delete("h");
      u.searchParams.delete("fit");
      u.searchParams.delete("crop");
      u.searchParams.delete("q");
      u.searchParams.delete("auto");
      u.searchParams.set("q", "100");
      u.searchParams.set("auto", "format,compress");
      return u.toString();
    }

    // --- WordPress / Jetpack resize (e.g. ?resize=800,450 or ?w=800) ---
    if (u.searchParams.has("resize") || (u.searchParams.has("w") && !host.includes("twitter"))) {
      u.searchParams.delete("resize");
      u.searchParams.delete("w");
      u.searchParams.delete("h");
      u.searchParams.delete("fit");
      u.searchParams.delete("strip");
      u.searchParams.delete("quality");
      return u.toString();
    }

    // --- Times of India / HT Media (thumb/ in path) ---
    const toi = u.pathname.match(/^(.*?)\/thumb\/(\d+)x(\d+)(\/.*)?$/);
    if (toi) {
      u.pathname = toi[1] + (toi[4] || "");
      return u.toString();
    }

    // --- BBC / Akamai image service (/ichef/) ---
    if (host.includes("bbci.co.uk") || u.pathname.includes("/ichef/")) {
      u.pathname = u.pathname.replace(/\/\d+\//, "/1280/");
      return u.toString();
    }

    // --- Generic: strip common resize query params ---
    ["width", "height", "w", "h", "size", "quality", "q", "maxwidth", "maxheight", "scale"].forEach(p => {
      u.searchParams.delete(p);
    });

    return u.toString();
  } catch {
    return imageUrl;
  }
}

function looksLikeHeadline(value) {
  if (!value) {
    return false;
  }
  const text = cleanupText(value);
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length < 30 || text.length > 180) {
    return false;
  }
  if (words.length < 5 || words.length > 28) {
    return false;
  }
  if (/^(sign in|home|live|menu|search|open source|bbc news|british broadcasting corporation)$/i.test(text)) {
    return false;
  }
  return /[a-zA-Z]/.test(text);
}

function looksLikeArticleUrl(candidate, baseUrl) {
  const url = new URL(candidate);
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (url.origin === base.origin && (path === "/" || path === "")) {
    return false;
  }
  if (/\/(signin|account|weather|sport\/scores-and-fixtures|newsround)$/.test(path)) {
    return false;
  }
  return path.split("/").filter(Boolean).length >= 1;
}

function trimTitle(value) {
  return value.length > 110 ? `${value.slice(0, 107).trimEnd()}...` : value;
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function readJson(req, options = {}) {
  const limit = options.limit || 1_000_000;
  return new Promise((resolve, reject) => {
    // Collect Buffers and decode once at the end. Concatenating chunks as
    // strings decodes each one on its own, so a multi-byte character split
    // across a chunk boundary comes out as replacement characters — which for
    // a password with an accent means a correct one is rejected at random.
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Turn an OpenAI error body into something the user can act on.
 *
 * "OpenAI 401" on its own is useless — it doesn't distinguish a revoked key
 * from a malformed header from a key belonging to the wrong project. OpenAI
 * says which in the response body; surface it.
 */
function openaiErrorMessage(status, body) {
  let detail = "";
  try {
    detail = JSON.parse(body)?.error?.message || "";
  } catch {
    detail = String(body || "").slice(0, 200);
  }
  const low = detail.toLowerCase();

  if (status === 401) {
    if (low.includes("incorrect api key")) {
      return "OpenAI rejected this key as invalid. It was most likely revoked or regenerated — " +
             "create a fresh one at platform.openai.com/api-keys and update OPENAI_API_KEY.";
    }
    if (low.includes("no api key") || low.includes("provide an api key")) {
      return "OpenAI received no key. OPENAI_API_KEY is set but empty or malformed — " +
             "check for quotes or line breaks in the value.";
    }
    return `OpenAI rejected the key (401). ${detail}`.trim();
  }
  if (status === 429) {
    return low.includes("quota")
      ? "OpenAI quota exhausted — add credit at platform.openai.com/settings/organization/billing."
      : "OpenAI is rate-limiting this key. Wait a moment and retry.";
  }
  if (status === 403) {
    return `OpenAI denied access (403). The key may lack permission for this model. ${detail}`.trim();
  }
  if (status >= 500) return "OpenAI is having problems (5xx). Try again shortly.";
  return `OpenAI ${status}. ${detail}`.trim();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function extractArticleText(html, title = "") {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:header|footer|nav|aside|form|button)\b[\s\S]*?<\/(?:header|footer|nav|aside|form|button)>/gi, " ");

  const scopes = extractArticleScopes(stripped);
  const scoredScopes = scopes.map((scope, index) => {
    const paragraphs = extractParagraphCandidates(scope.html, title);
    const score = paragraphs.reduce((sum, item) => sum + item.score, 0) + scope.priority - index;
    return { paragraphs, score };
  });

  scoredScopes.sort((a, b) => b.score - a.score);
  const best = scoredScopes.find((scope) => scope.paragraphs.length >= 2) || scoredScopes[0];
  return (best?.paragraphs || []).slice(0, 10).map((item) => item.text).join(" ");
}

function extractArticleScopes(html) {
  const scopes = [];
  const scopePatterns = [
    { regex: /<article\b[^>]*>([\s\S]*?)<\/article>/gi, priority: 120 },
    { regex: /<main\b[^>]*>([\s\S]*?)<\/main>/gi, priority: 80 },
    { regex: /<(?:section|div)\b[^>]*(?:class|id)=["'][^"']*(?:article|story|content|entry|post|body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/gi, priority: 55 },
  ];

  for (const pattern of scopePatterns) {
    let match;
    while ((match = pattern.regex.exec(html)) !== null) {
      scopes.push({ html: match[1], priority: pattern.priority });
    }
  }

  scopes.push({ html, priority: 0 });
  return scopes;
}

function extractParagraphCandidates(scope, title) {
  const seen = new Set();
  const candidates = [];
  for (const match of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanupText(stripTags(match[1] || ""));
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const score = scoreArticleParagraph(text, title);
    if (score > 0) candidates.push({ text, score });
  }
  return candidates;
}

function scoreArticleParagraph(text, title = "") {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (text.length < 45 || text.length > 1200 || words.length < 8) return 0;
  if (title && normalizeText(title) === normalized) return 0;
  if (isBoilerplateParagraph(normalized)) return 0;

  const sentenceCount = (text.match(/[.!?](?:\s|$)/g) || []).length;
  const hasNewsTerms = /\b(said|according|reported|minister|police|court|government|company|team|match|official|source|agency|statement)\b/i.test(text);

  // Relevance: paragraphs that mention the story's own proper nouns (from
  // the title) far outrank generic page copy like author bios. "Ranbir
  // Kapoor" appearing in a paragraph is a much stronger signal than length.
  let overlapBonus = 0;
  if (title) {
    const titleNouns = (title.match(/\b[A-Z][a-zA-Z''-]{3,}\b/g) || [])
      .map((w) => w.toLowerCase())
      .filter((w, i, a) => a.indexOf(w) === i);
    const hits = titleNouns.filter((n) => normalized.includes(n)).length;
    overlapBonus = Math.min(hits, 3) * 140;
  }

  return Math.min(text.length, 320) + sentenceCount * 35 + (hasNewsTerms ? 80 : 0) + overlapBonus;
}

function isBoilerplateParagraph(normalized) {
  return /\b(privacy policy|cookie policy|cookies|terms of use|sign in|sign up|subscribe|subscription|advertisement|sponsored|newsletter|all rights reserved|copyright|follow us|read more|related stories|enable javascript|disable ad blocker|allow notifications|manage settings|accept all|our privacy policy has been revised|please review updated privacy policy|news desk|entertainment desk|sports desk|is a dynamic and dedicated team|team of journalists|bring the pulse|about the author|written by|contributed to this report|catch all the|stay updated with|download the app|for more (?:updates|news)|end of article)\b/i.test(normalized);
}

function limitWords(value, maxWords) {
  const words = cleanupText(value || "").split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function limitCharacters(value, maxChars) {
  const text = cleanupText(value || "");
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars + 1);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary > Math.floor(maxChars * 0.84) ? boundary : maxChars).trim();
}

function buildPosterText(title, metaDescription, articleText) {
  const source = cleanupText(metaDescription || articleText || title);
  const sentences = source.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  let summary = "";
  for (const sentence of sentences) {
    const candidate = `${summary} ${sentence}`.trim();
    if (candidate.length > 120) {
      break;
    }
    summary = candidate;
    if (summary.length >= 72) {
      break;
    }
  }
  const output = summary || source;
  return output.length > 120 ? `${output.slice(0, 117).trimEnd()}...` : output;
}

function extractKeywords(title, posterText) {
  const found = [];
  const phraseMatches = cleanupText(title).match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[A-Z]{2,})\b/g) || [];
  for (const match of phraseMatches) {
    const upper = match.toUpperCase();
    if (!STOPWORDS.has(upper) && !found.includes(upper)) {
      found.push(upper);
    }
    if (found.length >= 3) {
      return found;
    }
  }

  const frequency = new Map();
  for (const word of cleanupText(`${title} ${posterText}`).toUpperCase().match(/[A-Z]{3,}/g) || []) {
    if (STOPWORDS.has(word) || word.length < 4) {
      continue;
    }
    frequency.set(word, (frequency.get(word) || 0) + 1);
  }

  for (const word of [...frequency.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word)) {
    if (!found.includes(word)) {
      found.push(word);
    }
    if (found.length >= 4) {
      break;
    }
  }

  return found.slice(0, 4);
}

/* ── Twitter / X — Post poster image with caption ── */
async function handleTwitterPost(req, res) {
  /* Publishing to the org's X account is an irreversible external write with
     the same standing as a DailyMattr publish, so it takes the same review
     role rather than merely a session — a writer must not be able to put a
     poster in front of the audience without QA. Checked through canReview()
     (as handleDailyMattrPublish does) so a future review role inherits it
     instead of hitting a 403. Dormant today because TWITTER_* is unset and the
     503 below fires first; the gate goes in before those keys ever appear. */
  const user = await currentUser(req);
  if (!canReview(user?.role)) {
    sendJson(res, 403, { error: "Only QA or admin can post to X." });
    return;
  }
  if (!twitterClient) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Twitter not configured. Set TWITTER_* keys in .env." }));
    return;
  }

  try {
    const caption = decodeURIComponent(req.headers["x-caption"] || "").trim();
    if (!caption) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Caption header." }));
      return;
    }
    if (caption.length > 280) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Caption is ${caption.length} chars; max is 280.` }));
      return;
    }

    // Read raw PNG body into a buffer (10 MB safety cap)
    const MAX_BYTES = 10 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Image exceeds 10 MB." }));
        return;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 100) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty or invalid image body." }));
      return;
    }

    console.log(`→ Twitter post: ${buffer.length} bytes, caption "${caption.slice(0, 40)}…"`);

    // 1) Upload media (v1.1 endpoint, OAuth 1.0a)
    const mediaId = await twitterClient.v1.uploadMedia(buffer, { mimeType: "image/png" });

    // 2) Create tweet (v2) referencing the media
    const tweet = await twitterClient.v2.tweet({
      text: caption,
      media: { media_ids: [mediaId] },
    });

    const tweetId = tweet?.data?.id;
    const tweetUrl = tweetId ? `https://x.com/i/status/${tweetId}` : null;
    console.log(`✓ Tweet posted: ${tweetUrl}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tweetUrl, id: tweetId }));
  } catch (err) {
    const code = err?.code || err?.data?.status || err?.status || 500;
    const msg  = err?.data?.detail || err?.data?.errors?.[0]?.message || err?.message || "Twitter post failed.";
    console.error("✗ Twitter post error:", code, msg);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg, code }));
  }
}

/* ── OpenAI — generate AI tweet caption + hashtags from a headline ── */
async function handleGenerateCaption(req, res) {
  if (!openaiApiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OPENAI_API_KEY not set on server." }));
    return;
  }

  try {
    // Read JSON body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }

    const headline = (body.headline || "").trim();
    if (!headline) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'headline' in body." }));
      return;
    }

    const systemPrompt = [
      "You are a senior social-media editor at a news outlet. You write tweets that accompany a news image poster — the image already shows the headline, so the tweet adds VALUE on top.",
      "",
      "Goal: make people stop scrolling and engage.",
      "",
      "RULES (follow strictly):",
      "1. NEVER repeat the headline verbatim. Rewrite it as a hook: a sharp angle, a question, a striking fact, or a one-line takeaway.",
      "2. Write 1–2 short sentences. Punchy. Active voice. No filler words ('In a major development', 'It is reported that', etc.).",
      "3. Add 2–4 hashtags at the end, each highly relevant — mix one broad (e.g. #IndianPolitics) with one specific (e.g. #TamilNadu, #DMK). No #BreakingNews unless it actually is. Hashtags must be CamelCase, no spaces, no special chars.",
      "4. Total length ≤ 270 characters INCLUDING hashtags. Count carefully.",
      "5. Tone: neutral and professional for politics/conflict/tragedy. Conversational and curious for tech/business/culture. Light-hearted (still classy) for entertainment/sports.",
      "6. No emojis. No clickbait phrasing ('You won't believe…'). No moralizing. No editorializing on contested issues — stay factual.",
      "7. Output ONLY the final tweet text. No quotes, no labels, no preamble, no explanation.",
      "",
      "EXAMPLES of the style we want:",
      "",
      "Headline: \"Modi tables Finance Bill 2026 in Parliament amid opposition uproar\"",
      "Tweet: Finance Bill 2026 hits the floor — and the opposition isn't letting it pass quietly. Key clauses on capital gains and digital tax are already drawing fire. #FinanceBill2026 #Parliament #IndianPolitics",
      "",
      "Headline: \"Apple unveils Vision Pro 2 with 50% lighter design at WWDC\"",
      "Tweet: Apple's second swing at spatial computing is half the weight — and apparently twice the battery life. The price tag? Still TBD. #VisionPro2 #WWDC #Apple",
      "",
      "Headline: \"India crowned T20 World Cup champions after 11-year drought\"",
      "Tweet: 11 years. One trophy back home. India's T20 wait is over. #T20WorldCup #TeamIndia #Cricket"
    ].join("\n");

    const t0 = Date.now();
    const aiRes = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Headline:\n${headline}` },
        ],
        temperature: 0.8,
        max_tokens: 140,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: openaiErrorMessage(aiRes.status, errText) }));
      return;
    }

    const data = await aiRes.json();
    meterText(data);
    let caption = data?.choices?.[0]?.message?.content?.trim() || "";

    // Strip surrounding quotes if model added any
    caption = caption.replace(/^["“”']+|["“”']+$/g, "").trim();

    // Hard-trim to 280 just in case
    if (caption.length > 280) caption = caption.slice(0, 277) + "…";

    const ms = Date.now() - t0;
    console.log(`✓ AI caption (${ms}ms, ${caption.length} chars): "${caption.slice(0, 60)}…"`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ caption }));
  } catch (err) {
    console.error("✗ generate-caption error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Caption generation failed." }));
  }
}

/* ── OpenAI — full article package (headline + 3 bullets + tweet) ──
   Local-dev mirror of api/generate-article.js. Editorial rules live in the
   shared prompt below; keep both copies in sync when editing. */
/* == Editorial spec ==
   One place for the numbers that the prompt, the validator, the repair
   pass and the deterministic clamp all have to agree on. They used to be
   scattered literals, which is how a spec change silently half-lands. */
const BULLET_COUNT = 4;
const BULLET_MIN_CHARS = 115;
const BULLET_MAX_CHARS = 125;
// Slack the validator tolerates before paying for a repair round-trip.
// The floor sits close to the target because the model systematically
// UNDERSHOOTS: measured output landed at 90-111 against a 115-125 spec, and
// a floor of 100 let most of that through untouched.
const BULLET_SOFT_MIN = 110;
const BULLET_SOFT_MAX = 132;
// Character counts are something an LLM cannot actually measure, so the
// prompt also states a word target, which models track far more reliably.
// English news prose averages ~6.2 characters per word including the space.
const BULLET_MIN_WORDS = Math.round(BULLET_MIN_CHARS / 6.2);
const BULLET_MAX_WORDS = Math.round(BULLET_MAX_CHARS / 6.0);
const HEADLINE_MAX_CHARS = 90;

// The base prompt is register-agnostic; buildEditorialPrompt() appends the
// register-specific rules chosen per story.
const EDITORIAL_SYSTEM_PROMPT = [
  "You are a journalist and content writer for Shortly (@SHORTLY__NEWS), a Twitter/X-style news app. Given a source headline and, when available, the article text, produce a news package in STRICT JSON with this exact shape:",
  "",
  '{ \"headline\": string, \"bullets\": [string, string, string, string], \"tweet\": string, \"register\": string, \"flags\": [string] }',
  "",
  "CARD 1 — the \"headline\" field:",
  "- Witty, informative and curiosity-driven. Engaging and click-worthy.",
  "- Be SPECIFIC. Never vague or generic. Name the tournament, the year, the city, the amount, the person.",
  "- Strike the balance between intrigue and clarity: the reader should know what this is about AND want to swipe.",
  "- Mention the subject EARLY. The brand, person, institution or place appears near the beginning.",
  "- Use numbers only when they are central to the story (for example $2.4 billion, 20%, 1:778). Do not decorate with numbers that do not carry the story.",
  "- MATCH THE TONE TO THE STORY:",
  "  * HARD NEWS (courts, money, deaths, policy, disasters, crime, conflict): straightforward and informative. No wordplay, no wink, no playfulness.",
  "  * INFOTAINMENT or FEATURE: witty, playful, conversational. The kind of line that makes someone stop scrolling.",
  "- Avoid vague filler such as 'boosts sentiment', 'makes waves', 'set to change everything'.",
  `- Maximum ${HEADLINE_MAX_CHARS} characters, so it fits on the poster.`,
  "- Correct sentence capitalisation. No periods between initials (write MS Dhoni, PM, US, UK, never M.S. Dhoni).",
  "- Never reuse the headline's exact phrasing in the bullets.",
  "",
  `CARD 2 — the \"bullets\" field: EXACTLY ${BULLET_COUNT} bullet points.`,
  `- LENGTH: each bullet must be ${BULLET_MIN_WORDS} to ${BULLET_MAX_WORDS} words (${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters). Count the WORDS. A bullet of ${BULLET_MIN_WORDS - 4} words is too short and must be developed with more of the source detail, not padded with filler.`,
  "- INVERTED PYRAMID: bullet 1 carries the single most important fact. Each following bullet adds the next most important detail. Background and context come LAST, never first.",
  "- EVERY BULLET MUST CARRY A FACT THE OTHERS DO NOT — a different figure, name, date, place, cause, consequence or reaction. Four bullets restating one fact in different words is a failure even if each sentence is well written.",
  "- Prefer concrete detail from the source over summary: the amount, the deadline, the vote, the sample size, the institution, the date. If the source gives a number, a bullet should carry it.",
  "- Do NOT end every bullet with an attribution tag. Attribute where a claim genuinely needs a source, usually one or two bullets; state the rest as fact. Four 'researchers said' endings read as a template, not as reporting.",
  "- At most ONE hedge per sentence. 'Studies indicate that X may improve Y' hedges twice and commits to nothing. Write what was actually found.",
  "- Never pad to reach the length. If the source does not support four distinct bullets, write the most specific ones you can from what is there rather than repeating yourself.",
  "- PLAIN IS NOT SIMPLISTIC. Short sentences and precise, ordinary words — the register of a wire-service report, not of a childrens book. Never pad, never talk down, never explain the obvious.",
  "- Use the correct term rather than a vague substitute. If a term genuinely needs unpacking, gloss it in a short clause instead of replacing it.",
  "- Each bullet is ONE complete sentence ending in a full stop. Never cut off midway, never trailing off.",
  "- Attribute anything contested, forward-looking or opinionated to a named person, body or document, using the verb 'said'. Never 'claimed', 'admitted', 'conceded' or 'slammed' — those read as judgemental.",
  "- Active voice with strong verbs. Exact figures, dates and titles wherever the source has them; never 'a lot of', 'several' or 'recently' in their place.",
  "- No judgement adjectives (shocking, stunning, massive, historic). No exclamation marks. Third person throughout — never address the reader as 'you'.",
  "- No em dashes; let sentences flow naturally. No periods between initials (MS Dhoni not M.S. Dhoni).",
  "- Only use a direct quote when quoting verbatim, immediately followed by the person's name; otherwise rephrase in third person.",
  "- Strictly sourced from the provided material. No extrapolation, no outside knowledge.",
  "- Neutral, professional, British English.",
  "",
  "TWEET — the \"tweet\" field. Build it in three parts separated by newlines:",
  "- Part 1: one or two short sentences, maximum 200 characters including the call to action. Professional but Gen Z-friendly tone. Neutral, no political lean, no editorialising. No em dashes.",
  "- Part 2 (new line), exactly: Follow @SHORTLY__NEWS for more 👇",
  "- Part 3 (new line): relevant @handles and #hashtags, ALL in lowercase (for example @bcci @icc #indvsaus #t20worldcup). 3 to 6 tags, most specific first, no generic filler like #news or #trending.",
  "",
  "PEOPLE IDENTIFICATION:",
  "- On first mention of a person, add a brief identifier: their role, title or what they are known for (for example 'Sunil Mittal, chairman of Bharti Enterprises', not just 'Sunil Mittal'). Never assume the audience knows the name.",
  "",
  "EDITORIAL RULES:",
  "- Use ONLY the provided material. Never fabricate statistics, records or quotes, and never add outside knowledge.",
  "- If a headline claim is not supported by the article text, if the story is communal, religious, politically sensitive or otherwise unverified, or if it reads as older than yesterday, add a short note to flags. flags is an empty array when there is nothing to raise.",
  "- Both sides represented on political or contested stories. No one-sided framing.",
  "- Do not present promotional or sponsored content as news.",
  "- Safe reporting for deaths, suicide and tragedy: no method details, no sensationalising, neutral tone.",
  "",
  "EXAMPLE headline — hard news (straightforward, subject first, the number carries the story):",
  '- "RBI holds the repo rate at 6.5% for an eighth straight meeting"',
  "EXAMPLE headline — feature (playful, still specific):",
  '- "Amitabh Bachchan bought an Ayodhya plot in a single day"',
  "",
  `EXAMPLE bullets (${BULLET_COUNT}, inverted pyramid, each a complete sentence of ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters):`,
  '- "The Reserve Bank of India has kept its key interest rate at 6.5% for the eighth meeting in a row, holding steady again."',
  '- "Governor Shaktikanta Das said food prices remain unpredictable, so the bank is not ready to start cutting rates yet."',
  '- "Home and car loan borrowers will see no change to their monthly payments, with EMIs staying exactly where they are."',
  '- "The bank has now held rates steady for well over a year, after raising them sharply through 2022 to bring inflation down."',
  "",
  "Output ONLY the JSON object. No prose around it.",
].join("\n");

/**
 * Compose the system prompt for one story: the shared editorial spec plus the
 * register-specific rules for THIS story's type. A single fixed tone
 * instruction is what produced summaries that read as written for a child —
 * a court ruling and a film premiere need different registers, not the same
 * flattened one.
 */
function buildEditorialPrompt(register) {
  return EDITORIAL_SYSTEM_PROMPT +
    "\n\n" + registerRules(register) +
    "\n\nSet the \"register\" field in your JSON to the register you actually wrote in: " +
    "\"wire\" for hard news, \"feature\" for infotainment, \"explainer\" for technical stories. " +
    "Override the suggested register if the story is plainly a different type.";
}


// Spec: every @handle/#hashtag after the CTA line is lowercase. The model
// occasionally keeps official casing (@RBI) — enforce deterministically.
function lowercaseTagLines(tweet) {
  const lines = String(tweet).split("\n");
  const ctaIdx = lines.findIndex((l) => /follow\s+@shortly__news/i.test(l));
  if (ctaIdx >= 0) {
    for (let i = ctaIdx + 1; i < lines.length; i++) lines[i] = lines[i].toLowerCase();
  }
  return lines.join("\n");
}

// Keep the tweet ≤280 chars, trimming at whitespace so a trailing hashtag
// is never cut mid-word.
function clampTweet(s) {
  s = lowercaseTagLines(String(s).replace(/[ \t]+\n/g, "\n").trim());
  if (s.length <= 280) return s;
  let cut = s.slice(0, 280);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (boundary > 240) cut = cut.slice(0, boundary);
  return cut.trim();
}

// A bullet is "good" when it is a complete sentence inside the target band.
// The soft bounds are wider than the spec so a bullet that is only a few
// characters out is left alone rather than paying for a repair round-trip.
function bulletIsValid(b) {
  const t = String(b).trim();
  if (t.length < BULLET_SOFT_MIN || t.length > BULLET_SOFT_MAX) return false;
  if (!/[.!?]["')\]]?$/.test(t)) return false;
  const core = t.replace(/[.!?"')\]]+$/, "").trim();
  return !TRAILING_STOPWORDS.test(core);
}

const REGISTER_KEYS = ["wire", "feature", "explainer"];

/**
 * Rectification pass. Rewrites bullets that failed either the length check or
 * the tone check, told exactly which faults to fix and which register to
 * write in.
 *
 * Naming the specific faults matters: "make it more professional" is the kind
 * of instruction that makes a model rewrite everything and drift off the
 * facts. A list of concrete defects keeps the edit surgical.
 */
async function rectifyBullets({ headline, articleText, bullets, register, issues }) {
  const instruction = rectifyInstruction({
    issues,
    register,
    min: BULLET_MIN_CHARS,
    max: BULLET_MAX_CHARS,
    count: BULLET_COUNT,
    minWords: BULLET_MIN_WORDS,
    maxWords: BULLET_MAX_WORDS,
  });
  const prompt =
    instruction + "\n\n" +
    (headline ? `Headline: ${headline}\n` : "") +
    (articleText ? `Source article: ${articleText.slice(0, 900)}\n` : "") +
    "Bullets to rewrite:\n" + bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");

  try {
    const r = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        // Low temperature: this is a correction, not a fresh draft.
        temperature: 0.25,
        max_tokens: 800,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    meterText(data);
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    const b = Array.isArray(parsed.bullets)
      ? parsed.bullets.slice(0, BULLET_COUNT).map((x) => String(x).replace(/\s+/g, " ").trim())
      : null;
    return b && b.length === BULLET_COUNT && b.every(Boolean) ? b : null;
  } catch {
    return null;
  }
}

const TRAILING_STOPWORDS = /\s+(and|or|but|to|of|in|on|at|for|with|the|a|an|its|his|her|their|our|your|this|that|these|those|as|by|from|into|onto|over|under|about|after|before|while|amid|is|are|was|were|has|have|had|will|would|which|who|when|where|during|through|throughout|across|among|amongst|between|against|within|without|since|until|till|unless|though|although|because|per|via|upon|toward|towards|despite|beyond|near|off|out|up|down|than|then|so|yet|nor|if|nearly|almost|only|just|also|both|either|neither|whether|following|include|including)$/i;

// Last-resort deterministic trim, used only when the model and the repair
// pass both leave a bullet too long. It never cuts mid-sentence or mid-word:
// prefer the longest run of whole sentences that fits, else trim at a word
// boundary, strip any dangling conjunction, and close with a full stop so
// the result never reads as chopped.
function clampBullet(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  // Trim to the SPEC ceiling, not the tolerance ceiling. The soft bound
  // exists to decide whether a repair call is worth paying for; it should
  // not leak into the output, or every bullet between the spec max and the
  // tolerance shows red in the UI having never been touched.
  if (s.length <= BULLET_MAX_CHARS) return s;

  // Mask decimal points before splitting, or "6.5%" is treated as a
  // sentence end and the bullet gets truncated to "...at 6."
  const MASK = String.fromCharCode(0xE000);
  const masked = s.replace(/(\d)\.(\d)/g, `$1${MASK}$2`);
  const sentences = masked.match(/[^.!?]+[.!?]+/g) || [];
  let acc = "";
  for (const sen of sentences) {
    if ((acc + sen).trim().length <= BULLET_MAX_CHARS) acc += sen; else break;
  }
  acc = acc.split(MASK).join(".").trim();
  if (acc.length >= BULLET_MIN_CHARS - 25) return acc;

  let cut = s.slice(0, BULLET_MAX_CHARS - 2);
  const sp = cut.lastIndexOf(" ");
  if (sp > BULLET_MIN_CHARS - 45) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  while (TRAILING_STOPWORDS.test(cut)) cut = cut.replace(TRAILING_STOPWORDS, "").trim();
  cut = cut.replace(/[\s,;:.\-–—]+$/, "").trim();
  return cut ? cut + "." : cut;
}

async function handleGenerateArticle(req, res) {
  if (!openaiApiKey) {
    sendJson(res, 503, { error: "OPENAI_API_KEY not set on server." });
    return;
  }

  try {
    const body = await readJson(req);
    const headline = (body?.headline || "").trim();
    const sourceUrl = (body?.sourceUrl || "").trim();
    if (!headline) {
      sendJson(res, 400, { error: "Missing 'headline' in body." });
      return;
    }

    // Grounding is everything here. Without source text the model has only a
    // headline to work from, and it fills four bullets by restating that
    // headline behind hedges — which is exactly what "over-simplified" output
    // turns out to be. So prefer text the client already scraped, and only
    // re-fetch as a fallback.
    let articleText = String(body?.articleText || "").trim().slice(0, 6000);
    let grounding = articleText ? "client" : "none";

    if (!articleText && sourceUrl) {
      try {
        const { html } = await fetchPublicHtml(sourceUrl, { userAgent: USER_AGENT });
        const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
        const scope = articleMatch?.[1] || html;
        articleText = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
          .map((m) => cleanupText(stripTags(m[1] || "")))
          .filter((t) => t.length >= 50 && t.length <= 500)
          .filter((t) => !/^(sign up|read more|copyright|follow live|watch:|also read)/i.test(t))
          .slice(0, 10)
          .join("\n");
        if (articleText) grounding = "refetch";
      } catch { /* grounding is best-effort */ }
    }

    if (grounding === "none") {
      console.warn("\u26a0 generate-article has NO source text — bullets will be thin. Headline:", headline.slice(0, 60));
    } else {
      console.log(`\u2713 grounded via ${grounding} (${articleText.length} chars)`);
    }

    const userContent = articleText
      ? `Source headline:\n${headline}\n\nArticle text:\n${articleText}`
      : `Source headline:\n${headline}\n\n(No article text available — write from the headline only and flag that facts could not be verified against source text.)`;

    const t0 = Date.now();
    // Pick a register from the source before generating. This is only a hint —
    // the model returns the register it actually used and that value wins.
    const suggestedRegister = suggestRegister(headline, articleText);

    const aiRes = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildEditorialPrompt(suggestedRegister) },
          { role: "user", content: userContent },
        ],
        temperature: 0.6,
        max_tokens: 600,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      console.error(`✗ OpenAI ${aiRes.status}:`, errText.slice(0, 300));
      sendJson(res, 502, { error: openaiErrorMessage(aiRes.status, errText) });
      return;
    }

    const data = await aiRes.json();
    meterText(data);
    let parsed = {};
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { /* handled below */ }

    const out = {
      headline: (parsed.headline || "").slice(0, HEADLINE_MAX_CHARS),
      // Raw-normalize only (no clamp yet) so the repair pass sees full text.
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.slice(0, BULLET_COUNT).map((x) => String(x).replace(/\s+/g, " ").trim())
        : [],
      tweet: clampTweet(parsed.tweet || ""),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
      // Ship the spec with the payload so the UI can label counts without
      // keeping its own copy of these numbers in sync.
      // Surfaced so thin bullets are explainable rather than mysterious: if
      // sourceChars is 0 the model wrote from the headline alone.
      grounding,
      sourceChars: articleText.length,
      spec: {
        headlineMax: HEADLINE_MAX_CHARS,
        bulletCount: BULLET_COUNT,
        bulletMin: BULLET_MIN_CHARS,
        bulletMax: BULLET_MAX_CHARS,
      },
    };
    if (!out.headline || out.bullets.length < BULLET_COUNT || !out.tweet) {
      sendJson(res, 502, { error: "AI returned an incomplete package.", raw: parsed });
      return;
    }

    // The model reports the register it wrote in; fall back to our guess.
    const register = REGISTER_KEYS.includes(parsed.register) ? parsed.register : suggestedRegister;
    out.register = register;

    // Two independent failure modes, so two checks:
    //   length  — bullets outside the character band or reading as fragments
    //   tone    — writing that talks down, hedges, or drops attribution
    // The tone check is deterministic and free, so it costs nothing to run on
    // every request and only spends a model call when something is wrong.
    const lengthBad = out.bullets.some((b) => !bulletIsValid(b));
    const tone = assessTone(out.bullets, { register, sourceText: articleText || headline });

    if (lengthBad || !tone.ok) {
      if (!tone.ok) console.log(`⚠ tone (${register}):`, tone.issues.join(" | "));
      const issues = tone.issues.slice();
      if (lengthBad) {
        issues.push(`Some bullets are outside the ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} character range or do not end as complete sentences.`);
      }
      const repaired = await rectifyBullets({
        headline, articleText, bullets: out.bullets, register, issues,
      });
      if (repaired) {
        const after = assessTone(repaired, { register, sourceText: articleText || headline });
        console.log(`✓ bullets rectified (${register})${after.ok ? "" : " — residual: " + after.issues.join(" | ")}`);
        out.bullets = repaired;
        out.toneIssues = after.ok ? [] : after.issues;
      } else {
        // Rectification failed; surface what we found rather than pretending.
        out.toneIssues = tone.issues;
      }
    } else {
      out.toneIssues = [];
    }

    out.bullets = out.bullets.map(clampBullet);

    console.log(`✓ AI article (${Date.now() - t0}ms): "${out.headline}"`);
    sendJson(res, 200, out);
  } catch (err) {
    console.error("✗ generate-article error:", err);
    sendJson(res, 500, { error: err.message || "Article generation failed." });
  }
}

/* ── OpenAI — context-aware, identity-preserving background enhance ──
   Local-dev mirror of api/upscale-image.js. Two stages:
     1. gpt-4o-mini vision describes the photo (people, faces, text, setting)
     2. gpt-image-1 (quality=high, input_fidelity=high) enhances with that
        description embedded so it knows what it must NOT change. */

// The headline is deliberately NOT given to the image model.
//
// Image models treat a quoted string in the prompt as text to RENDER, so
// `It accompanies this news story: "<headline>"` reliably produced photos
// with the headline burned into them. The renderer already draws the
// headline on the canvas — the model never needs to know it.
/* Super-resolution and restoration — explicitly NOT a generation task.

   Framing matters to this model. Asked to "enhance", it reaches for
   "improve": it re-renders the subject, re-lights the scene, and returns a
   handsome picture of a slightly different person. Told that this is a
   restoration and super-resolution job and that generation is out of scope,
   it stays much closer to the pixels it was given.

   The constraints are enumerated per object — face, expression, beard, pose,
   microphone, jewellery, clothing folds, stage elements, lighting, shadows —
   because a general instruction to "preserve the photograph" is too abstract
   to bind. Naming the things in the frame is what makes it stick, and a hard
   source needs that most: a well-lit studio portrait survives a vague brief,
   a low-resolution concert shot under heavy stage lighting does not.

   Deliberately NOT included: instructions about typography, gradients,
   highlights, logos or card layout. The model never sees any of that. It is
   handed the bare photograph; the headline, the gradient and the badge are
   drawn onto the canvas afterwards, so a rule about them would be a rule
   about pixels that are not in the request. Text INSIDE the photograph —
   signage, a jersey, a banner — is a different thing and is covered. */
function buildEnhancePrompt(description, _headlineNotUsed, _ratioNoLongerUsed) {
  return [
    "You are a professional image restoration and super-resolution model.",
    "",
    "Upscale this exact photograph while preserving 100% of the original",
    "pixels, composition and subject identity.",
    "",
    "This is NOT an image generation task. Do not recreate, reinterpret or",
    "re-render the image. Restore it.",
    description ? `CONTEXT — the photo shows: ${description}` : "",
    "",
    "ENHANCE ONLY:",
    "- resolution",
    "- sharpness",
    "- natural detail already present in the capture",
    "- texture clarity",
    "- noise reduction",
    "- compression artifact removal",
    "",
    "STRICT PRESERVATION RULES:",
    "- Keep the exact same person's face and facial structure.",
    "- Keep the exact same expression, eyes, nose, beard, hairstyle and skin",
    "  detail. Do not beautify, smooth or idealise.",
    "- Keep the exact same pose and body proportions.",
    "- Keep microphones, instruments, jewellery, clothing folds and stage",
    "  elements unchanged in shape, position and detail.",
    "- Keep the exact same lighting, shadows and colour tone. Stage lights,",
    "  haze and coloured wash stay exactly as photographed.",
    "- Keep the background unchanged, including the shape of every light",
    "  source and reflection.",
    "- Preserve every existing logo, brand name, sign, label and watermark,",
    "  including lettering on buildings and products: same spelling, shapes",
    "  and colours, in the same place. Never erase, replace or simplify them;",
    "  leave unreadable lettering soft rather than inventing or completing it.",
    "",
    "IMAGE QUALITY TARGET:",
    "Professional DSLR photograph. Natural camera sharpness. Realistic skin",
    "texture with visible pores and imperfections. Fine hair detail. Clean",
    "fabric texture. High-resolution editorial news photography.",
    "",
    "DO NOT:",
    "- regenerate the person",
    "- beautify the face or change facial features",
    "- add or remove objects",
    "- change the background or the lighting",
    "- hallucinate detail that is not in the source",
    "- create plastic or AI-looking skin",
    "- oversharpen or apply artistic effects",
    "",
    "The output should look like the same photograph taken with a higher-end",
    "camera and lens. Same moment, same person, same light — more resolution.",
  ].filter(Boolean).join("\n");
}

/* ── Expand: the same photograph, taken from further back ──
   This is the job the restore prompt above spends its whole length forbidding,
   and the two must never be run through one another. Restore says "do not
   reframe"; expand says "reframe, outward, and draw what was never
   photographed". Which one runs is the writer's choice at the button, never a
   heuristic — a tight portrait that wants widening and a soft wire photo that
   wants sharpening are not distinguishable from the pixels.

   It was forbidden for a reason that no longer holds. When the enhance still
   composited — the model's output laid back over the original as a detail
   layer — an extended frame could not be aligned with the source, so
   outpainting printed a doubled outline and a band of invented background
   (c59b45a, ea99e81). That compositing was removed wholesale in d8bff9c: the
   model's output is now used exactly as it comes back. Nothing downstream
   needs the two frames to line up any more, so the constraint that killed
   this went with it.

   What is asked for, in the order the model drops it:

   - The given photograph must survive INSIDE the result, unchanged. This is
     what fails first. Asked to widen a picture, the model will happily redraw
     the middle of it too and return a handsome stranger wearing the right
     shirt. input_fidelity=high is the real control; the wording exists so the
     prompt does not argue with it.
   - The extension is anatomy before it is scenery. A subject cropped at the
     chest needs a torso that belongs to those shoulders, arms leaving at the
     angle they already leave at, and hands that are hands. The vision stage
     supplies the pose; this restates it as a brief so the model treats it as
     an instruction rather than as background colour.
   - No new people, no new objects of interest, no lettering. The margin is
     continuation, not invention. This is a newsroom: a face that was never in
     the room cannot appear in the picture, and a banner cannot grow a slogan.
   - The seam must not be findable. Same lens, same depth of field, same grain,
     same light — a widened photograph, not a photograph pasted onto a
     painting. */
const EXPAND_AMOUNTS = {
  slight:   "Pull back a little: show roughly 25% more of the scene around the subject than the photograph currently holds.",
  moderate: "Pull back: show roughly 50% more of the scene around the subject than the photograph currently holds.",
  wide:     "Pull back substantially: show roughly twice as much of the scene around the subject as the photograph currently holds.",
};

/* What the new margin should contain, per kind of picture.

   This is the part that had to exist before a logo could go through here at
   all. The extend prompt was written for press photographs of people, and on
   a wordmark every line of it is either useless or actively harmful: there is
   no anatomy to continue, no setting past the edge, and a blanket "add no text
   or graphics" aimed at stopping invented captions reads, on a picture that IS
   text and graphics, as an instruction not to draw the only thing there is.
   Asked to widen the boAt mark under those rules the model has no good move —
   so it returns the picture roughly as it found it, which is exactly the
   "it only enhanced it and didn't zoom out" that was reported.

   The three cases differ in what continuation even means:

     people   anatomy first. A subject cut at the chest needs the torso, arms
              and lap that belong to those shoulders, then the room around
              them. The original case.
     scene    no person to continue, so it is all setting: the street, the
              building, the landscape, the interior carrying on past the edge
              at the right perspective.
     graphic  a logo, wordmark, icon, screenshot, or a product on a plain
              background. NOTHING about the mark is continued — it is finished
              already. What continues is the FIELD it sits on: the flat
              colour, the gradient, the surface. The mark stays exactly as
              supplied, once, unrepeated, with no letterform touched.

   The graphic rules are the strict ones, and deliberately. The failure mode
   there is not a wrong-looking margin, it is a second half-drawn wordmark or
   an invented tagline under the logo — a fabricated brand asset, on a card
   that goes out with the newsroom's name on it. Extending a field of colour
   is a job with no room to invent; that is the job it is given. */
const EXPAND_SUBJECTS = {
  people: [
    "WHAT YOU DRAW IN THE NEW MARGIN:",
    "- Anatomy first. Where the frame cuts a person off, continue that person",
    "  correctly: the torso, arms, hands, lap, legs and feet that belong to the",
    "  visible head, shoulders and posture — in the clothing already visible,",
    "  continuing its colour, fabric and folds.",
    "- Then the setting: the same room, stage, street, seating, floor, wall or",
    "  sky continuing naturally past each edge, at the correct perspective and",
    "  scale.",
    "- Match the photograph exactly: the same lens character and perspective,",
    "  the same depth of field and focus falloff, the same grain and noise, the",
    "  same light direction, hardness and colour temperature.",
    "",
    "ABSOLUTE RULES:",
    "- Add NO new people. No extra faces, no bystanders, no crowd members the",
    "  photograph does not already show at its edge.",
    "- Add NO new objects of interest — nothing a caption would have to",
    "  mention. This is journalism, not art.",
    "- Add no NEW text or graphics in the new margin. Preserve every existing",
    "  logo, brand name, sign, label and watermark in the supplied photograph;",
    "  never erase, replace or simplify them.",
    "- Text physically present in the photograph (signage, jerseys, banners) is",
    "  preserved exactly as it already appears — never invented, completed,",
    "  translated or extended into the new margin.",
  ],
  scene: [
    "WHAT YOU DRAW IN THE NEW MARGIN:",
    "- The setting, continuing outward: the same street, building, interior,",
    "  landscape, sky or water carrying on past each edge at the correct",
    "  perspective, scale and vanishing point.",
    "- Structures continue as they are built. A roofline, a road, a railing or",
    "  a shoreline leaves the frame on a path — follow it, do not restart it.",
    "- Match the photograph exactly: the same lens character and perspective,",
    "  the same depth of field and focus falloff, the same grain and noise, the",
    "  same light direction, hardness and colour temperature, the same weather.",
    "",
    "ABSOLUTE RULES:",
    "- Add NO people. Not one figure, near or far, that the photograph does not",
    "  already show at its edge.",
    "- Add NO new objects of interest — no vehicles, no animals, no landmarks,",
    "  nothing a caption would have to mention. This is journalism, not art.",
    "- Add no NEW text or graphics in the new margin. Preserve every existing",
    "  logo, brand name, sign, label and watermark, including building signage;",
    "  never erase, replace or simplify them.",
    "- Text physically present in the photograph (signage, hoardings, number",
    "  plates) is preserved exactly as it already appears — never invented,",
    "  completed, translated or extended into the new margin.",
  ],
  graphic: [
    "THIS IS A LOGO, WORDMARK, ICON, SCREENSHOT OR PRODUCT SHOT — NOT A SCENE.",
    "",
    "WHAT YOU DRAW IN THE NEW MARGIN:",
    "- ONLY the background field the subject sits on, continuing outward: the",
    "  flat colour, the gradient, the paper, the fabric, the studio sweep or",
    "  the surface it rests on — seamlessly, at exactly the same tone, and with",
    "  the same softness or texture.",
    "- If it sits on a plain colour, the margin is that colour and nothing",
    "  else. An empty margin is the correct answer here. Do not decorate it.",
    "- If it casts a shadow or reflection, continue that shadow or reflection",
    "  consistently with the light already in the picture.",
    "",
    "ABSOLUTE RULES — these matter more here than anywhere else:",
    "- The mark, wordmark, icon, device or product is reproduced EXACTLY as",
    "  supplied: same shapes, same letterforms, same spacing, same weight, same",
    "  colours, same proportions. Do not redraw it. Do not clean it up. Do not",
    "  straighten or re-space it.",
    "- Draw it ONCE. No second copy, no reflection of it, no faded version of",
    "  it in the margin, no tiling, no pattern made out of it.",
    "- Write NO letters, words, numbers or symbols anywhere. Not a tagline, not",
    "  a slogan, not a registered mark, not a domain, not a strapline under the",
    "  logo, not a caption. If lettering is cut off at the edge of the supplied",
    "  image, LEAVE IT CUT OFF — a half-letter is correct and a guessed word is",
    "  a fabricated brand asset.",
    "- Add NO other logos, badges, icons, devices, borders, frames, rules,",
    "  glows, sparkles or decorative elements.",
    "- Add NO people, hands, props or scenery. This is not a photograph of a",
    "  place; do not turn it into one.",
  ],
};

/* The failure this whole route has, stated to the model as a prohibition.

   Every other rule in the expand prompt is about what the margin should
   CONTAIN. This one is about what the result must not BE. The model's
   preferred reading of "widen this picture" is not "show more of the scene",
   it is "make a picture that has this picture in it" — and it will happily
   satisfy every other constraint while doing so: no new people, no lettering,
   perfect fidelity to the source, all of it true of a photograph sitting on a
   table. The reported ghost was exactly that: the source shrunk into a
   hard-edged rectangle in the middle of an invented landscape, reading as a
   second image pasted over the first.

   So it is named, in the terms it gets rendered in — a print, a screen, a
   frame, a shadow, a second copy — rather than as the abstraction "do not
   composite", which binds nothing. The composited path below makes this
   structurally difficult too; this is what covers the case where the model
   decides to draw a picture frame around a region it was told not to touch. */
const EXPAND_NO_GHOST = [
  "THE ONE THING THIS MUST NOT BE:",
  "- The supplied image is not an OBJECT in the result. It is not a photo, a",
  "  print, a poster, a billboard, a canvas, a card, a screen, a phone, a",
  "  monitor or a television standing somewhere in a scene. It IS the scene,",
  "  seen closer. The margin is more of that same physical space, at the same",
  "  scale, in the same light.",
  "- Draw NO border, frame, mount, mat, edge, outline, drop shadow, glow,",
  "  rounded corner, bevel or vignette anywhere around it or across it.",
  "- Draw the subject ONCE. No second copy of it, no smaller repeat, no",
  "  reflection or mirror image of it, no thumbnail, no version of it hanging",
  "  on a wall or lying on a surface in the margin. If the surface it sits on",
  "  is glossy, the reflection stays as faint and as short as it is in the",
  "  supplied picture — never a second, upside-down subject.",
  "- Nothing in the margin may imply that the middle of the picture is a",
  "  separate image. One photograph, one continuous space, one subject.",
];

/* ── Expand: the same picture, seen from further back ──
   The prompt is assembled per subject because the three want different things
   in the margin — see EXPAND_SUBJECTS above. What they share is the part that
   fails first: the supplied image must survive INSIDE the result untouched.
   Asked to widen a picture, the model will happily redraw the middle of it too
   and come back with a handsome stranger wearing the right shirt, or a
   wordmark whose letters are subtly not the brand's. input_fidelity=high is
   the real control; the wording exists so the prompt does not argue with it.

   `composited` is the difference between asking and telling, and it is the
   fix for the ghost.

   FALSE is the old shape of this prompt: the model is handed the bare source
   and told, in English, to "place the supplied photograph smaller within the
   output frame". That sentence is a generation instruction and gets obeyed as
   one — the model renders a scene and puts a picture in the middle of it. It
   is kept only for the legacy single-shot path, which has no way to build a
   frame, and that path now degrades to restore rather than run this. See the
   note above handleUpscaleImage().

   TRUE means the caller has already done the placing: the source is composited
   onto a transparent canvas of exactly the output size, centred where it
   should sit, with the margin left empty, and an alpha mask marks that margin
   as the only paintable region. There is no placement left to ask for, so the
   prompt does not ask — it describes the empty area and what belongs in it.
   The geometry is a fact before the model sees it, which is the only way it
   has ever been reliable. */
function buildExpandPrompt(description, ratioLabel, amount = "moderate", subject = "people", composited = false) {
  const pullBack = EXPAND_AMOUNTS[amount] || EXPAND_AMOUNTS.moderate;
  const kind = EXPAND_SUBJECTS[subject] ? subject : "people";
  const isGraphic = kind === "graphic";

  /* What the model is being handed, and it is not the same thing in the two
     cases. Composited, the input is already the output frame with a hole in
     it; the job is to fill the hole. Uncomposited, the input is the picture
     and the frame does not exist yet. Getting this sentence wrong is worse
     than leaving it out — a model told to fill an empty margin on an image
     that has none will invent one. */
  const task = composited
    ? [
        "TASK:",
        "The image you have been given is ALREADY the final frame. The sharp",
        "picture in the middle of it sits at exactly the size and position it",
        "must keep. The area around it is a BLURRED, LOW-DETAIL PLACEHOLDER —",
        "the same photograph smeared out to fill the frame. It is scaffolding,",
        "not content. Replace it.",
        isGraphic
          ? "Replace the blurred area with the background the subject actually sits on, continuing outward to every edge at its real tone and texture."
          : "Replace the blurred area with the scene continuing outward from the sharp picture's edges, so that more of the subject and more of the setting are visible than the sharp picture shows — drawn at the same focus and detail as the sharp picture, not left soft.",
        "Cover it completely, right to every edge and into every corner. Return",
        "a fully opaque image: no transparency anywhere, at any point.",
      ]
    : [
        "TASK:",
        isGraphic
          ? "Place the supplied image smaller within the output frame, centred, and fill everything around it by continuing the background it already sits on."
          : "Place the supplied photograph smaller within the output frame and draw the scene continuing outward from its edges, so that more of the subject and more of the setting are visible than the photograph shows.",
        pullBack,
        ratioLabel
          ? `The output frame is ${ratioLabel}. Fill it completely — the subject stays fully visible and central, never cropped, stretched or distorted.`
          : null,
      ];

  return [
    isGraphic
      ? "You are extending the background of a REAL brand or product image so it fills a taller frame."
      : "You are extending a REAL news photograph — the same photograph, taken",
    isGraphic ? null : "from further back with a wider lens.",
    "",
    description ? `CONTEXT — the image shows: ${description}` : null,
    "",
    ...task,
    "",
    "THE SUPPLIED IMAGE IS UNCHANGED:",
    isGraphic
      ? "- Every pixel of the supplied image appears in the output exactly as it is: the same shapes, colours, edges and proportions."
      : "- Everything visible in the input appears in the output exactly as it is:",
    isGraphic ? null : "  the same faces and facial structure, the same expressions, the same skin",
    isGraphic ? null : "  texture and age, the same hair, the same clothing, the same objects, the",
    isGraphic ? null : "  same light falling on them.",
    isGraphic ? null : "- Do not beautify, smooth, slim, re-light or re-pose anyone.",
    "- Do not shift, rotate, straighten or rescale what you were given relative",
    "  to itself. It is the middle of the new picture; you are drawing around it.",
    "",
    ...EXPAND_SUBJECTS[kind],
    "- No visible seam, border, frame, vignette, change in sharpness or change",
    "  in brightness, colour or tone where the supplied image ends and the",
    "  drawn margin begins. A surface that crosses that edge — a table, a",
    "  floor, a wall, the sky — keeps exactly the same shade on both sides of",
    "  it. Blend the margin into the outermost edge of the picture.",
    "",
    ...EXPAND_NO_GHOST,
    "",
    isGraphic
      ? "The result is the same mark on a larger field of its own background. Nothing added, nothing written, nothing invented."
      : "The result is one clean, believable press photograph of the same moment,",
    isGraphic ? null : "shot wider. No lettering, no collage, no picture-in-picture, no illustration.",
  ].filter((line) => line !== null).join("\n");
}

/* ── Reframe: ask the model for the whole picture, at the shape we want ──────

   This is the job that a reviewer got from ChatGPT by typing "make this image
   9:16" at it, and it came back better than anything this route was producing.
   Same model. The difference was never capability, it was everything we were
   piling on top of it.

   What expand does: composite the source into a frame, mask it, hand the model
   a picture that is half sharp photograph and half blurred scaffolding, and
   spend sixty lines of prompt forbidding it to touch the middle. What comes
   back is the margin, bolted to the original along a seam. Every failure this
   route has had — the doubled subject, the framed print, the smeared sky — was
   a failure of that bolting, not of the model's imagination.

   What reframe does: hand over the picture and ask for it at the poster's
   shape. No mask, no composite, no paste-back, and a prompt short enough that
   the model is not arguing with it. The model re-renders the whole frame,
   which is precisely what it is good at.

   THE COST, AND IT IS NOT SMALL: the output is a REGENERATION. Faces, tattoos,
   jewellery, signage — all redrawn, recognisably the same and not identically
   the same. On the promotional art this product mostly handles, that is
   invisible and the result is better. On a news photograph of a real person it
   is a fabrication with a masthead on it, and `input_fidelity: high` narrows
   that gap without closing it. That is why this is a job the reviewer picks,
   sitting next to one that cannot alter a pixel, and why the UI says so.

   The prompt is deliberately SHORT. The long one is not more careful, it is
   more contradictory: "extend outward" and "change nothing" in the same
   breath, forty prohibitions deep, is how you get a model that hedges by
   handing back what it was given. */
function buildReframePrompt(description, ratioLabel, subject = "people") {
  /* Kept to what a person types. "Upscale and reframe it to 9:16 ratio" at
     ChatGPT, on the same model, returned a cleaner picture than any long
     brief this route has carried — the long ones argue with themselves
     ("extend outward", "change nothing") and the model hedges. What is
     added below is only what a newsroom cannot leave to chance. */
  const ratio = ratioLabel || "9:16";
  return [
    `Upscale this image and reframe it to a ${ratio} ratio.`,
    "",
    description ? `The image shows: ${description}` : null,
    "",
    `Show the same scene from the same viewpoint, filling the ${ratio} frame`,
    "edge to edge by continuing the setting naturally beyond the current",
    "edges. Photorealistic, sharp and detailed, in the same light.",
    "",
    subject === "graphic"
      ? "Keep the mark, its letterforms, colours and proportions exactly as they are, drawn once, on more of its own background."
      : "The people are the same people: same faces, expressions, hair, clothing and pose.",
    "Preserve all existing logos, brand names, signs, labels, text and watermarks, including those on buildings, clothing and products: same spelling, letterforms, colours and placement on the original surface. Never erase, replace or simplify them, even when blurred.",
    "Do not add people or NEW text, captions, logos or watermarks. No border,",
    "frame or picture-in-picture — one continuous image.",
  ].filter((l) => l !== null).join("\n");
}

/* The SOURCE's shape, never the poster's.

   Asking for the poster ratio is what produced the overlay. A landscape photo
   requested as 1024x1536 cannot be returned as itself — the model has to place
   it inside a taller canvas and invent the rest, which it does by generating a
   background and blending a re-rendered subject into it. That compositing IS
   the doubled image people were seeing, and it also contradicts the
   input_fidelity=high flag set two lines later, which exists to preserve
   composition. The request was telling the model to keep the framing and to
   change it at the same time.

   Framing belongs to the poster canvas, which crops and pans under the
   writer's control using real pixels. The model's only job here is detail. */
function sizeForRatio(_posterRatioNoLongerUsed, orientationHint, sourceW = 0, sourceH = 0) {
  /* A square source belongs at 1024x1024, and it is also the cheapest shape
     OpenAI sells — $0.034 against $0.05 at medium. The browser only ever
     reports "landscape" or "portrait" (`rawW >= rawH`, app.js), so without
     this a square logo was billed at 1536x1024 AND asked to grow sideways.
     Read from the real pixel dimensions, not the poster: the poster's ratio
     driving size is the overlay bug this whole function exists to prevent. */
  if (sourceW > 0 && sourceH > 0) {
    const aspect = sourceW / sourceH;
    if (aspect > 0.95 && aspect < 1.05) return "1024x1024";
  }
  if (orientationHint === "landscape") return "1536x1024";
  if (orientationHint === "portrait")  return "1024x1536";
  // Unknown: let the model match the input rather than guess from the poster.
  return "auto";
}

/* What the poster canvas will DISCARD if this picture is used as it is.

   drawCoverImage() scales the picture to cover the frame — Math.max(W/w, H/h)
   — and clips whatever hangs over. So a source whose shape differs from the
   poster's does not get letterboxed, it gets cut, and the cut is total: a
   square logo on a 9:16 poster loses 44% of its width, a 16:9 press photo
   loses 68% of it. That is the complaint this answers. A writer uploads a
   rectangle or a square, the canvas takes a tall slice out of the middle, and
   most of the picture — most of a wordmark, most of a product — is simply
   gone.

   Returned as a fraction so the planner is handed the number rather than
   asked to estimate it from two dimensions and a ratio string. Models are
   poor at that arithmetic and excellent at using it once it is stated, and
   this particular number is the difference between "the framing is a bit
   tight" and "you are about to bin two thirds of this picture".

   0 when anything needed is missing or unparseable — an unknown loss must not
   read as a catastrophic one. */
const RATIO_VALUES = { "9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9 };

function coverCropLoss(sourceW, sourceH, posterRatio) {
  const target = RATIO_VALUES[posterRatio];
  if (!target || !sourceW || !sourceH) return 0;
  const source = sourceW / sourceH;
  // Cover keeps the smaller of the two aspects' worth of the larger dimension.
  // Whichever way round they are, the survivor is min/max.
  return 1 - Math.min(source, target) / Math.max(source, target);
}

/* The POSTER's shape — the opposite choice from sizeForRatio() above, and
   deliberately so.

   Restore asks for the source's shape because any difference forces the model
   to invent. Expand asks for the poster's shape because the invention is the
   whole point: a landscape photograph requested at 1024x1536 has to grow
   downward, and downward is where the rest of a seated subject is. Asking for
   the source's shape here would leave nothing to extend into, and the button
   would hand back the picture it was given.

   These are gpt-image's three output shapes; there is no 4:5 or 9:16, so each
   poster ratio maps to the nearest one and the poster canvas trims the rest —
   off a frame that now has margin to spare, which is the point of the
   exercise. */
function sizeForExpand(ratio, orientationHint) {
  switch (ratio) {
    case "9:16":
    case "4:5":  return "1024x1536";
    case "1:1":  return "1024x1024";
    case "16:9": return "1536x1024";
  }
  // No poster ratio supplied: widen within the source's own orientation
  // rather than guess at a shape the writer never chose.
  if (orientationHint === "landscape") return "1536x1024";
  if (orientationHint === "portrait")  return "1024x1536";
  return "auto";
}

/* ── Deciding which job the picture needs ──
   Restore and expand were originally two buttons because of an argument that
   does not survive contact with this pipeline: that nothing in the pixels
   distinguishes a photograph that wants widening from one that wants
   sharpening, so a person has to choose. That is true of a HEURISTIC — of
   anything reasoning from dimensions and file size. It is not true of a model
   that looks at the picture, and there has been one in stage 1 of this route
   all along, describing the photograph before the edit call. It was being
   asked what the photograph contains and not what it needs.

   So it is asked both, in the same call. This costs nothing extra: the
   describe already ran, its answer is already the context the edit prompt is
   built from, and a verdict is a few more tokens on a response that was
   already being paid for. Two calls would have been the wasteful design.

   What it weighs, and the second one is the part a person tends to miss:

     framing   is a subject cut off where it hurts — at or above the chest, or
               pressed into an edge — and would filling the poster's shape crop
               away the subject or the context that makes the picture mean
               something? That is the case for expand.
     detail    is the framing already right for the poster, with the picture
               only soft, noisy or small? That is the case for restore.
     cost      expanding SHRINKS the subject. The output is a fixed 1024x1536
               either way, so a photograph placed at 60% of the frame keeps
               about 60% of its former resolution on the face, and a source
               that was already small comes back worse than it went in. A
               tight crop of a low-resolution photo is the hard case, and the
               answer there is usually restore, or slight.

   The verdict is advisory in exactly one direction: it can only choose
   between the two jobs the caller already paid for. It cannot decline to run,
   cannot pick a model, and cannot spend anything.

   Fails soft, in the same way and for the same reason as the describe it
   replaces: a vision stage that is down must not take the enhance down with
   it. No JSON, bad JSON, an unknown verdict or a dead endpoint all land on
   restore with an empty description — the conservative half of the pair, and
   the behaviour this route had before any of this existed. */
function buildPlanPrompt(posterRatio, sourceW, sourceH, cropLoss) {
  const shape = sourceW && sourceH
    ? `The image is ${sourceW}x${sourceH} pixels.`
    : "The image's pixel dimensions are unknown.";

  /* The crop, stated rather than implied. Given the ratio and the dimensions
     a model will happily reason about whether the shapes "roughly match" and
     be wrong by half; given "62% of this picture will be discarded" it stops
     guessing. This one number is what makes a square logo on a 9:16 poster an
     obvious expand instead of a judgement call. */
  const pct = Math.round(cropLoss * 100);
  const crop = posterRatio
    ? (cropLoss > 0.02
        ? `It goes on a ${posterRatio} poster. The poster scales the image to COVER the frame and clips the overflow — it does not letterbox — so used as it is, about ${pct}% of this picture will be cut away and never seen.`
        : `It goes on a ${posterRatio} poster, and its shape already matches, so almost nothing would be cropped.`)
    : "The poster's shape is unknown; assume the image's own shape is kept.";

  return [
    "You are the first stage of an image pipeline for a news organisation.",
    "The picture may be a photograph, or it may be a logo, a wordmark, a",
    "screenshot or a product shot — writers upload all of these. Look at it",
    "and do three things.",
    "",
    shape,
    crop,
    "",
    "1. SAY WHAT KIND of picture it is, as \"subject\":",
    "   \"people\"   one or more people are the subject.",
    "   \"scene\"    no people: a place, building, street, landscape, interior,",
    "               object or animal, photographed.",
    "   \"graphic\"  a logo, wordmark, icon, badge, app screenshot, chart, or a",
    "               product photographed on a plain or studio background. If",
    "               the picture is mostly a designed mark rather than a",
    "               photographed moment, it is \"graphic\".",
    "",
    "2. DESCRIBE it, factually and precisely, in 4-6 short sentences.",
    "   For \"people\": count, apparent age, facial hair, glasses, expression,",
    "   and exactly what they are wearing including colours and fabric; WHERE",
    "   the frame cuts each person off (for example 'cropped at mid-chest',",
    "   'legs out of frame below the knee'), and the posture and orientation of",
    "   the body — seated or standing, leaning, turned, which way the arms and",
    "   shoulders angle; the setting and what plausibly continues past each",
    "   edge; the lighting and camera look.",
    "   For \"scene\": what the place is, what occupies each edge, what would",
    "   plausibly continue past it, the perspective, and the light and weather.",
    "   For \"graphic\": what the mark or product is and its colours and shape;",
    "   EXACTLY what the background is — flat colour, gradient, paper, studio",
    "   sweep, surface — and its tone; how much empty room sits between the",
    "   mark and each edge; and whether anything is cut off at an edge.",
    "   If words or lettering appear, say only WHERE they sit and how large.",
    "   Do NOT transcribe or quote them. Do NOT guess names or brands.",
    "",
    "3. DECIDE which of two jobs this picture needs.",
    "",
    "   \"expand\" — the FRAME is the problem. The image is placed smaller in the",
    "   output and the background or scene is drawn outward to fill it. Choose",
    "   this when any of these is true:",
    "     - a large share of the picture would be cropped away by the poster —",
    "       the percentage above is the measure, and anything over about 20% is",
    "       on its own a strong reason to expand, because the alternative is",
    "       losing that much of the picture outright;",
    "     - a person is cut off where it hurts (at or above the chest, or a head",
    "       close to the top edge), or the subject is pressed against an edge;",
    "     - a logo, mark or product fills its frame edge to edge with no room",
    "       around it, so the poster would slice through it.",
    "",
    "   \"restore\" — the frame is fine and the PICTURE is the problem: soft,",
    "   noisy, small, or full of compression artifacts. Nothing is reframed;",
    "   detail is recovered.",
    "",
    "   Weighing the two:",
    "     - When the shapes MISMATCH, expand almost always wins. Cropping",
    "       discards real picture permanently; expanding keeps all of it and",
    "       adds margin that can be plain. This is true for logos and product",
    "       shots especially — a square mark on a tall poster must be expanded,",
    "       never cropped, and its margin is simply more of its own background.",
    "     - When the shapes ALREADY MATCH and you would only be pulling back for",
    "       composition, be conservative. The output is a fixed size, so placing",
    "       the picture smaller inside it leaves fewer pixels on the subject",
    "       than it already has. If the source is under about 900 pixels on its",
    "       long edge, prefer \"restore\", or \"slight\" at most.",
    "     - When the framing genuinely works, prefer \"restore\": it is the job",
    "       that cannot invent anything.",
    "",
    "4. If the verdict is \"expand\", say how far to pull back:",
    "   \"slight\"   about 25% more scene — a little breathing room, or a small",
    "               source, or a shape close to the poster's already.",
    "   \"moderate\" about 50% more — the usual answer: a subject cut at the",
    "               chest, or a moderate shape mismatch.",
    "   \"wide\"     roughly twice — a very tight crop, or a shape far from the",
    "               poster's (a square or landscape image on a tall poster),",
    "               where a lot of margin has to be built.",
    "   If the verdict is \"restore\", set amount to \"slight\"; it is ignored.",
    "",
    "Answer as JSON, and nothing else:",
    '{"subject": "people" | "scene" | "graphic", "description": "...", "verdict": "restore" | "expand", "amount": "slight" | "moderate" | "wide", "reason": "one short sentence, plain English, naming what you saw"}',
  ].join("\n");
}

async function planEnhance(buffer, mime, { posterRatio = "", sourceW = 0, sourceH = 0 } = {}) {
  // What every failure below returns. Restore is the half of the pair that
  // reframes nothing, so a broken planner degrades to the safe job rather
  // than to an outpaint nobody asked for.
  const fallback = { mode: "restore", amount: "moderate", subject: "people", description: "", reason: "", decidedBy: "fallback" };
  const cropLoss = coverCropLoss(sourceW, sourceH, posterRatio);
  try {
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
    const r = await fetchWithDeadline("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: buildPlanPrompt(posterRatio, sourceW, sourceH, cropLoss) },
            /* "low" is a 512px thumbnail, and that is the right input for this
               question. Framing — where a body is cut, how much room is around
               it, how the shape sits against the poster's — survives the
               downscale intact. Grain and pore detail do not, and are not what
               is being judged. */
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
          ],
        }],
        // Asking for JSON rather than parsing prose out of a sentence. The
        // verdict drives which prompt runs, so it has to be a value, not an
        // interpretation.
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 500,
      }),
    });
    if (!r.ok) {
      console.warn(`⚠ enhance planner failed (${r.status}) — restoring without context`);
      return fallback;
    }
    const data = await r.json();
    meterText(data);
    const raw = data?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("⚠ enhance planner returned unparseable JSON — restoring without context");
      return fallback;
    }

    const verdict = String(parsed?.verdict || "").toLowerCase();
    const amount = String(parsed?.amount || "").toLowerCase();
    const subject = String(parsed?.subject || "").toLowerCase();
    return {
      /* Which extend prompt to build if this expands. Unrecognised falls to
         "people", the original case and the most heavily constrained of the
         three — it forbids adding text, objects and figures, so a graphic
         mislabelled into it comes back conservative rather than decorated. */
      subject: ["people", "scene", "graphic"].includes(subject) ? subject : "people",
      // Anything but a clean "expand" is a restore. An unrecognised verdict is
      // a planner that misunderstood the question, and the answer to that is
      // the job that cannot invent anything.
      mode: verdict === "expand" ? "expand" : "restore",
      amount: ["slight", "moderate", "wide"].includes(amount) ? amount : "moderate",
      description: String(parsed?.description || "").trim(),
      reason: String(parsed?.reason || "").trim().slice(0, 200),
      decidedBy: "ai",
    };
  } catch (e) {
    console.warn("⚠ enhance planner error — restoring without context:", e.message);
    return fallback;
  }
}

/* ── AI Enhance ──────────────────────────────────────────────────────────
   One route, three entry points, picked by X-Enhance-Stage.

     plan   Look at the picture and answer what it needs: restore or expand,
            how far to pull back, what kind of subject it is, and — the part
            that matters below — the exact output size the caller must build
            for. Cheap (gpt-4o-mini), spends no image credits, returns no
            picture. All of the deciding happens here; the edit stage only
            executes what it was told.

     edit   Do the job. Multipart: `image`, an optional alpha `mask`, and the
            plan echoed back as fields so stage 1 is not paid for twice.

     (none) Legacy single-shot — plan and edit in one call, raw image body.
            It cannot composite a frame or supply a mask, so an expand verdict
            degrades to restore rather than outpainting blind.

   WHY THE SPLIT — this is the ghost.

   An expand has to place the photograph inside a larger frame, and until now
   the placing was ASKED FOR, in English: "place the supplied photograph
   smaller within the output frame and draw the scene continuing outward".
   gpt-image reads that as what it says. It generates a scene and puts a
   picture in the middle of it. What came back was a photograph of a
   photograph — the real subject shrunk into a hard-edged rectangle floating
   in an invented landscape, with the invented landscape reading as the "real"
   image and the source reading as a second, ghostly one pasted on top. No
   amount of "no visible seam, border or frame" survives an instruction that
   literally asks for an inset.

   Geometry is not a thing to ask a model for. It is arithmetic, and it should
   be true before the model is called at all. It cannot be done here — there
   is no image library on this server — but the browser already has the
   picture decoded in a canvas, so it composites the source onto a frame of
   exactly `size`, leaves the margin transparent, and sends an alpha mask that
   is opaque over the source. The model is handed a fact instead of a request:
   it cannot move, rescale or re-render what it was given, and the prompt
   stops negotiating about placement and only describes what fills the margin.
   See buildExpandPrompt(). */

// gpt-image-1/1.5's output shapes. A size arriving from a browser is checked
// against this rather than trusted — it is what OpenAI gets billed for.
const ENHANCE_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);

/* ── Result cache ──────────────────────────────────────────────────────────
   Every press of AI Enhance is a fresh charge — there is no free path since
   the self-hosted upscaler was deleted. The UI actively invites re-pressing
   ("Re-pick a stock image to undo"), and a reviewer comparing two results, a
   stale second tab, or a reload all re-bill at full price for a byte-identical
   input. Nothing here changes what the model returns; it only stops paying
   twice for the same question.

   Keyed on the input bytes AND every parameter that changes the answer or the
   price — quality included, so lowering IMAGE_QUALITY does not keep serving
   the expensive result that was cached under the old tier.

   In-process and deliberately so: a restart costing one repeat call is a fair
   trade against a cache that can serve a stale image across a deploy. The
   entries are base64 PNGs, so the cap is on total bytes, not on count. */
/* A spend cap, not a security control — the role gate above is that. This is
   what stands between the account and a stuck tab, a retry loop, or a
   reviewer working through a backlog faster than anyone intended. It counts
   calls that were actually BILLED: a cache hit costs nothing and must not
   consume anyone's allowance, so recording happens after the paid call
   returns rather than at the door.

   ENHANCE_RATE_MAX is generous on purpose. A reviewer doing real work will
   not reach it; something looping will reach it in seconds. */
const ENHANCE_RATE_MAX = Number(process.env.ENHANCE_RATE_MAX) || 40;
const ENHANCE_RATE_WINDOW_MS = 60 * 60_000;
const enhanceLimiter = createRateLimiter({
  windowMs: ENHANCE_RATE_WINDOW_MS,
  max: ENHANCE_RATE_MAX,
});

/* ── The global ceiling ─────────────────────────────────────
   The limiter above is per user. This one is the org's, and it counts DOLLARS
   rather than presses, because that is the thing being protected: forty
   restores and forty reframes are the same number of calls and seven times
   the money.

   These are runaway numbers, not budget numbers. Measured against this
   deployment: the whole text pipeline runs about $2 a week, and image work at
   the tiers in force costs $0.05-$0.33 a press. $20 in an hour is roughly
   sixty reframes back to back — far past what anyone reviewing by hand will
   reach, and reached in seconds by something stuck. $60 in a day is the same
   guarantee against the slower kind of runaway, the one an hourly ceiling
   never sees because it never spends much in any single hour.

   Set either to 0 to meter without ever refusing. Both are env-overridable
   because the right ceiling is a property of the deployment rather than of
   the code — and once /health has shown a few days of real figures they can
   be pulled in with confidence instead of guessed at. */
/* `env()` returns "" for an unset variable, not undefined, so `?? default`
   never fires and Number("") is 0 — which this guard reads as "no ceiling".
   Written the obvious way, the breaker shipped switched off and said so only
   in a boot line nobody would have read twice. Parse explicitly: absent or
   unreadable falls back to the default, and only a deliberate 0 disables. */
function capFromEnv(name, fallback) {
  const raw = env(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`⚠ ${name}="${raw}" is not a number — using $${fallback}`);
    return fallback;
  }
  return n;
}
const SPEND_CAP_USD_HOUR = capFromEnv("SPEND_CAP_USD_HOUR", 20);
const SPEND_CAP_USD_DAY = capFromEnv("SPEND_CAP_USD_DAY", 60);
const spendGuard = createSpendGuard([
  { name: "hour", ms: 60 * 60_000, capUsd: SPEND_CAP_USD_HOUR },
  { name: "day", ms: 24 * 60 * 60_000, capUsd: SPEND_CAP_USD_DAY },
]);
console.log(
  `Spend guard: $${SPEND_CAP_USD_HOUR || "∞"}/hour, $${SPEND_CAP_USD_DAY || "∞"}/day on billed image calls`
  + " (text is metered, never refused). Totals on /health."
);

/* What one image edit might cost, booked before the call and corrected to the
   measured figure after. The expensive end of the range on purpose: see the
   reserve/settle note in lib/spend-guard.js — guessing low is the only
   direction that breaks the guarantee. */
const ENHANCE_RESERVE_USD = capFromEnv("ENHANCE_RESERVE_USD", 0.35) || 0.35;

/* Text spend is METERED but never refused — see recordUngated() in the guard
   for why. Called on every chat/responses reply that carried a usage block; a
   reply without one contributes nothing rather than a guess, because unlike
   the image path there is no reservation standing behind it to fall back on.

   This exists so the figure on /health is the whole of what this deployment
   spends, not just its expensive half. A total that quietly omitted the text
   pipeline would be the wrong number to hold a billing page up against. */
function meterText(data) {
  const usd = priceTextUsage(data?.usage);
  if (usd) spendGuard.recordUngated(usd);
}

const ENHANCE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const ENHANCE_CACHE_TTL_MS = 60 * 60_000;
const enhanceCache = new Map();
let enhanceCacheBytes = 0;

/* `mask` is BYTES here, not the { buffer, mime } wrapper readEnhanceEdit()
   resolves. Handed the wrapper, hash.update() throws
   ERR_INVALID_ARG_TYPE — "must be of type string or an instance of Buffer,
   TypedArray, or DataView. Received an instance of Object" — and because this
   runs before the OpenAI call, EVERY masked expand died here with a 500 whose
   body was the raw TypeError. The route's own feature was unreachable.

   Unwrapped at the call site, and defended here as well: the split where the
   image was unwrapped and the mask was not is exactly what invited it.
   `Buffer.isBuffer` rather than `mask.buffer || mask` — a real Buffer's
   `.buffer` is the 64KB pooled ArrayBuffer it was allocated from, which
   hash.update() rejects too, so the tempting one-liner reintroduces the crash
   by another route AND would key on the wrong bytes if it did not. */
function enhanceCacheKey(buffer, mask, parts) {
  const h = createHash("sha256").update(buffer);
  // The mask changes the output as much as the prompt does, so it has to be
  // part of the identity — two expands of one photo at different amounts
  // carry different masks and must not collide.
  if (mask) h.update(Buffer.isBuffer(mask) ? mask : mask.buffer);
  return h.update(JSON.stringify(parts)).digest("hex");
}

/* The entry, not the payload, because the PNG is now held beside it rather
   than inside it — see publishEnhanceResult(). A hit has to be able to hand
   the bytes out again under a fresh token, so it needs both halves. */
function enhanceCacheGet(key) {
  const hit = enhanceCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ENHANCE_CACHE_TTL_MS) {
    enhanceCache.delete(key);
    enhanceCacheBytes -= hit.bytes;
    return null;
  }
  // Refresh insertion order so a repeatedly-used result is the last evicted.
  enhanceCache.delete(key);
  enhanceCache.set(key, hit);
  return hit;
}

/* `png` is the raw image, and the cap is measured on it rather than on a
   base64 string a quarter larger than the thing it encodes. */
function enhanceCacheSet(key, payload, png) {
  const bytes = png ? png.length : 0;
  if (bytes === 0 || bytes > ENHANCE_CACHE_MAX_BYTES) return;
  enhanceCache.set(key, { payload, png, bytes, at: Date.now() });
  enhanceCacheBytes += bytes;
  // Map preserves insertion order, so the first key is the least recently used.
  while (enhanceCacheBytes > ENHANCE_CACHE_MAX_BYTES && enhanceCache.size > 1) {
    const oldest = enhanceCache.keys().next().value;
    enhanceCacheBytes -= enhanceCache.get(oldest).bytes;
    enhanceCache.delete(oldest);
  }
}

/* ── Where the finished picture is collected from ──────────────────────────

   The result used to travel home inside the JSON of the request that made
   it — `image: "data:image/png;base64,…"`, five or six megabytes of it,
   written to a socket that had already been open for the fifty-odd seconds
   gpt-image took. A response gets sixty seconds to flush before the platform
   proxy gives up on it, and that one often did not make it:

       ✓ AI reframe done in 53180ms (gpt-image-1.5, 1024x1536, quality=high)
         — $0.3297
       ✗ upscale-image error: Error: aborted … ECONNRESET      (60.002s later)

   That pair is the whole failure. The picture was made, it was BILLED, and it
   never arrived. What answered the reviewer was the proxy's own error page,
   which carries no JSON — so the client had no `error` field to read and fell
   back to printing "HTTP 502", a status with no sentence attached. Every
   diagnosis that starts from the message rather than from this log goes
   looking for an OpenAI fault that is not there.

   So the bytes no longer ride home in the answer. The PNG is parked here, the
   response carries a short URL to it, and the browser collects it as a plain
   binary GET with its own fresh sixty seconds. Three things follow, and the
   third is the one worth the change:

     - the JSON answer is a few hundred bytes and flushes in one packet;
     - the transfer is binary rather than base64, so a quarter less of it;
     - a collection that fails is FREE and can simply be repeated. The money
       was spent upstream and the picture is already sitting here.

   SAME ORIGIN, deliberately. Handing back a Supabase URL would have been less
   code and would have broken Save: describeMainImage() reads a `data:` src to
   mean "no address yet, upload this on Save" and an https one to mean the
   picture already has one (public/app.js). A remote URL would have published
   posts pointing at an object that expires an hour later — the failure would
   have been silent, and in the archive. The browser turns these bytes back
   into a data: URL before anything else sees them.

   The token is the whole authorisation: a v4 UUID, unguessable, dead in an
   hour, and it only ever names a picture the holder just paid for. */
const ENHANCE_RESULT_PATH = "/api/enhance-result";
const enhanceResults = new Map();   // token -> { png, at }
let enhanceResultBytes = 0;

function publishEnhanceResult(png) {
  const token = randomUUID();
  enhanceResults.set(token, { png, at: Date.now() });
  enhanceResultBytes += png.length;
  /* Shares its ceiling with the cache because it shares its Buffers: an entry
     in both maps is one allocation referenced twice, so the two counters
     overlap rather than add. Sweep the expired first — they are free to drop
     — and only then evict the merely oldest. */
  const now = Date.now();
  for (const [t, r] of enhanceResults) {
    if (now - r.at <= ENHANCE_CACHE_TTL_MS) break;   // insertion order == age order
    enhanceResults.delete(t);
    enhanceResultBytes -= r.png.length;
  }
  while (enhanceResultBytes > ENHANCE_CACHE_MAX_BYTES && enhanceResults.size > 1) {
    const oldest = enhanceResults.keys().next().value;
    enhanceResultBytes -= enhanceResults.get(oldest).png.length;
    enhanceResults.delete(oldest);
  }
  return `${ENHANCE_RESULT_PATH}/${token}`;
}

/* Collection. A miss is a 404 and not an error worth a stack trace: a token
   goes stale on its own after an hour, and after a redeploy every token in
   the process goes with it. The browser's answer to both is the same — say so
   plainly and let the reviewer press again. */
function handleEnhanceResult(req, res) {
  const token = req.url.slice(ENHANCE_RESULT_PATH.length + 1).split("?")[0];
  const hit = enhanceResults.get(token);
  if (!hit || Date.now() - hit.at > ENHANCE_CACHE_TTL_MS) {
    if (hit) {
      enhanceResults.delete(token);
      enhanceResultBytes -= hit.png.length;
    }
    sendJson(res, 404, { error: "That enhanced picture has expired. Press Enhance again." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": hit.png.length,
    // Private: it is one reviewer's unpublished picture, and the token that
    // names it is the only thing protecting it.
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(hit.png);
}

// The composited expand frame is a full-size RGBA PNG and runs larger than
// the source did, so this sits above the old 10 MB raw-body cap.
const MAX_ENHANCE_BYTES = 12 * 1024 * 1024;

function enhanceMime(contentType) {
  return String(contentType || "").includes("jpeg") ? "image/jpeg" : "image/png";
}

/* Raw image body — the plan stage and the legacy single-shot path. */
async function readEnhanceBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_ENHANCE_BYTES) {
      const err = new Error(`Image exceeds ${Math.round(MAX_ENHANCE_BYTES / 1048576)} MB.`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 1000) {
    const err = new Error("Empty or invalid image body.");
    err.status = 400;
    throw err;
  }
  return buffer;
}

/* Multipart body — the edit stage. At most two files: the picture, and on an
   expand the alpha mask that pins it in place. Everything else is a field
   carrying the plan stage's answer back, so the vision call is not repeated. */
function readEnhanceEdit(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 2, fileSize: MAX_ENHANCE_BYTES } });
    } catch (err) {
      reject(new Error("Malformed enhance upload: " + err.message));
      return;
    }

    /* Chunks are accumulated per part and joined at close rather than on each
       stream's own end event. Busboy only guarantees ordering between "close"
       and the file streams it has been allowed to drain, and a mask that
       arrives half-assembled is worse than one that never arrives: it would
       pin the picture to the wrong rectangle. */
    const parts = { image: [], mask: [] };
    const mimes = {};
    const fields = {};
    let tooBig = false;

    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("file", (name, stream, info) => {
      if (name !== "image" && name !== "mask") { stream.resume(); return; }
      mimes[name] = info.mimeType || "image/png";
      stream.on("data", (d) => parts[name].push(d));
      stream.on("limit", () => { tooBig = true; });
    });

    bb.on("error", reject);
    bb.on("close", () => {
      if (tooBig) {
        reject(new Error(`Image exceeds ${Math.round(MAX_ENHANCE_BYTES / 1048576)} MB.`));
        return;
      }
      const image = Buffer.concat(parts.image);
      const mask = Buffer.concat(parts.mask);
      if (image.length < 1000) {
        reject(new Error("No usable `image` part in the upload."));
        return;
      }
      resolve({
        image: { buffer: image, mime: mimes.image || "image/png" },
        // A truncated or absent mask is simply no mask. The expand still runs
        // — the frame is composited either way — it just loses the guarantee
        // that the model cannot paint inside the picture.
        mask: mask.length > 100 ? { buffer: mask, mime: mimes.mask || "image/png" } : null,
        fields,
      });
    });

    req.pipe(bb);
  });
}

/* The two ways this route can be unavailable without anything being broken.
   Checked before the vision call as well as before the image call: planning a
   job that cannot then be run is a call nobody gets anything for. */
function enhanceBlocked() {
  if (!openaiApiKey) {
    return { status: 503, error: "Generative restore needs OPENAI_API_KEY on the server." };
  }
  if (gptImageDisabled) {
    console.warn("⚠ DISABLE_GPT_IMAGE is set — refusing to spend OpenAI credits");
    return { status: 503, error: "Restore & Upscale is switched off on this server (DISABLE_GPT_IMAGE)." };
  }
  return null;
}

/* Stage 2 — the paid call, and nothing else. Every choice it acts on was made
   in the plan stage; this reads them, builds the prompt, and posts.

   `composited` is the caller saying "the frame is already built": the source
   drawn into a transparent canvas of exactly `size`, margin left empty. It is
   what lets buildExpandPrompt() drop the placement sentence, and it is what
   makes the mask meaningful — a mask over an un-composited source would pin
   the picture to a frame it does not fill. */
async function runEnhanceEdit({
  buffer,
  mime,
  mask = null,
  composited = false,
  mode,
  amount = "moderate",
  subject = "people",
  description = "",
  headline = "",
  posterRatio = "",
  size = "auto",
  decidedBy = "caller",
  reason = "",
  // Called once, only when OpenAI was actually paid. A cache hit returns
  // before this and so never consumes the caller's hourly allowance.
  onCharge = null,
}) {
  /* MEDIUM, deliberately. This is the setting that decides both what a face
     comes back looking like and what the call costs.

     `quality` is how much compute the model spends rendering detail —
     OpenAI's own default is high, and this route used to force low to save
     money (~$0.013 low against ~$0.05 medium). Starved of that budget the
     model returns smooth, waxy, under-detailed surfaces, which on a face
     reads as modelling clay. No prompt can undo it: you cannot instruct a
     model to render texture it has no budget to render.

     The default is `medium`, not `high`. High is four times the price at the
     shapes this route asks for (~$0.20 against ~$0.05) and the poster draws
     the photograph behind a dark gradient with copy over it, so the extra
     rendering budget is spent on detail the reader never sees. It went to
     `high` in dbcdb0f on the same day the free self-hosted upscaler was
     deleted, and the two together are what turned a near-zero bill into a
     real one.

     IMAGE_QUALITY still overrides per deployment, in both directions, and the
     boot log states the tier actually in force. */
  /* Reframe renders HIGH by default, separately from the rest. It is the
     job whose output IS the picture — every pixel on the poster is the
     model's — and at medium the leaves, water and skin that make a redrawn
     scene believable come back soft. High is what ChatGPT spends on the same
     request, and the comparison that prompted this was made against it.
     ~$0.20 against ~$0.05; the status line says what each press cost.
     IMAGE_QUALITY_REFRAME overrides it on its own. */
  const quality = (mode === "reframe"
    ? (process.env.IMAGE_QUALITY_REFRAME || "high")
    : (process.env.IMAGE_QUALITY || "medium")).toLowerCase();
  if (quality === "low") {
    console.warn("⚠ IMAGE_QUALITY=low — faces come back smooth and clay-like. medium is the intended floor.");
  } else if (quality === "high" && mode !== "reframe") {
    console.warn("⚠ IMAGE_QUALITY=high — roughly 4× the price of medium (~$0.20 vs ~$0.05 per enhance).");
  }

  /* An expand whose frame was not built by the caller cannot be done here.
     There is no image library on this server to build it with, and asking for
     it in prose is exactly the instruction that returned a photograph inside a
     photograph. Fall back to the job that invents nothing, and say so in the
     response rather than quietly handing back a differently-shaped picture. */
  let job = ["expand", "reframe"].includes(mode) ? mode : "restore";
  let jobReason = reason;
  if (job === "expand" && !composited) {
    console.warn("⚠ expand asked for without a composited frame — restoring instead");
    job = "restore";
    jobReason = "expand needs a pre-composited frame from the browser; restored instead";
  }

  /* Ask the cache before OpenAI. `description` is in the key because it is
     built into the prompt, so two plans that read the same photograph
     differently are genuinely different requests. `decidedBy`, `reason` and
     `masked` are not — they are reporting, and a hit rebuilds them from the
     stored payload below. */
  const prompt =
    job === "reframe" ? buildReframePrompt(description, posterRatio, subject)
    : job === "expand" ? buildExpandPrompt(description, posterRatio, amount, subject, composited)
    : buildEnhancePrompt(description, headline, posterRatio);
  const cacheKey = enhanceCacheKey(buffer, mask?.buffer ?? null, {
    job, amount: job === "expand" ? amount : null, subject,
    description, headline, posterRatio, size, quality, composited, prompt,
  });
  const cached = enhanceCacheGet(cacheKey);
  if (cached) {
    console.log(`✓ AI ${job} served from cache (${size}, quality=${quality}) — no charge`);
    /* A FRESH token for the same bytes. The one handed to the request that
       paid may already have been collected, swept or evicted, and returning a
       dead URL would turn a free hit into a press that fails for no reason.
       The reporting fields belong to THIS request, not to the one that paid. */
    return {
      ...cached.payload,
      image: publishEnhanceResult(cached.png),
      decidedBy,
      reason: jobReason,
      cached: true,
    };
  }

  const t0 = Date.now();

  /* One parameter set, because both rungs of the ladder take the same one.

     Worth knowing before the ladder ever changes: this is only true of the
     gpt-image-1 family. A later model may not accept `input_fidelity` at all,
     and `size` is resolved back in handleEnhancePlan before anything knows
     which rung will serve — so a model whose parameters differ cannot be
     adopted by swapping the id. It would 400 on every press, fall through to
     the rung below, and keep working, which is the migration looking finished
     without having started. Derive the parameters from `model` at that point,
     rather than sending one set to a model that wants another. */
  const callEdit = async (model, withMask) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    // OpenAI's identity-preservation control, and the thing standing between a
    // restore and a handsome stranger in the right shirt.
    form.append("input_fidelity", "high");
    /* NEVER "auto", which is the default.

       Handed an input that carries an alpha channel, gpt-image is entitled to
       answer with one, and it does. A returned PNG whose margin is still
       transparent is drawn by drawCoverImage() with no backing fill, so the
       card's own pale backdrop shows through it with a hairline where the
       alpha edge was antialiased — the washed-out field with a thin white
       rectangle around the photograph that was reported the second time.
       There is no case on this route where a transparent result is wanted:
       the output is a background photograph. */
    form.append("background", "opaque");
    form.append("output_format", "png");
    form.append("image", new Blob([buffer], { type: mime }), mime === "image/jpeg" ? "input.jpg" : "input.png");
    /* The mask's transparent pixels are the only ones the model may paint.
       On an expand that is the margin and nothing else, which is what makes
       "keep the supplied image unchanged" a constraint rather than a wish. */
    if (withMask && mask) {
      form.append("mask", new Blob([mask.buffer], { type: "image/png" }), "mask.png");
    }
    return fetchWithDeadline("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiApiKey}` },
      body: form,
    }, OPENAI_IMAGE_TIMEOUT_MS, `${model} ${job}`);
  };

  let modelUsed = IMAGE_MODEL_PRIMARY;
  let usedMask = Boolean(mask) && job === "expand";   // never on reframe: the whole frame is redrawn
  let aiRes = await callEdit(modelUsed, usedMask);

  /* Two different retries, and they must not be confused with each other.

     A 400/403/404 on the FIRST call usually means the account has no
     gpt-image-1.5, so the same request is repeated on gpt-image-1. If that
     also refuses and a mask was attached, the mask is the next most likely
     thing the account or model will not take, so it is dropped and the call
     is repeated once more. Dropping it is survivable precisely because the
     frame is already composited: the geometry stays correct, only the
     guarantee that the source pixels are untouched is lost — and the caller
     pastes them back over the result anyway. */
  if (!aiRes.ok && [400, 403, 404].includes(aiRes.status)) {
    const firstErr = await aiRes.text().catch(() => "");

    /* A 400 is not only "no such model". It is also how the API reports a
       moderation refusal and a malformed parameter, and neither of those gets
       better on a second model — the same picture and the same form go up
       again, fail the same way, and the reviewer waits through two full
       image-generation round trips before seeing an error. At three minutes
       apiece that is six minutes to be told no.

       So the retry is narrowed to what it was actually written for: the
       account not having the newer model. 403 and 404 always mean that; a
       400 only does when the body says so. Anything else fails on the first
       attempt, which is both faster and more honest. */
    {
      console.warn(`⚠ ${IMAGE_MODEL_PRIMARY} refused the request (${aiRes.status}):`, firstErr.slice(0, 300));

      /* Say WHICH kind of no.

         "The image service refused this picture" is true and useless. The
         reviewer cannot tell whether they uploaded something broken, whether
         the software is faulty, or whether to stop trying — and the one
         answer that matters most is the one they will never guess: OpenAI's
         safety system declines a lot of ordinary news photography. Injury,
         disaster, distress and children are all common triggers, and a
         newsroom photographs exactly those. Nothing is wrong with the file.

         The classification is read off OpenAI's own response rather than
         assumed, so if it refused for some other reason that reason is what
         gets shown. */
      let reason = "";
      try {
        const parsed = JSON.parse(firstErr);
        reason = parsed?.error?.message || "";
      } catch { /* not JSON — fall through to the raw text */ }
      if (!reason) reason = firstErr.replace(/\s+/g, " ").trim().slice(0, 200);

      const moderated = /moderation|safety system|content[_ ]policy|rejected as a result/i.test(firstErr);
      const err = new Error(
        moderated
          ? "OpenAI's safety filter declined this photograph. Nothing is wrong with your file — " +
            "distressing news images, and pictures of children, are refused routinely. " +
            "Use it as it is; the poster does not need the AI."
          : `The image service refused this picture: ${reason}`,
      );
      err.status = 502;
      err.detail = firstErr.slice(0, 300);
      err.moderated = moderated;
      throw err;
    }
  }
  if (!aiRes.ok && usedMask && [400, 422].includes(aiRes.status)) {
    const maskErr = await aiRes.text().catch(() => "");
    console.warn(`⚠ masked edit refused (${aiRes.status}) — retrying without the mask:`, maskErr.slice(0, 160));
    usedMask = false;
    aiRes = await callEdit(modelUsed, false);
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text().catch(() => "");
    console.error(`✗ ${modelUsed} ${aiRes.status}:`, errText.slice(0, 400));
    const err = new Error(`OpenAI image ${aiRes.status}`);
    err.status = 502;
    err.detail = errText.slice(0, 300);
    throw err;
  }

  const data = await aiRes.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    const err = new Error("OpenAI returned no image data.");
    err.status = 502;
    throw err;
  }

  /* ── What this call actually cost ─────────────────────────────────────
     Read off the response's own usage block rather than estimated from a
     table. The tables go stale — this repo's own IMAGES.md quoted square
     prices for a route that never asks for a square, and understated low and
     medium by about half — and an estimate is exactly the wrong thing to
     hand someone deciding whether they can afford a feature.

     Rates are per MILLION tokens and overridable, because they are the one
     part of this that OpenAI can change without the code noticing. The
     defaults are the published gpt-image rates. The authoritative number is
     always the usage dashboard; this is the per-click figure that makes the
     dashboard total explicable. */
  const usage = data?.usage || null;
  const RATE_TEXT_IN = Number(env("OPENAI_RATE_TEXT_IN") || 5);
  const RATE_IMAGE_IN = Number(env("OPENAI_RATE_IMAGE_IN") || 10);
  const RATE_IMAGE_OUT = Number(env("OPENAI_RATE_IMAGE_OUT") || 40);
  let cost = null;
  if (usage) {
    const textIn = usage.input_tokens_details?.text_tokens ?? 0;
    const imageIn = usage.input_tokens_details?.image_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - textIn);
    const out = usage.output_tokens ?? 0;
    cost = {
      textInTokens: textIn,
      imageInTokens: imageIn,
      outputTokens: out,
      usd: Number((
        (textIn * RATE_TEXT_IN + imageIn * RATE_IMAGE_IN + out * RATE_IMAGE_OUT) / 1e6
      ).toFixed(4)),
    };
  }

  console.log(
    `✓ AI ${job} done in ${Date.now() - t0}ms (${modelUsed}, ${size}, quality=${quality}` +
    `${job === "expand" ? `, ${amount}, ${usedMask ? "masked" : "unmasked"}` : ""}, chosen by ${decidedBy})` +
    (cost
      ? ` — $${cost.usd.toFixed(4)} (in ${cost.imageInTokens} img + ${cost.textInTokens} txt, out ${cost.outputTokens})`
      : " — cost unknown (no usage in response)")
  );

  /* Decoded once, here, and kept as bytes from this point on. The base64 was
     only ever the transport OpenAI chose; carrying it any further means
     holding the picture at 133% of its size and handing the browser the same
     surcharge. */
  const png = Buffer.from(b64, "base64");

  /* No `image` field: it is not a property of the result, it is an address
     issued per request. See publishEnhanceResult() — a cache hit has to be
     able to mint a new one, so the stored payload must not carry a stale one. */
  const payload = {
    context: description,
    engine: modelUsed,
    // Measured, not estimated. Null when OpenAI returns no usage block.
    cost,
    /* `quality` and `size` come back with the image so the setting can be
       checked from outside the box. IMAGE_QUALITY is an environment variable
       and an override in Railway silently reinstates the clay — without this
       the only way to know was to read a log line on the host. */
    quality,
    size,
    // Which job actually ran. The two return pictures that differ in framing,
    // not just in sharpness, so the caller has to know which one it got
    // before it decides whether the writer's zoom and pan still apply — and
    // an expand that degraded to a restore has to be visible, not silent.
    mode: job,
    amount: job === "expand" ? amount : null,
    // Whether the source pixels were actually pinned. The caller re-pastes
    // them either way; this is here so a mask being refused shows up in a
    // response rather than only in a server log.
    masked: usedMask,
    // What stage 1 took the picture to be. Reported because it changes what
    // the margin was allowed to contain, and a wrong call here is the one
    // worth being able to see from the outside — a logo read as a scene gets
    // a margin of invented room rather than more of its own field.
    subject,
    /* Who chose, and why. A reviewer watching a paid call reframe a
       photograph is owed both: "expand" alone reads as the software having
       opinions, while "expand — he is cropped at the chest with no room
       below" is a judgement they can agree or disagree with, and override on
       the next press. "fallback" says the planner never answered and the safe
       job ran, which must not be mistaken for the planner choosing it. */
    decidedBy,
    reason: jobReason,
  };

  /* Store only what a repeat of this exact request would get. The per-request
     reporting fields are re-attached on a hit rather than replayed.

     BEFORE the response is built, and that ordering is load-bearing: it is
     what makes a delivery that fails recoverable. The press that lost its
     socket to the proxy still left its picture here, so pressing again inside
     the hour is a free hit rather than a second $0.33. */
  enhanceCacheSet(cacheKey, payload, png);
  if (onCharge) onCharge(cost?.usd ?? null);
  return { ...payload, image: publishEnhanceResult(png) };
}

/* Stage 1 as its own response. Everything the caller needs to build the frame
   for stage 2 and nothing it has to compute for itself — including `size`,
   which the browser must match exactly or the model will rescale the
   composite and undo the whole point of compositing it. */
async function handleEnhancePlan(req, res) {
  const blocked = enhanceBlocked();
  if (blocked) { sendJson(res, blocked.status, { error: blocked.error }); return; }

  const buffer = await readEnhanceBody(req);
  const mime = enhanceMime(req.headers["content-type"]);
  const posterRatio = (req.headers["x-poster-ratio"] || "").toString();
  const sizeHint = (req.headers["x-image-orientation"] || "").toString();

  /* The caller's choice, applied to the planner's answer rather than instead
     of it. On `auto` the verdict stands; on a forced mode the verdict is
     discarded and the description and subject are kept, because the margin
     around a logo and the margin around a seated politician are not the same
     job and only stage 1 knows which this is. Same call, same cost either
     way — a forced mode is not cheaper, it is just less advised.

     The DEFAULT is restore, not auto: this header is the only thing standing
     between a caller that knows nothing about any of this and a reframe it
     never asked for. An unrecognised value falls back the same way. */
  const rawMode = (req.headers["x-enhance-mode"] || "restore").toString().toLowerCase();
  const requestedMode = ["auto", "expand", "restore", "reframe"].includes(rawMode) ? rawMode : "restore";
  const rawAmount = (req.headers["x-expand-amount"] || "moderate").toString().toLowerCase();
  const requestedAmount = ["slight", "moderate", "wide"].includes(rawAmount) ? rawAmount : "moderate";

  /* The source's real pixel dimensions, for the planner. Aspect alone is not
     enough to answer "can this picture afford to be made smaller inside the
     output" — a 400px crop and a 3000px one have the same shape and opposite
     answers. Sent by the browser, which has the decoded image in hand. */
  const srcDims = (req.headers["x-source-size"] || "").toString().match(/^(\d{1,5})x(\d{1,5})$/);
  const sourceW = srcDims ? Number(srcDims[1]) : 0;
  const sourceH = srcDims ? Number(srcDims[2]) : 0;

  const t0 = Date.now();

  /* ── A forced restore does not need the planner, and is safer without it ──
     The planner answers two questions: which job the picture needs, and what
     the picture contains. A caller that has already SAID "restore" is not
     asking the first, and the second is actively harmful here.

     Stage 1 is told to describe, for a scene, "what would plausibly continue
     past it, the perspective, and the light and weather". That is the right
     brief for reframe and expand, which have to draw what continues. Its
     answer is then injected into the restore prompt as "CONTEXT — the photo
     shows: ...", three lines under "This is NOT an image generation task."
     A sentence like "an overcast sky continues above the treeline" is not
     context to a generative image model, it is an instruction, and it is the
     second reason this route kept returning clouds. The first was the output
     shape, fixed on the client.

     So a forced restore skips stage 1 entirely: one paid call instead of two,
     several seconds faster, and nothing in the prompt describing weather that
     is not in the frame. Auto still runs it — it cannot choose a job without
     it — and so do reframe and expand, which need the continuation prose. */
  /* No planner. gpt-image-1.5 is the only model this route calls.

     Stage 1 was a gpt-4o-mini vision call that chose between the jobs. The
     reviewer chooses on the Job selector, so it answered a question nobody
     was asking — and it was a second provider billed on every press of a
     button whose cost was the complaint. Its description was also, on the
     restore prompt, the thing writing clouds into the output.

     Both prompts stand without it: buildReframePrompt takes `description`
     behind a null check and reads `subject` only to pick between its graphic
     line and its people line, and people is the stricter of the two. */
  const plan = {
    mode: requestedMode === "auto" ? "reframe" : requestedMode,
    amount: "moderate", subject: "people", description: "", reason: "", decidedBy: "caller",
  };

  /* ── auto expands when the caller composites ──────────────────────────────
     `auto` used to answer an expand verdict with Fit — the whole photograph,
     letterboxed, by arithmetic — and never with outpainting. The reason was
     sound at the time: expand had twice returned the source as a framed print
     inside an invented scene, on posters that were published, and a verdict
     is a good enough reason to letterbox a picture but not a good enough
     reason to let a model redraw the parts of one that do not exist.

     What has changed is that the model is no longer TRUSTED with any of it.
     The caller composites the source onto a frame of exactly this size, sends
     an alpha mask over it, and — the part that is not negotiable — pastes the
     source back over whatever returns (composeExpandResult in app.js). The
     model contributes the margin or it contributes nothing; either way the
     photograph in the middle is the one that went up, pixel for pixel. A
     ghost would now have to survive a paste-back that does not ask its
     permission.

     So the verdict is acted on instead of being noted and discarded, and a
     landscape photograph on a 9:16 poster gets what it always needed: one
     picture, filling the frame, with the parts that were never photographed
     drawn rather than cropped or padded with backdrop.

     `X-Expand-Capable` is what gates it, not a flag day. A caller that does
     not send it — the legacy single-shot path below, anything posting raw
     bytes — cannot build the frame or the mask, so for that caller an expand
     verdict still means Fit. The safety lives on the side that can enforce
     it. */
  /* ── and on `auto` it is now REFRAME, not expand ─────────────────────────
     Everything above described the composited expand and remains true of it.
     What changed is which job an expand verdict resolves to.

     Expand protects the original by pinning it and bolting a generated margin
     to it, and every failure this route has shipped was a failure of that
     bolt: the doubled subject, the framed print, the smeared sky. Reframe
     asks the model for the whole picture at the poster's shape and lets it
     re-render — which is what the same model does, well, when it is asked
     plainly. The reviewer compared the two side by side and picked this.

     It costs fidelity: the result is a regeneration, recognisably the same
     rather than identically the same. That is a deliberate trade and it is
     stated in the UI, because it is the reviewer's to make per picture — the
     composited expand is still on the Job selector for anything that must not
     be redrawn.

     No compositing is needed, so nothing gates this on the caller's abilities
     any more. X-Expand-Capable is therefore no longer read here; a forced
     expand that arrives without a frame is still caught in runEnhanceEdit,
     which is the place that can actually tell. */
  const wantedExpand = plan.mode === "expand";
  // Real dimensions or nothing: an unresolvable shape leaves the model to
  // guess at the poster, which is the overlay bug. That falls to Fit.
  const expandSize = wantedExpand ? sizeForExpand(posterRatio, sizeHint) : "";
  const autoReframe = requestedMode === "auto" && wantedExpand && expandSize !== "auto";
  const autoFit = requestedMode === "auto" && wantedExpand && !autoReframe;
  const mode = requestedMode === "auto"
    ? (autoReframe ? "reframe" : (wantedExpand ? "restore" : plan.mode))
    : requestedMode;
  const amount = requestedMode === "auto" ? plan.amount : requestedAmount;
  const decidedBy = autoFit ? "auto-fit" : (requestedMode === "auto" ? plan.decidedBy : "caller");
  /* Written for the reviewer, not the log. They pressed one button, the
     framing came back unchanged, and the picture then shrank inside the
     frame — they are owed the reason for both halves of that. */
  const reason = autoFit
    ? (plan.reason
        ? `${plan.reason} — fitted instead of generating margin`
        : "showing the whole photograph instead of generating margin")
    : (requestedMode === "auto" ? plan.reason : "");

  /* Which shape to ask for is the resolved mode's decision, and the two want
     opposite things — see sizeForRatio() and sizeForExpand(). Restore follows
     the SOURCE: any other shape forces the model to invent margin nobody
     asked for. Expand follows the POSTER: the margin is the point, and a 9:16
     poster is where a landscape photograph most needs the room. */
  const size = (mode === "expand" || mode === "reframe")
    ? sizeForExpand(posterRatio, sizeHint)
    : sizeForRatio(posterRatio, sizeHint, sourceW, sourceH);

  console.log(
    `✓ plan (${Date.now() - t0}ms): ${plan.subject} → ${mode}` +
    `${mode === "expand" ? ` / ${amount}` : ""}${autoFit ? " + fit" : ""} @ ${size} (${decidedBy})` +
    `${reason ? ` — ${reason}` : ""}`
  );
  if (plan.description) console.log(`✓ vision context: ${plan.description.slice(0, 140)}…`);

  sendJson(res, 200, {
    mode,
    amount,
    subject: plan.subject,
    description: plan.description,
    decidedBy,
    reason,
    /* Ask the browser to letterbox the result rather than leave it cropped.
       A flag, not a zoom figure: the frame's dimensions live on the client and
       fitZoomFor() already knows how to read them, so sending a number from
       here would be a second, staler answer to a question already answered. */
    fit: autoFit,
    // The exact canvas the caller must build for an expand. Sent for restore
    // too so one code path can post it straight back.
    size,
    posterRatio,
  });
}

/* The spend gate, shared by both paid entry points. Keyed on the signed-in
   user when there is one and the client IP otherwise, so one reviewer cannot
   spend another's allowance and an unauthenticated caller (which the route
   gate should already have refused) still cannot loop. */
async function enhanceSpendGate(req, res) {
  const user = await currentUser(req);
  const key = user?.username ? `u:${user.username}` : `ip:${clientKey(req)}`;
  const gate = enhanceLimiter.check(key);
  if (!gate.allowed) {
    const mins = Math.ceil(gate.retryAfterSeconds / 60);
    console.warn(`⚠ enhance rate limit hit by ${key} — ${ENHANCE_RATE_MAX}/hour`);
    sendJson(res, 429, {
      error: `That is ${ENHANCE_RATE_MAX} AI Enhances in an hour, which is the cap. Try again in ${mins} minute(s).`,
    });
    return null;
  }

  /* The org's ceiling, checked after the caller's own. The order matters only
     for the message: someone who has burnt their own allowance should be told
     that, not told the company is out of money. */
  const spend = spendGuard.reserve(ENHANCE_RESERVE_USD);
  if (!spend.allowed) {
    const mins = Math.ceil(spend.retryAfterSeconds / 60);
    console.error(
      `⛔ GLOBAL SPEND CAP — $${spend.spentUsd} of $${spend.capUsd} this ${spend.window}. `
      + `Billed image calls refused for ${mins} more minute(s). Raise SPEND_CAP_USD_${spend.window.toUpperCase()}, `
      + "or find what is looping."
    );
    /* Named plainly, and addressed to someone who has done nothing wrong and
       cannot lift it themselves. A bare "rate limited" here would read as a
       fault in their own work rather than a ceiling on the deployment. */
    sendJson(res, 429, {
      error: `AI image work is paused: this deployment has reached its $${spend.capUsd} ${spend.window}ly spend ceiling. `
        + `It frees up in ${mins} minute(s). If that is unexpected, tell an admin — something may be looping.`,
    });
    return null;
  }

  /* Releasing the reservation is tied to the RESPONSE, not to the happy path.
     Every way this request can end — returned, threw, timed out, socket
     dropped by the proxy — ends with the response closing, and exactly one of
     those ways involves OpenAI having billed anything. Hooking the lifecycle
     rather than wrapping each handler in try/catch means there is no error
     path left to forget about, and no handler had to be restructured to get
     it. The guard also reaps abandoned tickets on a timer, which covers the
     case where even 'close' never fires. */
  let charged = false;
  res.once("close", () => { if (!charged) spendGuard.release(spend.ticket); });

  return (usd) => {
    charged = true;
    enhanceLimiter.record(key);
    spendGuard.settle(spend.ticket, usd ?? null);
  };
}

/* Stage 2's entry point. Reads the multipart body, sanity-checks the plan the
   caller is handing back, and runs it. Nothing is decided here — a field that
   does not parse falls to the conservative value rather than to a 400, for
   the same reason the mode header does. */
async function handleEnhanceEditStage(req, res) {
  const blocked = enhanceBlocked();
  if (blocked) { sendJson(res, blocked.status, { error: blocked.error }); return; }

  const onCharge = await enhanceSpendGate(req, res);
  if (!onCharge) return;

  const { image, mask, fields } = await readEnhanceEdit(req);
  const rawSize = String(fields.size || "auto");
  const rawAmount = String(fields.amount || "moderate").toLowerCase();
  const rawSubject = String(fields.subject || "people").toLowerCase();

  const payload = await runEnhanceEdit({
    buffer: image.buffer,
    mime: enhanceMime(image.mime),
    mask,
    composited: String(fields.composited || "") === "1",
    mode: (() => {
      const m = String(fields.mode || "restore").toLowerCase();
      return ["expand", "reframe"].includes(m) ? m : "restore";
    })(),
    amount: ["slight", "moderate", "wide"].includes(rawAmount) ? rawAmount : "moderate",
    subject: ["people", "scene", "graphic"].includes(rawSubject) ? rawSubject : "people",
    description: String(fields.description || "").slice(0, 4000),
    headline: decodeURIComponent(String(fields.headline || "")).slice(0, 200),
    posterRatio: String(fields.posterRatio || ""),
    size: ENHANCE_SIZES.has(rawSize) ? rawSize : "auto",
    decidedBy: String(fields.decidedBy || "caller"),
    reason: String(fields.reason || "").slice(0, 200),
    onCharge,
  });

  sendJson(res, 200, payload);
}

/* The legacy single-shot: plan and edit in one call, raw image body, no way
   to composite a frame. Kept because this route existed before the split and
   something may still be posting to it that way; an expand verdict here
   degrades to restore inside runEnhanceEdit() rather than outpainting blind. */
async function handleEnhanceSingleShot(req, res) {
  const blocked = enhanceBlocked();
  if (blocked) { sendJson(res, blocked.status, { error: blocked.error }); return; }

  const onCharge = await enhanceSpendGate(req, res);
  if (!onCharge) return;

  const buffer = await readEnhanceBody(req);
  const mime = enhanceMime(req.headers["content-type"]);
  const headline = decodeURIComponent(req.headers["x-headline"] || "").trim().slice(0, 200);
  const posterRatio = (req.headers["x-poster-ratio"] || "").toString();
  const sizeHint = (req.headers["x-image-orientation"] || "").toString();
  const rawMode = (req.headers["x-enhance-mode"] || "restore").toString().toLowerCase();
  const requestedMode = ["auto", "expand", "restore", "reframe"].includes(rawMode) ? rawMode : "restore";
  const srcDims = (req.headers["x-source-size"] || "").toString().match(/^(\d{1,5})x(\d{1,5})$/);
  const sourceW = srcDims ? Number(srcDims[1]) : 0;
  const sourceH = srcDims ? Number(srcDims[2]) : 0;

  // Same rule: gpt-image-1.5 and nothing else.
  const plan = {
    mode: requestedMode === "auto" ? "reframe" : requestedMode,
    amount: "moderate", subject: "people", description: "", reason: "", decidedBy: "caller",
  };
  const mode = plan.mode;

  const payload = await runEnhanceEdit({
    buffer,
    mime,
    mask: null,
    composited: false,
    mode,
    amount: requestedMode === "auto" ? plan.amount : "moderate",
    subject: plan.subject,
    description: plan.description,
    headline,
    posterRatio,
    size: sizeForRatio(posterRatio, sizeHint, sourceW, sourceH),
    decidedBy: requestedMode === "auto" ? plan.decidedBy : "caller",
    reason: requestedMode === "auto" ? plan.reason : "",
    onCharge,
  });

  sendJson(res, 200, payload);
}

async function handleUpscaleImage(req, res) {
  /* No OpenAI key is checked here. The guards live in enhanceBlocked(), which
     each stage calls first — gating the route itself on a credential turned a
     missing key into "enhance is broken" with no indication of what was
     missing. */
  try {
    const stage = (req.headers["x-enhance-stage"] || "").toString().toLowerCase();
    if (stage === "plan") { await handleEnhancePlan(req, res); return; }
    if (stage === "edit") { await handleEnhanceEditStage(req, res); return; }
    await handleEnhanceSingleShot(req, res);
  } catch (err) {
    console.error("✗ upscale-image error:", err);
    const status = Number(err.status) || 500;
    sendJson(res, status, {
      error: err.message || "Image enhance failed.",
      ...(err.detail ? { detail: err.detail } : {}),
      /* A safety refusal is not a fault. The client presents it differently:
         "Restore failed" in front of it would tell a reviewer something
         broke, when in fact the software worked and the answer was no. */
      ...(err.moderated ? { moderated: true } : {}),
    });
  }
}
