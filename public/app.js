/* ── PIXIE — Scrape + Edit ── */

const canvas = document.getElementById("post-canvas");
// `ctx` is `let` (not const) so renderToHighResCanvas() can temporarily swap
// it to an offscreen 2× context for export, without rewriting every draw
// function to take a ctx parameter.
let ctx = canvas.getContext("2d");
const screenCtx = ctx;   // permanent reference to the on-screen context

// ── Export resolution ──
// Downloads aim as high as the browser can actually encode: 8K long edge
// first, stepping down to 6K then 4K. Oversized canvases silently fail on
// iOS/low-end GPUs (toBlob returns null or a blank) — the fallback chain in
// renderExportBlob() keeps trying smaller until one really encodes.
//   8K target (7680 long edge):
//     9:16  920×1700  → ×4.52 → 4159×7680
//     4:5  1080×1350  → ×5.69 → 6144×7680
//     1:1  1080×1080  → ×7.11 → 7680×7680
//     16:9 1920×1080  → ×4.00 → 7680×4320 (8K UHD)
const EXPORT_LONG_EDGES = [7680, 6144, 3840];   // 8K → 6K → 4K
function scaleForLongEdge(target) {
  const longEdge = Math.max(canvas.width, canvas.height);
  return Math.max(2, target / longEdge);   // never below 2× (retina floor)
}

/**
 * Render + PNG-encode the poster at the highest resolution the browser can
 * handle, stepping down through EXPORT_LONG_EDGES on failure.
 * `cropOpts` (optional): { paddingBelow, minHeight } in DESIGN pixels —
 * multiplied by the chosen scale before cropping the trailing black gap.
 * Returns { blob, width, height } or null if every tier failed.
 */
/* `encode` picks the file format. PNG is right for a download — it is exact,
   and a writer saving a poster wants the original pixels. It is the wrong
   thing to put on the wire: a 2078×3840 poster PNG is 12 MB, and five of them
   is a 42 MB upload that DailyMattr answers with a bare "Validation Error".
   See the compression ladder near DAILYMATTR_COMPRESSION_LADDER. */
async function renderExportBlob(cropOpts = null, targetLongEdges = EXPORT_LONG_EDGES, encode = null) {
  const type = encode?.type || "image/png";
  const quality = encode?.quality;
  for (const target of targetLongEdges) {
    const scale = scaleForLongEdge(target);
    let out;
    try {
      out = renderToHighResCanvas(scale);
      if (cropOpts) {
        out = exportCanvasCroppedToContent(out, {
          paddingBelow: cropOpts.paddingBelow * scale,
          minHeight:    cropOpts.minHeight * scale,
        });
      }
    } catch {
      continue;   // allocation failed at this size — try smaller
    }
    // toBlob returns null (or throws) when the canvas is too large to encode.
    const blob = await new Promise((resolve) => {
      try { out.toBlob(resolve, type, quality); } catch { resolve(null); }
    });
    if (blob && blob.size > 2000) {
      return { blob, width: out.width, height: out.height };
    }
  }
  return null;
}

// The X export stays at 2× — X rejects PNG uploads over 5 MB, and a full
// 4K/8K poster PNG blows well past that.
const X_EXPORT_SCALE = 2;

// Text-preview paragraph font (the bullet copy drawn on the canvas in "Text"
// mode). Keep the paragraph copy firmly bold in both measure and draw passes
// so the rendered text doesn't drift between lighter/heavier states.
const PREVIEW_TEXT_WEIGHT = 700;
const PREVIEW_TEXT_FONT = "'Poppins', 'Segoe UI', Arial, sans-serif";

const IMAGE_PAN_LIMIT = 900;
const IMAGE_PAN_HEADROOM = 1.1;

/**
 * Render the poster onto an offscreen canvas at `scale`× the design size and
 * return that canvas. Used for exporting at higher resolution than the live
 * preview (Download, Post-to-X). All draw functions read `canvas.width` and
 * `canvas.height` for layout — those stay at design size, while the export
 * ctx is scaled, so pixels come out at scale× density without changing a
 * single coordinate in the renderer.
 */
function renderToHighResCanvas(scale = 2) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width  = canvas.width  * scale;
  exportCanvas.height = canvas.height * scale;
  const exportCtx = exportCanvas.getContext("2d");
  // High-quality image scaling for any upscale during cover-image draw
  exportCtx.imageSmoothingEnabled = true;
  exportCtx.imageSmoothingQuality = "high";
  exportCtx.scale(scale, scale);

  // Swap the module-level ctx → all draw calls inside renderPoster() now
  // target the offscreen canvas. Restore immediately after.
  const previous = ctx;
  const prevTargeted = state._targetedRender;
  ctx = exportCtx;
  state._targetedRender = true;   // paint this one canvas, not all three cards
  try {
    renderPoster();
  } finally {
    ctx = previous;
    state._targetedRender = prevTargeted;
  }
  return exportCanvas;
}

const scrapeForm = document.getElementById("scrape-form");
const scrapeUrlInput = document.getElementById("scrape-url");
const scrapeButton = document.getElementById("scrape-btn");
const scrapeStatus = document.getElementById("scrape-status");
const downloadButton = document.getElementById("download-btn");
const textDownloadButton = document.getElementById("text-download-btn");
const previewModeToggle = document.getElementById("preview-mode-toggle");
const authGate = document.getElementById("auth-gate");
const authMessage = document.getElementById("auth-message");
const loginForm = document.getElementById("login-form");
const loginUsername = document.getElementById("login-username");
const loginPassword = document.getElementById("login-password");
const loginSubmit = document.getElementById("login-submit");
const accountBox = document.getElementById("account-box");
const accountName = document.getElementById("account-name");
const accountRole = document.getElementById("account-role");
const logoutBtn = document.getElementById("logout-btn");
const analyticsView = document.getElementById("analytics-view");
const analyticsRefreshBtn = document.getElementById("analytics-refresh");
const analyticsStatus = document.getElementById("analytics-status");
const analyticsMetaTitle = document.getElementById("analytics-meta-title");
const analyticsMetaList = document.getElementById("analytics-meta-list");
const analyticsTodayDate = document.getElementById("analytics-today-date");
const analyticsDailyReset = document.getElementById("analytics-daily-reset");
const analyticsRosterToggle = document.getElementById("analytics-roster-toggle");
const analyticsRosterBody = document.getElementById("analytics-roster-body");
const analyticsRosterList = document.getElementById("analytics-roster-list");
const analyticsRosterCount = document.getElementById("analytics-roster-count");
const analyticsRosterTitle = document.getElementById("analytics-roster-title");
const analyticsRosterDesc = document.getElementById("analytics-roster-desc");
const analyticsSourceTrigger = document.getElementById("analytics-source-trigger");
const analyticsSourceMenu = document.getElementById("analytics-source-menu");
const analyticsSourceLabel = document.getElementById("analytics-source-label");
const analyticsCategoryTrigger = document.getElementById("analytics-category-trigger");
const analyticsCategoryMenu = document.getElementById("analytics-category-menu");
const analyticsCategoryLabel = document.getElementById("analytics-category-label");
const analyticsFrom = document.getElementById("analytics-from");
const analyticsTo = document.getElementById("analytics-to");
const analyticsRangeApply = document.getElementById("analytics-range-apply");
const analyticsRangeClear = document.getElementById("analytics-range-clear");
const analyticsUpdated = document.getElementById("analytics-updated");
const analyticsFilterSummary = document.getElementById("analytics-filter-summary");

const editPanel = document.getElementById("edit-panel");
const imagePanel = document.getElementById("image-panel");
const headlineEdit = document.getElementById("headline-edit");
const detailEdit = document.getElementById("detail-edit");
const imgOffsetX = document.getElementById("img-offset-x");
const imgOffsetY = document.getElementById("img-offset-y");
const storyOpacityControl = document.getElementById("story-opacity-control");
const storyOverlayOpacityInput = document.getElementById("story-overlay-opacity");
const imgResetBtn = document.getElementById("img-reset-btn");
const bgImageUpload = document.getElementById("bg-image-upload");
const bgUploadZone = document.getElementById("bg-upload-zone");
const bgPasteBtn = document.getElementById("bg-paste-btn");
const stockImagesSection = document.getElementById("stock-images-section");
const stockImagesGrid = document.getElementById("stock-images-grid");
const imgZoom = document.getElementById("img-zoom");
/* Bounds live with the input: the range attributes are the contract, and the
   - / + buttons must clamp to exactly the same numbers the restore path does. */
/* 5, not 10. applyZoom clamps to this, so it is also the floor on Fit — and a
   very wide panorama needs under 10% to sit inside a 9:16 frame (3000x600
   wants 9.8), which made the one shape that most needs fitting the one shape
   that could not be fitted. */
const ZOOM_MIN = 5;
const ZOOM_MAX = 300;
const ZOOM_STEP = 5;
const fontSizeInput = document.getElementById("font-size");
const accentColorInput = document.getElementById("accent-color");
const accentHexLabel = document.getElementById("accent-hex");
const accentAltColorInput = document.getElementById("accent-alt-color");
const accentAltHexLabel = document.getElementById("accent-alt-hex");
const tagPresetsContainer = document.getElementById("tag-presets");

const faceDetector =
  typeof window !== "undefined" && "FaceDetector" in window
    ? new FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
    : null;

/* ── Aspect-ratio layout presets ──
   Each preset defines the canvas size + every key element's position so a
   single render path can produce posters in different aspect ratios.
   9:16 is the original Zeplin spec; the others are tuned to look right at
   their respective dimensions. Tweak numbers per preset, not in renderPoster. */
/* Each preset's `headline.bottomPadding` is the gap (px) between the bottom
   of the LAST headline line and the canvas bottom. The headline's actual y
   position is computed at render time from:
       top = canvas.height - bottomPadding - blockHeight
   so the headline always anchors to the bottom of the canvas no matter how
   many lines it wraps to. The gradient.fadeHeight defines how tall the
   transparent→black fade is above the headline. */
const LAYOUT_PRESETS = {
  "9:16": {
    label: "9:16",
    sub:   "Story / Reel",
    W: 920,  H: 1700,
    logo:     { centerX: 810, centerY: 150, slotPix: 100, slotShortly: 112 },
    /* 9:16 leaves room for the preview engagement + nav bars while keeping
       the headline closer to the likes row. */
    headline: { x: 64, bottomPadding: 305, maxWidth: 920 - 128, defaultSize: 49 },
    tag:      { x: 64, gapAboveHeadline: 16 },
    gradient: { fadeHeight: 330 },
    showPreviewBars: true,
  },
  "4:5": {
    label: "4:5",
    sub:   "Feed Portrait",
    W: 1080, H: 1350,
    logo:     { centerX: 970, centerY: 130, slotPix: 92,  slotShortly: 104 },
    headline: { x: 70, bottomPadding: 110, maxWidth: 1080 - 140, defaultSize: 52 },
    tag:      { x: 70, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 300 },
    showPreviewBars: false,
  },
  "1:1": {
    label: "1:1",
    sub:   "Square",
    W: 1080, H: 1080,
    logo:     { centerX: 970, centerY: 120, slotPix: 90, slotShortly: 102 },
    headline: { x: 70, bottomPadding: 90, maxWidth: 1080 - 140, defaultSize: 50 },
    tag:      { x: 70, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 280 },
    showPreviewBars: false,
  },
  "16:9": {
    label: "16:9",
    sub:   "Wide",
    W: 1920, H: 1080,
    logo:     { centerX: 1810, centerY: 110, slotPix: 90, slotShortly: 102 },
    /* Tighter maxWidth + bigger font so the headline wraps to ~3 lines
       and reads with the same prominence as the portrait presets. */
    headline: { x: 90, bottomPadding: 100, maxWidth: 1200, defaultSize: 64 },
    tag:      { x: 90, gapAboveHeadline: 14 },
    gradient: { fadeHeight: 300 },
    showPreviewBars: false,
  },
};

/* ── State ── */

const state = {
  aspectRatio: "9:16",         // key into LAYOUT_PRESETS
  accent: "#3979FF",
  /* The second highlight colour. [square] and (round) brackets take `accent`;
     {curly} takes this one — see HIGHLIGHT_TONES. */
  accentAlt: "#7A1726",
  headline: "",
  detailText: "",
  sourceUrl: "",               // article URL from the last scrape (grounds the AI writer)
  // Where the story is filed on the web app. Chosen by the writer, confirmed
  // by QA at publish.
  categoryId: "",
  stateId: "",
  articleText: "",             // full scraped body text — what actually grounds the AI writer
  mainImage: null,
  ready: false,
  imageOffset: { x: 0, y: 0 },
  imageZoom: 100,
  headlineStyle: "half-purple",
  fontSize: 0, // 0 = auto
  enhanceStrength: 20,      // percent of the AI upscale to keep
  logoX: 810,
  logoY: 80,
  logoSize: 110,
  logoImage: null,
  shortlyLogoImage: null,   // alt logo used when exporting for X
  useShortlyLogo: false,    // toggled by the X download handler
  previewMode: "pix",       // "pix" | "x" | "text" | "video"

  /* ── Slide 2 video ──
     Slide 2 is either the Text card or a trimmed, branded video clip.
     `videoEl` is the <video> element itself — drawn straight to the canvas
     in preview, and the source of truth for trim bounds. `videoFile` is set
     for local uploads, `videoUrl` for scraped YouTube/Instagram links; the
     export path picks whichever is present. */
  videoEl: null,
  // What the <video> element is actually playing. Kept so a video page that
  // loses the shared player can reload the same source into its own.
  videoSrc: "",
  videoUrl: "",             // resolved source URL (scrape path)
  videoFile: null,          // File object (local upload path)
  videoMeta: null,          // { title, duration, uploader, ... } from /resolve
  videoSourceKind: "file",  // new clips are direct uploads; "link" is legacy-only
  trimStart: 0,
  trimEnd: 0,
  videoMuted: false,
  videoExporting: false,
  // Framing for the video slide. A landscape clip cropped to 9:16 loses most
  // of its width, so which slice you keep matters — normalised 0..1 so the
  // same value drives the canvas preview and ffmpeg's crop regardless of
  // resolution.
  videoFocus: { x: 0.5, y: 0.5 },
  // null = use the current date at paint time. Only set to a Date if a
  // specific day ever needs pinning; leaving it null is what keeps an
  // open tab honest across midnight.
  // The date printed on the slide. Null means "use today", which is what it
  // did before this was editable.
  /* Live values for the selected story page. Like every other page field
     these are swapped in and out by setActivePage; the page keeps the copy. */
  storyHeading: "",
  storyBody: "",
  storyOverlayOpacity: 100,
  /* Unfinished until the writer says otherwise. Defaulting to false meant a
     brand-new post was born already marked "submitted", so anything that
     saved it — a mis-click, autosave once a row existed — handed work in
     progress to QA. Only an explicit Submit clears this. */
  isDraft: true,
  createdAt: null,
  // Sent to DailyMattr with the post. Chosen here rather than inferred at
  // publish so the writer's wording survives.
  keywords: "",
  showTimestamp: true,
  videoCaption: "",         // burned into the clip, bottom-anchored
  videoCaptionSize: 48,     // design px at 920×1700; scaled per ratio — poster headline size
  secondLogoImage: null,
  tag: "none",       // "none" | "trending" | "breaking" | "swipe-video" (+ "-text" variants)
  tagImages: {},     // { trending: Image, breaking: Image } — SVG-backed tags only
  isDownloading: false,
  forceTextExport: false,
  imageSelectionNonce: 0,
  productImageAnalysis: null,
  // The signed-in account: { id, username, role, displayName }. Null until
  // /api/auth/me answers, and the gate keeps the editor hidden until then.
  user: null,

  /* ── Saved pix (Supabase) ──
     `pixId` is the row this editing session owns: null until the first save,
     then reused so a scrape → write → export sequence updates one row instead
     of leaving three. `article` keeps the last AI payload so the save does not
     have to scrape it back out of the DOM. */
  pixId: null,
  article: null,

  /* ── The row's standing, as the library reported it ──
     Read from the post when it is opened and otherwise left alone: none of
     these are editor content, and nothing here writes them back. They exist so
     the editor can refuse an action the server is going to refuse anyway —
     which matters because "the server will catch it" arrives AFTER a video
     encode and an upload that can take minutes, and because publishing is the
     one action in this app that cannot be undone.

     `publishedAt` set with `publishedId` null means an earlier publish was
     started and never confirmed: the story may or may not be live. Treated
     exactly like a confirmed publish here — the button stays shut either
     way — but the wording differs, because only one of the two has an id
     anyone can look up. */
  publishedAt: null,
  publishedId: null,
  /* The ids of earlier copies of this story that are still on the public site.
     Kept because a correction does not replace anything — it adds a second
     entry — so the only way to finish the job is to delete the superseded ones
     by hand in DailyMattr's portal, and that needs their ids. They were being
     recorded in published_history all along and shown nowhere. */
  publishedHistory: [],
  /* QA's sign-off. Read here so the editor knows the post's review is settled:
     an approved post is one DailyMattr has, or is about to be given, and a
     rewrite underneath it leaves the approval stamp pointing at text no
     reviewer saw. What it stops is chiefly the unattended write — autosave
     refuses to fire on an approved row (see considerAutosave). */
  approved: false,
  rejected: false,
  rejectedByName: "",

  // Uploads already pushed to storage, remembered against their exact source
  // so pressing Save repeatedly uploads once.
  storedImageFor: null,
  storedImageUrl: null,
  storedVideoFor: null,
  storedVideoUrl: null,
  // The bucket copy the trim range is measured on, when a reopened post is
  // being cut from one. Unlike storedVideoUrl it does not move when Save
  // uploads a new encode — see videoClipKey().
  clipSourceUrl: "",
  // The last MP4 the server rendered, kept so Export then Save does not
  // encode the same range twice.
  renderedClip: null,
  // Set the moment the writer edits the headline or paragraph by hand, so the
  // AI writer landing later cannot overwrite it.
  headlineTouched: false,
  detailTouched: false,
  scrapedTitle: "",         // the headline as scraped, before the AI rewrite
  imageQuery: "",           // AI-picked image search query from the scrape
  sourceImageUrl: null,     // og:image of the source article

  /* ── Image filters (CSS-style values applied via ctx.filter) ── */
  filterBrightness: 100,    // 0–200 (100 = neutral)
  filterContrast:   100,    // 0–200
  filterSaturation: 100,    // 0–200
  filterBlur:       0,      // 0–20 px
  filterPreset:     "none", // identifier of the active preset chip, if any
};

// initAuth() is started at the BOTTOM of this file, not here.
//
// Its first statement is a synchronous setAuthState("checking", …), and that
// touches module bindings declared further down. `const`/`let` are not hoisted
// the way `function` is, so calling it from line ~301 threw
//   ReferenceError: Cannot access 'dailymattrMetaLoaded' before initialization
// on every load, leaving the app stuck on "Checking your session…" forever.
//
// Moving the CALL after every declaration fixes the whole class of problem:
// otherwise each new module-level binding added below this point and touched
// by setAuthState silently re-breaks startup.

// Build the ctx.filter string from current state values.
function buildFilterString() {
  /* "none", not an identity chain. A filter that changes nothing still costs
     the whole filter pass — the picture goes to its own layer, through a
     colour matrix, and back — on every card of every repaint. Measured at
     ~10ms a card against ~2.5ms for the bare draw, so the DEFAULT state, no
     filter chosen, was paying for one it never asked for. */
  if (
    Number(state.filterBrightness) === 100 &&
    Number(state.filterContrast) === 100 &&
    Number(state.filterSaturation) === 100 &&
    !(Number(state.filterBlur) > 0)
  ) return "none";
  return [
    `brightness(${state.filterBrightness}%)`,
    `contrast(${state.filterContrast}%)`,
    `saturate(${state.filterSaturation}%)`,
    `blur(${state.filterBlur}px)`,
  ].join(" ");
}

/* ctx.filter ignores the current transform. Every other draw call on the
   export context is multiplied by its ctx.scale(), but a blur(38px) stays 38
   DEVICE pixels — so on a 4.5x export the Text slide came out with under a
   quarter of the blur the preview shows, and that is the image the CMS got.
   Radii are written in design pixels, so they are scaled here to match. */
function deviceFilter(filter, target = ctx) {
  if (!filter || filter === "none") return filter;
  const m = typeof target.getTransform === "function" ? target.getTransform() : null;
  const k = m ? Math.hypot(m.a, m.b) : 1;
  if (!(k > 0) || k === 1) return filter;
  return filter.replace(/blur\(\s*([\d.]+)px\s*\)/g, (_, px) =>
    `blur(${Math.round(Number(px) * k * 100) / 100}px)`);
}

// Filter presets — pure value bundles, applied by clicking a chip.
const FILTER_PRESETS = {
  "none":    { brightness: 100, contrast: 100, saturation: 100, blur: 0 },
  "vivid":   { brightness: 105, contrast: 120, saturation: 145, blur: 0 },
  "bw":      { brightness: 105, contrast: 110, saturation: 0,   blur: 0 },
  "warm":    { brightness: 102, contrast: 108, saturation: 130, blur: 0 },
  "cool":    { brightness: 100, contrast: 110, saturation: 90,  blur: 0 },
  "faded":   { brightness: 108, contrast: 88,  saturation: 80,  blur: 0 },
  "soft":    { brightness: 105, contrast: 95,  saturation: 105, blur: 1 },
};

// Active layout preset (always read through this; never hard-code coords).
function getLayout() {
  return LAYOUT_PRESETS[state.aspectRatio] || LAYOUT_PRESETS["9:16"];
}

/* ── Highlight bracket syntax ──
   Users wrap words to highlight them. All three pairs are equivalent:
       [Modi]     (Modi)     {Modi}
   We expose a single character class that matches any of those six chars,
   so every place that strips/checks brackets goes through these. */
const HIGHLIGHT_OPEN_CHAR  = /[\[({]/;     // matches  [  (  {
const HIGHLIGHT_CLOSE_CHAR = /[\])}]/;     // matches  ]  )  }
const HIGHLIGHT_ANY_CHARS_GLOBAL = /[\[\](){}]/g;  // any bracket char, /g for replace

/* ── Two highlight colours, chosen by which bracket you type ────────────────

   All three pairs used to be synonyms. They are not any more: {curly} marks a
   run in the second colour, and [square] / (round) keep the first.

   Round stays with square deliberately. It was a synonym for square before
   this, so every headline already written with (parens) keeps the colour it
   already has — a silent recolour of published work is not a feature.

   A run carries the STATE KEY, never the hex. So it resolves through whatever
   the pickers hold at render time, and a design saved last week does not
   carry a stale colour back with it. */
const HIGHLIGHT_TONES = { "{": "accentAlt", "[": "accent", "(": "accent" };

/* Which tone a word OPENS, or null if it opens none. First bracket wins: a
   mismatched "[word}" is square, because the alternative is taking the tone
   from a closing character that may belong to a different run. */
function highlightToneFor(rawWord) {
  const m = /[[({]/.exec(String(rawWord || ""));
  return m ? HIGHLIGHT_TONES[m[0]] : null;
}

/* The hex a tone resolves to now. An absent or unknown tone falls back to the
   accent, which is what every highlighted run was before there were two — so
   older content and any future bracket both land somewhere sensible. */
function highlightColor(tone) {
  return (tone && state[tone]) || state.accent;
}

// Switch ratio: resize canvas, reset any pan that no longer makes sense, re-render.
function applyAspectRatio(ratio) {
  if (!LAYOUT_PRESETS[ratio]) return;
  state.aspectRatio = ratio;
  const L = LAYOUT_PRESETS[ratio];
  canvas.width = L.W;
  canvas.height = L.H;
  /* Reset image pan (positions vary too much across ratios to preserve).

     On EVERY page, not just the selected one. The ratio belongs to the post,
     so switching 9:16 to 16:9 reframes all of it — but this cleared only live
     state, leaving slides 2-5 panned for the old shape with their subjects
     half out of frame until each was selected and reset by hand. */
  state.imageOffset = { x: 0, y: 0 };
  for (const page of pages) {
    if (page.content && "imageOffset" in page.content) {
      page.content.imageOffset = { x: 0, y: 0 };
    }
  }
  if (typeof imgOffsetX !== "undefined") imgOffsetX.value = 0;
  if (typeof imgOffsetY !== "undefined") imgOffsetY.value = 0;
  // Update the size badge in the preview header
  const px = document.querySelector(".preview-pixels");
  if (px) px.textContent = `${L.W} × ${L.H}`;
  renderPoster();
}

/* ── Drag state (not part of poster state) ── */
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let dragOffsetStart = { x: 0, y: 0 };

const defaultMain = makeMainPlaceholder();

/* ── Load the real Pix logo ── */
const pixLogo = new Image();
pixLogo.src = "./assests/pix-logo.png?v=20260824";
pixLogo.onload = () => {
  state.logoImage = pixLogo;
  renderPoster();
};
pixLogo.onerror = () => {
  console.warn("Logo failed to load — using text fallback.");
};

// Alt logo used only when exporting for X downloads.
// PNG, square — same aspect ratio as Pix logo, so the existing slot scaler
// handles it identically (130×130 slot for X exports, see drawFixedLogos).
const shortlyLogo = new Image();
shortlyLogo.src = "./assests/shortly-logo.png";
shortlyLogo.onload = () => {
  state.shortlyLogoImage = shortlyLogo;
  renderPoster();
  console.log("✓ Shortly logo loaded — will be used for X exports");
};
shortlyLogo.onerror = () => {
  console.error("✗ Shortly logo failed to load from", shortlyLogo.src, "— X exports will fall back to Pix logo.");
};

/* ── 4:5 (Feed) poster footer assets ──
   The DailyMattr wordmark plus the two store-badge glyphs. The glyphs are
   tiny inline SVGs so the badges need no extra files; their text is drawn
   with ctx so it uses the Poppins the page already loads. */
const footerImages = {};
const FOOTER_IMAGE_SOURCES = {
  logo: "./assests/logo.svg",
  play: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <polygon points="3,2.5 13,12 3,21.5" fill="#00A0FF"/>
      <polygon points="3,2.5 16.5,9.2 13,12" fill="#00D86F"/>
      <polygon points="3,21.5 13,12 16.5,14.8" fill="#FF3A44"/>
      <polygon points="13,12 16.5,9.2 21.5,12 16.5,14.8" fill="#FFC000"/>
    </svg>`),
  apple: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="#fff" d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`),
};
function loadFooterImage(key, src) {
  const img = new Image();
  img.onload = () => { footerImages[key] = img; renderPoster(); };
  img.onerror = () => console.warn(`Footer ${key} image failed to load.`);
  img.src = src;
}
Object.entries(FOOTER_IMAGE_SOURCES).forEach(([key, src]) => {
  if (key !== "logo") { loadFooterImage(key, src); return; }
  // The wordmark file is brand blue; the footer wants it white. Recolour the
  // SVG source on load rather than keeping a second copy of the file.
  fetch(src)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
    .then((svg) => {
      const white = svg.replace(/fill="(?!none)[^"]*"/gi, 'fill="#FFFFFF"');
      loadFooterImage(key, "data:image/svg+xml;charset=utf-8," + encodeURIComponent(white));
    })
    .catch(() => loadFooterImage(key, src));
});


/* ── Load tag SVGs ── */
const tagFiles = {
  "trending": "./assests/Trending.svg",
  "trending-text": "./assests/Trending without logo.svg",
  "breaking": "./assests/Braking.svg",
  "breaking-text": "./assests/Breaking without icon.svg"
};
Object.entries(tagFiles).forEach(([key, src]) => {
  const img = new Image();
  img.src = src;
  img.onload = () => { state.tagImages[key] = img; renderPoster(); };
});

/* ── Canvas-drawn tags ──
   Same 37px bar as the SVG tags above, but painted with ctx so the label uses
   the Poppins the page already loads instead of needing an outlined SVG. */
const TAG_BAR_HEIGHT = 37;   // matches the SVG tag assets
const TAG_PAD_X      = 12;   // side padding around the label
const TAG_ICON_BOX   = 22;   // the glyph is drawn inside this square
const TAG_ICON_GAP   = 10;   // space between glyph and label
const TAG_FONT       = "600 21px 'Poppins', 'Segoe UI', Arial, sans-serif";

// Brand blue, matching the headline accent.
const DRAWN_TAGS = {
  "swipe-video":      { label: "Swipe for Video", bg: "#3979FF", icon: true },
  "swipe-video-text": { label: "Swipe for Video", bg: "#3979FF", icon: false }
};

// Wait for both Poppins AND Roboto Serif fonts to load before first render
document.fonts.ready.then(async () => {
  // Ensure Roboto Serif is loaded for headline rendering, and Poppins for the
  // drawn tag badges — their width comes from measureText, so a fallback font
  // at first paint would size the bar wrong.
  try {
    await document.fonts.load("600 49px 'Roboto Serif'");
    /* The story slide measures its heading at 700 and wraps its body at 500,
       and a face is not fetched until something asks for it. Warming only 600
       meant the first paint wrapped both against a fallback and re-broke the
       lines once the real faces arrived. */
    await document.fonts.load("700 46px 'Roboto Serif'");
    await document.fonts.load("500 41px 'Roboto Serif'");
    await document.fonts.load(TAG_FONT);
  } catch (e) { /* font may already be loaded */ }
  await waitForImage(defaultMain);
  await ensureImageFocalPoint(defaultMain);
  renderPoster();
});

/* ── Events ── */

// Mode tab switching
const modeTabs = document.getElementById("mode-tabs");
const writeForm = document.getElementById("write-form");
const writeHeadline = document.getElementById("write-headline");
const writeDetail = document.getElementById("write-detail");
const writeApplyBtn = document.getElementById("write-apply-btn");
const writeStatus = document.getElementById("write-status");

modeTabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".mode-tab");
  if (!tab) return;
  modeTabs.querySelectorAll(".mode-tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");

  const mode = tab.dataset.mode;
  if (mode === "link") {
    scrapeForm.hidden = false;
    writeForm.hidden = true;
  } else {
    scrapeForm.hidden = true;
    writeForm.hidden = false;
  }
});

if (previewModeToggle) {
  previewModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".preview-mode-btn");
    if (!btn) return;
    const mode = ["pix", "x", "text", "video"].includes(btn.dataset.previewMode) ? btn.dataset.previewMode : "pix";
    state.previewMode = mode;
    syncPreviewModeUI();
    // Video mode drives its own repaint loop while the clip plays.
    if (mode === "video") startVideoPreviewLoop(); else stopVideoPreviewLoop();
    if (mode === "text" && state.aspectRatio !== "9:16") {
      applyAspectRatio("9:16");
      return;
    }
    renderPoster();
  });
}

function setWriteStatus(message, type) {
  if (!writeStatus) return;
  writeStatus.textContent = message || "";
  writeStatus.className = "status-text";
  if (type) writeStatus.classList.add(type);
}

/* ── Sign in ──
   Pix has its own accounts. Two roles:
     writer — builds posts, saves them, and can re-open and re-save their own
     qa     — the same, plus editing and deleting everyone else's

   The gate covers the app until /api/auth/me answers, so a signed-out visitor
   never sees the editor. Every rule here is a convenience: the server applies
   the same ones to every request, and is the only place they are enforced. */

async function initAuth() {
  setAuthState("checking", "Checking your session…");
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (response.ok) {
      const payload = await response.json();
      applySession(payload.user);
      return;
    }
    const payload = await response.json().catch(() => ({}));
    // 503 means the database is unreachable — a different problem from being
    // signed out, and saying "sign in" would send the user round in circles.
    setAuthState("blocked", response.status === 503
      ? (payload.error || "Logins are unavailable right now.")
      : "Sign in to continue.");
  } catch {
    setAuthState("blocked", "Could not reach the server. Check your connection and try again.");
  }
}

/* ── DailyMattr publish panel ──
   Declared HERE, above applySession/setAuthState, because those two touch
   these bindings. They used to sit ~280 lines further down, which is a
   temporal dead zone: `const`/`let` are not hoisted like `function`, so the
   app died with "Cannot access 'dailymattrMetaLoaded' before initialization"
   and hung on the auth-checking screen.

   Not a race — initAuth()'s first statement is a SYNCHRONOUS setAuthState(),
   so it ran during module evaluation and threw on every single load, before
   any network call. See the note beside the state object. */
const dailymattrRefreshBtn = document.getElementById("dailymattr-refresh");
const dailymattrCategory = document.getElementById("dailymattr-category");
const dailymattrState = document.getElementById("dailymattr-state");
const dailymattrKeywords = document.getElementById("dailymattr-keywords");
const dailymattrContent = document.getElementById("dailymattr-content");
const dailymattrPublishBtn = document.getElementById("dailymattr-publish-btn");
const dailymattrStatus = document.getElementById("dailymattr-status");
const dailymattrMediaMode = document.getElementById("dailymattr-media-mode");
const dailymattrMediaInputs = [3, 4, 5].map((slot) => ({
  slot,
  input: document.getElementById(`dailymattr-media-${slot}`),
  name: document.getElementById(`dailymattr-media-name-${slot}`),
  card: document.querySelector(`[data-media-slot="${slot}"]`),
  remove: document.querySelector(`[data-remove-media="${slot}"]`),
}));

const DAILYMATTR_META_ENDPOINT = "/api/dailymattr/meta";
const DAILYMATTR_PUBLISH_ENDPOINT = "/api/dailymattr/publish";
const PIX_ANALYTICS_ENDPOINT = "/api/pix-analytics";
const DAILYMATTR_EXPORT_LONG_EDGES = [3840, 2560];
/* ── Compression for publishing ──
   Published slides go as JPEG, and go through a budget, not a fixed setting.

   A slide is a photograph with type over it, which is the case PNG is worst
   at: it stores every pixel losslessly and cannot use any of the redundancy a
   photo is full of. Measured on a real five-slide carousel, the poster alone
   came to 12.12 MB and the whole post to 42.32 MB. DailyMattr answers that
   with a bare "Validation Error" naming no field, so the size never appeared
   anywhere QA could see it — and a two-slide post went through while the same
   story as a carousel did not.

   A fixed quality would only move the guess: a busy photograph compresses far
   worse than a flat one, so the honest thing is to aim at a size and stop as
   soon as it is met. The ladder drops quality first, because at this
   resolution that is invisible, and only then drops resolution. The first rung
   already lands around 1 MB for a typical slide, so the usual cost of this is
   exactly one render — the rest is there for the slide that needs it.

   Downloads are untouched: a writer saving a poster still gets the exact PNG
   at full resolution. This applies only to what goes over the wire. */
function mbLabel(bytes) {
  return `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
}

const DAILYMATTR_SLIDE_BUDGET_BYTES = 3 * 1024 * 1024;
/* Two limits, because they have two different remedies.

   The SLIDES budget covers what we render and can therefore compress — the
   JPEG cards. If those are heavy the answer is to compress harder or drop a
   slide, and the ladder above has usually already done the first.

   The CEILING covers the whole upload including video, and is deliberately
   far looser. A clip's size is inherent: it cannot be re-encoded in the
   browser, and the only real remedy is a shorter trim range. Counting a video
   against the slides budget was simply wrong — it blocked every video post
   with advice ("replace the heaviest picture") that does not apply to a video,
   and four video posts have published to DailyMattr successfully (buzz ids
   8281, 8375, 8386, 8429) with clips up to 32s, so the platform plainly
   accepts them. The ceiling matches the per-file cap the server already
   enforces, so this refuses only what could not have been sent anyway. */
const DAILYMATTR_SLIDES_BUDGET_BYTES = 20 * 1024 * 1024;
const DAILYMATTR_TOTAL_CEILING_BYTES = 64 * 1024 * 1024;
const DAILYMATTR_COMPRESSION_LADDER = [
  { longEdges: [3840], quality: 0.92 },
  { longEdges: [3840], quality: 0.82 },
  { longEdges: [2560], quality: 0.85 },
  { longEdges: [2560], quality: 0.72 },
  { longEdges: [1920], quality: 0.8 },
  { longEdges: [1920], quality: 0.65 },
];

/* Render a slide small enough to send, and say what it took.

   Returns the first rung that fits the budget. If nothing fits — a slide that
   is somehow enormous at 1920 — it returns the smallest it managed rather than
   nothing, because a slightly-over slide that the caller can weigh against the
   whole-post budget beats a failed publish with no explanation. */
async function exportSlideForPublish(mode, maxBytes = DAILYMATTR_SLIDE_BUDGET_BYTES) {
  let smallest = null;
  for (let rung = 0; rung < DAILYMATTR_COMPRESSION_LADDER.length; rung += 1) {
    const { longEdges, quality } = DAILYMATTR_COMPRESSION_LADDER[rung];
    const shot = await exportSlidePng(mode, longEdges, { type: "image/jpeg", quality });
    if (!shot?.blob) continue;
    if (!smallest || shot.blob.size < smallest.blob.size) smallest = { ...shot, rung, quality };
    if (shot.blob.size <= maxBytes) return { ...shot, rung, quality, withinBudget: true };
  }
  return smallest ? { ...smallest, withinBudget: false } : null;
}

/* An image QA attached by hand, squeezed the same way. A phone photo dropped
   into an extra slot is routinely 8-12 MB, which is the same failure arriving
   by a different door. Videos are passed through untouched — re-encoding one
   in the browser costs more than it saves, and the trim range already bounds
   it. */
async function compressAttachedImage(file, maxBytes = DAILYMATTR_SLIDE_BUDGET_BYTES) {
  if (!file || !/^image\//i.test(file.type) || file.size <= maxBytes) return file;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;   // undecodable here; let the server and DailyMattr judge it
  }
  try {
    for (const { longEdges, quality } of DAILYMATTR_COMPRESSION_LADDER) {
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1, longEdges[0] / longest);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => {
        try { canvas.toBlob(resolve, "image/jpeg", quality); } catch { resolve(null); }
      });
      if (blob && blob.size <= maxBytes) {
        const name = String(file.name || "attachment").replace(/\.[^.]+$/, "") + ".jpg";
        return new File([blob], name, { type: "image/jpeg" });
      }
    }
    return file;
  } finally {
    bitmap.close?.();
  }
}
// Must match MAX_DAILYMATTR_MEDIA_BYTES on the server. Checked on the client
// too so an oversized clip fails in a second with a useful message, rather
// than after uploading tens of megabytes only to be cut off by busboy.
const DAILYMATTR_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
// DailyMattr accepts five media items per Buzz post, images and video mixed.
const DAILYMATTR_MAX_MEDIA_ITEMS = 5;
const dailymattrDraftTouched = { content: false, keywords: false, category: false, state: false };
let dailymattrMetaLoaded = false;
let analyticsLoadedForRole = "";

function isDailyMattrVideo(file) {
  return Boolean(file && /^video\/(mp4|quicktime)$/i.test(file.type));
}

function isDailyMattrImage(file) {
  return Boolean(file && /^image\/(jpeg|png|webp)$/i.test(file.type));
}

function dailyMattrExtraFiles() {
  return dailymattrMediaInputs
    .map(({ slot, input }) => ({ slot, file: input?.files?.[0] || null }))
    .filter(({ file }) => file);
}

function syncDailyMattrMediaCount() {
  if (!dailymattrMediaMode) return;
  dailymattrMediaMode.textContent = `${dailyMattrExtraFiles().length} / 3 added`;
  dailymattrMediaMode.className = "publish-mode";
}

function resetDailyMattrMediaSlot(item) {
  if (item.input) item.input.value = "";
  if (item.name) item.name.textContent = "Add image or video";
  if (item.card) item.card.classList.remove("has-file");
  if (item.remove) item.remove.hidden = true;
  syncDailyMattrMediaCount();
}

function resetDailyMattrExtraMedia() {
  dailymattrMediaInputs.forEach(resetDailyMattrMediaSlot);
}

function validateDailyMattrExtraFiles() {
  const extras = dailyMattrExtraFiles();
  for (const { slot, file } of extras) {
    if (!isDailyMattrImage(file) && !isDailyMattrVideo(file)) {
      return `Output ${slot} must be a JPG, PNG, WEBP, MP4 or MOV file.`;
    }
    if (file.size > DAILYMATTR_MAX_MEDIA_BYTES) {
      return `Output ${slot} is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${DAILYMATTR_MAX_MEDIA_BYTES / 1048576} MB per file.`;
    }
  }
  return "";
}

/* Capability checks, so a new role does not mean hunting every `=== "qa"`
   in the file. An admin is a superset of QA. */
function roleLabel(role) {
  return role === "admin" ? "Admin" : role === "qa" ? "QA" : "Writer";
}

function canReviewRole(role) { return role === "qa" || role === "admin"; }
function isAdminRole(role) { return role === "admin"; }

/* ── Your own count, in the header ──

   Every role sees a number for their own work. A writer sees how many stories
   they have written, a reviewer how many they have cleared — the question each
   one actually asks about themselves. Analytics answers this for QA and admins
   only, because it reports across the whole team; a writer's own output is not
   management reporting and should not have been behind that gate.

   Weekly leads, with the all-time total behind it, matching how the roster
   counts read elsewhere so the two never tell different stories. */
const accountCount = document.getElementById("account-count");

async function refreshMyPixCount() {
  if (!accountCount) return;
  if (!state.user) {
    accountCount.hidden = true;
    return;
  }
  try {
    const response = await fetch("/api/pix/stats", { credentials: "same-origin" });
    if (!response.ok) {
      accountCount.hidden = true;
      return;
    }
    const { counts } = await response.json();
    // Kept so the review tiles can show today/this-week without refetching.
    lastPixCounts = counts || null;
    if (!counts) {
      accountCount.hidden = true;
      return;
    }
    const reviewer = canReviewRole(state.user.role);
    /* A reviewer is measured by what they PUBLISHED, not by verdicts given.
       Approving and publishing are different acts — a reviewer can clear a
       queue and send none of it — and "how many did I publish" is the
       question they actually ask about their own day. Reviewed stays in the
       tooltip: it is the bigger number and the one with full history, whereas
       published is only accurate from the ledger forward. */
    const today = reviewer ? counts.published_today : counts.written_today;
    const week  = reviewer ? counts.published_week  : counts.written_week;
    const total = reviewer ? counts.published_total : counts.written_total;
    /* "submitted", not "written": the tally counts posts that were handed
       over, and drafts are deliberately outside it — they are unfinished work,
       and counting them made the chip read one higher than anything the writer
       could point at in a list. Their drafts are still theirs to find, under
       My posts. */
    const noun = reviewer ? "published" : "submitted";
    /* Both numbers, because they answer different questions: today is "am I
       on track", the week is "how am I doing". These count POSTS, not saves —
       reopening a pix and editing it never moves them, which is the whole
       point of a per-writer tally. */
    accountCount.innerHTML =
      `<strong>${today}</strong>&nbsp;today <span class="nav-count-sep">·</span> <strong>${week}</strong>&nbsp;this week`;
    accountCount.title = reviewer
      ? `${today} published today · ${week} in the last 7 days · ${total} since the publish ledger began`
        + `
${counts.reviewed_total} reviewed in total (approved or rejected — full history)`
        /* Only when they write. A reviewer who never does should not be shown
           a zero they have to work out the meaning of. */
        + (Number(counts.written_total)
            ? `
${counts.written_today} written by you today · ${counts.written_total} in total`
            : "")
      : `${today} submitted today · ${week} in the last 7 days · ${total} all time`;
    // Pulse only on an actual change, so it reads as "that went up" rather
    // than as an animation that fires on every poll.
    if (accountCount.dataset.week !== String(week) && accountCount.dataset.week !== undefined) {
      accountCount.classList.remove("just-changed");
      void accountCount.offsetWidth;                       // restart the animation
      accountCount.classList.add("just-changed");
    }
    accountCount.dataset.week = String(week);
    accountCount.hidden = false;
  } catch {
    // A header ornament must never be the thing that breaks sign-in.
    accountCount.hidden = true;
  }
}

function applySession(user) {
  state.user = user || null;
  document.body.dataset.role = user?.role || "";
  if (accountName) accountName.textContent = user?.displayName || user?.username || "—";
  if (accountRole) {
    // The badge names the role, it does not test a capability — an admin
    // showing "QA" here is simply wrong, however similar their powers are.
    accountRole.textContent = roleLabel(user?.role);
    accountRole.classList.toggle("is-qa", canReviewRole(user?.role));
    accountRole.classList.toggle("is-admin", isAdminRole(user?.role));
  }
  if (accountBox) accountBox.hidden = !user;
  if (logoutBtn) logoutBtn.hidden = !user;
  refreshMyPixCount();
  syncPrimaryAction();
  setAuthState(user ? "ready" : "blocked", user ? "" : "Sign in to continue.");
  // The mobile editor sheet must not open until the auth gate is gone. Opening
  // it during module setup puts its fixed backdrop above the sign-in card.
  if (user && isMobile()) setSheetOpen(true);
  syncReviewCopy();
  // Publishing to shortlyindia.com is QA-only (the server returns 403 for
  // writers). Hide the panel rather than showing controls that cannot work,
  // and don't spend a DailyMattr round-trip loading options a writer can
  // never use.
  syncDailyMattrAccess();
  // Required/conditional section UI must update immediately on role change;
  // loading the live option lists can finish later or fail independently.
  syncSectionInputs();
  if (canReviewRole(user?.role)) loadDailyMattrMeta({ force: true });
  // Writers need the lists too, to file their own story.
  if (user) loadSectionOptions();
  // Whoever just signed in gets their own list, not the previous user's.
  if (user && document.body.classList.contains("view-review")) loadReviewQueue();
  if (user && document.body.classList.contains("view-analytics")) {
    // A writer signing in on the analytics view has no analytics to see.
    if (canReviewRole(user.role)) loadAnalytics({ force: true });
    else setView("poster");
  }
}

function setAuthState(status, message) {
  document.body.classList.remove("auth-checking", "auth-ready", "auth-blocked");
  document.body.classList.add(status === "ready" ? "auth-ready" : status === "blocked" ? "auth-blocked" : "auth-checking");
  if (status !== "ready") document.body.classList.remove("sheet-open");
  if (authMessage) authMessage.textContent = message || "";
  if (authGate) authGate.hidden = status === "ready";
  if (loginForm) loginForm.hidden = status !== "blocked";
  if (status !== "ready") {
    state.user = null;
    document.body.dataset.role = "";
    if (accountBox) accountBox.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;
    analyticsLoadedForRole = "";
    dailymattrMetaLoaded = false;
    syncDailyMattrAccess();
    fillSelectOptions(dailymattrCategory, [], "Sign in to load categories");
    fillSelectOptions(dailymattrState, [], "Optional");
    setDailyMattrStatus("");
    setAnalyticsStatus("");
  }
  if (status === "blocked" && loginUsername) {
    // Focus only once the form is actually on screen.
    requestAnimationFrame(() => loginUsername.focus());
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    if (!username || !password) {
      if (authMessage) authMessage.textContent = "Enter your username and password.";
      return;
    }

    loginSubmit.disabled = true;
    loginSubmit.textContent = "Signing in…";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (authMessage) authMessage.textContent = payload.error || "Sign in failed.";
        loginPassword.value = "";
        loginPassword.focus();
        return;
      }
      loginPassword.value = "";
      applySession(payload.user);
    } catch {
      if (authMessage) authMessage.textContent = "Could not reach the server.";
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = "Sign in";
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch { /* the cookie is cleared server-side; a failure here is cosmetic */ }
    // Reload rather than tear the editor down by hand: it drops every scrap of
    // the previous user's work from memory, which is what signing out means.
    window.location.reload();
  });
}

/** True when this user may write to `post` (a library row). */
function canEditPost(post) {
  if (!state.user) return false;
  if (canReviewRole(state.user.role)) return true;
  return !post?.user_login_id || post.user_login_id === state.user.id;
}

function resetImageControls() {
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;
}

/* ── Undo: back to the picture the writer posted ─────────────────────────

   AI Enhance is a reviewer's tool and it costs money, so it gets used on
   pictures that turn out not to need it: an expand that pulls back further
   than the story wanted, a restore that smooths a texture somebody liked.
   Until now the only way back was to re-open the post, which throws away
   every other edit made since.

   ONE SLOT PER PAGE, and it holds the picture as the reviewer FOUND it —
   not a history of every change. Enhancing twice still undoes to the same
   place, because the question the button answers is "show me what the writer
   sent", not "step back one operation". The framing goes with it: an expand
   resets zoom and pan (see runImageAI), so restoring the picture without the
   numbers would hand back the right photograph in the wrong crop.

   Held OUTSIDE page.content deliberately. content is what gets captured into
   the saved design — syncActivePageContent() replaces it wholesale with the
   declared fields — so anything parked there is either discarded on the next
   sync or, if declared, written into every autosave. This is editor state
   that lives as long as the tab does, and a Map keyed by page id is the whole
   of it.

   STALENESS IS DETECTED, NOT SUBSCRIBED TO. Every picture the AI hands back
   is remembered alongside the original, and a slot is only honoured while the
   page is still showing one of them. The moment a reviewer uploads, pastes,
   drags in or picks a different image, the picture on the page is none of
   ours and the slot is dropped on the next look. That is why none of the
   half-dozen places an image can arrive from has to know this exists — and
   why an enhance that failed cannot leave a button offering to undo it. */
const imageUndo = new Map();

/* The picture actually on a page right now.

   The active page's content is only refreshed by syncActivePageContent(), so
   between an edit and the next render its `content.mainImage` is stale — the
   truth is in `state`. Every other page has it the other way round. Same
   live/stored split commitFieldToPage() makes on the way in. */
function imageOnPage(page) {
  if (!page) return null;
  return activePage() === page ? state.mainImage : (page.content?.mainImage || null);
}

/* The slot for a page, or null — dropping it if the picture has moved on to
   something the AI did not produce. */
function imageUndoEntry(page) {
  if (!page) return null;
  const entry = imageUndo.get(page.id);
  if (!entry) return null;
  const current = imageOnPage(page);
  if (!current || !entry.produced.has(current)) {
    imageUndo.delete(page.id);
    return null;
  }
  return entry;
}

function canUndoImage(page) {
  const entry = imageUndoEntry(page);
  // A slot whose original is still the picture on screen is a slot with
  // nothing to undo — the enhance has not landed yet, or it failed.
  return Boolean(entry) && imageOnPage(page) !== entry.image;
}

/* Called before an enhance replaces the picture. First one wins: the slot is
   the writer's image, and a second enhance must not overwrite it with the
   first enhance's output. */
function rememberImageBeforeAI(page, image) {
  if (!page || !image) return;
  if (imageUndo.has(page.id)) return;
  imageUndo.set(page.id, {
    image,
    offset: { ...(page.content?.imageOffset || state.imageOffset || { x: 0, y: 0 }) },
    zoom: numberOr(page.content?.imageZoom ?? state.imageZoom, 100),
    // The original counts as one of ours: it is what the page shows between
    // the click and the result landing, and a failed enhance leaves it there.
    produced: new Set([image]),
  });
}

// Whatever the AI just handed back, so the slot survives looking at it.
function noteAIImage(page, image) {
  if (!page || !image) return;
  imageUndo.get(page.id)?.produced.add(image);
}

function revertImageToOriginal() {
  const page = activePage();
  const entry = imageUndoEntry(page);
  if (!entry || !canUndoImage(page)) return;

  commitFieldToPage(page, "mainImage", entry.image);
  commitFieldToPage(page, "imageOffset", { ...entry.offset });
  commitFieldToPage(page, "imageZoom", entry.zoom);
  syncControl(imgOffsetX, entry.offset.x);
  syncControl(imgOffsetY, entry.offset.y);
  syncControl(imgZoom, entry.zoom);

  /* The slot is KEPT, not cleared. The original is still the original, so an
     enhance-undo-enhance sequence undoes to the same picture rather than to
     the middle of its own history — and canUndoImage() disables the button on
     its own now that the page is showing it. */
  renderPoster();
  setEnhanceStatus("↩ Back to the image as the writer posted it.", "success");
}

/* Enable the button only when there is something behind it. Called from the
   end of renderPoster(), which is the one place that runs after every change
   to the picture with the live page's values restored — the per-card paint
   sees whichever page it is drawing, not the one on screen. */
function syncImageUndoUI() {
  const btn = document.getElementById("image-undo-btn");
  if (!btn) return;
  const enhancing = document.getElementById("ai-enhance-btn")?.classList.contains("working");
  btn.disabled = Boolean(enhancing) || !canUndoImage(activePage());
}

/* The page a pending image pick belongs to.

   The nonce alone answers "is this still the picture the writer wants"; it
   does not answer "which slide did they want it ON". setActivePage never
   bumps the nonce, so clicking another card mid-fetch left the arriving photo
   to land on whatever slide was then selected — replacing its picture, while
   the slide the pick was made for stayed empty. */
let imageSelectionOwner = null;

function claimImageSelection() {
  state.imageSelectionNonce += 1;
  imageSelectionOwner = activePage();
  return state.imageSelectionNonce;
}

/* An image that arrived for a page the writer has since left. Files it on that
   page and reports true, so the caller skips the live path entirely rather
   than writing someone else's slide. */
function stashImageForAbsentPage(page, img) {
  if (!page || activePage() === page) return false;
  if (!page.content) page.content = {};
  page.content.mainImage = img;
  // A fresh picture is unframed, matching resetImageControls() on the live path.
  page.content.imageOffset = { x: 0, y: 0 };
  page.content.imageZoom = 100;
  renderPoster();
  return true;
}

function isXRenderMode() {
  return state.useShortlyLogo || (!state.isDownloading && state.previewMode === "x");
}

function isTextPreviewMode() {
  return state.previewMode === "text" && (!state.isDownloading || state.forceTextExport);
}

function isStoryPreviewMode() {
  return state.previewMode === "story";
}

// True while painting the video slide. `videoOverlayExport` is set only by
// renderVideoOverlayPng(), which needs the branding layer on transparency
// with no video frame and no mockup chrome underneath it.
function isVideoPreviewMode() {
  return state.previewMode === "video" || state.videoOverlayExport;
}

function syncPreviewModeUI() {
  if (!previewModeToggle) return;
  previewModeToggle.querySelectorAll(".preview-mode-btn").forEach((btn) => {
    const active = btn.dataset.previewMode === state.previewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
  updatePrimaryDownloadButton();
}

function updatePrimaryDownloadButton() {
  // Update only the label span — the button also contains an SVG icon that
  // textContent assignment on the button itself would wipe out.
  const label = document.getElementById("download-btn-label");
  if (label) label.textContent = "Download Poster";
}

updatePrimaryDownloadButton();

function buildFallbackImageSuggestions(searchQuery, count = 6) {
  const words = searchQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const label = (words.join(" ") || "news").toUpperCase();
  const palettes = [
    ["#0f172a", "#7c3aed", "#22d3ee"],
    ["#111827", "#ef4444", "#f59e0b"],
    ["#082f49", "#14b8a6", "#eab308"],
    ["#18181b", "#e11d48", "#a3e635"],
    ["#1e1b4b", "#2563eb", "#f97316"],
    ["#052e16", "#16a34a", "#38bdf8"],
  ];

  return Array.from({ length: count }, (_, index) => {
    const [base, accent, glow] = palettes[index % palettes.length];
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${base}"/>
            <stop offset="58%" stop-color="#050505"/>
            <stop offset="100%" stop-color="${accent}"/>
          </linearGradient>
          <radialGradient id="g1" cx="${20 + index * 11}%" cy="${18 + index * 7}%" r="58%">
            <stop offset="0%" stop-color="${glow}" stop-opacity="0.72"/>
            <stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
          </radialGradient>
          <filter id="blur"><feGaussianBlur stdDeviation="36"/></filter>
        </defs>
        <rect width="1200" height="1800" fill="url(#bg)"/>
        <circle cx="${260 + index * 120}" cy="${260 + index * 95}" r="360" fill="url(#g1)" filter="url(#blur)"/>
        <circle cx="${940 - index * 70}" cy="${1120 + index * 46}" r="420" fill="${accent}" opacity="0.22" filter="url(#blur)"/>
        <g opacity="0.22" stroke="#fff" stroke-width="2">
          ${Array.from({ length: 18 }, (_, line) => `<path d="M${line * 84 - 220} 0 L${line * 84 + 520} 1800"/>`).join("")}
        </g>
        <text x="88" y="220" fill="#fff" opacity="0.22" font-family="Arial, sans-serif" font-size="64" font-weight="800">${escapeSvgText(label)}</text>
      </svg>
    `;
    const imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return {
      id: `fallback-${index + 1}`,
      alt: `${searchQuery} related image`,
      preview: imageUrl,
      image: imageUrl,
      imageProxy: imageUrl,
      source: "fallback",
    };
  });
}

function escapeSvgText(value) {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[ch]));
}

// Write mode — build poster from manual text
writeApplyBtn.addEventListener("click", async () => {
  const text = writeHeadline.value.trim();
  if (!text) return;
  // Slide 2 is NOT a reprint of slide 1. Falling back to the headline here
  // put the same sentence on both cards, which is the "text paragraph shows
  // the headline" bug and also what the editorial spec forbids.
  const detail = writeDetail.value.trim();

  // Building from hand-written text is a new post, not an edit of whatever
  // was scraped before it. Without this the save would write the new headline
  // onto the previous story's row — keeping its source URL and article text,
  // which now describe something else entirely.
  startNewPix();

  state.headline = text;
  state.detailText = limitDetailTextClient(detail);
  headlineEdit.value = text;
  if (detailEdit) detailEdit.value = state.detailText;
  editPanel.hidden = false;
  imagePanel.hidden = false;
  renderPoster();
  scrollPreviewIntoViewIfMobile();
  closeSheetIfMobile();

  writeApplyBtn.disabled = true;
  setWriteStatus("Finding matching images...");
  await fetchStockImages(text, {
    autoApplyRandom: true,
    onStatus: setWriteStatus,
  });
  writeApplyBtn.disabled = false;
});

// Live sync: write-headline → headline-edit → poster
writeHeadline.addEventListener("input", () => {
  state.headline = writeHeadline.value;
  state.headlineTouched = true;
  headlineEdit.value = writeHeadline.value;
  setWriteStatus("");
  scheduleRender();
});

writeDetail.addEventListener("input", (event) => {
  const text = event.inputType === "insertLineBreak" ? formatDetailBulletField(writeDetail) : writeDetail.value;
  state.detailText = limitDetailTextClient(text);
  state.detailTouched = true;
  if (detailEdit) detailEdit.value = state.detailText;
  setWriteStatus("");
  scheduleRender();
});
writeDetail.addEventListener("keydown", handleDetailBulletEnter);

scrapeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runScrape();
});

// On mobile, after a Build, scroll the preview into view so the user
// gets visual confirmation without having to scroll up.
function scrollPreviewIntoViewIfMobile() {
  if (window.matchMedia("(max-width: 760px)").matches) {
    const previewPanel = document.querySelector(".preview-panel");
    if (previewPanel) {
      // Use rAF so the DOM has settled (panels may have just become visible).
      requestAnimationFrame(() => {
        previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }
}

/* ── Download for X ── */
const xDownloadBtn = document.getElementById("x-download-btn");
const xDownloadStatus = document.getElementById("x-download-status");
const xComposerLink = document.querySelector(".preview-card-x-link");
const xCopyImageBtn = document.getElementById("x-copy-image-btn");
const X_POST_LIMIT = 280;
const X_FOLLOW_LINE = "Follow @dailymattr for more such news.";

function xHashtags(view) {
  const tags = ["DailyMattr"];
  const seen = new Set(tags.map((tag) => tag.toLowerCase()));
  const candidates = String(view.keywords || "").split(/[#,\n]+/);

  for (const candidate of candidates) {
    const tag = candidate.trim().replace(/[^\p{L}\p{N}_]+/gu, "").slice(0, 40);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    tags.push(tag);
    seen.add(tag.toLowerCase());
    if (tags.length >= 3) break;
  }
  if (!seen.has("news")) tags.push("News");
  return tags;
}

function truncateXPostText(value, limit) {
  const chars = Array.from(String(value || "").trim());
  if (chars.length <= limit) return chars.join("");
  const clipped = chars.slice(0, Math.max(0, limit - 1)).join("");
  const wordBreak = clipped.lastIndexOf(" ");
  const clean = wordBreak >= Math.floor(limit * 0.7) ? clipped.slice(0, wordBreak) : clipped;
  return clean.replace(/[\s,;:!?.-]+$/u, "") + "…";
}

function xPostText(view, hashtags = xHashtags(view)) {
  const tweet = typeof view.article?.tweet === "string" ? view.article.tweet.trim() : "";
  const main = tweet || cleanHeadlineForPublish(view.headline);
  if (!main) return "";
  // X renders each hashtags parameter entry as ` #tag`, which also counts
  // toward 280. Reserve that space and keep the requested follow line intact.
  const hashtagLength = hashtags.reduce((length, tag) => length + tag.length + 2, 0);
  const mainLimit = X_POST_LIMIT - X_FOLLOW_LINE.length - 2 - hashtagLength;
  return `${truncateXPostText(main, mainLimit)}\n\n${X_FOLLOW_LINE}`;
}

function syncXComposerLink() {
  if (!xComposerLink) return;
  const url = new URL("https://x.com/intent/tweet");
  const view = basePageView();
  const hashtags = xHashtags(view);
  const text = xPostText(view, hashtags);
  if (text) {
    url.searchParams.set("text", text);
    url.searchParams.set("hashtags", hashtags.join(","));
  }
  xComposerLink.href = url.href;
}

// Keep normal new-tab behavior, including keyboard and middle-click, without
// waiting for a request or allowing an older post's text to survive a reset.
if (xComposerLink) {
  for (const event of ["click", "auxclick", "contextmenu", "focus"]) {
    xComposerLink.addEventListener(event, () => syncXComposerLink());
  }
}
if (xCopyImageBtn) xCopyImageBtn.addEventListener("click", copyXPreviewImage);

function setPostStatus(msg, kind) {
  if (!xDownloadStatus) return;
  xDownloadStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  xDownloadStatus.textContent = "";
  if (msg) xDownloadStatus.append(msg);
}

/* Show the publish panel to review roles only. This is presentation, not the
   control: the server applies the same capability check because a hidden
   button is not a permission. */
function syncDailyMattrAccess() {
  const panel = document.getElementById("dailymattr-panel");
  if (panel) panel.hidden = !canReviewRole(state.user?.role);
}

function setDailyMattrStatus(message, kind) {
  if (!dailymattrStatus) return;
  dailymattrStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  dailymattrStatus.textContent = message || "";
}

function cleanHeadlineForPublish(value) {
  return String(value || "").replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "").replace(/\s+/g, " ").trim();
}

function inferDailyMattrKeywords() {
  const raw = [
    state.imageQuery,
    state.tag && state.tag !== "none" ? state.tag.replace(/-/g, " ") : "",
    cleanHeadlineForPublish(state.headline),
  ].filter(Boolean).join(" ");

  const words = raw.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const seen = new Set();
  const stop = new Set(["with", "from", "that", "this", "have", "will", "into", "about", "after", "before", "their", "where", "which", "while"]);
  const picked = [];
  for (const word of words) {
    if (stop.has(word) || seen.has(word)) continue;
    seen.add(word);
    picked.push(word);
    if (picked.length >= 6) break;
  }
  return picked.join(", ");
}

function defaultDailyMattrContent() {
  const headline = cleanHeadlineForPublish(state.headline);
  const detail = normalizeDetailTextClient(state.detailText || "");
  if (!headline) return "";
  return detail ? `${headline}\n\n${detail}`.trim() : headline;
}

function syncDailyMattrDraft({ force = false } = {}) {
  if (dailymattrContent && (!dailymattrDraftTouched.content || force)) {
    dailymattrContent.value = defaultDailyMattrContent();
  }
  if (dailymattrKeywords && (!dailymattrDraftTouched.keywords || force)) {
    // The writer's own keywords win over a guess from the headline.
    dailymattrKeywords.value = (state.keywords || "").trim() || inferDailyMattrKeywords();
  }
}

function fillSelectOptions(selectEl, items, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  selectEl.appendChild(first);
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item.id);
    option.textContent = item.name || String(item.id);
    selectEl.appendChild(option);
  });
}

// Crop the canvas vertically to where the last non-black pixel lives, so the
// exported PNG doesn't ship the trailing black gradient gap below the headline.
// `paddingBelow`: extra px to keep below the last content row (breathing room).
// `minHeight`:   never crop above this height (avoids ugly squares for short headlines).
function exportCanvasCroppedToContent(srcCanvas, { paddingBelow = 32, minHeight = 1100 } = {}) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const sctx = srcCanvas.getContext("2d");

  // Pull the bottom 60% of the canvas in ONE getImageData call (fast).
  // 60% covers the gradient + headline area; we won't have content above that.
  const scanStart = Math.max(0, Math.floor(h * 0.4));
  const scanH = h - scanStart;
  let lastContentY = h;
  try {
    const data = sctx.getImageData(0, scanStart, w, scanH).data;
    const rowBytes = w * 4;
    const THRESHOLD = 12;  // RGB channel value above which we call it "content"

    // Scan rows bottom-up; first row with any non-black pixel = content end
    outer:
    for (let row = scanH - 1; row >= 0; row--) {
      const rowOffset = row * rowBytes;
      for (let col = 0; col < rowBytes; col += 4) {
        if (
          data[rowOffset + col]     > THRESHOLD ||
          data[rowOffset + col + 1] > THRESHOLD ||
          data[rowOffset + col + 2] > THRESHOLD
        ) {
          lastContentY = scanStart + row + 1;
          break outer;
        }
      }
    }
  } catch (e) {
    // CORS taint or similar — bail out and just use the full canvas
    console.warn("Crop scan failed, exporting full canvas:", e);
    return srcCanvas;
  }

  // Compute final crop height with padding + min-height clamp + max bound
  const cropH = Math.max(minHeight, Math.min(h, lastContentY + paddingBelow));
  if (cropH >= h) return srcCanvas;  // nothing to crop

  const out = document.createElement("canvas");
  out.width = w;
  out.height = cropH;
  out.getContext("2d").drawImage(srcCanvas, 0, 0, w, cropH, 0, 0, w, cropH);
  return out;
}

// Returns { caption, source: "ai" | "fallback", error? }
async function fetchAiCaption(headline, timeoutMs = 12000) {
  const fallback = headline.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "").trim().slice(0, 280);
  if (!headline.trim()) return { caption: fallback, source: "fallback", error: "empty headline" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch("/api/generate-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { const j = await resp.json(); detail = j.error || detail; } catch {}
      console.error("[AI caption] server returned:", detail);
      return { caption: fallback, source: "fallback", error: detail };
    }
    const data = await resp.json();
    const c = (data?.caption || "").trim();
    if (!c) return { caption: fallback, source: "fallback", error: "empty AI response" };
    console.log("[AI caption] success:", c);
    return { caption: c, source: "ai" };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : (e?.message || String(e));
    console.error("[AI caption] fetch failed:", msg);
    return { caption: fallback, source: "fallback", error: msg };
  }
}

function renderXPreviewCanvas() {
  // Download and clipboard must use the same pinned base poster, crop and logo.
  const prevMode = state.previewMode;
  const prevDownloading = state.isDownloading;
  const prevShortly = state.useShortlyLogo;
  const prevForceText = state.forceTextExport;
  syncActivePageContent();
  const restorePageId = activePageId;

  try {
    setActivePage("base", { force: true });
    state.isDownloading = true;
    state.useShortlyLogo = true;
    state.forceTextExport = false;
    state.previewMode = "x";
    const exportCanvas = renderToHighResCanvas(X_EXPORT_SCALE);
    return exportCanvasCroppedToContent(exportCanvas, {
      paddingBelow: 36 * X_EXPORT_SCALE,
      minHeight: 1100 * X_EXPORT_SCALE,
    });
  } finally {
    // Restore before asynchronous PNG encoding so later edits/page selections
    // cannot be overwritten by an old download or clipboard callback.
    state.isDownloading = prevDownloading;
    state.useShortlyLogo = prevShortly;
    state.forceTextExport = prevForceText;
    state.previewMode = prevMode;
    setActivePage(restorePageId, { force: true });
    renderPoster();
  }
}

function createXPreviewBlob() {
  return new Promise((resolve, reject) => {
    const cropped = renderXPreviewCanvas();
    cropped.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't render the X image."));
    }, "image/png");
  });
}

async function downloadXPreview({ usePrimaryButton = false } = {}) {
  const baseHeadline = (basePageView().headline || "").trim();
  if (!baseHeadline) {
    setPostStatus("Build a poster first.", "error");
    return;
  }
  const targetButton = usePrimaryButton ? downloadButton : xDownloadBtn;
  if (targetButton) targetButton.disabled = true;
  setPostStatus("Preparing X download...");
  try {
    const blob = await createXPreviewBlob();
    const blobUrl = URL.createObjectURL(blob);
    const dl = document.createElement("a");
    dl.href = blobUrl;
    dl.download = `${slugify(baseHeadline || "pix-post")}-x.png`;
    dl.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    setPostStatus("X-ready PNG downloaded.", "success");
  } catch (error) {
    setPostStatus("Couldn't render X download.", "error");
    console.error("X download failed:", error);
  } finally {
    if (targetButton) targetButton.disabled = false;
  }
}

async function copyXPreviewImage() {
  if (!(basePageView().headline || "").trim()) {
    setPostStatus("Build a poster first.", "error");
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    setPostStatus("Image copying isn't supported here. Download the Pix and attach it on X.", "error");
    return;
  }
  if (xCopyImageBtn) xCopyImageBtn.disabled = true;
  setPostStatus("Copying X image...");
  try {
    const blobPromise = createXPreviewBlob();
    // Handle encoding failure even if clipboard access fails before consuming it.
    blobPromise.catch(() => {});
    // Pass the promise without awaiting it to retain the click's user activation.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
    setPostStatus("Image copied. Open X, click in the post and paste (Ctrl+V or Cmd+V). Text fills in automatically.", "success");
  } catch {
    setPostStatus("Couldn't copy the image. Download the Pix and attach it on X instead.", "error");
  } finally {
    if (xCopyImageBtn) xCopyImageBtn.disabled = false;
  }
}

if (xDownloadBtn) xDownloadBtn.addEventListener("click", () => {
  downloadXPreview();
});

async function downloadTextPreview() {
  const headline = (state.headline || "").trim();
  if (!headline && !getDetailTextForPreview().trim()) {
    setPostStatus("Build a poster first.", "error");
    return;
  }

  if (textDownloadButton) textDownloadButton.disabled = true;
  setPostStatus("Rendering high-resolution text image…");

  const previousMode = state.previewMode;
  state.isDownloading = true;
  state.forceTextExport = true;
  state.previewMode = "text";

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (error) {
    console.error("Text download failed:", error);
  } finally {
    state.isDownloading = false;
    state.forceTextExport = false;
    state.previewMode = previousMode;
    renderPoster();
    if (textDownloadButton) textDownloadButton.disabled = false;
  }

  if (!result) {
    setPostStatus("Couldn't render text image.", "error");
    return;
  }
  const blobUrl = URL.createObjectURL(result.blob);
  const dl = document.createElement("a");
  dl.href = blobUrl;
  dl.download = `${slugify(headline || "pix-post")}-text.png`;
  dl.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  setPostStatus(`Text PNG downloaded (${result.width}×${result.height}).`, "success");
}

if (textDownloadButton) textDownloadButton.addEventListener("click", () => {
  downloadTextPreview();
});

// The single "Download Poster" button is gone — each card owns its export
// now. This block is kept behind a guard so an older markup revision (or a
// cached page) still works rather than throwing at load.
if (downloadButton) downloadButton.addEventListener("click", async () => {
  // Clean export (no preview overlays). The export happens entirely on an
  // offscreen canvas via renderExportBlob (8K→6K→4K fallback), so the
  // on-screen preview never changes; we restore state + re-render after.
  downloadButton.disabled = true;
  setStatus("Rendering high-resolution poster…");

  // Explicitly own the render mode → always the Pix poster, never text/X,
  // regardless of the current preview toggle or leftover flags.
  const prevMode = state.previewMode;
  state.isDownloading = true;
  state.forceTextExport = false;
  state.useShortlyLogo = false;
  state.previewMode = "pix";

  let result = null;
  try {
    result = await renderExportBlob();
  } catch (err) {
    console.error("Download failed:", err);
  } finally {
    state.isDownloading = false;
    state.previewMode = prevMode;
    renderPoster();  // Restore preview
    downloadButton.disabled = false;
  }

  if (!result) {
    setStatus("Failed to generate high-resolution export.", "error");
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.headline || "pix-post")}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Poster downloaded (${result.width}×${result.height}).`, "success");
});

// Headline live edit
headlineEdit.addEventListener("input", () => {
  state.headline = headlineEdit.value;
  state.headlineTouched = true;
  writeHeadline.value = headlineEdit.value;
  // Editing the headline used to overwrite the paragraph whenever a
  // heuristic guessed the paragraph "was" the headline. The guess misfired,
  // silently replacing real bullet copy. The two fields are independent now.
  scheduleRender();
});

if (detailEdit) {
  detailEdit.addEventListener("input", (event) => {
    const text = event.inputType === "insertLineBreak" ? formatDetailBulletField(detailEdit) : detailEdit.value;
    state.detailText = limitDetailTextClient(text);
    state.detailTouched = true;
    writeDetail.value = state.detailText;
    scheduleRender();
  });
  detailEdit.addEventListener("keydown", handleDetailBulletEnter);
}

/* Story copy writes to live state; syncActivePageContent folds it back onto
   the page on the next read, which is the same route every page-scoped field
   takes. */
document.getElementById("story-heading-edit")?.addEventListener("input", (e) => {
  state.storyHeading = e.target.value;
  scheduleRender();
});
document.getElementById("story-body-edit")?.addEventListener("input", (e) => {
  state.storyBody = e.target.value;
  scheduleRender();
});

storyOverlayOpacityInput?.addEventListener("input", (event) => {
  if (activePage()?.type !== "story") return;
  state.storyOverlayOpacity = clamp(Number(event.target.value), 0, 100);
  scheduleRender();
});

// Image offset sliders
imgOffsetX.addEventListener("input", () => {
  state.imageOffset.x = Number(imgOffsetX.value);
  scheduleRender();
});

imgOffsetY.addEventListener("input", () => {
  state.imageOffset.y = Number(imgOffsetY.value);
  scheduleRender();
});

imgResetBtn.addEventListener("click", () => {
  // Pan + zoom reset
  state.imageOffset = { x: 0, y: 0 };
  state.imageZoom = 100;
  imgOffsetX.value = 0;
  imgOffsetY.value = 0;
  imgZoom.value = 100;
  if (activePage()?.type === "story") {
    state.storyOverlayOpacity = 100;
    syncControl(storyOverlayOpacityInput, 100);
  }

  // Filters reset
  applyFilterPreset("none");

  renderPoster();
});

/* ── Filters ── */
const filterBrightnessInput = document.getElementById("filter-brightness");
const filterContrastInput   = document.getElementById("filter-contrast");
const filterSaturationInput = document.getElementById("filter-saturation");
const filterBlurInput       = document.getElementById("filter-blur");
const filterPresetsContainer = document.getElementById("filter-presets");

function syncFilterUI() {
  if (filterBrightnessInput) filterBrightnessInput.value = state.filterBrightness;
  if (filterContrastInput)   filterContrastInput.value   = state.filterContrast;
  if (filterSaturationInput) filterSaturationInput.value = state.filterSaturation;
  if (filterBlurInput)       filterBlurInput.value       = state.filterBlur;
  if (filterPresetsContainer) {
    filterPresetsContainer.querySelectorAll(".preset-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.filter === state.filterPreset);
    });
  }
}

/* ── Reading the photograph, so the adjustment is not a guess ────────────
   A 64px thumbnail, one pass, cached on the image. The same size and the
   same reasoning as imageHue: it is enough to characterise a picture and it
   costs about a millisecond whatever was pasted in.

   What is measured, and why each one:

     p01, p99   the black and white points, as percentiles rather than the
                actual min and max. A single blown highlight or one dead
                pixel would otherwise say the range is already full when the
                picture is visibly flat.
     median     the exposure. The mean is pulled around by a large bright sky
                or a large dark suit; the median is what the picture mostly
                is.
     chroma     mean saturation, for deciding whether the colour is flat.

   Nothing here calls an API. This is the whole point: most of what people
   press AI Enhance for — "it looks flat", "it looks dark", "it looks
   washed out" — is a tone problem, not a resolution problem, and tone is
   arithmetic. */
function analysePhoto(image) {
  if (!image) return null;
  if (image.__tone !== undefined) return image.__tone;

  let tone = null;
  try {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (w && h) {
      const scale = Math.min(1, 64 / Math.max(w, h));
      const sw = Math.max(1, Math.round(w * scale));
      const sh = Math.max(1, Math.round(h * scale));
      const off = document.createElement("canvas");
      off.width = sw; off.height = sh;
      const octx = off.getContext("2d", { willReadFrequently: true });
      octx.drawImage(image, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh).data;

      const hist = new Uint32Array(256);
      let counted = 0, chromaSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const luma = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
        hist[Math.min(255, Math.max(0, luma))]++;
        chromaSum += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        counted++;
      }
      if (counted) {
        const at = (share) => {
          const want = counted * share;
          let seen = 0;
          for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= want) return v; }
          return 255;
        };
        tone = { p01: at(0.01), median: at(0.5), p99: at(0.99), chroma: chromaSum / counted, counted };
      }
    }
  } catch (err) {
    // Cross-origin photographs taint the canvas. No analysis, no adjustment.
    tone = null;
  }

  image.__tone = tone;
  return tone;
}

/* The free half of "enhance": what brightness, contrast and saturation this
   particular photograph wants, worked out from its own histogram.

   Deliberately timid. These are news photographs, and the failure everyone
   recognises is the over-processed one — crushed blacks, a sky pushed to
   neon. Each control is clamped to a range that cannot make a picture look
   handled, so the worst case of pressing this is that it does very little.
   That is the right worst case for a button that runs on somebody's
   photograph without asking. */
const AUTO_TONE = {
  /* Deadbands, and they are the most important part of this.

     Auto levels without them normalises every photograph to the same
     midpoint, which is wrong for exactly the pictures a newsroom runs: a
     high-key studio portrait on white is SUPPOSED to sit bright, and a
     night shot is supposed to sit dark. Correcting those toward the middle
     does not fix a fault, it removes an intention.

     Measured on a properly exposed press photo: without a deadband this
     asked for brightness 90 — a visible darkening of a picture that had
     nothing wrong with it. So each control does nothing at all inside its
     band, and outside it corrects only HALF the distance to the target.
     Half because the measurement is a 64px thumbnail and a heuristic; a
     correction that lands short is a photograph that still needs a nudge,
     and one that overshoots is a photograph somebody has to undo. */
  /* Wide on the bright side on purpose. A studio portrait on a white
     background measures a median of 166 and there is nothing wrong with it;
     at [95,155] this asked to darken it 8%. High-key is a normal way for a
     press photograph to be exposed, and low-key is rarer, so the band is
     not symmetric. */
  medianOk: [90, 175],     // exposure inside this is a choice, not a fault
  medianTarget: 122,
  /* 180, not 200. A high-key portrait has a raised black point by
     definition — that is what high-key MEANS — so it measures a span around
     190 and read as "flat" at 200. The contrast lift that followed then
     pushed its median past the exposure band and triggered a darkening: the
     button turning a correctly exposed studio shot into a worse one through
     two steps that were each individually defensible. A span of 180 out of
     255 is a photograph with a full tonal range. */
  spanOk: 180,             // a histogram this wide is not flat
  spanTarget: 235,
  chromaOk: [0.11, 0.32],  // colour inside this needs no help
  chromaTarget: 0.19,
  minChromaToTouch: 0.03,  // below this it is greyscale; never boost it

  strength: 0.5,           // correct half the distance, never all of it
  brightness: [92, 112],
  contrast: [100, 125],
  saturation: [100, 130],
};

function autoFilterFor(image) {
  const tone = analysePhoto(image);
  if (!tone) return null;
  const clamp2 = (v, [lo, hi]) => Math.round(Math.min(hi, Math.max(lo, v)));
  // Half the distance from "no change" to what the measurement asks for.
  const ease = (want) => 100 + (want - 100) * AUTO_TONE.strength;

  /* Contrast: a flat picture is one whose histogram does not reach the ends.
     Expanding it is what "auto levels" has always meant, and it is the change
     that makes the most difference on the pictures this button is for. */
  const span = Math.max(1, tone.p99 - tone.p01);
  /* A span this small is not a flat photograph, it is a picture with no
     tonal information in it at all — a solid colour, a blank, a screenshot of
     an empty panel. Expanding that has nothing to expand; it just pushes the
     one tone present away from mid-grey. Left alone. */
  const degenerate = span < 20;
  const contrast = (degenerate || span >= AUTO_TONE.spanOk)
    ? 100
    : clamp2(ease((AUTO_TONE.spanTarget / span) * 100), AUTO_TONE.contrast);

  /* Brightness against the MEDIAN, and measured after the contrast change
     rather than before it: contrast() pivots on mid-grey, so expanding a dark
     picture darkens it further, and correcting exposure from the original
     median would be correcting a number that no longer applies. */
  const medianAfter = 128 + (tone.median - 128) * (contrast / 100);
  const brightness = (medianAfter >= AUTO_TONE.medianOk[0] && medianAfter <= AUTO_TONE.medianOk[1])
    ? 100
    : clamp2(ease((AUTO_TONE.medianTarget / Math.max(1, medianAfter)) * 100), AUTO_TONE.brightness);

  /* Saturation only ever goes UP, and only on a picture that has colour to
     begin with. Cutting it would override a deliberately muted photograph,
     and dividing by a near-zero chroma on a greyscale one asks for 900%. */
  const saturation = (tone.chroma < AUTO_TONE.minChromaToTouch ||
                      (tone.chroma >= AUTO_TONE.chromaOk[0] && tone.chroma <= AUTO_TONE.chromaOk[1]))
    ? 100
    : clamp2(ease((AUTO_TONE.chromaTarget / tone.chroma) * 100), AUTO_TONE.saturation);

  return { brightness, contrast, saturation, blur: 0, tone };
}

function applyFilterPreset(name, { announce = true } = {}) {
  /* "auto" is the one preset that is not a fixed bundle — it is computed from
     the photograph currently on the page. If the picture cannot be read
     (cross-origin, or nothing loaded yet) it falls back to None rather than
     silently doing nothing, so the chip never lies about having acted. */
  const p = name === "auto"
    ? (autoFilterFor(state.mainImage) || FILTER_PRESETS["none"])
    : (FILTER_PRESETS[name] || FILTER_PRESETS["none"]);
  state.filterBrightness = p.brightness;
  state.filterContrast   = p.contrast;
  state.filterSaturation = p.saturation;
  state.filterBlur       = p.blur;
  state.filterPreset     = name;
  syncFilterUI();
  // Reflect in the collapsed accordion header pill
  const meta = document.getElementById("acc-meta-filter");
  if (meta) {
    const labels = { none:"None", auto:"Auto", vivid:"Vivid", bw:"B&W", warm:"Warm", cool:"Cool", faded:"Faded", soft:"Soft", custom:"Custom" };
    meta.textContent = labels[name] || "";
  }

  /* The enhance button applies this as one step of a larger decision and
     writes its own line about what it did and what it cost. Two status
     messages for one press reads as two things having happened. */
  if (name === "auto" && announce) {
    const t = p.tone;
    setStatus(
      t
        ? `Auto: brightness ${p.brightness}%, contrast ${p.contrast}%, saturation ${p.saturation}% ` +
          `— read off this photograph (range ${t.p01}–${t.p99}, midpoint ${t.median}). Costs nothing.`
        : "Auto could not read this picture, so nothing was changed.",
      t ? "success" : "error",
    );
  }
}

[
  [filterBrightnessInput, "filterBrightness"],
  [filterContrastInput,   "filterContrast"],
  [filterSaturationInput, "filterSaturation"],
  [filterBlurInput,       "filterBlur"],
].forEach(([el, key]) => {
  if (!el) return;
  el.addEventListener("input", () => {
    state[key] = Number(el.value);
    // Manual edit means it's no longer a known preset — clear active chip
    state.filterPreset = "custom";
    if (filterPresetsContainer) {
      filterPresetsContainer.querySelectorAll(".preset-btn")
        .forEach(b => b.classList.remove("active"));
    }
    const meta = document.getElementById("acc-meta-filter");
    if (meta) meta.textContent = "Custom";
    scheduleRender();
  });
});

if (filterPresetsContainer) {
  filterPresetsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".preset-btn");
    if (!btn) return;
    applyFilterPreset(btn.dataset.filter);
    renderPoster();
  });
}

// Zoom slider
/* ── Zoom ──
   The range input remains the single source of truth for the value — page
   restore, syncControl and the drag handler all read img-zoom.value — but it
   is hidden and driven by − / + instead. Everything routes through applyZoom()
   so the buttons, a restore and any future caller cannot drift apart. */
const imgZoomOut = document.getElementById("img-zoom-out");
const imgZoomIn = document.getElementById("img-zoom-in");
const imgZoomValue = document.getElementById("img-zoom-value");

/* Called from renderPoster rather than from each of the four places that write
   img-zoom.value. Zoom is a render input by definition, so anything that
   changes it must re-render or the poster itself would be stale — which makes
   the readout provably agree with what is on screen, including restores that
   set .value directly (a programmatic write fires no "input" event).
   Elements are looked up lazily: renderPoster can run during boot, before the
   consts above are initialised, and reading one then would throw on the TDZ. */
let zoomReadoutShown = null;
function syncZoomReadout() {
  const z = Math.round(Number(imgZoom.value) || 100);
  if (z === zoomReadoutShown) return;
  zoomReadoutShown = z;
  const out = document.getElementById("img-zoom-value");
  const minus = document.getElementById("img-zoom-out");
  const plus = document.getElementById("img-zoom-in");
  if (out) {
    out.textContent = `${z}%`;
    // The readout is also the reset, so it is inert at 100 — nothing to undo.
    out.disabled = z === 100;
  }
  if (minus) minus.disabled = z <= ZOOM_MIN;
  if (plus) plus.disabled = z >= ZOOM_MAX;
}

function applyZoom(next) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(Number(next) || 100)));
  /* Zooming OUT re-centres. A pan set while zoomed in can leave the picture
     off-canvas entirely once it shrinks, and hunting it back with two more
     sliders is worse than starting from the middle. */
  if (clamped < state.imageZoom) {
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;
  }
  state.imageZoom = clamped;
  imgZoom.value = String(clamped);
  syncZoomReadout();
  scheduleRender();
}

/* ── Fit: the whole photograph, letterboxed ──────────────────────────────────

   Zoom is a multiplier on the COVER scale — the scale at which the picture
   fills the frame and the overflow is cropped. A 16:9 photograph on a 9:16
   poster loses about 68% of itself that way, which is right for most poster
   images and wrong when the picture is the story.

   Fit is the other scale: the largest the picture can be with all of it
   inside the frame. Expressed as a zoom so it travels through the existing
   control, the page snapshot and the saved design without any new field —
   the writer can nudge it afterwards and it behaves like any other zoom.

   IMAGE_PAN_HEADROOM is divided back out because drawCoverImage multiplies it
   in; without that the "fit" would still overflow by that margin, which is
   the whole thing it is supposed not to do. */
function fitZoomFor(image) {
  if (!image || !image.width || !image.height) return 100;
  const frameW = canvas.width;
  const frameH = canvas.height;
  const coverScale = Math.max(frameW / image.width, frameH / image.height);
  const containScale = Math.min(frameW / image.width, frameH / image.height);
  const zoom = (containScale / (coverScale * IMAGE_PAN_HEADROOM)) * 100;
  /* Floored, not rounded. The zoom control carries whole percentages, and
     rounding up is enough to push the picture back over the edge it was just
     fitted inside — on a 16:9 photo in a 9:16 frame, 27.7 rounds to 28 and
     overflows by 11px, so the thing lands one crop short of doing its job.
     A percent under is invisible; a percent over is the bug.

     The floor matches the control's own minimum. It used to be 10, which a
     panorama cannot fit inside a 9:16 frame in — 3000x600 needs 9.8% — so the
     one shape that most needs fitting was the one shape it refused to fit. */
  return Math.max(ZOOM_MIN, Math.floor(zoom));
}

/* Already showing the whole picture? Then the useful thing this button can do
   is give the frame back. Fit and reset from one control, because the row has
   no space for two and the writer only ever wants one of them. */
function toggleFitZoom() {
  const image = state.mainImage;
  if (!image) return;
  const fit = fitZoomFor(image);
  const atFit = Math.abs(Number(imgZoom.value) - fit) <= 1;
  applyZoom(atFit ? 100 : fit);
}

imgZoom.addEventListener("input", () => applyZoom(imgZoom.value));
imgZoomOut?.addEventListener("click", () => applyZoom(Number(imgZoom.value) - ZOOM_STEP));
imgZoomIn?.addEventListener("click", () => applyZoom(Number(imgZoom.value) + ZOOM_STEP));
imgZoomValue?.addEventListener("click", toggleFitZoom);

/* Press-and-hold to run, so crossing the range does not take forty clicks. */
[[imgZoomOut, -ZOOM_STEP], [imgZoomIn, ZOOM_STEP]].forEach(([btn, delta]) => {
  if (!btn) return;
  let hold = null;
  let repeat = null;
  const stop = () => { clearTimeout(hold); clearInterval(repeat); hold = null; repeat = null; };
  btn.addEventListener("pointerdown", () => {
    hold = setTimeout(() => {
      repeat = setInterval(() => {
        if (btn.disabled) return stop();
        applyZoom(Number(imgZoom.value) + delta);
      }, 70);
    }, 400);
  });
  ["pointerup", "pointerleave", "pointercancel", "blur"].forEach((ev) => btn.addEventListener(ev, stop));
});

// Font size slider (0 = auto)
fontSizeInput.addEventListener("input", () => {
  state.fontSize = Number(fontSizeInput.value);
  scheduleRender();
});

// Accent color picker
accentColorInput.addEventListener("input", () => {
  state.accent = accentColorInput.value;
  accentHexLabel.textContent = accentColorInput.value.toUpperCase();
  document.querySelector('.color-circle').style.borderColor = state.accent;
  scheduleRender();
});

// The {curly} highlight colour. Guarded: an older cached index.html has no
// such input, and an unguarded addEventListener on null takes the editor down
// at load rather than merely losing one control.
accentAltColorInput?.addEventListener("input", () => {
  state.accentAlt = accentAltColorInput.value;
  if (accentAltHexLabel) accentAltHexLabel.textContent = accentAltColorInput.value.toUpperCase();
  const circle = accentAltColorInput.closest(".color-circle");
  if (circle) circle.style.borderColor = state.accentAlt;
  scheduleRender();
});

// Tag presets
tagPresetsContainer.addEventListener("click", (e) => {
  const btn = e.target.closest(".preset-btn");
  if (!btn) return;
  tagPresetsContainer.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.tag = btn.dataset.tag;
  renderPoster();
});

// Aspect-ratio chips
const ratioPresetsContainer = document.getElementById("ratio-presets");
if (ratioPresetsContainer) {
  ratioPresetsContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".ratio-btn");
    if (!btn) return;
    const ratio = btn.dataset.ratio;
    if (!ratio || ratio === state.aspectRatio) return;
    ratioPresetsContainer.querySelectorAll(".ratio-btn").forEach(b => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-checked", b === btn ? "true" : "false");
    });
    applyAspectRatio(ratio);
    // Reflect in the collapsed accordion header pill
    const meta = document.getElementById("acc-meta-ratio");
    if (meta) meta.textContent = ratio;
  });
}

/* ── Accordion toggle ──
   Clicking a header flips the data-open attr on its parent .acc; CSS
   handles the smooth height transition via grid-template-rows.
   On mobile, toggling one section will close the others (single-open
   mode) so the panel stays compact. */
const isMobile = () => window.matchMedia("(max-width: 760px)").matches;

document.addEventListener("click", (e) => {
  const head = e.target.closest(".acc-head");
  if (!head) return;
  const acc  = head.parentElement;
  if (!acc || !acc.classList.contains("acc")) return;

  const opening = acc.dataset.open !== "true";
  if (opening && isMobile()) {
    // Single-open mode: close all sibling accordions inside the same .acc-list
    const list = acc.closest(".acc-list");
    if (list) {
      list.querySelectorAll(":scope > .acc[data-open='true']").forEach(o => {
        o.dataset.open = "false";
        const h = o.querySelector(":scope > .acc-head");
        if (h) h.setAttribute("aria-expanded", "false");
      });
    }
  }

  acc.dataset.open = opening ? "true" : "false";
  head.setAttribute("aria-expanded", opening ? "true" : "false");

  // When opening on mobile, scroll the header into a comfortable view
  if (opening && isMobile()) {
    requestAnimationFrame(() => {
      head.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
});

/* ── Mobile bottom-sheet (FAB → controls popup) ──
   On mobile, the editor panels live inside .edit-sheet which is hidden
   off-screen by default. The FAB toggles `body.sheet-open` to slide it up;
   tapping the backdrop or the close button drops it back down. */
const fabEdit       = document.getElementById("fab-edit");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const sheetClose    = document.getElementById("sheet-close");
const editSheet     = document.getElementById("edit-sheet");

function setSheetOpen(open) {
  document.body.classList.toggle("sheet-open", open);
  if (fabEdit) fabEdit.setAttribute("aria-expanded", open ? "true" : "false");
  if (sheetBackdrop) sheetBackdrop.setAttribute("aria-hidden", open ? "false" : "true");
  if (open && editSheet) {
    // Reset scroll to top when opening so the user starts at the first section
    requestAnimationFrame(() => editSheet.scrollTo({ top: 0, behavior: "instant" }));
  }
}

if (fabEdit)       fabEdit.addEventListener("click", () => setSheetOpen(!document.body.classList.contains("sheet-open")));
if (sheetBackdrop) sheetBackdrop.addEventListener("click", () => setSheetOpen(false));
if (sheetClose)    sheetClose.addEventListener("click", () => setSheetOpen(false));

/* ── Swipe-to-close gesture on the sheet handle ── */
(function attachSheetSwipe() {
  const handle = document.querySelector(".sheet-handle");
  if (!handle || !editSheet) return;

  let startY     = null;     // touch start clientY
  let dragY      = 0;        // current downward delta
  let isDragging = false;
  const CLOSE_PX = 90;       // drag this far → close

  function onStart(e) {
    if (!document.body.classList.contains("sheet-open")) return;
    const point = e.touches ? e.touches[0] : e;
    startY = point.clientY;
    dragY = 0;
    isDragging = true;
    // Disable CSS transition during drag so transform tracks finger 1:1
    editSheet.style.transition = "none";
  }

  function onMove(e) {
    if (!isDragging) return;
    const point = e.touches ? e.touches[0] : e;
    const dy = point.clientY - startY;
    if (dy <= 0) {
      // Pulling up — slight rubber-band, then clamp at 0
      dragY = Math.max(-12, dy / 6);
    } else {
      dragY = dy;
    }
    editSheet.style.transform = `translateY(${dragY}px)`;
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    editSheet.style.transition = "";   // restore CSS transition
    if (dragY > CLOSE_PX) {
      editSheet.style.transform = "";  // let .sheet-open class take over
      setSheetOpen(false);
    } else {
      editSheet.style.transform = "";  // snap back to fully open
    }
    startY = null;
    dragY = 0;
  }

  // Touch (iOS / Android)
  handle.addEventListener("touchstart", onStart, { passive: true });
  handle.addEventListener("touchmove",  onMove,  { passive: true });
  handle.addEventListener("touchend",   onEnd);
  handle.addEventListener("touchcancel", onEnd);

  // Pointer (desktop drag — useful for testing)
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    onStart(e);
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup",   onEnd);
  handle.addEventListener("pointercancel", onEnd);
})();

// Close the sheet on Escape (a11y)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("sheet-open")) setSheetOpen(false);
});

// Auto-close the sheet after a successful Build/scrape on mobile so the user
// instantly sees their poster.
function closeSheetIfMobile() {
  if (window.matchMedia("(max-width: 760px)").matches) setSheetOpen(false);
}

// On first load, collapse all accordions on mobile so the panel is compact
function setInitialAccordionState() {
  if (!isMobile()) return;
  document.querySelectorAll(".acc").forEach((acc, i) => {
    // Keep just the first accordion (Aspect Ratio) open by default
    const open = i === 0;
    acc.dataset.open = open ? "true" : "false";
    const h = acc.querySelector(":scope > .acc-head");
    if (h) h.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
setInitialAccordionState();

window.addEventListener("resize", () => {
  // Re-apply on viewport class crossings (mobile↔desktop) for sanity
  const isMob = isMobile();
  document.querySelectorAll(".acc").forEach((acc) => {
    if (!isMob) {
      acc.dataset.open = "true";
      const h = acc.querySelector(":scope > .acc-head");
      if (h) h.setAttribute("aria-expanded", "true");
    }
  });
});

// Background image upload
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function getFirstImageFile(collection) {
  if (!collection) return null;
  for (const item of collection) {
    if (item?.type?.startsWith("image/")) {
      if (typeof item.getAsFile === "function") return item.getAsFile();
      return item;
    }
  }
  return null;
}

function validateImageFile(file) {
  if (!file) {
    setStatus("No image found.", "error");
    return false;
  }
  if (!file.type || !file.type.startsWith("image/")) {
    setStatus("Please use an image file.", "error");
    return false;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setStatus("Image is too large. Use a file under 10 MB.", "error");
    return false;
  }
  return true;
}

function isEditableElement(element) {
  return Boolean(
    element?.closest?.(
      'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]'
    )
  );
}

function extractImageUrlFromHtml(html) {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const image = doc.querySelector("img[src]");
    return image?.src || "";
  } catch {
    return "";
  }
}

function isLikelyWebUrl(value) {
  return /^https?:\/\//i.test((value || "").trim());
}

function loadBackgroundImageFile(file, sourceLabel = "Custom image") {
  if (!validateImageFile(file)) return;
  const uploadNonce = claimImageSelection();
  state.productImageAnalysis = null;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const img = new Image();
    img.onload = async () => {
      if (state.imageSelectionNonce !== uploadNonce) return;
      await ensureImageFocalPoint(img);
      state.mainImage = img;
      resetImageControls();
      editPanel.hidden = false;
      imagePanel.hidden = false;
      renderPoster();
      setStatus(`${sourceLabel} loaded!`, "success");
      bgImageUpload.value = "";
      analyzeUploadedProductImage(ev.target.result, uploadNonce);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

async function loadBackgroundImageUrl(url, sourceLabel = "Pasted image") {
  const trimmedUrl = (url || "").trim();
  if (!isLikelyWebUrl(trimmedUrl)) {
    setStatus("Paste a direct image, an image URL, or drag in an image file.", "error");
    return false;
  }

  const uploadNonce = claimImageSelection();
  state.productImageAnalysis = null;

  try {
    setStatus("Loading pasted image...");
    const proxiedUrl = `/api/image?url=${encodeURIComponent(trimmedUrl)}`;
    const img = await imageFromUrl(proxiedUrl);
    if (state.imageSelectionNonce !== uploadNonce) return true;
    state.mainImage = img;
    resetImageControls();
    editPanel.hidden = false;
    imagePanel.hidden = false;
    renderPoster();
    setStatus(`${sourceLabel} loaded!`, "success");
    try {
      analyzeUploadedProductImage(proxiedUrl, uploadNonce);
    } catch (error) {
      console.warn("Pasted image analysis failed to start:", error);
    }
    return true;
  } catch (error) {
    console.warn("Pasted image URL load failed:", error);
    setStatus("That pasted link did not behave like a direct image.", "error");
    return false;
  }
}

async function loadClipboardImageData(clipboardData) {
  const file =
    getFirstImageFile(clipboardData?.items) ||
    getFirstImageFile(clipboardData?.files);
  if (file) {
    loadBackgroundImageFile(file, "Pasted image");
    return true;
  }

  const html = clipboardData?.getData?.("text/html") || "";
  const htmlImageUrl = extractImageUrlFromHtml(html);
  if (htmlImageUrl) {
    return loadBackgroundImageUrl(htmlImageUrl, "Pasted image");
  }

  const plainText = (clipboardData?.getData?.("text/plain") || "").trim();
  if (isLikelyWebUrl(plainText)) {
    return loadBackgroundImageUrl(plainText, "Pasted image");
  }

  return false;
}

async function loadBackgroundImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && isLikelyWebUrl(text)) {
          await loadBackgroundImageUrl(text, "Clipboard image");
          return;
        }
      } catch (error) {
        console.warn("Clipboard text read failed:", error);
      }
    }
    setStatus("Clipboard paste button is not supported here. Use Ctrl+V or Cmd+V on the upload box.", "error");
    return;
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const clipboardItem of clipboardItems) {
      const imageType = clipboardItem.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await clipboardItem.getType(imageType);
        const file = new File([blob], `clipboard-image.${imageType.split("/")[1] || "png"}`, { type: imageType });
        loadBackgroundImageFile(file, "Clipboard image");
        return;
      }
      if (clipboardItem.types.includes("text/html")) {
        const html = await (await clipboardItem.getType("text/html")).text();
        const imageUrl = extractImageUrlFromHtml(html);
        if (imageUrl && (await loadBackgroundImageUrl(imageUrl, "Clipboard image"))) return;
      }
      if (clipboardItem.types.includes("text/plain")) {
        const text = (await (await clipboardItem.getType("text/plain")).text()).trim();
        if (text && isLikelyWebUrl(text) && (await loadBackgroundImageUrl(text, "Clipboard image"))) return;
      }
    }
    setStatus("No image found in the clipboard.", "error");
  } catch (error) {
    console.warn("Clipboard image read failed:", error);
    setStatus("Clipboard access was blocked. Copy an image, then use Ctrl+V or Cmd+V on the upload box.", "error");
  }
}

bgImageUpload.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  loadBackgroundImageFile(file);
});

if (bgPasteBtn) {
  bgPasteBtn.addEventListener("click", () => {
    loadBackgroundImageFromClipboard();
  });
}

if (bgUploadZone) {
  let dragDepth = 0;

  bgUploadZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      bgImageUpload.click();
    }
  });

  bgUploadZone.addEventListener("paste", (event) => {
    event.preventDefault();
    loadClipboardImageData(event.clipboardData).then((handled) => {
      if (!handled) setStatus("No image found in the clipboard.", "error");
    });
  });

  bgUploadZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    bgUploadZone.classList.add("is-dragover");
  });

  bgUploadZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    bgUploadZone.classList.add("is-dragover");
  });

  bgUploadZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth || event.target === bgUploadZone) {
      bgUploadZone.classList.remove("is-dragover");
    }
  });

  bgUploadZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    bgUploadZone.classList.remove("is-dragover");
    const file = getFirstImageFile(event.dataTransfer?.files) || getFirstImageFile(event.dataTransfer?.items);
    if (!file) {
      setStatus("Drop an image file to use it as the background.", "error");
      return;
    }
    loadBackgroundImageFile(file, "Dropped image");
  });
}

document.addEventListener("paste", (event) => {
  const target = event.target;
  if (isEditableElement(target)) return;
  const zoneFocused =
    document.activeElement === bgUploadZone ||
    document.activeElement === bgPasteBtn ||
    bgUploadZone?.contains?.(document.activeElement);
  const pasteInsideZone = bgUploadZone?.contains?.(target);
  if (!zoneFocused && !pasteInsideZone) return;
  event.preventDefault();
  loadClipboardImageData(event.clipboardData).then((handled) => {
    if (!handled) setStatus("No image found in the clipboard.", "error");
  });
});

async function analyzeUploadedProductImage(imageData, expectedNonce) {
  try {
    setStatus("Reading product text and patterns...");
    const prepared = await prepareImageForAnalysis(imageData);
    if (state.imageSelectionNonce !== expectedNonce) return;

    const response = await fetch("/api/analyze-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageData: prepared }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Image analysis failed.");
    if (state.imageSelectionNonce !== expectedNonce) return;

    /* Onto the page the picture was picked for. This is page-owned and the
       vision call outlives the click, so an added slide was inheriting a
       different slide's analysis and skewing its suggested-image terms. */
    commitFieldToPage(imageSelectionOwner, "productImageAnalysis", payload.analysis || null);
    const analysis = imageSelectionOwner?.content?.productImageAnalysis ?? state.productImageAnalysis;
    const text = (analysis?.visibleText || []).join(", ");
    setStatus(text ? `Product text recognized: ${text}` : "Product patterns recognized.", "success");
  } catch (error) {
    console.warn("Product image analysis failed:", error);
    if (state.imageSelectionNonce === expectedNonce) {
      setStatus("Custom image loaded. Product text recognition unavailable.", "success");
    }
  }
}

async function prepareImageForAnalysis(imageData) {
  const img = await createImage(imageData);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(img.width * scale));
  out.height = Math.max(1, Math.round(img.height * scale));
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(img, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.86);
}

/* ── Canvas drag-to-pan ── */

canvas.addEventListener("mousedown", (e) => {
  if (!state.mainImage) return;
  isDragging = true;
  canvas.classList.add("dragging");
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  dragStart = { x: e.clientX * scaleX, y: e.clientY * scaleY };
  dragOffsetStart = { ...state.imageOffset };
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const dx = e.clientX * scaleX - dragStart.x;
  const dy = e.clientY * scaleY - dragStart.y;
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  imgOffsetX.value = Math.round(state.imageOffset.x);
  imgOffsetY.value = Math.round(state.imageOffset.y);
  scheduleRender();
});

window.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    canvas.classList.remove("dragging");
  }
});

// Touch support for mobile
canvas.addEventListener("touchstart", (e) => {
  if (!state.mainImage || e.touches.length !== 1) return;
  isDragging = true;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  dragStart = { x: touch.clientX * scaleX, y: touch.clientY * scaleY };
  dragOffsetStart = { ...state.imageOffset };
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (!isDragging || e.touches.length !== 1) return;
  const touch = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const dx = touch.clientX * scaleX - dragStart.x;
  const dy = touch.clientY * scaleY - dragStart.y;
  state.imageOffset.x = clamp(dragOffsetStart.x + dx, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  state.imageOffset.y = clamp(dragOffsetStart.y + dy, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
  imgOffsetX.value = Math.round(state.imageOffset.x);
  imgOffsetY.value = Math.round(state.imageOffset.y);
  renderPoster();
  e.preventDefault();
}, { passive: false });

canvas.addEventListener("touchend", () => { isDragging = false; });

/* ── Scrape Flow ── */

async function runScrape() {
  const url = scrapeUrlInput.value.trim();
  if (!url) {
    setStatus("Enter an article URL first.", "error");
    return;
  }

  scrapeButton.disabled = true;
  scrapeButton.classList.add("loading");
  setStatus("Scraping article...");

  try {
    const response = await fetch("/api/scrape-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Scrape failed.");
    }

    // A new article is a new post: drop the row this session was editing so
    // the next save creates one rather than overwriting the previous story.
    startNewPix();

    // Update state
    state.headline = payload.title || "";
    state.detailText = limitDetailTextClient(payload.detailText || payload.articleText || payload.title || "");
    // The scrape already extracted the full article body. Keep it: the AI
    // writer needs it to produce specific bullets, and without it the server
    // has to re-fetch the URL — a second request that often fails on
    // paywalled or JS-rendered pages, silently degrading to headline-only.
    state.articleText = payload.articleText || "";
    state.sourceUrl = payload.sourceUrl || scrapeUrlInput.value.trim();
    syncSourceUrlInput();
    state.ready = true;
    state.scrapedTitle = payload.title || "";
    state.imageQuery = payload.imageQuery || "";
    state.sourceImageUrl = payload.image || null;

    // Reset offsets
    state.imageOffset = { x: 0, y: 0 };
    imgOffsetX.value = 0;
    imgOffsetY.value = 0;

    // Populate edit panel
    headlineEdit.value = payload.title || "";
    if (detailEdit) detailEdit.value = state.detailText;
    writeHeadline.value = payload.title || "";
    writeDetail.value = state.detailText;
    editPanel.hidden = false;
    imagePanel.hidden = false;
    scrollPreviewIntoViewIfMobile();
    closeSheetIfMobile();

    // Load scraped image
    if (payload.imageProxy) {
      setStatus("Loading image...");
      try {
        state.mainImage = await imageFromUrl(payload.imageProxy);
      } catch {
        state.mainImage = null;
        setStatus("Article scraped! Image could not load — using placeholder.", "success");
      }
    } else {
      state.mainImage = null;
    }

    renderPoster();
    setStatus(`Scraped — writing the article…`, "success");

    // Fetch recommended stock images in the background
    fetchStockImages(payload.title, { smartQuery: payload.imageQuery || "" });

    // One action, everything filled: scraping now also writes the headline,
    // the four points and the tweet, and pushes them into the slides. The
    // scrape is the moment we have the freshest source text, so this is
    // where grounding is best.
    generateArticle({ applyToSlides: true }).then((data) => {
      setStatus(
        data ? "Done! Poster and article ready — edit below, then download."
             : "Poster ready. The article writer failed — open the Article tab to retry.",
        data ? "success" : "error"
      );
    });
  } catch (error) {
    setStatus(error.message || "Unable to scrape that article.", "error");
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.classList.remove("loading");
  }
}

async function fetchStockImages(headline, options = {}) {
  const { autoApplyFirst = false, autoApplyRandom = false, onStatus = null, smartQuery = "" } = options;
  const selectionNonceAtStart = state.imageSelectionNonce;
  const report = (message, type) => {
    if (typeof onStatus === "function") onStatus(message, type);
  };

  try {
    // 1. Preferred: the AI-generated entity query from the scrape (e.g.
    //    "Karan Johar Ranbir Kapoor Ramayana"). Fallback: naive keyword
    //    extraction from the headline (write-mode has no scrape payload).
    const STOP = new Set(["THE", "A", "AN", "AND", "OR", "BUT", "FOR", "WITH", "FROM", "THAT", "THIS",
      "WILL", "WOULD", "SHOULD", "COULD", "SAYS", "SAID", "AFTER", "BEFORE", "ABOUT",
      "HAVE", "HAS", "HAD", "WAS", "WERE", "ARE", "IS", "BEEN", "INTO", "OVER", "UNDER",
      "THEIR", "THEY", "THEM", "THERE", "THEN", "MORE", "MOST", "VERY", "JUST", "ALSO",
      "NEW", "NEWS", "LIVE", "WHAT", "WHEN", "WHERE", "WHO", "HOW", "WHY", "WHICH", "AMID", "IN", "ON"]);

    // Extract alphanumeric words, uppercase
    const words = headline.toUpperCase().replace(/[^A-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const keywords = words.filter(w => !STOP.has(w) && w.length > 2).slice(0, 5); // Take top 5 meaningful words

    let searchQuery = smartQuery
      || (keywords.length > 0 ? keywords.join(" ") : headline.slice(0, 40));
    if (smartQuery) console.log(`[images] using AI query: "${smartQuery}"`);
    const imageContext = buildProductImageContext(state.productImageAnalysis);
    const imageSearchTerms = buildProductSearchTerms(state.productImageAnalysis);
    if (imageSearchTerms) {
      searchQuery = `${searchQuery} ${imageSearchTerms}`.trim().slice(0, 120);
    }

    let images = [];

    // COST ORDER: free sources first. Flux (fal.ai) BILLS PER GENERATION, so
    // it only runs as the last resort when both free sources return nothing —
    // previously it fired first on every scrape and quietly burned credits.

    // 2. Web / News images (free: Bing -> Google -> DDG)
    try {
      const gRes = await fetch(`/api/google-images?query=${encodeURIComponent(searchQuery)}`);
      const gData = await gRes.json();
      if (gRes.ok && gData.images?.length) {
        images = gData.images;
      }
    } catch { /* Web images failed, try Stock Pexels */ }

    // 3. Pexels stock (free tier)
    if (!images.length) {
      try {
        const pRes = await fetch(`/api/stock-images?query=${encodeURIComponent(searchQuery)}`);
        const pData = await pRes.json();
        if (pRes.ok && pData.images?.length) {
          images = pData.images;
        }
      } catch { /* Pexels also failed */ }
    }

    // 4. Flux generation — PAID, last resort only.
    if (!images.length) {
      try {
        const fluxUrl = `/api/flux-image?query=${encodeURIComponent(searchQuery)}${imageContext ? `&context=${encodeURIComponent(imageContext)}` : ""}`;
        const fRes = await fetch(fluxUrl);
        const fData = await fRes.json();
        if (fRes.ok && fData.images?.length) {
          images = fData.images;
        }
      } catch { /* Flux failed too */ }
    }

    if (!images.length) {
      images = buildFallbackImageSuggestions(searchQuery);
    }

    if (!images.length) {
      stockImagesSection.hidden = true;
      report("No matching images found. You can upload one manually.", "error");
      return;
    }

    stockImagesGrid.innerHTML = "";
    const getLoadableImageUrls = (img) => {
      const urls = [img.imageProxy, img.image, img.preview].filter(Boolean);
      return [...new Set(urls)];
    };

    const applySuggestedImage = async (img, thumb = null, expectedNonce = null) => {
      // The slide this pick is FOR, before any await moves the selection.
      const owner = activePage();
      if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
        return false;
      }
      report("Loading selected image...");
      setStatus("Loading image...");
      for (const imageUrl of getLoadableImageUrls(img)) {
        try {
          const fullImg = await imageFromUrl(imageUrl);
          if (expectedNonce !== null && state.imageSelectionNonce !== expectedNonce) {
            return false;
          }
          await ensureImageFocalPoint(fullImg);
          claimImageSelection();
          // claimImageSelection() stamps the CURRENT page; this pick belongs
          // to the one it was made from.
          imageSelectionOwner = owner;
          if (stashImageForAbsentPage(owner, fullImg)) {
            report("Image applied to the slide it was chosen for.", "success");
            setStatus("Image applied!", "success");
            stockImagesGrid.querySelectorAll(".stock-item").forEach(t => t.classList.remove("active"));
            if (thumb) thumb.classList.add("active");
            return true;
          }
          state.mainImage = fullImg;
          resetImageControls();
          renderPoster();
          report("Image applied.", "success");
          setStatus("Image applied!", "success");
          stockImagesGrid.querySelectorAll(".stock-item").forEach(t => t.classList.remove("active"));
          if (thumb) thumb.classList.add("active");
          return true;
        } catch {
          // Keep trying the next available URL for this result.
        }
      }
      report("Failed to load that image.", "error");
      setStatus("Failed to load image.", "error");
      return false;
    };

    const thumbs = [];
    images.forEach(img => {
      const thumb = document.createElement("div");
      thumb.className = "stock-item";
      thumb.style.backgroundImage = `url(${img.preview})`;
      thumb.title = img.alt || "Related image";
      thumb.addEventListener("click", () => applySuggestedImage(img, thumb));
      stockImagesGrid.appendChild(thumb);
      thumbs.push(thumb);
    });

    stockImagesSection.hidden = false;
    report(`Found ${images.length} matching image${images.length === 1 ? "" : "s"}.`, "success");

    if ((autoApplyFirst || autoApplyRandom) && images[0] && state.imageSelectionNonce === selectionNonceAtStart) {
      const order = images.map((_, index) => index);
      if (autoApplyRandom) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      }

      let applied = false;
      for (const index of order) {
        if (state.imageSelectionNonce !== selectionNonceAtStart) break;
        applied = await applySuggestedImage(images[index], thumbs[index], selectionNonceAtStart);
        if (applied) break;
      }

      if (applied) {
        report(`Poster ready with a matching image. ${images.length > 1 ? "Tap another thumbnail to change it." : ""}`.trim(), "success");
      } else if (state.imageSelectionNonce === selectionNonceAtStart) {
        report("Found images, but none loaded. Try a thumbnail or upload one manually.", "error");
      }
    }
  } catch {
    stockImagesSection.hidden = true;
    report("Image search failed. You can upload one manually.", "error");
  }
}

/* ── Poster Rendering ── */

// Compute the headline layout (lines + font) AND its top y position based on
// canvas.height - bottomPadding. Done once per render and stashed on state
// so drawBackground / drawTag / drawHeadline all use the same anchor.
function buildProductSearchTerms(analysis) {
  if (!analysis) return "";
  return [
    analysis.productType,
    ...(analysis.visibleText || []).slice(0, 3),
    ...(analysis.brandCues || []).slice(0, 2),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildProductImageContext(analysis) {
  if (!analysis) return "";
  const parts = [];
  if (analysis.productType) parts.push(`product type: ${analysis.productType}`);
  if (analysis.visibleText?.length) parts.push(`visible text/OCR: ${analysis.visibleText.join(", ")}`);
  if (analysis.brandCues?.length) parts.push(`brand cues: ${analysis.brandCues.join(", ")}`);
  if (analysis.patterns?.length) parts.push(`patterns: ${analysis.patterns.join(", ")}`);
  if (analysis.colors?.length) parts.push(`colors: ${analysis.colors.join(", ")}`);
  if (analysis.promptHints) parts.push(`prompt hints: ${analysis.promptHints}`);
  return parts.join("; ").slice(0, 900);
}

function computeHeadlineLayoutAndTop() {
  const L = getLayout();
  const text = state.headline || "YOUR HEADLINE HERE";
  const layout = state.fontSize > 0
    ? buildHeadlineLayoutFixed(text, L.headline.maxWidth, state.fontSize)
    : buildHeadlineLayout(text, L.headline.maxWidth, 5);

  // Pull the actual font size out of the font string so the block height
  // doesn't depend on layout.lineHeight (which has line-spacing baked in)
  const m = layout.font.match(/(\d+(?:\.\d+)?)px/);
  const fontSize = m ? parseFloat(m[1]) : 49;

  const blockHeight = (layout.lines.length - 1) * layout.lineHeight + fontSize;
  const bottomPadding = isXRenderMode()
    ? 56
    : L.headline.bottomPadding + (hasPosterFooter() ? POSTER_FOOTER.headlineLift : 0);
  const top = Math.max(0, canvas.height - bottomPadding - blockHeight);
  return { layout, top, fontSize, blockHeight, bottomPadding };
}

/* ── Three cards, one renderer ──
   The reader swipes a carousel, so the editor shows all three slides at once
   instead of hiding two behind a mode toggle. Every draw function reads the
   module-level `ctx` and `canvas`, so each card is painted by pointing `ctx`
   at that card's canvas and setting the mode — the same swap trick the
   high-res exporter already uses. No draw function needed changing.

   `state._targetedRender` marks "paint once into the ctx I gave you", which
   is what the exporter and the per-card painters need; without it a nested
   renderPoster() would recurse back into painting all three. */

/* ── Pages ──────────────────────────────────────────────────────────────
   The carousel is a spine plus extras.

   The spine is what a scrape produces and cannot be removed: Poster is
   page 1 and Text is page 2. Everything else — including video — is added
   by hand, up to MAX_PAGES in total, in any mix of poster / text / video.

   Only one page is selected at a time, and the editor columns write to
   whichever that is. Rather than thread a page argument through forty draw
   and control functions, the selected page's values ARE `state`: switching
   pages captures the outgoing page's fields out of state and applies the
   incoming page's fields into it. Painting does the same swap per card, so
   every page can be on screen at once while only one is live.

   A field is either page-owned (listed below) or global. Global is the
   default and covers everything that is a property of the post rather than
   of one page in it: accent, logo, aspect ratio, the timestamp toggle. */

const MAX_PAGES = 5;

// The background image is owned by poster AND text pages: the text card
// paints a blurred copy of it, so two text pages with one shared image
// could not look different from each other.
const IMAGE_PAGE_FIELDS = [
  /* storedImageUrl/storedImageFor are page-owned for the same reason
     mainImage is: each slide has its own picture and therefore its own
     uploaded copy. They were plain `state` values when only the post had an
     image, and leaving them there broke the moment pages got their own —
     syncActivePageContent() REPLACES page.content with a fresh capture of the
     declared fields, so a URL written onto the selected page's content was
     discarded by the next sync. Undeclared meant unsaved. */
  "mainImage", "storedImageUrl", "storedImageFor", "imageOffset", "imageZoom",
  "filterPreset", "filterBrightness", "filterContrast", "filterSaturation", "filterBlur",
  "sourceImageUrl", "productImageAnalysis",
];
const POSTER_PAGE_FIELDS = [...IMAGE_PAGE_FIELDS, "headline", "tag", "fontSize", "headlineStyle"];
/* A text page owns its background but not its words: the paragraph is one
   body of text on the post, divided across the text pages at paint time.
   See recomputeDetailSlices(). */
const TEXT_PAGE_FIELDS   = [...IMAGE_PAGE_FIELDS];
/* A story page owns everything it shows: its own image, its own heading and
   its own body copy. That last one is what separates it from a text page —
   a text page takes a SLICE of the post's single paragraph, so its words are
   decided by how many text pages there are. A story page is written directly,
   which is what you want when each slide makes its own point. */
const STORY_PAGE_FIELDS  = [...IMAGE_PAGE_FIELDS, "storyHeading", "storyBody", "storyOverlayOpacity"];
/* A video page owns its upload and its last encode as well as its clip:
   two video pages that shared `storedVideoUrl` would publish each other's
   footage. */
const VIDEO_PAGE_FIELDS  = [
  "videoEl", "videoSrc", "videoUrl", "videoFile", "videoMeta", "videoSourceKind",
  /* The name of the file the writer chose. The File itself does not survive a
     reload, so without this a reviewer opening the post has no way to see WHAT
     was added — only that something was. */
  "videoFileName",
  "trimStart", "trimEnd", "videoMuted", "videoFocus", "videoCaption", "videoCaptionSize",
  "storedVideoUrl", "storedVideoFor", "clipSourceUrl", "renderedClip",
];

// The spine is poster + text. Video is not part of it, so the base page
// never owns a clip — only an added Video page does.
const BASE_PAGE_FIELDS = [...new Set([...POSTER_PAGE_FIELDS, ...TEXT_PAGE_FIELDS, "detailText"])];
const ALL_PAGE_FIELDS = [...new Set([...BASE_PAGE_FIELDS, ...STORY_PAGE_FIELDS, ...VIDEO_PAGE_FIELDS])];

const PAGE_TYPES = {
  poster: { label: "Poster", mode: "pix",   download: "Download",  fields: POSTER_PAGE_FIELDS },
  text:   { label: "Text",   mode: "text",  download: "Download",  fields: TEXT_PAGE_FIELDS },
  story:  { label: "Story",  mode: "story", download: "Download",  fields: STORY_PAGE_FIELDS },
  video:  { label: "Video",  mode: "video", download: "Export MP4", fields: VIDEO_PAGE_FIELDS },
};

/* Which editor controls can reach a given page. Controls that cannot are
   dimmed instead of hidden — the panel keeps its shape, so nothing jumps
   when the selection changes. */
const PAGE_SCOPE = {
  base:   { headline: true,  detail: true,  tag: true,  image: true,  video: false },
  poster: { headline: true,  detail: false, tag: true,  image: true,  video: false },
  text:   { headline: false, detail: true,  tag: false, image: true,  video: false },
  /* A story page writes its own heading and its own body, into storyHeading
     and storyBody. The post-level headline and paragraph boxes are therefore
     off here: they are not this page's copy, and leaving them live meant a
     writer aiming at the story heading hit the POST headline instead and
     silently rewrote the poster. Story pages get their own two boxes. */
  story:  { headline: false, detail: false, tag: false, image: true,  video: false },
  video:  { headline: false, detail: false, tag: false, image: false, video: true  },
};

const basePage = { id: "base", type: "base", el: null, cards: [], content: null };
const pages = [basePage];
let activePageId = "base";
let pageSeq = 0;

basePage.cards = Array.from(document.querySelectorAll('.preview-card[data-page="base"]')).map((el) => ({
  el,
  mode: el.dataset.previewMode,
  canvas: el.querySelector("canvas"),
  page: basePage,
  detailSlice: null,     // set by recomputeDetailSlices() on text cards
  sliceRange: null,
}));

/* ── Rail order ──
   `pages` holds content; `slotOrder` holds the sequence the reader sees.
   They are separate because the spine is one page with two cards, and a
   card has to be movable on its own. Page numbers are slot positions, so
   reordering renumbers by construction — there is nothing to keep in step. */
const slotOrder = [...basePage.cards];
let currentModalCard = null;

function cardForElement(el) { return slotOrder.find((card) => card.el === el) || null; }

const xPreviewCanvas = document.getElementById("x-canvas");

function fieldsForPage(page) {
  if (!page || page.type === "base") return BASE_PAGE_FIELDS;
  return PAGE_TYPES[page.type]?.fields || [];
}

const CARD_LABELS = { pix: "Poster", text: "Text", story: "Story", video: "Video", x: "For X" };
function cardLabel(card) {
  if (!card) return "Page";
  if (card.isX || card.mode === "x") return "For X";
  return CARD_LABELS[card.mode] || "Page";
}

// Where a card sits in the rail, 1-based — what the writer sees on it.
function cardNumber(card) {
  if (!card) return "1";
  if (card.isX || card.mode === "x") return "𝕏";
  return slotOrder.indexOf(card) + 1;
}

function getPage(id) { return pages.find((p) => p.id === id) || basePage; }
function activePage() { return getPage(activePageId); }
function extraPages() { return pages.filter((p) => p !== basePage); }

// One card, one page, one number. Counting the cards that are actually in
// the rail is what stops the count and the rail drifting apart — that is
// what let a full rail render six.
function pageCount() { return slotOrder.length; }
function canAddPage() { return pageCount() < MAX_PAGES; }

/* Copy the plain {x,y} pairs so a stored page cannot be mutated later by a
   drag on the live one. Images, Files and <video> elements are shared by
   reference on purpose — they are the payload, not a value. */
function clonePageValue(value) {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return { ...value };
  }
  return value;
}

function capturePageFields(fields) {
  const out = {};
  for (const field of fields) out[field] = clonePageValue(state[field]);
  return out;
}

function applyPageFields(values) {
  if (!values) return;
  for (const key of Object.keys(values)) state[key] = values[key];
}

/* Fold live state back into the selected page before anything reads a page.
   Fields the selected page does not own are still edits to the post, so
   they land on the base page — otherwise changing the paragraph while an
   added poster page is selected would vanish on the next repaint. */
function syncActivePageContent() {
  const page = activePage();
  page.content = capturePageFields(fieldsForPage(page));
  if (page !== basePage) {
    const owned = new Set(fieldsForPage(page));
    const rest = BASE_PAGE_FIELDS.filter((field) => !owned.has(field));
    basePage.content = { ...(basePage.content || {}), ...capturePageFields(rest) };
  }
}

/* Read the post as its OWN page holds it, whatever page is selected.
   `state` is the SELECTED page's values — setActivePage() applies the base
   page's content and then the selected page's on top — so a save taken while
   an added page is selected was reading that page's headline, tag, image and
   framing and writing them into the post's own columns. Clicking "Add page"
   on a saved post was enough: the new page's blank image landed in
   main_image_url and the row lost its picture with nobody touching a key.

   Deliberately a READ-ONLY view. The obvious alternative — swap the base
   page's values into `state` for the duration of the save — corrupts the
   other direction: serializePages() and withPrimaryVideo() both begin with
   syncActivePageContent(), which would file the base page's headline and
   image under the selected page and write that into design.pages, where a
   restore of `state` afterwards cannot reach it. Nothing here writes back,
   so those helpers keep seeing the true selection.

   The spread is safe for fields the selected page does not own:
   syncActivePageContent() has just folded those onto basePage.content, and
   fields no page owns at all (storedImageUrl, sourceUrl, article…) are not
   in BASE_PAGE_FIELDS, so `state`'s value survives the overlay untouched.
   That is what lets callers read every field off the view rather than having
   to remember which of them the pages happen to own. */
function basePageView() {
  syncActivePageContent();
  return activePage() === basePage ? state : { ...state, ...(basePage.content || {}) };
}

function paintCardInto(target, mode) {
  if (!target) return;
  if (target.width !== canvas.width || target.height !== canvas.height) {
    target.width = canvas.width;
    target.height = canvas.height;
  }
  const prevCtx = ctx;
  const prevMode = state.previewMode;
  const prevTargeted = state._targetedRender;
  ctx = target.getContext("2d");
  state.previewMode = mode;
  state._targetedRender = true;
  try {
    paintPoster();
  } finally {
    ctx = prevCtx;
    state.previewMode = prevMode;
    state._targetedRender = prevTargeted;
  }
}

/* ── Dividing the points across text pages ──
   The paragraph stays one body of text — it is what gets saved, published
   and searched, and splitting it into per-page copies would mean four
   places to keep in step. Instead each text card is handed a slice of it
   at paint time: six points over two text pages is 3 and 3, over three
   pages 2/2/2, and seven over two is 4 and 3.

   Because slices are derived rather than stored, adding, removing or
   dragging a text page re-divides them on the next paint with nothing to
   invalidate. */

function detailPoints(text) {
  return (text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[•*-]\s*$/.test(line));
}

// Remainders go to the earliest pages, so 7 over 2 reads 4 then 3 — a
// fuller first card looks deliberate where a fuller last one looks like
// something overflowed.
function distributePoints(points, buckets) {
  const out = [];
  let taken = 0;
  let remainder = points.length % buckets;
  const each = Math.floor(points.length / buckets);
  for (let i = 0; i < buckets; i += 1) {
    const size = each + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    out.push(points.slice(taken, taken + size));
    taken += size;
  }
  return out;
}

let detailSliceKey = "";

function recomputeDetailSlices({ force = false } = {}) {
  const textCards = slotOrder.filter((card) => card.mode === "text");
  const body = getFullDetailText();
  const key = `${slotOrder.map((c) => c.mode).join(",")}|${body}`;
  if (!force && key === detailSliceKey) return;
  detailSliceKey = key;

  // One text page carries the whole paragraph, exactly as it always did.
  if (textCards.length < 2) {
    for (const card of textCards) { card.detailSlice = null; card.sliceRange = null; }
    syncSliceLabels();
    return;
  }

  const points = detailPoints(body);
  const chunks = distributePoints(points, textCards.length);
  let next = 1;
  textCards.forEach((card, i) => {
    const chunk = chunks[i];
    card.detailSlice = chunk.join("\n\n");
    card.sliceRange = chunk.length ? [next, next + chunk.length - 1] : null;
    next += chunk.length;
  });
  syncSliceLabels();
}

function syncSliceLabels() {
  for (const card of slotOrder) {
    const label = card.el.querySelector(".preview-card-slice");
    if (!label) continue;
    label.hidden = true;
    label.textContent = "";
  }
}

/* ── One repaint per frame, however fast the typing ──────────────────────────

   renderPoster() repaints every page and the X preview, which is 5-20ms of
   work. Called straight out of an input handler that is what every keystroke
   costs, and a fast typist or a dragged slider outruns it: the events queue,
   each one paints a frame nobody will ever see, and the editor feels like it
   is catching up rather than responding.

   The screen only refreshes sixty times a second, so more than one paint per
   frame is work thrown away by definition. This collapses a burst into the
   single paint that actually reaches the glass.

   Deliberately NOT applied to renderPoster() itself. Some callers paint and
   then immediately read the canvas back — the export path, the X preview, the
   screen-preview modal — and deferring those would hand them a stale or empty
   canvas. Those keep calling renderPoster() directly and paint synchronously,
   exactly as before. Only the continuous-input handlers schedule, because they
   are the only ones that fire faster than the display. */
let renderScheduled = false;

/* ── Paint what is being edited now; paint the rest once the hand stops ─────

   One paint per frame was still one paint of EVERYTHING per frame: every
   page's card and the X preview, when the writer is looking at one of them.
   Three cards is three photographs drawn, three backdrops blurred, three
   panes of glass built, for one card that moved. On a five-page post it is
   five, and the drag stutters in proportion.

   So a scheduled render paints the active page's cards on the frame, and the
   others — plus the X preview, which is on a different tab — are painted once
   SETTLE_MS has passed with no further input. They cannot fall out of step
   for longer than that, and nothing that reads a canvas back goes through
   here: those callers still call renderPoster() and get every card at once. */
const SETTLE_MS = 150;
let settleTimer = 0;

function liveCards() {
  const page = activePage();
  return new Set(page && page.cards ? page.cards : []);
}

function settleRender() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    renderPoster();
  }, SETTLE_MS);
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderPoster({ cards: liveCards() });
    settleRender();
  });
}

function renderPoster(opts) {
  // Export paths swap ctx themselves and want a single paint.
  if (state._targetedRender) { paintPoster(); return; }

  // A Set of cards restricts the paint to those — a scheduled render passes
  // the active page's. Anything else, no argument or an Event from a
  // listener, paints the lot.
  const only = opts && opts.cards instanceof Set ? opts.cards : null;

  syncZoomReadout();
  syncActivePageContent();
  syncXComposerLink();
  recomputeDetailSlices();

  // The live values, restored after the last card. Every page is painted
  // through base first, so a page only overrides the fields it owns and
  // inherits the rest of the post.
  const live = capturePageFields(ALL_PAGE_FIELDS);

  try {
    for (const page of pages) {
      applyPageFields(live);
      applyPageFields(basePage.content);
      if (page !== basePage) applyPageFields(page.content);
      for (const card of page.cards) {
        if (only && !only.has(card)) continue;
        // A text card paints its slice of the paragraph, not the whole of it.
        state._detailSlice = card.detailSlice || null;
        paintCardInto(card.canvas, card.mode);
      }
      state._detailSlice = null;
    }

    // X is the poster again, so it always follows page 1 — never whichever
    // page happens to be selected.
    if (!only) {
      applyPageFields(live);
      applyPageFields(basePage.content);
      paintCardInto(xPreviewCanvas, "x");
    }
  } finally {
    applyPageFields(live);
    if (currentModalCard) updateScreenPreviewModal();
    // After applyPageFields(live), not before: the paint loop leaves state
    // holding whichever page it drew last, and the button belongs to the page
    // on screen.
    syncImageUndoUI();
  }
}

/* ── Page operations ── */

function blankPageContent(type) {
  const blank = {
    mainImage: null,
    imageOffset: { x: 0, y: 0 },
    imageZoom: 100,
    filterPreset: "none",
    filterBrightness: 100,
    filterContrast: 100,
    filterSaturation: 100,
    filterBlur: 0,
    sourceImageUrl: null,
    productImageAnalysis: null,
    headline: "",
    tag: "none",
    fontSize: 0,
    // Blank everywhere else, but a headline needs *a* style: inheriting the
    // post's current one is the least surprising starting point.
    headlineStyle: state.headlineStyle,
    detailText: "",
    storyHeading: "",
    storyBody: "",
    storyOverlayOpacity: 100,
    videoEl: null,
    videoSrc: "",
    videoUrl: "",
    videoFile: null,
    videoMeta: null,
    videoSourceKind: "file",
    trimStart: 0,
    trimEnd: 0,
    videoMuted: false,
    videoFocus: { x: 0.5, y: 0.5 },
    storedVideoUrl: null,
    storedVideoFor: null,
    clipSourceUrl: "",
    renderedClip: null,
    videoCaption: "",
    videoCaptionSize: state.videoCaptionSize,
  };
  const owned = new Set(fieldsForPage({ type }));
  const content = {};
  for (const field of owned) content[field] = clonePageValue(blank[field]);
  return content;
}

/* Build and mount a page. Kept separate from addPage() so reopening a saved
   post can rebuild its pages without each one stealing the selection and
   capturing the live values on the way past. */
function createPage(type, content) {
  const spec = PAGE_TYPES[type];
  const addTile = document.getElementById("preview-add");
  if (!spec || !addTile) return null;

  pageSeq += 1;
  const id = `page-${pageSeq}`;

  const fig = document.createElement("figure");
  fig.className = "preview-card";
  fig.dataset.page = id;
  fig.dataset.previewMode = spec.mode;
  fig.innerHTML = `
          <figcaption class="preview-card-label" title="Click to view full screen">
            <button type="button" class="preview-card-grip" data-grip
                    aria-label="Move this page — drag, or use the left and right arrow keys"
                    title="Drag to reorder (or focus and press &larr; &rarr;)">&#10287;</button>
            <span class="preview-card-num"></span>
            <span class="preview-card-type">${spec.label}</span>
            <button type="button" class="preview-card-remove" data-remove-page
                    aria-label="Remove this page" title="Remove this page">&times;</button>
          </figcaption>
          <div class="canvas-container">
            <canvas width="${canvas.width}" height="${canvas.height}"></canvas>
          </div>
          <p class="preview-card-slice" hidden></p>
          <div class="preview-card-actions">
            <button type="button" class="btn-ghost preview-card-edit" data-edit-page>
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.3 2.2l2.5 2.5L6 12.5 3 13l.5-3z" fill="none"
                      stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
              </svg> Edit
            </button>
            <button type="button" class="btn-ghost preview-card-dl" data-download="${spec.mode}">
              <svg width="12" height="12" aria-hidden="true"><use href="#i-download"/></svg> ${spec.download}
            </button>
          </div>`;

  const cardCanvas = fig.querySelector("canvas");
  const page = {
    id,
    type,
    el: fig,
    cards: [],
    content: { ...blankPageContent(type), ...(content || {}) },
  };
  page.cards = [{
    el: fig, mode: spec.mode, canvas: cardCanvas, page, detailSlice: null, sliceRange: null,
  }];

  addTile.before(fig);
  pages.push(page);
  slotOrder.push(page.cards[0]);
  if (type === "video") attachVideoReframe(cardCanvas, id);
  return page;
}

function addPage(type) {
  if (!canAddPage()) return null;
  // A new page starts empty rather than as a copy of page 1: clearing a
  // duplicate is more work than filling a blank.
  const page = createPage(type, null);
  if (!page) return null;

  renumberPages();
  setActivePage(page.id);
  page.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  return page;
}

/* ── Saving the page list ──
   Text, tags, framing AND the page's own image. The image used to be left
   out: it lives in the tab as a data: URL, only the post's picture was ever
   uploaded, and a URL cannot be stored for a file that was never sent — so a
   reopened post rebuilt its added pages empty of media. ensureMediaUploaded
   now uploads each page's picture first and leaves the URL on page.content,
   which is what `imageUrl` below carries. */
function serializePages() {
  syncActivePageContent();
  return extraPages().map((page) => {
    const c = page.content || {};
    const entry = { type: page.type };
    if (page.type === "story") {
      // A story page carries its own words, so they travel with the page
      // rather than being derived from the post's paragraph on open.
      entry.storyHeading = c.storyHeading || "";
      entry.storyBody = c.storyBody || "";
      entry.overlayOpacity = c.storyOverlayOpacity ?? 100;
    }
    if (page.type === "poster") {
      entry.headline = c.headline || "";
      entry.tag = c.tag || "none";
      entry.fontSize = c.fontSize ?? 0;
      entry.headlineStyle = c.headlineStyle;
    }
    // No text: a text page shows a slice of the post's paragraph, and the
    // slice is derived from the page order on open.
    /* The page's own picture, for every type that shows one. Without this the
       row remembered how a slide was framed but not what it framed. */
    if (c.storedImageUrl) entry.imageUrl = c.storedImageUrl;

    if (page.type === "poster" || page.type === "text" || page.type === "story") {
      entry.imageZoom = c.imageZoom ?? 100;
      entry.imageOffset = { x: c.imageOffset?.x ?? 0, y: c.imageOffset?.y ?? 0 };
      entry.filters = {
        preset: c.filterPreset || "none",
        brightness: c.filterBrightness ?? 100,
        contrast: c.filterContrast ?? 100,
        saturation: c.filterSaturation ?? 100,
        blur: c.filterBlur ?? 0,
      };
    }
    if (page.type === "video") {
      entry.video = {
        url: c.videoUrl || null,
        // The bucket copy is the only part of a clip that survives a reload,
        // so it is the one piece of media a page does carry across.
        storedUrl: c.storedVideoUrl || null,
        storedFor: c.storedVideoFor || null,
        sourceKind: c.videoSourceKind || "link",
        trimStart: c.trimStart ?? 0,
        trimEnd: c.trimEnd ?? 0,
        muted: !!c.videoMuted,
        focus: { x: c.videoFocus?.x ?? 0.5, y: c.videoFocus?.y ?? 0.5 },
        caption: c.videoCaption || "",
        captionSize: c.videoCaptionSize ?? state.videoCaptionSize,
      };
    }
    return entry;
  });
}

/* `spine` is the list of base cards the post was SAVED with. It has to be
   applied HERE rather than afterwards, because the loop below spends the
   MAX_PAGES budget as it goes.

   Without it: a writer who removes the Text slide to make room can build a
   poster plus four story pages, and it saves correctly — spine ["pix"] and
   four page entries. On reopen this function reseeded the rail with EVERY
   base card, so the budget started at 2 instead of the 1 that was saved, and
   the `canAddPage()` guard in the loop broke out one entry early. The last
   slide was dropped, in silence. restoreSpineCards() then removed the Text
   card a moment later — freeing the very slot the page had just been refused.

   Worse than losing it on screen: the next save serialises the three pages
   that survived over the four that were stored, so the fifth slide's heading,
   body and picture leave the database too. Autosave did that without anyone
   pressing a thing. */
function restorePages(list, spine) {
  for (const page of extraPages()) {
    if (page.parkedVideo) {
      page.parkedVideo.removeAttribute("src");
      page.parkedVideo.load();
    }
    page.el?.remove();
  }
  pages.length = 1;
  slotOrder.length = 0;
  /* A post saved before the spine was recorded has no list; both cards is the
     arrangement it was saved under, so that is what it reopens with. */
  const wantedSpine = Array.isArray(spine) ? spine : null;
  for (const card of basePage.cards) {
    if (wantedSpine && !wantedSpine.includes(card.mode)) {
      /* renumberPages() only re-inserts cards that are IN slotOrder — it
         never takes one out — so a card left in the DOM here would sit in the
         rail as a ghost that no page owns. */
      card.el?.remove();
      continue;
    }
    slotOrder.push(card);
  }
  activePageId = "base";
  playerOwner = null;

  for (const entry of Array.isArray(list) ? list : []) {
    if (!PAGE_TYPES[entry?.type] || !canAddPage()) break;
    const content = {};
    if (entry.type === "story") {
      content.storyHeading = entry.storyHeading || "";
      content.storyBody = entry.storyBody || "";
      // `imageOpacity` was briefly written by the first version of this
      // control. Reuse its value for the gradient, but never fade the image.
      content.storyOverlayOpacity = clamp(numberOr(entry.overlayOpacity, numberOr(entry.imageOpacity, 100)), 0, 100);
    }
    if (entry.type === "poster") {
      content.headline = entry.headline || "";
      content.tag = entry.tag || "none";
      content.fontSize = numberOr(entry.fontSize, 0);
      if (entry.headlineStyle) content.headlineStyle = entry.headlineStyle;
    }
    /* Story pages belong here too. serializePages() writes imageZoom,
       imageOffset and filters for "poster", "text" AND "story", but this side
       only ever read them back for the first two — so a story slide that had
       been zoomed in on a face, nudged into place or given a filter reopened
       at 100% and dead centre, and the next save wrote those defaults back
       over the framing the writer had chosen. */
    if (entry.type === "poster" || entry.type === "text" || entry.type === "story") {
      content.imageZoom = numberOr(entry.imageZoom, 100);
      content.imageOffset = {
        x: numberOr(entry.imageOffset?.x, 0),
        y: numberOr(entry.imageOffset?.y, 0),
      };
      content.filterPreset = entry.filters?.preset || "none";
      content.filterBrightness = numberOr(entry.filters?.brightness, 100);
      content.filterContrast = numberOr(entry.filters?.contrast, 100);
      content.filterSaturation = numberOr(entry.filters?.saturation, 100);
      content.filterBlur = numberOr(entry.filters?.blur, 0);
    }
    if (entry.type === "video") {
      content.videoUrl = entry.video?.url || "";
      content.storedVideoUrl = entry.video?.storedUrl || null;
      /* Seed the player source too, so the card can paint without waiting to
         be selected and adoptPageVideo has something to load. */
      content.videoSrc = entry.video?.storedUrl || "";
      content.clipSourceUrl = entry.video?.storedUrl || "";
      content.storedVideoFor = entry.video?.storedFor || null;
      content.videoSourceKind = entry.video?.sourceKind || "link";
      content.trimStart = numberOr(entry.video?.trimStart, 0);
      content.trimEnd = numberOr(entry.video?.trimEnd, 0);
      content.videoMuted = !!entry.video?.muted;
      content.videoFocus = {
        x: numberOr(entry.video?.focus?.x, 0.5),
        y: numberOr(entry.video?.focus?.y, 0.5),
      };
      content.videoCaption = entry.video?.caption || "";
      content.videoCaptionSize = numberOr(entry.video?.captionSize, state.videoCaptionSize);
    }
    /* The picture comes back through the proxy, exactly as page 1's does.

       Deliberately not awaited: restorePages is called from a synchronous
       rebuild and a post with four slides would otherwise block the editor on
       four sequential network fetches before drawing anything. Each page
       paints as its own image lands, and renderPoster is called per arrival
       rather than once at the end so the rail fills in progressively instead
       of staying blank until the slowest one finishes. A failure leaves that
       page without its picture, which is what happened to every page before
       this existed — no worse, and the rest still open. */
    const page = createPage(entry.type, content);
    if (entry.imageUrl && page) {
      page.content.storedImageUrl = entry.imageUrl;
      imageFromUrl(`/api/image?url=${encodeURIComponent(entry.imageUrl)}`)
        .then((img) => {
          if (!page.content) return;
          page.content.mainImage = img;
          page.content.storedImageFor = img?.src || entry.imageUrl;
          /* If this page is the one on screen, its content was copied into
             `state` before the image arrived, so the canvas is still drawing
             the empty version. Push it across before repainting. */
          if (activePage() === page) state.mainImage = img;
          renderPoster();
        })
        .catch(() => {});
    }
  }

  renumberPages();
}

/* Take a card out of the rail without destroying the page behind it.

   The two spine cards both live on `basePage`, which owns the post itself —
   the headline, the image, the paragraph. Deleting that page would take the
   post with it, which is why removePage() refuses index 0. But refusing to
   remove the CARD was a different rule wearing the same coat: a story that is
   only a video, or only a poster, is an ordinary thing to want, and there was
   no way to say so.

   So the card leaves slotOrder and the DOM while the page stays. Putting it
   back is just pushing the card in again — see restoreSpineCards(). */
function removeCard(card) {
  const slot = slotOrder.indexOf(card);
  if (slot < 0) return;
  // A post with no pages is not a post.
  if (slotOrder.length <= 1) {
    setStatus("A post needs at least one page.", "error");
    return;
  }

  slotOrder.splice(slot, 1);
  card.el?.remove();

  // The selection may have been sitting on the card that just left.
  if (!slotOrder.some((c) => c.el?.dataset?.page === activePageId)) {
    const next = slotOrder[0];
    if (next) setActivePage(next.el?.dataset?.page || "base", { force: true });
  }

  renumberPages();
  renderPoster();
  setStatus("Page removed.", "success");
}

/* Which spine cards are in the rail right now. Saved with the post, because
   otherwise removing the text page and reopening would quietly bring it back
   and the removal would look like it had failed. */
function spineCardsInRail() {
  return slotOrder.filter((c) => c.el?.dataset?.page === "base").map((c) => c.mode);
}

function restoreSpineCards(modes) {
  // Older posts have no spine list. Leaving both in is the behaviour they
  // were saved under, so that is what they get.
  if (!Array.isArray(modes)) return;
  let changed = false;
  for (const card of basePage.cards) {
    const present = slotOrder.includes(card);
    const wanted = modes.includes(card.mode);
    if (present && !wanted) {
      slotOrder.splice(slotOrder.indexOf(card), 1);
      card.el?.remove();
      changed = true;
    } else if (!present && wanted) {
      /* Back to the front, in the spine's own order, rather than appended.
         A returning poster belongs at the start of the story — pushing it
         onto the end would silently reorder the post on open. */
      const at = card.mode === "pix" ? 0 : Math.min(1, slotOrder.length);
      slotOrder.splice(at, 0, card);
      changed = true;
    }
  }
  /* renumberPages() is what actually puts a card back on screen — it
     re-inserts every element before the add tile. restorePages() already ran
     it before this point, so without this call a restored card would sit in
     slotOrder while never appearing in the rail: present in the data, absent
     from the page. */
  if (changed) {
    renumberPages();
    renderPoster();
  }
}

/* Back to a blank story: the two spine cards, no added pages, no clip, no
   image, no copy.

   "Start a new post" is not only the New post button. That button reloads the
   document, so it never had to clear anything by hand — but Scrape & Build and
   Write Text start a new post inside a live tab, and everything the previous
   story built is still standing when they do.

   Clearing scalar fields on `state` is not enough on its own, and that is the
   part that is easy to get wrong: every field in ALL_PAGE_FIELDS is owned by a
   PAGE, and `page.content` — not live state — is what setActivePage() applies
   and what serializePages() writes. So story A's Video page stayed in the rail
   with its uploaded clip, A's storedVideoUrl went into story B's saved row,
   and QA publishing B shipped A's slides and A's footage to DailyMattr under
   B's headline. DailyMattr is write-only; that cannot be taken back. */
function resetPostModel() {
  /* Read the blanks first, while live state is still intact: blankPageContent()
     seeds headlineStyle and videoCaptionSize from `state` on purpose — those
     are settings the writer chose, not content belonging to the last story.
     base + story + video together cover exactly ALL_PAGE_FIELDS. */
  const blank = {
    ...blankPageContent("base"),
    ...blankPageContent("story"),
    ...blankPageContent("video"),
  };

  /* Drops every added page, unloads each one's parked <video>, resets
     activePageId and playerOwner, and renumbers the rail. It leaves the last
     clip loaded in the shared <video> element, which is deliberate and
     harmless: no card paints it once state.videoEl is cleared below, and the
     next video page's adoptPageVideo() detaches the src it does not want. */
  restorePages([]);
  // A spine card the last story removed belongs back in a fresh post.
  restoreSpineCards(["pix", "text"]);

  /* Not optional: setActivePage() applies basePage.content over live state on
     every selection, so without this the writer's first click on any card
     brings back A's headline, image and paragraph. If a non-base page was
     selected when the new post started, syncActivePageContent() has already
     folded A's base fields in there. */
  basePage.content = null;
  for (const field of ALL_PAGE_FIELDS) state[field] = clonePageValue(blank[field]);

  /* restorePages() sets activePageId by assignment, so live state and the
     editor controls were never refreshed from the now-blank base page. This is
     the call that pushes the cleared content out to both — applyDesignSnapshot
     ends the same way, for the same reason. */
  setActivePage("base", { force: true });
}

function removePage(id) {
  const index = pages.findIndex((p) => p.id === id);
  if (index <= 0) return;                    // the spine is not removable
  const [page] = pages.splice(index, 1);

  if (page.parkedVideo) {
    page.parkedVideo.removeAttribute("src");
    page.parkedVideo.load();
    page.parkedVideo = null;
  }
  // The shared player would otherwise still be held by a page that no
  // longer exists, and the next video page would decline to reload.
  if (playerOwner === page) playerOwner = null;
  for (const card of page.cards) {
    const slot = slotOrder.indexOf(card);
    if (slot >= 0) slotOrder.splice(slot, 1);
  }
  page.el?.remove();

  if (activePageId === id) {
    activePageId = "base";
    applyPageFields(basePage.content);
    adoptPageVideo(basePage);
    syncEditorFromState();
  }

  renumberPages();
  renderPoster();
  setStatus("Page removed.", "success");
}

function renumberPages() {
  const addTile = document.getElementById("preview-add");

  slotOrder.forEach((card, index) => {
    const number = index + 1;
    const numEl = card.el.querySelector(".preview-card-num");
    if (numEl) numEl.textContent = String(number);
    card.canvas?.setAttribute("aria-label", `Page ${number} — ${cardLabel(card)}`);
    // Re-inserting every card before the tile, in order, is what puts the
    // rail in slot order — including after a drag.
    addTile?.before(card.el);
  });

  const used = pageCount();
  const chip = document.getElementById("page-count-chip");
  if (chip) {
    chip.textContent = `${used} of ${MAX_PAGES} pages`;
    chip.classList.toggle("is-full", used >= MAX_PAGES);
  }
  const addBtn = document.getElementById("preview-add-btn");
  if (addBtn) {
    /* aria-disabled, not disabled. A disabled button does not fire a click at
       all, so pressing plus on a full rail produced silence — no menu, no
       message, nothing — and the writer concluded the editor was broken
       rather than that they had run out of slides. It still reads as disabled
       to assistive tech and still looks dimmed; the difference is that the
       handler now runs and can explain itself. */
    const room = canAddPage();
    addBtn.disabled = false;
    addBtn.setAttribute("aria-disabled", room ? "false" : "true");
    addBtn.title = room
      ? "Add another page"
      : `${MAX_PAGES} slides is the limit — the poster and the Text slide count too. Remove one to add another.`;
  }
  const hint = document.getElementById("preview-add-hint");
  if (hint) hint.textContent = canAddPage() ? `${MAX_PAGES - used} left` : "Full";

  syncPageSelectionUI();
}

function setActivePage(id, { force = false } = {}) {
  const next = getPage(id);
  if (!force && next.id === activePageId) return;

  syncActivePageContent();

  activePageId = next.id;

  applyPageFields(basePage.content);
  if (next !== basePage) applyPageFields(next.content);

  // Only another video page can take the shared player, so selecting a
  // poster or text page leaves it — and its clip — exactly where it was.
  if (next.type === "video") adoptPageVideo(next);
  syncEditorFromState();
  syncPageSelectionUI();
  renderPoster();
}

function syncPageSelectionUI() {
  document.querySelectorAll(".preview-card[data-page]").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.page === activePageId);
  });

  const page = activePage();
  const bar = document.getElementById("page-context");
  const name = document.getElementById("page-context-name");
  if (bar) bar.hidden = page === basePage;
  if (name && page !== basePage) {
    name.textContent = `Page ${cardNumber(page.cards[0])} · ${PAGE_TYPES[page.type]?.label || "Page"}`;
  }

  applyPageScope(page);
}

function applyPageScope(page) {
  const scope = PAGE_SCOPE[page.type] || PAGE_SCOPE.base;
  const setScope = (el, on) => {
    if (!el) return;
    el.classList.toggle("scope-off", !on);
    if ("disabled" in el) el.disabled = !on;
  };
  setScope(headlineEdit, scope.headline);
  /* The Size slider sizes the headline, so it belongs to the same gate. It was
     in no scope at all: on a Story or Text page the headline box sat visibly
     dimmed and disabled while the slider right beneath it stayed live — and
     moving it edited the poster on page 1, a card the writer was not looking
     at, with no visible effect on the page they were. */
  setScope(fontSizeInput, scope.headline);
  setScope(detailEdit, scope.detail);
  setScope(tagPresetsContainer, scope.tag);
  setScope(document.getElementById("video-acc"), scope.video);
  setScope(imagePanel, scope.image);
}

/* Push state back into the controls after a page switch — without this the
   panel would show the previous page's values over the new page's canvas. */
function syncEditorFromState() {
  if (headlineEdit) headlineEdit.value = state.headline || "";
  if (detailEdit) detailEdit.value = state.detailText || "";

  /* The story fields address the SELECTED page, so they follow the selection
     like every other page-scoped control — and they are hidden entirely off a
     story page, because there would be nothing for them to write to. */
  const storyBox = document.getElementById("story-fields");
  const headingEl = document.getElementById("story-heading-edit");
  const bodyEl = document.getElementById("story-body-edit");
  if (storyBox) storyBox.hidden = activePage()?.type !== "story";
  if (headingEl && headingEl.value !== (state.storyHeading || "")) headingEl.value = state.storyHeading || "";
  if (bodyEl && bodyEl.value !== (state.storyBody || "")) bodyEl.value = state.storyBody || "";
  const storySelected = activePage()?.type === "story";
  if (storyOpacityControl) storyOpacityControl.hidden = !storySelected;
  syncControl(storyOverlayOpacityInput, clamp(numberOr(state.storyOverlayOpacity, 100), 0, 100));
  syncControl(imgOffsetX, state.imageOffset?.x ?? 0);
  syncControl(imgOffsetY, state.imageOffset?.y ?? 0);
  syncControl(imgZoom, state.imageZoom);
  syncControl(fontSizeInput, state.fontSize);
  syncFilterUI();

  if (tagPresetsContainer) {
    tagPresetsContainer.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tag === state.tag);
    });
  }

  const captionInput = document.getElementById("video-caption");
  if (captionInput) captionInput.value = state.videoCaption || "";
  syncControl(document.getElementById("video-caption-size"), state.videoCaptionSize);
  const muteInput = document.getElementById("video-mute");
  if (muteInput) muteInput.checked = !!state.videoMuted;
  const videoEditor = document.getElementById("video-editor");
  if (videoEditor) videoEditor.hidden = !(state.videoSrc || state.videoUrl || state.videoFile);
  syncTrimUI();
}

/* ── One player, several video pages ──
   The editor has a single <video>, and `playerOwner` is the page whose clip
   is currently in it. Selecting a poster or text page changes nothing: the
   owner keeps the player, so the common case — one video page — never
   reloads. Only a second video page taking the player forces the previous
   owner onto a detached copy, parked at its own trim point, so its card
   keeps painting its own footage. */
let playerOwner = null;

function parkPageVideo(page) {
  if (!page || !videoPreviewEl || page.type !== "video") return;

  const src = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";
  const content = page.content || (page.content = {});
  content.videoSrc = src;
  if (!src) { content.videoEl = null; return; }

  let parked = page.parkedVideo;
  if (!parked) {
    parked = document.createElement("video");
    parked.muted = true;
    parked.playsInline = true;
    parked.preload = "auto";
    page.parkedVideo = parked;
  }

  const at = videoPreviewEl.currentTime || content.trimStart || 0;
  if (parked.getAttribute("src") !== src) {
    parked.src = src;
    parked.addEventListener("loadeddata", () => {
      try { parked.currentTime = at; } catch { /* seek before metadata */ }
      renderPoster();
    }, { once: true });
    parked.load();
  } else {
    try { parked.currentTime = at; } catch { /* nothing loaded yet */ }
  }
  content.videoEl = parked;
}

function adoptPageVideo(page) {
  if (!page || !videoPreviewEl || page.type !== "video") return;

  const content = page.content || (page.content = {});

  // Already holding this page's clip — nothing to move.
  if (playerOwner === page) {
    content.videoEl = videoPreviewEl;
    state.videoEl = videoPreviewEl;
    return;
  }

  if (playerOwner && playerOwner !== page) parkPageVideo(playerOwner);

  /* Fall back to what the page actually stores.

     Only ONE video page is primed with a videoSrc on load (loadPixIntoEditor
     does it for design.video), so any other restored video page had an empty
     `wanted` — and an empty `wanted` meant this blanked the shared player
     instead of loading that page's own footage. Clicking the Video card made
     the clip that was visible a moment earlier disappear. storedUrl is the
     bucket copy; the link is re-previewed through the proxy the same way the
     fetch path does it. */
  const wanted = content.videoSrc
    || content.storedVideoUrl
    || (content.videoUrl ? `/api/video/preview?u=${encodeURIComponent(content.videoUrl)}` : "");
  const current = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";

  if (wanted && wanted !== current) {
    const at = content.trimStart || 0;
    videoPreviewEl.addEventListener("loadeddata", () => {
      try { videoPreviewEl.currentTime = at; } catch { /* seek before metadata */ }
      renderPoster();
    }, { once: true });
    videoPreviewEl.src = wanted;
    videoPreviewEl.load();
  } else if (!wanted && current) {
    videoPreviewEl.removeAttribute("src");
    videoPreviewEl.load();
  }

  playerOwner = page;
  content.videoEl = videoPreviewEl;
  state.videoEl = videoPreviewEl;
  state.videoSrc = wanted;
}

/* The page whose clip save and publish should use. Extra video pages get a
   preview and their own Export MP4, but a post ships one video. */
function primaryVideoPage() {
  const withClip = pages.find((p) => p.type === "video"
    && (p.content?.videoUrl || p.content?.videoFile || p.content?.storedVideoUrl));
  return withClip || pages.find((p) => p.type === "video") || null;
}

function primaryVideoContent() {
  return primaryVideoPage()?.content || {};
}

/* Run something that reads and writes the post's video against the primary
   video page, whatever is selected. Anything it produces — a fresh encode,
   an uploaded URL — is folded back into that page rather than left on the
   page the writer happens to be looking at. */
async function withPrimaryVideo(fn) {
  syncActivePageContent();
  const live = capturePageFields(VIDEO_PAGE_FIELDS);
  const page = primaryVideoPage();

  applyPageFields(page
    ? Object.fromEntries(VIDEO_PAGE_FIELDS.map((f) => [f, clonePageValue(page.content?.[f])]))
    : blankPageContent("video"));

  try {
    return await fn();
  } finally {
    /* What fn actually produced — a fresh encode, an uploaded URL, a new clip
       key — read out of state before anything is restored over it. */
    const produced = capturePageFields(VIDEO_PAGE_FIELDS);
    if (page) Object.assign(page.content, produced);

    /* `live` is a snapshot taken BEFORE fn ran, so restoring it blindly puts
       the pre-upload values back into state. That is harmless while some other
       page is selected — the video page owns the fields and state's copy is
       irrelevant — but it is destructive when the video page is the one on
       screen, because then state IS that page's live copy and the very next
       syncActivePageContent() captures the stale snapshot straight back over
       the upload. The clip encoded, uploaded and logged successfully, and the
       row still saved storedUrl: null.

       Writers are routinely on the Video page when they press Save — it is
       the page they were just editing — so this was the common path, not the
       rare one. */
    applyPageFields(activePage() === page ? produced : live);
  }
}

/* Reopening a post saved before video became its own page: its clip has to
   land somewhere, so give it one. */
function ensureVideoPage() {
  return pages.find((p) => p.type === "video") || (canAddPage() ? createPage("video", null) : null);
}

/* restoreStoredVideo() finishes asynchronously, on loadedmetadata, and
   writes the trim range into live state — by which time the selection has
   moved back to page 1. Registering after it (listeners run in order) lets
   us catch those values and file them under the page they belong to.

   `loadToken` is loadPixIntoEditor's load counter; see the re-baseline at the
   foot of the handler for why this needs one. */
function bindRestoredVideoToPage(page, loadToken) {
  if (!videoPreviewEl || !page) return;
  videoPreviewEl.addEventListener("loadedmetadata", () => {
    Object.assign(page.content, capturePageFields(VIDEO_PAGE_FIELDS), {
      videoEl: videoPreviewEl,
      videoSrc: videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "",
    });
    playerOwner = page;
    if (activePageId === page.id) syncEditorFromState();
    renderPoster();
    /* This handler is the real end of the open, long after loadPixIntoEditor's
       promise resolved — so its editorLoading window has already closed and
       cannot cover us. Everything just written (trimStart, trimEnd,
       storedVideoFor) was DERIVED from the row's own design.video, so it is
       what the library already holds, not an edit; without saying so, merely
       opening a post with a clip left the editor looking dirty and the idle
       poller wrote it back ~3s later — re-encoding the clip from a source URL
       that has usually expired. The token stops a slow clip belonging to the
       previously-open post from declaring the current one saved. */
    if (loadToken === editorLoadSeq) markPixSaved();
  }, { once: true });
}

function paintPoster() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (isVideoPreviewMode()) {
    drawPixVideoScreen();
    return;
  }

  if (isTextPreviewMode()) {
    drawPixTextScreen();
    return;
  }

  if (isStoryPreviewMode()) {
    drawStoryScreen();
    return;
  }

  // Compute headline layout + bottom-anchored top ONCE for this render and
  // share via state._render so drawBackground / drawTag / drawHeadline don't
  // each have to recompute the same thing.
  state._render = computeHeadlineLayoutAndTop();

  drawBackground();
  drawHero();
  drawTag();
  drawHeadline();
  drawHeadlineTimestamp();
  drawPosterFooter();

  // Preview-only UI elements (not included in download).
  // Only the 9:16 preset shows the Reels-style engagement + nav bars; on
  // square / wide / 4:5 ratios these mockups don't make visual sense.
  if (!state.isDownloading && !isXRenderMode() && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawNavBar();
  }

  // AI Enhance is only meaningful once a real background image is loaded
  const enhanceBtn = document.getElementById("ai-enhance-btn");
  if (enhanceBtn && !enhanceBtn.classList.contains("working")) {
    enhanceBtn.disabled = !state.mainImage;
  }
}

/**
 * Slide 2, video variant: the clip fills the frame with the Shortly/Pix
 * branding over it.
 *
 * This same function produces BOTH the on-screen preview and the transparent
 * PNG that ffmpeg burns into the exported MP4 — see renderVideoOverlayPng().
 * Sharing one renderer is the whole point: the branding in the file is
 * guaranteed to be what the user approved on screen, and the media service
 * never needs a font, a layout table, or a redeploy when the design changes.
 *
 * In overlay-export mode the video frame and the mockup chrome are skipped,
 * leaving gradient + logo on transparency.
 */
function drawPixVideoScreen() {
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);
  const overlayOnly = !!state.videoOverlayExport;

  ctx.save();

  if (!overlayOnly) {
    // Letterbox backdrop, then the current video frame scaled to cover.
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);
    const v = state.videoEl;
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      // focus 0.5 is centred; 0 pins the left/top edge, 1 the right/bottom.
      // Only the overflowing axis can move, so the frame never shows letterbox.
      const f = state.videoFocus || { x: 0.5, y: 0.5 };
      ctx.drawImage(v, -(dw - W) * f.x, -(dh - H) * f.y, dw, dh);
    }
  }

  // Bottom scrim so the logo and any platform UI stay legible over bright
  // footage. Lighter than the poster's gradient — the video is the subject
  // here, not a backdrop for a headline.
  const fade = Math.min(H * 0.42, L.gradient.fadeHeight * 1.5);
  const grad = ctx.createLinearGradient(0, H - fade, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.34)");
  grad.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - fade, W, fade);

  // A matching top scrim keeps the logo readable on light footage.
  const topFade = H * 0.18;
  const topGrad = ctx.createLinearGradient(0, 0, 0, topFade);
  topGrad.addColorStop(0, "rgba(0,0,0,0.46)");
  topGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, topFade);

  drawFixedLogos();
  drawVideoCaption();

  // Mockup chrome is preview-only — it must never reach the exported file.
  if (!overlayOnly && !state.isDownloading && getLayout().showPreviewBars) {
    drawEngagementBar();
    drawPixPageDots(0.5 * W, 1558 * (H / 1700), s);
    drawNavBar();
  }

  ctx.restore();
}

/**
 * Caption burned into the video slide, bottom-anchored like the poster
 * headline. Supports the same [bracket] / (paren) / {brace} highlight
 * syntax as the headline, so the two slides look like one system.
 *
 * Drawn inside drawPixVideoScreen, which means it lands in BOTH the live
 * preview and the transparent PNG ffmpeg composites — no server change was
 * needed to add this.
 *
 * Bottom padding matches the headline preset, which is already tuned to sit
 * above the platform's own UI (the engagement/nav bars the preview mocks up).
 */
function drawVideoCaption() {
  const raw = (state.videoCaption || "").trim();
  if (!raw) return;

  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  const maxWidth = L.headline.maxWidth;
  const left = L.headline.x;
  const fontSize = Math.round((state.videoCaptionSize || 48) * s);
  const lineHeight = headlineLineHeight(raw, fontSize, 1.22);
  // Same face and weight as the poster headline (buildHeadlineLayout), so the
  // video slide and the poster read as one system.
  const font = `600 ${fontSize}px 'Roboto Serif', 'Poppins', serif`;

  ctx.save();
  ctx.font = font;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // Wrap on the visible text — bracket characters are markup, not glyphs, so
  // measuring with them in would wrap too early. Newlines are honoured as
  // deliberate breaks: each segment wraps on its own.
  const lines = [];
  for (const segment of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(test.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "")).width <= maxWidth) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }

  const MAX_LINES = 4;
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1].replace(/[\s.,;:]+$/, "")}…`;
  }

  // Measured to the last line's glyphs, not its full line step — the same
  // block height computeHeadlineLayoutAndTop uses, so caption and date land
  // exactly where the poster's headline and date do.
  const blockHeight = (lines.length - 1) * lineHeight + fontSize;
  const top = H - L.headline.bottomPadding * (H / 1700) - blockHeight;

  // Pass 1 — accent boxes behind highlighted runs.
  // `tone` rather than a boolean: a run is open in ONE of two colours now, and
  // the segment has to carry which so the box can be filled per run.
  let tone = null;
  lines.forEach((text, i) => {
    const y = top + i * lineHeight;
    let cursor = left;
    let segStart = null;
    let segWidth = 0;
    const segments = [];
    const parts = text.split(" ");

    parts.forEach((rawWord, idx) => {
      const opening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
      const closing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
      const clean = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "");
      if (opening) tone = highlightToneFor(rawWord);

      const wordWidth = ctx.measureText(clean).width;
      const advance = wordWidth + ctx.measureText(" ").width;

      if (tone && clean.length) {
        if (segStart === null) segStart = cursor;
        segWidth += (closing || idx === parts.length - 1) ? wordWidth : advance;
      }
      if ((closing || idx === parts.length - 1) && segStart !== null) {
        segments.push({ x: segStart, w: segWidth, tone });
        segStart = null;
        segWidth = 0;
      }
      if (closing) tone = null;
      cursor += advance;
    });

    const padX = fontSize * 0.16;
    const padY = fontSize * 0.14;
    segments.forEach(seg => {
      // Per segment, not once for the line — two runs on one line can be two
      // different colours.
      ctx.fillStyle = highlightColor(seg.tone);
      const r = fontSize * 0.18;
      const bx = seg.x - padX;
      const by = y - padY;
      const bw = seg.w + padX * 2;
      const bh = fontSize + padY * 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
    });
  });

  // Pass 2 — the words themselves.
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 16 * s;
  ctx.shadowOffsetY = 5 * s;
  lines.forEach((text, i) => {
    ctx.fillText(text.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, ""), left, top + i * lineHeight);
  });

  ctx.restore();

  // The poster's date stamp, placed the way drawHeadlineTimestamp places it:
  // just under the last line's glyphs, left edge shared with the caption.
  drawTimestamp(left, top + blockHeight + Math.round(14 * s), s);
}

/**
 * Render the video branding to a transparent PNG blob at exactly
 * `width`×`height` — the dimensions ffmpeg will scale the clip to, so the
 * overlay lands pixel-for-pixel with no resampling drift.
 */
async function renderVideoOverlayPng(width, height) {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  // Design-space → output-space. The canvas preset drives layout, so this is
  // a uniform scale by construction and the overlay can't skew.
  outCtx.scale(width / canvas.width, height / canvas.height);

  const prevCtx = ctx;
  const prevMode = state.previewMode;
  const prevTargeted = state._targetedRender;
  ctx = outCtx;
  state.videoOverlayExport = true;
  state.previewMode = "video";
  state._targetedRender = true;
  try {
    drawPixVideoScreen();
  } finally {
    ctx = prevCtx;
    state.videoOverlayExport = false;
    state.previewMode = prevMode;
    state._targetedRender = prevTargeted;
  }

  return new Promise((resolve) => {
    try { out.toBlob(resolve, "image/png"); } catch { resolve(null); }
  });
}

/**
 * Output size for the exported MP4. Width is pinned to 1080 (the practical
 * ceiling for Reels/Stories/Shorts) and height follows the CANVAS aspect,
 * not a nominal 9:16 — the "9:16" preset is really 920×1700 (0.541), so
 * assuming true 9:16 here would misalign the overlay by ~90px.
 * Both dimensions are forced even; libx264 + yuv420p requires it.
 */
function videoTargetSize() {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  // The overlay is drawn, not resampled, so targeting a larger frame than the
  // design canvas costs nothing in quality. Portrait and square go to 1080
  // wide (the Reels/Stories/Shorts standard); landscape goes to 1920.
  const width = even(canvas.width > canvas.height ? 1920 : 1080);
  const height = even(width * (canvas.height / canvas.width));
  return { width, height };
}

/* ── Preview repaint loop ──
   A <video> gives the canvas no "new frame" signal, so during playback we
   repaint every animation frame. It runs ONLY while the clip is actually
   playing — a paused video produces identical frames, and looping on those
   would burn a core for nothing. Seeks and loads repaint once instead
   (see the listeners further down). */
let videoPreviewRaf = 0;

// Only the video pages change from one frame of playback to the next. Every
// other card was being repainted sixty times a second for a clip it does not
// show, which is what made playback drop frames on a post with a poster and
// a text page beside it.
function videoCards() {
  return new Set(pages.filter((p) => p.type === "video").flatMap((p) => p.cards));
}

function startVideoPreviewLoop() {
  if (videoPreviewRaf) return;
  const tick = () => {
    const v = state.videoEl;
    // Park as soon as the mode changes or playback stops.
    if (!v || v.paused || v.ended) {
      videoPreviewRaf = 0;
      renderPoster();   // settle on the final frame
      return;
    }
    renderPoster({ cards: videoCards() });
    videoPreviewRaf = requestAnimationFrame(tick);
  };
  videoPreviewRaf = requestAnimationFrame(tick);
}

function stopVideoPreviewLoop() {
  if (videoPreviewRaf) cancelAnimationFrame(videoPreviewRaf);
  videoPreviewRaf = 0;
}

function drawPixTextScreen() {
  const image = state.mainImage || defaultMain;
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  ctx.save();
  ctx.fillStyle = "#070707";
  ctx.fillRect(0, 0, W, H);

  /* ── The text page is UNIFORMLY blurred, and that is the design ────────────

     It was drawn sharp here for a while, on the reasoning that a treatment
     going from sharp to frosted has nothing to show when its input is already
     frosted — true of the poster and the story page, and wrong about this one.
     Those two are photographs with a caption at the foot. This one is a page
     of body copy that fills the card, and the picture behind it is a texture,
     not a subject. There is no framing to preserve and nothing to be sharp
     for.

     The spec says so explicitly: one rectangle over the whole 382x682 frame,
     Background blur set to UNIFORM (not Progressive) at 16, with a linear fill
     at 85%. Those are this file's own numbers — GLASS.blurAt is 16,
     GLASS.blurCardWidth is 382, GLASS.fillAlpha is 0.85 — so the radius is
     taken from them rather than restated, and quoted in the design's units and
     scaled to whatever the canvas actually is, exactly as paintMistGlass does
     it. On a 920-wide card that is ~38px.

     Blur ONLY. The old default here also carried brightness(62%)
     contrast(108%) saturate(72%), which is why the page used to be 75-98%
     black before a word was drawn: the picture was dimmed twice, once in the
     filter and again by everything painted over it. The darkening belongs to
     the veil and the fill below, where it can be reasoned about; this layer
     just softens.

     Live: window.GLASS.blurAt = 24 then redraw. */
  const textBlur = Math.round((GLASS.blurAt * W) / GLASS.blurCardWidth);
  drawTextPreviewBackgroundImage(
    image, 0, 0, W, H, state.imageOffset, (state.imageZoom || 100) / 100, s,
    `blur(${textBlur}px)`,
  );

  const textX = L.headline.x;
  const minTextY = state.forceTextExport ? H * 0.16 : H * 0.1;
  const bottomTextPadding = state.forceTextExport ? L.headline.bottomPadding : 335;
  const lastLineY = H - bottomTextPadding * (H / 1700);
  /* Measured before anything is painted over the photograph, because the glass
     and the fade below are anchored to the top of this block. */
  const textLayout = layoutWrappedPreviewText(
    getDetailTextForPreview(), minTextY, L.headline.maxWidth, lastLineY, 39 * s, 61 * s);

  /* ── The same treatment the poster and the story page get ──────────────

     This page used to be the exception: a four-stop wash over the whole frame
     — 0.68 at the top, 0.52, 0.68, 0.98 at the foot — with a flat 0.22 on top
     of that. Between 75% and 98% black everywhere, which is why the frosted
     glass could not be seen on this page. There was nothing to see: the
     photograph was already gone before the copy was drawn.

     It is the same glass and the same fade as the other two pages now,
     anchored to the copy the same way.

     The veil is what the wash leaves behind, and it is here for a real reason
     rather than as a leftover. The other two pages put their copy in a known
     place near the foot, so the ramp always has run-up above it. This page's
     copy GROWS UPWARD from the foot and is clamped at minTextY, so a long
     enough post starts its first line a tenth of the way down the card, where
     the ramp has barely begun. The veil is the floor that keeps that first
     line legible; the glass supplies the build and the frost on top of it. */
  ctx.fillStyle = `rgba(0, 0, 0, ${GLASS.textPageVeil})`;
  ctx.fillRect(0, 0, W, H);

  paintMistGlass(ctx, { width: W, height: H, copyTop: textLayout.startY, image, cacheKey: glassCacheKey(image, "text") });
  paintBottomFade(ctx, {
    width: W,
    height: H,
    copyTop: textLayout.startY,
    fadeHeight: L.gradient.fadeHeight,
  });

  drawFixedLogos();

  drawWrappedPreviewTextLayout(textLayout, textX, L.headline.maxWidth);

  if (!state.forceTextExport) {
    drawEngagementBar();
    drawPixPageDots(0.5 * W, 1558 * (H / 1700), s);
    drawNavBar();
  }

  ctx.restore();
}

/* ── Story page ───────────────────────────────────────────────────────
   Its own image, its own heading, its own body copy — one slide making one
   point, which is what a swipeable story is made of.

   Distinct from the text page on purpose. A text page takes a SLICE of the
   post's single paragraph, so its words depend on how many text pages exist;
   add a page and every other page's words move. A story page is written
   directly, so a slide keeps what you wrote on it.

   The image is drawn full-bleed under a gradient that goes almost solid
   towards the bottom, rather than as a fixed top band. A hard split has to
   pick a height, and the reference slides do not agree on one — some are
   nearly full-photo, some are half. The gradient reads as either, and it
   never leaves a bare strip when a portrait image cannot fill a band. */
/* Type is specified against the 382-wide card the design is drawn on, and
   stored here already multiplied by 920/382 = 2.4084 — the reference frame
   every other number in this file uses. Both are written out so a value can
   be checked against the design without redoing the arithmetic:

     heading      19px   / 26px  line   ->  45.8 / 62.6
     description  16.8px / 26.8px line  ->  40.5 / 64.5 */
const STORY = {
  headingSize: 45.8,       // 19px, Roboto Serif Bold
  headingLineHeight: 62.6, // 26px
  maxHeadingLines: 3,
  bodySize: 40.5,          // 16.8px, Roboto Serif Medium
  bodyLineHeight: 64.5,    // 26.8px
  /* Raised from 7 once typed line breaks started counting: a short list burns
     a line per item, so the old cap cut off copy that fitted the frame fine.
     Ten still clears the picture — ten lines plus a heading leaves the block
     starting a little above the halfway mark. */
  maxBodyLines: 10,
  gapAfterHeading: 34,
  bottomPadding: 300,
};

function storyHeadingText() {
  /* No fallback to the post headline. A story page carries whatever is typed
     on it and nothing else — inheriting the headline put the poster's words
     on every story slide, which then had to be cleared by hand on each one,
     and an untouched page looked finished when it was not. Empty means empty:
     the heading is simply not drawn, and the body moves up to fill the space.

     Whitespace is flattened so the heading breaks on WIDTH and nothing else.
     It wraps now — it did not when this was written — but a typed newline in
     a two-line kicker gives a ragged break that the column width did not ask
     for, and the same heading then sets differently on a 4:5 card than on a
     9:16 one. Breaks belong in the body. */
  return (state.storyHeading || "").replace(/\s+/g, " ").trim();
}

function storyBodyText() {
  return (state.storyBody || "").trim();
}

/* One line of heading, with its [bracketed] runs set in the accent colour.

   The poster headline marks its highlights with a filled block behind white
   text. A story slide sits on a photograph rather than on a solid panel, and a
   block there fights the picture instead of sitting on it — so the same
   [bracket] markup paints the WORDS accent-blue and leaves the rest white.
   Marked and unmarked words therefore differ by colour, not by background. */
/* The heading's words, with their highlight state and their line breaks.

   Split from the drawing because the layout has to know how many lines the
   heading takes BEFORE it can place the block: the whole slide is laid out
   from the foot upward, so a heading that wraps to two lines pushes
   everything above it, and measuring during the draw would be too late.

   Wrapping is done over the words with the bracket characters already
   stripped, not over the raw string. Measuring the raw text would count
   characters that are never drawn and break the line early. */
function storyHeadingLayout(text, maxWidth, fontSize) {
  if (!text) return [];
  ctx.save();
  ctx.font = `700 ${Math.round(fontSize)}px 'Roboto Serif', 'Poppins', serif`;

  const words = [];
  // The tone of the run currently open, or null between runs — see
  // HIGHLIGHT_TONES. A word carries the key, not the colour.
  let openTone = null;
  text.split(" ").forEach((rawWord) => {
    const opening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
    const closing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
    if (opening) openTone = highlightToneFor(rawWord);
    const clean = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, "");
    if (clean.length) words.push({ text: clean, marked: Boolean(openTone), tone: openTone });
    if (closing) openTone = null;
  });

  const space = ctx.measureText(" ").width;
  const lines = [];
  let line = [];
  let width = 0;
  for (const word of words) {
    const w = ctx.measureText(word.text).width;
    const next = line.length ? width + space + w : w;
    if (line.length && next > maxWidth) {
      lines.push(line);
      line = [word];
      width = w;
      if (lines.length >= STORY.maxHeadingLines) break;
    } else {
      line.push(word);
      width = next;
    }
  }
  if (line.length && lines.length < STORY.maxHeadingLines) lines.push(line);

  ctx.restore();
  return lines;
}

function drawStoryHeading(lines, left, top, fontSize, lineHeight, s) {
  if (!lines.length) return top;
  ctx.save();
  ctx.font = `700 ${Math.round(fontSize)}px 'Roboto Serif', 'Poppins', serif`;
  ctx.textBaseline = "top";

  /* The shadow does the work the block used to: text on a photograph needs
     something to lift it off whatever happens to be behind it. */
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 14 * s;
  ctx.shadowOffsetY = 4 * s;

  const space = ctx.measureText(" ").width;
  lines.forEach((line, row) => {
    let cursor = left;
    const y = top + row * lineHeight;
    for (const word of line) {
      /* White unless the writer bracketed it.

         This used to read "no brackets anywhere means mark the whole
         heading", which made every unmarked heading accent-blue — a blue
         sentence across a photograph with nothing marking it as a kicker.
         Plain is now plain, and the accent stays available for the words
         somebody actually chooses to mark. */
      ctx.fillStyle = word.marked ? highlightColor(word.tone) : "#ffffff";
      ctx.fillText(word.text, cursor, y);
      cursor += ctx.measureText(word.text).width + space;
    }
  });

  ctx.restore();
  return top + lines.length * lineHeight;
}

function drawStoryScreen() {
  const image = state.mainImage || defaultMain;
  const W = canvas.width;
  const H = canvas.height;
  const L = getLayout();
  const s = Math.min(W / 920, H / 1700);

  ctx.save();
  ctx.fillStyle = "#070707";
  ctx.fillRect(0, 0, W, H);

  // "none": a story slide shows its picture sharp. The gradient below is what
  // makes the copy readable, not a blur across the whole frame.
  drawTextPreviewBackgroundImage(image, 0, 0, W, H, state.imageOffset, (state.imageZoom || 100) / 100, s, "none");

  const left = L.headline.x;
  const maxWidth = L.headline.maxWidth;
  const body = storyBodyText();

  /* Laid out from the bottom up, like the poster headline: the block is
     anchored to a fixed distance from the foot of the frame so slides with
     different amounts of copy still line up as a set when swiped. */
  ctx.textBaseline = "top";
  const headingSize = STORY.headingSize * s;
  const headingLine = STORY.headingLineHeight * s;
  const bodySize = STORY.bodySize * s;
  const bodyLine = STORY.bodyLineHeight * s;

  ctx.font = `500 ${Math.round(bodySize)}px 'Roboto Serif', 'Poppins', serif`;
  const bodyLines = body ? wrapPlainLines(body, maxWidth, STORY.maxBodyLines) : [];

  /* Measured, not assumed. The heading used to be one line by fiat — the text
     was flattened and drawn as a single run, so anything longer than the
     column simply ran off the right edge of the card. It wraps now, which
     means its height is a count of lines rather than one fontSize. */
  const headingLines = storyHeadingLayout(storyHeadingText(), maxWidth, headingSize);
  const headingHeight = headingLines.length
    ? headingLines.length * headingLine + STORY.gapAfterHeading * s
    : 0;
  const bodyHeight = bodyLines.length * bodyLine;
  const stampHeight = state.showTimestamp ? bodyLine * 0.9 : 0;
  const blockHeight = headingHeight + bodyHeight + stampHeight;
  const top = H - STORY.bottomPadding * (H / 1700) - blockHeight;

  /* Measured BEFORE the fade is painted, because the fade is anchored to the
     top of this block — the same way the headline page anchors to its first
     line. The fade used to be painted first, which is exactly why it could
     only ever be a fixed wash over the whole frame: at that point nothing
     here knew where the copy was going to land. */
  paintMistGlass(ctx, {
    width: W,
    height: H,
    copyTop: top,
    opacity: clamp(numberOr(state.storyOverlayOpacity, 100) / 100, 0, 1),
    image,
    cacheKey: glassCacheKey(image, "story"),
  });
  paintBottomFade(ctx, {
    width: W,
    height: H,
    copyTop: top,
    fadeHeight: L.gradient.fadeHeight,
    // The story page's own overlay control still rides on top of the shape.
    opacity: clamp(numberOr(state.storyOverlayOpacity, 100) / 100, 0, 1),
  });

  drawFixedLogos();

  let y = top;
  if (headingLines.length) {
    y = drawStoryHeading(headingLines, left, y, headingSize, headingLine, s) + STORY.gapAfterHeading * s;
  }

  ctx.save();
  ctx.font = `500 ${Math.round(bodySize)}px 'Roboto Serif', 'Poppins', serif`;
  // Solid white at 80%, per the spec — not a lighter grey, which would shift
  // with whatever is behind it instead of staying a fixed step below the
  // heading's pure white.
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 12 * s;
  ctx.shadowOffsetY = 3 * s;
  bodyLines.forEach((line, i) => ctx.fillText(line, left, y + i * bodyLine));
  ctx.restore();

  if (state.showTimestamp) drawTimestamp(left, y + bodyHeight + bodyLine * 0.16, s);

  if (!state.isDownloading) {
    drawEngagementBar();
    drawNavBar();
  }

  ctx.restore();
}

/* Plain greedy wrap against the CURRENT ctx.font. Deliberately not
   drawWrappedPreviewText: that one auto-shrinks to fit a box and understands
   bullets, neither of which a story body wants — the copy is short and the
   size should be the same on every slide of a set. */
function wrapPlainLines(text, maxWidth, maxLines) {
  const lines = [];

  /* The writer's own line breaks come first, and each block is wrapped to the
     column after that. One greedy pass over `\s+`-collapsed text — which is
     what this used to be — threw every deliberate break away, so a typed list
     came out as a single run-on line and pressing Enter appeared to do
     nothing at all. A break is a break; only runs of spaces and tabs inside a
     line are worth collapsing. */
  const blocks = String(text).replace(/\r\n?/g, "\n").split("\n");

  for (const block of blocks) {
    const trimmed = block.replace(/[ \t]+/g, " ").trim();
    if (!trimmed) {
      lines.push("");             // a blank line the writer left stays blank
      continue;
    }
    let line = "";
    for (const word of trimmed.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }

      /* A single word wider than the column — a pasted URL, nearly always.
         Letting it through whole (which is what an `|| !line` escape does)
         put it half outside the frame with the tail simply gone. Break it at
         the column edge instead: a URL split across two lines still reads,
         one that walks off the canvas does not. */
      let rest = word;
      while (ctx.measureText(rest).width > maxWidth) {
        let cut = 1;
        while (cut < rest.length && ctx.measureText(rest.slice(0, cut + 1)).width <= maxWidth) cut++;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }

  /* Trailing blanks are just the cursor resting on a new row. Counting them
     would spend the line budget on nothing and, since the block is laid out
     bottom-up, shove the copy upward as you type. */
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s.,;:]+$/, "")}…`;
  }
  return lines;
}

/**
 * Creation timestamp under the slide-2 paragraph — "07 Aug | 12:30 PM".
 *
 * Left edge aligns with the paragraph (same textX) so the two form one
 * block rather than two loosely stacked things. Sits one paragraph-line
 * below the last line of copy.
 *
 * Spec was Poppins / 70% opacity / 10px. The 10 is a Figma-frame value and
 * frames differ in width, so it is expressed here relative to the 39px
 * paragraph and scaled with the canvas — that keeps the proportion in the
 * reference at every aspect ratio. TIMESTAMP_SIZE is the one number to
 * change if it should read larger or smaller.
 */
const TIMESTAMP_SIZE = 21;      // design px, against a 39px paragraph
const TIMESTAMP_OPACITY = 0.82;
const TIMESTAMP_COLOR = "#ffffff";

/**
 * Date only — "07 Aug". No time.
 *
 * toLocaleDateString with no `timeZone` option resolves in the runtime's own
 * zone, which is the browser's, which follows the operating system. So the
 * date is whatever the person looking at the screen would call today, with
 * no conversion and nothing to configure.
 *
 * This matters more than it looks: a UTC-based date is wrong for a third of
 * every day in IST (UTC+5:30) — anything created before 05:30 local would
 * carry yesterday's date.
 */
function formatCreatedAt(date) {
  // Reads the clock at paint time. This used to render a Date frozen when the
  // page loaded, which is wrong for the way the app is actually used: the tab
  // stays open for days, so the stamp would sit on yesterday's date — or last
  // week's — without anyone noticing.
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/**
 * Place the stamp directly beneath the poster headline.
 *
 * The headline is bottom-anchored and its block height changes with the line
 * count, so the position is derived from the cached layout rather than a
 * fixed y — otherwise a two-line headline would leave a gap and a four-line
 * one would collide.
 */
function drawHeadlineTimestamp() {
  if (!state.showTimestamp) return;
  const L = getLayout();
  const cached = state._render || computeHeadlineLayoutAndTop();
  const s = Math.min(canvas.width / 920, canvas.height / 1700);
  // Sit just under the last headline line, left edge shared with it.
  const y = cached.top + cached.blockHeight + Math.round(14 * s);
  drawTimestamp(L.headline.x, y, s);
}

function drawTimestamp(x, y, s) {
  if (!state.showTimestamp) return;
  ctx.save();
  ctx.globalAlpha = TIMESTAMP_OPACITY;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // Keep the complete date, including the month, firmly legible at export
  // size while reusing the same Poppins face as the paragraph copy.
  ctx.font = `700 ${Math.round(TIMESTAMP_SIZE * s)}px ${PREVIEW_TEXT_FONT}`;
  // A soft shadow only — at 70% over a blurred photo the glyphs would
  // otherwise disappear against light areas.
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 2 * s;
  ctx.fillStyle = TIMESTAMP_COLOR;
  ctx.fillText(formatCreatedAt(state.createdAt), x, y);
  ctx.restore();
}

/* ── The "Get latest updates on DailyMattr" footer ──
   4:5 Feed posters only, and only on the poster itself (page 1) — never the X
   card, the text/story/video slides or the other ratios. The headline is
   lifted by `headlineLift` so the copy, the date and the footer stack without
   overlapping; everything below is in 1080×1350 design px. */
const POSTER_FOOTER = {
  headlineLift: 80,    // added to the 4:5 headline bottomPadding (110 → 190)
  sideMargin: 56,
  ruleFromBottom: 118, // the divider line above the row
  rowCenterFromBottom: 68,
  textSize: 27,
  logoHeight: 40,
  // Where the wordmark's letters sit inside logo.svg, as a fraction of its
  // height (y≈23.4 of the 32-unit viewBox). Used to put the logo on the
  // same baseline as the lead text.
  logoBaseline: 23.4 / 32,
  badgeHeight: 62,
  badgeGap: 12,
};

function hasPosterFooter() {
  return state.aspectRatio === "4:5" && state.previewMode === "pix" && !isXRenderMode();
}

function drawPosterFooter() {
  if (!hasPosterFooter()) return;
  const F = POSTER_FOOTER;
  const W = canvas.width;
  const H = canvas.height;
  const left = F.sideMargin;
  const right = W - F.sideMargin;
  const ruleY = H - F.ruleFromBottom;
  const cy = H - F.rowCenterFromBottom;

  ctx.save();

  // Deepen the bottom so the row reads on any photo.
  const shade = ctx.createLinearGradient(0, ruleY - 80, 0, H);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(0.45, "rgba(0,0,0,0.55)");
  shade.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, ruleY - 80, W, H - (ruleY - 80));

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(left, ruleY - 1, right - left, 2);

  // Left: lead text + wordmark, sharing one baseline. The baseline is placed
  // so the text's cap height is centred on the row.
  ctx.font = `600 ${F.textSize}px ${PREVIEW_TEXT_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  const baseline = cy + Math.round(F.textSize * 0.36);
  const lead = "Get latest updates on";
  ctx.fillText(lead, left, baseline);
  let leftEnd = left + ctx.measureText(lead).width;
  const logo = footerImages.logo;
  if (logo) {
    const lw = (logo.naturalWidth || 156) / (logo.naturalHeight || 32) * F.logoHeight;
    const lx = leftEnd + 10;
    ctx.drawImage(logo, lx, baseline - F.logoBaseline * F.logoHeight, lw, F.logoHeight);
    leftEnd = lx + lw;
  } else {
    ctx.fillStyle = "#ffffff";
    const lx = leftEnd + 10;
    ctx.fillText("daily mattr", lx, baseline);
    leftEnd = lx + ctx.measureText("daily mattr").width;
  }

  // Right: the two store badges, right-aligned
  const apple = drawStoreBadge(right, cy, footerImages.apple, "Download on the", "App Store");
  const google = drawStoreBadge(apple - F.badgeGap, cy, footerImages.play, "GET IT ON", "Google Play");

  // Vertical divider centred in the gap between the two groups
  const dx = Math.round((leftEnd + google) / 2);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(dx - 1, cy - F.badgeHeight / 2 + 4, 2, F.badgeHeight - 8);

  ctx.restore();
}

/* One store badge whose RIGHT edge sits at `rightX`. Returns its left edge. */
function drawStoreBadge(rightX, cy, icon, small, big) {
  const h = POSTER_FOOTER.badgeHeight;
  const padX = 16;
  const iconSize = 34;
  const smallFont = `500 13px ${PREVIEW_TEXT_FONT}`;
  const bigFont = `500 25px ${PREVIEW_TEXT_FONT}`;
  ctx.font = smallFont;
  const smallW = ctx.measureText(small).width;
  ctx.font = bigFont;
  const bigW = ctx.measureText(big).width;
  const w = padX + iconSize + 10 + Math.max(smallW, bigW) + padX;
  const x = rightX - w;
  const y = cy - h / 2;

  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 10);
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = "#000000";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.stroke();

  if (icon) {
    const iw = (icon.naturalWidth || 1) / (icon.naturalHeight || 1) * iconSize;
    const ih = iconSize;
    const fitW = Math.min(iw, iconSize);
    const fitH = fitW === iw ? ih : ih * (iconSize / iw);
    ctx.drawImage(icon, x + padX + (iconSize - fitW) / 2, cy - fitH / 2, fitW, fitH);
  }

  const tx = x + padX + iconSize + 10;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = smallFont;
  ctx.fillText(small, tx, cy - 6);
  ctx.font = bigFont;
  ctx.fillText(big, tx, cy + 20);
  ctx.restore();
  return x;
}

/* `filter` defaults to the Text slide's treatment: heavily blurred and dimmed,
   because there the picture is a backdrop for a wall of copy and has to stay
   out of its way. A story slide is the opposite — the photo is the point, and
   the gradient alone keeps the lower copy legible — so it passes "none" and
   gets the image sharp. */
/* ── The static layers, painted once per picture rather than once per frame ──

   Of the three layers below, the first two do not move: the cover-scaled
   backdrop and the un-panned copy are functions of the picture, the frame and
   the zoom, and nothing the writer does between two keystrokes — or between
   two frames of a drag — changes them. They were being blurred at 26px and
   18px over the whole card on every repaint anyway, and a blur over 920x1700
   is the single most expensive thing this renderer does.

   So they are painted into a canvas the size of the card and that canvas is
   blitted back until any of their inputs changes. The pan lives in the third
   layer only, so a drag rebuilds nothing.

   Bypassed under a scaled context (the 4x export), where the layer would be
   the wrong resolution — the export paints directly, as it always did. */
const backdropCache = new Map();
const BACKDROP_CACHE_MAX = 6;

/* ── The Text slide's blur, computed here rather than asked of the browser ──

   It used to be ctx.filter = "blur(39px)", and that is a request the browser
   is free to ignore: Safari has no canvas filters at all, and a browser that
   drops one does so silently, with no error and no sign in the preview a
   reviewer is looking at on another machine. Posts reached DailyMattr with
   the Text slide's photograph completely sharp while Pix showed it frosted.

   So the blur is done in JS on pixels. It is cheap because a blur this heavy
   has no detail left to keep: the frame is drawn into a small canvas sized so
   the radius there is SOFT_SIGMA_SMALL pixels, blurred there with three box
   passes (a close Gaussian), and scaled back up. The small canvas depends only
   on the design, never on the output size, so the preview and every export
   rung are built from the same pixels and cannot disagree. */
const SOFT_SIGMA_SMALL = 8;
const softBackdropCache = new Map();

function boxSizesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl -= 1;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wl + 2));
}

// One running-sum box pass along rows or columns, edges clamped so the frame's
// border is not darkened by sampling the nothing beyond it.
function boxBlurPass(src, dst, w, h, r, horizontal) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;
  const inv = 1 / (2 * r + 1);
  const last = len - 1;
  for (let l = 0; l < lines; l += 1) {
    const base = l * lineStep;
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += src[base + Math.min(last, Math.max(0, k)) * step + c];
      for (let i = 0; i < len; i += 1) {
        dst[base + i * step + c] = sum * inv;
        sum += src[base + Math.min(last, i + r + 1) * step + c] - src[base + Math.max(0, i - r) * step + c];
      }
    }
  }
}

function gaussianBlurPixels(data, w, h, sigma) {
  if (!(sigma > 0.3)) return;
  let a = Float32Array.from(data);
  let b = new Float32Array(data.length);
  for (const size of boxSizesForGauss(sigma)) {
    const r = (size - 1) / 2;
    boxBlurPass(a, b, w, h, r, true);
    boxBlurPass(b, a, w, h, r, false);
  }
  data.set(a);
}
let imageUidSeq = 0;

function imageUid(image) {
  if (!image) return "none";
  if (!image.__uid) image.__uid = ++imageUidSeq;
  return image.__uid;
}

function cacheKeep(map, max, key, value) {
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

function drawTextPreviewBackgroundImage(image, x, y, width, height, offset, zoom, scale = 1, filter) {
  const bleed = 34 * scale;
  const drawX = x - bleed;
  const drawY = y - bleed;
  const drawW = width + bleed * 2;
  const drawH = height + bleed * 2;
  const baseScale = Math.max(drawW / image.width, drawH / image.height);
  const imageScale = baseScale * (zoom || 1) * IMAGE_PAN_HEADROOM;
  const drawWidth = image.width * imageScale;
  const drawHeight = image.height * imageScale;
  const focal = image.__focalPoint || { x: image.width / 2, y: image.height / 2 };

  const sharpFilter = filter || `blur(${Math.round(18 * scale)}px) brightness(62%) contrast(108%) saturate(72%)`;

  // A plain blur — the Text slide — is computed, not requested; see
  // softBackdropCache above.
  const blurOnly = /^\s*blur\(\s*([\d.]+)px\s*\)\s*$/.exec(sharpFilter);
  if (blurOnly && Number(blurOnly[1]) > 0) {
    const sigma = Number(blurOnly[1]);
    const f = Math.min(1, SOFT_SIGMA_SMALL / sigma);
    const off = offset || { x: 0, y: 0 };
    const key = [imageUid(image), focal.x, focal.y, off.x, off.y, x, y, width, height,
      zoom || 1, scale, sigma].join("|");
    let soft = softBackdropCache.get(key);
    if (!soft) {
      soft = document.createElement("canvas");
      soft.width = Math.max(2, Math.round(width * f));
      soft.height = Math.max(2, Math.round(height * f));
      const g = soft.getContext("2d", { willReadFrequently: true });
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.setTransform(soft.width / width, 0, 0, soft.height / height, -x * soft.width / width, -y * soft.height / height);
      g.fillStyle = "#070707";
      g.fillRect(x, y, width, height);
      // The backdrop's dimming as a fill rather than a filter, for the same
      // reason the blur is not one: it must not depend on filter support.
      drawLayer(baseScale * IMAGE_PAN_HEADROOM, null, g);
      g.fillStyle = "rgba(0, 0, 0, 0.48)";
      g.fillRect(x, y, width, height);
      drawLayer(imageScale, off, g);
      const px = g.getImageData(0, 0, soft.width, soft.height);
      gaussianBlurPixels(px.data, soft.width, soft.height, sigma * (soft.width / width));
      g.putImageData(px, 0, 0);
      cacheKeep(softBackdropCache, BACKDROP_CACHE_MAX, key, soft);
    }
    ctx.save();
    ctx.filter = "none";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(soft, x, y, width, height);
    ctx.restore();
    return;
  }

  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const unscaled = !m || (m.a === 1 && m.d === 1 && m.b === 0 && m.c === 0 && m.e === 0 && m.f === 0);
  const cacheKey = unscaled && ctx.canvas
    ? [imageUid(image), focal.x, focal.y, x, y, width, height, zoom || 1, scale, sharpFilter,
       ctx.canvas.width, ctx.canvas.height].join("|")
    : null;

  ctx.save();

  /* ── The backdrop, which is what stops a zoomed-out photo ending in a line ──

     The zoom slider runs down to 10% while IMAGE_PAN_HEADROOM is 1.1, so below
     about 87% the picture no longer reaches the edges of the frame. The clamp
     below cannot save it: with the image smaller than the frame the minimum
     runs past the maximum, and clamp() collapses to the maximum, pinning the
     picture to the top-left. Everything under it was the flat #070707 the page
     starts with — a hard horizontal edge across the card, which is exactly the
     line that kept being reported and kept not being the gradient.

     This layer is drawn at COVER scale with no zoom and no offset applied, so
     it always reaches every edge whatever the sliders say. It is blurred and
     dimmed because it is scenery, not the subject. Above about 87% zoom the
     sharp layer covers it completely and it makes no difference to anything —
     it only becomes visible at the point where the alternative was a black
     band. */
  const backdropScale = baseScale * IMAGE_PAN_HEADROOM;
  const paintStaticLayers = () => {
    ctx.filter = deviceFilter(`blur(${Math.round(26 * scale)}px) brightness(52%) saturate(78%)`);
    drawLayer(backdropScale, null);
    ctx.filter = deviceFilter(sharpFilter);
    drawLayer(imageScale, null);
  };

  if (cacheKey) {
    let layer = backdropCache.get(cacheKey);
    if (!layer) {
      layer = document.createElement("canvas");
      layer.width = ctx.canvas.width;
      layer.height = ctx.canvas.height;
      // drawLayer paints through the module-level ctx, so it is pointed at the
      // cache canvas for the duration — the same swap paintCardInto does.
      const prev = ctx;
      ctx = layer.getContext("2d");
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        paintStaticLayers();
      } finally {
        ctx = prev;
      }
      cacheKeep(backdropCache, BACKDROP_CACHE_MAX, cacheKey, layer);
    }
    ctx.filter = "none";
    ctx.drawImage(layer, 0, 0);
  } else {
    paintStaticLayers();
  }

  ctx.filter = deviceFilter(sharpFilter);
  drawLayer(imageScale, offset);
  ctx.restore();

  function drawLayer(layerScale, layerOffset, target = ctx) {
    const w = image.width * layerScale;
    const h = image.height * layerScale;
    let dx = drawX + drawW / 2 - focal.x * layerScale;
    let dy = drawY + drawH / 2 - focal.y * layerScale;

    if (layerOffset) {
      dx += layerOffset.x;
      dy += layerOffset.y;
    }

    /* Only worth clamping while the image is bigger than the frame — that is
       what the clamp is for, keeping a pan from dragging an edge into view.
       Below that it has no meaning, and applying it anyway is what jammed a
       small picture into the corner instead of leaving it centred. */
    if (w >= drawW) dx = clamp(dx, drawX + drawW - w, drawX);
    if (h >= drawH) dy = clamp(dy, drawY + drawH - h, drawY);
    target.drawImage(image, dx, dy, w, h);
  }
}

function drawTextPreviewLogo(x, y, size) {
  const logo = state.logoImage || state.shortlyLogoImage;
  if (!logo) return;

  const rawW = logo.naturalWidth || logo.width || 1;
  const rawH = logo.naturalHeight || logo.height || 1;
  const scale = size / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;
  drawLogoAt(logo, x, y, drawW, drawH);
}

function drawPixStatusBar(scaleX, scaleY, s) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(29 * s)}px 'Inter', 'Segoe UI', Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("9:41", 104 * scaleX, 45 * scaleY);

  const right = canvas.width - 72 * scaleX;
  const y = 45 * scaleY;

  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 4 * s;
  for (let i = 0; i < 4; i += 1) {
    const h = (9 + i * 6) * s;
    ctx.fillRect(right - 140 * scaleX + i * 14 * scaleX, y + 17 * scaleY - h, 7 * scaleX, h);
  }

  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 6 * scaleY, 30 * s, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 6 * scaleY, 18 * s, Math.PI * 1.18, Math.PI * 1.82);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(right - 70 * scaleX, y + 8 * scaleY, 4 * s, 0, Math.PI * 2);
  ctx.fill();

  const bx = right - 18 * scaleX;
  const by = y - 14 * scaleY;
  const bw = 52 * scaleX;
  const bh = 25 * scaleY;
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 6 * s);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx + bw + 4 * scaleX, by + 8 * scaleY, 4 * scaleX, 9 * scaleY);
  ctx.beginPath();
  ctx.roundRect(bx + 5 * scaleX, by + 5 * scaleY, bw - 10 * scaleX, bh - 10 * scaleY, 4 * s);
  ctx.fill();
  ctx.restore();
}

/* Where the text page's copy lands, worked out without drawing it.

   Split from the drawing for the same reason the story page measures its block
   first: the glass and the fade are anchored to the top of the copy, so the
   treatment underneath cannot be painted until the copy's position is known.
   Painting first is exactly what forced this page to use a fixed full-frame
   wash — at that point nothing here knew where the words were going to sit. */
function layoutWrappedPreviewText(text, minY, maxWidth, maxY, fontSize, lineHeight) {
  const preserveOpenBullet = !state.isDownloading && state.previewMode === "text";
  const fit = fitPreviewTextLines(text, maxWidth, minY, maxY, fontSize, lineHeight, { preserveOpenBullet });
  const { lines, visibleLines } = fit;
  const overflowed = lines.length > visibleLines.length;
  let ellipsisIndex = -1;
  if (overflowed) {
    ellipsisIndex = visibleLines.length - 1;
    while (ellipsisIndex > 0 && !visibleLines[ellipsisIndex]) ellipsisIndex -= 1;
    visibleLines[ellipsisIndex] = `${visibleLines[ellipsisIndex]}...`;
  }

  ctx.save();
  ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(fit.fontSize)}px ${PREVIEW_TEXT_FONT}`;
  const visibleHeight = visibleLines.reduce((sum, line) => sum + getPreviewTextStep(line, fit.lineHeight), 0);
  ctx.restore();
  const startY = Math.max(minY, maxY - Math.max(0, visibleHeight - fit.lineHeight));
  return { fit, visibleLines, ellipsisIndex, startY };
}

function drawWrappedPreviewTextLayout(layout, x, maxWidth) {
  const { fit, visibleLines, ellipsisIndex, startY } = layout;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;
  ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(fit.fontSize)}px ${PREVIEW_TEXT_FONT}`;
  let cy = startY;
  visibleLines.forEach((visibleLine, index) => {
    if (visibleLine) {
      if (index === ellipsisIndex) {
        drawEllipsizedLine(visibleLine, x, cy, maxWidth);
      } else {
        ctx.fillText(visibleLine, x, cy);
      }
    }
    cy += getPreviewTextStep(visibleLine, fit.lineHeight);
  });
  ctx.restore();
}

function drawWrappedPreviewText(text, x, minY, maxWidth, maxY, fontSize, lineHeight) {
  drawWrappedPreviewTextLayout(
    layoutWrappedPreviewText(text, minY, maxWidth, maxY, fontSize, lineHeight), x, maxWidth);
}

function fitPreviewTextLines(text, maxWidth, minY, maxY, fontSize, lineHeight, options = {}) {
  const canShrink = state.previewMode === "text";
  const scales = canShrink ? [1, 0.92, 0.84, 0.76, 0.68, 0.62] : [1];
  let bestFit = null;

  for (const scale of scales) {
    const nextFontSize = Math.max(fontSize * scale, fontSize * 0.62);
    const nextLineHeight = Math.max(nextFontSize * 1.34, lineHeight * scale);
    ctx.font = `${PREVIEW_TEXT_WEIGHT} ${Math.round(nextFontSize)}px ${PREVIEW_TEXT_FONT}`;
    const lines = buildPreviewTextLines(text, maxWidth, options);
    const maxBlockHeight = Math.max(nextLineHeight, maxY - minY + nextLineHeight);
    const visibleLines = getVisiblePreviewLines(lines, nextLineHeight, maxBlockHeight);
    const fit = { fontSize: nextFontSize, lineHeight: nextLineHeight, lines, visibleLines };
    bestFit = fit;
    if (visibleLines.length === lines.length) return fit;
  }

  return bestFit;
}

function getVisiblePreviewLines(lines, lineHeight, maxBlockHeight) {
  const visibleLines = [];
  let blockHeight = 0;
  for (const line of lines) {
    const step = getPreviewTextStep(line, lineHeight);
    if (visibleLines.length && blockHeight + step > maxBlockHeight) break;
    visibleLines.push(line);
    blockHeight += step;
  }
  return visibleLines.length ? visibleLines : [lines[0] || ""];
}

function getPreviewTextStep(line, lineHeight) {
  return line ? lineHeight : lineHeight * (state.previewMode === "text" ? 0.28 : 0.42);
}

function buildPreviewTextLines(text, maxWidth, options = {}) {
  const sourceLines = limitDetailTextClient(text, options).split("\n");
  const lines = [];
  sourceLines.forEach((sourceLine) => {
    const trimmed = sourceLine.trim();
    if (!trimmed) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      return;
    }

    const lineText = /^[\u2022*-]\s+/.test(trimmed) ? `\u2022 ${trimmed.replace(/^[\u2022*-]\s+/, "")}` : trimmed;
    lines.push(...wrapPreviewTextLine(lineText, maxWidth));
  });

  return lines.length ? lines : [""];
}

function wrapPreviewTextLine(text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(test).width <= maxWidth) {
      line = test;
      return;
    }

    lines.push(line);
    line = word;
  });

  if (line) lines.push(line);
  return lines;
}

function drawEllipsizedLine(line, x, y, maxWidth) {
  let output = line.endsWith("...") ? line : `${line}...`;
  while (output.length > 4 && ctx.measureText(output).width > maxWidth) {
    output = `${output.slice(0, -4).trimEnd()}...`;
  }
  ctx.fillText(output, x, y);
}

function drawPixPageDots(cx, cy, s) {
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
  ctx.beginPath();
  ctx.arc(cx - 11 * s, cy, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx + 11 * s, cy, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBackground() {
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const glow = ctx.createRadialGradient(110, 90, 0, 110, 90, 350);
  glow.addColorStop(0, "rgba(139, 92, 246, 0.24)");
  glow.addColorStop(1, "rgba(139, 92, 246, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/* ── The bottom fade, drawn the same way on every page that carries copy ──

   One continuous rise: transparent above the words, dark enough at the first
   line to keep them readable while some photograph still shows through, then
   progressively darker to solid black at the foot of the frame.

   It is anchored to `copyTop` rather than to the frame, which is what makes a
   set of slides look like a set: the fade follows the copy up when there are
   more lines and down when there are fewer, so the picture gives way to ink at
   the same distance above the text every time.

   Shared because the two pages had drifted apart. The headline page had this
   curve; the story page had a flat wash over the WHOLE frame — a 12% veil
   across the top, so its photograph never showed clean, and a jump from 0.30
   to 0.86 across sixteen percent of the height that read as a band rather
   than a fade. Same picture, two different treatments, depending only on
   which slide you were looking at.

   `opacity` scales the whole curve, for the story page's overlay control. It
   multiplies rather than replaces, so the shape survives at every setting. */
/* ── Frosted glass under the copy ────────────────────────────────────────────

   The fade darkens the picture; this softens it. Together they are what makes
   text sitting on a photograph look deliberate rather than dropped on top —
   the eye stops reading detail exactly where it starts reading words.

   Blur alone would be worse than nothing, because a blurred band has edges. So
   it is masked with the same shape the fade uses: nothing at the top, full
   blur by the copy line, which means there is no boundary anywhere for the eye
   to catch. Same anchor, same reach, so the two effects move together when the
   copy moves.

   The whole frame is blurred and then masked, rather than blurring just the
   band. Blurring a band samples the transparent nothing beyond its edges and
   comes back with a dark rim along them; blurring the full canvas means every
   sample has real pixels under it and the mask decides what survives. */
/* Matched to the fade's own reach so the two cannot drift apart, and scaled
   off the frame so a 1080-wide export is blurred by the same amount a 920
   preview is rather than a fifth less. */
/* Against the 1700px reference frame, so a 1080-wide export is treated the
   same amount a 920 preview is rather than a fifth less. */

/* Smoked glass, which is not the same thing as more blur.

   Blur alone only makes a photograph soft; the picture is still fully there,
   still as colourful and as contrasty, just out of focus. Smoked glass reads
   the way it does because it takes the LIFE out of what is behind it — colour
   drains, darks and lights pull toward each other — and a little softening
   comes along with that rather than being the whole effect.

   So the blur drops and these do the work instead. Saturation first, because
   that is what separates smoke from fog: fog is white and hides things,
   smoke is grey and drains them. */

/* How far above the first line any of this reaches, as a multiple of the
   layout's fadeHeight.

   It was 1.6, chosen when the fade was the only effect and had to do all the
   work of separating copy from picture — which meant starting at 40% of the
   frame and darkening a third of the photograph to get there. The blur does
   that work now, and does it better, so the colour no longer needs the runway:
   at 0.6 it begins just above the copy, around 59%, and the picture above is
   left alone. */
/* 2.0, from the gradient spec. Measured off the mock, its stops run from 21%
   of the card down to 61%, completing at the first line — about 680px on a
   1700px frame, against the 198px this used to run in. The shape below only
   reads as that shape if it is given that distance. */
const FADE_STRETCH = 2.0;


function fadeReach(layoutFade) {
  return layoutFade * FADE_STRETCH;
}


/* ── The one darkening profile ───────────────────────────────────────────────

   The shape from the design tool, as three stops: transparent at the top,
   80% at 63% of the way down, solid at the foot.

   It lives out here because BOTH ramps have to follow it. They did not, and
   that is the whole of what "not at all smooth" was: the fade ran this curve
   over 660px while the glass ran a smoothstep over 123px inside it, so the
   card darkened gently, then fell off a 123px cliff, then sat flat. Two
   profiles disagreeing in the same band cannot be tuned into one — the
   steeper one is what the eye finds, whatever the other is doing.

   Linear between stops, which is what a gradient tool does; the callers
   sample it densely enough that the joins do not read as slope changes. */
const SPEC_STOPS = [
  [0, 0],
  [0.63, 0.8],
  [1, 1],
];

function specAlpha(t) {
  for (let k = 1; k < SPEC_STOPS.length; k++) {
    const [p0, a0] = SPEC_STOPS[k - 1];
    const [p1, a1] = SPEC_STOPS[k];
    if (t <= p1) return a0 + ((a1 - a0) * (t - p0)) / (p1 - p0);
  }
  return 1;
}

/* ── The onset, eased ────────────────────────────────────────────────────────

   specAlpha is the design's profile exactly, and the design's profile is
   piecewise linear: it goes from not climbing at all to climbing at its full
   rate over no distance whatsoever. A step in SLOPE is what the eye is
   actually good at - it is why a gradient built from a handful of stops shows
   a line at every join though its values are continuous - and this one would
   sit at the top of the band, which is exactly where a line was reported in
   this treatment before.

   The obvious fix is to multiply the curve by a smoothstep over its first
   stretch. That was tried and measured on the rendered card and it is worse
   than it looks: multiplying a ramp by a curve that reaches 1 means the
   product's slope reaches 1.69x the ramp's own, so easing the onset bought a
   68% steeper patch a fifth of the way down. Measured 0.28 levels per pixel
   against an average of 0.13.

   So the window is applied to the SLOPE and the result renormalised. The
   curve accelerates from a standstill, never climbs faster than it has to,
   and still lands at 1 - the design's shape with its first corner rounded off
   rather than its middle steepened. Peak comes down to about 1.43x average.

   Built once into a table because it is an integral, and read from a loop
   that runs per strip per render. */
const RAMP_ONSET = 0.18;

/* The same window at the OTHER end, and its absence was a visible edge.

   The onset above rounds off the start: the curve accelerates from a
   standstill instead of leaving the line at full pace. Nothing did that at the
   finish, so the ramp arrived at 1 still climbing and was then held flat by
   the clamp — a slope that goes from its full value to zero in one row, across
   the whole width of the card, at a fixed height. That is a crease, and it is
   the "hard stop" that gets reported: not the blur radius stepping, and not
   the value jumping (the value is continuous), but its FIRST DERIVATIVE.

   The eye resolves a change in slope far more readily than a change in value
   — the same Mach-banding fact this file already leans on for the gradient
   sample count. A ramp can be perfectly smooth everywhere and still show the
   one place it stops being a ramp.

   Symmetric with the onset because there is no reason for it not to be, and
   the renormalisation below keeps the curve landing at exactly 1 either way. */
const RAMP_TAPER = 0.18;

const RAMP_SAMPLES_LUT = 512;

const RAMP_TABLE = (() => {
  const n = RAMP_SAMPLES_LUT;
  const out = new Float64Array(n + 1);
  const step = 1 / n;
  let acc = 0;
  for (let i = 1; i <= n; i++) {
    const t = i * step;
    // The design's own rate of climb at this depth, differenced off its stops.
    const slope = (specAlpha(t) - specAlpha(t - step)) / step;
    // ...ramped in from zero over the first RAMP_ONSET of the band, and back
    // down to zero over the last RAMP_TAPER, so the curve arrives at 1 having
    // already stopped climbing rather than being stopped by the clamp.
    acc += slope * Math.min(1, t / RAMP_ONSET) * Math.min(1, (1 - t) / RAMP_TAPER);
    out[i] = acc;
  }
  if (acc > 0) for (let i = 0; i <= n; i++) out[i] /= acc;
  return out;
})();

function rampAlpha(t) {
  const n = RAMP_SAMPLES_LUT;
  const x = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return RAMP_TABLE[i] + (RAMP_TABLE[i + 1] - RAMP_TABLE[i]) * (x - i);
}


/* The panel colour: #17130F — HSB(33, 35, 9) — laid at 85%.

   Fixed, not read from the photograph. Reading it per picture was tried and
   half worked: a warm pitch gave hue 33, a blue valley 215. What killed it was
   a press photograph of a man in a navy suit in front of a US flag coming back
   RED, hue 359 — the hue is picked by chroma weight and a saturated flag
   outvotes a large area of dark navy, so the panel took its colour from the
   backdrop while the subject was a different colour entirely. A newsroom has a
   lot of those.

   Fixing it costs almost nothing, because at saturation 35 and brightness 9
   under an 85% fill every hue is nearly the same near-black: the difference
   between 33 and 196 is a lean you have to look for. The per-image hue was
   buying very little and risking a card tinted by a flag. */
/* Kept for the panel alone. The per-image hue machinery this used to serve
   was removed with the fade's tint; the panel still wants to be expressed as
   a hue with a fixed saturation and brightness rather than as a magic hex,
   because that is the rule the design is written to. */
function hsbToRgb(h, s, b) {
  const c = b * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = b - c;
  const [r, g, bl] =
    h <  60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((bl + m) * 255),
  };
}

/* ── The photograph's dominant hue ──────────────────────────────────────
   Only the HUE. Saturation, brightness and the fill's 85% are fixed by the
   design and never come from the picture: inherit those and a washed-out
   photo gives a washed-out panel while a neon one gives a luminous one, and
   the panel stops being the same panel. Fixing S and B is what lets every
   card behave identically while still being its own colour.

   Found on a 64px thumbnail, hues histogrammed into 24 buckets weighted by
   chroma and by brightness, so a large flat wash of pale sky counts for less
   than a smaller area of strong colour. Near-grey and near-black pixels are
   skipped rather than down-weighted — arithmetically they have a hue, but it
   is meaningless and one bit of sensor noise swings it across the wheel, so
   they must not accumulate into a majority by sheer count.

   The winning bucket is refined to the CIRCULAR mean of the pixels in it.
   Circular because hue wraps: averaging 359 and 1 the arithmetic way gives
   180, which is cyan — the exact opposite of the red they are.

   Cached on the image beside its focal point. renderPoster runs on every
   drag, and this would otherwise be the most expensive thing in the loop for
   a value that cannot change. */
function imageHue(image) {
  if (!image) return null;
  if (image.__panelHue !== undefined) return image.__panelHue;

  let hue = null;
  try {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (w && h) {
      const scale = Math.min(1, 64 / Math.max(w, h));
      const sw = Math.max(1, Math.round(w * scale));
      const sh = Math.max(1, Math.round(h * scale));
      const off = document.createElement("canvas");
      off.width = sw;
      off.height = sh;
      const octx = off.getContext("2d", { willReadFrequently: true });
      octx.drawImage(image, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh).data;

      const BUCKETS = 24;                       // 15 degrees each
      const weight = new Float64Array(BUCKETS);
      const sinSum = new Float64Array(BUCKETS);
      const cosSum = new Float64Array(BUCKETS);
      let chromaWeight = 0;
      let counted = 0;

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;        // transparent pixels say nothing
        counted++;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const chroma = max - min;
        if (chroma < 0.09 || max < 0.12) continue;

        let h2;
        if (max === r)      h2 = 60 * (((g - b) / chroma) % 6);
        else if (max === g) h2 = 60 * (((b - r) / chroma) + 2);
        else                h2 = 60 * (((r - g) / chroma) + 4);
        if (h2 < 0) h2 += 360;

        const wgt = chroma * (0.4 + 0.6 * max);
        const bucket = Math.min(BUCKETS - 1, Math.floor(h2 / (360 / BUCKETS)));
        const rad = (h2 * Math.PI) / 180;
        weight[bucket] += wgt;
        sinSum[bucket] += Math.sin(rad) * wgt;
        cosSum[bucket] += Math.cos(rad) * wgt;
        chromaWeight += wgt;
      }

      /* Below this share of coloured pixels the hue is not a fact about the
         picture, it is noise — a black-and-white press photo, a snow scene, a
         document scan. Those keep the design's own hue rather than taking a
         cast from an arithmetic accident. */
      if (counted && chromaWeight / counted >= GLASS.minChroma) {
        let best = 0;
        for (let i = 1; i < BUCKETS; i++) if (weight[i] > weight[best]) best = i;
        if (weight[best] > 0) {
          hue = (Math.atan2(sinSum[best], cosSum[best]) * 180) / Math.PI;
          if (hue < 0) hue += 360;
        }
      }
    }
  } catch (err) {
    /* A cross-origin photograph taints the canvas and getImageData throws.
       That is a normal thing for a scraped picture to be, not an error — the
       panel keeps the design's hue, which is what it had before any of this. */
    hue = null;
  }

  image.__panelHue = hue;
  return hue;
}

/* The panel: the picture's hue at the design's fixed saturation, brightness
   and 85% fill. GLASS.hue is the fallback for a photograph that has no hue
   worth taking, and it is the design's own 196. */
function glassPanelColour(image) {
  const hue = GLASS.hueFromImage ? imageHue(image) : null;
  return hsbToRgb(hue === null || hue === undefined ? GLASS.hue : hue,
                  GLASS.saturation, GLASS.brightness);
}

const GLASS = (window.GLASS = Object.assign({
  on: true,

  /* The panel, to spec: fill #0F1517 at 85% over a 16px background blur.
     #0F1517 is HSB(195, 35, 9), and 35/9/85% are FIXED — only H moves, per
     photograph. That is the whole rule: a warm pitch gives H 33, a blue
     stadium H 215, and every card is otherwise identical, so a set of slides
     reads as one design rather than as a colour effect applied per picture. */
  /* Neutral. The panel was #17130F — hue 33 at saturation 35 — and on a
     photograph with no warm element in it that reads as an unexplained brown
     wash rather than as glass. Saturation 0 makes it a true black tint: the
     hue is kept only so the knob still exists for a deliberate warm or cool
     panel later. Brightness stays at the 9 from the picker. */
  /* 196 is the design's own hue and the fallback for a photograph that has
     none worth taking — greyscale, snow, a document scan, anything
     cross-origin whose pixels cannot be read. */
  hue: 196,
  hueFromImage: true, // marked CHANGE on the picker: H comes from the picture
  /* Below this share of coloured pixels the hue is noise, not a fact about
     the picture, and the panel keeps the design's own 196.

     0.06, not the 0.12 this threshold was born with. That number came from
     the old FADE tint, where the hue was painted at saturation 78 across the
     full height of the card — there, a wrong hue is a colour cast over the
     whole thing and the bar to act on one should be high. Here the hue lands
     at saturation 35 and brightness 9 under an 85% fill, which is a whisper:
     the difference between hue 33 and hue 196 at those values is a couple of
     levels of 255. The cost of a wrong hue collapsed, so the bar came down
     with it.

     What it was rejecting: ordinary muted photographs. A Getty press shot of
     a man in a navy suit measures 0.10, an aerial of a flooded valley 0.08 —
     both plainly coloured, both failing 0.12 and taking the fallback, which
     is the opposite of "use the image's colours". True greyscale, snow and
     document scans measure well under 0.02 and are still rejected. */
  minChroma: 0.06,
  saturation: 0.35,   // FIXED, marked on the picker. Never from the image.
  brightness: 0.09,  // FIXED, marked on the picker. Never from the image.

  /* One colour on every card, rather than the hue read from each photograph.

     Reading it per picture was the original idea and it half worked: a warm
     pitch gave hue 33, a blue valley 215, and the card belonged to its own
     image. What killed it was watching a press photograph of a man in a navy
     suit standing in front of a US flag come back RED — hue 359. The hue is
     picked by chroma weight, and a saturated flag outvotes a large area of
     dark navy, so the panel took its colour from the backdrop while the
     subject of the photograph was a different colour entirely. That is not a
     tuning problem; on any picture where the loudest colour is not the
     subject's, the answer is wrong, and a newsroom has a lot of those.

     What made fixing it cheap is the spec itself. At saturation 35 and
     brightness 9 under an 85% fill, every hue is nearly the same near-black —
     the difference between 33 and 196 is a lean you have to look for. So the
     per-image hue was buying very little and risking a card tinted by a flag.

     The per-image path is gone rather than flagged off: the hue measurement
     it needed went with the fade's own tint, and a flag pointing at deleted
     machinery is worse than no flag. */
  fillAlpha: 0.85,   // FIXED, marked on the picker. The 85% beside the hex.

  /* Blur is quoted in the design's own units — 16 on a 382-wide card — and
     scaled to whatever the poster canvas actually is, so the frost is the
     same thickness relative to the card at any export size. */
  /* 14 on a 382-wide card — 34px on the 920 poster.

     It was 26 (63px) while the ramp was 123px long, which is half a pixel of
     radius gained per pixel descended. Sharpness is the one property of a
     photograph the eye can check without a reference — it knows what a
     building in focus looks like — so a gradient that steep in RADIUS is
     findable even when the alpha under it is perfectly smooth. That is what
     survived every previous round of tuning.

     Over the full-height ramp the same 26 would still work, but the design
     this is matching has no blur in it at all: the transition there is
     carried entirely by the darkening. Halving it keeps the surface reading
     as glass while handing the actual transition back to the gradient, which
     is the part the eye cannot catch. */
  blurAt: 16,

  /* How far the blur LAGS the darkening, as an exponent on the shared ramp.

     1 is the two moving together. It was 2 while the band started 272px above
     the copy: the lag existed to keep the radius climbing BELOW the type, and
     with that much run-up the type sat a third of the way down the band with
     plenty of ramp above it to hold back.

     The run-up is 65 now, so the copy line falls about a tenth of the way into
     the band and almost the whole ramp is already below it - the lag has
     nothing left to protect and only starves the first two lines of the frost
     that was asked for. At 2 the first line measured sigma 1.6; at 1 it is
     9.4, with the steepest climb still landing well below the copy.

     Above 1 holds the frost back towards the foot again. */
  blurCurve: 1,

  /* How many pre-blurred copies of the downscaled band to build.

     The blur is applied in the small canvas's own space and multiplied by the
     upscale on the way out, which is what makes a large radius affordable —
     but it means the radius has to be baked into a copy rather than set per
     strip. Twelve levels across the ramp is about a fifth of a pixel of sigma
     between neighbours on the card; the per-strip version it replaced already
     rounded to a quarter. */
  blurLevels: 12,

  /* How far into the band the blurred picture is fully present, as a fraction.

     Not the same thing as the darkening's ramp, and that is the point. Below
     this the blurred layer is being faded in over the sharp original and the
     eye reads focus from the sharp half; above it there is no sharp copy left
     and the radius can grow as far as it likes without any crossfade to
     notice. 0.35 puts it at about the first line of copy.

     A MULTIPLE of where the copy line falls in the band, not a fraction of
     the band: 1 means fully present exactly when the copy starts, whatever
     runUpAboveCopy is set to.

     1.8 puts it at about the second line, and that is a balance rather than a
     preference. The run-up is 65px, so at 1 the whole sharp-to-frosted
     crossfade is compressed into those 65px: measured on a fine-textured
     source, detail falls from 100% to 7% of clear across them and the worst
     single row carries 5.6% of the total. Stretching it to the second line
     halves that to 3.1% while still leaving only 32% of the detail standing
     where the first line sits — weak enough, under the darkening, not to read
     as a sharp copy.

     Higher is smoother still and walks back towards the superimposed-sharp-
     copy problem this exists to solve: at 2.6 the first line keeps 56% of its
     detail, which is the defect, not a setting. */
  /* Below 1, and it has to be: the copy must sit on FULLY frosted picture.

     This was briefly 1.8, on the reasoning in the paragraph above — stretch
     the crossfade, halve the worst row's share of it. The arithmetic was
     right and the result was wrong, because the paragraph measures the ramp
     and not what the ramp is under. frostReach is a multiple of where the
     copy line falls, so 1.8 puts full presence 184px BELOW the first line and
     leaves the copy itself sitting on 56% frost. Reported immediately, and
     correctly, as the glass having gone.

       0.9  frost full at y=1186, copy at y=1209  ->  100% behind the copy
       1.0  frost full at y=1209, copy at y=1209  ->  100%, with no margin
       1.8  frost full at y=1393, copy at y=1209  ->   56%

     So it goes back to 0.9, and the discontinuity that 1.8 was reaching for
     is fixed where it actually lives: RAMP_TAPER, which stops the ramp
     arriving at full presence still climbing. Stretching a ramp does not
     smooth the corner at the end of it; easing the corner does.

     Live: window.GLASS.frostReach = 1.2 then redraw, for a softer, later
     frost — at the cost of clarity behind the first line. */
  frostReach: 0.9,

  /* How many stops each ramp is described with.

     addColorStop interpolates LINEARLY, so a gradient is a chain of straight
     segments with a slope change at every join, and the eye resolves a change
     in slope far more readily than a change in value. 64 across a 763px band
     is a join every 12px, which was under the threshold while ONE gradient
     carried the whole treatment. Splitting frost from darkening put two
     gradients over the same span with their joins at the same offsets, and the
     slope changes add: measured 1.55 levels of 255 on a smooth source against
     0.97 before the split, with 55 rows showing a step.

     Measured, not guessed: 96 is the knee (55 rows -> 2), and 256 takes the
     worst row back to 0.94 with none stepping at all, which is where it was
     before the split. About 1ms a page for the last of that. */
  gradientSamples: 256,

  /* How much noise goes back over the blurred picture, breaking up the 8-bit
     staircase the blur creates by averaging the photograph's own away. Scales
     the noise tile's spread; see glassNoise. 0 turns it off and the contour
     bands come back. */
  dither: 0.12,
  blurCardWidth: 382,
  downscale: 4,     // the blur is reached by downsampling; see paintMistGlass

  refract: 0.022,   // how far the glass bends the picture, as a share of width
  refractStrips: 56,// depth resolution of the bend, and of the blur ramp
  /* ── How far above the first line the glass begins ────────────────────

     In the 1700px reference frame, scaled to whatever the card actually is.
     272 is about four and a half lines at the poster's 62px line height.

     This replaces `reach` and `startBelowCopy`, which between them decided
     that the band started AT the copy and ran 123px. Both were tuned
     repeatedly and neither could work: a ramp that short has to be steep, and
     one that starts on the type puts its steepest part where the eye is
     already looking. The run-up moves the onset into empty picture and the
     band's own height supplies the length.

     65 is about one line-height at the poster's 62px, and it is where the
     treatment was asked to begin - marked on a card, a little above the first
     row of copy. It was 272, roughly two lines further up.

     The shorter run-up is not free: the darkening has 556px to build across
     instead of 763, so its steepest run goes from 0.30 to about 0.41 levels
     per pixel. That is still five times gentler than the 2.0 cliff this
     treatment started from, and well inside the design's own slope, but it is
     the direction that made the edge findable before - so it is worth knowing
     which way this knob trades.

     Tunable live: window.GLASS.runUpAboveCopy = 272 then redraw restores the
     longer, gentler build. */
  runUpAboveCopy: 230,   // marked on the card: start the blend lower


  /* The text page's floor, under the glass rather than instead of it.

     The poster and the story page put their copy in a known place near the
     foot, so the ramp always has run-up above it. The text page's copy grows
     UPWARD from the foot and is clamped at a tenth of the card, so a long
     enough post starts its first line where the ramp has hardly begun. This is
     the floor that keeps that line legible; the glass builds on top of it.

     Set by measurement, not taste: white body copy on a bright photograph has
     to clear 4.5:1 at the first line in that worst case. */
  textPageVeil: 0.42,
}, window.GLASS));

/* ── Scratch canvases, kept rather than remade ───────────────────────────────

   This function allocated two canvases every time it ran, and it runs once per
   page: with a poster, a story and a text card open that is six canvases and
   about 10 MB per render. renderPoster() is called straight out of every
   keystroke handler, so ordinary typing was churning ~100 MB/s of canvas — GC
   pressure that shows up as the editor locking up under a fast typist rather
   than as anything so clear as an error.

   The sizes only change when the card size or the export scale changes, so the
   same two canvases are reused and resized when they no longer fit. Cleared
   rather than trusted: a reused canvas still holds the last frame, and the
   glass is built by compositing, so a stale layer underneath would show.

   Keyed by role because the two have different lifetimes and sizes, and
   sharing one would resize it twice per call, which is the expensive part of
   an allocation in the first place. */
const glassScratchPool = new Map();

/* ── Finished panes, kept ─────────────────────────────────────────────────────

   The glass is a pure function of what lies under its band and of its own
   geometry. Between keystrokes neither changes: the photograph, its pan, its
   zoom and its filter are the same, and the band starts where the copy
   starts. Yet it was rebuilt every frame — a dozen blur levels, fifty-six
   strips, a dither pass and a mask — for each card, on each repaint.

   paintMistGlass takes a cacheKey naming everything under the band (see
   glassCacheKey); the geometry is appended inside. On a hit the masked pane
   is blitted and the ink laid over it, and the whole build is skipped.

   Only at 1:1. An export scales the context and would need the pane at that
   resolution; those builds are rare and go straight through. */
const glassCache = new Map();
const GLASS_CACHE_MAX = 6;

function glassCacheKey(image, extra = "") {
  const focal = image && image.__focalPoint;
  return [
    state.previewMode, imageUid(image),
    focal ? focal.x : "", focal ? focal.y : "",
    state.imageOffset ? state.imageOffset.x : 0, state.imageOffset ? state.imageOffset.y : 0,
    state.imageZoom, buildFilterString(), JSON.stringify(GLASS), extra,
  ].join("|");
}

function glassScratch(role, width, height) {
  let cv = glassScratchPool.get(role);
  if (!cv) {
    cv = document.createElement("canvas");
    glassScratchPool.set(role, cv);
  }
  if (cv.width !== width || cv.height !== height) {
    cv.width = width;
    cv.height = height;
  }
  return cv;
}

/* ── Dither, because the blur is too good ─────────────────────────────────────

   A photograph carries sensor noise, and that noise is what keeps a smooth
   sky from banding: it dithers the 8-bit quantisation so the steps between
   adjacent values fall in different places on each row. Blurring averages it
   away. What is left is a mathematically smooth gradient, and a smooth
   gradient in 8 bits is a staircase — flat for as many rows as it takes the
   true value to cross the next 1/255, then a step.

   Measured on a photo-like ramp with the glass on: 33 runs where the row mean
   held the SAME value for four or more rows, the longest for thirty. With the
   glass off and only the darkening applied, zero. That is the "layered lines",
   and it is not the strips, the levels or the ramps — all of those measure
   clean. It is the blur doing its job.

   So a little noise goes back in. One tile, built once and repeated, laid over
   the finished glass in "overlay" so mid-grey is a no-op and the deviations
   lighten and darken symmetrically. It only has to be about a level to break
   the staircase up. */
let glassNoiseTile = null;

function glassNoise() {
  if (glassNoiseTile) return glassNoiseTile;
  const tile = document.createElement("canvas");
  tile.width = 128;
  tile.height = 128;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  const id = tctx.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) {
    /* Centred on 128 so "overlay" leaves the average untouched. The spread is
       what becomes the dither amplitude once GLASS.dither scales it down. */
    const v = 128 + Math.round((Math.random() * 2 - 1) * 90);
    id.data[i] = v;
    id.data[i + 1] = v;
    id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  tctx.putImageData(id, 0, 0);
  glassNoiseTile = tile;
  return tile;
}

function paintMistGlass(target, { width, height, copyTop, opacity = 1, image = null, cacheKey = null }) {
  /* The glass takes its geometry from GLASS.runUpAboveCopy and the height of
     its own band, not from the caller's fadeHeight - which it used to be
     handed through blurReach() and which could only ever be a fraction of a
     ramp that was too short to begin with. It handed over 149px on a 1700px
     card, and 149px is enough to ARRIVE in but not enough to DISSOLVE in. */
  /* ── Where the glass begins, and how long it has to get there ─────────

     Both of these were wrong, and no amount of curve-shaping could cover it.

     It began AT the first line (startBelowCopy = 0) and reached full strength
     123px later, a quarter of the way into a 491px band. Measured off the
     rendered card that is 92 of the 95 available levels of darkening inside
     120px — from line one to line three — against three levels across the
     whole run-up above it. A ramp that does nothing and then does everything
     is an edge with a soft top, and the eye finds it exactly where the type
     is, because that is where it lands.

     Peak slope tells the story: 1.22% per px against the design tool's 0.21%.
     Six times steeper. The curve was never the problem — smoothstep,
     smootherstep, 64 samples, per-strip radii all argued over the shape of a
     ramp too short to matter.

     So: start it a good way ABOVE the copy, where there is nothing for the
     onset to be measured against, and let it run the full height of the band.
     GLASS.runUpAboveCopy is in 1700-space and scales with the frame; the
     clamp keeps a tall setting from starting above the top of the card. */
  const runUp = Math.min(copyTop, GLASS.runUpAboveCopy * (height / 1700));
  const start = Math.max(0, copyTop - runUp);
  const span = height - start;
  if (span <= 0) return;
  /* The ramp IS the band now. It follows specAlpha across all of it, the same
     profile the bottom fade runs, so the two darkenings are one build rather
     than a cliff hidden inside a slope. */
  const copyFrac = 1;
  const glassTint = glassPanelColour(image);

  const canvas = target.canvas;
  if (!GLASS.on || !canvas || span <= 2 || width <= 2) return;

  /* ── Design space vs device pixels ────────────────────────────────────
     Everything handed to this function — width, start, span — is in DESIGN
     space, the 920x1700 the layout is written against. The canvas underneath
     is not necessarily that size: renderToHighResCanvas exports at up to 4x
     by scaling the context, and the video overlay does the same.

     Every other draw call here is unaffected, because a scaled context maps
     design coordinates to device pixels on its own. This one is different: it
     READS the canvas, and drawImage's SOURCE rectangle is not transformed. A
     source rect of (0, start, 920, span) against a 3680-wide export canvas
     reads the top-left corner instead of the copy band — the preview would
     look right and the published card would carry a frosted crop of the wrong
     part of the photograph.

     So the source rect is converted through the live transform, and the glass
     is built at device resolution so a 4x export is not fed a 1x layer. */
  const m = typeof target.getTransform === "function" ? target.getTransform() : null;
  const sx = m && m.a ? m.a : 1;
  const sy = m && m.d ? m.d : 1;
  const ox = m ? m.e : 0;
  const oy = m ? m.f : 0;

  const devW = Math.max(2, Math.round(width * sx));
  const devSpan = Math.max(2, Math.round(span * sy));
  const sw = Math.max(2, Math.round(devW / GLASS.downscale));
  const sh = Math.max(2, Math.round(devSpan / GLASS.downscale));

  // The geometry joins the caller's key: the same picture under a band that
  // starts lower — one more line of headline — is a different pane.
  const keptKey = cacheKey && sx === 1 && sy === 1
    ? `${cacheKey}|${start}|${span}|${width}|${height}|${devW}|${devSpan}`
    : null;
  let layer = keptKey ? glassCache.get(keptKey) : null;

  if (!layer) {
    /* The band, at a fraction of its size. Reading back from the canvas being
       drawn on is safe here: the photograph and its backdrop are already down,
       and nothing after this point has been painted yet. */
    const small = glassScratch("small", sw, sh);
    const sctx = small && small.getContext("2d", { willReadFrequently: false });
    if (!sctx) return;
    sctx.clearRect(0, 0, sw, sh);

    try {
      sctx.drawImage(canvas, ox, start * sy + oy, devW, devSpan, 0, 0, sw, sh);
    } catch (err) {
      /* A tainted canvas does not throw on drawImage, but a detached or
         zero-sized one can. The fade alone is a complete treatment, so losing
         the glass costs legibility nothing. */
      return;
    }

    // Build the finished glass at full size, then lay it down in one pass — so
    // the ramp masks the whole stack and not each layer separately.
    const glass = glassScratch("glass", devW, devSpan);
    const g = glass && glass.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.filter = "none";
    g.clearRect(0, 0, devW, devSpan);

    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";

    /* ── Refraction ───────────────────────────────────────────────────────
       Blur alone is fog, not glass. What separates the two is that glass BENDS
       what is behind it: a straight roofline behind real frosted glass arrives
       wavy, and it is that displacement, not the softness, that tells the eye
       it is looking through a solid.

       Done by re-drawing the blurred band as horizontal strips, each pulled
       sideways by a smooth function of its own depth. Two sine waves of
       unrelated frequency are summed so the bend never repeats visibly — one
       wave alone reads as a ripple effect, which is a filter, not a surface.

       The bend is strongest at the leading edge and settles as it descends.
       Real glass refracts hardest where it is thickest and where the eye meets
       it at an angle, and it also puts the distortion where the photograph is
       still legible — by the time the copy starts, the picture is far enough
       gone that bending it further would only cost contrast. */
    /* The blur is specified against a 382-wide card, so it scales with the
       canvas.

       It used to be divided by GLASS.downscale before being handed to
       ctx.filter, on the reasoning that "most of it is delivered by the
       downsample itself - drawing the band at 1/4 size and scaling back up IS a
       blur of roughly that factor - and ctx.filter only has to supply the
       remainder".

       That is wrong, and it cost three quarters of the effect. The filter is set
       on `g`, the FULL-SIZE context, so it resolves in destination pixels; the
       division would only be recovered if the blur happened in the small
       canvas's own space, before the 4x upscale. It does not, so the divide is
       simply lost. And the premise is wrong too: downsampling by four discards
       detail finer than about four pixels, it does not multiply a later blur by
       four.

       Measured on the rendered card at blurAt 34: the foot asked for 77px and
       received a Gaussian of sigma 16.4 - read off the 10-90% width of a hard
       edge, which is 2.563 sigma. Line three asked 31 and got 3.9.

       So the radius goes to ctx.filter as-is. blurAt is retuned to match, since
       the number now means what it says. */
    const blurTarget = (GLASS.blurAt * devW) / GLASS.blurCardWidth;
    const smallBlur = `blur(${Math.max(1, Math.round(blurTarget))}px)`;

    /* ── The blur, done where it is cheap ─────────────────────────────────

       Setting ctx.filter on the full-size context and letting each strip carry
       its own radius is the obvious way and it is unaffordable: at the radii
       this now asks for, a paint measured 140ms against 3ms. Fifty-six blurs of
       a 920-wide band, at sigma up to 60, on every drag.

       The band is already held at 1/GLASS.downscale for the read-back, and a
       blur applied THERE is multiplied by the upscale on the way out — sigma 15
       on the quarter-size copy lands as sigma 60 on the card, over a sixteenth
       of the pixels. So the levels are built once, in small space, and the
       strips just draw from whichever one matches their depth.

       Quantising to GLASS.blurLevels steps rather than a radius per strip is
       what makes that a fixed cost instead of a per-strip one. Twelve levels
       across the ramp is a fifth of a pixel of sigma between neighbours on the
       card, well under the quarter-pixel the per-strip version already rounded
       to.

       Padded and edge-extended before blurring, because a blur samples outward
       and there is nothing past the edge of the small canvas: those samples come
       back transparent, and at the foot that reads as the glass thinning out and
       the sharp photograph coming back through at the very bottom of the card. */
    const maxSigmaSmall = blurTarget / GLASS.downscale;
    const levels = Math.max(2, Math.round(GLASS.blurLevels));
    const pad = Math.max(2, Math.ceil(maxSigmaSmall * 3));
    const padH = sh + pad * 2;
    const padded = glassScratch("padded", sw, padH);
    const pctx = padded && padded.getContext("2d");
    const blurLevel = [];
    if (pctx) {
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.filter = "none";
      pctx.clearRect(0, 0, sw, padH);
      pctx.drawImage(small, 0, pad);
      // Edge rows stretched into the padding, so the blur has something to read.
      pctx.drawImage(small, 0, 0, sw, 1, 0, 0, sw, pad);
      pctx.drawImage(small, 0, sh - 1, sw, 1, 0, sh + pad, sw, pad);
      for (let k = 0; k < levels; k++) {
        const sigma = (maxSigmaSmall * k) / (levels - 1);
        const lv = glassScratch("blur" + k, sw, padH);
        const lctx = lv && lv.getContext("2d");
        if (!lctx) break;
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, sw, padH);
        lctx.filter = sigma >= 0.3 ? `blur(${Math.round(sigma * 4) / 4}px)` : "none";
        lctx.drawImage(padded, 0, 0);
        lctx.filter = "none";
        blurLevel.push(lv);
      }
    }

    const bendMax = devW * GLASS.refract;
    if (bendMax >= 0.5 && blurLevel.length) {
      const strips = Math.max(8, Math.round(GLASS.refractStrips));
      const stripH = glass.height / strips;
      // Sampled a strip taller than it is drawn, so a bent strip never exposes
      // an unpainted sliver where it has been pulled away from its neighbour.
      const bleed = Math.max(1, stripH * 0.6);
      for (let i = 0; i < strips; i++) {
        const t = i / (strips - 1);
        /* Two slow waves, not two fast ones.

           The step in displacement between neighbouring strips is
           bendMax * |dwave/dt| / strips, and at 7.6 and 17.3 that derivative
           peaks near 11 — which over 56 strips put adjacent ten-pixel slabs up
           to four pixels apart sideways. Measured on the rendered card: a 7px
           lateral jump across 3px of height. That is not a bend, it is tearing,
           and it is what the layered lines were.

           At 2.3 and 3.9 the derivative peaks near 2.9, and the strip count
           below carries the rest. The bend still never repeats visibly — that is
           what two unrelated frequencies buy — it just happens over the depth of
           the band rather than within a few strips of it. */
        const wave = Math.sin(t * 2.3) * 0.62 + Math.sin(t * 3.9 + 1.7) * 0.38;
        // Falls from full bend at the leading edge to a third of it at the foot.
        const depth = 1 - 0.66 * t;
        const dx = wave * bendMax * depth;
        /* A little vertical give as well, or the bend reads as a shear.

           Slowed from 11.1 to match the sideways wave, so the surface undulates
           as one thing rather than wobbling vertically at four times the rate it
           bends horizontally.

           NOT because 11.1 put the strips out of order, which is what this
           comment claimed at first and is wrong: the step between neighbours is
           amplitude * |dcos/dt| / strips, which even at 11.1 is 0.54px against a
           strip height of 7 — nowhere near enough to reorder them. The test that
           appeared to show reordering was in fact reading the cross-fade's two
           draws per strip as two strips. Checked by reverting: the suite passes
           either way, so this is a look, not a fix. */
        const dy = Math.cos(t * 2.7) * bendMax * 0.35 * depth;
        /* Named for what it is, and NOT `sy` — that is the transform's scale-y,
           declared above and load-bearing for export correctness. Shadowing it
           inside the one loop that also does coordinate maths is how the
           design-space/device-pixel bug this function exists to avoid gets
           reintroduced by someone reading quickly. */
        /* Clamped as an INTERVAL, not as two independent numbers. Taking
           min(sh, stripSrcH) bounds the height but not srcY + srcH, so the last
           strips ask for pixels past the bottom of the small canvas; the read is
           short and the strip is drawn stretched. Harmless at fifty-six strips
           where the overhang is a fraction of one, live at refractStrips <= 8. */
        /* Clamped into the PADDING, not to the band.

           [0, sh] was the conservative bound, and it left the foot bare. The
           last strip's destination bottom is sh * downscale + dy, and both
           terms fall short: sh is round(devSpan / downscale), so on a 721px
           band that is 180 and 180 * 4 = 720, one row shy; and dy at the foot
           is negative, taking another ~2px. Three rows of the band get no
           blurred content at all while the presence mask sits at alpha 1.0, so
           the sharp photograph shows through at full strength — a 63-level drop
           across the full width in three rows, which is a hard line.

           Reading past `sh` is safe and was safe all along: the level canvases
           are sh + pad * 2 tall and the read is already offset by `pad`, so
           rows sh..sh+pad exist and hold edge-extended pixels. The clamp was
           guarding against a short read that no longer happens.

           What must NOT change is that the destination follows the clamped
           source — that uniform mapping is what stops the first and last strips
           being drawn stretched. It still does; only the interval got wider. */
        const stripSrcY0 = Math.max(-pad, (i * stripH - bleed) / GLASS.downscale);
        const stripSrcY1 = Math.min(sh + pad, (i * stripH + stripH + bleed) / GLASS.downscale);
        const stripSrcH = Math.max(1, stripSrcY1 - stripSrcY0);

        /* ── The blur RAMPS, rather than being faded in at full strength ──────

           Until now one fully-blurred layer was alpha-faded over the sharp
           picture. Halfway through that ramp you are looking at both at once —
           a sharp image and a 63px-blurred one superimposed at half strength —
           and the eye reads the sharp copy still sitting in it. That is what
           makes the transition findable however smooth the alpha curve is: the
           curve is smooth, but what it is fading between is two different
           pictures rather than two amounts of the same effect.

           Ramping the radius instead means every depth is a single, genuinely
           blurred image at its own strength. Nothing is superimposed and there
           is no sharp copy left to notice.

           It costs nothing here because the refraction already redraws the band
           as strips: the radius simply varies per strip.

           The step between neighbours is blurTarget / strips, so it is the RAMP
           that has to cover the strips, not the band. This comment used to claim
           all fifty-six carried it, and that was wrong when it was written: the
           ramp then ended at copyFrac = 0.26, so fourteen strips carried the
           whole thing at 1.75px apart. It is true now only because the ramp runs
           the full band - about a fifth of a pixel between neighbours, which a
           diff against a constant-radius render puts at under 0.01 of 255 levels
           on the finished card. If copyFrac is ever shortened again, this
           divides by fourteen, not fifty-six. */
        /* The blur follows the darkening's curve RAISED TO A POWER, so it lags
           it: barely there where the band begins, and piling up towards the
           foot. Asked for as "more blurry as you go down".

           Raising blurAt alone would not do it. That scales every depth by the
           same factor, so the leading edge gets blurrier in step with the foot
           — and the leading edge is the one place a radius gradient is easy to
           catch, because it is the only part of the band with enough luminance
           left to show what sharpness was lost. Back-loading it instead adds
           the blur where the card is nearly black and the eye has almost no
           reference for focus, which is why blurAt can go up a long way while
           the top of the band actually gets SOFTER in its rate of change. */
        const rampT = Math.min(1, Math.max(0, t / copyFrac));
        const ease = Math.pow(rampAlpha(rampT), GLASS.blurCurve);
        /* Between two levels, not snapped to the nearest one.

           Snapping quantises the radius to blurLevels steps, and across a range
           that now reaches sigma 99 that is a step of nine pixels of blur from
           one strip to the next — which is a band of visibly different sharpness
           about ten pixels tall, reported as "layered lines". Drawing the lower
           level and then the upper at the fractional weight blends them, and a
           blend of two Gaussians of nearby sigma is close enough to the one in
           between that the seam goes away entirely. */
        const lp = ease * (blurLevel.length - 1);
        const k0 = Math.min(blurLevel.length - 1, Math.max(0, Math.floor(lp)));
        const k1 = Math.min(blurLevel.length - 1, k0 + 1);
        const frac = lp - k0;
        /* Destination follows the clamped source, so the mapping stays uniform.
           Drawing a fixed-height destination from a clamped source is what
           stretched the first and last strips: strip 0 asked for pixels above
           the canvas, got the read clipped to the top, and then scaled that
           short read over the full destination height. */
        // + pad, because the levels carry the edge-extended padding.
        const put = (canvasIn, alpha) => {
          if (alpha <= 0.001) return;
          g.globalAlpha = alpha;
          g.drawImage(
            canvasIn,
            0, stripSrcY0 + pad, sw, stripSrcH,
            dx, stripSrcY0 * GLASS.downscale + dy, glass.width, stripSrcH * GLASS.downscale,
          );
        };
        put(blurLevel[k0], 1);
        if (k1 !== k0) put(blurLevel[k1], frac);
        g.globalAlpha = 1;
      }
      g.filter = "none";
    } else if (blurLevel.length) {
      g.drawImage(blurLevel[blurLevel.length - 1], 0, pad, sw, sh, 0, 0, glass.width, glass.height);
    } else {
      g.filter = smallBlur;
      g.drawImage(small, 0, 0, sw, sh, 0, 0, glass.width, glass.height);
      g.filter = "none";
    }

    /* The bend pulls strips inward from the sides, so the outermost few pixels
       can end up unpainted. Stretch the edge columns outward to cover it —
       cheaper than drawing oversized and clipping, and invisible under this
       much blur. */
    if (bendMax >= 0.5) {
      const edge = Math.ceil(bendMax) + 2;
      g.drawImage(glass, edge, 0, 2, glass.height, 0, 0, edge, glass.height);
      g.drawImage(glass, glass.width - edge - 2, 0, 2, glass.height, glass.width - edge, 0, edge, glass.height);
    }


    /* The colour, blended rather than painted. "soft-light" keeps the glass's
       own luminance — its highlights stay highlights — and moves only its hue
       and saturation toward the photograph's dominant colour, which is what
       makes this read as tinted frost instead of a sheet of colour. A picture
       with no usable hue (imageFadeTint returns null on greyscale and on any
       cross-origin image) simply skips this and keeps the neutral glass. */
    /* ── Two ramps, because they are two different things ─────────────────

       The frost and the darkening used to share one mask: the blurred picture
       and the dark fill were stacked into this canvas, and a single ramp faded
       the whole stack in. That is why the card still read as sharp anywhere
       near the copy however large the radius got.

       At half mask alpha you are not looking at a half-blurred picture. You are
       looking at a blurred picture at half strength laid over the SHARP
       original at half strength, and the eye takes its reading of focus from
       the sharp component every time. Measured on the rendered card at blurAt
       34: the strip loop asked for sigma 52 at line three and the composite
       showed a 10-90 edge width of 1px - sharp - because the mask was only 60%
       on there. Raising the radius cannot fix that; it only blurs the half you
       were not looking at.

       So the blurred picture gets its own, faster ramp and is fully present by
       the copy line, and the dark fill keeps the long gentle one. Past that point there is no sharp copy left anywhere, and the rest
       of the transition is carried by brightness, which the eye cannot check.
       The radius then goes on growing under a solid layer - which is what makes
       "blurrier as you go down" visible rather than theoretical. */
    /* The dither, over the finished blur and under the mask, so it is shaped by
       the same ramp as everything else and never appears where the glass is not. */
    if (GLASS.dither > 0 && typeof g.createPattern === "function") {
      const tile = glassNoise();
      const pattern = tile && g.createPattern(tile, "repeat");
      if (pattern) {
        g.globalCompositeOperation = "overlay";
        g.globalAlpha = GLASS.dither;
        g.fillStyle = pattern;
        g.fillRect(0, 0, glass.width, glass.height);
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      }
    }

    g.globalCompositeOperation = "destination-in";
    const presence = g.createLinearGradient(0, 0, 0, glass.height);
    const PRESENCE_SAMPLES = Math.max(8, Math.round(GLASS.gradientSamples));
    /* Where the copy line falls inside the band, which is what the frost is
       anchored to rather than a fixed fraction.

       GLASS.frostReach is a MULTIPLE of that: 1 means the blurred layer is
       fully present exactly when the copy starts. Written this way so it
       survives runUpAboveCopy being moved - a fixed fraction silently pushes
       the frost below the first line when the run-up is shortened, which puts
       the sharp original back under the very lines it was split out to clear. */
    const copyFracInBand = Math.min(1, Math.max(0.02, runUp / span));
    const frost = Math.min(1, Math.max(0.02, copyFracInBand * GLASS.frostReach));
    for (let i = 0; i <= PRESENCE_SAMPLES; i++) {
      const t = i / PRESENCE_SAMPLES;
      // Same eased curve, compressed into the first GLASS.frostReach of the band.
      presence.addColorStop(t, `rgba(0,0,0,${rampAlpha(Math.min(1, t / frost))})`);
    }
    g.fillStyle = presence;
    g.fillRect(0, 0, glass.width, glass.height);
    g.globalCompositeOperation = "source-over";

    layer = glass;
    if (keptKey) {
      // Copied out of the scratch canvas, which the next build will overwrite.
      const keep = document.createElement("canvas");
      keep.width = glass.width;
      keep.height = glass.height;
      const kctx = keep.getContext("2d");
      if (kctx) {
        kctx.drawImage(glass, 0, 0);
        cacheKeep(glassCache, GLASS_CACHE_MAX, keptKey, keep);
        layer = keep;
      }
    }
  } // if (!layer)

  const prevAlpha = target.globalAlpha;
  target.globalAlpha = opacity;
  target.drawImage(layer, 0, 0, layer.width, layer.height, 0, start, width, span);
  target.globalAlpha = prevAlpha;

  /* The darkening, as its own gradient straight onto the target.

     It used to be a flat fill inside the glass canvas that the one mask then
     shaped. Painting it here instead is the same arithmetic - fillAlpha times
     the ramp - and it is what lets the two ramps differ at all. It is also one
     less full-size fill on the offscreen canvas.

     Sampled densely for the reason the mask is: addColorStop interpolates
     LINEARLY, so a curve described by a few stops is a few straight segments
     with a slope change at every join, and the eye resolves a change in slope
     far more readily than a change in value. */
  if (glassTint) {
    const ink = target.createLinearGradient(0, start, 0, height);
    const INK_SAMPLES = Math.max(8, Math.round(GLASS.gradientSamples));
    for (let i = 0; i <= INK_SAMPLES; i++) {
      const t = i / INK_SAMPLES;
      ink.addColorStop(t,
        `rgba(${glassTint.r},${glassTint.g},${glassTint.b},${(GLASS.fillAlpha * rampAlpha(t) * opacity).toFixed(4)})`);
    }
    target.fillStyle = ink;
    target.fillRect(0, start, width, span);
  }

  /* The sheen that used to sit here is gone. It drew a white band across the
     full width at the copy line to suggest the thickness of a glass edge, and
     on a dark photograph that is not a suggestion of thickness, it is a
     horizontal line drawn on the card — which is the one thing this treatment
     must not do. */
}

function paintBottomFade(target, { width, height, copyTop, fadeHeight: layoutFade, opacity = 1 }) {
  /* How far the fade reaches above the copy, as a multiple of the layout's
     own fadeHeight. That value was tuned for a fade that lands quickly, and
     the ink still has to reach full strength by the first line — so a short
     ramp arrives there steeply and then has nothing left to do but sit at
     flat black for the rest of the frame. Stretching it lowers the arrival
     slope by the same proportion, 38% gentler at 1.6, which is what turns the
     darkening into a steady build rather than a late rush onto a flat panel. */
  const fadeHeight = fadeReach(layoutFade);
  const start = Math.max(0, copyTop - fadeHeight);
  const span = height - start;
  // Copy sitting at or below the foot leaves nothing to fade.
  if (span <= 0) return start;

  /* The gradient spans the band, start to foot. It no longer needs to know
     where the copy line falls: the design's stops are positions along the
     gradient itself, not offsets from the first line of type. That is what
     removed the two-segment shape this used to draw. */
  const grad = target.createLinearGradient(0, start, 0, height);

  /* ── The gradient, exactly as drawn ──────────────────────────────────────

     From the design tool, read off the stop list:

       fill    #000000, linear, 100%
       0%      000000 at   0%
       63%     000000 at  80%
       100%    000000 at 100%

     ...and then the whole thing is scaled so the black tops out at 75%, which
     is what "make the black gradient 75%" asks for. The shape drawn in the
     design is kept exactly; only its ceiling moves:

       0%      0.00        63%     0.60        100%    0.75

     Scaled rather than clamped, and that is the whole decision. Setting ONLY
     the last stop to 75% leaves the 63% stop at 80%, so the gradient would
     rise to 80% and then fall back to 75% — the foot of the card coming out
     LIGHTER than the middle of the band, which reads as exactly the sort of
     horizontal edge this treatment exists to avoid. The test that says alpha
     never decreases catches it.

     What the ceiling buys: a quarter of the photograph is still coming
     through at the very foot, where at 100% none of it was.

     Three stops and nothing else. They are transcribed rather than
     approximated, and the two things that used to sit on top of them are
     gone:

       COPY_LINE_ALPHA (0.86) remapped the design's 100% onto the first line
       of copy and then ran a second, separate segment from there to the foot.
       That is a different gradient with a corner in the middle of it.

       GLASS.fadeMax (0.20) scaled the whole thing at the end, so the design's
       100% was rendering at 20% and the foot of the card was five times
       lighter than specified.

     Canvas interpolates LINEARLY between stops, which is what the design tool
     does too — so three stops reproduce this gradient exactly and sampling it
     more finely would be sampling two straight lines. Everything else in this
     file samples because it is drawing a curve; this is not a curve.

     `opacity` still multiplies, for the story page's overlay control. At its
     default of 1 the values above are what lands on the card. */
  const BLACK_CEILING = 0.75;
  const SPEC_STOPS = [[0, 0], [0.63, 0.80], [1, 1]];
  for (const [position, alpha] of SPEC_STOPS) {
    grad.addColorStop(position, `rgba(0,0,0,${(alpha * BLACK_CEILING * opacity).toFixed(3)})`);
  }

  target.fillStyle = grad;
  target.fillRect(0, start, width, span);
  return start;
}

function drawHero() {
  const image = state.mainImage || defaultMain;
  const zoom = (state.imageZoom || 100) / 100;
  drawCoverImage(image, 0, 0, canvas.width, canvas.height, state.imageOffset, zoom);

  // headlineTop moves with line count, so the fade follows short and long
  // titles alike. See paintBottomFade for the curve — the story page draws
  // the same one, anchored to its own copy.
  const L = getLayout();
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  paintMistGlass(ctx, {
    width: canvas.width,
    height: canvas.height,
    copyTop: headlineTop,
    image,
    cacheKey: glassCacheKey(image),
  });
  paintBottomFade(ctx, {
    width: canvas.width,
    height: canvas.height,
    copyTop: headlineTop,
    fadeHeight: L.gradient.fadeHeight,
  });

  // Draw both logos at fixed positions
  drawFixedLogos();
}

function drawLogo(x, y, size) {
  ctx.save();

  if (state.logoImage) {
    // Draw logo PNG at its native aspect ratio
    const imgW = state.logoImage.naturalWidth || state.logoImage.width;
    const imgH = state.logoImage.naturalHeight || state.logoImage.height;
    const aspect = imgW / imgH;
    let drawW, drawH;
    if (aspect >= 1) {
      drawW = size;
      drawH = size / aspect;
    } else {
      drawH = size;
      drawW = size * aspect;
    }
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 18;
    ctx.drawImage(
      state.logoImage,
      x - drawW / 2,
      y - drawH / 2,
      drawW,
      drawH
    );
    ctx.shadowBlur = 0;
  } else {
    // Text fallback
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = state.accent;
    ctx.font = `italic 800 ${Math.round(size * 0.42)}px 'Poppins', 'Segoe UI', Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Pix", x, y + 2);
  }

  ctx.restore();
}

function drawFixedLogos() {
  // Pick logo: when exporting for X, swap to Shortly (if loaded). Else use Pix.
  const useAlt = isXRenderMode() && state.shortlyLogoImage;
  const logo = useAlt ? state.shortlyLogoImage : state.logoImage;
  if (!logo) return;

  // Position + size come from the active aspect-ratio preset. The Shortly
  // logo already has its own gradient halo, so we use the slot size that's
  // tuned for it (slightly larger).
  const L = getLayout();
  const slotSize = useAlt ? L.logo.slotShortly : L.logo.slotPix;
  const centerX = L.logo.centerX;
  const centerY = L.logo.centerY;

  const rawW = logo.naturalWidth  || logo.width  || 1;
  const rawH = logo.naturalHeight || logo.height || 1;

  // Scale so the longest edge fills the slot (preserves aspect ratio)
  const scale = slotSize / Math.max(rawW, rawH);
  const drawW = rawW * scale;
  const drawH = rawH * scale;

  // Center inside the slot
  const px = centerX - drawW / 2;
  const py = centerY - drawH / 2;

  drawLogoAt(logo, px, py, drawW, drawH);
}

/* The logo used to carry a white halo and a hairline ring, which over a blue
   mark read as a pale blue outline rather than as glow. Both are gone: the
   mark is its own solid circle and needs nothing behind it to separate from
   the photo. */
/* The logo files are 3467px square and the slot is about a hundred. Drawing
   them straight from the file resamples eleven megapixels down to a coin, on
   every card, on every repaint — measured at 7ms a card, more than the
   headline, the tag and the fade together. Once at the size it is drawn, then
   blitted; keyed by device size so a 4x export gets a 4x copy. */
const logoScaleCache = new Map();

function logoAtSize(img, devW, devH) {
  const w = Math.max(1, Math.round(devW));
  const h = Math.max(1, Math.round(devH));
  const rawW = img.naturalWidth || img.width || 0;
  const rawH = img.naturalHeight || img.height || 0;
  // Not worth a copy unless the file is well over the drawn size.
  if (!rawW || rawW < w * 2 || rawH < h * 2) return img;
  const key = `${imageUid(img)}|${w}x${h}`;
  let scaled = logoScaleCache.get(key);
  if (!scaled) {
    scaled = document.createElement("canvas");
    scaled.width = w;
    scaled.height = h;
    const c = scaled.getContext("2d");
    if (!c) return img;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(img, 0, 0, w, h);
    cacheKeep(logoScaleCache, 8, key, scaled);
  }
  return scaled;
}

function drawLogoAt(img, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const radius = Math.min(w, h) / 2;

  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const source = logoAtSize(img, w * (m && m.a ? m.a : 1), h * (m && m.d ? m.d : 1));

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(source, x, y, w, h);
  ctx.restore();
}

function drawTag() {
  if (state.tag === "none") return;

  const drawn = DRAWN_TAGS[state.tag];
  const tagImg = drawn ? null : state.tagImages[state.tag];
  if (!drawn && !tagImg) return;

  const drawW = drawn ? measureDrawnTag(drawn) : (tagImg.naturalWidth || tagImg.width);
  const drawH = drawn ? TAG_BAR_HEIGHT          : (tagImg.naturalHeight || tagImg.height);

  // Tag is anchored to the dynamic headline top, so it always sits just
  // above the headline regardless of how many lines the headline wrapped to.
  const L = getLayout();
  const tagX = L.tag.x;
  const headlineTop = state._render?.top ?? (canvas.height - L.headline.bottomPadding - 200);
  const tagY = headlineTop - drawH - L.tag.gapAboveHeadline;

  if (drawn) {
    drawTagBadge(drawn, tagX, tagY, drawW, drawH);
    return;
  }

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.drawImage(tagImg, tagX, tagY, drawW, drawH);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function measureDrawnTag(tag) {
  ctx.save();
  ctx.font = TAG_FONT;
  const textW = ctx.measureText(tag.label).width;
  ctx.restore();
  const iconW = tag.icon ? TAG_ICON_BOX + TAG_ICON_GAP : 0;
  return Math.round(TAG_PAD_X * 2 + iconW + textW);
}

function drawTagBadge(tag, x, y, w, h) {
  // Only the bar carries the drop shadow — the SVG tags shadow the whole
  // image once, so shadowing the label too would read as a double halo.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = tag.bg;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "#FFFFFF";
  let cursor = x + TAG_PAD_X;
  if (tag.icon) {
    drawPlayGlyph(cursor, y + (h - TAG_ICON_BOX) / 2, TAG_ICON_BOX);
    cursor += TAG_ICON_BOX + TAG_ICON_GAP;
  }
  ctx.font = TAG_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // +1px optical nudge — Poppins' middle baseline sits slightly high in the bar.
  ctx.fillText(tag.label, cursor, y + h / 2 + 1);
  ctx.restore();
}

/* Rounded play triangle, sized to fit a `box`×`box` square at (x, y). */
function drawPlayGlyph(x, y, box) {
  const inset = box * 0.14;
  const left  = x + inset + box * 0.06;
  const top   = y + inset;
  const height = box - inset * 2;
  const width  = height * 0.88;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left + width, top + height / 2);
  ctx.lineTo(left, top + height);
  ctx.closePath();
  // Stroking with the fill colour rounds the triangle's corners.
  ctx.lineJoin = "round";
  ctx.lineWidth = box * 0.14;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

function drawHeadline() {
  // Use the layout + top that renderPoster already computed and cached, so
  // text, gradient, and tag stay in sync. Fall back gracefully if state
  // isn't initialized yet (e.g. very first paint).
  const L = getLayout();
  const cached = state._render || computeHeadlineLayoutAndTop();
  const { layout, top } = cached;
  const text = state.headline || "YOUR HEADLINE HERE";
  const left = L.headline.x;
  const blockHeight = layout.lines.length * layout.lineHeight;

  const allWords = text.trim().split(/\s+/).filter(Boolean);
  const purpleCount = Math.ceil(allWords.length / 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = layout.font;

  let currentlyHighlighted = null;

  // PASS 1: Draw Accent Backgrounds
  layout.lines.forEach((line, lineIndex) => {
    const rawWords = line.split(" ");
    let bgCursor = left;
    const y = top + lineIndex * layout.lineHeight;

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    let segmentStartX = null;
    let segmentWidth = 0;
    let segments = [];

    rawWords.forEach((rawWord, i) => {
      const isOpening = HIGHLIGHT_OPEN_CHAR.test(rawWord);
      const isClosing = HIGHLIGHT_CLOSE_CHAR.test(rawWord);
      const cleanWord = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '');

      // The tone of the open run, or null. Was a boolean before there were
      // two colours; the segment carries it so each box fills its own.
      if (isOpening) currentlyHighlighted = highlightToneFor(rawWord);

      // Advance exactly as pass 2 does (it measures `word + " "` and skips
      // bracket-only tokens), so each box starts under its first glyph.
      const wordWidth = ctx.measureText(cleanWord).width;
      const totalAdvance = cleanWord.length ? ctx.measureText(cleanWord + " ").width : 0;

      if (currentlyHighlighted && cleanWord.length > 0) {
        if (segmentStartX === null) {
          segmentStartX = bgCursor;
        }

        let advanceForHighlight = totalAdvance;
        if (isClosing || i === rawWords.length - 1) {
          advanceForHighlight = wordWidth; // Stop highlight at the end of the word cleanly
        }

        segmentWidth += advanceForHighlight;
      }

      if ((isClosing || i === rawWords.length - 1) && segmentStartX !== null) {
        segments.push({ x: segmentStartX, w: segmentWidth, tone: currentlyHighlighted });
        segmentStartX = null;
        segmentWidth = 0;
      }

      if (isClosing) currentlyHighlighted = null;
      bgCursor += totalAdvance;
    });

    // Pull the actual font size out of the font string (e.g. "600 49px ...")
    // so the highlight box hugs the glyph height, not the line-height. Using
    // lineHeight made the box too tall and bled into the next line's bbox.
    const fontMatch = layout.font.match(/(\d+(?:\.\d+)?)px/);
    const fontSize  = fontMatch ? parseFloat(fontMatch[1]) : Math.round(layout.lineHeight / 1.22);

    const PAD_X        = Math.max(8, Math.round(fontSize * 0.16));  // horizontal breathing room
    const CORNER_RAD   = Math.max(4, Math.round(fontSize * 4 / 18)); // Figma: 4px at 18px

    // Where the ink actually sits. The serif face has a tall ascent, so its
    // glyphs land well below the em-box top — a box sized from the font size
    // alone rode high and cut the letters. With textBaseline "top",
    // measurements are offsets from y (the top line), not from the alphabetic
    // baseline. Every box is placed from the same measurements and has the
    // same height, so the gap between one line's box and the next is
    // identical on every line.
    //
    // The box spans the tallest ascender (b, d, l — they rise above the caps)
    // to the lowest descender (g, p, y), plus equal padding above and below,
    // so no letter touches an edge. The padding is whatever the line height
    // leaves after a small fixed gap between boxes, capped so a loosely
    // spaced headline doesn't get oversized boxes.
    const inkTop    = -ctx.measureText("Hbdfhkl").actualBoundingBoxAscent;
    const inkBottom = ctx.measureText("gjpqy").actualBoundingBoxDescent;
    const inkHeight = inkBottom - inkTop;
    const LINE_GAP  = Math.max(5, Math.round(fontSize * 0.08) + 2);
    const PAD_Y     = Math.max(0, Math.min(
      Math.round(fontSize * 0.14),
      (layout.lineHeight - LINE_GAP - inkHeight) / 2,
    ));
    const drawH  = inkHeight + PAD_Y * 2;
    const boxTop = y + inkTop - PAD_Y;

    segments.forEach(seg => {
      // Per segment: two runs on one line can now be two colours.
      ctx.fillStyle = highlightColor(seg.tone);
      const drawX = seg.x - PAD_X;
      const widthToFill = seg.w + PAD_X * 2;
      const drawY = boxTop;

      ctx.beginPath();
      ctx.roundRect(drawX, drawY, widthToFill, drawH, CORNER_RAD);
      ctx.fill();
    });
  });

  // reset for pass 2
  currentlyHighlighted = null;

  // PASS 2: Draw White Text with Shadow — at half its former 0.6 opacity,
  // so it still lifts the words off the photo without muddying the
  // highlight boxes it falls on.
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;

  layout.lines.forEach((line, lineIndex) => {
    const rawWords = line.split(" ");
    let cursor = left;
    const y = top + lineIndex * layout.lineHeight;

    for (const rawWord of rawWords) {
      const cleanWord = rawWord.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '');
      if (cleanWord.length > 0) {
        ctx.fillStyle = "#ffffff"; // All text is white
        ctx.fillText(cleanWord + " ", cursor, y);
        cursor += ctx.measureText(cleanWord + " ").width;
      }
    }
  });

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/* ── Preview-only UI Overlays (drawn on canvas, excluded from download) ── */

function drawEngagementBar() {
  ctx.save();

  // Scale factor from Zeplin (390 width, 2.36x to reach 920px)
  const scale = 2.36;

  const pillW = Math.round(222.3 * scale); // ~525
  const pillH = Math.round(48.9 * scale);  // ~115
  const shareW = Math.round(48.9 * scale); // ~115
  const gap = Math.round(8 * scale);       // ~19

  const barY = 1700 - Math.round(14 * scale) - Math.round(46 * scale) - Math.round(6 * scale) - pillH;

  // Center align the entire group (pill + gap + share circle)
  const totalW = pillW + gap + shareW;
  const barX = (canvas.width - totalW) / 2;

  // Dark Pill Background
  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.beginPath();
  ctx.roundRect(barX, barY, pillW, pillH, pillH / 2);
  ctx.fill();

  // Faint border
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw Separator Lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1.5;
  const sectionW = pillW / 3;
  const cy = barY + pillH / 2;

  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(barX + sectionW * i, cy - 22);
    ctx.lineTo(barX + sectionW * i, cy + 22);
    ctx.stroke();
  }

  // Draw Items
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 32px 'Inter', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const iconScale = 40;

  const drawItem = (index, iconPath, text, isFill) => {
    const cx = barX + sectionW * index + sectionW / 2;
    const textWidth = ctx.measureText(text).width;
    const itemGap = 12;
    const totalW = iconScale + itemGap + textWidth;

    const startX = cx - totalW / 2 + iconScale / 2;

    // Draw icon
    drawIconPath(startX, cy, iconScale, iconPath, isFill);

    // Draw text
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, startX + iconScale / 2 + itemGap, cy + 2);
  };

  const LIKE_SOLID = "M2 21h2V9H2v12zm4-9v10a1 1 0 001 1h9.07a2 2 0 001.93-1.49L21.83 11A2 2 0 0019.9 8.5H14V4a2 2 0 00-2-2h-.09a1.65 1.65 0 00-1.56 1.09L7.44 12H6z";
  const DISLIKE_OUTLINE = "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm-1.41 15.41L12 17l1.41-.65V11H7.5l3-7h3.5v9h5.11l-3 7L13.59 18.41zM3 15h4V3H3v12z";
  const COMMENT_OUTLINE = "M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 15.17L18.83 16H4V4h16v13.17z";

  drawItem(0, LIKE_SOLID, "1.2k", true);
  drawItem(1, DISLIKE_OUTLINE, "200", false);
  drawItem(2, COMMENT_OUTLINE, "200", false);

  // --- Share Circle ---
  const shareX = barX + pillW + gap;

  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.beginPath();
  ctx.arc(shareX + shareW / 2, cy, shareW / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const SHARE_SOLID = "M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z";
  drawIconPath(shareX + shareW / 2 - 2, cy - 2, 40, SHARE_SOLID, true);

  ctx.restore();
}

function drawIconPath(cx, cy, size, pathData, isFill = true) {
  ctx.save();
  const scale = size / 24;
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(scale, scale);
  const p = new Path2D(pathData);
  ctx.fillStyle = isFill ? "#ffffff" : "rgba(255, 255, 255, 0.85)";
  ctx.fill(p);
  ctx.restore();
}

function drawNavBar() {
  ctx.save();
  const scale = 2.36;
  const barW = Math.round(378 * scale); // 892
  const barH = Math.round(46 * scale);  // 108
  const barY = 1700 - Math.round(6 * scale) - barH; // 1578
  const barX = (920 - barW) / 2; // ~14

  // Background
  ctx.fillStyle = "rgba(13, 13, 13, 0.8)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.2)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 54);
  ctx.fill();

  // Faint border
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const cy = barY + barH / 2;

  const NAV_HOME = "M12 5.69l5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3L2 12h3v8h6v-6h2v6h6v-8h3L12 3z";
  const NAV_VIDEO = "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zm-11-2l6-4-6-4v8z";
  const NAV_DOC_OUTLINE = "M14 2H6a2 2 0 00-2 2v16h16V8l-6-6zm4 18H6V4h7v5h5v11z M8 14h8v-2H8v2z M8 18h8v-2H8v2z M8 10h5V8H8v2z";
  const NAV_AUDIO = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z M11 7h2v10h-2z M7 10h2v4H7z M15 10h2v4h-2z";
  const NAV_BOLT = "M11 21h-1l1-7H7.5a.5.5 0 01-.4-.8l3.9-5.2V3h1l-1 7h3.5a.5.5 0 01.4.8L11 16v5z";

  const icons = [NAV_HOME, NAV_VIDEO, NAV_DOC_OUTLINE, NAV_AUDIO, NAV_BOLT];

  const padding = 64;
  const startX = barX + padding;
  const W = barW - padding * 2;

  icons.forEach((path, i) => {
    const cx = startX + i * (W / 4);
    const isAccent = i === 4;

    if (isAccent) {
      // Accent circle
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, Math.PI * 2);
      ctx.fillStyle = "#3979FF";
      ctx.fill();
    }

    const iconSize = isAccent ? 40 : 44;
    drawIconPath(cx, cy, iconSize, path, isAccent);
  });

  ctx.restore();
}

function buildHeadlineLayoutFixed(text, maxWidth, size) {
  const cleaned = normalizeHeadlineForPoster(text);
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapTextBlock(cleaned, maxWidth);
  return { font, lines, lineHeight: headlineLineHeight(cleaned, size, 1.1) };
}

/* ── Headline Layout ── */

function buildHeadlineLayout(text, maxWidth, _maxLines) {
  const cleaned = normalizeHeadlineForPoster(text);

  // Fixed 48px / 600 weight — text grows downward as lines increase
  const size = 48;
  const font = `600 ${size}px 'Roboto Serif', 'Poppins', serif`;
  ctx.font = font;
  const lines = wrapTextBlock(cleaned, maxWidth);
  return { font, lines, lineHeight: headlineLineHeight(cleaned, size, 1.22) };
}

/* Line spacing for the poster headline. A headline with [highlighted] words
   gets a little more: each highlight box has to hold the tallest ascender
   (l, H) to the lowest descender (g, y) — about the font size itself — plus
   padding above and below and a gap to the next line's box. At the plain
   spacing the boxes had only 2–3px of padding and letters touched the edges.
   Headlines without highlights keep their original spacing. */
function headlineLineHeight(text, size, plainRatio) {
  const ratio = HIGHLIGHT_OPEN_CHAR.test(text) ? Math.max(plainRatio, 1.38) : plainRatio;
  return Math.round(size * ratio);
}

function normalizeHeadlineForPoster(text) {
  return text
    // Collapse runs of spaces/tabs but KEEP newlines — pressing Enter is a
    // deliberate line break, and /\s+/ used to flatten it into a space.
    .replace(/[^\S\n]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")        // cap runaway blank runs
    .replace(/^live\s+/i, "")
    .split("\n").map(l => l.trim()).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * Wrap a block that may contain manual line breaks: each newline-separated
 * segment is wrapped (and rebalanced) on its own, so an author's break is
 * always honoured and auto-wrapping never pulls words across it.
 */
function wrapTextBlock(text, maxWidth) {
  const out = [];
  for (const segment of text.split("\n")) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");                     // a deliberate blank line
      continue;
    }
    out.push(...wrapWords(words, maxWidth));
  }
  return out.length ? out : [""];
}

function wrapWords(words, maxWidth) {
  const lines = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    // Strip bracket markers when measuring text width
    if (ctx.measureText(test.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '')).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return rebalanceLines(lines, maxWidth);
}

function rebalanceLines(lines, maxWidth) {
  if (lines.length < 2) return lines;

  const balanced = [...lines];
  for (let i = 0; i < balanced.length - 1; i += 1) {
    const currentWords = balanced[i].split(" ");
    const nextWords = balanced[i + 1].split(" ");
    if (currentWords.length < 2 || nextWords.length < 2) continue;

    const moved = `${balanced[i]} ${nextWords[0]}`;
    // Strip bracket markers when measuring text width
    if (ctx.measureText(moved.replace(HIGHLIGHT_ANY_CHARS_GLOBAL, '')).width <= maxWidth * 0.98) {
      balanced[i] = moved;
      nextWords.shift();
      balanced[i + 1] = nextWords.join(" ");
    }
  }

  return balanced.filter(Boolean);
}

function compressLines(lines, maxLines) {
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines - 1);
  const finalLine = lines.slice(maxLines - 1).join(" ");
  kept.push(finalLine.length > 46 ? `${finalLine.slice(0, 43).trimEnd()}...` : finalLine);
  return kept;
}

/* ── Cover Image Drawing ── */

function drawCoverImage(image, x, y, width, height, offset, zoom) {
  const baseScale = Math.max(width / image.width, height / image.height);
  const scale = baseScale * (zoom || 1) * IMAGE_PAN_HEADROOM;
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const focal = image.__focalPoint || { x: image.width / 2, y: image.height / 2 };

  let dx = x + width / 2 - focal.x * scale;
  let dy = y + height / 2 - focal.y * scale;

  if (offset) {
    dx += offset.x;
    dy += offset.y;
  }

  /* Clamping is what stops a pan dragging an empty edge into frame, and it
     only means anything while the picture is BIGGER than the frame. Once it is
     smaller — zoomed out to fit a landscape photo into a 9:16 poster — the
     minimum runs past the maximum and clamp() collapses to the maximum, which
     pinned the photograph into the top-left corner instead of leaving it in
     the middle of the card. A fitted photo belongs centred, with the backdrop
     showing evenly around it. */
  const minX = x + width - drawWidth;
  const minY = y + height - drawHeight;
  if (drawWidth >= width) dx = clamp(dx, minX, x);
  if (drawHeight >= height) dy = clamp(dy, minY, y);

  // Apply filters (brightness/contrast/saturation/blur) only to the image
  // layer — gradient, headline, logo, etc. should NOT be filtered. Reset to
  // "none" immediately after the draw so subsequent layers render normally.
  ctx.save();
  ctx.filter = deviceFilter(buildFilterString());
  ctx.drawImage(image, dx, dy, drawWidth, drawHeight);
  ctx.restore();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ── Image Utilities ── */

async function imageFromUrl(url) {
  if (url.startsWith("data:")) {
    return createImage(url);
  }
  return createImage(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
}

async function createImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = async () => {
      await ensureImageFocalPoint(image);
      resolve(image);
    };
    image.onerror = reject;
    image.src = src;
  });
}

/* Where the poster should centre this picture when it crops it.

   EVERY face, not the first one. drawCoverImage() centres the crop on this
   point, so on a 9:16 poster — which keeps about a third of a landscape
   photograph's width — the focal point decides who survives the cut. Reading
   `faces[0]` centred the poster on whichever face the detector happened to
   return first, and a landscape press photo of two people came back as a
   portrait of one of them with the other's shoulder at the edge. Nothing was
   wrong with the picture; the crop was aimed at half of it.

   The centre of the box that contains all the faces keeps a group together:
   two people either side of the frame average back to the middle and both
   stay in, and a single face is unchanged because the union of one box is
   that box. It is not a promise that everyone fits — a crop that narrow
   cannot make that promise, which is what the expand path below is for — but
   it aims at the group instead of at one member of it. */
async function ensureImageFocalPoint(image) {
  if (image.__focalPoint) return image.__focalPoint;

  let focalPoint = { x: image.width / 2, y: image.height / 2 };
  if (faceDetector) {
    try {
      const faces = await faceDetector.detect(image);
      if (faces?.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const face of faces) {
          const box = face.boundingBox;
          if (!box) continue;
          x0 = Math.min(x0, box.x);
          y0 = Math.min(y0, box.y);
          x1 = Math.max(x1, box.x + box.width);
          y1 = Math.max(y1, box.y + box.height);
        }
        if (Number.isFinite(x0) && Number.isFinite(y0)) {
          focalPoint = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
        }
      }
    } catch { }
  }

  image.__focalPoint = focalPoint;
  return focalPoint;
}

function waitForImage(image) {
  if (image.complete) return Promise.resolve(image);
  return new Promise((resolve) => {
    image.onload = () => resolve(image);
  });
}

/* ── Placeholder ── */

function makeMainPlaceholder() {
  return makeSvgImage(`
    <svg xmlns="http://www.w3.org/2000/svg" width="920" height="1700" viewBox="0 0 920 1700">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stop-color="#1a1a2e" />
          <stop offset="50%" stop-color="#0f0f1a" />
          <stop offset="100%" stop-color="#050508" />
        </linearGradient>
        <radialGradient id="glow" cx="0.3" cy="0.2" r="0.6">
          <stop offset="0%" stop-color="rgba(139,92,246,0.12)" />
          <stop offset="100%" stop-color="transparent" />
        </radialGradient>
      </defs>
      <rect width="920" height="1700" fill="url(#bg)" />
      <rect width="920" height="1700" fill="url(#glow)" />
      <text x="460" y="800" text-anchor="middle" font-family="Poppins, sans-serif" font-size="38" font-weight="700" fill="rgba(255,255,255,0.1)">Paste a URL to get started</text>
    </svg>
  `);
}

function makeSvgImage(svg) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  image.__focalPoint = { x: 460, y: 850 };
  return image;
}

/* ── Helpers ── */

/* The whole paragraph, from whichever field is currently authoritative —
   the draft box while Write Text is open, the editor box while typing, the
   saved value otherwise. Slices are cut from this. */
function getFullDetailText() {
  if (!state.isDownloading && state.previewMode === "text") {
    const isWritingText = writeForm && !writeForm.hidden;
    return isWritingText && writeDetail
      ? writeDetail.value
      : (detailEdit?.value ?? state.detailText ?? "");
  }
  return state.detailText || "";
}

function getDetailTextForPreview() {
  // No headline fallback anywhere in here. The headline belongs to slide 1;
  // echoing it onto slide 2 is the bug, not a graceful default. An empty
  // paragraph shows a prompt instead, which is honest about the card being
  // unfinished rather than looking deliberately duplicated.
  const fallback = "Add key points in Text Paragraph, or generate them from a link.";

  // Painting a text card that owns a slice: show only its share of the
  // points, and say so plainly when the division left it with none.
  if (state._detailSlice !== null && state._detailSlice !== undefined) {
    const slice = state._detailSlice.trim();
    return limitDetailTextClient(slice || "No points left for this page — add more to the paragraph.");
  }

  const text = getFullDetailText();
  if (!state.isDownloading && state.previewMode === "text") {
    return limitDetailTextClient(text.trim() ? text : fallback, { preserveOpenBullet: true });
  }
  return limitDetailTextClient(text.trim() || fallback);
}

function handleDetailBulletEnter(event) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

  const field = event.currentTarget;
  const value = field.value || "";
  const selectionStart = field.selectionStart ?? value.length;
  const selectionEnd = field.selectionEnd ?? selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const currentLine = value.slice(lineStart, selectionStart);
  const currentLineText = currentLine.trim();
  const shouldBulletCurrentLine = currentLineText && !/^[\u2022*-]\s+/.test(currentLineText);

  event.preventDefault();

  let nextValue = value;
  let nextStart = selectionStart;
  let nextEnd = selectionEnd;
  if (shouldBulletCurrentLine) {
    nextValue = `${value.slice(0, lineStart)}\u2022 ${value.slice(lineStart)}`;
    nextStart += 2;
    nextEnd += 2;
  }

  const before = nextValue.slice(0, nextStart);
  const after = nextValue.slice(nextEnd);
  const insertion = before.trim() ? "\n\n\u2022 " : "\u2022 ";
  field.value = `${before}${insertion}${after}`;

  const cursor = before.length + insertion.length;
  field.setSelectionRange(cursor, cursor);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function formatDetailBulletField(field) {
  const original = field.value || "";
  const formatted = formatDetailBulletText(original);
  if (formatted === original) return original;

  const cursor = field.selectionStart ?? original.length;
  const delta = formatted.length - original.length;
  field.value = formatted;
  const nextCursor = Math.min(field.value.length, Math.max(0, cursor + delta));
  field.setSelectionRange(nextCursor, nextCursor);
  return field.value;
}

function formatDetailBulletText(value) {
  const normalized = (value || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return normalized;

  const wantsNextBullet = /\n$/.test(normalized);
  const hasOpenBullet = /(?:^|\n)\s*[\u2022*-]\s*$/.test(normalized);
  const points = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[\u2022*-]\s*$/.test(line))
    .map((line) => (/^[\u2022*-]\s+/.test(line) ? `\u2022 ${line.replace(/^[\u2022*-]\s+/, "")}` : `\u2022 ${line}`));

  let output = points.join("\n\n");
  if ((wantsNextBullet || hasOpenBullet) && output) {
    output = `${output}\n\n\u2022 `;
  }
  return output;
}

function limitDetailTextClient(value, options = {}) {
  return normalizeDetailTextClient(value, options);
}

function normalizeDetailTextClient(value, { preserveOpenBullet = false } = {}) {
  const lines = (value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd());

  while (!preserveOpenBullet && lines.length && /^[\u2022*-]\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }

  return lines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function limitWordsClient(value, maxWords) {
  return (value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function slugify(value) {
  return (value || "pix-post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pix-post";
}

function setStatus(message, type) {
  scrapeStatus.textContent = message;
  scrapeStatus.className = "status-text";
  if (type) scrapeStatus.classList.add(type);
}

/* The analytics boards are built with innerHTML, and the names in them come
   from the database — user_name is written from whatever display name an
   account was created with (lib/pix-api.js sets it from the session). A name
   containing markup would otherwise execute in every QA's browser, so it is
   escaped on the way in. Anything rendered through textContent elsewhere is
   already safe and does not need this. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function setAnalyticsStatus(message, type) {
  if (!analyticsStatus) return;
  analyticsStatus.textContent = message || "";
  analyticsStatus.className = "status-text" + (type ? ` ${type}` : "");
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatCompactNumber(value) {
  const n = Number(value) || 0;
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function animateCounter(el, value, suffix = "") {
  if (!el) return;
  const target = Number(value) || 0;
  const start = Number(el.dataset.currentValue || 0);
  const diff = target - start;
  const startTime = performance.now();
  const duration = 700;

  function frame(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = start + diff * eased;
    el.textContent = `${formatCompactNumber(Math.round(current))}${suffix}`;
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      el.dataset.currentValue = String(target);
      el.textContent = `${formatCompactNumber(target)}${suffix}`;
    }
  }

  requestAnimationFrame(frame);
}

function analyticsValueEl(key) {
  return document.querySelector(`[data-analytics-value="${key}"]`);
}

function analyticsDailyValueEl(key) {
  return document.querySelector(`[data-analytics-daily-value="${key}"]`);
}

let analyticsMidnightTimer = null;
let analyticsResetClockTimer = null;

function scheduleAnalyticsMidnightRefresh(nextResetAt) {
  clearTimeout(analyticsMidnightTimer);
  clearInterval(analyticsResetClockTimer);
  analyticsMidnightTimer = null;
  analyticsResetClockTimer = null;

  const resetAt = new Date(nextResetAt || "");
  if (Number.isNaN(resetAt.getTime())) {
    if (analyticsDailyReset) analyticsDailyReset.textContent = "Resets automatically at 12:00 AM IST";
    return;
  }

  const updateResetCopy = () => {
    if (!analyticsDailyReset) return;
    const remainingMinutes = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 60000));
    if (!remainingMinutes) {
      analyticsDailyReset.textContent = "Refreshing for the new India business day...";
      return;
    }
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    const remaining = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    analyticsDailyReset.textContent = `Resets at 12:00 AM IST · ${remaining} remaining`;
  };

  updateResetCopy();
  analyticsResetClockTimer = setInterval(updateResetCopy, 60000);
  const delay = Math.max(0, resetAt.getTime() - Date.now()) + 1500;
  analyticsMidnightTimer = setTimeout(() => {
    clearInterval(analyticsResetClockTimer);
    analyticsResetClockTimer = null;
    loadAnalytics({ force: true });
  }, delay);
}

function renderAnalyticsDaily(daily = {}) {
  animateCounter(analyticsDailyValueEl("sent"), daily.sent_count || 0);
  animateCounter(analyticsDailyValueEl("approved"), daily.approved_count || 0);
  animateCounter(analyticsDailyValueEl("rejected"), daily.rejected_count || 0);
  animateCounter(analyticsDailyValueEl("pending"), daily.pending_count || 0);

  if (analyticsTodayDate) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(daily.day_key || "")
      ? new Date(`${daily.day_key}T12:00:00+05:30`)
      : new Date();
    analyticsTodayDate.textContent = new Intl.DateTimeFormat("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: daily.timezone || "Asia/Kolkata",
    }).format(day);
  }

  scheduleAnalyticsMidnightRefresh(daily.next_reset_at);
}

function renderAnalyticsSummary(summary = {}, role = "writer") {
  animateCounter(analyticsValueEl("sent"), summary.sent_count || 0);
  animateCounter(analyticsValueEl("approved"), summary.approved_count || 0);
  animateCounter(analyticsValueEl("rejected"), summary.rejected_count || 0);
  animateCounter(analyticsValueEl("pending"), summary.pending_count || 0);
  animateCounter(analyticsValueEl("rate"), summary.approval_rate || 0, "%");

  const sentSub = document.getElementById("analytics-sent-sub");
  const approvedSub = document.getElementById("analytics-approved-sub");
  const rejectedSub = document.getElementById("analytics-rejected-sub");
  const pendingSub = document.getElementById("analytics-pending-sub");
  const rateSub = document.getElementById("analytics-rate-sub");

  if (sentSub) {
    sentSub.textContent = canReviewRole(role)
      ? `${formatCount(summary.active_writers || 0)} writers active in the pipeline`
      : "Posts you have sent into the workflow";
  }
  if (approvedSub) {
    approvedSub.textContent = canReviewRole(role)
      ? `${formatCount(summary.approved_by_me_count || 0)} approved by you`
      : "Posts QA has approved";
  }
  if (rejectedSub) {
    rejectedSub.textContent = canReviewRole(role)
      ? "Returned to writers for changes"
      : "Posts QA returned for changes";
  }
  if (pendingSub) {
    pendingSub.textContent = canReviewRole(role)
      ? "Still waiting for QA action"
      : "Your posts still in review";
  }
  if (rateSub) {
    rateSub.textContent = canReviewRole(role)
      ? `${formatCount(summary.active_qas || 0)} QA reviewers active`
      : "Share of your posts approved";
  }
}

function renderAnalyticsMeta(summary = {}, role = "writer") {
  if (!analyticsMetaList || !analyticsMetaTitle) return;
  analyticsMetaTitle.textContent = canReviewRole(role) ? "Approval health" : "Your pipeline health";
  const items = canReviewRole(role)
    ? [
        ["Active writers", formatCount(summary.active_writers || 0)],
        ["Active QA reviewers", formatCount(summary.active_qas || 0)],
        ["Approved by you", formatCount(summary.approved_by_me_count || 0)],
        ["Avg approval time", `${Number(summary.avg_approval_hours || 0).toFixed(1)} hrs`],
      ]
    : [
        ["Posts sent", formatCount(summary.sent_count || 0)],
        ["Posts approved", formatCount(summary.approved_count || 0)],
        ["Posts pending", formatCount(summary.pending_count || 0)],
        ["Avg approval time", `${Number(summary.avg_approval_hours || 0).toFixed(1)} hrs`],
      ];

  analyticsMetaList.innerHTML = items.map(([label, value]) => `
    <div class="analytics-metric">
      <span class="analytics-metric-label">${label}</span>
      <strong class="analytics-metric-value">${value}</strong>
    </div>
  `).join("");
}

function renderAnalyticsBoard(container, rows, { empty, valueLabel, showRate = false, rateField = "approval_rate", approvedField = "approved_count", pendingField = "pending_count" }) {
  if (!container) return;
  if (!rows?.length) {
    container.innerHTML = `<div class="analytics-empty">${empty}</div>`;
    return;
  }
  container.innerHTML = rows.map((row, index) => `
    <div class="analytics-row">
      <span class="analytics-rank">${index + 1}</span>
      <div class="analytics-row-main">
        <span class="analytics-row-name">${escapeHtml(row.user_name || "Unknown")}</span>
        <span class="analytics-row-meta">${approvedField in row && pendingField in row
          ? `${formatCount(row[approvedField] || 0)} approved · ${formatCount(row[pendingField] || 0)} pending`
          : valueLabel}</span>
      </div>
      <div class="analytics-row-value">
        <span class="analytics-row-total">${formatCount(row.sent_count ?? row.approved_count ?? 0)} ${valueLabel}</span>
        <span class="analytics-row-rate">${showRate ? `${formatCount(row[rateField] || 0)}% approval` : ""}</span>
      </div>
    </div>
  `).join("");
}

/* ─── Content writer roster ────────────────────────────────
   A collapsed strip that opens into a table: total sent, then approvals in
   green, rejections in red and pending in yellow. Source, category and date
   filters are server-side because the counts are SQL rollups and cannot be
   narrowed accurately in the browser. */
let writerRoster = [];
let qaRoster = [];
let rosterMode = "writers";     // "writers" | "qa"

/* Sentinel matching the server's, for posts with no category on them. */
const UNCATEGORISED = "__none__";

const analyticsFilters = { source: "all", category: "all", from: "", to: "" };

function analyticsFilterDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" })
    .format(new Date(`${value}T12:00:00+05:30`));
}

function syncAnalyticsFilterSummary() {
  if (!analyticsFilterSummary) return;
  const source = analyticsSourceLabel?.textContent?.trim() || "All sources";
  const category = analyticsCategoryLabel?.textContent?.trim() || "All categories";
  const from = analyticsFilterDate(analyticsFilters.from);
  const to = analyticsFilterDate(analyticsFilters.to);
  const dates = from && to ? `${from} – ${to}` : from ? `From ${from}` : to ? `Until ${to}` : "All dates";
  analyticsFilterSummary.textContent = `${source} · ${category} · ${dates}`;
}

/* Copy for each side of the toggle. The writer view counts verdicts on what a
   writer sent; the QA view counts verdicts a reviewer recorded. */
const ROSTER_MODES = {
  writers: {
    title: "Content writers",
    desc: "Verdicts on each writer's posts.",
    noun: "writer",
    empty: "No writer activity yet.",
  },
  qa: {
    title: "QA approvers",
    desc: "Verdicts each reviewer has recorded.",
    noun: "approver",
    empty: "No QA verdicts yet.",
  },
};

/* Team-wide posts nobody has ruled on. Per-reviewer it would be meaningless —
   the same number repeated down every row — so it belongs in the QA-mode
   subtitle instead. */
let rosterAwaitingTotal = 0;

function escapeRosterText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function rosterInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderWriterRoster() {
  if (!analyticsRosterList) return;

  const mode = ROSTER_MODES[rosterMode] || ROSTER_MODES.writers;
  /* Ten, sliced here rather than in SQL. The query behind these rows now
     returns everybody, because the Writers screen merges the same payload
     into a roster keyed by account and a top-ten cut left everyone below
     eleventh place reading "no posts yet". This panel is still a
     leaderboard, so it still shows ten. */
  const rows = (rosterMode === "qa" ? qaRoster : writerRoster).slice(0, 10);

  if (analyticsRosterTitle) analyticsRosterTitle.textContent = mode.title;
  if (analyticsRosterDesc) {
    analyticsRosterDesc.textContent = rosterMode === "qa" && rosterAwaitingTotal
      ? `${mode.desc} ${formatCount(rosterAwaitingTotal)} post${rosterAwaitingTotal === 1 ? "" : "s"} still awaiting approval.`
      : mode.desc;
  }
  if (analyticsRosterCount) {
    analyticsRosterCount.textContent = `${formatCount(rows.length)} ${mode.noun}${rows.length === 1 ? "" : "s"}`;
  }

  if (!rows.length) {
    analyticsRosterList.innerHTML = `<div class="analytics-empty">${mode.empty}</div>`;
    return;
  }

  const isQa = rosterMode === "qa";

  // A header row plus one row per person, all on the same grid track list, so
  // the counts line up into columns.
  const body = rows.map((row) => {
    const approved = Number(row.approved_count) || 0;
    const rejected = Number(row.rejected_count) || 0;
    // Total sent and awaiting both belong to a writer's own output. A QA row
    // counts verdicts recorded — it never sent anything and "not yet decided"
    // belongs to nobody in particular — hence the dashes.
    const sent = Number(row.sent_count) || 0;
    const awaiting = Number(row.pending_count) || 0;
    // Writers count posts created today; QA rows count verdicts recorded
    // today. Both values come from the same India-midnight SQL window.
    const today = Number(row.today_count) || 0;
    // Share of what they uploaded that QA cleared. Derived from the two numbers
    // in the row rather than the server's approval_rate so it can never
    // disagree with the columns either side of it. A writer with nothing sent
    // has no rate — 0% would read as a verdict nobody made.
    const rate = sent ? Math.round((approved / sent) * 100) : null;
    /* Output over the last seven days. A lifetime total tells you who has
       been here longest; this tells you who is producing now, which is the
       question anyone actually asks of a roster. The arrow compares it with
       the seven days before, so a number that is falling says so. */
    const week = Number(row.week_count) || 0;
    const prevWeek = Number(row.prev_week_count) || 0;
    const trend = week > prevWeek ? "up" : week < prevWeek ? "down" : "flat";
    const trendMark = trend === "up" ? "↑" : trend === "down" ? "↓" : "";
    const weekTitle = `${week} this week vs ${prevWeek} the week before`;
    const name = escapeRosterText(row.user_name || (isQa ? "Unknown QA" : "Unknown writer"));
    return `
      <div class="roster-row">
        <span class="roster-avatar">${escapeRosterText(rosterInitials(row.user_name))}</span>
        <span class="roster-name" title="${name}">${name}</span>
        <span class="roster-cell roster-today" title="Resets at 12:00 AM IST">${formatCount(today)}</span>
        <span class="roster-cell roster-week is-${trend}" title="${weekTitle}">${formatCount(week)}${trendMark}</span>
        <!-- Writers are measured by what they handed over, reviewers by what
             they actually put on the public site. Approving and publishing are
             different acts — a reviewer can clear a queue and send none of it —
             and this column was an em dash for reviewers because there was
             nothing to put in it until the ledger existed. -->
        <span class="roster-cell roster-sent"${isQa ? ' title="From the publish ledger — earlier publishes only left an approval behind"' : ""}>${
          isQa ? formatCount(Number(row.published_count) || 0) : formatCount(sent)
        }</span>
        <span class="roster-cell roster-approved">${formatCount(approved)}</span>
        <span class="roster-cell roster-rejected">${formatCount(rejected)}</span>
        <span class="roster-cell roster-awaiting">${isQa ? "—" : formatCount(awaiting)}</span>
        <span class="roster-cell roster-rate">${isQa || rate === null ? "—" : `${rate}%`}</span>
      </div>
    `;
  }).join("");

  analyticsRosterList.innerHTML = `
    <div class="roster-row roster-head-row">
      <span></span>
      <span>${isQa ? "Reviewer" : "Writer"}</span>
      <span class="roster-cell" title="Resets at 12:00 AM IST">Today</span>
      <span class="roster-cell">This week</span>
      <span class="roster-cell">${isQa ? "Published" : "Total sent"}</span>
      <span class="roster-cell">Approved</span>
      <span class="roster-cell">Rejected</span>
      <span class="roster-cell">Pending</span>
      <span class="roster-cell">Approved %</span>
    </div>
    ${body}
  `;
}

function setWriterRoster(rows, qaRows, awaitingTotal = 0) {
  writerRoster = Array.isArray(rows) ? rows : [];
  qaRoster = Array.isArray(qaRows) ? qaRows : [];
  rosterAwaitingTotal = Number(awaitingTotal) || 0;
  renderWriterRoster();
}

function toggleWriterRoster(force = null) {
  if (!analyticsRosterToggle || !analyticsRosterBody) return;
  const open = force === null ? analyticsRosterBody.hidden : force;
  analyticsRosterBody.hidden = !open;
  analyticsRosterToggle.setAttribute("aria-expanded", String(open));
}

if (analyticsRosterToggle) {
  analyticsRosterToggle.addEventListener("click", () => toggleWriterRoster());
}

document.querySelectorAll("[data-roster-mode]").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    // Keep this event local to the mode switch; the nearby expand button owns
    // the separate show/hide action.
    event.stopPropagation();
    rosterMode = btn.dataset.rosterMode === "qa" ? "qa" : "writers";
    document.querySelectorAll("[data-roster-mode]").forEach((other) => {
      const active = other === btn;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-pressed", String(active));
    });
    renderWriterRoster();
    toggleWriterRoster(true);
  });
});

/* ── Source, category and date-range filters ──
   These narrow the SQL rollups, so every change is a refetch rather than a
   re-render.

   The options are the sections DailyMattr actually publishes into, in the
   editorial order loadSectionOptions() already resolved — the same list, and
   the same ids, the writer files under. Nothing is hard-coded here: a rename or
   a renumber on their side flows through without touching this. */
function sourceOptionEls() {
  return analyticsSourceMenu ? [...analyticsSourceMenu.querySelectorAll("[data-value]")] : [];
}

function fillSourceOptions(sources = []) {
  if (!analyticsSourceMenu) return;

  const rows = [
    { value: "all", label: "All sources" },
    ...(sources || []).map((source) => ({
      value: String(source.value || "").toLowerCase(),
      label: String(source.value || ""),
    })).filter((source) => source.value),
  ];
  if (analyticsFilters.source !== "all" && !rows.some((row) => row.value === analyticsFilters.source)) {
    rows.push({ value: analyticsFilters.source, label: analyticsFilters.source });
  }

  analyticsSourceMenu.innerHTML = rows.map(({ value, label }) => `
    <li class="analytics-select-option" role="option" tabindex="-1"
        data-value="${escapeRosterText(value)}" aria-selected="false">${escapeRosterText(label)}</li>
  `).join("");
  setSourceValue(analyticsFilters.source, { refetch: false });
}

function setSourceValue(value, { refetch = true } = {}) {
  const options = sourceOptionEls();
  const chosen = options.find((el) => el.dataset.value === value) || options[0];
  if (!chosen) return;

  options.forEach((el) => el.setAttribute("aria-selected", String(el === chosen)));
  if (analyticsSourceLabel) analyticsSourceLabel.textContent = chosen.textContent;

  const next = chosen.dataset.value;
  const changed = analyticsFilters.source !== next;
  analyticsFilters.source = next;
  syncAnalyticsFilterSummary();
  if (refetch && changed) loadAnalytics({ force: true });
}

function categoryOptionEls() {
  return analyticsCategoryMenu ? [...analyticsCategoryMenu.querySelectorAll("[data-value]")] : [];
}

function fillCategoryOptions(categories = sectionCategories) {
  if (!analyticsCategoryMenu) return;

  const rows = [
    { value: "all", label: "All categories" },
    ...(categories || []).map((c) => ({ value: String(c.id), label: String(c.name) })),
    { value: UNCATEGORISED, label: "Uncategorised" },
  ];

  analyticsCategoryMenu.innerHTML = rows.map(({ value, label }) => {
    const safeValue = escapeRosterText(value);
    return `<li class="analytics-select-option" role="option" tabindex="-1"
                data-value="${safeValue}" aria-selected="false">${escapeRosterText(label)}</li>`;
  }).join("");

  // A category can disappear between loads (the last post under it was
  // recategorised); falling back to "all" beats leaving the filter on a value
  // that is no longer selectable.
  const current = analyticsFilters.category;
  setCategoryValue(rows.some((row) => row.value === current) ? current : "all", { refetch: false });
}

function setCategoryValue(value, { refetch = true } = {}) {
  const options = categoryOptionEls();
  const chosen = options.find((el) => el.dataset.value === value) || options[0];
  if (!chosen) return;

  options.forEach((el) => el.setAttribute("aria-selected", String(el === chosen)));
  if (analyticsCategoryLabel) analyticsCategoryLabel.textContent = chosen.textContent;

  const next = chosen.dataset.value;
  const changed = analyticsFilters.category !== next;
  analyticsFilters.category = next;
  syncAnalyticsFilterSummary();
  if (refetch && changed) loadAnalytics({ force: true });
}

function openSourceMenu() {
  if (!analyticsSourceMenu || !analyticsSourceTrigger) return;
  closeCategoryMenu();
  const below = window.innerHeight - analyticsSourceTrigger.getBoundingClientRect().bottom - 24;
  analyticsSourceMenu.style.maxHeight = `${Math.max(140, Math.min(280, below))}px`;
  analyticsSourceMenu.classList.add("is-open");
  analyticsSourceTrigger.setAttribute("aria-expanded", "true");
  sourceOptionEls().find((el) => el.getAttribute("aria-selected") === "true")
    ?.scrollIntoView({ block: "nearest" });
}

function closeSourceMenu({ focusTrigger = false } = {}) {
  if (!analyticsSourceMenu || !analyticsSourceTrigger) return;
  analyticsSourceMenu.classList.remove("is-open");
  analyticsSourceTrigger.setAttribute("aria-expanded", "false");
  if (focusTrigger) analyticsSourceTrigger.focus();
}

function sourceMenuIsOpen() {
  return analyticsSourceMenu?.classList.contains("is-open") === true;
}

function moveSourceFocus(step) {
  const options = sourceOptionEls();
  if (!options.length) return;
  const active = document.activeElement;
  const from = options.indexOf(active);
  const next = from === -1
    ? options.findIndex((el) => el.getAttribute("aria-selected") === "true")
    : from + step;
  const index = Math.max(0, Math.min(options.length - 1, next === -1 ? 0 : next));
  options[index].focus();
  options[index].scrollIntoView({ block: "nearest" });
}

/* The menu opens downward and is never allowed to cover its own trigger: it is
   capped to the room actually left below, and scrolls internally past that. */
function openCategoryMenu() {
  if (!analyticsCategoryMenu || !analyticsCategoryTrigger) return;
  closeSourceMenu();
  const below = window.innerHeight - analyticsCategoryTrigger.getBoundingClientRect().bottom - 24;
  analyticsCategoryMenu.style.maxHeight = `${Math.max(140, Math.min(280, below))}px`;
  analyticsCategoryMenu.classList.add("is-open");
  analyticsCategoryTrigger.setAttribute("aria-expanded", "true");
  const selected = categoryOptionEls().find((el) => el.getAttribute("aria-selected") === "true");
  selected?.scrollIntoView({ block: "nearest" });
}

function closeCategoryMenu({ focusTrigger = false } = {}) {
  if (!analyticsCategoryMenu || !analyticsCategoryTrigger) return;
  analyticsCategoryMenu.classList.remove("is-open");
  analyticsCategoryTrigger.setAttribute("aria-expanded", "false");
  if (focusTrigger) analyticsCategoryTrigger.focus();
}

function categoryMenuIsOpen() {
  return analyticsCategoryMenu?.classList.contains("is-open") === true;
}

/* Roving focus through the options, so the list is usable without a mouse. */
function moveCategoryFocus(step) {
  const options = categoryOptionEls();
  if (!options.length) return;
  const active = document.activeElement;
  const from = options.indexOf(active);
  const next = from === -1
    ? options.findIndex((el) => el.getAttribute("aria-selected") === "true")
    : from + step;
  const index = Math.max(0, Math.min(options.length - 1, next === -1 ? 0 : next));
  options[index].focus();
  options[index].scrollIntoView({ block: "nearest" });
}

if (analyticsSourceTrigger) {
  analyticsSourceTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (sourceMenuIsOpen()) closeSourceMenu();
    else { openSourceMenu(); moveSourceFocus(0); }
  });

  analyticsSourceTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openSourceMenu();
    moveSourceFocus(0);
  });
}

if (analyticsSourceMenu) {
  analyticsSourceMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    event.stopPropagation();
    setSourceValue(option.dataset.value);
    closeSourceMenu({ focusTrigger: true });
  });

  analyticsSourceMenu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); moveSourceFocus(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveSourceFocus(-1); }
    else if (event.key === "Home") { event.preventDefault(); sourceOptionEls()[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); sourceOptionEls().pop()?.focus(); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = event.target.closest("[data-value]");
      if (!option) return;
      setSourceValue(option.dataset.value);
      closeSourceMenu({ focusTrigger: true });
    } else if (event.key === "Escape" || event.key === "Tab") {
      closeSourceMenu({ focusTrigger: event.key === "Escape" });
    }
  });
}

if (analyticsCategoryTrigger) {
  analyticsCategoryTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (categoryMenuIsOpen()) closeCategoryMenu();
    else { openCategoryMenu(); moveCategoryFocus(0); }
  });

  analyticsCategoryTrigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openCategoryMenu();
    moveCategoryFocus(0);
  });
}

if (analyticsCategoryMenu) {
  analyticsCategoryMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    event.stopPropagation();
    setCategoryValue(option.dataset.value);
    closeCategoryMenu({ focusTrigger: true });
  });

  analyticsCategoryMenu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); moveCategoryFocus(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveCategoryFocus(-1); }
    else if (event.key === "Home") { event.preventDefault(); categoryOptionEls()[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); categoryOptionEls().pop()?.focus(); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = event.target.closest("[data-value]");
      if (!option) return;
      setCategoryValue(option.dataset.value);
      closeCategoryMenu({ focusTrigger: true });
    } else if (event.key === "Escape" || event.key === "Tab") {
      closeCategoryMenu({ focusTrigger: event.key === "Escape" });
    }
  });
}

// Clicking anywhere else dismisses whichever dashboard menu is open.
document.addEventListener("click", () => {
  if (sourceMenuIsOpen()) closeSourceMenu();
  if (categoryMenuIsOpen()) closeCategoryMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sourceMenuIsOpen()) closeSourceMenu({ focusTrigger: true });
  if (event.key === "Escape" && categoryMenuIsOpen()) closeCategoryMenu({ focusTrigger: true });
});

if (analyticsRangeApply) {
  analyticsRangeApply.addEventListener("click", () => {
    analyticsFilters.from = analyticsFrom?.value || "";
    analyticsFilters.to = analyticsTo?.value || "";
    syncAnalyticsFilterSummary();
    loadAnalytics({ force: true });
  });
}

if (analyticsRangeClear) {
  analyticsRangeClear.addEventListener("click", () => {
    if (analyticsFrom) analyticsFrom.value = "";
    if (analyticsTo) analyticsTo.value = "";
    analyticsFilters.source = "all";
    analyticsFilters.category = "all";
    setSourceValue("all", { refetch: false });
    setCategoryValue("all", { refetch: false });
    analyticsFilters.from = "";
    analyticsFilters.to = "";
    syncAnalyticsFilterSummary();
    loadAnalytics({ force: true });
  });
}

/* Recent posts, each naming its writer and opening on click.

   The leaderboards answer "who is producing"; this answers "who wrote that
   one". Rows are built with DOM nodes rather than innerHTML so headlines and
   names cannot inject markup — the boards above needed escapeHtml precisely
   because they take the string route. */
let analyticsRecentRows = [];

/* The Refresh button was never wired — it had three references in the file and
   not one of them was an event listener, so clicking it did nothing at all. */
if (analyticsRefreshBtn) {
  analyticsRefreshBtn.addEventListener("click", () => loadAnalytics({ force: true }));
}
document.getElementById("analytics-search")?.addEventListener("input", () => renderAnalyticsRecent());

function renderAnalyticsRecent() {
  const container = document.getElementById("analytics-recent");
  if (!container) return;
  const term = (document.getElementById("analytics-search")?.value || "").trim().toLowerCase();
  const rows = term
    ? analyticsRecentRows.filter((r) =>
      `${r.headline || ""} ${r.user_name || ""}`.toLowerCase().includes(term))
    : analyticsRecentRows;

  container.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "analytics-empty";
    empty.textContent = analyticsRecentRows.length ? "No posts match that filter." : "No posts yet.";
    container.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "analytics-recent-row" + (row.approved ? " is-approved" : "");
    item.title = "Open this post";

    const main = document.createElement("div");
    main.className = "analytics-recent-main";
    const title = document.createElement("span");
    title.className = "analytics-recent-title";
    title.textContent = row.headline || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "analytics-recent-meta";
    meta.textContent = [
      row.user_name || "Unknown writer",
      formatLibraryDate(row.created_at),
      row.approved && row.approved_by_name ? `approved by ${row.approved_by_name}` : "",
    ].filter(Boolean).join(" · ");
    main.append(title, meta);

    const pill = document.createElement("span");
    /* Draft outranks the verdict in the label: an unsubmitted post has no
       verdict to report, and calling it "Pending" would say it is waiting on
       QA when QA cannot even see it. */
    const isDraft = Boolean(row.is_draft);
    pill.className = "status-pill" + (isDraft ? " is-draft" : row.approved ? " is-approved" : "");
    pill.textContent = isDraft ? "Draft" : row.approved ? "Approved" : "Pending";

    item.append(main, pill);
    item.addEventListener("click", () => {
      setView("poster");
      openSavedPost(row.id);
    });
    container.appendChild(item);
  }
}

async function loadAnalytics({ force = false } = {}) {
  if (!analyticsView || !state.user) return;
  if (!canReviewRole(state.user.role)) return;
  if (!force && analyticsLoadedForRole === state.user.role) return;

  if (analyticsRefreshBtn) analyticsRefreshBtn.disabled = true;
  analyticsView.setAttribute("aria-busy", "true");
  setAnalyticsStatus("Loading analytics…");

  const query = new URLSearchParams();
  if (analyticsFilters.source && analyticsFilters.source !== "all") {
    query.set("source", analyticsFilters.source);
  }
  if (analyticsFilters.category && analyticsFilters.category !== "all") {
    query.set("category", analyticsFilters.category);
  }
  if (analyticsFilters.from) query.set("from", analyticsFilters.from);
  if (analyticsFilters.to) query.set("to", analyticsFilters.to);
  const url = query.toString() ? `${PIX_ANALYTICS_ENDPOINT}?${query}` : PIX_ANALYTICS_ENDPOINT;

  try {
    const response = await fetch(url, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setAnalyticsStatus(payload.error || `Could not load analytics (${response.status}).`, "error");
      return;
    }

    const role = payload.role || state.user.role || "writer";
    const analytics = payload.analytics || {};
    analyticsLoadedForRole = role;

    analyticsRecentRows = Array.isArray(analytics.recent) ? analytics.recent : [];
    renderAnalyticsRecent();

    // Sections may not have loaded yet on the first analytics open; refill from
    // whatever loadSectionOptions() has by now so the picker is never empty.
    fillCategoryOptions();
    fillSourceOptions(analytics.sources || []);
    // The server is the authority on what it actually applied — a backwards
    // range comes back swapped and invalid filters are dropped, so the controls
    // have to follow it.
    if (payload.filters) {
      setSourceValue(payload.filters.source || "all", { refetch: false });
      setCategoryValue(payload.filters.category || "all", { refetch: false });
      analyticsFilters.from = payload.filters.from || "";
      analyticsFilters.to = payload.filters.to || "";
      if (analyticsFrom) analyticsFrom.value = analyticsFilters.from;
      if (analyticsTo) analyticsTo.value = analyticsFilters.to;
      syncAnalyticsFilterSummary();
    }

    renderAnalyticsSummary(analytics.summary, role);
    renderAnalyticsDaily(analytics.daily);
    renderAnalyticsMeta(analytics.summary, role);

    /* "full" gets the team roster and the reviewer table — both QA and admin
       now, since QA works the queue and needs to see whose posts are piling
       up. The server decides which it sent and says so, rather than the
       client inferring it from the role: the two could otherwise disagree and
       render a roster the payload does not contain. */
    if ((payload.scope || "full") === "full" && canReviewRole(role)) {
      setWriterRoster(analytics.writers || [], analytics.qas || [], analytics.summary?.pending_count || 0);
    } else {
      setWriterRoster([{
        user_name: state.user.displayName || state.user.username || "You",
        sent_count: analytics.summary?.sent_count || 0,
        approved_count: analytics.summary?.approved_count || 0,
        rejected_count: analytics.summary?.rejected_count || 0,
        pending_count: analytics.summary?.pending_count || 0,
        today_count: analytics.daily?.sent_count || 0,
      }], [{
        user_name: "QA desk",
        approved_count: analytics.summary?.approved_count || 0,
        rejected_count: analytics.summary?.rejected_count || 0,
        today_count: (analytics.daily?.approved_count || 0) + (analytics.daily?.rejected_count || 0),
      }], analytics.summary?.pending_count || 0);
    }

    if (analyticsUpdated) {
      analyticsUpdated.textContent = `Updated ${new Intl.DateTimeFormat("en-IN", {
        hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
      }).format(new Date())} IST`;
    }
    setAnalyticsStatus("");
  } catch (err) {
    setAnalyticsStatus(err.message || "Could not load analytics.", "error");
  } finally {
    if (analyticsRefreshBtn) analyticsRefreshBtn.disabled = false;
    analyticsView.removeAttribute("aria-busy");
  }
}

/* ═══════════════════════ View switcher (Poster | Article) ═══════════════════════ */

const viewTabs = document.getElementById("view-tabs");
const articleView = document.getElementById("article-view");
const reviewView = document.getElementById("review-view");

/* ── Topbar title + breadcrumb ──
   The sidebar says where you are by highlight; the topbar says it in words,
   which is what makes a deep-linked or reloaded tab legible. Titles are
   role-agnostic except Review, whose label already flips between "Review" and
   "My posts" depending on who is signed in — reused here so the two never
   disagree. */
const CMS_VIEW_TITLES = {
  poster:    { title: "Create a Pix", crumb: "Create Pix" },
  article:   { title: "Article Writer", crumb: "Article" },
  review:    { title: "Review", crumb: "Review" },
  analytics: { title: "Analytics", crumb: "Analytics" },
  writers:   { title: "Content Writers", crumb: "Writers" },
};

function syncCmsHeader(view) {
  const meta = CMS_VIEW_TITLES[view] || CMS_VIEW_TITLES.poster;
  const titleEl = document.getElementById("cms-page-title");
  const crumbEl = document.getElementById("cms-crumb-current");
  const reviewLabel = document.getElementById("review-tab-label")?.textContent?.trim();
  const title = view === "review" && reviewLabel ? reviewLabel : meta.title;
  if (titleEl) titleEl.textContent = title;
  if (crumbEl) crumbEl.textContent = view === "review" && reviewLabel ? reviewLabel : meta.crumb;
}

/* ── Action bar proxies ──
   The footer buttons forward their click to the original control rather than
   duplicating its logic. Every handler, guard and disabled state written for
   those buttons keeps working, and there is still exactly one implementation
   of Save, Publish and Reject. Disabled/hidden state is mirrored back so a
   proxy can never offer something its target refuses. */
document.addEventListener("click", (e) => {
  const proxy = e.target.closest("[data-proxy]");
  if (!proxy) return;
  const target = document.getElementById(proxy.dataset.proxy);
  if (!target || target.disabled) return;
  /* Save is the one proxy that cannot forward through target.click(): the
     topbar drives the same button with two different meanings ("Save draft"
     and, for a writer, "Submit"). This used to stamp the intent onto the
     target — and never cleared it. #save-pix-btn carries no data-intent of
     its own, so after a single Submit the in-editor Save button meant Submit
     for the life of the page, and a writer could not stamp it back because
     syncPrimaryAction() hides the only "draft" proxy from them. That is how a
     half-written story reached QA's queue while it was still being typed.
     The intent is now an argument, so it lives exactly as long as the click. */
  if (target.id === "save-pix-btn") {
    runSave(proxy.dataset.intent || "draft");
    return;
  }
  target.click();
});

setInterval(() => {
  for (const proxy of document.querySelectorAll("[data-proxy]")) {
    const target = document.getElementById(proxy.dataset.proxy);
    if (!target) continue;
    proxy.disabled = Boolean(target.disabled);
    /* A proxy hidden by ROLE stays hidden. Mirroring the target's own hidden
       flag unconditionally was undoing that every 500ms — Save draft kept
       reappearing for writers, because the button it proxies is not itself
       hidden, only irrelevant to them. */
    if (proxy.dataset.roleHidden === "true") { proxy.hidden = true; continue; }
    proxy.hidden = Boolean(target.hidden);
  }
}, 500);

/* The footer's own saved indicator. Autosave writes silently by design, so
   without this the only sign anything happened was a status line three
   columns away. */
const cmsAutosave = document.getElementById("cms-autosave");
const cmsAutosaveText = document.getElementById("cms-autosave-text");
let cmsAutosaveTimer = null;

function showAutosaved(label) {
  if (!cmsAutosave) return;
  if (cmsAutosaveText) cmsAutosaveText.textContent = label;
  cmsAutosave.hidden = false;
  clearTimeout(cmsAutosaveTimer);
  cmsAutosaveTimer = setTimeout(() => { cmsAutosave.hidden = true; }, 6000);
}

/* ── The primary action is not the same job for both roles ──

   A writer cannot publish at all — the server returns 403 — so a "Publish"
   button was offering them an action that could only fail. What they actually
   do is hand the post to QA, which is what saving does. So for a writer the
   primary button says Submit and drives the save, and the separate Save draft
   is dropped: with only one action, two buttons doing the same thing is just
   a question the writer has to answer for no reason.

   QA and admin keep Publish, wired to the DailyMattr publish. */
function syncPrimaryAction() {
  const primary = document.querySelector('.cms-topbar-actions .btn-primary');
  const draft = document.querySelector('.cms-topbar-actions [data-proxy="save-pix-btn"]');
  if (!primary || !state.user) return;
  const reviewer = canReviewRole(state.user.role);
  primary.textContent = reviewer ? "Publish" : "Submit";
  primary.dataset.proxy = reviewer ? "dailymattr-publish-btn" : "save-pix-btn";
  primary.dataset.intent = "submit";        // Submit hands the post to QA
  primary.title = reviewer
    ? "Publish this pix to the web app"
    : "Save and send to QA for review";
  if (draft) {
    draft.dataset.roleHidden = reviewer ? "false" : "true";
    draft.hidden = !reviewer;
  }
  /* Last, so it can override the "Publish" just written above for a post that
     is already live. Running it the other way round would leave the topbar
     offering an action the panel below it has disabled. */
  syncPublishState();
}

/* ── Collapsing the rail ──
   Icons rather than nothing: hiding it outright would leave no way back
   except a control floating over the content, and no sense of where you are.
   The choice is remembered, because a collapsed rail is a working preference
   about screen space, not a per-page state. */
const navCollapseBtn = document.getElementById("nav-collapse");

function setNavCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  localStorage.setItem("pix-nav-collapsed", collapsed ? "1" : "0");
  if (navCollapseBtn) {
    navCollapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    navCollapseBtn.setAttribute("aria-label", collapsed ? "Expand the navigation" : "Collapse the navigation");
    navCollapseBtn.title = collapsed ? "Expand" : "Collapse";
  }
  // The poster canvas is sized from its column, which just changed width.
  requestAnimationFrame(() => { try { renderPoster(); } catch {} });
}

setNavCollapsed(localStorage.getItem("pix-nav-collapsed") === "1");
navCollapseBtn?.addEventListener("click", () =>
  setNavCollapsed(!document.body.classList.contains("nav-collapsed")));

/* ── Keeping the tally true across tabs ──

   The count is a fact about the database, not about this tab, and writers
   work in several at once — scrape in one, write in another, keep a third on
   My posts. An event-driven refresh only ever knew about saves made HERE, so
   every other tab drifted and stayed drifted until someone reloaded it. It
   also went stale on its own overnight: the "today" figure is relative to the
   IST day, so a tab left open past midnight kept yesterday's number.

   Three signals, cheapest first:

   1. Same-browser tabs tell each other directly. BroadcastChannel makes a
      save in one tab land in the others within a frame, so the common case —
      two tabs, one person — needs no polling at all.
   2. Coming back to a tab re-reads. This is when a stale number is actually
      SEEN, and it also covers what a broadcast cannot: a second browser, a
      phone, or a colleague's verdict on your post.
   3. A slow poll underneath, for a tab sitting visible and untouched — a
      writer watching their own count while a reviewer works through the
      queue. 60s, because this is an ornament, not a live feed. */
/* Identifies this tab so a broadcast can be told apart from its own echo.
   crypto.randomUUID is not available on http:// origins in some browsers,
   hence the fallback — the value only has to be unique among open tabs.

   Declared BEFORE the listener that reads it. The callback is deferred so the
   other order would run correctly, but a `const` referenced above its own
   declaration is exactly the shape of the temporal-dead-zone crash this file
   has hit before, and it is not worth leaving for someone to re-derive. */
const PIX_TAB_ID = (crypto.randomUUID?.() || String(Math.random()).slice(2));

/* The most recent /api/pix/stats answer. Today and this week are counted
   across the whole library by the server; the list on screen is capped at 200
   rows, so deriving them from it would quietly under-report for anyone busy
   enough to need the number. */
let lastPixCounts = null;

const pixCountChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("pix-counts") : null;

pixCountChannel?.addEventListener("message", (e) => {
  // Ignore our own echo; a save here already refreshed directly.
  if (e.data?.tab !== PIX_TAB_ID) refreshMyPixCount();
});

function announceCountChange() {
  try { pixCountChannel?.postMessage({ tab: PIX_TAB_ID, at: Date.now() }); } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshMyPixCount();
});
window.addEventListener("focus", () => refreshMyPixCount());

setInterval(() => {
  // A hidden tab is not being read, and a signed-out one has nothing to count.
  if (document.visibilityState === "visible" && state.user) refreshMyPixCount();
}, 60_000);

const cmsToday = document.getElementById("cms-today");
if (cmsToday) {
  cmsToday.textContent = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function setView(view) {
  // Signed out, there is nothing to list.
  if ((view === "review" || view === "analytics" || view === "writers") && !state.user) view = "poster";
  // Analytics and Writers are QA-only; a writer landing here (stale tab, deep
  // link) goes home. The server refuses them too — this is only the redirect.
  if (view === "analytics" && !canReviewRole(state.user?.role)) view = "poster";
  // The roster is the admin's screen; QA landing here (stale tab, deep link)
  // goes home. The server refuses it too.
  if (view === "writers" && !isAdminRole(state.user?.role)) view = "poster";

  document.body.classList.toggle("view-article", view === "article");
  document.body.classList.toggle("view-review", view === "review");
  document.body.classList.toggle("view-analytics", view === "analytics");
  document.body.classList.toggle("view-writers", view === "writers");
  if (articleView) articleView.hidden = view !== "article";
  if (reviewView) reviewView.hidden = view !== "review";
  if (analyticsView) analyticsView.hidden = view !== "analytics";
  if (writersView) writersView.hidden = view !== "writers";
  if (viewTabs) {
    viewTabs.querySelectorAll(".view-tab").forEach(t => {
      const active = t.dataset.view === view;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  syncCmsHeader(view);
  // The mobile edit sheet makes no sense away from the poster — drop it
  if (view !== "poster") setSheetOpen(false);
  if (view === "review") loadReviewQueue();
  if (view === "analytics") loadAnalytics({ force: true });
  if (view === "writers") loadWriters();
}

if (viewTabs) {
  viewTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab");
    if (tab) setView(tab.dataset.view);
  });
}

/* ═══════════════════════ AI Article Writer ═══════════════════════ */

const articleGenerateBtn = document.getElementById("article-generate-btn");
const articleStatus      = document.getElementById("article-status");
const articleResult      = document.getElementById("article-result");

function setArticleStatus(msg, kind) {
  if (!articleStatus) return;
  articleStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  articleStatus.textContent = msg || "";
}

/**
 * Generate the article package and fill the slides with it.
 *
 * `applyToSlides` is what closes the loop that used to be missing: the writer
 * produced a headline and bullets that only ever landed in the Article tab and
 * the clipboard, so the poster still showed the raw scraped title and the Text
 * slide still showed the raw scraped paragraph. Now one action fills both.
 */
async function generateArticle({ applyToSlides = false } = {}) {
  const headline = (state.headline || "").trim();
  if (!headline) {
    setArticleStatus("No story yet — scrape a link or write a headline first.", "error");
    return null;
  }

  if (articleGenerateBtn) articleGenerateBtn.disabled = true;
  setArticleStatus("Writing headline, bullets and tweet…");

  try {
    const resp = await fetch("/api/generate-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headline,
        sourceUrl: state.sourceUrl || "",
        // Pass the text we already scraped so the server does not re-fetch.
        articleText: state.articleText || state.detailText || "",
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    renderArticle(data);
    state.article = data;
    syncXComposerLink();

    if (applyToSlides) {
      // The writer can be typing while this request is in flight — the scrape
      // fires it and it lands ~10s later. Overwriting an edit made in that
      // window silently threw it away, and [highlight brackets] added right
      // after a scrape were the usual casualty.
      if (data.headline && !state.headlineTouched) {
        state.headline = data.headline;
        if (headlineEdit) headlineEdit.value = data.headline;
        if (writeHeadline) writeHeadline.value = data.headline;
      }
      if (Array.isArray(data.bullets) && data.bullets.length && !state.detailTouched) {
        // Bulleted, one per line — drawPixTextScreen already renders a
        // bullet glyph for lines starting with a dash.
        const block = data.bullets.map((b) => `- ${b}`).join("\n");
        state.detailText = limitDetailTextClient(block);
        if (detailEdit) detailEdit.value = state.detailText;
        if (writeDetail) writeDetail.value = state.detailText;
      }
      renderPoster();
    }

    // Thin sources produce thin bullets; say so rather than let it look
    // like the writer underperformed.
    const thin = data.sourceChars !== undefined && data.sourceChars < 200;
    setArticleStatus(
      thin
        ? "✓ Done — but little source text was found, so the points are general. Check the article link."
        : "✓ Done — review before publishing.",
      thin ? "error" : "success"
    );
    return data;
  } catch (err) {
    setArticleStatus(`Generation failed: ${err.message}`, "error");
    return null;
  } finally {
    if (articleGenerateBtn) articleGenerateBtn.disabled = false;
  }
}

if (articleGenerateBtn) {
  articleGenerateBtn.addEventListener("click", () => generateArticle({ applyToSlides: true }));
}

function renderArticle({ headline, bullets, tweet, flags, spec }) {
  // The editorial spec travels with the payload, so these numbers live in
  // exactly one place (server.mjs). Fallbacks only matter for a cached
  // response from an older deploy.
  const HEADLINE_MAX_CHARS = spec?.headlineMax ?? 90;
  const BULLET_MIN_CHARS   = spec?.bulletMin   ?? 115;
  const BULLET_MAX_CHARS   = spec?.bulletMax   ?? 125;

  const headEl   = document.getElementById("article-headline");
  const bulletEl = document.getElementById("article-bullets");
  const tweetEl  = document.getElementById("article-tweet");
  const flagsBlk = document.getElementById("article-flags-block");
  const flagsEl  = document.getElementById("article-flags");

  headEl.textContent = headline;
  const headCount = document.getElementById("article-headline-count");
  headCount.textContent = `${headline.length} / ${HEADLINE_MAX_CHARS}`;
  headCount.classList.toggle("over", headline.length > HEADLINE_MAX_CHARS);

  // Per-bullet counts. The spec is a tight character band, so showing the
  // actual length per bullet is the only way to see at a glance whether the
  // model hit it — a total or an average would hide one bad bullet.
  bulletEl.innerHTML = "";
  bullets.forEach(b => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = b;
    const count = document.createElement("span");
    count.className = "bullet-count";
    count.textContent = b.length;
    const outOfBand = b.length < BULLET_MIN_CHARS || b.length > BULLET_MAX_CHARS;
    count.classList.toggle("over", outOfBand);
    count.title = outOfBand
      ? `${b.length} characters — outside the ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} target`
      : `${b.length} characters`;
    li.append(text, count);
    bulletEl.appendChild(li);
  });

  tweetEl.textContent = tweet;
  const tweetCount = document.getElementById("article-tweet-count");
  tweetCount.textContent = `${tweet.length} / 280`;
  tweetCount.classList.toggle("over", tweet.length > 280);

  if (flags && flags.length) {
    flagsEl.innerHTML = "";
    flags.forEach(f => {
      const li = document.createElement("li");
      li.textContent = f;
      flagsEl.appendChild(li);
    });
    flagsBlk.hidden = false;
  } else {
    flagsBlk.hidden = true;
  }

  articleResult.hidden = false;
}

// Copy buttons — per-block and copy-all
function flashCopied(btn) {
  const prev = btn.textContent;
  btn.textContent = "Copied ✓";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1400);
}

document.querySelectorAll(".copy-btn[data-copy-target]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const el = document.getElementById(btn.dataset.copyTarget);
    if (!el) return;
    const text = el.tagName === "UL"
      ? [...el.querySelectorAll("li")].map(li => `• ${li.textContent}`).join("\n")
      : el.textContent;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(btn);
    } catch { /* clipboard denied */ }
  });
});

const copyAllBtn = document.getElementById("article-copy-all");
if (copyAllBtn) {
  copyAllBtn.addEventListener("click", async () => {
    const head    = document.getElementById("article-headline")?.textContent || "";
    const bullets = [...document.querySelectorAll("#article-bullets li")].map(li => `• ${li.textContent}`).join("\n");
    const tweet   = document.getElementById("article-tweet")?.textContent || "";
    const full = `${head}\n\n${bullets}\n\n${tweet}`;
    try {
      await navigator.clipboard.writeText(full);
      const prev = copyAllBtn.textContent;
      copyAllBtn.textContent = "✓ Copied everything";
      setTimeout(() => { copyAllBtn.textContent = prev; }, 1400);
    } catch { /* clipboard denied */ }
  });
}

/* ═══════════════════════ AI Enhance (gpt-image-1) ═══════════════════════ */

const aiEnhanceBtn    = document.getElementById("ai-enhance-btn");
const aiEnhanceStatus = document.getElementById("ai-enhance-status");

function setEnhanceStatus(msg, kind) {
  if (!aiEnhanceStatus) return;
  aiEnhanceStatus.className = "status-text" + (kind ? ` ${kind}` : "");
  aiEnhanceStatus.textContent = msg || "";
}

const enhanceModeSel    = document.getElementById("enhance-mode");
const expandAmountSel   = document.getElementById("expand-amount");
const expandAmountField = document.getElementById("expand-amount-field");
const enhanceModeHint   = document.getElementById("enhance-mode-hint");

/* Two jobs behind one button.

     restore  the photograph as it is framed, with detail recovered.
     expand   the photograph placed smaller in a wider frame, with the rest of
              the subject and the setting drawn outward into the margin — the
              zoom-out. A press photo cropped at the chest comes back with the
              body; a landscape photo comes back tall enough for a 9:16 poster
              instead of being cut to a strip by the canvas.

   Which one runs is normally the server's stage 1 to decide, from the
   photograph itself — see planEnhance() in server.mjs. The select is there for
   a reviewer who disagrees with a verdict.

   Everything around the call is identical either way — the snapshot, the page
   guard, the status line, the failure path — so there is one of it. What
   differs is the mode header, and what happens to the writer's framing when
   the picture lands. */
/* gpt-image's output ceiling on the long edge, and therefore the only size
   worth uploading. Both the skip gate and the upload cap below read it, so
   they cannot drift apart — the gate exists precisely because the cap is
   what makes a large photograph lose by going through here. */
/* Carry the server's classification across the throw. `new Error(msg)` keeps
   the words and drops everything else, so a safety refusal arrived at the
   catch indistinguishable from a crash — which is how it ends up presented as
   one. */
function enhanceError(payload, status) {
  const e = new Error(payload?.error || `HTTP ${status}`);
  if (payload?.moderated) e.moderated = true;
  if (payload?.detail) e.detail = payload.detail;
  return e;
}

const MODEL_CEILING_PX = 1536;
const RATIO_ASPECTS = { "9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9 };

/* The only aspects gpt-image can return: 1024x1024, 1024x1536, 1536x1024.
   Anything sent at a different shape comes back with the difference invented. */
const MODEL_SHAPES = [1, 1024 / 1536, 1536 / 1024];

/* Which of the three the picture is closest to, compared in LOG space.

   Ratios are multiplicative, so a linear comparison is asymmetric: against
   1.000 and 1.500, an aspect of 1.22 is 0.22 above one and 0.28 below the
   other and picks the square, while 1/1.22 = 0.82 — the same relationship,
   the other way up — sits 0.18 from 1.000 and 0.15 from 0.667 and picks the
   portrait. A photograph and the same photograph rotated should not resolve
   to differently-proportioned shapes. Log distance is symmetric and does not.

   Named, and out of the closure it was written in, because a shape decision
   that nothing can assert on has now shipped wrong three times in this file. */
function nearestModelShape(aspect) {
  if (!(aspect > 0) || !isFinite(aspect)) return 1;
  return MODEL_SHAPES.reduce((best, a) =>
    Math.abs(Math.log(a / aspect)) < Math.abs(Math.log(best / aspect)) ? a : best);
}

const ENHANCE_LABELS = {
  restore: { done: "Restored and upscaled", failed: "Restore failed" },
  expand:  { done: "Expanded and reframed", failed: "Expand failed" },
  reframe: { done: "Reframed to the poster's shape — the whole picture redrawn at 9:16", failed: "Reframe failed" },
};

const ENHANCE_WORKING = {
  auto:    "Reading the photograph, then either recovering detail or extending it to fill the frame (30–90s)…",
  restore: "Restoring and upscaling — analysing the photo, then recovering detail (30–90s)…",
  expand:  "Expanding — reading how the photo is cropped, then drawing the scene outward (30–90s)…",
  reframe: "Reframing — redrawing the whole picture at the poster's shape, high quality (60–120s)…",
};

/* Pull back is the distance to zoom out, and it only means anything when a
   reviewer has forced expand. On Auto the stage that picks the job picks the
   distance from the same look at the photograph, so leaving the control up
   would offer a choice nothing is reading. */
/* What each job actually does, in the reviewer's terms. This used to be one
   static sentence that said "It does not reframe, zoom out or generate
   anything past the edges" — true of restore, and the exact opposite of what
   Expand does, sitting under a selector that offers Expand. A reviewer who
   reads it before picking is told the wrong thing about the option they are
   about to pick, so it has to move with the selector. */
const ENHANCE_MODE_HINTS = {
  auto: "Runs Reframe & Upscale: the whole picture redrawn at the poster's shape, high quality. Uses paid AI credits.",
  restore: "Recovers detail at exactly the framing you set by REDRAWING the picture at up to 1536px — faces and fine detail come back recognisably the same, not pixel-identical, and a photo already above 1536px is left alone. Uses paid AI credits.",
  reframe: "The same thing as asking ChatGPT to 'upscale and reframe it to 9:16': one gpt-image-1.5 call at HIGH quality redraws the whole scene at the poster's shape, seamless, with more of the setting above and below. It is a regeneration — faces and fine detail come back recognisably the same, not pixel-identical. Use Expand to keep the photograph pinned exactly. About $0.33 a picture, measured — the uploaded photo is billed as well as the output.",
  expand: "Draws new scene outward past the edges of the photograph to fill the poster. The original is pinned in place by a mask, but the margin is generated — check the result before publishing. Costs more than Restore.",
};

function syncEnhanceModeUI() {
  const mode = enhanceModeSel?.value || "auto";
  if (expandAmountField) expandAmountField.hidden = mode !== "expand";
  if (enhanceModeHint) {
    enhanceModeHint.textContent = ENHANCE_MODE_HINTS[mode] || ENHANCE_MODE_HINTS.auto;
  }
}
if (enhanceModeSel) enhanceModeSel.addEventListener("change", syncEnhanceModeUI);
syncEnhanceModeUI();

/* ── Expand geometry: the browser's half of the fix ──────────────────────

   The reported bug was a ghost second image — the photograph shrunk into a
   hard-edged rectangle sitting in the middle of a larger, invented picture,
   so the card showed two images at once. It was not a rendering bug and not a
   compositing bug on this side. It was the expand prompt.

   Expanding a picture means placing it inside a bigger frame and drawing the
   rest. That placement used to be a SENTENCE in the prompt — "place the
   supplied photograph smaller within the output frame and draw the scene
   continuing outward". gpt-image reads that as what it says: it generates a
   scene, and it puts a picture in the middle of it. Every other rule in the
   prompt stayed satisfied while it did — no new people, no lettering, faithful
   to the source — because a photograph lying in a landscape breaks none of
   them.

   The geometry was never the model's job. It is arithmetic, and this side has
   the decoded pixels, so it is done here: the source is drawn into a canvas of
   exactly the output size, at exactly the position and scale it should keep,
   and the rest is left transparent. An alpha mask marks that transparent area
   as the only region the model may paint. The prompt then has no placement
   left to ask for — it only describes what fills the margin — and the model
   cannot move, rescale or re-render what it was handed.

   Three things now have to go wrong at once for a doubled image to come back,
   and the last of them is unconditional: the mask would have to be refused,
   the prompt's anti-ghost rules ignored, and the feathered paste-back below
   skipped. */

/* How much of the output frame should be margin, by area, per pull-back.
   Area rather than a linear percentage because that is what "show 50% more
   scene" actually means to someone looking at the result — a linear 0.5 leaves
   three quarters of the frame empty and shrinks the subject to a stamp. */
const EXPAND_MARGIN_AREA = { fit: 0, slight: 0.20, moderate: 0.35, wide: 0.50 };

/* Where the vertical margin goes, as the fraction of it that sits ABOVE the
   picture. Centred is the wrong answer for people: a subject cut at the chest
   needs the room below — that is where the torso, the arms and the lap are —
   and centring spends half of it on empty sky above a head. A scene or a
   graphic has no such asymmetry, so those stay centred. */
const EXPAND_TOP_BIAS = { people: 0.30, scene: 0.5, graphic: 0.5 };

function parseEnhanceSize(size) {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(String(size || ""));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/* ── The frame the model returns is NOT the frame the poster shows ─────────

   This is the arithmetic that was missing, and it is why an expand could come
   back correct and still land on the card with the subject cut off.

   gpt-image sells three shapes. A 9:16 poster resolves to 1024x1536, which is
   2:3 — taller than the picture the model draws but not as tall as the card.
   The card then does what it does to every image: covers the frame and clips
   the overflow. 1024x1536 into 920x1700 loses about a fifth of its width
   before the pan headroom is applied, and a quarter after.

   So the margin the model was paid to draw is not the part that gets cut.
   The picture is placed at contain scale — full frame width — and it is the
   picture's own left and right edges that go over the side. On a landscape
   photograph of two people, one at each end, that is one person per edge.

   The visible rect is knowable here: the layout preset gives the card's real
   dimensions and drawCoverImage's scale is fixed arithmetic. So it is
   computed, and the placement is planned inside it rather than inside the
   full model canvas. The generated margin absorbs the crop, which is what
   margin is for. */

/* The zoom an expanded frame is committed at.

   IMAGE_PAN_HEADROOM oversizes every image by 10% so there is something to
   pan with. That is right for a photograph the writer is framing by hand and
   wrong for a frame built to these exact dimensions thirty seconds ago: it
   spends a tenth of a purpose-built picture on slack nobody asked for.

   Ceiling, not floor. The zoom control carries whole percentages, and 90%
   puts the scale a hair UNDER cover — which does not crop the picture, it
   letterboxes it, leaving 17px of backdrop across the top and bottom of a
   9:16 card. A percent over is invisible; a percent under is a seam. */
const EXPAND_COMMIT_ZOOM = Math.ceil(100 / IMAGE_PAN_HEADROOM);

/* What of a `frameW × frameH` picture the poster actually shows, in that
   picture's own pixels, at the zoom an expand commits. Centred, because
   composeExpandResult() centres the frame's focal point for the same reason
   this function exists. */
function posterVisibleRect(frameW, frameH, zoomPct = EXPAND_COMMIT_ZOOM) {
  const L = getLayout();
  const scale =
    Math.max(L.W / frameW, L.H / frameH) * IMAGE_PAN_HEADROOM * (zoomPct / 100);
  const w = Math.min(frameW, L.W / scale);
  const h = Math.min(frameH, L.H / scale);
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h };
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the image."))),
      "image/png",
    );
  });
}

/* A data: URL, and it has to stay one.

   describeMainImage() reads `state.mainImage.src` to decide what a picture IS:
   a data: URL means an upload or an enhance, with no address until Save pushes
   it to storage, and anything else is treated as an address and recorded as
   one. A blob: URL would be filed as the image's permanent address and die
   with the tab.

   Encoded through toBlob rather than toDataURL because the composite is now
   several times larger than it was — toDataURL is synchronous and would hold
   the main thread for the whole PNG encode, freezing the editor at the very
   end of a call the reviewer has already waited a minute for. */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the enhanced image."));
    reader.readAsDataURL(blob);
  });
}

/* Collecting the enhanced picture from the address the server answered with.

   Stage 2 no longer sends the image back inside its own JSON. It sends a
   short same-origin URL and the bytes are fetched separately — because the
   old five-megabyte answer had to be flushed down a socket that had already
   been held open for the fifty seconds gpt-image took, and past sixty the
   platform proxy closed it. The picture was made and billed and thrown away;
   see "Where the finished picture is collected from" in server.mjs.

   It is turned back into a data: URL immediately, for the reason written
   above canvasToImage(): describeMainImage() reads the src to decide whether
   a picture still needs uploading on Save. Left as a URL, an enhanced photo
   would be filed as one that already has an address — and that address is a
   token that stops answering in an hour, so the post would publish and then
   quietly lose its picture.

   A data: URL is passed through untouched, so a server still answering the
   old way keeps working. */
async function collectEnhancedImage(src) {
  if (src.startsWith("data:")) return src;
  const resp = await fetch(src);
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try { detail = (await resp.json())?.error || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return await blobToDataUrl(await resp.blob());
}

async function canvasToImage(canvas) {
  const blob = await canvasToPng(canvas);
  const dataUrl = await blobToDataUrl(blob);
  return await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Enhanced image failed to load."));
    el.src = dataUrl;
  });
}

/* Where the picture sits inside the frame the model will be given.

   `safe` is the part of that frame the poster will actually show — see
   posterVisibleRect() above. Everything is measured against it rather than
   against the full canvas, so the picture is whole in the crop and not merely
   whole in the file. Omitted, it is the whole frame, which is the right answer
   when there is no poster to crop against and is what the geometry tests
   measure. */
function planExpandPlacement(srcW, srcH, frameW, frameH, amount, subject, safe) {
  const area = safe && safe.w > 0 && safe.h > 0
    ? safe
    : { x: 0, y: 0, w: frameW, h: frameH };

  // The largest the picture can be drawn without cropping any of it.
  const contain = Math.min(area.w / srcW, area.h / srcH);
  /* How much of the visible area that alone already leaves empty. This is the
     number the old prose prompt had no way to reason about: a landscape photo
     on a 9:16 frame is mostly margin before anything is pulled back at all,
     while a photo whose shape already matches the poster has none. */
  const filled = (srcW * contain * srcH * contain) / (area.w * area.h);
  const wantFilled = 1 - (EXPAND_MARGIN_AREA[amount] ?? EXPAND_MARGIN_AREA.moderate);
  /* Shrink only if the shape mismatch has not already delivered the margin.
     Pulling back further than asked costs resolution on the subject for
     nothing — the output is a fixed size, so every percent of frame the
     picture gives up is detail it does not get back. */
  const scale = contain * (filled > wantFilled ? Math.sqrt(wantFilled / filled) : 1);

  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const bias = EXPAND_TOP_BIAS[subject] ?? 0.5;

  return {
    frameW,
    frameH,
    w,
    h,
    x: Math.round(area.x + (area.w - w) / 2),
    y: Math.round(area.y + (area.h - h) * bias),
    /* The blend band, in frame pixels. The mask's opaque rectangle is inset by
       this much so the model may repaint the outermost sliver of the picture
       and feather its margin into it; the paste-back ramps across the same
       band. Without it the source ends on a hard line, and a hard line around
       a rectangle is a picture frame — which is the thing this whole file is
       trying not to draw. */
    band: Math.min(24, Math.max(4, Math.round(Math.min(w, h) * 0.02))),
    /* ── The soft boundary, and why a hard one drew a rectangle ──────────

       The photograph used to end on a hard line: the mask kept every pixel of
       it, and the paste-back laid it down at full alpha. Where the model's
       margin happened to match the photograph's tone the line was invisible;
       where it did not — a table drawn a shade darker below a bright one —
       the line ran the full width of the card, and the result read as a
       photograph lying on a scene. The rectangle, again.

       So the boundary is a STRIP, not a line. The mask fades across it, so
       the model is allowed to repaint the outermost `blend` pixels of the
       photograph and carry its own margin into them; and the paste-back
       fades the photograph in across the same strip, so its presence goes
       from nothing at the edge to everything `blend` pixels in. Whatever the
       model did with tone at the edge is crossed gradually, inside the
       picture, where its own detail hides the crossing.

       Eight percent of the short side — 39px on a 486px-tall photo in the
       1024x1536 frame, so real room for a tone shift to be spread over. The
       floor is twice the old band; the cap keeps a huge frame from eating a
       small subject. */
    blend: Math.min(120, Math.max(
      2 * Math.min(24, Math.max(4, Math.round(Math.min(w, h) * 0.02))),
      Math.round(Math.min(w, h) * 0.08),
    )),
  };
}

/* ── What actually goes up the wire on an expand ──────────────────────────

   THE MARGIN IS NOT TRANSPARENT, and that is the second half of the ghost fix.

   Sending a frame with a transparent margin looks like the obvious thing to
   do — here is the picture, here is the hole, fill the hole — and it is what
   caused the second report. Two things go wrong with it:

     · `background` on /v1/images/edits defaults to "auto", so handed an input
       with an alpha channel the model is entitled to answer with one. A
       returned PNG whose margin is still transparent draws, through
       drawCoverImage() (which lays down no backing fill), as the card's own
       pale backdrop with a hairline where the alpha edge was antialiased.
       That is the washed-out field with a thin white rectangle around the
       photo. The server now sends background="opaque" as well, but a client
       that never asks for transparency cannot be given it by accident.

     · An empty margin is a weak brief. Given a void the model produces
       low-confidence filler; given something to continue it continues it.

   So the margin is pre-filled with a blurred bleed: the same photograph
   scaled to cover the whole frame and blurred, with the sharp original laid
   over it at its rect. It is the fill every phone gallery uses to pad a photo
   into a taller frame, and it has two properties that matter here — its
   colour and light already match the picture, so it is a real starting point
   for the model; and if the model contributes nothing usable, what is left is
   a clean blurred bleed, which nobody has ever mistaken for a second image. */
function fillExpandBleed(ctx, srcCanvas, place) {
  const cover = Math.max(place.frameW / srcCanvas.width, place.frameH / srcCanvas.height);
  const w = srcCanvas.width * cover;
  const h = srcCanvas.height * cover;
  const x = (place.frameW - w) / 2;
  const y = (place.frameH - h) / 2;

  /* An UNBLURRED cover pass first, and it is not decoration.

     A canvas blur samples past the edge of what it is handed and fades it out,
     so a blurred pass on its own does not reach the frame's own borders at
     full alpha — on a 9:16 frame from a 4:3 source it left 112 transparent
     rows top and bottom. That is a hole, and a hole is the very thing this
     layer exists to prevent: it is what the model is entitled to answer with
     an alpha channel of its own, and what shows the card's backdrop through
     the poster. This pass is what makes the frame opaque. */
  ctx.drawImage(srcCanvas, x, y, w, h);

  // The soft pass on top is what makes it read as a bleed rather than as a
  // second, badly cropped copy of the photograph. Overdrawn by three blur
  // radii, which is where a Gaussian has nothing left to give, so it too
  // arrives at the edges at full strength.
  const blur = Math.max(8, Math.round(Math.min(place.frameW, place.frameH) * 0.05));
  const pad = blur * 3;
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(srcCanvas, x - pad, y - pad, w + pad * 2, h + pad * 2);
  ctx.restore();
}

function buildExpandFrame(srcCanvas, place) {
  const frame = document.createElement("canvas");
  frame.width = place.frameW;
  frame.height = place.frameH;
  const fctx = frame.getContext("2d");
  fillExpandBleed(fctx, srcCanvas, place);
  fctx.drawImage(srcCanvas, place.x, place.y, place.w, place.h);

  /* The mask still goes with it, but it is a HINT and the code no longer
     pretends otherwise.

     OpenAI have confirmed that gpt-image-1 does not inpaint the way dall-e-2
     did: the mask is applied as a soft mask and the whole image is recreated,
     so the opaque region is not preserved pixel-for-pixel and the model
     remains free to re-render the picture as an object sitting in a scene.
     It is still worth sending — it biases the edit toward the margin — but
     every guarantee in this file now comes from composeExpandResult() below,
     which does not ask the model for permission.

     Mask semantics are the opposite of what they look like: TRANSPARENT is
     where the model may paint, opaque is what it should leave alone. */
  const mask = document.createElement("canvas");
  mask.width = place.frameW;
  mask.height = place.frameH;
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#000";
  mctx.fillRect(place.x, place.y, Math.max(1, place.w), Math.max(1, place.h));
  /* Feathered inward over `blend`: fully editable at the photograph's edge,
     fully kept `blend` pixels in. gpt-image reads the mask as a soft mask,
     so this is what lets it blend its margin INTO the picture's edge rather
     than butting up against it — the half of the seam fix that happens on
     the model's side. See place.blend. */
  /* Over `band` — two percent — and not the wider `blend`. A wide feather
     hands the model a strip of the photograph to REDRAW, and it does: on the
     first live result it drew the rider's arm and helmet slightly differently
     inside the strip, and fading the original into that was a smeared band
     across the arm — a ghost, which is worse than a line. The feather here
     is only enough to soften the model's own edge. Tone continuity is
     handled on the margin's side, in matchMarginTone. */
  fadeEdgesInward(mctx, place.x, place.y, place.w, place.h, place.band);

  return { frame, mask };
}

/* Knock a canvas's alpha out across a strip inside a rect's edges: gone at the
   edge, untouched `width` pixels in. Shared by the mask (what the model may
   repaint) and the paste-back (how much of the photograph is present), and
   the two must agree, or the strip the model blended is either covered
   hard-edged or left showing. */
function fadeEdgesInward(ctx, x, y, w, h, width) {
  const d = Math.max(1, Math.min(Math.round(width), Math.floor(Math.min(w, h) / 2)));
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "destination-out";
  const run = (gx0, gy0, gx1, gy1, rx, ry, rw, rh) => {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  };
  run(x, 0, x + d, 0, x, y, d, h);                       // left
  run(x + w, 0, x + w - d, 0, x + w - d, y, d, h);       // right
  run(0, y, 0, y + d, x, y, w, d);                       // top
  run(0, y + h, 0, y + h - d, x, y + h - d, w, d);       // bottom
  ctx.globalCompositeOperation = prev;
}

/* ── Why the composite is NOT rendered larger ────────────────────────────

   There was an expandOutputScale() here, and removing it is the fix for a
   poster that came back with a smeared strip across the sky.

   The reasoning that put it there was sound as far as it went. gpt-image caps
   its output at 1536px, so the photograph arrived at about 830px and the card
   stretched it to 920 — while the writer's 1280px original was still in hand,
   and layer 4 pastes it back without asking the model anything. Rendering the
   composite bigger and pasting from the original gave the photograph real
   pixels instead of interpolated ones.

   What that missed is that the composite is ONE canvas. Scaling it up scales
   every layer on it, and only layer 4 had more pixels to give. The model's
   margin was upsampled by the same factor — 1.54x on that poster — and then
   butted directly against a photograph at 1:1, along a horizontal line the
   full width of the card. The join is feathered by `band`: 11 frame pixels,
   17 at that scale, 0.72% of the image height.

   Soft next to sharp, with 17 pixels to get from one to the other. Above the
   horizon, where a sunset sky has no detail to hide it, that reads as a
   smear. Below, blocky landscape covered for it, which is why only the top of
   the poster looked wrong and why this survived review: the failure was read
   as the model refusing to paint, and the model had painted.

   Uniform beats sharp-in-places. The photograph is slightly softer than it
   could be and the whole picture is now equally sharp. Making it sharper
   again means either a feather wide enough to cross the sharpness step
   honestly, or a model that returns more than 1536px — not a scale factor
   applied to a canvas where one layer cannot follow. */

/* ── Assembling the result, in four layers ───────────────────────────────

   Nothing here trusts the model with anything except the margin, because the
   margin is the only thing it was needed for.

     1. the locally built frame — sharp picture, blurred bleed — which is
        fully opaque, so no hole in the model's return can reach the canvas;
     2. the model's picture over it, which is where a real drawn margin comes
        from when the call worked;
     3. a ring of the source painted OUTWARD across the boundary;
     4. the source itself, hard-edged and pixel-exact.

   Layer 3 is the correction for what the first attempt at this got wrong. It
   used to feather the source's alpha DOWN to zero at its own edge, which
   deliberately let the model's pixels show exactly where the model's border
   artifact lives — it imported the halo instead of hiding it. Fading outward
   from a slightly oversized copy covers that band with real picture content
   and blends into the margin beyond it, where there is nothing to hide.

   The ~2% stretch on the ring is a sub-pixel misregistration against layer 4
   at their shared edge and is not visible; the alternative, replicating edge
   pixels outward, costs four more draws to look the same.

   This is not the composite that had to be removed from this pipeline before.
   That one blended the model's whole output over the original at an alignment
   nobody knew, and printed a doubled outline for its trouble. Here the
   rectangle is one this file chose, in a frame this file built. */
/* `scale` renders the whole composite larger, and `srcCanvas` is expected to
   carry the resolution to match. NOTHING PASSES A SCALE any more, and the
   block above says why — a scale sharpens layer 4 and cannot sharpen layer 2,
   which is a seam, not an improvement. The parameter stays because the
   identity case is what the geometry tests pin. Layers 1 and 2 are
   the model's frame stretched to the new size, which costs nothing real: the
   bleed is blurred by construction and the drawn margin is scenery. Layers 3
   and 4 are drawn from whatever `srcCanvas` actually holds, so handing this a
   full-resolution source is the whole of the sharpness gain.

   1 is the identity: every rect below rounds back to the number it started
   from, which is what the geometry tests measure. */
/* ── How much bigger than the model's frame the composite is built ─────────

   The model returns 1024x1536 and the writer's photograph is very often
   larger — a 4000px wire photo, a 1920px screenshot. Building the composite
   at the model's size threw those pixels away: the picture came back SMALLER
   than it went in, which is what "it is not upscaling" meant.

   So the composite is built at the photograph's own scale — the number of
   source pixels per frame pixel where the photograph sits — and layer 5
   (composeExpandResult) pastes the original in at that size. The margin is
   the model's and is interpolated up to match; it is scenery under a
   gradient, and the join is handled by a sharpness ramp, not a hard edge.

   Never below 1 (a small photograph is not shrunk further), and capped so the
   result cannot outgrow what a browser will happily hold — a 4096px-tall
   canvas is already the export's own size. */
const COMPOSE_MAX_EDGE = 4096;

function nativeComposeScale(rawW, rawH, place) {
  if (!place || !(place.w > 0) || !(place.h > 0) || !(rawW > 0) || !(rawH > 0)) return 1;
  const native = Math.min(rawW / place.w, rawH / place.h);
  const cap = COMPOSE_MAX_EDGE / Math.max(place.frameW || 1, place.frameH || 1);
  return Math.max(1, Math.min(native, cap));
}

/* How far out into the margin the tone correction reaches, as a fraction of
   the photograph's short side. Full at the boundary, gone this far out. Long
   enough that a broad shade difference becomes a gradient the eye reads as
   light falling off, short enough that the model's margin further out is
   its own. */
const TONE_REACH_FRACTION = 0.35;

/* Per-line colour offsets applied to a strip of pixels, full on the line that
   touches the photograph and easing to nothing at the far side. `data` is an
   ImageData's bytes, `width` x `height`. When `alongX` the strip runs the
   width of the photograph and `deltas` holds one RGB triple per column;
   otherwise it runs the height and holds one per row. `photoFirst` says the
   photograph is at line 0 (a strip below or right of it) rather than at the
   last line. Pure, so it can be tested without a canvas. */
function rampStrip(data, width, height, deltas, alongX, photoFirst) {
  const lines = alongX ? height : width;
  if (lines <= 0) return;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const line = alongX ? y : x;
      const dist = photoFirst ? line : (lines - 1 - line);
      const t = Math.min(1, dist / lines);
      const w = 1 - t * t * (3 - 2 * t);      // smoothstep, 1 at the photo, 0 at the far side
      if (w <= 0) continue;
      const d = (alongX ? x : y) * 3;
      const i = (y * width + x) * 4;
      data[i]     += deltas[d]     * w;
      data[i + 1] += deltas[d + 1] * w;
      data[i + 2] += deltas[d + 2] * w;
    }
  }
}

/* Mean RGB of each column (alongX) or row across a strip, then box-smoothed
   along the edge by `radius` so one bright pixel does not become one bright
   streak of correction. */
function edgeMeans(data, width, height, alongX, radius) {
  const n = alongX ? width : height;
  const depth = alongX ? height : width;
  const raw = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < depth; j++) {
      const i = (alongX ? (j * width + k) : (k * width + j)) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    raw[k * 3] = r / depth; raw[k * 3 + 1] = g / depth; raw[k * 3 + 2] = b / depth;
  }
  const rad = Math.max(0, Math.round(radius));
  if (!rad) return raw;
  const out = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - rad), z = Math.min(n - 1, k + rad);
    let r = 0, g = 0, b = 0;
    for (let m = a; m <= z; m++) { r += raw[m * 3]; g += raw[m * 3 + 1]; b += raw[m * 3 + 2]; }
    const c = z - a + 1;
    out[k * 3] = r / c; out[k * 3 + 1] = g / c; out[k * 3 + 2] = b / c;
  }
  return out;
}

/* Bend the margin's tone to meet the photograph along each of its four edges.
   `photo` is a canvas holding the photograph at pw x ph; the margin is what
   is already on `ctx` around (px, py, pw, ph). Reads and writes pixels, so it
   is a no-op on a context that cannot (the test stubs), and on a tainted
   canvas, where getImageData throws — the composite is still complete
   without it, just with the line the correction exists to remove. */
function matchMarginTone(ctx, photo, px, py, pw, ph, { reach, sample, smooth }) {
  if (typeof ctx.getImageData !== "function" || typeof ctx.putImageData !== "function") return;
  const W = ctx.canvas ? ctx.canvas.width : px + pw;
  const H = ctx.canvas ? ctx.canvas.height : py + ph;
  const k = Math.max(1, Math.min(Math.round(sample), Math.floor(Math.min(pw, ph) / 4)));
  const pctx = photo.getContext && photo.getContext("2d");
  if (!pctx || typeof pctx.getImageData !== "function") return;
  try {
    const edges = [
      // [alongX, photoFirst, photo strip rect, margin strip rect]
      { alongX: true,  photoFirst: true,  photoRect: [0, ph - k, pw, k],       marginRect: [px, py + ph, pw, Math.min(reach, H - (py + ph))] },
      { alongX: true,  photoFirst: false, photoRect: [0, 0, pw, k],            marginRect: [px, Math.max(0, py - reach), pw, Math.min(reach, py)] },
      { alongX: false, photoFirst: true,  photoRect: [pw - k, 0, k, ph],       marginRect: [px + pw, py, Math.min(reach, W - (px + pw)), ph] },
      { alongX: false, photoFirst: false, photoRect: [0, 0, k, ph],            marginRect: [Math.max(0, px - reach), py, Math.min(reach, px), ph] },
    ];
    for (const e of edges) {
      const [mx, my, mw, mh] = e.marginRect;
      if (mw <= 0 || mh <= 0) continue;
      const photoPx = pctx.getImageData(...e.photoRect);
      const margin = ctx.getImageData(mx, my, mw, mh);
      // The margin's own edge rows, next to the photograph.
      const near = e.alongX
        ? ctx.getImageData(mx, e.photoFirst ? my : my + mh - Math.min(k, mh), mw, Math.min(k, mh))
        : ctx.getImageData(e.photoFirst ? mx : mx + mw - Math.min(k, mw), my, Math.min(k, mw), mh);
      const a = edgeMeans(photoPx.data, photoPx.width, photoPx.height, e.alongX, smooth);
      const b = edgeMeans(near.data, near.width, near.height, e.alongX, smooth);
      const deltas = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) deltas[i] = a[i] - b[i];
      rampStrip(margin.data, mw, mh, deltas, e.alongX, e.photoFirst);
      ctx.putImageData(margin, mx, my);
    }
  } catch (err) {
    /* Tainted canvas or a context that will not read back: leave the margin
       as the model drew it. */
  }
}

/* Where the sharp photograph gives way to the soft margin: a ramp this
   fraction of the photograph's short side, measured inward from its edge.
   The old 11px feather was the smear across the sky — soft next to sharp with
   nothing between. Six percent of a 900px-tall photograph is ~54px, over
   which the writer's pixels fade into the same picture at the margin's
   softness, so there is no line to find. */
const SHARP_RAMP_FRACTION = 0.06;

function composeExpandResult(resultImg, srcCanvas, baseFrame, place, scale = 1, sharpSource = null) {
  const s = scale > 0 ? scale : 1;
  const out = document.createElement("canvas");
  out.width = Math.round(place.frameW * s);
  out.height = Math.round(place.frameH * s);
  const ctx = out.getContext("2d");

  ctx.drawImage(baseFrame, 0, 0, out.width, out.height);
  if (resultImg) ctx.drawImage(resultImg, 0, 0, out.width, out.height);

  const band = Math.max(1, Math.round(place.band * s));
  const blend = Math.max(band, Math.round((place.blend || place.band * 2) * s));
  const px = Math.round(place.x * s);
  const py = Math.round(place.y * s);
  const pw = Math.round(place.w * s);
  const ph = Math.round(place.h * s);
  /* ── Layers 3 and 4: the photograph, faded in across the boundary ─────

     There used to be a ring here — the source drawn slightly oversized and
     faded OUTWARD over the margin, then the source hard-edged over that. It
     was written to hide a halo the model left at the mask's edge, and it
     drew a rectangle instead: the halo was gone once the mask went soft
     (buildExpandFrame), and the ring put a hard content edge straight back
     across the strip the model had just blended into.

     Now the photograph fades IN, over the model's picture, across the same
     `blend` strip the mask let the model repaint. At the photograph's edge
     the model's version shows entirely — that is where it carried its tone
     across — and `blend` pixels in the photograph is entirely itself. The
     crossing is inside the picture, spread over enough pixels that a tone
     step becomes a gradient, and it is aligned by construction: the model
     was handed this photograph at this rect and drew around it. */
  const soft = document.createElement("canvas");
  soft.width = pw;
  soft.height = ph;
  const softCtx = soft.getContext("2d");
  softCtx.drawImage(srcCanvas, 0, 0, pw, ph);

  /* ── The margin is bent to meet the photograph; the photograph is not bent ──

     Two things have now been tried at this boundary and both drew something:
     a hard edge drew a LINE wherever the model's margin was a shade off the
     photograph's tone, and a wide alpha fade drew a GHOST wherever the model
     had redrawn a shape inside the strip. Blending pixels between two
     renderings of the same arm cannot be made to work; the renderings differ.

     So the photograph goes down whole and exact, and the mismatch is fixed on
     the other side of the edge: the colour step between the photograph's
     outermost rows and the margin's innermost rows is measured per column
     (per row for the sides), smoothed along the edge, and added to the
     margin at full strength on its first line, fading to nothing `reach`
     lines out. A table drawn a shade darker below the picture is lifted to
     the picture's shade where they meet and left alone further away. No
     content is blended, only tone — which is the only thing that was wrong. */
  matchMarginTone(ctx, soft, px, py, pw, ph, {
    reach: Math.round(Math.min(pw, ph) * TONE_REACH_FRACTION),
    sample: Math.max(2, band),
    smooth: blend,
  });

  /* Whole, hard-edged, no fade at all. Even a two-percent fade exposed the
     model's edge pixels along the photograph's outermost rows — and those
     are the model's blend of picture and margin, a shade off — as a one-row
     hairline. The tone correction above has already brought the margin's
     first rows to the photograph's shade, so the hard edge is now the
     smoothest edge there is. */
  ctx.drawImage(soft, px, py);

  /* ── Layer 5: the writer's own pixels ─────────────────────────────────

     Everything above is at the model's resolution, `srcCanvas` included —
     that is the ≤1536px copy that went up. When the composite is built larger
     than that (scale > 1, see nativeComposeScale) the photograph in layer 4
     is interpolated, and the original is in hand with real pixels to give.

     It is laid over layer 4 through an alpha ramp that is transparent at the
     photograph's edge and opaque SHARP_RAMP_FRACTION of the way in. Layer 4
     is the same picture at the margin's softness, fully opaque underneath, so
     the ramp is not sharp-over-scenery — it is sharp-over-soft of the SAME
     content, aligned by construction. That is the "feather wide enough to
     cross the sharpness step honestly" the previous attempt at this needed
     and did not have: the step is now a slope inside the photograph, where
     the picture's own detail carries it, instead of a line at its border.

     Only with a source to paste and a scale to justify it. At scale 1 the
     sharp source IS srcCanvas, and the identity case stays the identity. */
  if (sharpSource && s > 1) {
    const inner = Math.max(band * 2, Math.round(Math.min(pw, ph) * SHARP_RAMP_FRACTION));
    const sharp = document.createElement("canvas");
    sharp.width = pw;
    sharp.height = ph;
    const sctx = sharp.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(sharpSource, 0, 0, pw, ph);
    sctx.globalCompositeOperation = "destination-out";
    const ramp = (gx0, gy0, gx1, gy1, rx, ry, rw2, rh2) => {
      const g = sctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = g;
      sctx.fillRect(rx, ry, rw2, rh2);
    };
    ramp(0, 0, inner, 0, 0, 0, inner, ph);                    // left
    ramp(pw, 0, pw - inner, 0, pw - inner, 0, inner, ph);     // right
    ramp(0, 0, 0, inner, 0, 0, pw, inner);                    // top
    ramp(0, ph, 0, ph - inner, 0, ph - inner, pw, inner);     // bottom
    sctx.globalCompositeOperation = "source-over";
    ctx.drawImage(sharp, px, py);
  }
  return out;
}

async function runImageAI() {
  const btn = aiEnhanceBtn;
  const requestedMode = enhanceModeSel?.value || "auto";
  const img = state.mainImage;
  if (!img) return;
  // Whose picture this is. Read before the first await — see the commit below.
  const enhanceOwner = activePage();
  /* Before anything is spent. Taken here rather than beside the commit so the
     slot exists even if the call fails halfway — and taken from the same page
     the result will be committed to, not from whatever is selected when it
     lands. First one wins, so enhancing twice still undoes to the writer's
     image. */
  rememberImageBeforeAI(enhanceOwner, img);

  btn.disabled = true;
  btn.classList.add("working");
  setEnhanceStatus(ENHANCE_WORKING[requestedMode] || ENHANCE_WORKING.auto);

  try {
    // Snapshot the current background to a temp canvas, capped at 1536 on
    // the long edge (gpt-image's max output — no point uploading more).
    const rawW = img.naturalWidth || img.width;
    const rawH = img.naturalHeight || img.height;

    /* ── What does this photograph actually need? ────────────────────────
       Worked out here, from the picture, before anything is spent. Two
       questions, and only one of them can cost money:

         is it too small?   gpt-image's ceiling is MODEL_CEILING_PX on the
                            long edge and the upload is capped to match, so
                            a source already at or above it is downscaled on
                            the way out, repainted at the ceiling, and
                            enlarged back on the way home. On a 3000px wire
                            photo that replaces real capture with the model's
                            idea of it and bills for the privilege. The model
                            is never shown more than the ceiling, so it can
                            never return more. Below it, the call genuinely
                            adds pixels.

         is it flat?        exposure, contrast and colour, read off the
                            picture's own histogram. This is arithmetic and
                            costs nothing — see autoFilterFor.

       Which gives three answers, and two of them are free:

         needs nothing      big enough, and correctly exposed. Say so and
                            stop. This is most wire photographs.
         tone only          big enough, but flat or dark. Fix it locally.
                            No call, no credits, instant.
         upscale            genuinely short of pixels. Spend — and apply the
                            tone fix as well, since it is free either way.

       The point is that the expensive answer is the LAST one considered
       rather than the only one available. */
    const longEdge = Math.max(rawW, rawH);
    /* Restore only, and the qualifier is load-bearing. The argument for
       skipping is "the model cannot return more pixels than it was shown",
       and that is an argument about RESOLUTION — which is the only thing
       restore is for.

       It does not transfer to the other jobs. Reframe and Expand exist to
       change the SHAPE, and a 3000px landscape on a 9:16 poster is exactly
       the case they were written for: the card is cropping two thirds of the
       width away and no amount of resolution fixes that. Skipping them told
       a reviewer who had explicitly chosen "redraw the whole picture to fit
       the poster" that the photograph "does not need it" — the opposite of
       the problem they were looking at — and, when the tone check fired,
       silently applied a brightness change instead of the reframe they asked
       for. Auto goes through too: only the server's planner knows which job
       it will resolve to, so deciding here would be guessing. */
    const bigEnough = longEdge >= MODEL_CEILING_PX && requestedMode === "restore";
    const auto = autoFilterFor(img);
    const toneHelps = !!auto && !(auto.brightness === 100 && auto.contrast === 100 && auto.saturation === 100);

    const toneSummary = auto
      ? `brightness ${auto.brightness}%, contrast ${auto.contrast}%, saturation ${auto.saturation}%`
      : "";

    if (bigEnough) {
      if (toneHelps) {
        applyFilterPreset("auto", { announce: false });
        commitFieldToPage(enhanceOwner, "filterBrightness", auto.brightness);
        commitFieldToPage(enhanceOwner, "filterContrast", auto.contrast);
        commitFieldToPage(enhanceOwner, "filterSaturation", auto.saturation);
        renderPoster();
        setEnhanceStatus(
          `Adjusted it here instead — ${toneSummary}. ` +
          `At ${rawW}×${rawH} it is already larger than the AI can return ` +
          `(${MODEL_CEILING_PX}px), so the call would have shrunk it. No credits used.`,
          "success",
        );
      } else {
        setEnhanceStatus(
          `This photograph does not need it. ${rawW}×${rawH} is larger than the AI can ` +
          `return (${MODEL_CEILING_PX}px), and its exposure and contrast already measure fine. ` +
          `Nothing changed, no credits used.`,
          "success",
        );
      }
      btn.disabled = false;
      btn.classList.remove("working");
      return;
    }

    /* Small enough that the model can genuinely add pixels. The tone fix is
       free, so it is applied regardless — the call is being made for
       resolution, not for exposure, and there is no reason to pay a model to
       do arithmetic that has already been done. */
    if (toneHelps) {
      applyFilterPreset("auto", { announce: false });
      commitFieldToPage(enhanceOwner, "filterBrightness", auto.brightness);
      commitFieldToPage(enhanceOwner, "filterContrast", auto.contrast);
      commitFieldToPage(enhanceOwner, "filterSaturation", auto.saturation);
    }

    /* ── Send a shape the model can actually return ──────────────────────
       gpt-image has exactly three output shapes — 1024x1024, 1024x1536 and
       1536x1024, so aspects 1.000, 0.667 and 1.500 — and nothing else. A
       photograph whose aspect is not one of those CANNOT come back as itself:
       the model has to make up the difference, and on an outdoor picture the
       difference it makes up is sky. A 16:9 press photo is 1.778 against an
       output of 1.500, so 19% of the returned frame is invented, every time.
       That is the whole of the "it keeps adding clouds" report, and no
       wording in the prompt can prevent it — the shape is a fact about the
       request, not about the instructions.

       So the picture is cropped to the nearest of the three BEFORE it goes,
       and what gets cropped is precisely the strip the model would otherwise
       have invented. Losing a real edge is the better half of that trade for
       a newsroom: an edge that is missing is obvious, an edge that is
       fabricated is not, and the poster crops to its own shape afterwards
       regardless.

       ...but it can only be done once the job is KNOWN, and the job is
       decided by stage 1. Cropping here, from the mode the reviewer picked,
       got that wrong for Auto — which is the default the planner exists to
       serve. "auto" is not the string "restore", so the crop was skipped,
       the native shape went up, the server resolved the verdict to restore
       and asked for 1536x1024 anyway, and a 1.77 source came back with a
       fifth of the frame invented and billed for. The mismatch the crop was
       written to close was wide open on the path most presses take.

       So stage 1 gets the picture as it is — it needs the true shape to
       reason about crop loss — and the trim happens below, against the mode
       that actually resolved. See cropToModelShape below. */
    const cappedScale = Math.min(1, MODEL_CEILING_PX / Math.max(rawW, rawH));
    const tmp = document.createElement("canvas");
    tmp.width  = Math.round(rawW * cappedScale);
    tmp.height = Math.round(rawH * cappedScale);
    tmp.getContext("2d").drawImage(img, 0, 0, tmp.width, tmp.height);

    const sourceBlob = await canvasToPng(tmp);

    /* Crop a copy to the nearest shape gpt-image can return, for whichever of
       the jobs turns out to preserve framing. Built as a function so it is
       only paid for on the branch that uses it. */
    const cropToModelShape = async () => {
      const srcAspect = tmp.width / tmp.height;
      const target = nearestModelShape(srcAspect);
      let cw = tmp.width, ch = tmp.height;
      if (srcAspect > target) cw = tmp.height * target;
      else if (srcAspect < target) ch = tmp.width / target;
      if (Math.abs(cw - tmp.width) < 1 && Math.abs(ch - tmp.height) < 1) return sourceBlob;
      const c = document.createElement("canvas");
      c.width = Math.round(cw);
      c.height = Math.round(ch);
      c.getContext("2d").drawImage(
        tmp, Math.round((tmp.width - cw) / 2), Math.round((tmp.height - ch) / 2),
        Math.round(cw), Math.round(ch), 0, 0, c.width, c.height,
      );
      return canvasToPng(c);
    };

    /* ── Stage 1: what does this picture need, and at what size ──
       Cheap (one gpt-4o-mini look), spends no image credits, returns no
       picture. It exists as its own round trip because its answer decides
       what this function has to BUILD before the paid call — an expand needs
       a composited frame at exactly the size the server resolved, and there
       is no way to build that from inside a single request. */
    const planResp = await fetch("/api/upscale-image", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Enhance-Stage": "plan",
        "X-Image-Orientation": rawW >= rawH ? "landscape" : "portrait",
        // Read by the expand path, which renders into the poster's shape so
        // there is somewhere for the widened scene to go. The restore path
        // ignores it and follows the source — see sizeForRatio() in
        // server.mjs for why asking it for the poster's shape is what
        // produced the invented margin.
        "X-Poster-Ratio": state.aspectRatio || "",
        // Story context helps the vision stage understand what the photo
        // shows, which sharpens the "preserve exactly this" instructions.
        "X-Headline": encodeURIComponent((state.headline || "").slice(0, 200)),
        // Which job to run, or "auto" to let the server's stage 1 choose from
        // the photograph. The server defaults to restore when this is absent
        // or unrecognised — a caller that says nothing gets the job that
        // reframes nothing.
        "X-Enhance-Mode": requestedMode,
        // How far to pull back, when expand has been forced. Ignored on the
        // auto path, where stage 1 sets it; sent always so the request shape
        // does not depend on the mode.
        "X-Expand-Amount": expandAmountSel?.value || "moderate",
        /* This caller builds the frame itself: it composites the source onto
           a canvas of exactly the size the server resolves, sends the mask,
           and pastes the source back over whatever returns. That is what
           makes an expand safe, and it is the only reason `auto` is allowed
           to choose one — the legacy single-shot path cannot do any of it and
           does not send this, so an expand verdict there still degrades to a
           restore. See the "auto expands when the caller composites" block in
           server.mjs. */
        "X-Expand-Capable": "1",
        /* The real pixel size, which the server cannot cheaply read out of the
           PNG and the browser has in hand. The planner needs it: an expand
           places the photograph smaller inside a fixed-size output, so a small
           source comes back with less on the face than it started with, and
           shape alone cannot tell a 400px crop from a 3000px one. These are
           the capped dimensions, which is what the model will actually see. */
        "X-Source-Size": `${tmp.width}x${tmp.height}`,
      },
      body: sourceBlob,
    });
    const plan = await planResp.json().catch(() => ({}));
    if (!planResp.ok) throw enhanceError(plan, planResp.status);

    /* An expand only happens if there is a frame to build it in. A size the
       server could not resolve to real dimensions ("auto") leaves nothing to
       composite onto, and rather than fall back to asking the model to place
       the picture itself — the thing that drew the ghost — this drops to a
       restore, which reframes nothing and cannot double anything. */
    /* ── Reframe is an expand with no pull-back ────────────────────────
       It used to be its own job: the raw picture went up with no frame and
       no mask, and the model returned the whole poster-shaped image. That
       is a regeneration, and it is why "sometimes it changes the image":
       the model redrew the face along with the margin, and it returned it
       at 1024px however large the photograph had been — a downscale that
       read as "not upscaling".

       So it now takes the road Expand takes. The photograph is fitted into
       the poster's visible area as large as it will go (amount "fit" — no
       pull-back, the margin is only what the shape demands), the mask pins
       it, the model draws the margin, and composeExpandResult pastes the
       writer's own pixels back over the middle at their native resolution.
       The model never gets a say over anything inside the photograph. */
    /* ── Reframe is a whole-frame redraw; Expand is the pinned composite ──

       Reframe went through the pinned-photo composite for two commits and
       came back with a rectangle, then a smear, then a tone-matched edge
       that still could not match what the same model does when it is simply
       ASKED: a reviewer typed "upscale and reframe it to 9:16" at ChatGPT and
       got a seamless, coherent 9:16 picture. Same model. It regenerates the
       scene, and that is the trade the reviewer is making when they pick
       Reframe — it is stated on the selector. Expand stays as the job that
       pins the photograph and composites the margin around it. */
    const framed = plan.mode === "expand";
    const frameSize = framed ? parseEnhanceSize(plan.size) : null;
    const amount = plan.amount || "moderate";
    /* Inside what the card will show, not inside what the model will
       return — the two differ by a quarter of the width on a 9:16 poster,
       and the difference used to come off the photograph rather than off
       the margin drawn for it. */
    const safeRect = frameSize ? posterVisibleRect(frameSize.w, frameSize.h) : null;
    const place = frameSize
      ? planExpandPlacement(tmp.width, tmp.height, frameSize.w, frameSize.h, amount, plan.subject, safeRect)
      : null;

    /* A photograph that already has the poster's shape AND is already larger
       than the model returns has nothing to gain from a redraw: same shape
       back, fewer pixels, a regenerated face. Say so and keep the credits.
       Smaller than the model's output it still gains pixels, so it goes. */
    if (plan.mode === "reframe") {
      const target = RATIO_ASPECTS[state.aspectRatio] || 9 / 16;
      const sameShape = Math.abs(Math.log((rawW / rawH) / target)) < 0.06;
      if (sameShape && longEdge >= MODEL_CEILING_PX) {
        setEnhanceStatus(
          `This photograph is already ${state.aspectRatio || "9:16"} at ${rawW}×${rawH} — larger than the AI ` +
          `can return (${MODEL_CEILING_PX}px), so a redraw could only shrink it. ` +
          `${toneHelps ? `Adjusted it here instead — ${toneSummary}. ` : ""}No credits used.`,
          "success",
        );
        if (toneHelps) renderPoster();
        btn.disabled = false;
        btn.classList.remove("working");
        return;
      }
    }

    setEnhanceStatus(place
      ? `Expanding — drawing the scene outward from the photo${plan.reason ? ` (${plan.reason})` : ""} (30–90s)…`
      : plan.mode === "reframe"
        ? ENHANCE_WORKING.reframe
        : "Restoring and upscaling — recovering detail (30–90s)…");

    /* ── Stage 2: the paid call ──
       Multipart, because an expand sends two files: the composited frame and
       the mask that pins the picture inside it. The plan travels back as
       fields so the vision stage is not paid for twice. */
    const form = new FormData();
    /* Kept, not discarded after upload. The frame this builds is a complete,
       usable expanded picture on its own — sharp photograph, blurred bleed
       margin — and it is layer 1 of the result as well as the input. That is
       what makes the model's contribution additive: whatever it returns is
       laid over something that already works, so a transparent margin, a
       refusal or a nonsense return cannot leave a hole or a halo. */
    let baseFrame = null;
    if (place) {
      const built = buildExpandFrame(tmp, place);
      baseFrame = built.frame;
      form.append("image", await canvasToPng(built.frame), "frame.png");
      form.append("mask", await canvasToPng(built.mask), "mask.png");
      form.append("composited", "1");
    } else if (plan.mode === "reframe") {
      // Reframe redraws the whole picture at the poster's shape. Cropping it
      // to a model shape first would discard picture it was about to use.
      form.append("image", sourceBlob, "source.png");
      form.append("composited", "0");
    } else {
      // Restore, however it was reached — chosen outright, or resolved there
      // by the planner on auto. Now the shape can be matched to what the model
      // is able to hand back, so there is nothing left for it to invent.
      form.append("image", await cropToModelShape(), "source.png");
      form.append("composited", "0");
    }
    /* A reframe needs nothing built for it — that is the point of it. The raw
       source goes up, the model returns the whole picture at the poster's
       shape, and there is no composite to align or mask to pin. Only expand
       requires the frame, so only expand is gated on having built one. */
    form.append("mode", place ? "expand" : (plan.mode === "reframe" ? "reframe" : "restore"));
    form.append("amount", amount);
    form.append("subject", plan.subject || "people");
    form.append("description", plan.description || "");
    form.append("headline", encodeURIComponent((state.headline || "").slice(0, 200)));
    form.append("posterRatio", state.aspectRatio || "");
    form.append("size", plan.size || "auto");
    form.append("decidedBy", plan.decidedBy || "caller");
    form.append("reason", plan.reason || "");

    // No Content-Type here on purpose: the browser has to set the multipart
    // boundary itself, and naming the type strips it.
    const resp = await fetch("/api/upscale-image", {
      method: "POST",
      headers: { "X-Enhance-Stage": "edit" },
      body: form,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw enhanceError(data, resp.status);
    if (!data.image) throw new Error("No image returned.");

    /* A second round trip, and a cheap one: the answer above carried an
       address, not the picture. A failure here costs nothing and can be
       retried — the call is already paid for and the result is held server-
       side for an hour, so pressing again is a cache hit rather than a second
       charge. See collectEnhancedImage(). */
    const imageSrc = await collectEnhancedImage(data.image);
    const returned = new Image();
    await new Promise((resolve, reject) => {
      returned.onload = resolve;
      returned.onerror = () => reject(new Error("Enhanced image failed to load."));
      returned.src = imageSrc;
    });

    // The unconditional half of the ghost fix — see composeExpandResult().
    /* The paste-back comes off the ORIGINAL, not off `tmp`.

       `tmp` exists because gpt-image will not accept more than 1536px, and
       for a while it was doing double duty as the thing pasted back over the
       result. It was fixed by rendering the composite larger and pasting the
       source back from `img` at up to its native resolution — and that fix
       was WRONG, in a way that took a poster to see.

       The composite is one canvas, so scaling it up scales everything on it.
       The photograph gained real pixels; the model's margin only gained
       interpolated ones. On a 1280px source that worked out at 1.54x, which
       means the margin arrived UPSAMPLED 1.54x and butted directly against a
       photograph at 1:1, along a horizontal line the full width of the card
       at place.y. The feather meant to hide that join is `band` — 11 frame
       pixels, 17 at that scale, 0.72% of the image height. It never stood a
       chance.

       That is the smeared strip along the top of the poster: not the model
       declining to paint, but our own composite putting soft pixels next to
       sharp ones with nothing in between. It shows worst above the horizon
       because a smooth sunset sky has no detail to disguise it, and passes
       unnoticed below where blocky landscape does.

       So the scale is gone and the composite is uniform again. The
       photograph is a little softer than it could be; every part of the
       picture is now equally sharp, which matters more. Sharpening the
       photograph alone is not available while it shares a canvas with a
       margin that cannot be sharpened with it — the honest version of that
       needs a wider feather, or a model that returns more pixels. */
    let enhanced = returned;
    if (data.mode === "expand" && place && baseFrame) {
      /* Built at the photograph's own scale, and the ORIGINAL is what goes
         in last — see nativeComposeScale and layer 5 of composeExpandResult.
         `tmp` is still layers 3 and 4: it is the copy the model saw, so it
         is registered exactly against the model's margin. */
      const composeScale = nativeComposeScale(rawW, rawH, place);
      enhanced = await canvasToImage(
        composeExpandResult(returned, tmp, baseFrame, place, composeScale, img),
      );
    }

    // Claim the result as ours, so imageUndoEntry() reads the page as still
    // showing an AI picture rather than one the reviewer swapped in.
    noteAIImage(enhanceOwner, enhanced);

    /* An expanded frame is already aimed, so nothing may re-aim it.

       ensureImageFocalPoint() would otherwise run the face detector over the
       result and hand drawCoverImage() a face to centre the crop on. On this
       picture that undoes the whole call: the margin was drawn, and the
       placement chosen, so that the photograph sits in the middle of what the
       card shows. Panning off to a face pushes that carefully centred
       composition sideways and takes the crop back off the edge of the
       photograph — the same cut the expand was paid to avoid.

       Set rather than skipped, because the field is what drawCoverImage reads
       and an absent one falls back to the centre anyway; writing it down
       makes the intent explicit and stops the detector running for nothing. */
    if (data.mode === "expand" || data.mode === "reframe") {
      enhanced.__focalPoint = { x: enhanced.width / 2, y: enhanced.height / 2 };
    }
    await ensureImageFocalPoint(enhanced);
    /* Onto the page that was selected when Enhance was pressed. This runs
       30-90 seconds after the click and had no page guard at all, so a
       writer who clicked through the carousel while waiting watched the
       slide they happened to be looking at swap to page 1's enhanced photo
       — destroying that slide's own picture, unrecoverable when it was a
       drag-and-drop upload. */
    commitFieldToPage(enhanceOwner, "mainImage", enhanced);

    /* An expanded picture is a different picture — wider, with the subject
       smaller inside it — so the zoom and pan the writer set to rescue the
       old framing now fight the new one. A 160% zoom applied to a frame that
       was widened precisely to stop the canvas cropping crops it again, and
       the call is paid for and looks like it did nothing.

       Reset to the unframed defaults, exactly as a freshly picked image
       arrives (see resetImageControls / stashImageForAbsentPage), and let
       the writer reframe from there. A restore keeps its framing: same
       picture, same shape, so the numbers still mean what they meant. */
    if (data.mode === "expand" || data.mode === "reframe") {
      /* EXPAND_COMMIT_ZOOM, not 100, and it is the same number the placement
         was planned against — posterVisibleRect() defaults to it. The two
         have to agree or the guarantee breaks: the picture was fitted inside
         the rect the card shows AT THIS ZOOM, so committing any other one
         crops the photograph the expand just finished protecting.

         It is 91% rather than 100% because IMAGE_PAN_HEADROOM's 10% of pan
         slack is worth having on a photograph the writer is framing by hand
         and worth nothing on a frame generated to these dimensions. */
      commitFieldToPage(enhanceOwner, "imageOffset", { x: 0, y: 0 });
      commitFieldToPage(enhanceOwner, "imageZoom", EXPAND_COMMIT_ZOOM);
      if (activePage() === enhanceOwner) {
        syncControl(imgOffsetX, 0);
        syncControl(imgOffsetY, 0);
        syncControl(imgZoom, EXPAND_COMMIT_ZOOM);
      }
    } else if (plan.fit) {
      /* The planner judged the poster about to cut most of this picture away,
         and on `auto` the answer to that is Fit, not a paid reframe — see the
         "auto never expands" block in server.mjs. Same arithmetic the zoom
         readout runs on click (fitZoomFor / toggleFitZoom), applied here so
         the reviewer sees the whole photograph without a second press.

         Centred, because a fitted picture is smaller than the frame and any
         inherited offset would push it off-centre against the backdrop for no
         reason the writer chose. */
      const fitZoom = fitZoomFor(enhanced);
      commitFieldToPage(enhanceOwner, "imageOffset", { x: 0, y: 0 });
      commitFieldToPage(enhanceOwner, "imageZoom", fitZoom);
      if (activePage() === enhanceOwner) {
        syncControl(imgOffsetX, 0);
        syncControl(imgOffsetY, 0);
        syncControl(imgZoom, fitZoom);
      }
    }

    renderPoster();

    /* Say what ran, and on the auto path say why.

       A reviewer who pressed one button and got a reframed photograph is owed
       the reason — not to justify the software, but because the verdict is the
       thing they might disagree with, and the select above is how they say so
       on the next press. "Expanded and reframed" alone gives them nothing to
       push against; "he was cropped at mid-chest with no room below" does. */
    const label = ENHANCE_LABELS[data.mode] || ENHANCE_LABELS.restore;
    const engineLabel = data.engine || "AI";
    const why = requestedMode === "auto" && data.reason ? ` — ${data.reason}` : "";
    // Fit changes what the reviewer is looking at as much as the job did, so
    // it has to be named. Silently shrinking the picture inside the frame
    // reads as a bug, not as the answer to the crop they never saw coming.
    const fitted = (data.mode !== "expand" && plan.fit) ? ", fitted to show all of it" : "";
    /* A cache hit is worth saying out loud. It is the difference between a
       press that cost money and one that did not, and the reviewer is the
       only person who can decide whether to keep pressing. */
    /* What it cost, measured off OpenAI's own usage block rather than a
       price table — the tables here have been wrong before. Shown because a
       reviewer deciding whether to press this again is the one person the
       number is actually for, and it was previously only in a boot log on
       the host. */
    const billed = data.cached
      ? " (from cache, no charge)"
      : (data.cost ? ` — $${data.cost.usd.toFixed(3)}` : "");
    setEnhanceStatus(
      `✓ ${label.done}${fitted} via ${engineLabel}${billed}${why}. Re-pick a stock image to undo.`,
      "success",
    );
  } catch (err) {
    /* A safety refusal is reported as itself, not as a failure. The software
       did its job and the answer was no; "Restore failed" in front of that
       tells a reviewer something is broken and sends them looking for a fault
       that is not there. It is also the one refusal they can act on — by
       publishing the photograph as it is. */
    if (err.moderated) {
      setEnhanceStatus(err.message, "success");
    } else {
      // Before the plan lands there is no resolved mode, so the failure is
      // named after what was asked for. On auto that is neither job yet.
      const failed = ENHANCE_LABELS[requestedMode]?.failed || "Enhance failed";
      setEnhanceStatus(`${failed}: ${err.message}`, "error");
    }
  } finally {
    btn.classList.remove("working");
    btn.disabled = !state.mainImage;
    // Re-read after "working" comes off: syncImageUndoUI() greys the undo out
    // for the duration of a call, and nothing else would put it back on the
    // failure path.
    syncImageUndoUI();
  }
}

if (aiEnhanceBtn) aiEnhanceBtn.addEventListener("click", () => runImageAI());

const imageUndoBtn = document.getElementById("image-undo-btn");
if (imageUndoBtn) imageUndoBtn.addEventListener("click", () => revertImageToOriginal());
syncImageUndoUI();

/* ── Theme toggle (dark default; persisted in localStorage) ── */
(function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pix-theme", theme);
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", theme === "dark" ? "#0e1117" : "#f5f7fb");
    }
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  // Sync meta/aria with whatever the head bootstrap already applied
  applyTheme(document.documentElement.dataset.theme || "light");

  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
  });
})();

/* ═══════════════════════ Slide 2 — video ═══════════════════════

   Slide 2 is either the Text card or a directly uploaded video clip. The clip
   gets trimmed to a range chosen here and is exported with the Pix branding
   burned in by ffmpeg. Legacy URL-backed posts can still be reopened, but new
   videos enter through file upload only.

   Both endpoints are ordinary same-origin routes on this server, which
   shells out to yt-dlp and ffmpeg. An earlier version POSTed to a separate
   host with an HMAC token because Vercel caps serverless request bodies at
   4.5 MB, far below a video upload — Railway has no such cap, so the second
   service, the shared secret and the CORS config are all gone.
   ══════════════════════════════════════════════════════════════ */

const MAX_CLIP_SECONDS = 90;          // matches MAX_CLIP_SECONDS on the service
const MAX_VIDEO_UPLOAD_BYTES = 300 * 1024 * 1024;

const videoFileInput   = document.getElementById("video-file-input");
const videoFileDrop    = document.getElementById("video-file-drop");
const videoFileLabel   = document.getElementById("video-file-label");
const videoStatusEl    = document.getElementById("video-status");
const videoEditor      = document.getElementById("video-editor");
const videoPreviewEl   = document.getElementById("video-preview");
const trimStartInput   = document.getElementById("trim-start");
const trimEndInput     = document.getElementById("trim-end");
const trimStartLabel   = document.getElementById("trim-start-label");
const trimEndLabel     = document.getElementById("trim-end-label");
const trimDurationEl   = document.getElementById("trim-duration");
const videoMuteInput   = document.getElementById("video-mute");
const videoExportBtn   = document.getElementById("video-export-btn");

function setVideoStatus(message, type) {
  if (!videoStatusEl) return;
  videoStatusEl.textContent = message || "";
  videoStatusEl.className = "status-text";
  if (type) videoStatusEl.classList.add(type);
}

function formatTimecode(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/* The video endpoints are ordinary same-origin routes on this server — the
   backend shells out to yt-dlp and ffmpeg. There is no second host, no
   shared secret and no token exchange: that only existed to work around
   Vercel's 4.5 MB serverless body cap, which Railway doesn't have. */

// Swap the export button into a visible working state. The encode reports no
// percentage, so this is an indeterminate "still going" signal, not progress.
function setExportWorking(working) {
  const btn = document.getElementById("video-export-btn");
  const label = document.getElementById("video-export-label");
  const bar = document.getElementById("video-export-progress");
  if (btn) btn.classList.toggle("working", working);
  if (label) label.textContent = working ? "Exporting…" : "Export Video";
  if (bar) bar.hidden = !working;
}

async function mediaErrorMessage(res) {
  const data = await res.json().catch(() => null);
  if (data && data.error) return data.error;
  if (res.status === 413) return "That file is too large.";
  if (res.status === 504) return "The server timed out. Try a shorter clip.";
  return `Server error ${res.status}.`;
}

/* ── Source: local file ── */
function loadLocalVideoFile(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    setVideoStatus("That is not a video file.", "error");
    return;
  }
  if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
    setVideoStatus(`That file is ${(file.size / 1048576).toFixed(0)} MB; the limit is 300 MB.`, "error");
    return;
  }

  state.videoFile = file;
  state.videoUrl = "";
  state.videoMeta = null;
  state.videoSourceKind = "file";
  state.videoFileName = file.name;
  /* A new source means the stored copy is no longer this post's video.

     storedVideoUrl/storedVideoFor were cleared in only two places — starting a
     new post, and blanking a page — never when the clip itself was replaced.
     So swapping the video and then hitting an encode failure saved the row
     pointing at the PREVIOUS clip: reopening played the old footage, and
     restoreStoredVideo stamped storedVideoFor to match it, so the next Submit
     took the "already stored and unchanged" shortcut and reported nothing at
     all. QA then published the old video, to a write-only API. */
  state.storedVideoUrl = null;
  state.storedVideoFor = null;
  state.clipSourceUrl = "";
  state.renderedClip = null;
  if (videoFileLabel) videoFileLabel.textContent = file.name;

  const objectUrl = URL.createObjectURL(file);
  if (videoPreviewEl) {
    videoPreviewEl.poster = "";
    videoPreviewEl.src = objectUrl;
    // Revoking on load would break seeking — the URL is released when the
    // source is replaced instead.
    videoPreviewEl.addEventListener("loadedmetadata", () => {
      setupTrimRange(videoPreviewEl.duration || 0);
      if (videoEditor) videoEditor.hidden = false;
      setVideoStatus(`${file.name} · ${formatTimecode(videoPreviewEl.duration)}`, "success");
      // Onto the video page, not just into state — see commitVideoToItsPage.
      commitVideoToItsPage();
      renderPoster();
      if (!videoPreviewEl.paused) startVideoPreviewLoop();
    }, { once: true });
  }
}

/* File the video under the page that owns it, whatever is selected.

   The video controls live in the left panel, not in the page rail, so the
   natural way to add a clip is to be looking at page 1 while doing it. But the
   video fields are PAGE-owned: syncActivePageContent() captures the fields of
   the SELECTED page, and page 1's list has no video in it — so a clip added
   from page 1 was written into `state` and nowhere else. The moment the writer
   clicked the Video card to look at it, applyPageFields loaded that page's
   (empty) content over the top and the File was gone: state.videoFile null,
   trim back to 0, videoClipKey() null.

   That is why so many posts saved with a trim range and no storedUrl, and why
   the console said "clip skipped, no key" — the file had been destroyed by a
   click, before Save ever ran, and an uploaded File cannot be recovered.

   So the moment a video is loaded it is committed to its own page. Selecting
   that page then LOADS the clip instead of erasing it, and withPrimaryVideo()
   finds it at save time from whichever page is on screen. */
function commitVideoToItsPage() {
  /* The page the writer is actually on, not "the primary video page".

     primaryVideoPage() deliberately prefers a page that ALREADY holds a clip,
     which makes the first video page a permanent magnet: on a post with two
     Video slides, loading footage into slide 4 was written onto slide 2
     instead. And because the commit below replaces every video field at once,
     that did not merely misfile the new clip — it overwrote slide 2's
     storedVideoUrl, destroying footage that was already uploaded and saved.

     Video controls are scope-gated to video pages (PAGE_SCOPE.video), so the
     selected page IS the right answer on the normal path; the primary is only
     a fallback for a clip arriving from somewhere else. */
  const active = activePage();
  const page = (active?.type === "video" ? active : primaryVideoPage()) || ensureVideoPage();

  /* No page to put it on. ensureVideoPage() returns null when the rail is
     full, and every caller discarded that null — the status line had already
     said "success", so the clip simply evaporated at save time inside
     withPrimaryVideo(), which substitutes a blank video page and writes the
     row with no clip WHILE the editor carries on showing the video. Said here
     rather than at the call sites so future callers inherit it. */
  if (!page) {
    setVideoStatus(
      `This post already has all ${MAX_PAGES} slides, so the clip has nowhere to live — remove a page and add the video again.`,
      "error",
    );
    return null;
  }

  if (!page.content) page.content = {};
  Object.assign(page.content, capturePageFields(VIDEO_PAGE_FIELDS));
  return page;
}

/* Commit an async result to the page that OWNED it when the work started.

   Anything that finishes after an await — an enhance, a stock pick, a scrape,
   a vision call, an encode — was started FOR a particular page, and the writer
   is free to click a different card while it runs. Writing the result into
   live `state` on arrival files it under whatever page happens to be selected
   at that moment: the wrong slide gets the picture, and the slide it was meant
   for keeps nothing. Worse, if the selected page does not own the field at
   all, syncActivePageContent() spills it onto page 1.

   So: write through the owning page, and touch `state` only while that page is
   still the one on screen. Same shape as commitVideoToItsPage(). */
function commitFieldToPage(page, field, value) {
  if (!page) return;
  if (!page.content) page.content = {};
  page.content[field] = value;
  if (activePage() === page) state[field] = value;
}

/* ── Trim ── */
function setupTrimRange(duration) {
  const dur = Math.max(0, duration || 0);
  state.trimStart = 0;
  state.trimEnd = Math.min(dur || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS);
  if (trimStartInput) {
    trimStartInput.max = String(dur || MAX_CLIP_SECONDS);
    trimStartInput.value = "0";
  }
  if (trimEndInput) {
    trimEndInput.max = String(dur || MAX_CLIP_SECONDS);
    trimEndInput.value = String(state.trimEnd);
  }
  syncTrimUI();
}

function syncTrimUI() {
  const duration = Math.max(0, state.trimEnd - state.trimStart);
  if (trimStartLabel) trimStartLabel.textContent = formatTimecode(state.trimStart);
  if (trimEndLabel) trimEndLabel.textContent = formatTimecode(state.trimEnd);
  if (trimDurationEl) {
    trimDurationEl.textContent = `${duration.toFixed(1)}s`;
    trimDurationEl.classList.toggle("over-limit", duration > MAX_CLIP_SECONDS || duration <= 0);
  }
  if (videoExportBtn) {
    videoExportBtn.disabled =
      state.videoExporting || duration <= 0 || duration > MAX_CLIP_SECONDS ||
      (!state.videoUrl && !state.videoFile);
  }
}

// Start and End get one range input each; clamping here (rather than
// building a custom dual-handle widget) is what stops them crossing over.
if (trimStartInput) {
  trimStartInput.addEventListener("input", () => {
    state.trimStart = Math.min(parseFloat(trimStartInput.value) || 0, state.trimEnd - 0.1);
    trimStartInput.value = String(state.trimStart);
    if (videoPreviewEl && videoPreviewEl.src) videoPreviewEl.currentTime = state.trimStart;
    syncTrimUI();
  });
}

if (trimEndInput) {
  trimEndInput.addEventListener("input", () => {
    state.trimEnd = Math.max(parseFloat(trimEndInput.value) || 0, state.trimStart + 0.1);
    trimEndInput.value = String(state.trimEnd);
    if (videoPreviewEl && videoPreviewEl.src) videoPreviewEl.currentTime = state.trimEnd;
    syncTrimUI();
  });
}

const trimSetStartBtn = document.getElementById("trim-set-start");
if (trimSetStartBtn) {
  trimSetStartBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) return;
    state.trimStart = Math.min(videoPreviewEl.currentTime, state.trimEnd - 0.1);
    if (trimStartInput) trimStartInput.value = String(state.trimStart);
    syncTrimUI();
  });
}

const trimSetEndBtn = document.getElementById("trim-set-end");
if (trimSetEndBtn) {
  trimSetEndBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) return;
    state.trimEnd = Math.max(videoPreviewEl.currentTime, state.trimStart + 0.1);
    if (trimEndInput) trimEndInput.value = String(state.trimEnd);
    syncTrimUI();
  });
}

// Preview exactly the selected range, then stop at the out-point.
const trimPlayBtn = document.getElementById("trim-play");
if (trimPlayBtn) {
  trimPlayBtn.addEventListener("click", () => {
    if (!videoPreviewEl || !videoPreviewEl.src) {
      setVideoStatus("Load a video first.", "error");
      return;
    }
    videoPreviewEl.currentTime = state.trimStart;
    videoPreviewEl.play();
    const stopAtEnd = () => {
      if (videoPreviewEl.currentTime >= state.trimEnd) {
        videoPreviewEl.pause();
        videoPreviewEl.removeEventListener("timeupdate", stopAtEnd);
      }
    };
    videoPreviewEl.addEventListener("timeupdate", stopAtEnd);
  });
}

if (videoMuteInput) {
  videoMuteInput.addEventListener("change", () => {
    state.videoMuted = videoMuteInput.checked;
  });
}

/* The caption is painted by drawPixVideoScreen, which produces both the
   live preview and the PNG ffmpeg burns in — so a repaint is all that's
   needed here, and what you see is exactly what gets exported. */
const videoCaptionInput = document.getElementById("video-caption");
if (videoCaptionInput) {
  videoCaptionInput.addEventListener("input", () => {
    state.videoCaption = videoCaptionInput.value;
    scheduleRender();
  });
}

const videoCaptionSizeInput = document.getElementById("video-caption-size");
if (videoCaptionSizeInput) {
  videoCaptionSizeInput.addEventListener("input", () => {
    state.videoCaptionSize = Number(videoCaptionSizeInput.value) || 48;
    scheduleRender();
  });
}

if (videoFileInput) {
  videoFileInput.addEventListener("change", (e) => loadLocalVideoFile(e.target.files && e.target.files[0]));
}

if (videoFileDrop) {
  videoFileDrop.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    videoFileInput?.click();
  });
  ["dragenter", "dragover"].forEach((ev) =>
    videoFileDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoFileDrop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    videoFileDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      videoFileDrop.classList.remove("dragover");
    })
  );
  videoFileDrop.addEventListener("drop", (e) => {
    const files = (e.dataTransfer && e.dataTransfer.files) || [];
    const file = [...files].find((f) => f.type.startsWith("video/"));
    if (file) loadLocalVideoFile(file);
    else setVideoStatus("Drop a video file.", "error");
  });
}

/* ── Export ── */
/* Render the trim range to an MP4 on the server.
 *
 * Shared by Export and Save. Save stores the *trimmed* clip rather than the
 * source: the source can be a 17-minute file far over Supabase's per-file
 * limit, while the clip is the part that was actually chosen — and it is what
 * gets published.
 */
async function renderTrimmedClip({ width, height, onStatus = () => {} } = {}) {
  const size = (width && height) ? { width, height } : videoTargetSize();
  const duration = state.trimEnd - state.trimStart;
  const overlay = await renderVideoOverlayPng(size.width, size.height);

  const form = new FormData();
  form.append("start", String(state.trimStart));
  form.append("end", String(state.trimEnd));
  form.append("width", String(size.width));
  form.append("height", String(size.height));
  form.append("mute", state.videoMuted ? "true" : "false");
  // ffmpeg must crop the same slice the preview showed, or the exported clip
  // is framed differently from what was approved on screen.
  form.append("focusX", String(state.videoFocus?.x ?? 0.5));
  form.append("focusY", String(state.videoFocus?.y ?? 0.5));
  if (overlay) form.append("overlay", overlay, "overlay.png");
  if (state.videoFile) {
    form.append("video", state.videoFile, state.videoFile.name);
    onStatus(`Uploading and encoding ${duration.toFixed(1)}s… this can take a few minutes.`);
  } else {
    /* Encode from whatever the PREVIEW is playing, not from the original link.
       trimStart/trimEnd are timestamps into the element on screen, so if that
       element is showing the already-trimmed copy from our bucket (a reopened
       post) while this sent the original URL, ffmpeg would cut those seconds
       out of the wrong footage — and fail outright when the original is a
       dead YouTube link or an expired signed URL.

       clipSourceUrl, not storedVideoUrl: the first Save after a re-encode
       moves storedVideoUrl to the NEW upload while the preview keeps playing
       the copy it opened with. Comparing the two then fell through to
       videoUrl, which is "" for an uploaded file, so every later encode in
       that session was refused ("Supply either a url or a video file") and
       the row saved the new caption next to the old, captionless clip. */
    form.append("url", state.clipSourceUrl || state.videoUrl);
    onStatus(`Downloading and encoding ${duration.toFixed(1)}s… this can take a few minutes.`);
  }

  // No AbortController timeout: a long download plus encode legitimately runs
  // for minutes, and aborting here would kill work the server is still doing
  // without telling it to stop.
  // No Content-Type header — the browser sets the multipart boundary.
  const res = await fetch("/api/video/clip", { method: "POST", body: form });
  if (!res.ok) throw new Error(await mediaErrorMessage(res));

  const blob = await res.blob();
  if (blob.size < 1000) throw new Error("The encoder returned an empty file.");
  return blob;
}

async function exportVideoClip() {
  if (state.videoExporting) return;
  const duration = state.trimEnd - state.trimStart;
  if (duration <= 0) { setVideoStatus("Set a trim range first.", "error"); return; }
  if (!state.videoUrl && !state.videoFile) { setVideoStatus("Load a video first.", "error"); return; }

  state.videoExporting = true;
  syncTrimUI();
  setExportWorking(true);
  setVideoStatus("Rendering overlay…");

  try {
    const { width, height } = videoTargetSize();
    /* The key and the page BEFORE the encode, not after.

       The encode runs for minutes and the trim sliders stay live throughout.
       Stamping the finished blob with a key computed on ARRIVAL filed old
       footage under the new range: the row recorded the new in/out points, the
       preview played them, and the stored and published mp4 was the old cut,
       with no error anywhere. resolvePublishClipFromState already reads its
       key before the await; this is the same discipline. */
    const clipKey = videoClipKey();
    const clipOwner = activePage();
    const blob = await renderTrimmedClip({ width, height, onStatus: setVideoStatus });

    const title = (state.videoMeta && state.videoMeta.title) || state.headline || "pix-clip";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${slugify(title)}-slide2.mp4`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);

    setVideoStatus(`Exported ${(blob.size / 1048576).toFixed(1)} MB · ${width}×${height}`, "success");

    /* The encode is done and paid for; keep it so Save can store this exact
       clip without re-rendering it — filed against the page it was rendered
       for, so navigating away mid-export neither loses it nor hands it to a
       different video slide. */
    commitFieldToPage(clipOwner, "renderedClip", { blob, key: clipKey });
  } catch (err) {
    // A dropped connection surfaces as a bare "Failed to fetch", which tells
    // the user nothing — name the likely cause.
    const msg = /failed to fetch|networkerror|load failed/i.test(err.message || "")
      ? "Lost connection to the server during export. The clip may be too large — try a shorter range."
      : (err.message || "Export failed.");
    setVideoStatus(msg, "error");
  } finally {
    state.videoExporting = false;
    setExportWorking(false);
    syncTrimUI();
  }
}

if (videoExportBtn) videoExportBtn.addEventListener("click", exportVideoClip);

// The canvas preview reads frames straight off this element.
if (videoPreviewEl) {
  state.videoEl = videoPreviewEl;
  // Playback drives the rAF loop; everything else is a single repaint.
  // The video card is always visible in the rail, so these fire unconditionally.
  // They used to be gated on state.previewMode === "video", which is only true
  // transiently while that card is being painted — so in practice the guard was
  // always false and the card never updated on play or seek.
  videoPreviewEl.addEventListener("play", () => startVideoPreviewLoop());
  ["seeked", "loadeddata", "pause", "ended"].forEach((ev) =>
    videoPreviewEl.addEventListener(ev, () => {
      // Remember what is loaded, so a video page that later gives up the
      // shared player can reload the same source into its own. Loading a
      // clip is also how a page claims the player in the first place.
      state.videoSrc = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";
      const current = activePage();
      if (current.type === "video") playerOwner = current;
      renderPoster();
    })
  );
}

syncTrimUI();

/* ── Per-card downloads ──
   Each preview card owns its own export. Previously one button exported
   "whatever mode the toggle happened to be in", which is how the X download
   once shipped the Text slide — the mode was ambient state rather than
   something the action declared. Here the button names its slide. */

async function exportSlidePng(mode, targetLongEdges = EXPORT_LONG_EDGES, encode = null) {
  const prev = {
    mode: state.previewMode,
    downloading: state.isDownloading,
    forceText: state.forceTextExport,
    shortly: state.useShortlyLogo,
    /* The caller's text slice belongs in the snapshot too. The restore-render
       in the finally takes renderPoster's full path, which ends every page by
       clearing _detailSlice — so the FIRST compression rung consumed it and
       every rung after it exported the whole paragraph instead of that page's
       slice. On a carousel with two Text pages that publishes both slides with
       identical, overflowing copy. */
    slice: state._detailSlice,
  };
  state.isDownloading = true;
  state.previewMode = mode;
  state.forceTextExport = mode === "text";
  state.useShortlyLogo = false;

  let result = null;
  try {
    result = await renderExportBlob(null, targetLongEdges, encode);
  } catch (err) {
    console.error(`${mode} export failed:`, err);
  } finally {
    state.isDownloading = prev.downloading;
    state.previewMode = prev.mode;
    state.forceTextExport = prev.forceText;
    state.useShortlyLogo = prev.shortly;
    renderPoster();
    /* AFTER the restore-render, not before: that render is itself what clears
       _detailSlice, so restoring first would simply be undone and the next
       compression rung would export the whole paragraph again. */
    state._detailSlice = prev.slice;
  }
  return result;
}

async function downloadSlide(mode) {
  const result = await exportSlidePng(mode);
  if (!result) return null;

  const suffix = mode === "pix" ? "" : `-${mode}`;
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(state.headline || "pix-post")}${suffix}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return result;
}

const previewRail = document.getElementById("preview-rail");
if (previewRail) {
  previewRail.addEventListener("click", async (e) => {
    // Removing a page must not also select it on the way out.
    const removeBtn = e.target.closest("[data-remove-page], [data-remove-card]");
    if (removeBtn) {
      const owner = removeBtn.closest("[data-page]");
      if (!owner) return;
      /* A spine card removes only itself; an added page removes the page.
         Both spine cards share one page, so removing the page would take the
         other card — and the post's content — with it. */
      if (owner.dataset.page === "base") {
        const card = cardForElement(owner);
        if (card) removeCard(card);
      } else {
        removePage(owner.dataset.page);
      }
      return;
    }

    // Clicking the header label (POSTER, TEXT, FOR X, number, etc.) opens the enlarged preview modal
    const anyCardEl = e.target.closest(".preview-card");
    const labelEl = e.target.closest(".preview-card-label");
    if (labelEl && anyCardEl) {
      if (anyCardEl.dataset.previewMode === "x" || anyCardEl.classList.contains("preview-card-pinned")) {
        const xCard = {
          el: anyCardEl,
          mode: "x",
          canvas: xPreviewCanvas || anyCardEl.querySelector("canvas"),
          page: basePage,
          detailSlice: null,
          sliceRange: null,
          isX: true,
        };
        openScreenPreviewModal(xCard);
        return;
      }
      const pageCard = cardForElement(anyCardEl);
      if (pageCard) {
        if (anyCardEl.dataset.page) setActivePage(anyCardEl.dataset.page);
        openScreenPreviewModal(pageCard);
        return;
      }
    }

    /* Selecting first is what makes the per-card exports correct: every
       export path reads live state, so the page has to be live before the
       render starts. Clicking Download on page 4 therefore selects page 4,
       which is also what the writer expects to see happen. */
    const cardEl = e.target.closest(".preview-card[data-page]");
    if (cardEl) setActivePage(cardEl.dataset.page);

    // "Edit" is the same selection, said out loud — the controls that write
    // to this page are in the left column, and on mobile behind the sheet.
    if (e.target.closest("[data-edit-page]")) {
      openEditorForPage(cardEl);
      return;
    }

    const btn = e.target.closest("[data-download]");
    if (!btn) return;
    const mode = btn.dataset.download;

    // X has its own export path: 2x scale (X rejects PNGs over 5 MB),
    // cropped to content, Shortly logo instead of Pix.
    if (mode === "x") {
      downloadXPreview();
      return;
    }

    // The video slide is an MP4 from the server, not a canvas PNG.
    if (mode === "video") {
      if (!state.videoUrl && !state.videoFile) {
        setStatus("Load a video into this page first — open the Video panel.", "error");
        return;
      }
      exportVideoClip();
      return;
    }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Rendering…";
    // Export the slice this card shows, not the whole paragraph — the file
    // has to match the card it was downloaded from.
    const card = cardEl ? cardForElement(cardEl) : null;
    state._detailSlice = card?.detailSlice || null;
    try {
      const r = await downloadSlide(mode);
      setStatus(r ? `Page downloaded (${r.width}×${r.height}).` : "Export failed.", r ? "success" : "error");
    } finally {
      state._detailSlice = null;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

/* Put the writer in front of the controls for the page they just picked.
   On mobile that means opening the sheet; on both, the section that
   matters for this page type. */
function openEditorForPage(cardEl) {
  const page = activePage();
  const openAccordion = (el) => {
    const acc = el?.closest(".acc");
    if (!acc || acc.dataset.open === "true") return;
    acc.dataset.open = "true";
    acc.querySelector(":scope > .acc-head")?.setAttribute("aria-expanded", "true");
  };

  if (isMobile()) setSheetOpen(true);

  const mode = cardEl?.dataset.previewMode;
  const focusTarget = page.type === "video" || mode === "video"
    ? videoFileDrop
    : (mode === "text" ? detailEdit : headlineEdit);

  openAccordion(focusTarget);
  requestAnimationFrame(() => {
    focusTarget?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (focusTarget && !focusTarget.disabled) focusTarget.focus({ preventScroll: true });
  });
}

/* ── Reordering ──
   Dragging the grip moves a page; every number, and the division of the
   paragraph's points, follows from the new order on the next paint.

   The grip is a button rather than the whole card for two reasons: the
   video card already claims pointer drags for reframing, and a focusable
   grip gives the whole feature a keyboard path (← →) that a drag cannot. */

function moveSlot(card, toIndex) {
  const from = slotOrder.indexOf(card);
  if (from < 0) return false;
  let to = Math.max(0, Math.min(toIndex, slotOrder.length));
  if (from < to) to -= 1;
  if (to === from) return false;
  slotOrder.splice(from, 1);
  slotOrder.splice(to, 0, card);
  renumberPages();
  return true;
}

(() => {
  const rail = document.getElementById("preview-rail");
  if (!rail) return;

  let dragging = null;

  // Cards are only draggable while their own grip is held, so a plain drag
  // across a card never starts a reorder.
  rail.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-grip]");
    const fig = grip?.closest(".preview-card[data-page]");
    if (fig) fig.draggable = true;
  });
  rail.addEventListener("pointerup", () => {
    if (!dragging) rail.querySelectorAll(".preview-card[draggable]").forEach((el) => { el.draggable = false; });
  });

  rail.addEventListener("dragstart", (e) => {
    const fig = e.target.closest(".preview-card[data-page]");
    if (!fig || !fig.draggable) { e.preventDefault(); return; }
    dragging = cardForElement(fig);
    if (!dragging) { e.preventDefault(); return; }
    fig.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag without payload.
    e.dataTransfer.setData("text/plain", fig.dataset.page || "page");
  });

  rail.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const overEl = e.target.closest?.(".preview-card[data-page]");
    if (!overEl || overEl === dragging.el) return;
    const over = cardForElement(overEl);
    if (!over) return;
    const rect = overEl.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    moveSlot(dragging, slotOrder.indexOf(over) + (after ? 1 : 0));
  });

  rail.addEventListener("drop", (e) => { if (dragging) e.preventDefault(); });

  rail.addEventListener("dragend", () => {
    if (dragging) dragging.el.classList.remove("is-dragging");
    rail.querySelectorAll(".preview-card[draggable]").forEach((el) => { el.draggable = false; });
    dragging = null;
    // The order changed, so the points divide differently.
    recomputeDetailSlices({ force: true });
    renderPoster();
  });

  // Keyboard path: focus a grip, then arrow the page along the rail.
  rail.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const grip = e.target.closest("[data-grip]");
    const card = grip && cardForElement(grip.closest(".preview-card[data-page]"));
    if (!card) return;
    e.preventDefault();
    const at = slotOrder.indexOf(card);
    if (!moveSlot(card, e.key === "ArrowLeft" ? at - 1 : at + 2)) return;
    recomputeDetailSlices({ force: true });
    renderPoster();
    grip.focus();
    card.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });
})();

/* ── Add page ──
   A menu rather than three buttons: the tile sits in the rail at card
   width, and three labels do not fit there without shrinking to the point
   of being guesswork. */
(() => {
  const tile = document.getElementById("preview-add");
  const btn = document.getElementById("preview-add-btn");
  const menu = document.getElementById("preview-add-menu");
  if (!tile || !btn || !menu) return;

  const setMenuOpen = (open) => {
    menu.hidden = !open;
    // The tile swaps its face for the choices, so the open state lives on
    // the tile — it is what hides the button and widens the column.
    tile.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) menu.querySelector("[data-add-page]")?.focus();
  };
  const closeMenu = () => setMenuOpen(false);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    /* A full rail used to make this button do nothing whatsoever — no menu,
       no message, no explanation — so a writer building a five-slide carousel
       clicked the plus and watched nothing happen, which reads as the editor
       being broken rather than as a limit being reached.

       The limit counts SLIDES, and the post's own Text slide is one of them.
       That is the part nobody can be expected to guess: a fresh post already
       holds two slides (the poster and the text page) before a single page is
       added, so only three can ever be added while both are in the rail. Say
       so, and say what to do about it. */
    if (!canAddPage()) {
      const hasTextSlide = spineCardsInRail().includes("text");
      setStatus(
        hasTextSlide
          ? `This post already has all ${MAX_PAGES} slides — the poster and the Text slide count towards them. Remove the Text slide to make room for another page.`
          : `This post already has all ${MAX_PAGES} slides. Remove one to add another.`,
        "error"
      );
      return;
    }
    setMenuOpen(menu.hidden);
  });

  menu.addEventListener("click", (e) => {
    if (e.target.closest("[data-add-cancel]")) {
      closeMenu();
      btn.focus();
      return;
    }
    const item = e.target.closest("[data-add-page]");
    if (!item) return;
    closeMenu();
    /* One video per post — the rule primaryVideoPage() and the publish path
       have always assumed, without anything enforcing it. A second Video page
       could be added, but every video operation resolves through the PRIMARY
       page: the publish loop shipped the first clip twice and never sent the
       second, and saving uploaded the first page's footage for both. Since
       DailyMattr's API is write-only, that duplicate is permanent. Refusing
       the second page is the honest reading of a model the rest of the code
       already relies on. */
    if (item.dataset.addPage === "video" && pages.some((p) => p.type === "video")) {
      setStatus("A post carries one video, so it has one Video page. Edit the one you have.", "error");
      return;
    }
    addPage(item.dataset.addPage);
  });

  document.addEventListener("click", (e) => {
    if (!menu.hidden && !tile.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
})();

// The way back when an added page is selected. Page 1 is where the post's
// own fields live, so this is also "stop editing an extra".
document.getElementById("page-context-back")?.addEventListener("click", () => {
  setActivePage("base");
  document.getElementById("post-canvas")
    ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
});

// First paint of the counter, the add tile and the selection ring.
renumberPages();

/* ═══ Screen Zoom Preview Modal ═══ */
function openScreenPreviewModal(card) {
  if (!card) return;
  currentModalCard = card;
  const modal = document.getElementById("screen-preview-modal");
  if (!modal) return;
  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }
  updateScreenPreviewModal();
}

function updateScreenPreviewModal() {
  if (!currentModalCard) return;
  const modal = document.getElementById("screen-preview-modal");
  if (!modal) return;

  const numEl = document.getElementById("screen-preview-modal-num");
  const typeEl = document.getElementById("screen-preview-modal-type");
  const modalCanvas = document.getElementById("screen-preview-modal-canvas");
  const canvasWrap = modal.querySelector(".screen-preview-canvas-wrap");
  const headerEl = modal.querySelector(".screen-preview-modal-header");

  const num = cardNumber(currentModalCard);
  const label = cardLabel(currentModalCard).toUpperCase();
  const ratio = state.aspectRatio || "9:16";
  if (numEl) numEl.textContent = num;
  if (typeEl) typeEl.textContent = `${label} · ${ratio}`;

  const srcCanvas = currentModalCard.canvas;
  if (srcCanvas && modalCanvas) {
    modalCanvas.width = srcCanvas.width;
    modalCanvas.height = srcCanvas.height;

    const ratioStr = `${srcCanvas.width} / ${srcCanvas.height}`;
    if (canvasWrap) {
      canvasWrap.style.aspectRatio = ratioStr;
    }
    modalCanvas.style.aspectRatio = ratioStr;

    const mCtx = modalCanvas.getContext("2d");
    mCtx.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
    mCtx.drawImage(srcCanvas, 0, 0);

    requestAnimationFrame(() => {
      const rect = modalCanvas.getBoundingClientRect();
      if (rect.width && headerEl) {
        headerEl.style.maxWidth = `${Math.max(rect.width, 360)}px`;
      }
    });
  }
}

function closeScreenPreviewModal() {
  const modal = document.getElementById("screen-preview-modal");
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
  currentModalCard = null;
}

function stepModalCard(delta) {
  if (!currentModalCard) return;
  const allCards = [...slotOrder];
  const xFig = document.querySelector('.preview-card[data-preview-mode="x"]');
  if (xFig && xPreviewCanvas) {
    allCards.push({
      el: xFig,
      mode: "x",
      canvas: xPreviewCanvas,
      page: basePage,
      detailSlice: null,
      sliceRange: null,
      isX: true,
    });
  }
  if (!allCards.length) return;
  let idx = allCards.findIndex((c) => c.canvas === currentModalCard?.canvas || (c.isX && currentModalCard?.isX));
  if (idx < 0) idx = 0;
  const nextIdx = (idx + delta + allCards.length) % allCards.length;
  currentModalCard = allCards[nextIdx];
  if (currentModalCard?.el?.dataset?.page) {
    setActivePage(currentModalCard.page?.id || currentModalCard.el.dataset.page);
  }
  updateScreenPreviewModal();
}

(() => {
  const modal = document.getElementById("screen-preview-modal");
  const closeBtn = document.getElementById("screen-preview-modal-close");
  const prevBtn = document.getElementById("screen-preview-prev-btn");
  const nextBtn = document.getElementById("screen-preview-next-btn");
  const dlBtn = document.getElementById("screen-preview-download-btn");

  closeBtn?.addEventListener("click", () => closeScreenPreviewModal());
  prevBtn?.addEventListener("click", () => stepModalCard(-1));
  nextBtn?.addEventListener("click", () => stepModalCard(1));

  dlBtn?.addEventListener("click", async () => {
    if (!currentModalCard) return;
    const mode = currentModalCard.mode;
    if (mode === "x") {
      downloadXPreview();
    } else if (mode === "video") {
      if (!state.videoUrl && !state.videoFile) {
        setStatus("Load a video into this page first — open the Video panel.", "error");
        return;
      }
      exportVideoClip();
    } else {
      state._detailSlice = currentModalCard.detailSlice || null;
      try {
        const r = await downloadSlide(mode);
        setStatus(r ? `Page downloaded (${r.width}×${r.height}).` : "Export failed.", r ? "success" : "error");
      } finally {
        state._detailSlice = null;
      }
    }
  });

  // Clicking the dark backdrop closes the modal
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeScreenPreviewModal();
  });

  document.addEventListener("keydown", (e) => {
    if (!modal || (!modal.open && !modal.hasAttribute("open"))) return;
    if (e.key === "Escape") {
      closeScreenPreviewModal();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepModalCard(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepModalCard(1);
    }
  });
})();


/* ── Rail navigation ──
   Arrows page the carousel by one card. They hide themselves when everything
   already fits, so on a wide screen the header stays clean instead of
   carrying two controls that do nothing. */
async function loadDailyMattrMeta({ force = false } = {}) {
  if (!state.user) {
    fillSelectOptions(dailymattrCategory, [], "Sign in to load categories");
    fillSelectOptions(dailymattrState, [], "Optional");
    dailymattrMetaLoaded = false;
    return;
  }
  if (dailymattrMetaLoaded && !force) return;

  setDailyMattrStatus("Loading DailyMattr categories…");
  try {
    const response = await fetch(DAILYMATTR_META_ENDPOINT, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setDailyMattrStatus(payload.error || `Could not load DailyMattr (${response.status}).`, "error");
      return;
    }
    if (!payload.configured) {
      fillSelectOptions(dailymattrCategory, [], "DailyMattr not configured");
      fillSelectOptions(dailymattrState, [], "Optional");
      setDailyMattrStatus(
        payload.missing?.length
          ? `Server setup missing: ${payload.missing.join(", ")}`
          : "DailyMattr is not configured on this server.",
        "error",
      );
      return;
    }

    fillSelectOptions(dailymattrCategory, payload.categories || [], "Choose a category");
    fillSelectOptions(dailymattrState, payload.states || [], "Optional");
    // Options exist now, so the saved choice can actually take.
    syncSectionInputs();
    dailymattrMetaLoaded = true;
    syncDailyMattrDraft();
    setDailyMattrStatus(`DailyMattr ready. ${payload.categories?.length || 0} categories loaded.`, "success");
  } catch (err) {
    setDailyMattrStatus(err.message || "Could not load DailyMattr options.", "error");
  }
}

/* ── Is this post publishable at all? ──

   Set when a publish attempt ended without an answer — the server kept its
   claim on the row and a retry would be refused, but this session should not
   even offer the button. Session-scoped on purpose: it describes what just
   happened in this tab, whereas state.publishedAt describes the row, and a
   reload correctly re-reads the row rather than remembering the scare. */
let publishOutcomeUnknown = false;

/* One place decides whether Publish is available and what it says, because
   three things can close it and they used to be checked nowhere:

     - the row is already live on DailyMattr (their API has no delete, so a
       second publish is a permanent duplicate)
     - a previous attempt's outcome is unknown, so the post may be live
     - the row is rejected, and publishing it would erase the rejection

   Called on load, on role change, and after every publish attempt. The server
   refuses all three as well and is the guard that actually counts; this is
   here so QA finds out BEFORE a multi-minute encode and upload, and so the
   button stops reading "Publish" on a story that is already out.

   `announce` writes the reason to the status line, and defaults OFF because
   most callers run at moments where that would be noise or worse: the finally
   below runs immediately after a SUCCESSFUL publish, where the row is now
   published and re-announcing it as an error would paint over the "Published,
   ID 1379, marked approved" line QA needs to read. Opening a post is the one
   moment the line is empty and the standing is news. */
/* The ids of copies this post has already put on the public site and then
   superseded, oldest first. Not the current one — that is state.publishedId —
   because the two call for different things: the current copy is the story, the
   superseded ones are litter that has to be deleted by hand. */
function supersededPublishedIds() {
  const history = Array.isArray(state.publishedHistory) ? state.publishedHistory : [];
  return history.map((entry) => (entry && entry.id != null ? String(entry.id) : "")).filter(Boolean);
}

function syncPublishState({ announce = false } = {}) {
  if (!dailymattrPublishBtn) return;

  let reason = "";
  let short = "";
  /* A published post with a known ID is not shut — it is the CORRECTION case.
     It used to be blocked here, which made the whole republish path dead code:
     publishToDailyMattr() opens a "Publish a corrected copy?" confirm for
     exactly this state and the server accepts `republish` for it, but neither
     could ever be reached because this function disabled the only button that
     calls them (and the topbar proxy refuses a disabled target). A typo in a
     live story was therefore permanent, which is the opposite of what the
     guard was for: it exists to stop an ACCIDENTAL second send — a reload, a
     stray click, a retry after a timeout — and that job is done by the confirm
     dialog, which names the live ID and says the old copy stays up. So the
     button stays live and says what pressing it will do. */
  let correction = false;
  /* Not gated on state.pixId. An unsaved poster has no library row to claim,
     so the server cannot guard it — but this session knows perfectly well that
     it just sent one, and refusing a second click here is the only thing
     standing between QA and two identical live stories. */
  if (state.publishedAt && state.publishedId && !publishOutcomeUnknown) {
    correction = true;
    short = "Republish";
    const older = supersededPublishedIds();
    reason = `Already live as ID ${state.publishedId}. Publishing again sends a CORRECTED COPY as a new entry — the existing one stays up until you delete it in the DailyMattr portal.`
      /* Named, not counted. Somebody has to go and delete these, and a bare
         "2 earlier copies" sends them hunting through the portal for ids the
         app already knows. */
      + (older.length
          ? ` Earlier ${older.length === 1 ? "copy" : "copies"} still on the site unless already removed: ${older.join(", ")}.`
          : "");
  } else if (state.publishedAt || publishOutcomeUnknown) {
    /* Sent, never confirmed. Deliberately shut rather than merely warned: the
       one thing nobody can do from here is find out, and the retry that feels
       harmless is the one that duplicates a live story. */
    short = "Outcome unknown";
    reason = "A publish of this post was sent and no confirmation came back, so it may already be live. Check the DailyMattr portal before publishing again.";
  } else if (state.pixId && state.rejected) {
    short = "Rejected";
    reason = `Rejected by ${state.rejectedByName || "a reviewer"}. Withdraw the rejection in Review ("Undo reject") before publishing.`;
  }

  const blocked = Boolean(reason) && !correction;
  dailymattrPublishBtn.disabled = blocked;
  dailymattrPublishBtn.textContent = blocked
    ? `${short} — cannot publish`
    : (correction ? "Republish a corrected copy" : "Publish to DailyMattr");
  dailymattrPublishBtn.title = reason;

  /* The topbar button proxies this one. The 500ms mirror copies disabled and
     hidden but not the label, and syncPrimaryAction owns "Publish"/"Submit" —
     so the label is set here for the reviewer case only, leaving a writer's
     "Submit" (which drives Save, not this button) alone. */
  const primary = document.querySelector('.cms-topbar-actions .btn-primary');
  if (primary && primary.dataset.proxy === "dailymattr-publish-btn") {
    primary.textContent = blocked ? short : (correction ? "Republish" : "Publish");
    primary.title = reason || "Publish this pix to the web app";
  }

  /* Say why the button is shut. A disabled control with no explanation reads
     as a broken page, and this one is shut for a reason QA has to act on.

     The correction case is not an error — the button still works — so it is
     announced without the error styling, or opening a published post would
     paint a red line over a post that is doing nothing wrong. */
  if (announce && reason) setDailyMattrStatus(reason, correction ? "" : "error");
}

/* Get the slide-2 MP4 for publishing, by the cheapest route that is still
   correct.

   The bug this replaces: publish always called renderTrimmedClip(), which
   re-encodes from state.videoUrl — the ORIGINAL source. On a reopened post
   that URL is a YouTube link or an expiring signed URL, while the preview the
   writer approved is playing the trimmed copy in our own bucket. So the
   preview and the export were reading from two different places, and the
   export lost: dead link, expired signature, or yt-dlp needed all over again.
   The visible symptom is a post that publishes its images and silently drops
   the video.

   Order of preference:
     1. the clip already rendered in this session
     2. the trimmed copy in our bucket, when nothing has been edited since
     3. a fresh encode — only when there is genuinely nothing to reuse

   videoClipKey() covers trim range, mute, focus, caption and ratio, so any
   edit invalidates 1 and 2 and correctly forces a re-render. */
function resolvePublishClip(onStatus = () => {}) {
  // The clip lives on a video page, so read it from there rather than from
  // whichever page QA left selected.
  return withPrimaryVideo(() => resolvePublishClipFromState(onStatus));
}

async function resolvePublishClipFromState(onStatus = () => {}) {
  const clipKey = videoClipKey();
  if (!clipKey) return null;

  if (state.renderedClip?.key === clipKey && state.renderedClip.blob) {
    return state.renderedClip.blob;
  }

  if (state.storedVideoUrl && state.storedVideoFor === clipKey) {
    try {
      onStatus("Attaching the stored video…");
      const res = await fetch(state.storedVideoUrl);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 1000) return blob;
      }
      // Fall through to a fresh encode rather than failing — the bucket object
      // could have been pruned.
      console.warn("stored clip unreadable, re-encoding");
    } catch (err) {
      console.warn("stored clip fetch failed, re-encoding:", err.message);
    }
  }

  const videoReady = state.videoEl
    && state.videoEl.readyState >= 2
    && state.videoEl.videoWidth > 0
    && state.trimEnd > state.trimStart;
  if (!videoReady) return null;

  onStatus("Rendering the video — this can take a few minutes…");
  const blob = await renderTrimmedClip({ onStatus });
  if (blob) state.renderedClip = { blob, key: clipKey };
  return blob;
}

/* Assembly moves the SELECTION from page to page and waits on a multi-second
   PNG encode at each stop (see the loop below). For those seconds live state
   belongs to whichever page is being exported, and the idle poller has no way
   to tell that from a person editing — so publishing a post with a second
   Poster page could write that page's headline, tag and image into the post's
   own columns, permanently if QA closed the tab on the "Published" dialog.
   Publishing owns the row while it runs. */
let publishInFlight = false;

/* Returns true only when DailyMattr accepted the post; every other path falls
   out as undefined. Approve & Publish reads that, because it hands control back
   to the Review list where the publish panel's own status line is off screen.

   `skipConfirm` is for callers that have already shown their own confirmation —
   not a way to publish without one. */
async function publishToDailyMattr({ skipConfirm = false } = {}) {
  /* Local, not module-scoped. It describes one press — set by the republish
     confirm, read when the form is built — and as a module variable every
     early return between those two points (a missing category, an unloaded
     meta list, a media validation refusal) leaked it into the next press,
     because only the finally cleared it and none of those returns reach one.
     A leaked `true` is the worst possible value to leak: it is the field that
     lifts the already-published guard, so the following ordinary publish would
     have gone out unguarded. Scoped to the call, that cannot happen. */
  let republishRequested = false;
  if (!state.user) {
    setDailyMattrStatus("Sign in to publish.", "error");
    return;
  }
  if (!state.headline.trim()) {
    setDailyMattrStatus("Build a poster first.", "error");
    return;
  }
  /* The states that make publishing wrong rather than merely unnecessary.
     syncPublishState() has already disabled the button for each of them, so
     this is the belt to that braces — the button can be re-enabled by the
     proxy mirror, a stale render or a keyboard activation, and the cost of
     getting through is a permanent duplicate on a public site. The server
     refuses them as well; this exists so QA is told before the encode rather
     than after it.

     The walls come FIRST, before the republish confirm below. A post can be
     both published and rejected — QA can reject one it already sent — and
     asked in the other order that post got the "publish a corrected copy?"
     dialog, was answered yes, and was then refused anyway by the rejection
     wall. A confirmation collected for an action that cannot happen is how
     people learn to click through them. */
  if (publishOutcomeUnknown) {
    setDailyMattrStatus(
      "The last publish was sent and no confirmation came back — this post may already be live. Check the DailyMattr portal before publishing again.",
      "error",
    );
    return;
  }
  if (state.pixId && state.rejected) {
    setDailyMattrStatus(
      `This post was rejected by ${state.rejectedByName || "a reviewer"}. Withdraw the rejection in Review ("Undo reject") before publishing — publishing it would erase who turned it down and when.`,
      "error",
    );
    return;
  }
  if (state.publishedAt) {
    /* Two different situations, and only one of them can be offered a way
       forward.

       KNOWN live (we hold an id): a correction has nowhere else to go, since
       DailyMattr cannot edit an entry. So this is a real choice — send the
       edited version as a NEW entry — rather than a wall. It is a confirm,
       not a notice, and the wording has to be blunt: republishing does not
       replace anything. The old story stays up until somebody removes it in
       their portal by hand, and the dialog names the id to remove.

       UNKNOWN (a publish was started and never confirmed): still a wall. We
       cannot say whether the first attempt is live, so "publish another copy"
       might mean one copy or two, and nobody can tell which afterwards. Their
       portal is the only place that knows. */
    if (!state.publishedId) {
      const message = "A publish of this post was started and never confirmed, so it may already be live. Check the DailyMattr portal before publishing again.";
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Publish outcome unknown",
        body: message,
        facts: ["No DailyMattr ID was recorded for that attempt — only their portal can say whether the story exists."],
        confirmLabel: "Close",
      });
      return;
    }

    const goAgain = await confirmAction({
      title: "Publish a corrected copy?",
      body: `This story is already live as ID ${state.publishedId}. DailyMattr cannot edit an entry, so the corrected version goes up as a SEPARATE new post with its own ID.`,
      facts: [
        `The existing copy (ID ${state.publishedId}) stays live until you delete it in the DailyMattr portal.`,
        "Both versions will be on the site until you do.",
        /* The old line promised the ids were "kept, so you can find the old
           ones" without ever showing them — they were in published_history and
           readable nowhere. Listed here instead, because this dialog is the
           moment the list grows by one. */
        supersededPublishedIds().length
          ? `Already superseded, and still up unless removed: ${supersededPublishedIds().join(", ")}.`
          : "Every ID this post produces is kept, so the older ones stay findable.",
      ],
      confirmLabel: "Publish as new",
      danger: true,
    });
    if (!goAgain) {
      setDailyMattrStatus("Not republished — the live copy is unchanged.", "");
      return;
    }
    republishRequested = true;
  }
  if (!dailymattrMetaLoaded) {
    await loadDailyMattrMeta({ force: true });
    if (!dailymattrMetaLoaded) return;
  }

  const categoryId = dailymattrCategory?.value || "";
  const stateId = dailymattrState?.value || "";
  const content = (dailymattrContent?.value || "").trim() || defaultDailyMattrContent();
  /* Priority: what QA typed here, then what the writer saved with the post,
     then a guess from the headline. The writer's wording used to be discarded
     — keywords were only ever inferred at publish time — so a deliberate
     choice lost to an automatic one. */
  const keywords = (dailymattrKeywords?.value || "").trim()
    || (state.keywords || "").trim()
    || inferDailyMattrKeywords();
  const mediaError = validateDailyMattrExtraFiles();
  if (!categoryId) {
    setDailyMattrStatus("Choose a DailyMattr category.", "error");
    return;
  }
  if (!content) {
    setDailyMattrStatus("Enter a caption before publishing.", "error");
    return;
  }
  if (mediaError) {
    setDailyMattrStatus(mediaError, "error");
    return;
  }
  /* Same idea for the clip length. MAX_CLIP_SECONDS was enforced in exactly
     two places: the Export button, which greys out with no explanation, and
     the server — AFTER the entire several-hundred-megabyte upload had been
     received. So a writer who dragged the end handle past the limit watched
     every slide render and the whole file upload, and only then read "Clip is
     200s; the limit is 90s." Checked here it costs a click. */
  const clipForLimit = primaryVideoContent();
  const clipSeconds = (clipForLimit.trimEnd ?? 0) - (clipForLimit.trimStart ?? 0);
  if (clipSeconds > MAX_CLIP_SECONDS) {
    setDailyMattrStatus(
      `The video is ${clipSeconds.toFixed(0)}s and the limit is ${MAX_CLIP_SECONDS}s. Shorten the trim range on the Video page, then publish.`,
      "error",
    );
    return;
  }

  /* DailyMattr rejects the State category without a state. Caught here so the
     failure costs a click, not a multi-minute video encode and upload first. */
  if (stateIsRequired(categoryId) && !stateId) {
    setDailyMattrStatus("The State category needs a state. Choose one above, then publish.", "error");
    dailymattrState?.focus();
    return;
  }

  /* The one genuinely irreversible action in the app: DailyMattr has no
     delete route on the integration API, so a mistaken publish has to be
     removed by hand from their portal. Worth one click to confirm, and worth
     showing exactly what is about to go. */
  const catLabel = dailymattrCategory?.selectedOptions?.[0]?.textContent || "none";
  const stLabel = dailymattrState?.value ? (dailymattrState.selectedOptions?.[0]?.textContent || "") : "";
  /* Read the clip off the video page, not off live state: the video moved
     onto its own page, so `state.video*` only holds it while that page is
     the selected one — and QA confirms this dialog from page 1. */
  const clip = primaryVideoContent();
  /* Mirror videoClipKey()'s own gate — a source AND a real trim range — rather
     than accepting a stored URL on its own. The two predicates used to
     disagree: the dialog said "including the video" whenever storedVideoUrl
     was set, while the assembly needs trimEnd > trimStart, which on a
     just-reopened post is not true until the <video> fires loadedmetadata.
     QA confirmed a count the publish could not deliver. The assembly now
     aborts instead of skipping (see the loop below), so a disagreement is
     loud either way — but it should not arise in the first place. */
  const hasVideo = Boolean(
    (clip.storedVideoUrl || clip.videoUrl || clip.videoFile)
    && clip.trimEnd > clip.trimStart
  );
  const extraCount = dailyMattrExtraFiles().length;
  /* Count the same way the assembly does — every card in the rail plus the
     attached files — or the dialog promises a number the publish will not
     deliver. It previously counted a fixed poster+text+clip, which silently
     under-reported the moment a third page existed. */
  const railCount = slotOrder.filter((card) => card.mode !== "video" || hasVideo).length;
  const mediaCount = railCount + extraCount;

  /* Approve & Publish has already shown this same warning and collected the
     category, so a second identical dialog would only train QA to click
     through it. This skips the duplicate, never the confirmation. */
  /* `republishRequested` counts as a confirmation. The republish dialog above
     is the stronger of the two — it names the live ID, says the old copy stays
     up, and its button reads "Publish as new" — so following it with the
     generic "Publish to DailyMattr?" would ask a weaker version of a question
     just answered, and a second dialog is exactly where people stop reading. */
  const go = (skipConfirm || republishRequested) ? true : await confirmAction({
    title: "Publish to DailyMattr?",
    body: "This goes live on shortlyindia.com straight away. It cannot be undone from here — a mistake has to be removed from their portal by hand.",
    facts: [
      `Category: ${catLabel}${stLabel ? ` \u00b7 ${stLabel}` : ""}`,
      `${mediaCount} media item${mediaCount === 1 ? "" : "s"}${hasVideo ? ", including the video" : ""}`,
      state.pixId ? "The post will be marked approved" : "Not saved yet, so it will not be marked approved",
    ],
    confirmLabel: "Publish now",
  });
  if (!go) return;

  /* Claimed before anything else, and cleared in the finally that also
     re-enables the button: every early return in the body below is inside
     that try, so there is no path out of here that leaves it set. Disabling
     dailymattrPublishBtn is not enough on its own — considerAutosave() only
     stands down for savePixBtn, which publishing never touches. */
  publishInFlight = true;
  dailymattrPublishBtn.disabled = true;
  dailymattrPublishBtn.textContent = "Publishing…";
  setDailyMattrStatus("Rendering slide images…");
  /* Divides the catch below into "nothing left the browser" and "we do not
     know". Everything up to the fetch — rendering, encoding, assembling the
     form — is local, so a throw there is provably harmless; after it, it is
     not. */
  let publishRequestSent = false;

  try {

    const form = new FormData();
    form.append("content_en", content);
    form.append("category_id", categoryId);
    if (keywords) form.append("keywords", keywords);
    if (stateId) form.append("state_id", stateId);
    if (state.sourceUrl) form.append("source_url", state.sourceUrl);
    // Lets the server mark this post approved once DailyMattr accepts it —
    // sending a story live IS the approval. Absent when the poster was never
    // saved, in which case there is no library row to mark.
    if (state.pixId) form.append("pix_id", state.pixId);
    /* Sent only when QA has just answered the republish dialog, and cleared
       the moment this attempt ends — a flag that outlived its confirmation
       would turn the next ordinary publish into an unguarded one. */
    if (republishRequested) form.append("republish", "true");
    /* Publish every page in the rail, in the order the reader will swipe
       them — not a fixed poster-plus-text pair.

       This used to export exactly one "pix" card and one "text" card. Once
       pages became addable (up to five, of any type) that quietly dropped
       everything past the first two: a writer could build a four-page story,
       press publish, and have pages three and four vanish with no warning.
       The confirmation dialog counted the same way, so it did not warn
       either — it under-reported and the mismatch was invisible.

       Each card is exported from ITS page. setActivePage swaps the page's
       content into live state (headline, tag, filters, framing) and
       syncActivePageContent folds the current one back first, so a second
       poster page exports its own headline rather than page one's. The
       original selection is restored in the finally, whatever happens.

       The "For X" card stays out of this: it is a Twitter/X crop with its own
       framing, and on the news app it would read as a duplicate of the poster
       in the wrong aspect. It is not in slotOrder, so it is excluded by
       construction rather than by a filter someone has to remember. */
    const slug = slugify(state.headline || "pix-post");
    const outboundMedia = [];
    const restorePageId = activePageId;
    try {
      for (const card of slotOrder) {
        const n = outboundMedia.length + 1;
        setActivePage(card.el?.dataset?.page || "base", { force: true });

        if (card.mode === "video") {
          setDailyMattrStatus(`Preparing page ${n} (video)…`);
          const clip = await resolvePublishClip((msg) => setDailyMattrStatus(msg));
          /* Abort, do not skip. This was `continue`, and it was the only
             failure in this loop that did not stop the publish — the oversize
             branch just below and the failed-PNG branch further down both
             return. So a post whose clip could not be prepared went live with
             its images only, after a dialog that had just told QA the video
             was included, and the success dialog reported nothing missing.
             DailyMattr's API is write-only, so there is no adding it
             afterwards: the story is permanently a partial.

             Both surviving causes are invisible to QA and both are ordinary.
             The clip key is null until the reopened <video> fires
             loadedmetadata (state.trimEnd is 0 until then), and a stored clip
             whose bucket URL has expired or 404s never fires it at all — so
             that second one silently drops the video on EVERY publish of that
             post. Neither is a reason to ship a partial story. */
          if (!clip) {
            const message = `Page ${n}'s video could not be prepared, so nothing was published. Open the Video page, wait for the clip to load, and try again — if it never loads, its stored copy is gone and the video must be re-added.`;
            setDailyMattrStatus(message, "error");
            confirmAction({
              notice: true,
              title: "Not published",
              body: message,
              facts: ["Nothing was sent — the post is unchanged and still publishable."],
              confirmLabel: "Close",
            });
            return;
          }
          if (clip.size > DAILYMATTR_MAX_MEDIA_BYTES) {
            const mb = (v) => (v / 1048576).toFixed(1);
            setDailyMattrStatus(
              `Page ${n}'s clip is ${mb(clip.size)} MB, over the ${mb(DAILYMATTR_MAX_MEDIA_BYTES)} MB limit. Shorten the trim range and try again.`,
              "error",
            );
            return;
          }
          outboundMedia.push({ blob: clip, filename: `${slug}-p${n}.mp4` });
          continue;
        }

        // A text card shows one slice of the paragraph; export the slice that
        // card displays, or the file will not match what is on screen.
        setDailyMattrStatus(`Rendering page ${n}…`);
        state._detailSlice = card.detailSlice || null;
        let shot = null;
        try {
          shot = await exportSlideForPublish(card.mode);
        } finally {
          state._detailSlice = null;
        }
        if (!shot?.blob) {
          setDailyMattrStatus(`Could not render page ${n}.`, "error");
          return;
        }
        // Extension follows the encoder — a JPEG named .png is refused by a
        // validator that checks the two against each other.
        outboundMedia.push({
          blob: shot.blob,
          filename: `${slug}-p${n}${shot.blob.type === "image/jpeg" ? ".jpg" : ".png"}`,
        });
      }
    } finally {
      setActivePage(restorePageId, { force: true });
    }

    if (!outboundMedia.length) {
      setDailyMattrStatus("There is nothing to publish yet — build at least one page.", "error");
      return;
    }

    for (const { file } of dailyMattrExtraFiles()) {
      const squeezed = await compressAttachedImage(file);
      if (squeezed !== file) {
        setDailyMattrStatus(
          `Compressed ${file.name} from ${mbLabel(file.size)} to ${mbLabel(squeezed.size)}…`,
        );
      }
      outboundMedia.push({ blob: squeezed, filename: squeezed.name || file.name });
    }
    if (outboundMedia.length > DAILYMATTR_MAX_MEDIA_ITEMS) {
      setDailyMattrStatus(
        `This post has ${outboundMedia.length} media files and DailyMattr accepts ${DAILYMATTR_MAX_MEDIA_ITEMS}. Remove one and try again.`,
        "error",
      );
      return;
    }
    /* The whole-post weight, checked before anything leaves the browser.

       DailyMattr's refusal for an oversized post is "Validation Error" and
       nothing else — no field, no size, no limit — so left to them this fails
       with the one message QA cannot act on. Checked here it fails with the
       numbers, and only after compression has already had its go, so this
       fires for a genuinely huge post rather than for a normal one. */
    const isVideoItem = (m) => String(m.blob?.type || "").startsWith("video/");
    const totalBytes = outboundMedia.reduce((sum, m) => sum + (m.blob?.size || 0), 0);
    const videoBytes = outboundMedia.filter(isVideoItem)
      .reduce((sum, m) => sum + (m.blob?.size || 0), 0);
    const slideBytes = totalBytes - videoBytes;

    const heaviest = (items) => [...items]
      .sort((a, b) => (b.blob?.size || 0) - (a.blob?.size || 0))
      .slice(0, 3)
      .map((m, i) => `${i + 1}. ${m.filename} — ${mbLabel(m.blob.size)}`);

    /* The pictures, which we render and can compress. Video is excluded on
       purpose — see the two constants. */
    if (slideBytes > DAILYMATTR_SLIDES_BUDGET_BYTES) {
      const message = `The pictures in this post come to ${mbLabel(slideBytes)}, over the ${mbLabel(DAILYMATTR_SLIDES_BUDGET_BYTES)} limit.`;
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Too large to publish",
        body: message,
        facts: [
          "Nothing was sent — the post is unchanged.",
          "The heaviest items:",
          ...heaviest(outboundMedia.filter((m) => !isVideoItem(m))),
          "Remove a slide, or replace the heaviest picture with a smaller one.",
        ],
        confirmLabel: "Close",
      });
      return;
    }

    /* The whole upload. Only a very long clip can reach this, and the remedy
       is a shorter trim — not "replace a picture", which is what this used to
       tell people holding a perfectly ordinary video. */
    if (totalBytes > DAILYMATTR_TOTAL_CEILING_BYTES) {
      const message = `This post is ${mbLabel(totalBytes)} of media, over the ${mbLabel(DAILYMATTR_TOTAL_CEILING_BYTES)} limit.`;
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Too large to publish",
        body: message,
        facts: [
          "Nothing was sent — the post is unchanged.",
          "The heaviest items:",
          ...heaviest(outboundMedia),
          videoBytes
            ? `The video accounts for ${mbLabel(videoBytes)} — shorten its trim range on the Video page.`
            : "Remove a slide, or replace the heaviest picture with a smaller one.",
        ],
        confirmLabel: "Close",
      });
      return;
    }
    console.info(
      `[pix] publishing ${outboundMedia.length} media, ${mbLabel(totalBytes)} total` +
      (videoBytes ? ` (${mbLabel(videoBytes)} video)` : ""),
    );

    // Numbered by position, so the pages are always 1..N with no gaps no
    // matter which of the optional items are present.
    outboundMedia.forEach(({ blob, filename }, index) => {
      form.append(`media_page_${index + 1}`, blob, filename);
    });

    setDailyMattrStatus("Sending to DailyMattr…");
    /* From here on the request is in the air. If anything below throws — an
       aborted fetch, a dropped connection, the tab going offline mid-upload —
       the server may already have forwarded the whole thing to DailyMattr, so
       the catch must not report it as a clean failure. */
    publishRequestSent = true;
    const response = await fetch(DAILYMATTR_PUBLISH_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setDailyMattrStatus(payload.error || `Publish failed (${response.status}).`, "error");

      /* Two very different failures used to read identically. The dialog said
         "Nothing was sent — fix the problem and publish again" for every
         non-200, including the case where DailyMattr had accepted the post and
         only the answer went missing. QA did as instructed and the story went
         live twice, permanently — their API has no delete.

         The server now says which it was. `indeterminate` means the request
         left it and no usable answer came back; nobody, on either side, can
         tell whether the story exists. The only correct instruction is to go
         and look, so this never invites a retry and the button stays shut for
         the rest of the session. */
      if (payload.indeterminate) {
        publishOutcomeUnknown = true;
        confirmAction({
          notice: true,
          title: "Publish outcome unknown",
          body: payload.error
            || "The post was sent to DailyMattr and no confirmation came back, so it may already be live.",
          facts: [
            "Do NOT publish again yet — a second attempt would create a second live story that cannot be deleted.",
            "Open the DailyMattr portal and check whether this story is there.",
            "If it is not there, reload this page and publish once more.",
          ],
          confirmLabel: "Close",
        });
        return;
      }

      /* Already published, or rejected: the server refused before sending
         anything. Adopt what it told us about the row so the button and the
         status line stop offering an action that cannot succeed — the client's
         copy is stale precisely because someone else changed the row. */
      if (payload.alreadyPublished) {
        state.publishedAt = payload.publishedAt || new Date().toISOString();
        state.publishedId = payload.publishedId || null;
      }
      if (payload.rejected) {
        state.rejected = true;
        state.rejectedByName = payload.rejectedByName || state.rejectedByName;
      }

      /* A failure needs the dialog more than a success does: the post is NOT
         live, and a red line at the foot of the column is exactly the thing
         someone scrolls past before assuming it went out. */
      /* What was actually wrong, one line per field, above the generic
         reassurance. This dialog used to carry a single sentence and the fact
         "Nothing was sent — fix the problem and publish again", which told QA
         to fix something the dialog had never named: the per-field refusals
         from DailyMattr were parsed away long before they reached here, so a
         carousel rejected over one bad slide read exactly like a carousel
         rejected for any other reason. */
      const refusals = Array.isArray(payload.details) ? payload.details.filter(Boolean) : [];
      confirmAction({
        notice: true,
        title: payload.alreadyPublished ? "Already published" : "Not published",
        body: (refusals.length ? payload.summary : "")
          || payload.error
          || `DailyMattr refused the post (HTTP ${response.status}).`,
        facts: [
          ...(refusals.length ? ["DailyMattr refused it because:", ...refusals] : []),
          payload.alreadyPublished || payload.rejected
            ? "Nothing was sent this time."
            : "Nothing was sent — the post is unchanged and still publishable.",
        ],
        confirmLabel: "Close",
      });
      return;
    }

    const publishedId = payload.publishedId ? ` ID ${payload.publishedId}.` : "";

    /* The row is now live, so record that here too — the button must close
       immediately rather than only after the next reload. `publishRecord`
       reports whether the server managed to write the id onto the row; the
       claim itself is committed either way, so the guard holds regardless and
       what a failure costs is only the id. */
    state.publishedAt = payload.publishRecord?.publishedAt || new Date().toISOString();
    state.publishedId = payload.publishRecord?.publishedId || payload.publishedId || null;
    /* `??`, not `||`: an empty array is the truthful answer for a first
       publish, and falling through to the old value on it would leave a
       corrected post still listing the copy it just superseded as current. */
    state.publishedHistory = payload.publishRecord?.publishedHistory ?? state.publishedHistory;
    // Publishing approves, and approval takes a post out of draft server-side.
    state.isDraft = false;
    /* Carried in state for the same reason as publishedAt: the row has a
       verdict now, and autosave refuses to rewrite a post that has one. The
       publish flag alone would cover this tab, but the two travel together
       everywhere else and a half-updated standing is how they drift apart. */
    if (payload.approval?.ok) state.approved = true;

    /* Say what happened to the approval as well as the publish. The two can
       legitimately disagree — the story is live either way, but if it was not
       marked approved QA needs to know to do it by hand, and a bare
       "Published" would hide that. */
    let approvalNote = "";
    if (payload.approval?.ok) {
      approvalNote = payload.approval.alreadyApproved ? " Already approved." : " Marked approved.";
    } else if (payload.approval?.reason === "post not saved") {
      approvalNote = " Save the post to mark it approved.";
    } else if (payload.approval) {
      approvalNote = ` Published, but could not mark it approved (${payload.approval.reason}) — approve it in Review.`;
    }
    setDailyMattrStatus(`Published to DailyMattr.${publishedId}${approvalNote}`, "success");

    /* And say it in a dialog. Publishing is the one action in this app that
       cannot be undone — the story is on a public site and their API is
       write-only, so a mistake means asking DailyMattr to delete a row. A
       status line at the foot of a scrolling column is the wrong weight for
       that, and it was being missed.

       The id is the useful part: it is the only handle anyone has if the post
       later needs pulling, and it exists nowhere else on our side. */
    const facts = [];
    if (payload.publishedId) facts.push(`DailyMattr ID ${payload.publishedId}`);
    if (state.headline) facts.push(cleanHeadlineForPublish(state.headline));
    /* What actually went, not what was promised. An irreversible action should
       end with a receipt someone can reconcile against the live post — the
       count and whether a clip was among it are the two things that were
       silently wrong before the assembly learned to abort. */
    const sentVideos = outboundMedia.filter(({ filename }) => /\.(mp4|mov)$/i.test(filename)).length;
    facts.push(`${outboundMedia.length} media item${outboundMedia.length === 1 ? "" : "s"} sent`
      + (sentVideos ? `, including ${sentVideos === 1 ? "the video" : `${sentVideos} videos`}` : ", no video"));
    if (payload.publishRecord && payload.publishRecord.ok === false && payload.publishRecord.reason !== "post not saved") {
      facts.push(`Warning: the DailyMattr ID could not be saved onto this post (${payload.publishRecord.reason}). Write it down.`);
    }
    if (approvalNote.trim()) facts.push(approvalNote.trim());
    confirmAction({
      notice: true,
      title: "Published",
      body: "This pix is live on the web app.",
      facts,
      confirmLabel: "Done",
    });

    // The badge in Review is rebuilt on entry, but refresh now so a QA who is
    // already looking at the list sees it flip.
    if (payload.approval?.ok) loadReviewQueue();
    return true;
  } catch (err) {
    /* The quietest path of all, and until now the one that showed no dialog.
       If the request had already left the browser, this is the same
       indeterminate state the server reports with `indeterminate` — an aborted
       upload, a dropped connection, a tab put to sleep — and the server may
       well have forwarded the whole post to DailyMattr before the socket
       closed. Say so, and stop offering the button. */
    if (publishRequestSent) {
      publishOutcomeUnknown = true;
      const message = "The connection dropped while this post was being sent, so it may already be live on DailyMattr. "
        + "Check their portal before publishing again — a second attempt cannot be undone.";
      setDailyMattrStatus(message, "error");
      confirmAction({
        notice: true,
        title: "Publish outcome unknown",
        body: message,
        facts: [
          err.message || "The upload failed part-way through.",
          "Do NOT publish again until you have checked the DailyMattr portal.",
        ],
        confirmLabel: "Close",
      });
    } else {
      setDailyMattrStatus(err.message || "Could not publish to DailyMattr.", "error");
    }
  } finally {
    publishInFlight = false;
    /* Not `disabled = false` any more. syncPublishState() owns both the label
       and the disabled flag, and it is the only thing that knows the post is
       now published, or that the last attempt's outcome is unknown — putting
       "Publish to DailyMattr" back on an enabled button in either of those
       cases is precisely how a duplicate gets made. */
    syncPublishState();
  }
}

if (dailymattrRefreshBtn) {
  dailymattrRefreshBtn.addEventListener("click", () => loadDailyMattrMeta({ force: true }));
}
if (dailymattrPublishBtn) {
  // Wrapped, so the click event is never read as the options object.
  dailymattrPublishBtn.addEventListener("click", () => publishToDailyMattr());
}
if (dailymattrContent) {
  dailymattrContent.addEventListener("input", () => { dailymattrDraftTouched.content = true; });
}
if (dailymattrKeywords) {
  dailymattrKeywords.addEventListener("input", () => { dailymattrDraftTouched.keywords = true; });
}
/* QA overriding the section is a deliberate act, so it must not be undone by a
   later sync from the post. Same contract the caption and keywords already
   use. */
if (dailymattrCategory) {
  dailymattrCategory.addEventListener("change", () => {
    dailymattrDraftTouched.category = true;
    state.categoryId = dailymattrCategory.value;
    if (!stateIsRequired(state.categoryId)) {
      state.stateId = "";
      dailymattrDraftTouched.state = false;
    }
    syncSectionInputs();
  });
}
if (dailymattrState) {
  dailymattrState.addEventListener("change", () => {
    dailymattrDraftTouched.state = true;
    state.stateId = dailymattrState.value;
    syncSectionInputs();
  });
}
dailymattrMediaInputs.forEach((item) => {
  item.input?.addEventListener("change", () => {
    const file = item.input.files?.[0] || null;
    if (!file) {
      resetDailyMattrMediaSlot(item);
      return;
    }
    const error = validateDailyMattrExtraFiles();
    if (error) {
      resetDailyMattrMediaSlot(item);
      setDailyMattrStatus(error, "error");
      return;
    }
    if (item.name) item.name.textContent = file.name;
    if (item.card) item.card.classList.add("has-file");
    if (item.remove) item.remove.hidden = false;
    syncDailyMattrMediaCount();
    setDailyMattrStatus(`Output ${item.slot} ready.`, "success");
  });
  item.remove?.addEventListener("click", () => resetDailyMattrMediaSlot(item));
});

(() => {
  const rail = document.getElementById("preview-rail");
  const prev = document.getElementById("rail-prev");
  const next = document.getElementById("rail-next");
  if (!rail || !prev || !next) return;

  const step = () => {
    const card = rail.querySelector(".preview-card");
    // Card width plus the gap, so one press moves exactly one card.
    const gap = parseFloat(getComputedStyle(rail).columnGap || getComputedStyle(rail).gap || "14") || 14;
    return card ? card.getBoundingClientRect().width + gap : rail.clientWidth * 0.8;
  };

  const scrollable = () => rail.scrollWidth - rail.clientWidth > 4;

  function sync() {
    const on = scrollable();
    prev.hidden = next.hidden = !on;
    if (!on) return;
    // Disable rather than hide at the ends — a control that vanishes
    // mid-interaction makes the row jump.
    prev.disabled = rail.scrollLeft <= 2;
    next.disabled = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
  }

  prev.addEventListener("click", () => rail.scrollBy({ left: -step(), behavior: "smooth" }));
  next.addEventListener("click", () => rail.scrollBy({ left:  step(), behavior: "smooth" }));
  rail.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  // The cards resize when the aspect ratio changes, which changes whether the
  // rail overflows at all.
  if (window.ResizeObserver) new ResizeObserver(sync).observe(rail);

  // Layout is not settled when this module runs, so the first sync would read
  // scrollWidth === clientWidth and leave the arrows in the wrong state.
  sync();
  requestAnimationFrame(sync);
  window.addEventListener("load", sync);
})();


/* ── Drag to reframe a video page ──
   Cropping a landscape clip to 9:16 throws away most of its width, so the
   default centre crop often cuts the subject in half. Dragging the video
   card picks the slice to keep. The value is normalised, so the preview and
   ffmpeg's crop agree at any resolution.

   Every video page gets this, so the handler takes the canvas and the page
   it belongs to: the drag edits live state, which means the page has to be
   the selected one first. Grabbing an unselected card selects it, so the
   gesture works on first touch rather than needing a click to arm it. */
function attachVideoReframe(card, pageId) {
  if (!card) return;
  card.classList.add("video-reframe");

  let dragging = false;
  let startX = 0, startY = 0, startFocus = null;

  const hasVideo = () => {
    const v = state.videoEl;
    return v && v.readyState >= 2 && v.videoWidth > 0;
  };

  // How far the frame can travel on each axis, in canvas pixels. Zero on the
  // axis that exactly fits — dragging there would only reveal black.
  function overflow() {
    const v = state.videoEl;
    const scale = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
    return {
      x: Math.max(0, v.videoWidth * scale - canvas.width),
      y: Math.max(0, v.videoHeight * scale - canvas.height),
    };
  }

  function pointerDown(e) {
    if (pageId && activePageId !== pageId) setActivePage(pageId);
    if (!hasVideo()) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startFocus = { ...(state.videoFocus || { x: 0.5, y: 0.5 }) };
    card.setPointerCapture?.(e.pointerId);
    card.classList.add("dragging");
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!dragging) return;
    const rect = card.getBoundingClientRect();
    // The card is displayed smaller than the canvas, so convert CSS pixels
    // of travel into canvas pixels before dividing by the overflow.
    const scaleToCanvas = canvas.width / rect.width;
    const over = overflow();
    const dx = (e.clientX - startX) * scaleToCanvas;
    const dy = (e.clientY - startY) * scaleToCanvas;
    const next = {
      x: over.x ? clamp(startFocus.x - dx / over.x, 0, 1) : 0.5,
      y: over.y ? clamp(startFocus.y - dy / over.y, 0, 1) : 0.5,
    };
    state.videoFocus = next;
    scheduleRender();
  }

  function pointerUp(e) {
    if (!dragging) return;
    dragging = false;
    card.releasePointerCapture?.(e.pointerId);
    card.classList.remove("dragging");
  }

  card.addEventListener("pointerdown", pointerDown);
  card.addEventListener("pointermove", pointerMove);
  card.addEventListener("pointerup", pointerUp);
  card.addEventListener("pointercancel", pointerUp);

  // Double-click recentres — quicker than dragging back by feel.
  card.addEventListener("dblclick", () => {
    if (pageId && activePageId !== pageId) setActivePage(pageId);
    state.videoFocus = { x: 0.5, y: 0.5 };
    renderPoster();
  });
}

// Video pages get this when they are created; there is no video card on the
// spine any more, so nothing to attach here.

// Timestamp toggle — the stamp is on by default; some posters do not want it.
/* ── Date on the slide, and keywords ─────────────────────────────────
   state.createdAt existed but was never assigned, so formatCreatedAt() always
   fell through to new Date() — the stamp read "today" and no one could change
   it. That is wrong whenever a story is written up a day after the event.

   Kept as a real Date in state and stored as ISO in the design snapshot, so
   the value survives a save and does not drift with the reader's timezone.
   Null still means "today", which is the behaviour everything had before. */
const postDateInput = document.getElementById("post-date");
const postKeywordsInput = document.getElementById("post-keywords");

function toDateInputValue(d) {
  // <input type="date"> wants local YYYY-MM-DD. toISOString() would convert to
  // UTC first, which in IST (UTC+5:30) shows the previous day before 05:30.
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function syncDateAndKeywordInputs() {
  if (postDateInput) {
    const d = state.createdAt instanceof Date && !isNaN(state.createdAt) ? state.createdAt : new Date();
    const want = toDateInputValue(d);
    if (postDateInput.value !== want) postDateInput.value = want;
  }
  if (postKeywordsInput && postKeywordsInput.value !== (state.keywords || "")) {
    postKeywordsInput.value = state.keywords || "";
  }
}

if (postDateInput) {
  postDateInput.addEventListener("change", () => {
    const raw = postDateInput.value;
    if (!raw) { state.createdAt = null; renderPoster(); return; }
    // Parse as LOCAL midday, not midnight: midnight in a timezone behind UTC
    // can roll the date back a day when it is normalised.
    const [y, m, d] = raw.split("-").map(Number);
    const parsed = new Date(y, m - 1, d, 12, 0, 0);
    state.createdAt = isNaN(parsed) ? null : parsed;
    renderPoster();
  });
}

// Start the field on today rather than blank — an empty date box reads as
// "no date", when the slide has always stamped the current one.
syncDateAndKeywordInputs();

document.getElementById("post-date-today")?.addEventListener("click", () => {
  state.createdAt = null;      // null = follow the clock, as before
  syncDateAndKeywordInputs();
  renderPoster();
});

if (postKeywordsInput) {
  postKeywordsInput.addEventListener("input", () => {
    state.keywords = postKeywordsInput.value;
    // Mirror into the publish panel so QA sees what the writer wrote.
    if (dailymattrKeywords && !dailymattrDraftTouched.keywords) {
      dailymattrKeywords.value = state.keywords;
    }
  });
}

/* ── Confirmation dialog ─────────────────────────────────────────────
   Replaces window.confirm for the actions that cannot be taken back.

   window.confirm is fine functionally, but it renders as a browser chrome
   alert with no room to say WHAT is about to happen — and for publishing that
   detail is the whole point: which section, how many files, whether a video
   is going. It also cannot be styled, so it reads as a browser error rather
   than part of the app.

   Built on native <dialog>: Esc-to-cancel, focus trapping and top-layer
   stacking come free, and this page has enough stacking contexts (the mobile
   sheet, the aurora backdrop, the preview rail) that a hand-rolled overlay
   would land behind something eventually.

   Returns a promise for true/false so callers keep reading top to bottom. */
const pixDialogEl = document.getElementById("pix-dialog");

/* `extras` is an optional element rendered inside the dialog — used by
   Approve & Publish to ask for a category the post never carried. It stays the
   caller's node, so the caller reads its values straight off it after this
   resolves; detaching it from the dialog does not clear a <select>. */
/* `notice: true` turns this into a one-button acknowledgement — same dialog,
   no choice to make. A notice is telling the user something happened, so a
   Cancel would be answering a question that was never asked. */
function confirmAction({ title, body = "", facts = [], confirmLabel = "Confirm", danger = false, extras = null, notice = false } = {}) {
  // No <dialog> (very old browser, or the element was removed): fall back
  // rather than silently proceeding with something irreversible.
  if (!pixDialogEl || typeof pixDialogEl.showModal !== "function") {
    if (notice) {
      window.alert(`${title}\n\n${body}`);
      return Promise.resolve(true);
    }
    return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  }

  document.getElementById("pix-dialog-title").textContent = title;
  const bodyEl = document.getElementById("pix-dialog-body");
  bodyEl.textContent = body;
  bodyEl.hidden = !body;

  const factsEl = document.getElementById("pix-dialog-facts");
  factsEl.textContent = "";
  factsEl.hidden = !facts.length;
  for (const fact of facts) {
    const li = document.createElement("li");
    li.textContent = fact;
    factsEl.appendChild(li);
  }

  // Rebuilt on every open, so a picker left by a previous call cannot linger
  // into a plain confirm.
  const extrasEl = document.getElementById("pix-dialog-extras");
  if (extrasEl) {
    extrasEl.textContent = "";
    extrasEl.hidden = !extras;
    if (extras) extrasEl.appendChild(extras);
  }

  const confirmBtn = document.getElementById("pix-dialog-confirm");
  confirmBtn.textContent = confirmLabel;
  confirmBtn.classList.toggle("is-danger", Boolean(danger));

  const cancelBtn = document.getElementById("pix-dialog-cancel");
  cancelBtn.hidden = notice;

  return new Promise((resolve) => {
    /* Resolve from whichever signal arrives first, rather than trusting the
       "close" event alone.

       That event is the obvious hook and it is what this originally used — but
       it does not fire in every environment (measured: the dialog opened,
       closed and set returnValue correctly while "close" never fired at all).
       When that happens the promise never settles and the caller hangs
       forever with no error: the Publish button would sit disabled and the
       user would have no idea why. Button clicks are the signal we actually
       control, so they decide, and the events are a safety net for Esc and
       the backdrop. */
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      pixDialogEl.removeEventListener("cancel", onCancel);
      pixDialogEl.removeEventListener("close", onClose);
      if (pixDialogEl.open) pixDialogEl.close();
      resolve(value);
    };
    const onCancel = () => finish(false);
    const onConfirm = () => finish(true);
    const onClose = () => finish(pixDialogEl.returnValue === "confirm");

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    pixDialogEl.addEventListener("cancel", onCancel);   // Esc
    pixDialogEl.addEventListener("close", onClose);     // backdrop / programmatic

    pixDialogEl.returnValue = "cancel";   // anything but an explicit yes means no
    pixDialogEl.showModal();
    // Focus Cancel, not Confirm: a stray Enter must not publish. A notice has
    // no Cancel and nothing to guard against, so its one button takes focus.
    (notice ? confirmBtn : cancelBtn).focus();
  });
}

const showTimestampInput = document.getElementById("show-timestamp");
if (showTimestampInput) {
  showTimestampInput.addEventListener("change", () => {
    state.showTimestamp = showTimestampInput.checked;
    renderPoster();
  });
}


/* ── Keep the date stamp current ──
   Computing the date at paint time is only half of it: an idle tab never
   repaints, so the canvas would keep showing the day it was last drawn.
   This schedules a repaint just after local midnight, and re-checks whenever
   the tab becomes visible again — a sleeping laptop does not fire timers, so
   waking up is the case a timer alone would miss. Also covers the machine's
   clock or timezone being changed while the tab sits open. */
(() => {
  const label = () => formatCreatedAt(state.createdAt);
  let lastLabel = label();
  let timer = 0;

  function refreshIfRolledOver() {
    const now = label();
    if (now !== lastLabel) {
      lastLabel = now;
      renderPoster();
    }
  }

  function scheduleNextMidnight() {
    clearTimeout(timer);
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);      // 00:00 tomorrow, local
    // A couple of seconds past the boundary, so the new day is unambiguous.
    const wait = Math.max(1000, nextMidnight.getTime() - now.getTime() + 2000);
    timer = setTimeout(() => {
      refreshIfRolledOver();
      scheduleNextMidnight();
    }, wait);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refreshIfRolledOver();
    scheduleNextMidnight();   // the pending timer may have been throttled
  });
  window.addEventListener("focus", refreshIfRolledOver);

  scheduleNextMidnight();
})();

// Enhance strength — how much of the AI upscale to keep. Applies to the NEXT
// enhance; it is a request parameter, not a canvas filter, so there is
// nothing to re-render on change.
const enhanceStrengthInput = document.getElementById("enhance-strength");
const enhanceStrengthHint = document.getElementById("enhance-strength-hint");
if (enhanceStrengthInput) {
  const describe = (v) =>
    v >= 90 ? `${v}% — full model output, sharpest but most artificial.`
    : v >= 60 ? `${v}% — strong, and where faces start to look painted.`
    : v >= 25 ? `${v}% — mostly a clean resample, very natural.`
    : `${v}% — raise this only if the image still looks soft.`;
  enhanceStrengthInput.addEventListener("input", () => {
    state.enhanceStrength = Number(enhanceStrengthInput.value);
    if (enhanceStrengthHint) enhanceStrengthHint.textContent = describe(state.enhanceStrength);
  });
}

/* ── Saving to Supabase ────────────────────────────────────────────────────
   A post reaches the pix_posts table only when the user presses Save. Nothing
   is written on scrape, on rewrite or on download: the editor is a workspace,
   and half-finished experiments do not belong in the library.

   A saved row holds the source article and the text extracted from it, what
   the AI wrote, which image was chosen, and the complete editor snapshot
   (ratio, accent, offsets, filters, logo, video trim) — enough to rebuild the
   poster exactly. */

const PIX_SAVE_ENDPOINT = "/api/pix";
let pixSaveInFlight = null;

/**
 * Begin a new post: forget the row this session was editing, forget the
 * provenance of the last story, and — via resetPostModel() — forget its pages
 * and everything on them. Called when a scrape brings in a different article
 * and when a poster is built from hand-written text — both are new posts, and
 * without this the next save would land on the previous row and pair a new
 * headline with an old source URL.
 *
 * Deliberately not window.location.reload() like the New post button: both
 * callers assign the new story's headline and text immediately after this
 * returns, and a reload would throw away the scrape that was just fetched.
 */
function startNewPix() {
  state.pixId = null;
  // The next story starts unfinished, whatever the last one ended as. Without
  // this a writer who submitted, then pressed New post, began the next
  // article already flagged as submitted.
  state.isDraft = true;
  /* A new post has no history, and forgetting to say so is the dangerous
     direction: the previous story's publish record would otherwise keep the
     Publish button shut on a post that has never been sent anywhere. */
  state.publishedAt = null;
  state.publishedId = null;
  state.publishedHistory = [];
  state.approved = false;
  state.rejected = false;
  state.rejectedByName = "";
  state.article = null;
  state.storedImageFor = null;
  state.storedImageUrl = null;
  state.storedVideoFor = null;
  state.storedVideoUrl = null;
  state.clipSourceUrl = "";
  state.renderedClip = null;
  state.headlineTouched = false;
  state.detailTouched = false;
  state.sourceUrl = "";
  syncSourceUrlInput();
  state.categoryId = "";
  state.stateId = "";
  syncSectionInputs();
  state.createdAt = null;
  state.keywords = "";
  syncDateAndKeywordInputs();
  state.articleText = "";
  state.scrapedTitle = "";
  state.imageQuery = "";
  state.sourceImageUrl = null;
  /* The rail, the pages and everything they own. The scalar clears above are
     the post's provenance; this is the post's content, and it lives on the
     pages rather than on `state` — which is why the three lines above that
     clear storedVideoFor/storedVideoUrl/renderedClip never actually dropped
     the last story's clip. Runs before syncDailyMattrDraft({force}) below so
     that draft is rebuilt from a blank post, not from the previous headline. */
  resetPostModel();
  dailymattrDraftTouched.content = false;
  dailymattrDraftTouched.keywords = false;
  dailymattrDraftTouched.category = false;
  dailymattrDraftTouched.state = false;
  resetDailyMattrExtraMedia();
  syncDailyMattrDraft({ force: true });
  publishOutcomeUnknown = false;
  syncPublishState();
}

/**
 * Write the current post to the library.
 *
 * Answers { ok, id?, error? } rather than throwing: the button has to be able
 * to tell the user precisely why a save did not happen.
 */
/* `asDraft` is the whole difference between the two buttons. A draft is saved
   but not handed over: it stays out of QA's queue until it is submitted. Left
   undefined the post keeps whatever it already was, so autosave never quietly
   promotes a draft into the queue.

   `auto` says this write came from the idle timer rather than from a press.
   The server treats the two differently in one place — lifting the rejection
   on a post its author has corrected, which has to be a deliberate handover
   and not something a 2.5s timer does mid-sentence. */
async function savePixToLibrary({ asDraft, auto = false } = {}) {
  /* Resolve the intent for THIS write into a local and leave state.isDraft
     alone until the server has accepted it. Writing it here, above the
     guards, meant a submit refused for a missing category still flipped the
     post to non-draft — permanently, because there is no un-submit — and the
     next Save then created the row in QA's queue mid-sentence.

     The demotion rule is unchanged and load-bearing: submitting always
     applies, but asking for a draft only holds for a post that is still one.
     Hence `!state.isDraft` rather than a flat `false` on the asDraft:true
     branch — otherwise QA pressing Save on a post they are reviewing would
     pull it out of their own queue, which is exactly what makes it safe for
     the in-editor button to be hard-wired to "draft" for every role. */
  const submitting = asDraft === false ? true : !state.isDraft;
  if (!state.user) {
    return { ok: false, error: "Sign in to save posts." };
  }
  if (state.user.role === "writer" && !state.categoryId) {
    return { ok: false, error: "Choose a category before saving." };
  }
  if (state.user.role === "writer" && stateIsRequired(state.categoryId) && !state.stateId) {
    return { ok: false, error: "Choose a state before saving a State category post." };
  }
  // Nothing worth a row yet.
  if (!state.headline && !state.sourceUrl) {
    return { ok: false, error: "Nothing to save yet — scrape a link or write a headline first." };
  }
  /* Source link is required, for every role.

     It is the only record of where a story came from. QA checks it on every
     post, it is what Review searches, and it is what anyone answering "where
     did this come from" months later has to work with — and once a post is
     published to DailyMattr there is no going back to add it, because their
     API is write-only. A scrape fills it in automatically, so the only way to
     arrive here empty is a hand-written post, which is exactly the case where
     the provenance is least obvious and most worth recording. */
  if (submitting && !String(state.sourceUrl || "").trim()) {
    return { ok: false, error: "Add the source link before submitting.", needsSource: true };
  }

  // Impatient double-clicks are the one way two saves overlap. Serialising
  // them keeps the first response — which carries the new id — from racing
  // the second request into creating a duplicate row.
  const run = async () => {
    /* Which post this write is FOR, fixed before the first await.

       The upload below is not quick — several MB of pasted image, or a
       server-side video encode measured in tens of seconds — and the editor
       stays live throughout. Open another post from Review in that window and
       the payload, assembled afterwards, picked up the NEW post's id and the
       new post's fields: the save started for A landed on B, or, after
       "New post", created a fresh row holding a mixture of the two.

       `?? null` rather than a bare read: an unsaved post has no id, and the
       undefined-to-defined transition is exactly the startNewPix case that
       has to be caught too. */
    const targetId = state.pixId ?? null;
    try {
      // Uploads first: the row stores URLs, and a data: URL has none.
      const mediaProblems = await ensureMediaUploaded((message) => {
        if (savePixLabel) savePixLabel.textContent = message;
      });
      /* The payload cannot simply be built before the awaits — describeMainImage
         and the design snapshot read the stored URLs that the upload has just
         produced, so assembling first would record null for exactly the media
         that was uploaded. Abort here instead, after the upload (its side
         effects are still wanted if the writer comes back to this post) and
         before anything is sent. */
      if ((state.pixId ?? null) !== targetId) {
        return { ok: false, error: "Not saved — another post was opened while this one was uploading." };
      }

      /* A video that did not store must not be handed to QA.

         Submitting used to go ahead regardless: the writer got a dialog saying
         the clip had failed, pressed "Got it", and the post was already in the
         review queue — without its video. QA then opened a post whose video
         does not play, and publishing refused with "the video could not be
         prepared", by which time the writer's file was long gone from their
         tab and the footage was unrecoverable. Eight of the twelve most recent
         video posts in the library are in exactly that state.

         So the hand-over is held back and the post stays a draft. Nothing is
         lost — every word and every picture is saved — and it stays with the
         one person who can still fix it, because they are the only one who
         still has the file. */
      const heldBack = submitting && Boolean(videoStoreFailure || imageStoreFailure);
      const handOver = submitting && !heldBack;
      if (savePixLabel) savePixLabel.textContent = "Saving…";
      const response = await fetch(PIX_SAVE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        // `autosave` rides alongside the columns rather than in them: it
        // describes the request, not the post, and normalise() on the server
        // only reads keys it maps to columns.
        body: JSON.stringify({ ...collectPixPayload(handOver), autosave: auto }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn(`[pix] not saved: ${data.error || response.status}`);
        // 401: the cookie expired while the tab was open. Put the login back
        // up — retrying the save without a session would just fail again.
        if (response.status === 401) handleSignedOut();
        return { ok: false, error: data.error || `Save failed (${response.status}).` };
      }
      /* Only now is the post's standing what the request claimed it was. A
         refused or failed save leaves the session exactly as it found it.

         Same ownership check as before the fetch, because the response is one
         more await later: the row was written correctly either way, but if
         the editor has moved on since, these three lines would stamp this
         post's id, draft flag and saved-baseline onto a different one — and a
         wrong baseline is the silent failure, because it tells the unsaved
         dot that a post nobody has saved is already stored. */
      if ((state.pixId ?? null) === targetId) {
        /* The server's answer, not the intent. They differ on a post that has
           already been handed over: an asDraft save cannot un-submit one (see
           handleSave), so believing the intent here would leave the editor
           calling a submitted post a draft — and the next line of feedback,
           the pill and the autosave gate all read this flag. */
        state.isDraft = data.isDraft ?? !handOver;
        state.pixId = data.id || state.pixId;
        /* The server lifted a rejection because this save was the author's
           correction, so the post is back in QA's Awaiting queue. Carried into
           state or the editor would keep describing it as rejected — the
           Publish button reads state.rejected, and the writer would be told to
           ask for a withdrawal that has already happened. */
        if (data.resubmitted) {
          state.rejected = false;
          syncPublishState();
        }
        markPixSaved();
      }
      /* Every save, not only the ones that create a row.

         "Only a new row moves the tally" was true before drafts existed. It
         is now exactly backwards: a draft CREATES a row but is not counted,
         and submitting it is an UPDATE — so the single moment the number
         actually changes was the one moment nothing refreshed it, and a
         writer watched their count sit still all day. Approving and rejecting
         move it too, and neither is a create. A count query is cheap; being
         wrong about someone's day's work is not. */
      refreshMyPixCount();
      announceCountChange();
      console.log(`[pix] saved ${data.id}`);
      return {
        ok: true,
        id: data.id,
        created: data.created,
        resubmitted: Boolean(data.resubmitted),
        warning: mediaProblems.length ? mediaProblems.join("; ") : null,
        videoStoreFailure,
        imageStoreFailure,
        /* The submit was downgraded to a draft because the clip is missing —
           and the SERVER agreed. Asserting this from intent alone told a
           writer their post "was kept as YOUR draft" when the row had come
           back non-draft, which happens whenever the post was already with QA:
           an asDraft save cannot un-submit one. The sharpest case is a
           rejected post, where the same save also lifts the rejection and
           pushes it back into the Awaiting queue — so the writer is told it is
           safe in Drafts while QA is holding it, clipless, right now. */
        heldBack: heldBack && (data.isDraft ?? !handOver) === true,
      };
    } catch (err) {
      console.warn("[pix] not saved:", err.message);
      return { ok: false, error: err.message || "Save failed." };
    }
  };

  pixSaveInFlight = (pixSaveInFlight || Promise.resolve()).then(run, run);
  return pixSaveInFlight;
}

/* `submitting` is passed in rather than read off state.isDraft: the caller
   decides what this particular write means, and a save that is later refused
   must not have left a changed flag behind for the next one to pick up. */
/* `view` is the base-page reading of `state` (see basePageView). Every field
   below is taken off it rather than off `state` directly — not because all of
   them are page-owned, but because a mixed convention is what let headline,
   tag and mainImage quietly go back to the live selection. For anything the
   pages do not own the two are the same object value anyway. */
function collectPixPayload(submitting, view = basePageView()) {
  const article = view.article || {};
  const image = describeMainImage(view);

  return {
    id: view.pixId || undefined,
    isDraft: !submitting,

    // The scrape
    sourceUrl: view.sourceUrl || null,
    categoryId: view.categoryId || null,
    stateId: view.stateId || null,
    scrapedTitle: view.scrapedTitle || null,
    articleText: view.articleText || null,
    detailText: view.detailText || null,
    imageQuery: view.imageQuery || null,
    sourceImageUrl: view.sourceImageUrl || null,

    // What the writer produced
    aiHeadline: article.headline || null,
    aiBullets: Array.isArray(article.bullets) ? article.bullets : [],
    aiTweet: article.tweet || null,
    aiFlags: Array.isArray(article.flags) ? article.flags : [],

    // What the poster shows
    headline: view.headline || null,
    detailBody: view.detailText || null,
    mainImageUrl: image.url,
    mainImageSource: image.source,
    aspectRatio: view.aspectRatio,
    accentColor: view.accent,
    tag: view.tag,

    design: collectDesignSnapshot(view),
  };
}

/* The main image is held as an <img>, not a URL, so the source has to be read
   back off it. Remote images always travel through /api/image?url=…, so the
   original address is recoverable from the proxy query; a data: URL means a
   local upload or an AI enhance, which has no address to store. */
/* `view` must be a base-page reading (basePageView): mainImage is owned by
   every page type that shows one, so reading it off live `state` describes
   whichever page is selected rather than the post. */
function describeMainImage(view) {
  const src = view.mainImage?.src || "";
  if (!src) return { url: null, source: null };
  if (src.startsWith("data:")) {
    // An upload or an AI enhance. It has a URL only once it has been pushed
    // to storage — see ensureMediaUploaded, which Save runs first.
    return {
      url: view.storedImageFor === src ? view.storedImageUrl : null,
      source: "upload",
    };
  }

  let url = src;
  try {
    const parsed = new URL(src, window.location.origin);
    if (parsed.pathname === "/api/image" && parsed.searchParams.has("url")) {
      url = parsed.searchParams.get("url");
    } else {
      // imageFromUrl appends a cache-busting ?t= — not part of the address.
      parsed.searchParams.delete("t");
      url = parsed.toString();
    }
  } catch { /* keep src as-is */ }

  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const source =
    /pexels\.com$/i.test(host) || /pexels/i.test(host) ? "stock"
    : /fal\.(media|ai)$/i.test(host) || /fal\./i.test(host) ? "flux"
    : url === view.sourceImageUrl ? "scraped"
    : "search";

  /* Our own copy wins over the address it came from. ensureMediaUploaded now
     stores remote pictures too, and pointing the post at that copy is what
     stops a published story losing its image because a news site reorganised
     its CDN. `source` still records where it originally came from. */
  const stored = view.storedImageFor === src ? view.storedImageUrl : null;
  return { url: stored || url, source };
}

/* Everything the canvas reads that is not text or an image. Deliberately a
   flat, explicit list rather than a clone of `state`: the live objects in
   there (Image elements, the <video>, File handles) are not serialisable and
   would silently bloat or break the row. */
/* `view` must be a base-page reading (basePageView). The typography, framing
   and filter fields here are all page-owned, so the same page-selection leak
   that emptied main_image_url also stamped an added page's crop and font size
   onto the post's design blob. */
function collectDesignSnapshot(view) {
  return {
    aspectRatio: view.aspectRatio,
    accent: view.accent,
    accentAlt: view.accentAlt,
    headlineStyle: view.headlineStyle,
    fontSize: view.fontSize,
    enhanceStrength: view.enhanceStrength,
    imageOffset: { ...view.imageOffset },
    imageZoom: view.imageZoom,
    logo: { x: view.logoX, y: view.logoY, size: view.logoSize },
    tag: view.tag,
    showTimestamp: view.showTimestamp,
    createdAt: view.createdAt instanceof Date && !isNaN(view.createdAt)
      ? view.createdAt.toISOString()
      : null,
    keywords: view.keywords || "",
    previewMode: view.previewMode,
    filters: {
      preset: view.filterPreset,
      brightness: view.filterBrightness,
      contrast: view.filterContrast,
      saturation: view.filterSaturation,
      blur: view.filterBlur,
    },
    /* The post's video. Read off the primary video page rather than live
       state: the clip belongs to that page now, and saving while page 1 is
       selected must not write out whatever video fields happen to be left
       over in state. */
    video: (() => {
      const v = primaryVideoContent();
      return {
        sourceKind: v.videoSourceKind || "link",
        url: v.videoUrl || null,
        // The bucket copy: the rendered clip, already cut to the range below
        // and with the caption burned in. `url` above is the original link,
        // which for a scraped clip is a signed URL that expires within hours.
        storedUrl: v.storedVideoUrl || null,
        // The key that copy was rendered under. Reopening compares its tail
        // with the caption and framing below before trusting the copy.
        storedFor: v.storedVideoFor || null,
        storedTrimmed: Boolean(v.storedVideoUrl),
        title: v.videoMeta?.title || null,
        // What the writer actually added, so a reviewer can see it later.
        fileName: v.videoFileName || v.videoFile?.name || null,
        trimStart: v.trimStart ?? 0,
        trimEnd: v.trimEnd ?? 0,
        muted: Boolean(v.videoMuted),
        focus: { x: v.videoFocus?.x ?? 0.5, y: v.videoFocus?.y ?? 0.5 },
        caption: v.videoCaption || null,
        captionSize: v.videoCaptionSize ?? view.videoCaptionSize,
      };
    })(),
    // Pages the writer added on top of the spine. The spine itself is the
    // rest of this snapshot, so only the extras are listed.
    pages: serializePages(),
    // Which spine cards are still in the rail. Without this, removing the
    // poster or the text page comes undone on the next open.
    spine: spineCardsInRail(),
    savedAt: new Date().toISOString(),
  };
}

/* ── Save button ──
   The only path into the library. Nothing is stored until this is pressed, so
   the feedback has to be unambiguous: the label reports what happened and the
   preview status line carries the reason whenever it did not. */
const savePixBtn = document.getElementById("save-pix-btn");
const savePixLabel = document.getElementById("save-pix-label");
let saveResetTimer = null;

function showSaveState(label, className = "") {
  if (!savePixBtn) return;
  if (savePixLabel) savePixLabel.textContent = label;
  savePixBtn.classList.remove("is-saved", "is-error");
  if (className) savePixBtn.classList.add(className);
  clearTimeout(saveResetTimer);
  saveResetTimer = setTimeout(() => {
    // Back to whatever this role's resting label is, not a hard-coded "Save".
    if (savePixLabel) savePixLabel.textContent = saveButtonLabel();
    savePixBtn.classList.remove("is-saved", "is-error");
  }, 3000);
}

/* The single save path, shared by the in-editor button and the topbar
   proxies. `intent` is a parameter and nothing else: it used to be read back
   off savePixBtn.dataset, where a "submit" left by one click outlived the
   post that set it. The in-editor button always passes "draft"; only a proxy
   carrying data-intent="submit" — the writer's topbar primary — can submit. */
async function runSave(intent) {
  if (!savePixBtn) return;
  savePixBtn.disabled = true;
  if (savePixLabel) savePixLabel.textContent = "Saving…";
  savePixBtn.classList.remove("is-saved", "is-error");

  const result = await savePixToLibrary({ asDraft: intent !== "submit" });

  savePixBtn.disabled = false;
  if (result?.ok) {
    /* savePixToLibrary only commits state.isDraft once the server accepted,
       so this is the row's real standing, not the intent that was asked for —
       an asDraft:true save of a post QA already has stays submitted. */
    const draft = Boolean(state.isDraft);
    // "Updated" rather than "Saved" when this post is already in the
    // library, so pressing Save twice does not look like it made two.
    showSaveState(result.created ? "Saved" : "Updated", "is-saved");
    if (result.warning) {
      setPostStatus(`Saved, but the ${result.warning}.`, "error");
    }

    /* A clip that failed to store gets a dialog, not a line of red text.

       This is the ONLY moment it can still be recovered. An uploaded video
       lives in the tab as a File; the row keeps a URL, and if the encode
       failed there is no URL to keep. Reload or reopen the post and the File
       is gone for good — videoClipKey() then finds no source, resolvePublishClip
       returns null, and publishing refuses with "the video could not be
       prepared" long after anyone could do anything about it. Four of the five
       saved video posts in the library are already in that state.

       So: say it now, while the file is still in memory and pressing Save
       again is a real fix. */
    /* A missing slide picture gets the same treatment as a missing clip. Both
       reach QA as a post that looks finished and is not, and in both cases the
       only moment it can still be fixed cheaply is now, while the source is
       still loaded in this tab. */
    if (result.videoStoreFailure || result.imageStoreFailure) {
      const missingVideo = Boolean(result.videoStoreFailure);
      const thing = missingVideo ? "video" : "picture";
      await confirmAction({
        notice: true,
        title: result.heldBack
          ? `Not sent to QA — the ${thing} is missing`
          : `The ${thing} was not saved`,
        body: result.heldBack
          ? `Your writing is saved, but the ${thing} could not be stored — so this post was kept as YOUR draft instead of going to QA. A post with a missing ${thing} cannot be published by anyone.`
          : `Everything else was saved, but the ${thing} could not be stored — so this post cannot be published as it stands.`,
        facts: [
          result.videoStoreFailure || result.imageStoreFailure,
          "Press Submit again now. The file is still loaded in this tab.",
          `Do NOT reload or open another post first — an uploaded ${thing} cannot be recovered after that, and would have to be added again.`,
          ...(result.heldBack
            ? ["It stays in your Drafts until it goes through, so nothing you have written is lost."]
            : []),
        ],
        confirmLabel: "Got it",
      });
    }

    if (!result.warning) {
      /* Say where it went and how to move on. Writers were typing the next
         story over a saved poster because nothing told them Save would keep
         landing on the same row. The draft wording matters as much: this line
         claimed "the copy QA is reviewing has been updated" on every save,
         including drafts QA has never been shown. */
      setPostStatus(
        /* A correction to a rejected post is its own outcome, and the most
           useful thing this line can say: the post has left the Rejected tab
           and is back in the queue, which is exactly what the writer was
           trying to achieve and previously never happened. */
        result.resubmitted
          ? "Saved and back with QA — your correction returns the post to the review queue."
          /* A submit that was held back for a missing clip really did stay a
             draft, so it must not be described as sent. */
          : result.heldBack
            ? "Kept as your draft — the video did not save, so it was not sent to QA."
            : draft
            ? (result.created
                ? "Draft saved. QA cannot see it until you press Submit."
                : "Draft updated. QA cannot see it until you press Submit.")
            : (result.created
                ? "Saved and sent to QA for review. Press New post to start the next one."
                : "Saved — the copy QA is reviewing has been updated. Press New post to start a different story."),
        "success",
      );
    }

    /* Writers get this as a dialog, not just a status line. Handing the story
       over is the end of their work on it, and a line of text under the
       preview was being missed — writers kept typing the next story over the
       row they had just sent. QA sees no dialog: saving is not a handoff for
       them, and a modal on every edit would be in the way. */
    /* Not when the hand-over was held back: the writer has just been told, in
       its own dialog, that the post stayed with them because the video is
       missing. A second dialog immediately after saying "Sent to QA" would
       contradict it — and the reassuring one is the lie. */
    if (state.user?.role === "writer" && !result.heldBack) {
      confirmAction({
        notice: true,
        title: result.resubmitted
          ? "Back with QA"
          : draft ? "Draft saved" : (result.created ? "Sent to QA" : "Update sent to QA"),
        body: result.resubmitted
          ? "The rejection has been lifted and your corrected post is in the review queue again."
          : draft
            ? "Kept in My posts. QA cannot see it until you press Submit."
            : (result.created
                ? "Your article is saved and has moved to QA for review."
                : "Your changes are saved. QA is reviewing the updated copy."),
        facts: [
          state.headline ? cleanHeadlineForPublish(state.headline) : "(untitled)",
          result.resubmitted
            ? "It is waiting for approval again — no need to ask anyone to reopen it."
            : draft ? "Press Submit when it is ready for review."
                    : "Press New post to start the next story.",
        ],
        confirmLabel: "Got it",
      });
    }
  } else {
    showSaveState("Not saved", "is-error");
    setPostStatus(result?.error || "Could not save this post.", "error");
    /* A missing source link gets a dialog rather than a status line: it is
       the one failure here that is a step the person skipped rather than
       something that went wrong, so it needs to say what to do and put them
       in front of the field. */
    if (result?.needsSource) {
      await confirmAction({
        notice: true,
        title: "Source link required",
        body: "Every pix needs the link it came from. Paste the article URL into Source Link.",
        facts: [
          "QA checks it on every post, and Review searches by it.",
          "Scraping a link fills it in for you.",
        ],
        confirmLabel: "Add it now",
      });
      focusSourceLink();
    }
  }
}

/* Hard-coded "draft", deliberately. This button is the writer's checkpoint,
   not their handoff — Submit is the topbar primary. It is safe for a reviewer
   too: savePixToLibrary honours asDraft:true only on a post that is already a
   draft, so pressing Save on something in QA's queue cannot pull it out. */
if (savePixBtn) {
  savePixBtn.addEventListener("click", () => { runSave("draft"); });
}

/* ── Starting the next post ────────────────────────────────────────────────

   Save writes to state.pixId when there is one, which is right for "fix a typo
   and save again" and wrong for "that one is done, here is the next story".
   startNewPix() already drops the row id, but only Scrape & Build and Write
   Text call it — so a writer who cleared the headline and typed a new one by
   hand kept saving over the post QA was reviewing, with no sign anything was
   amiss.

   This reloads rather than unsetting fields one by one. A poster carries pages,
   images, a video with its trim, filters, logo placement and framing; clearing
   that by hand means enumerating state no one can be sure is complete, and a
   single missed field means the next story silently inherits it. The session
   cookie survives a reload, so the writer stays signed in and lands on an
   editor that is genuinely empty. */
const newPixBtn = document.getElementById("new-pix-btn");
if (newPixBtn) {
  newPixBtn.addEventListener("click", async () => {
    /* Deliberately not the button's is-dirty class: that is suppressed for a
       post which has never been saved, and unsaved work is exactly what must
       not be thrown away without asking. */
    const hasContent = Boolean(state.headline || state.sourceUrl);
    const unsaved = hasContent
      && (lastSavedFingerprint === null || pixFingerprint() !== lastSavedFingerprint);

    if (unsaved) {
      const go = await confirmAction({
        title: "Start a new post?",
        body: "This poster has changes that are not in the library yet. Starting a new one discards them.",
        facts: [state.headline ? `“${state.headline}”` : "Untitled poster"],
        confirmLabel: "Discard and start new",
        danger: true,
      });
      if (!go) return;
    }
    window.location.reload();
  });
}

/* ── Opening a saved post ──────────────────────────────────────────────────
   The list itself lives on the Review page (one page, scoped by role). What
   is left here is everything needed to pull a stored row back into the
   editor. */

function formatLibraryDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/* The date a row should show is the date it is being SORTED by.

   Every row showed updated_at (falling back to created_at) whatever list it
   was in. On the Published tab that is the wrong clock twice over: the rows
   arrive newest-published-first, but each one prints the day it was last
   edited — so a story written last week and published this morning sits at the
   top under last week's date, and the column reads as though the ordering is
   broken when it is the label that is lying.

   Answers { at, label }. The label is dropped on All, where created_at needs
   no explaining and a prefix on every row would only add noise. */
function reviewRowStamp(post) {
  if (reviewFilter === "published") return { at: post.published_at, label: "published" };
  if (reviewFilter === "approved") return { at: post.approved_at, label: "approved" };
  if (reviewFilter === "rejected") return { at: post.rejected_at, label: "rejected" };
  if (reviewFilter === "awaiting" || reviewFilter === "drafts") {
    return { at: post.updated_at || post.created_at, label: "edited" };
  }
  return { at: post.created_at, label: "" };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function openSavedPost(id) {
  setReviewStatus("Opening…");
  try {
    const response = await fetch(`/api/pix?id=${encodeURIComponent(id)}`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not open that post (${response.status}).`, "error");
      return;
    }
    await loadPixIntoEditor(payload.post);
    setReviewStatus("");
    /* The unpublishable case gets the line, not the cheerful one.

       A post carrying a video page with no stored clip cannot be published by
       anybody, and the only place that ever said so was the publish button —
       after QA had read the article, edited it, and committed to sending it.
       Saying it on open means the first thing a reviewer learns about an
       unpublishable post is that it is unpublishable, while the writer may
       still have the file and a rejection can still recover the footage.

       Set here rather than inside loadPixIntoEditor because the success line
       above runs afterwards and would overwrite it. */
    if (canReviewRole(state.user?.role) && primaryVideoPage() && !state.storedVideoUrl) {
      setStatus(
        "This post has a video page but no stored clip, so it cannot be published. Reject it back to the writer to have the video added again.",
        "error",
      );
    } else {
      setStatus("Opened — edit it, then press Save.", "success");
    }
  } catch (err) {
    setReviewStatus(err.message || "Could not open that post.", "error");
  }
}

/* ── Opening a row is not editing it ──
   loadPixIntoEditor is async: it awaits the main image, and the restored clip
   finishes later still, on `loadedmetadata`. The 800ms poller does not know
   any of that. It saw the new post's id, a fingerprint that no longer matched
   the PREVIOUS post's baseline, and — after ~3s of a half-restored editor —
   wrote what it found: main_image_url = null over the post just opened, and,
   because state.storedVideoFor is not stamped until the clip's metadata
   arrives, a full re-encode and re-upload of a source URL that has usually
   expired by then. Nobody had touched a key.

   `editorLoading` closes the synchronous body. `editorLoadSeq` is what closes
   the tails: a load's re-baseline only counts while that load is still the
   current one, so a slow image or clip belonging to post A cannot declare
   post B "saved" after the user has moved on. */
let editorLoading = false;
let editorLoadSeq = 0;

/* Rebuild the editor from a stored row. The design snapshot carries anything
   that is not text or an image; missing keys fall back to what is already in
   state, so a row saved by an older version still opens. */
async function loadPixIntoEditor(post) {
  if (!post) return;
  const design = post.design || {};

  /* Not markPixSaved(): that would record a half-restored post — no image,
     trimEnd 0 — as the stored truth, which is a worse thing to leave behind
     if the image fetch then fails. Null hits considerAutosave's existing
     "no baseline yet" guard and blanks the unsaved dot for the duration, and
     it structurally cannot leave a baseline belonging to the previous post. */
  const loadToken = ++editorLoadSeq;
  lastSavedFingerprint = null;
  editorLoading = true;
  try {
    resetDailyMattrExtraMedia();

    /* The publish line belongs to the post that was open, not to the panel.
       Without this, "Published to DailyMattr" stayed on screen when the next
       article was opened, so an untouched post read as already sent — the one
       mistake this panel must never invite. */
    setDailyMattrStatus("");

    state.pixId = post.id;
    state.isDraft = Boolean(post.is_draft);
    /* Carry the row's standing into the editor. Without it the publish panel
       had no idea whether this post was already live or already turned down,
       so the only thing that could refuse either was the server — after the
       encode and the upload, as an error QA had no way to anticipate. */
    state.publishedAt = post.published_at || null;
    state.publishedId = post.published_id || null;
    state.publishedHistory = Array.isArray(post.published_history) ? post.published_history : [];
    state.approved = Boolean(post.approved);
    state.rejected = Boolean(post.rejected);
    state.rejectedByName = post.rejected_by_name || "";
    publishOutcomeUnknown = false;
    state.headline = post.headline || post.ai_headline || post.scraped_title || "";
    state.detailText = post.detail_body || post.detail_text || "";
    state.articleText = post.article_text || "";
    state.sourceUrl = post.source_url || "";
    syncSourceUrlInput();
    state.categoryId = post.category_id ? String(post.category_id) : "";
    state.stateId = post.state_id ? String(post.state_id) : "";
    syncSectionInputs();
    state.scrapedTitle = post.scraped_title || "";
    state.imageQuery = post.image_query || "";
    state.sourceImageUrl = post.source_image_url || null;
    state.article = (post.ai_headline || (post.ai_bullets || []).length)
      ? {
          headline: post.ai_headline || "",
          bullets: post.ai_bullets || [],
          tweet: post.ai_tweet || "",
          flags: post.ai_flags || [],
        }
      : null;
    state.ready = true;
    dailymattrDraftTouched.content = false;
    dailymattrDraftTouched.keywords = false;
    dailymattrDraftTouched.category = false;
    dailymattrDraftTouched.state = false;

    applyDesignSnapshot(design, post);
    syncDailyMattrDraft({ force: true });

    // Text inputs
    if (headlineEdit) headlineEdit.value = state.headline;
    if (detailEdit) detailEdit.value = state.detailText;
    if (writeHeadline) writeHeadline.value = state.headline;
    if (writeDetail) writeDetail.value = state.detailText;
    if (editPanel) editPanel.hidden = false;
    if (imagePanel) imagePanel.hidden = false;

    // The article tab reads from the DOM, so refill it too when there is one.
    if (state.article) {
      renderArticle({
        headline: state.article.headline || state.headline,
        bullets: state.article.bullets,
        tweet: state.article.tweet,
        flags: state.article.flags,
      });
    }

    // A stored image is a URL; it goes back through the proxy exactly as it did
    // the first time. An upload has no URL, so the poster opens without it.
    // A stored video plays straight from the bucket.
    /* A stored clip belongs to a Video page. Posts saved before video became
       its own page carry no page list, so give them a page to land in. */
    if (design.video?.storedUrl) {
      const videoPage = ensureVideoPage();
      if (videoPage) {
        renumberPages();
        setActivePage(videoPage.id);
        /* Rows saved before design.video carried storedFor still have it on
           the page entry, which restorePages has just put on this page. */
        restoreStoredVideo({
          ...design.video,
          storedFor: design.video.storedFor || videoPage.content?.storedVideoFor || null,
        });
        bindRestoredVideoToPage(videoPage, loadToken);
        setActivePage("base");
      } else {
        setStatus("Opened, but this post is full — its video has no page to open into.", "error");
      }
    }

    state.mainImage = null;
    if (post.main_image_url) {
      try {
        state.mainImage = await imageFromUrl(`/api/image?url=${encodeURIComponent(post.main_image_url)}`);
      } catch {
        setStatus("Opened, but the image could not be reloaded.", "error");
      }
    }

    renderPoster();
    // What was just loaded is, by definition, what is stored — but only if
    // this is still the load the editor is showing.
    if (loadToken === editorLoadSeq) {
      markPixSaved();
      /* Same guard: a stale load must not put ITS post's publish state on the
         button and the status line of the post now on screen. Announced here
         and nowhere else — setDailyMattrStatus("") a few lines up has just
         cleared the previous post's publish line, so this is the one place
         where the standing is both news and unobstructed. */
      syncPublishState({ announce: true });
    }
  } finally {
    /* Guarded too: an older load unwinding must not declare the newer one
       finished. And it must be a finally — applyDesignSnapshot and the
       restores are synchronous and can throw, and a stuck flag would kill
       autosave for the rest of the session. */
    if (loadToken === editorLoadSeq) editorLoading = false;
  }
}

function applyDesignSnapshot(design, post) {
  const ratio = design.aspectRatio || post.aspect_ratio;
  if (ratio && LAYOUT_PRESETS[ratio]) applyAspectRatio(ratio);

  state.accent = design.accent || post.accent_color || state.accent;
  state.accentAlt = design.accentAlt || state.accentAlt;
  state.tag = design.tag || post.tag || "none";
  state.headlineStyle = design.headlineStyle || state.headlineStyle;
  state.fontSize = numberOr(design.fontSize, state.fontSize);
  state.enhanceStrength = numberOr(design.enhanceStrength, state.enhanceStrength);
  state.imageZoom = numberOr(design.imageZoom, 100);
  state.imageOffset = {
    x: numberOr(design.imageOffset?.x, 0),
    y: numberOr(design.imageOffset?.y, 0),
  };
  state.logoX = numberOr(design.logo?.x, state.logoX);
  state.logoY = numberOr(design.logo?.y, state.logoY);
  state.logoSize = numberOr(design.logo?.size, state.logoSize);
  state.showTimestamp = design.showTimestamp !== false;
  const restoredDate = design.createdAt ? new Date(design.createdAt) : null;
  state.createdAt = restoredDate && !isNaN(restoredDate) ? restoredDate : null;
  state.keywords = typeof design.keywords === "string" ? design.keywords : "";
  syncDateAndKeywordInputs();

  const filters = design.filters || {};
  state.filterPreset = filters.preset || "none";
  state.filterBrightness = numberOr(filters.brightness, 100);
  state.filterContrast = numberOr(filters.contrast, 100);
  state.filterSaturation = numberOr(filters.saturation, 100);
  state.filterBlur = numberOr(filters.blur, 0);

  // Push the values back into the controls, or the panel would show the
  // previous post's settings while the canvas shows this one's.
  syncControl(imgOffsetX, state.imageOffset.x);
  syncControl(imgOffsetY, state.imageOffset.y);
  syncControl(imgZoom, state.imageZoom);
  syncControl(fontSizeInput, state.fontSize);
  syncControl(accentColorInput, state.accent);
  if (accentAltColorInput) syncControl(accentAltColorInput, state.accentAlt);
  syncControl(filterBrightnessInput, state.filterBrightness);
  syncControl(filterContrastInput, state.filterContrast);
  syncControl(filterSaturationInput, state.filterSaturation);
  syncControl(filterBlurInput, state.filterBlur);
  if (accentHexLabel) accentHexLabel.textContent = String(state.accent).toUpperCase();
  if (accentAltHexLabel) accentAltHexLabel.textContent = String(state.accentAlt).toUpperCase();

  // Rebuild the added pages, then hand the editor back to page 1 — which is
  // what the writer is looking at when a post opens.
  /* The spine goes IN, rather than being applied after the fact: restorePages
     spends the 5-slide budget as it rebuilds, so it has to start from the
     arrangement the post was saved with or it drops the last page. */
  restorePages(design.pages, design.spine);
  // Still called: it is the path that puts a spine card BACK, and the one
  // that handles a legacy post with no spine recorded at all.
  restoreSpineCards(design.spine);
  setActivePage("base", { force: true });
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function syncControl(el, value) {
  if (el && value !== undefined && value !== null) el.value = value;
}

/* A session can expire mid-edit. Say so once, plainly, and put the login back
   up rather than letting every later action fail on its own. */
function handleSignedOut() {
  setReviewStatus("");
  setAuthState("blocked", "Your session expired. Sign in again — your poster is still on screen.");
}

/* ── Saved posts / Review ──────────────────────────────────────────────────
   One page, read two ways. The server scopes the list by role, so this file
   renders whatever it is handed:

     writer — "My posts": their own — drafts included, since nowhere else
              lists them — with Open and a read-only Draft / Awaiting /
              Approved / Rejected pill.
     qa     — "Review": everyone's, filterable by sign-off, with Open,
              Approve / Unapprove and Delete.

   Approving is deliberately not part of saving. A save writes the post; an
   approval records a judgement about it and touches none of its fields — so
   QA can approve without the risk of nudging a slider on the way past. */

const reviewList = document.getElementById("review-list");
const reviewStatus = document.getElementById("review-status");
const reviewFilters = document.getElementById("review-filters");
const reviewRefreshBtn = document.getElementById("review-refresh");
const reviewTabLabel = document.getElementById("review-tab-label");
const reviewTitle = document.getElementById("review-title");
const reviewDesc = document.getElementById("review-desc");

/* "all" | "drafts" | "awaiting" | "approved" | "rejected" | "published". Not
   QA-only any more: All and Drafts are offered to writers too, because a
   writer's own drafts are listed nowhere else. The rest are the queue's states
   and stay marked qa-only in the markup.

   "published" is the odd one and belongs to QA alone: it is not a verdict but
   the record of what has left the building, and it exists because a correction
   has to begin by reopening the exact post that went out. */
let reviewFilter = "all";

/* The tabs are multi-select: statuses OR together, "mine" narrows whose posts
   on top of them, and All clears the lot. `reviewFilter` stays the single name
   the rest of the list reads (row stamp, empty line) — the one status when
   exactly one is on, "mine" when only that is, "multi" when statuses mix. */
const reviewStatuses = new Set();
let reviewMine = false;

/* Selecting a tab means two things — which rows to ask for, and which buttons
   look pressed — and they have to move together, so every change goes
   through here. */
function selectReviewFilter(name, { toggle = false } = {}) {
  if (name === "all") {
    reviewStatuses.clear();
    reviewMine = false;
  } else if (name === "mine") {
    reviewMine = toggle ? !reviewMine : true;
    if (!toggle) reviewStatuses.clear();
  } else {
    if (!toggle) { reviewStatuses.clear(); reviewMine = false; }
    if (toggle && reviewStatuses.has(name)) reviewStatuses.delete(name);
    else reviewStatuses.add(name);
  }
  reviewFilter = reviewStatuses.size > 1 ? "multi"
    : reviewStatuses.size === 1 ? [...reviewStatuses][0]
    : reviewMine ? "mine" : "all";
  if (!reviewFilters) return;
  reviewFilters.querySelectorAll(".review-filter").forEach((t) => {
    const f = t.dataset.filter;
    const active = f === "all"
      ? !reviewStatuses.size && !reviewMine
      : f === "mine" ? reviewMine : reviewStatuses.has(f);
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
}

const reviewDateFrom = document.getElementById("review-date-from");
const reviewDateTo = document.getElementById("review-date-to");
const reviewDateClear = document.getElementById("review-date-clear");
const reviewDateApply = document.getElementById("review-date-apply");

/* The range the list is actually filtered by. Picking a date only fills the
   box; Apply is what moves it here, so a half-picked range (From set, To not
   yet) never fires a query of its own. */
const reviewAppliedDates = { from: "", to: "" };

/* <input type=date> values are local calendar days. Turned into instants here
   — start of From, start of the day AFTER To — so the server compares
   timestamps without having to know the reader's timezone. */
function reviewDateBounds() {
  const day = (value, addDays = 0) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays).toISOString();
  };
  return { from: day(reviewAppliedDates.from), to: day(reviewAppliedDates.to, 1) };
}

/* Every date box in the app — Review, Analytics, the editor's post date —
   opens its calendar on a click anywhere in it, not only on the small icon.
   Delegated, so a date input added later gets it too. showPicker() throws
   outside a user gesture or on older browsers, where the icon still works. */
document.addEventListener("click", (event) => {
  const input = event.target.closest?.('input[type="date"]');
  if (!input || input.disabled || input.readOnly) return;
  if (typeof input.showPicker !== "function") return; // old browser: icon only
  try {
    input.showPicker();
  } catch (err) {
    // Blocked, e.g. inside a cross-origin iframe. The icon still works.
    console.warn("Date picker could not open:", err?.message || err);
  }
}, true); // capture: runs before any handler that might stop the click

[reviewDateFrom, reviewDateTo].forEach((input) => {
  // Enter applies, like the search box.
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); reviewDateApply?.click(); }
  });
});
// The calendar for To starts no earlier than From, and vice versa.
reviewDateFrom?.addEventListener("change", () => { if (reviewDateTo) reviewDateTo.min = reviewDateFrom.value; });
reviewDateTo?.addEventListener("change", () => { if (reviewDateFrom) reviewDateFrom.max = reviewDateTo.value; });

reviewDateApply?.addEventListener("click", () => {
  let from = reviewDateFrom?.value || "";
  let to = reviewDateTo?.value || "";
  // Typed back to front: swap rather than list nothing.
  if (from && to && from > to) {
    [from, to] = [to, from];
    reviewDateFrom.value = from;
    reviewDateTo.value = to;
  }
  reviewAppliedDates.from = from;
  reviewAppliedDates.to = to;
  loadReviewQueue();
});

reviewDateClear?.addEventListener("click", () => {
  [reviewDateFrom, reviewDateTo].forEach((input) => {
    if (!input) return;
    input.value = "";
    input.min = "";
    input.max = "";
  });
  const wasApplied = reviewAppliedDates.from || reviewAppliedDates.to;
  reviewAppliedDates.from = "";
  reviewAppliedDates.to = "";
  if (wasApplied) loadReviewQueue();
});

/* Title, tab label and blurb all follow the role. Called whenever a session
   resolves, so a writer signing in after QA never sees QA's wording. */
function syncReviewCopy() {
  const isQa = canReviewRole(state.user?.role);
  if (reviewTabLabel) reviewTabLabel.textContent = isQa ? "Review" : "My posts";
  if (reviewTitle) reviewTitle.innerHTML = isQa ? "Review<br>and publish." : "Your<br>saved posts.";
  if (reviewDesc) {
    // Approving is no longer something QA does from this list — a post is
    // approved by being published from the editor — so the wording points at
    // the route that exists rather than at a button that has gone.
    reviewDesc.textContent = isQa
      ? "Every post the writers have saved. Open one to edit and publish it, or send it back with Reject."
      : "Everything you have saved. Open one to keep working on it — QA reviews them from their own view.";
  }
  /* Reset only out of a tab this role cannot see. The old flat reset to "all"
     ran on every session resolve, so with writers now offered Drafts it would
     have thrown them straight back out of it. What it is actually for is a
     role change in one tab — QA signing out and a writer signing in — where a
     filter left behind would otherwise keep listing under a tab that has just
     been hidden. */
  if (!isQa && (reviewMine || [...reviewStatuses].some((s) => s !== "drafts"))) {
    selectReviewFilter(reviewStatuses.has("drafts") ? "drafts" : "all");
  }
}

function setReviewStatus(message, kind) {
  if (!reviewStatus) return;
  reviewStatus.textContent = message || "";
  reviewStatus.className = "status-text" + (kind ? ` ${kind}` : "");
}

if (reviewFilters) {
  reviewFilters.addEventListener("click", (event) => {
    const btn = event.target.closest(".review-filter");
    if (!btn) return;
    selectReviewFilter(btn.dataset.filter, { toggle: true });
    loadReviewQueue();
  });
}

if (reviewRefreshBtn) reviewRefreshBtn.addEventListener("click", () => loadReviewQueue());

/* ═══════════════════════ Writer accounts (QA only) ═══════════════════════

   Accounts previously existed only if someone ran `npm run users:seed`, which
   creates a fixed roster of six — adding a seventh writer meant shell access
   to the server. QA runs the team, so QA gets the screen.

   Everything here is rendered with DOM nodes, never innerHTML: usernames and
   display names are operator-supplied text and would otherwise be a script
   injection into the one screen only QA can see. */
const writersView = document.getElementById("writers-view");
const writersList = document.getElementById("writers-list");
const writersStatusEl = document.getElementById("writers-status");
const writerCreateForm = document.getElementById("writer-create-form");

function setWritersStatus(message, kind) {
  if (!writersStatusEl) return;
  writersStatusEl.className = "status-text" + (kind ? ` ${kind}` : "");
  writersStatusEl.textContent = message || "";
}

async function usersRequest(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401) { handleSignedOut(); throw new Error("Signed out."); }
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status}).`);
  return payload;
}

let writerStats = new Map();     // user id -> { sent, approved, pending }
/* The same roster, counted the other way round: user id -> verdicts recorded.
   A reviewer authors nothing, so every figure keyed off authorship is zero for
   them and the screen said "no posts yet" about someone who had approved five
   hundred posts and published four hundred of them — including one an hour
   earlier. Their work was in the database the whole time; nothing on this
   screen was reading it. */
let qaStats = new Map();         // user id -> { approved, rejected, published, week }
let selectedWriterId = null;

/* The roster and the output figures come from two places and are merged here:
   /api/users knows who exists (including anyone who has never written a word,
   who is absent from the post table entirely), while the analytics writers
   board knows how much each has produced. Neither alone is the answer. */
async function loadWriters() {
  if (!writersList || !isAdminRole(state.user?.role)) return;
  setWritersStatus("Loading writers...");
  try {
    const [{ users }, analytics] = await Promise.all([
      usersRequest("/api/users"),
      // Counts are a nicety - a failure here must not empty the roster.
      usersRequest("/api/pix-analytics").catch(() => null),
    ]);

    writerStats = new Map();
    for (const row of analytics?.analytics?.writers || []) {
      if (row.user_login_id) {
        writerStats.set(row.user_login_id, {
          sent: row.sent_count || 0,
          week: row.week_count || 0,
          approved: row.approved_count || 0,
          pending: row.pending_count || 0,
        });
      }
    }

    qaStats = new Map();
    for (const row of analytics?.analytics?.qas || []) {
      if (row.user_login_id) {
        qaStats.set(row.user_login_id, {
          approved: row.approved_count || 0,
          rejected: row.rejected_count || 0,
          published: row.published_count || 0,
          week: row.week_count || 0,
        });
      }
    }

    writersList.textContent = "";
    for (const u of users) writersList.appendChild(renderWriterRow(u));

    const active = users.filter((u) => u.active).length;
    setWritersStatus(`${users.length} account${users.length === 1 ? "" : "s"} \u00b7 ${active} active`);

    // Keep the open writer open across a refresh (e.g. after a disable).
    if (selectedWriterId) {
      const still = users.find((u) => u.id === selectedWriterId);
      if (still) openWriter(still);
    }
  } catch (err) {
    setWritersStatus(err.message, "error");
  }
}

function renderWriterRow(u) {
  const li = document.createElement("li");
  li.className = "writers-item"
    + (u.active ? "" : " is-disabled")
    + (u.id === selectedWriterId ? " is-selected" : "");
  li.dataset.userId = u.id;

  // The row itself opens the writer; the admin buttons sit outside it so a
  // click on "Disable" does not also select the row.
  const open = document.createElement("button");
  open.type = "button";
  open.className = "writers-item-open";
  open.addEventListener("click", () => openWriter(u));

  const avatar = document.createElement("span");
  avatar.className = "writers-avatar";
  avatar.textContent = initialsOf(u.displayName || u.username);

  const main = document.createElement("span");
  main.className = "writers-item-main";
  const name = document.createElement("span");
  name.className = "writers-item-name";
  name.textContent = u.displayName || u.username;
  const meta = document.createElement("span");
  meta.className = "writers-item-meta";
  const stats = writerStats.get(u.id);
  /* A reviewer's output is verdicts, not posts. Read their row off the QA
     board instead, falling back to the authorship line only for a reviewer who
     has genuinely never decided anything \u2014 otherwise "no posts yet" is a
     true sentence answering the wrong question. Someone who does both keeps
     whichever halves they actually did. */
  const qa = canReviewRole(u.role) ? qaStats.get(u.id) : null;
  meta.textContent = [
    roleLabel(u.role),
    qa
      ? `${qa.approved} approved \u00b7 ${qa.rejected} rejected \u00b7 ${qa.published} published`
      : (stats ? `${stats.sent} post${stats.sent === 1 ? "" : "s"}` : "no posts yet"),
    qa && stats ? `${stats.sent} written` : null,
    u.active ? null : "disabled",
  ].filter(Boolean).join(" \u00b7 ");
  main.append(name, meta);

  /* This week's work, called out rather than buried in the meta line \u2014 it is
     the number the roster exists to answer. A lifetime total tells you who has
     been here longest, not who is producing now. */
  const weekOf = qa || stats;
  if (weekOf) {
    const week = document.createElement("span");
    week.className = "writers-week";
    week.textContent = `${weekOf.week} this week`;
    week.title = qa ? "Verdicts recorded in the last 7 days" : "Posts created in the last 7 days";
    main.appendChild(week);
  }
  open.append(avatar, main);

  const actions = document.createElement("div");
  actions.className = "writers-item-actions";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn-ghost";
  resetBtn.textContent = "Reset password";
  resetBtn.addEventListener("click", async () => {
    const next = window.prompt(`New password for ${u.username} (at least 6 characters):`);
    if (next === null) return;
    if (next.length < 6) { setWritersStatus("Passwords must be at least 6 characters.", "error"); return; }
    try {
      await usersRequest("/api/users/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username, password: next }),
      });
      setWritersStatus(`Password updated for ${u.username}.`, "success");
    } catch (err) { setWritersStatus(err.message, "error"); }
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "btn-ghost";
  toggleBtn.textContent = u.active ? "Disable" : "Enable";
  const isSelf = state.user && u.username === state.user.username;
  if (isSelf && u.active) {
    // The server refuses this too; disabling it here explains why rather than
    // waiting for an error after the click.
    toggleBtn.disabled = true;
    toggleBtn.title = "You cannot disable your own account.";
  }
  toggleBtn.addEventListener("click", async () => {
    /* Disabling has no visible consequence on this screen beyond a greyed row,
       but it locks the person out completely — and a disabled account fails
       login with "Incorrect username or password", so from their side it looks
       like a broken password, not a switched-off account. That already
       happened once in production. Confirm before doing it; enabling needs no
       confirmation because it cannot lock anyone out. */
    if (u.active) {
      const ok = await confirmAction({
        title: `Disable ${u.displayName || u.username}?`,
        body: "They will be signed out immediately and will not be able to log in. Sign-in will tell them the password is wrong, so let them know.",
        facts: ["Their posts stay exactly as they are", "You can re-enable them at any time"],
        confirmLabel: "Disable",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await usersRequest("/api/users/active", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username, active: !u.active }),
      });
      setWritersStatus(`${u.username} ${u.active ? "disabled" : "enabled"}.`, "success");
      loadWriters();
    } catch (err) { setWritersStatus(err.message, "error"); }
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn-ghost";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditWriterDialog(u);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn-ghost is-danger";
  deleteBtn.textContent = "Delete";
  if (isSelf) {
    deleteBtn.disabled = true;
    deleteBtn.title = "You cannot delete your own account.";
  }
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await confirmAction({
      title: `Delete ${u.displayName || u.username}?`,
      body: "They will be permanently removed. Their posts will remain but without an attached author.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await usersRequest("/api/users/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username }),
      });
      setWritersStatus(`${u.username} deleted.`, "success");
      loadWriters();
    } catch (err) { setWritersStatus(err.message, "error"); }
  });

  actions.append(editBtn, deleteBtn, resetBtn, toggleBtn);
  li.append(open, actions);
  return li;
}

function initialsOf(name) {
  const parts = String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((w) => w[0].toUpperCase()).join("") || "?";
}

/* Everything one writer has produced. Reuses the list endpoint's existing
   ?user= filter - QA may narrow to any author, a writer is pinned to their
   own - so this needed no new server route. */
async function openWriter(u) {
  selectedWriterId = u.id;
  document.querySelectorAll(".writers-item").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.userId === u.id);
  });

  const emptyEl = document.getElementById("writer-detail-empty");
  const bodyEl = document.getElementById("writer-detail-body");
  const listEl = document.getElementById("writer-posts");
  if (!bodyEl || !listEl) return;
  if (emptyEl) emptyEl.hidden = true;
  bodyEl.hidden = false;

  document.getElementById("writer-detail-name").textContent = u.displayName || u.username;
  const stats = writerStats.get(u.id);
  const qa = canReviewRole(u.role) ? qaStats.get(u.id) : null;
  /* Same split as the roster row: a reviewer is summarised by the verdicts
     they gave, a writer by how their own output fared. "approved / pending"
     means two different things in those two sentences, which is why the
     reviewer line names publishing rather than reusing the writer wording. */
  document.getElementById("writer-detail-meta").textContent = [
    u.username,
    roleLabel(u.role),
    qa
      ? `${qa.approved} approved \u00b7 ${qa.rejected} rejected \u00b7 ${qa.published} published`
      : (stats ? `${stats.approved} approved \u00b7 ${stats.pending} pending` : "no posts yet"),
  ].join(" \u00b7 ");

  listEl.textContent = "";
  const loading = document.createElement("li");
  loading.className = "writer-posts-empty";
  loading.textContent = "Loading...";
  listEl.appendChild(loading);

  try {
    /* Ask the question that fits the account. `?user=` is authorship, which
       is the whole story for a writer and none of it for a reviewer: pointed
       at a QA login it returned nothing and the pane said they had never
       written anything, which is true and useless. `?reviewer=` lists what
       they approved, rejected or published instead. */
    const scope = qa ? `reviewer=${encodeURIComponent(u.id)}` : `user=${encodeURIComponent(u.id)}`;
    const res = await fetch(`/api/pix?limit=100&${scope}`, { credentials: "same-origin" });
    if (res.status === 401) return handleSignedOut();
    const payload = await res.json().catch(() => ({}));
    listEl.textContent = "";
    const posts = payload.posts || [];
    if (!posts.length) {
      const none = document.createElement("li");
      none.className = "writer-posts-empty";
      none.textContent = qa
        ? `${u.displayName || u.username} has not reviewed anything yet.`
        : `${u.displayName || u.username} has not written anything yet.`;
      listEl.appendChild(none);
      return;
    }
    // renderReviewItem already draws a post row with its thumbnail, status and
    // Open/Approve/Delete actions - no reason to grow a second one.
    for (const post of posts) listEl.appendChild(renderReviewItem(post));
  } catch (err) {
    listEl.textContent = "";
    const failed = document.createElement("li");
    failed.className = "writer-posts-empty";
    failed.textContent = `Could not load posts: ${err.message}`;
    listEl.appendChild(failed);
  }
}

/* Create the account. This handler was lost when the writers block was
   rewritten — the form still opened, so the page looked complete, but
   submitting it did nothing at all. */
if (writerCreateForm) {
  writerCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const usernameEl = document.getElementById("writer-username");
    const passwordEl = document.getElementById("writer-password");
    const username = (usernameEl?.value || "").trim();
    const displayName = (document.getElementById("writer-display")?.value || "").trim();
    const password = passwordEl?.value || "";
    const role = document.getElementById("writer-role")?.value || "writer";

    if (!username) { setWritersStatus("Give the account a username.", "error"); usernameEl?.focus(); return; }
    if (password.length < 6) { setWritersStatus("Passwords must be at least 6 characters.", "error"); passwordEl?.focus(); return; }

    const btn = document.getElementById("writer-create-btn");
    if (btn) btn.disabled = true;
    setWritersStatus("Creating…");
    try {
      const { user } = await usersRequest("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role, displayName }),
      });
      writerCreateForm.reset();
      writerCreateForm.hidden = true;
      setWritersStatus(
        `Created ${user.username}. Pass on the password you just set — it is stored hashed and cannot be read back.`,
        "success",
      );
      await loadWriters();
    } catch (err) {
      setWritersStatus(err.message, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

document.getElementById("writers-add-toggle")?.addEventListener("click", () => {
  const form = document.getElementById("writer-create-form");
  if (!form) return;
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById("writer-username")?.focus();
});

document.getElementById("writers-refresh")?.addEventListener("click", () => loadWriters());

/* ── Section (category + state) ──────────────────────────────────────
   The writer files the story while they build it: they have the context, and
   QA would otherwise be guessing at review time. QA can still change it at
   publish — this is the starting point, not a lock.

   The one hard rule comes from DailyMattr: the "State" category REQUIRES a
   state. Matched by NAME against their live list rather than by a hard-coded
   id, so it survives them renumbering. Enforced on the server too — this is
   the early, friendly half. */
const postCategorySelect = document.getElementById("post-category");
const postStateSelect = document.getElementById("post-state");
const postSectionHint = document.getElementById("post-section-hint");
const postStateField = document.getElementById("post-state-field");
const postSectionRow = postCategorySelect?.closest(".section-row");
const postCategoryRequired = document.getElementById("post-category-required");

let stateCategoryId = null;   // the id of the category literally named "State"
/* Shared with the analytics category filter, which lists the same sections. */
let sectionCategories = [];

function stateIsRequired(categoryId) {
  return Boolean(stateCategoryId) && String(categoryId || "") === String(stateCategoryId);
}

/* Show the rule before it bites, rather than letting a publish fail on it. */
function syncSectionHint() {
  const needsState = stateIsRequired(state.categoryId);
  const writerNeedsCategory = state.user?.role === "writer";
  if (postCategorySelect) {
    postCategorySelect.required = writerNeedsCategory;
    postCategorySelect.setAttribute("aria-required", String(writerNeedsCategory));
  }
  if (postCategoryRequired) postCategoryRequired.hidden = !writerNeedsCategory;
  if (postStateField) {
    postStateField.hidden = !needsState;
    postStateField.classList.toggle("is-required", needsState);
  }
  if (postSectionRow) postSectionRow.classList.toggle("has-state", needsState);
  if (postStateSelect) {
    postStateSelect.required = needsState;
    postStateSelect.setAttribute("aria-required", String(needsState));
  }
  if (!postSectionHint) return;
  if (writerNeedsCategory && !state.categoryId) {
    postSectionHint.textContent = "Category is required before saving.";
    postSectionHint.className = "helper-text is-warning";
  } else if (needsState && !state.stateId) {
    postSectionHint.textContent = "The State category needs a state — pick one.";
    postSectionHint.className = "helper-text is-warning";
  } else {
    postSectionHint.textContent = "Where this story is filed on the web app.";
    postSectionHint.className = "helper-text";
  }
}

function syncSectionInputs() {
  if (postCategorySelect && postCategorySelect.value !== (state.categoryId || "")) {
    postCategorySelect.value = state.categoryId || "";
  }
  if (postStateSelect && postStateSelect.value !== (state.stateId || "")) {
    postStateSelect.value = state.stateId || "";
  }

  /* Mirror into the publish panel, so what the writer filed under is what QA
     sees rather than "Choose a category". Skipped once QA has picked
     something themselves — their override wins.

     Setting .value on a <select> whose options have not loaded yet is a silent
     no-op, which is why loadDailyMattrMeta() and loadSectionOptions() both
     call back here after populating their lists. */
  if (dailymattrCategory && !dailymattrDraftTouched.category
      && dailymattrCategory.value !== (state.categoryId || "")) {
    dailymattrCategory.value = state.categoryId || "";
  }
  if (dailymattrState && !dailymattrDraftTouched.state
      && dailymattrState.value !== (state.stateId || "")) {
    dailymattrState.value = state.stateId || "";
  }
  syncSectionHint();
}

/* Editing the section here is the same act as editing it in the publish panel
   — one value, two places to change it. Both go through syncSectionInputs()
   so the mirroring and the override guard live in exactly one function; the
   direct assignment that used to sit here bypassed the guard and could
   overwrite a choice QA had already made. */
postCategorySelect?.addEventListener("change", () => {
  state.categoryId = postCategorySelect.value;
  if (!stateIsRequired(state.categoryId)) {
    state.stateId = "";
    dailymattrDraftTouched.state = false;
  }
  // A hand edit here outranks an earlier hand edit in the publish panel: the
  // guard exists to stop AUTOMATIC syncs clobbering a choice, not to make the
  // two controls disagree. Clearing it lets this one through.
  dailymattrDraftTouched.category = false;
  syncSectionInputs();
});
postStateSelect?.addEventListener("change", () => {
  state.stateId = postStateSelect.value;
  dailymattrDraftTouched.state = false;
  syncSectionInputs();
});

/* Everyone signed in can read the lists — a writer needs them to file a story.
   Publishing remains QA-only on the server. */
async function loadSectionOptions() {
  if (!postCategorySelect || !state.user) return;
  try {
    const res = await fetch(DAILYMATTR_META_ENDPOINT, { credentials: "same-origin" });
    if (!res.ok) return;
    const payload = await res.json();
    const categories = payload.categories || [];
    const states = payload.states || [];
    const stateCat = categories.find((c) => /^state$/i.test(String(c.name).trim()));
    stateCategoryId = stateCat ? String(stateCat.id) : null;
    fillSelectOptions(postCategorySelect, categories, "Choose a category");
    fillSelectOptions(postStateSelect, states, "Choose a state");
    syncSectionInputs();
    // The analytics category filter lists these same sections, by the same ids.
    sectionCategories = categories;
    fillCategoryOptions(categories);
  } catch { /* the picker is a convenience; the publish panel still works */ }
}

/* Source link — the writer can type it, not only inherit it from a scrape.

   state.sourceUrl had exactly one writer before this: runScrape(). A
   hand-written post could never record where it came from, and reopening a
   saved post showed no trace of the stored link.

   Two ordering traps, both of which cost the value silently:
     - startNewPix() clears state.sourceUrl, and it runs INSIDE the "Build
       Poster" handler, so this listener must own the field afterwards rather
       than the handler reading it before.
     - loadPixIntoEditor() restores state but refills only the headline and
       paragraph inputs, so the box has to be refilled explicitly or it looks
       empty over a post that has one. */
const sourceUrlEdit = document.getElementById("source-url-edit");

/* Open the section, scroll to it and focus. Telling someone a field is
   required and leaving them to find it — inside a collapsed accordion, in a
   three-column editor — is most of the annoyance of a required field. */
function focusSourceLink() {
  if (!sourceUrlEdit) return;
  const acc = sourceUrlEdit.closest(".acc");
  if (acc) acc.dataset.open = "true";
  sourceUrlEdit.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => sourceUrlEdit.focus(), 320);
}
if (sourceUrlEdit) {
  sourceUrlEdit.addEventListener("input", () => {
    state.sourceUrl = sourceUrlEdit.value.trim();
  });
}

/* Keep the box and the state in step wherever either changes. */
function syncSourceUrlInput() {
  if (sourceUrlEdit && sourceUrlEdit.value.trim() !== (state.sourceUrl || "")) {
    sourceUrlEdit.value = state.sourceUrl || "";
  }
}

/* Search is a server round-trip, so it is debounced — every keystroke firing a
   query would put the list into a race where an early, slower response lands
   after a later one and overwrites it with stale rows. */
const reviewSearchInput = document.getElementById("review-search");
if (reviewSearchInput) {
  let searchTimer = null;
  reviewSearchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadReviewQueue(), 300);
  });
  // Enter searches immediately rather than waiting out the debounce.
  reviewSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); clearTimeout(searchTimer); loadReviewQueue(); }
  });
}

/* ── Review stats ──

   The counts object goes in whole and THIS function decides which fields to
   show. The previous shape let the caller pick — it passed written_today and
   the renderer labelled it "Reviewed today" — so a reviewer saw their writing
   count under a reviewing label: 0 beside a chip reading 42. A label and the
   number under it were being chosen in two different places, which is a shape
   that can always drift. One place now.

   A reviewer gets three numbers because they do three distinct things, and
   the difference between them is the point: 57 approved, 21 rejected and 42
   published in a day are all true at once and none substitutes for another.
   A writer gets one, because they do one.

   Day and week figures come from the server, which counts the whole library;
   the verdict split is derived from the rows on screen and describes exactly
   what is listed below. */
function renderReviewStats({ counts, approved, rejected, awaiting, drafts, published, total, filtered }) {
  const host = document.getElementById("review-list");
  if (!host) return;
  let strip = document.getElementById("review-stats");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "review-stats";
    strip.className = "review-stats";
    host.parentNode.insertBefore(strip, host);
  }

  /* First paint can beat the counts request — the view opens, the list loads,
     and lastPixCounts is still null, so the personal tiles would render empty
     and stay that way until something else refreshed them. Ask, then redraw
     once. Guarded so the redraw cannot ask again and loop. */
  if (!lastPixCounts && state.user && !renderReviewStats._awaiting) {
    renderReviewStats._awaiting = true;
    refreshMyPixCount().finally(() => {
      renderReviewStats._awaiting = false;
      if (document.body.classList.contains("view-review")) loadReviewQueue();
    });
  }

  const reviewer = canReviewRole(state.user?.role);
  const tile = (label, value, tone = "", title = "") =>
    value === undefined || value === null
      ? ""
      : `<div class="review-stat${tone ? " is-" + tone : ""}"${title ? ` title="${title}"` : ""}>
           <span class="review-stat-value">${formatCount(value)}</span>
           <span class="review-stat-label">${label}</span>
         </div>`;

  /* Several people hold both roles — they review the queue AND write their own
     stories. Showing a reviewer only their verdicts meant that half of their
     day simply had no number anywhere on their screen, while the same work
     done by a writer was counted. The tile appears when they have actually
     written something, so a reviewer who never writes is not given a
     permanent zero to explain. */
  const alsoWrites = reviewer && (Number(counts?.written_week) || Number(counts?.written_total));

  const own = reviewer
    ? [
        tile("Reviewed today", counts?.reviewed_today, "",
             "Posts you approved or rejected today. A post you did both to counts once."),
        tile("Published today", counts?.published_today, "published",
             "Sent to DailyMattr by you today"),
        alsoWrites ? tile("Written today", counts?.written_today, "",
             "Posts you wrote yourself today — counted the same way a writer's are") : "",
        tile("Reviewed this week", counts?.reviewed_week),
        alsoWrites ? tile("Written this week", counts?.written_week) : "",
      ]
    : [
        tile("Submitted today", counts?.written_today, "",
             "Posts you handed to QA today. Drafts are not counted."),
        tile("Submitted this week", counts?.written_week),
      ];

  /* Under a filter the verdict tiles would restate the filter back at you —
     "5 rejected" beside a list showing only rejected posts. The personal
     figures stay: they describe the day, not the list. */
  strip.innerHTML = [
    ...own,
    filtered ? "" : tile("Approved", approved, "approved"),
    filtered ? "" : tile("Rejected", rejected, "rejected"),
    filtered ? "" : tile("Awaiting QA", awaiting, "awaiting"),
    /* Only when there is one. A permanent zero here would read as "publishing
       is broken" on a library that simply has not sent anything yet, and the
       tile is a way in to the Published tab rather than a target. */
    filtered ? "" : (published ? tile("Published", published, "published",
         "On DailyMattr. Open one to send a corrected copy — their API has no edit.") : ""),
    filtered ? "" : (drafts ? tile("Drafts", drafts, "draft") : ""),
    filtered ? tile("Shown", total) : "",
  ].filter(Boolean).join("");
  strip.hidden = !strip.innerHTML;
}

async function loadReviewQueue() {
  if (!reviewList || !state.user) return;
  setReviewStatus("Loading…");
  reviewList.innerHTML = "";

  /* 200 is the server's ceiling. It was 100 against a library that has passed
     220 posts, so the oldest 120 were unreachable — ordered newest first, a
     writer's submission simply fell off the end of QA's list as newer ones
     arrived, which reads exactly like "my post never showed up".
     Hitting even this ceiling is reported below rather than hidden. */
  const PAGE_LIMIT = 200;
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  // `status` rather than `approved`: the queue has three states now, and a
  // boolean cannot say "rejected".
  /* "mine" is a scope, not a status — it narrows WHOSE posts are listed rather
     than which stage they are at, so it travels as `user` and leaves `status`
     unset. The server has taken ?user= all along (the analytics Writers screen
     uses it); the review list simply never asked, which is why a reviewer who
     also writes could not find their own work in a library of everyone's. */
  if (reviewMine && state.user?.id) params.set("user", String(state.user.id));
  if (reviewStatuses.size) params.set("status", [...reviewStatuses].join(","));
  const term = (reviewSearchInput?.value || "").trim();
  if (term) params.set("q", term);
  const { from, to } = reviewDateBounds();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const narrowed = reviewFilter !== "all" || Boolean(from || to);

  try {
    const response = await fetch(`/api/pix?${params}`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not load the queue (${response.status}).`, "error");
      return;
    }

    const posts = payload.posts || [];
    if (!posts.length) {
      const empty = document.createElement("li");
      empty.className = "review-empty";
      empty.textContent = reviewFilter === "multi" || (reviewMine && reviewStatuses.size) || from || to
        ? "Nothing matches these filters."
        : reviewFilter === "mine"
        ? "You have not written a post yet. Build one, then press Save."
        : reviewFilter === "published"
        ? "Nothing has been published to DailyMattr yet."
        : reviewFilter === "approved"
        ? "Nothing approved yet."
        : reviewFilter === "rejected"
          ? "Nothing rejected."
          : reviewFilter === "awaiting"
            ? "Nothing waiting — every saved post has a verdict."
            /* Drafts are the viewer's own, whoever is looking, so this line is
               about them and not about the library. */
            : reviewFilter === "drafts"
              ? "No drafts of yours — everything you have saved has been submitted."
              : canReviewRole(state.user?.role)
                ? "No posts saved yet."
                : "You have not saved a post yet. Build one, then press Save.";
      reviewList.appendChild(empty);
      syncReviewBulk();
      /* Redraw the tiles on the empty path too. Returning early left the
         PREVIOUS filter's numbers sitting above an empty list — "3 approved"
         over "no drafts of yours" — which reads as a contradiction rather
         than as a stale panel. Today and this week still stand: they are
         facts about the day, not about whatever is listed. */
      renderReviewStats({
        counts: lastPixCounts,
        approved: 0, rejected: 0, awaiting: 0, drafts: 0, published: 0,
        total: 0,
        filtered: narrowed,
      });
      setReviewStatus("");
      return;
    }

    /* Say so when the list is full. Silent truncation is what made the old
       100-post cap look like lost work rather than a paging limit: a writer's
       post really was missing from QA's screen, with nothing on the page
       admitting it. If this ever fills up, it says so and says what to do. */
    if (posts.length >= PAGE_LIMIT) {
      setReviewStatus(
        `Showing the ${PAGE_LIMIT} most recent — older posts are not on this page. Narrow it with a filter or the search box.`,
        "error",
      );
    }

    const approvedCount = posts.filter((p) => p.approved).length;
    const rejectedCount = posts.filter((p) => p.rejected).length;
    const publishedCount = posts.filter((p) => p.published_at).length;
    /* Drafts are counted apart from "awaiting". The All list now includes the
       viewer's own drafts, and folding them into the awaiting figure would
       report unfinished work as sitting with QA — the same false statement the
       row pill below avoids. */
    const draftCount = posts.filter((p) => isStillDraft(p)).length;
    const awaitingCount = posts.length - approvedCount - rejectedCount - draftCount;
    /* Tiles rather than one run-on sentence. The old line packed five numbers
       into a single row of small grey text, so the two a writer actually asks
       for — how much today, how much this week — were not in it at all, and
       the three that were had to be read like prose. Each figure now has its
       own label and its own place. */
    renderReviewStats({
      counts: lastPixCounts,
      approved: approvedCount,
      rejected: rejectedCount,
      awaiting: awaitingCount,
      drafts: draftCount,
      published: publishedCount,
      total: posts.length,
      filtered: narrowed,
    });
    setReviewStatus("");

    posts.forEach((post) => reviewList.appendChild(renderReviewItem(post)));
    syncReviewBulk();
  } catch (err) {
    setReviewStatus(err.message || "Could not load the queue.", "error");
  }
}

/* ── Bulk select (QA only) ──
   Tick rows, then Reject or Delete them together. Each post still goes
   through the same per-post endpoint the row buttons use, so the server's
   rules apply to every one exactly as if it had been pressed by hand. The
   selection is of rows ON SCREEN: every reload redraws the list and starts
   it empty, so nothing can be acted on that the reviewer cannot see. */
const reviewSelected = new Map(); // id -> post
const reviewBulk = document.getElementById("review-bulk");
const reviewSelectAll = document.getElementById("review-select-all");
const reviewBulkCount = document.getElementById("review-bulk-count");
const reviewBulkReject = document.getElementById("review-bulk-reject");
const reviewBulkDelete = document.getElementById("review-bulk-delete");
const reviewBulkClear = document.getElementById("review-bulk-clear");

function reviewRowBoxes() {
  return reviewList ? [...reviewList.querySelectorAll(".review-select")] : [];
}

function syncReviewBulk() {
  const boxes = reviewRowBoxes();
  // Drop selections whose row is gone (reloaded, deleted, filtered away).
  const onScreen = new Set(boxes.map((b) => b.dataset.id));
  for (const id of [...reviewSelected.keys()]) if (!onScreen.has(id)) reviewSelected.delete(id);

  const n = reviewSelected.size;
  if (reviewBulk) reviewBulk.hidden = !boxes.length || !canReviewRole(state.user?.role);
  if (reviewBulkCount) reviewBulkCount.textContent = n ? `${n} selected` : "Select all";
  if (reviewSelectAll) {
    reviewSelectAll.checked = n > 0 && n === boxes.length;
    reviewSelectAll.indeterminate = n > 0 && n < boxes.length;
  }
  const rejectable = [...reviewSelected.values()].filter((p) => !p.rejected).length;
  if (reviewBulkReject) {
    reviewBulkReject.disabled = !rejectable;
    reviewBulkReject.textContent = rejectable ? `Reject ${rejectable}` : "Reject selected";
  }
  if (reviewBulkDelete) {
    reviewBulkDelete.disabled = !n;
    reviewBulkDelete.textContent = n ? `Delete ${n}` : "Delete selected";
  }
  if (reviewBulkClear) reviewBulkClear.hidden = !n;
  boxes.forEach((b) => b.closest(".review-item")?.classList.toggle("is-selected", b.checked));
}

reviewSelectAll?.addEventListener("change", () => {
  reviewRowBoxes().forEach((box) => {
    box.checked = reviewSelectAll.checked;
    if (box.checked) reviewSelected.set(box.dataset.id, box._post);
    else reviewSelected.delete(box.dataset.id);
  });
  syncReviewBulk();
});

reviewBulkClear?.addEventListener("click", () => {
  reviewSelected.clear();
  reviewRowBoxes().forEach((box) => { box.checked = false; });
  syncReviewBulk();
});

/* Runs one request per post, a few at a time, and reports what failed
   rather than stopping at the first error — half a batch done and the rest
   silently skipped is the worst outcome for a bulk action. */
async function runReviewBulk(posts, label, request) {
  const buttons = [reviewBulkReject, reviewBulkDelete, reviewBulkClear, reviewSelectAll];
  buttons.forEach((b) => b && (b.disabled = true));
  let done = 0;
  const failed = [];
  const queue = [...posts];
  const worker = async () => {
    while (queue.length) {
      const post = queue.shift();
      try {
        const response = await request(post);
        if (response.status === 401) { queue.length = 0; handleSignedOut(); return; }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          failed.push({ post, message: `${post.headline || "Untitled"}: ${payload.error || response.status}` });
        }
      } catch (err) {
        failed.push({ post, message: `${post.headline || "Untitled"}: ${err.message || "network error"}` });
      }
      done += 1;
      setReviewStatus(`${label} ${done} of ${posts.length}…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, posts.length) }, worker));
  if (reviewSelectAll) reviewSelectAll.disabled = false;
  if (reviewBulkClear) reviewBulkClear.disabled = false;
  return failed;
}

reviewBulkReject?.addEventListener("click", async () => {
  const posts = [...reviewSelected.values()].filter((p) => !p.rejected);
  if (!posts.length) return;
  const live = posts.filter((p) => p.published_at).length;
  const ok = await confirmAction({
    title: `Reject ${posts.length} post${posts.length === 1 ? "" : "s"}?`,
    body: "They go back to their writers to fix. You can undo a reject from the Rejected tab.",
    facts: [
      live ? `${live} of them ${live === 1 ? "is" : "are"} already on DailyMattr — rejecting will not take ${live === 1 ? "it" : "them"} down.` : "",
      reviewSelected.size > posts.length ? `${reviewSelected.size - posts.length} already rejected will be skipped.` : "",
    ].filter(Boolean),
    confirmLabel: `Reject ${posts.length}`,
    danger: true,
  });
  if (!ok) return;
  const failed = await runReviewBulk(posts, "Rejecting", (post) =>
    fetch(`/api/pix/approve?id=${encodeURIComponent(post.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ approved: false, rejected: true }),
    }));
  reviewSelected.clear();
  await loadReviewQueue();
  refreshMyPixCount();
  announceCountChange();
  setReviewStatus(
    failed.length
      ? `Rejected ${posts.length - failed.length} of ${posts.length}. Failed — ${failed.map((f) => f.message).join("; ")}`
      : `Rejected ${posts.length} post${posts.length === 1 ? "" : "s"}.`,
    failed.length ? "error" : "success",
  );
});

reviewBulkDelete?.addEventListener("click", async () => {
  const posts = [...reviewSelected.values()];
  if (!posts.length) return;
  const live = posts.filter((p) => p.published_at).length;
  const ok = await confirmAction({
    title: `Delete ${posts.length} post${posts.length === 1 ? "" : "s"}?`,
    body: "They will be removed from the library for everyone. This cannot be undone.",
    facts: [
      ...posts.slice(0, 5).map((p) => `"${p.headline || "Untitled post"}" — ${p.user_name || "unknown"}`),
      posts.length > 5 ? `…and ${posts.length - 5} more` : "",
      live ? `${live} ${live === 1 ? "is" : "are"} on DailyMattr — deleting here does not remove ${live === 1 ? "it" : "them"} there.` : "",
    ].filter(Boolean),
    confirmLabel: `Delete ${posts.length}`,
    danger: true,
  });
  if (!ok) return;
  const failed = await runReviewBulk(posts, "Deleting", (post) =>
    fetch(`/api/pix?id=${encodeURIComponent(post.id)}`, { method: "DELETE", credentials: "same-origin" }));
  const kept = new Set(failed.map((f) => f.post.id));
  if (posts.some((p) => p.id === state.pixId && !kept.has(p.id))) state.pixId = null;
  reviewSelected.clear();
  await loadReviewQueue();
  refreshMyPixCount();
  announceCountChange();
  setReviewStatus(
    failed.length
      ? `Deleted ${posts.length - failed.length} of ${posts.length}. Failed — ${failed.map((f) => f.message).join("; ")}`
      : `Deleted ${posts.length} post${posts.length === 1 ? "" : "s"}.`,
    failed.length ? "error" : "success",
  );
});

/* "Still unsubmitted", matching what the server lists: a row that carries a
   verdict has left the drafts stage whatever its flag says, and the few rows
   that predate approval clearing the flag must not be relabelled Draft after
   QA has already signed them off. */
function isStillDraft(post) {
  return Boolean(post.is_draft) && !post.approved && !post.rejected;
}

/* Every DailyMattr id this post has ever produced, newest first: the copy that
   is live now, then the superseded ones still sitting on the public site
   because their API has no delete. Tolerant of a malformed column — this is
   list decoration, and a bad row must not take the whole queue down with it. */
function publishedCopies(post) {
  const history = Array.isArray(post.published_history) ? post.published_history : [];
  const past = history.map((entry) => (entry && entry.id != null ? String(entry.id) : "")).filter(Boolean);
  return post.published_id ? [String(post.published_id), ...past.reverse()] : past.reverse();
}

function renderReviewItem(post) {
  const li = document.createElement("li");
  /* Published outranks approved for the row's colour for the same reason it
     does for the pill: publishing auto-approves, so every published post is
     also an approved one, and drawing them alike is what made a live story
     impossible to pick out of the Approved list. */
  li.className = "review-item"
    + (post.published_at ? " is-published" : post.approved ? " is-approved" : post.rejected ? " is-rejected" : "");

  // Bulk-select tick box — reviewers only, since Reject and Delete are theirs.
  if (canReviewRole(state.user?.role)) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "review-select";
    box.dataset.id = post.id;
    box._post = post;
    box.checked = reviewSelected.has(post.id);
    box.setAttribute("aria-label", `Select "${post.headline || "untitled"}"`);
    box.addEventListener("change", () => {
      if (box.checked) reviewSelected.set(post.id, post);
      else reviewSelected.delete(post.id);
      syncReviewBulk();
    });
    li.appendChild(box);
  }

  // The stored image is a URL, so the thumbnail is the real poster image
  // rather than a re-render — cheap, and enough to recognise a post by.
  if (post.main_image_url) {
    const thumb = document.createElement("img");
    thumb.className = "review-thumb";
    thumb.loading = "lazy";
    thumb.alt = "";
    thumb.src = `/api/image?url=${encodeURIComponent(post.main_image_url)}`;
    thumb.addEventListener("error", () => thumb.remove());
    li.appendChild(thumb);
  }

  const main = document.createElement("div");
  main.className = "review-item-main";

  const title = document.createElement("span");
  title.className = "review-item-title";
  title.textContent = post.headline || "(untitled)";

  const meta = document.createElement("span");
  meta.className = "review-item-meta";
  meta.textContent = [
    post.user_name || "unknown",
    /* Falls back to the row's own dates when the sorted-by timestamp is
       missing — a post approved before approved_at existed still has to show
       something, and an empty gap in the middle of the meta line reads as a
       rendering fault rather than as missing history. */
    (() => {
      const stamp = reviewRowStamp(post);
      const when = formatLibraryDate(stamp.at) || formatLibraryDate(post.updated_at || post.created_at);
      if (!when) return "";
      return stamp.label && stamp.at ? `${stamp.label} ${when}` : when;
    })(),
    hostOf(post.source_url),
    post.approved && post.approved_by_name ? `approved by ${post.approved_by_name}` : "",
    post.rejected && post.rejected_by_name ? `rejected by ${post.rejected_by_name}` : "",
    /* The handle for finding this story in DailyMattr's portal, which is the
       only place it can be deleted from. Named in the list rather than only
       inside the editor because that is where somebody clearing up after a
       correction is working. */
    post.published_at && post.published_id ? `DailyMattr ${post.published_id}` : "",
    post.published_at && !post.published_id ? "publish unconfirmed" : "",
  ].filter(Boolean).join(" · ");

  const pill = document.createElement("span");
  /* Draft outranks the verdict, the same way the analytics list does it: an
     unsubmitted post has no verdict to report, and "Awaiting approval" would
     tell the writer their draft is with QA when QA cannot see it at all. */
  const draft = isStillDraft(post);
  /* Published outranks approved. It is the more specific fact and the one that
     changes what QA can do next: an approved post can still be edited freely,
     a published one can only be corrected by sending a second copy. */
  const published = Boolean(post.published_at);
  pill.className = "status-pill"
    + (draft ? " is-draft" : published ? " is-published" : post.approved ? " is-approved" : post.rejected ? " is-rejected" : "");
  pill.textContent = draft ? "Draft"
    : published ? "Published"
      : post.approved ? "Approved" : post.rejected ? "Rejected" : "Awaiting approval";

  main.append(title, meta, document.createElement("br"), pill);

  /* A post that has been sent more than once has more than one copy on the
     public site, and only one of them is the current text. The count is the
     warning; the ids are in the title so whoever is tidying up can read them
     without opening the post. */
  const copies = publishedCopies(post);
  if (copies.length > 1) {
    const superseded = document.createElement("span");
    superseded.className = "status-pill is-superseded";
    superseded.textContent = `${copies.length} copies live`;
    superseded.title = `Every ID this post has produced, newest first: ${copies.join(", ")}. `
      + "Only the newest is the corrected text — the rest stay on the site until they are deleted in the DailyMattr portal.";
    main.append(document.createTextNode(" "), superseded);
  }

  const actions = document.createElement("div");
  actions.className = "review-item-actions";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn-ghost";
  open.textContent = "Open";
  open.addEventListener("click", async () => {
    await openSavedPost(post.id);
    setView("poster");
  });

  actions.append(open);

  /* Three actions, and approving is not one of them.

     Approval is not a decision made from a list — it is made after reading the
     post, which means opening it, and publishing from the editor marks the
     post approved on the way out. A row-level Approve was therefore a second
     path to the same state that skipped the reading, and Approve & Publish put
     the one irreversible action in this app next to four reversible ones.

     Reject stays here because it is the verdict that does NOT need the editor:
     a row can be sent back on the strength of its headline and writer alone.
     Rejecting from inside the post is available too, on the editor toolbar. */
  if (canReviewRole(state.user?.role)) {
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn-ghost" + (post.rejected ? "" : " btn-reject");
    reject.textContent = post.rejected ? "Undo reject" : "Reject";
    reject.addEventListener("click", () => setPostVerdict(post, post.rejected ? "awaiting" : "rejected", reject));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-ghost";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteReviewPost(post, li));

    /* Reopen, and ONLY on a post that is already approved. The row stays
       Open / Reject / Delete for everything in the queue — approving is still
       not something done from a list.

       This exists because locking an author out of an approved post created a
       dead end: the server tells them "ask QA to reopen it before editing",
       and until now there was nothing for QA to press. An instruction that
       names a control which does not exist is worse than no instruction.

       Withdrawing the approval is a verdict change, not an edit, so it goes
       through the same setPostVerdict path as Reject and lands the post back
       in Awaiting. */
    if (post.approved) {
      const reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "btn-ghost";
      reopen.textContent = "Reopen";
      reopen.title = post.published_at
        ? "Withdraw the approval so the writer can edit — the copy already on DailyMattr will not change"
        : "Withdraw the approval and put this back in the queue so the writer can edit it";
      reopen.addEventListener("click", async () => {
        /* A published post is the one case worth a confirmation: reopening
           does not and cannot retract the live story, and someone reaching
           for this button may believe it does. */
        if (post.published_at) {
          const ok = await confirmAction({
            title: "Reopen a published post?",
            body: "The writer will be able to edit it again. The copy already on DailyMattr will NOT change — their API has no edit and no delete.",
            facts: ["Editing here will make the library disagree with the public site."],
            confirmLabel: "Reopen anyway",
            danger: true,
          });
          if (!ok) return;
        }
        setPostVerdict(post, "awaiting", reopen);
      });
      actions.append(reopen);
    }

    actions.append(reject, del);
  }
  li.append(main, actions);
  return li;
}

/* verdict: "approved" | "rejected" | "awaiting" */
async function setPostVerdict(post, verdict, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = { approved: "Approving…", rejected: "Rejecting…", awaiting: "Withdrawing…" }[verdict];
  try {
    const response = await fetch(`/api/pix/approve?id=${encodeURIComponent(post.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ approved: verdict === "approved", rejected: verdict === "rejected" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not update the verdict (${response.status}).`, "error");
      button.textContent = previous;
      return;
    }
    setReviewStatus({
      approved: "Approved.",
      rejected: "Rejected.",
      awaiting: "Verdict withdrawn — back to awaiting approval.",
    }[verdict], "success");
    // Re-fetch rather than patch the row in place: under the Pending or
    // Approved filter the post has just left the list it is sitting in.
    loadReviewQueue();
    refreshMyPixCount();   // a verdict is a review, so the reviewer's tally moved
    announceCountChange();  // ...and the author's, in whichever tab they have open
  } catch (err) {
    setReviewStatus(err.message || "Could not update the verdict.", "error");
    button.textContent = previous;
  } finally {
    button.disabled = false;
  }
}

async function deleteReviewPost(post, itemEl) {
  const ok = await confirmAction({
    title: "Delete this post?",
    body: `"${post.headline || "Untitled post"}" will be removed from the library for everyone. This cannot be undone.`,
    facts: [
      `Written by ${post.user_name || "unknown"}`,
      post.approved ? "It is currently approved" : "It is still pending",
    ],
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    const response = await fetch(`/api/pix?id=${encodeURIComponent(post.id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) return handleSignedOut();
      setReviewStatus(payload.error || `Could not delete (${response.status}).`, "error");
      return;
    }
    itemEl.remove();
    if (state.pixId === post.id) state.pixId = null;
    setReviewStatus("Deleted.", "success");
  } catch (err) {
    setReviewStatus(err.message || "Could not delete.", "error");
  }
}

/* ── Unsaved-changes indicator ──────────────────────────────────────────────
   Nothing is written until Save is pressed, so an edit made after the last
   Save — a rewritten headline, a pair of [highlight brackets], a swapped
   image — lives only in the tab. That is easy to miss, and the post looks
   fine on screen while the database still holds the previous version.

   The button says so: it reads "Save •" while the poster differs from what
   was last stored, and settles back to "Save" once they match. */

let lastSavedFingerprint = null;

/* A cheap stand-in for the whole payload. Only the fields that end up in a
   column count — `design.savedAt` is a timestamp and would make every check
   look like a change. */
/* Read off the same base-page view as collectPixPayload, and for the same
   reason: this is what decides whether the post "changed", and merely
   SELECTING another page changes live `state`. Reading `state` here made the
   dirty dot light — and the idle autosave fire — on a page click, which is
   how a blank added page's fields reached the row unattended. The two
   readings must also agree with each other: markPixSaved() records this value
   as "what is stored", so a fingerprint computed against a different page
   than the payload would never match and autosave would re-fire forever. */
function pixFingerprint(view = basePageView()) {
  const article = view.article || {};
  return JSON.stringify([
    view.headline,
    view.detailText,
    view.sourceUrl,
    describeMainImage(view).url,
    view.aspectRatio,
    view.accent,
    view.tag,
    view.headlineStyle,
    view.fontSize,
    view.imageZoom,
    view.imageOffset?.x,
    view.imageOffset?.y,
    view.logoX, view.logoY, view.logoSize,
    view.filterPreset, view.filterBrightness, view.filterContrast,
    view.filterSaturation, view.filterBlur,
    view.showTimestamp,
    article.headline, (article.bullets || []).join("|"), article.tweet,
    view.videoUrl, view.trimStart, view.trimEnd, view.videoCaption,
    // Added pages are part of the post, so editing one has to light the
    // unsaved dot the same way editing page 1 does.
    JSON.stringify(serializePages()),
  ]);
}

function markPixSaved() {
  lastSavedFingerprint = pixFingerprint();
  refreshSaveIndicator();
}

/* The button is wired to the draft path for everyone, so for a writer — whose
   handoff is the separate topbar Submit — it has to say "draft" out loud. A
   button labelled "Save" that had silently become a Submit is what let a
   half-written article reach QA; the label now cannot disagree with what the
   press does. Reviewers have no draft/submit split to explain, so they keep
   the plain word. */
function saveButtonLabel() {
  return state.user && !canReviewRole(state.user.role) ? "Save draft" : "Save";
}

function refreshSaveIndicator() {
  if (!savePixBtn || !savePixLabel) return;
  // Mid-flight labels ("Saving…", "Saved", "Updated") own the button for a
  // few seconds; leave them alone.
  if (savePixBtn.disabled || savePixBtn.classList.contains("is-saved") || savePixBtn.classList.contains("is-error")) return;

  const nothingToSave = !state.headline && !state.sourceUrl;
  const dirty = !nothingToSave && lastSavedFingerprint !== null && pixFingerprint() !== lastSavedFingerprint;
  const label = saveButtonLabel();

  savePixBtn.classList.toggle("is-dirty", dirty);
  savePixLabel.textContent = dirty ? `${label} •` : label;
  savePixBtn.title = dirty
    ? "This post has changes that are not in the library yet"
    : (label === "Save draft"
        ? "Save a draft — QA cannot see it until you press Submit"
        : "Save this post to the library");
}

/* Polled rather than wired into every control: the editor changes state from
   dozens of places — sliders, drags, chips, the AI writer, an image load —
   and a single cheap comparison is more reliable than remembering to call a
   hook from all of them. */
/* ── Reject, from the editor ──

   Shown only once the open post has a row and only to a reviewer: rejecting
   something that was never saved would have nothing to write to, and the
   button would be a dead control for every writer.

   confirmAction first. Rejection is visible to the writer and resets the
   post's standing, so it should not be one stray click away. */
const rejectPixBtn = document.getElementById("reject-pix-btn");
const rejectPixLabel = document.getElementById("reject-pix-label");

function syncRejectButton() {
  if (!rejectPixBtn) return;
  const allowed = Boolean(state.user && canReviewRole(state.user.role) && state.pixId);
  rejectPixBtn.hidden = !allowed;
}

if (rejectPixBtn) {
  rejectPixBtn.addEventListener("click", async () => {
    if (!state.pixId) return;
    const ok = await confirmAction({
      title: "Reject this post?",
      body: "It goes back to the writer as rejected. They can edit it and it returns to the queue.",
      confirmLabel: "Reject",
      danger: true,
    });
    if (!ok) return;

    rejectPixBtn.disabled = true;
    if (rejectPixLabel) rejectPixLabel.textContent = "Rejecting…";
    try {
      const response = await fetch(`/api/pix/approve?id=${encodeURIComponent(state.pixId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ approved: false, rejected: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) return handleSignedOut();
        setStatus(payload.error || `Could not reject that post (${response.status}).`, "error");
        return;
      }
      setStatus("Rejected — sent back to the writer.", "success");
      // The Review list is now stale by one row.
      if (typeof loadReviewQueue === "function") loadReviewQueue();
      refreshMyPixCount();
    } catch (err) {
      setStatus(err.message || "Could not reject that post.", "error");
    } finally {
      rejectPixBtn.disabled = false;
      if (rejectPixLabel) rejectPixLabel.textContent = "Reject";
    }
  });
}

/* ── Autosave ──

   Only for a post that already has a row. A new post still needs one manual
   Save, for two reasons: a writer has to choose a category before the server
   will accept it at all, so an autosave before that could only fail; and most
   experiments in this editor are never meant to be kept, so creating a row the
   moment someone types a headline would fill the library with abandoned
   drafts. Once the row exists, every later edit saves itself.

   That is exactly the case QA is in — they only ever open posts that are
   already saved — which is where edits were being lost.

   Idle-triggered rather than on a fixed timer: saving mid-sentence would write
   half a headline and, with QA editing a post a writer may also have open,
   the fewer intermediate versions written the better. */
const AUTOSAVE_IDLE_MS = 2500;
let autosaveFingerprint = null;
let autosaveDirtySince = 0;
let autosaveInFlight = false;

function considerAutosave() {
  if (!state.user || !state.pixId || autosaveInFlight) return;
  // A manual save owns the button and the row while it runs.
  if (savePixBtn?.disabled) return;
  /* So do the two other things that drive `state` themselves. Autosave can
     only ever tell "the post changed" from a fingerprint, and both of these
     change it for reasons that are not edits: an open is still restoring the
     post it is about to declare saved, and a publish is stepping the
     selection through every page to export it. Neither is a person typing. */
  if (editorLoading || publishInFlight) return;
  /* An export is already encoding this clip. ensureMediaUploaded would post
     the whole original file to /api/video/clip a SECOND time — two ffmpeg jobs
     on the same footage, two multi-hundred-megabyte uploads, from a timer
     nobody pressed. The publish button refuses for the same reason. */
  if (state.videoExporting) return;
  if (lastSavedFingerprint === null) return;

  /* ── Where autosave stops ──
     It had no notion of workflow state at all: any row it could see, it kept
     rewriting.

     A post that is approved — or already on DailyMattr, whose API has no edit
     and no delete — must not be changed by a timer. The row is the only record
     of what QA signed off and of what went out; overwriting it 2.5s after
     somebody scrolled past leaves "approved by <QA>" over text no reviewer read
     and a library that disagrees with the public site. `publishOutcomeUnknown`
     counts as published for the same reason it shuts the Publish button: the
     story may be live and nothing here can find out.

     For a writer, the line is earlier — anything that is not a draft. Once
     work has been handed over, QA may be reading it right now, and a
     background write pushes half-typed sentences under their eyes; that is the
     incident this whole audit came from. It also makes the resubmission of a
     rejected post an act rather than an accident: the server lifts a rejection
     on an explicit save (see clearRejection), and this is why an idle timer
     cannot do it for them.

     Refusing is not the same as losing the edit. The unsaved dot stays lit and
     the Save button still works — that is the point, an explicit press instead
     of an ambient one. QA keeps the manual route on an approved post too; only
     the author is locked out server-side, since only QA can reopen one. */
  if (state.approved || state.publishedAt || publishOutcomeUnknown) return;
  if (!canReviewRole(state.user.role) && !state.isDraft) return;

  const fingerprint = pixFingerprint();
  if (fingerprint === lastSavedFingerprint) {
    autosaveDirtySince = 0;
    return;
  }
  // Still changing — restart the clock so it fires after typing stops.
  if (fingerprint !== autosaveFingerprint) {
    autosaveFingerprint = fingerprint;
    autosaveDirtySince = Date.now();
    return;
  }
  if (Date.now() - autosaveDirtySince < AUTOSAVE_IDLE_MS) return;

  autosaveInFlight = true;
  /* Say the intent out loud rather than letting savePixToLibrary infer it. A
     background write must only ever re-save the post as what it already is;
     leaving the argument off made autosave inherit whatever the last resolved
     intent happened to be, which is how one mis-set flag turned an idle timer
     into a repeated submission to QA. */
  savePixToLibrary({ asDraft: state.isDraft, auto: true })
    .then((result) => {
      if (result.ok && result.videoStoreFailure) {
        /* Saved, but not with its video — so it must not read as saved.

           Autosave used to print "Saved automatically" and light "Autosaved at
           14:32" whatever happened to the clip, dropping both result.warning
           and result.videoStoreFailure on the floor. The writer saw green,
           believed the post was safe, reloaded or opened the next story, and
           the footage was gone for good: the row keeps a trim range and no
           URL, and an uploaded File does not survive a reload.

           No dialog here — a modal from a background timer would interrupt
           typing every few seconds — but the line is red, it names the clip,
           and the "saved" stamp is deliberately withheld. */
        setStatus(`Saved automatically, but the video was not: ${result.videoStoreFailure}. Press Save to try the clip again.`, "error");
      } else if (result.ok) {
        setStatus(result.warning ? `Saved automatically, but the ${result.warning}.` : "Saved automatically.",
          result.warning ? "error" : "success");
        showAutosaved(`Autosaved at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
      } else {
        /* Quietly. The unsaved dot stays lit, so the state is still visible,
           and a validation failure here would otherwise reappear as a toast
           every few seconds until the writer happened to fix it. */
        console.warn("[pix] autosave skipped:", result.error);
      }
    })
    .finally(() => {
      autosaveInFlight = false;
      autosaveDirtySince = 0;
      autosaveFingerprint = null;
    });
}

setInterval(() => {
  refreshSaveIndicator();
  syncRejectButton();
  considerAutosave();
  syncDailyMattrDraft();
  syncDailyMattrMediaCount();
}, 800);

/* ── Uploaded media ─────────────────────────────────────────────────────────
   An uploaded image lives in the tab as a `data:` URL and an uploaded video as
   a File — neither has an address, so neither can go in a database row. On
   Save they are pushed to Supabase Storage first and the row keeps the URL
   that comes back.

   Uploads happen at Save, not at drop: most experiments never get saved, and
   uploading every image the moment it is dragged in would spend storage on
   posters nobody keeps. */

/* PUT a blob with progress. fetch() cannot report upload progress at all, and
   a writer staring at a still screen through a 45 MB clip has no way to tell a
   slow upload from a dead one — so this stays XHR. */
function putWithProgress(url, blob, { contentType, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    // Storage rejects a repeat PUT to the same path without this; a retry of a
    // half-finished upload must be allowed to land on its own key.
    xhr.setRequestHeader("x-upsert", "true");

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      let detail = "";
      try { detail = JSON.parse(xhr.responseText)?.message || ""; } catch { /* not json */ }
      reject(new Error(detail || `Storage refused the upload (${xhr.status}).`));
    };
    // A dropped connection lands here rather than in onload, and it is the
    // failure that orphaned every stray clip in the bucket.
    xhr.onerror = () => reject(new Error("The connection dropped during the upload."));
    xhr.ontimeout = () => reject(new Error("The upload timed out."));
    xhr.onabort = () => reject(new Error("The upload was cancelled."));
    xhr.send(blob);
  });
}

/**
 * Store one blob and return the URL it can be read back from.
 *
 * Three steps, and the third is the one that matters: the server is asked to
 * CONFIRM the object is in the bucket before this resolves. Until that check
 * existed, "uploaded" meant "the request did not visibly fail", which is how
 * 27 clips ended up in Storage with no post pointing at them.
 *
 * The bytes go straight from here to Supabase. They no longer pass through the
 * app server, which used to hold each whole file in memory while forwarding it.
 */
async function uploadMediaBlob(blob, filename, { onProgress } = {}) {
  const contentType = blob?.type || "application/octet-stream";

  // 1. Ask for a one-shot signed URL scoped to one object path.
  const signRes = await fetch("/api/media/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ contentType, filename: filename || "upload" }),
  });

  /* An older server has no /api/media/sign. Falling back keeps a browser tab
     that is mid-shift working across a deploy instead of failing every upload
     until it is reloaded. */
  if (signRes.status === 404) return legacyUploadMediaBlob(blob, filename);

  const signed = await signRes.json().catch(() => ({}));
  if (!signRes.ok) {
    if (signRes.status === 401) handleSignedOut();
    throw new Error(signed.error || `Could not prepare the upload (${signRes.status}).`);
  }
  if (!signed.uploadUrl || !signed.key) {
    throw new Error("The server did not return an upload address.");
  }

  // 2. Straight to Storage.
  await putWithProgress(signed.uploadUrl, blob, { contentType, onProgress });

  // 3. Only now ask whether it is really there. A URL is recorded on a post
  //    only after this answers yes.
  const confirmRes = await fetch("/api/media/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ key: signed.key }),
  });
  const confirmed = await confirmRes.json().catch(() => ({}));
  if (!confirmRes.ok) {
    if (confirmRes.status === 401) handleSignedOut();
    throw new Error(confirmed.error || `The upload could not be confirmed (${confirmRes.status}).`);
  }
  if (typeof confirmed.url !== "string" || !/^https?:\/\//i.test(confirmed.url)) {
    throw new Error("The upload was not confirmed as stored.");
  }
  return confirmed.url;
}

/* The previous route: browser -> app server -> Storage. Kept only so an
   in-flight tab survives a deploy; nothing should reach for it by choice. */
async function legacyUploadMediaBlob(blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename || "upload");
  const response = await fetch("/api/media", {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) handleSignedOut();
    throw new Error(payload.error || `Upload failed (${response.status}).`);
  }
  /* A 200 is not the same as a URL. The body is parsed with .catch(() => ({})),
     so an empty, truncated or HTML response arrives here as {} and this used to
     return undefined — which the caller then filed as a "stored" clip with no
     address. */
  if (typeof payload.url !== "string" || !/^https?:\/\//i.test(payload.url)) {
    throw new Error("Upload finished but the server returned no file URL.");
  }
  return payload.url;
}

function dataUrlToBlob(dataUrl) {
  const [meta, encoded] = String(dataUrl).split(",");
  const contentType = (meta.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
  if (!/;base64$/i.test(meta.split(";").slice(1).join(";")) && !/;base64/i.test(meta)) {
    return new Blob([decodeURIComponent(encoded)], { type: contentType });
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

/* `/api/image?url=X` is how every remote picture is loaded — the proxy is what
   makes it same-origin and therefore drawable onto a canvas. Getting X back out
   matters because the thing worth storing is the picture's real address, not
   our proxy's. */
function unwrapProxiedImageUrl(src) {
  const text = String(src || "");
  if (!/[?&]url=/.test(text)) return text;
  const encoded = (text.match(/[?&]url=([^&]+)/) || [])[1];
  if (!encoded) return text;
  try { return decodeURIComponent(encoded); } catch { return text; }
}

/* A picture we have already uploaded. Re-uploading one of these on every save
   would fill the bucket with identical copies of the same file. */
function isStoredMediaUrl(url) {
  return /\/storage\/v1\/object\/public\//.test(String(url || ""));
}

/**
 * The bytes behind whatever the canvas is currently painting.
 *
 * A data: URL carries its own bytes. Everything else is a remote address, and
 * the ONLY way a writer ever produced a data: URL was by dragging a file in —
 * a suggested image, a stock image, the scraped article image and a pasted
 * link all arrive as URLs. ensureMediaUploaded used to skip those outright, so
 * a slide illustrated by any means except drag-and-drop was saved with no
 * picture at all: the text survived, the image did not, and QA opened the
 * carousel to find empty slides. Fetching through the same proxy that loaded
 * the image keeps this same-origin and reuses its cache.
 */
async function blobForImageSrc(src) {
  const text = String(src || "");
  if (text.startsWith("data:")) return dataUrlToBlob(text);
  if (!text) throw new Error("no image source");
  const raw = unwrapProxiedImageUrl(text);
  const proxied = `/api/image?url=${encodeURIComponent(raw)}`;
  const res = await fetch(proxied, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`source unreachable (${res.status})`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("source returned an empty file");
  return blob;
}

/* One slide's picture, stored and recorded. Returns the URL it settled on, or
   null when there is nothing to store. Shared by the post's own image and by
   every added page so the two can never drift apart again. */
async function storeImageForSlide(src, filename) {
  const text = String(src || "");
  if (!text) return null;
  /* Already ours — record the address rather than uploading a second copy.
     This is also what makes reopening a saved post and saving it again free:
     the image comes back as a proxy around the stored URL. */
  const raw = unwrapProxiedImageUrl(text);
  if (isStoredMediaUrl(raw)) return raw;
  return await uploadMediaBlob(await blobForImageSrc(text), filename);
}

/**
 * Make sure everything the poster shows has a URL, uploading what does not.
 *
 * Each upload is remembered against its exact source, so pressing Save five
 * times uploads once. Returns a message when something could not be stored —
 * the save still goes ahead, minus that URL, because losing the text as well
 * would make a storage outage twice as expensive.
 */
/* Set when the clip could not be stored on THIS save. Read by the caller so
   it can raise a dialog rather than a status line — see runSave. */
let videoStoreFailure = null;
/* Same contract as videoStoreFailure, for a slide picture that could not be
   stored. A carousel handed to QA with a blank slide is the image-shaped
   version of a post handed over with no clip. */
let imageStoreFailure = null;

async function ensureMediaUploaded(onProgress = () => {}) {
  const problems = [];
  videoStoreFailure = null;
  imageStoreFailure = null;

  /* The image to upload is the POST's, not the selected page's — otherwise
     saving while an added page is selected uploaded that page's picture (or,
     far more often, uploaded nothing at all because the new page has none)
     and describeMainImage then found no stored URL for the real one. Only
     this read moves to the view: storedImageFor/storedImageUrl below are not
     page-owned, so they stay on `state` where describeMainImage reads them
     back through the same view. */
  syncActivePageContent();
  if (!basePage.content) basePage.content = {};
  const src = basePageView().mainImage?.src || "";
  /* Every source, not only a dragged-in file. The old test was
     `src.startsWith("data:")`, which quietly meant "only pictures the writer
     dragged in get stored" — a suggested, stock, scraped or pasted image is a
     URL and was skipped, so the post saved with no picture. */
  if (src && basePage.content.storedImageFor !== src) {
    onProgress("Uploading image…");
    try {
      const url = await storeImageForSlide(src, "poster-image");
      /* Onto the base page, and onto `state` only when the base page is the
         one selected. Now that these are page-owned, writing them to `state`
         while an added page is open would file the POST's picture under that
         page and lose the post's own. */
      /* Re-read basePage.content AFTER the await instead of writing through a
         reference taken before it. syncActivePageContent() REPLACES the object
         (`basePage.content = { ...old, ...capture }`), and the 800ms render
         poll calls it — so an upload lasting more than one tick left the
         pre-await reference orphaned and the URL was written onto an object
         nothing would ever read again. The post's picture then saved as null
         while every page's saved fine, because the pages were not selected and
         their objects were never rebuilt. */
      if (!basePage.content) basePage.content = {};
      basePage.content.storedImageFor = src;
      basePage.content.storedImageUrl = url;
      /* Also into `state` when the SELECTED page does not own these fields.

         storedImageFor/storedImageUrl became page-owned, and a Video page is
         the one page type that owns none of the image fields. When one is
         selected, syncActivePageContent() treats every BASE field as
         un-owned and rebuilds basePage.content from `state` — which still
         mirrors the pre-upload values, because the write above deliberately
         skipped state. So the URL just uploaded was overwritten with null
         three times inside the same save, and describeMainImage then recorded
         main_image_url: null for a picture that is sitting in the bucket.

         The test is additive rather than a replacement: when the base page IS
         selected, state must still be written, or the ordinary path loses the
         URL the same way. */
      if (activePage() === basePage
          || !fieldsForPage(activePage()).includes("storedImageUrl")) {
        state.storedImageFor = src;
        state.storedImageUrl = url;
      }
    } catch (err) {
      problems.push(`image not stored (${err.message})`);
    }
  }

  /* Every added page's picture too — this is what makes a carousel survive.

     Only the post's own image was ever uploaded, so a writer could paste a
     picture into slide 2, save, and watch it vanish on reopen; QA then opened
     the post and found the carousel empty, because the pages were rebuilt
     from text and framing with no media to hang it on. The pages themselves
     were saved all along. The images were simply never sent anywhere.

     Written to page.content, not to `state`: the selected page's fields are
     swapped in and out of state as the rail is clicked, so a URL parked there
     would follow the selection instead of the page it belongs to. */
  syncActivePageContent();
  for (const page of extraPages()) {
    const content = page.content || (page.content = {});
    const pageSrc = content.mainImage?.src || "";
    /* Same correction as the post's image above, and this is the one the
       carousel complaint was actually about: a writer illustrating slide 3
       from the suggested-image strip produced a URL, not a data: URL, so the
       slide was skipped here, `imageUrl` was never written by
       serializePages(), and the reviewer opened a slide with words and no
       picture. */
    if (!pageSrc) continue;
    if (content.storedImageFor === pageSrc) continue;
    onProgress(`Uploading page ${cardNumber(page.cards[0]) || ""} image…`);
    try {
      const url = await storeImageForSlide(pageSrc, "page-image");
      // Same hazard as above: re-read rather than trust the pre-await handle.
      const fresh = page.content || (page.content = {});
      fresh.storedImageFor = pageSrc;
      fresh.storedImageUrl = url;
      /* The selected page's values live in `state`, and the next
         syncActivePageContent() rebuilds its content from there — so writing
         only to content would be undone for whichever page is on screen.
         That is precisely why the last slide a writer touched was the one
         that lost its picture. */
      if (activePage() === page) {
        state.storedImageFor = pageSrc;
        state.storedImageUrl = url;
      }
    } catch (err) {
      /* Recorded, not just listed. A slide whose picture never reached Storage
         renders as words on a blank frame, and until now that still went to QA
         with nothing to stop it — the same silent hand-over the missing clip
         used to get. */
      problems.push(`page image not stored (${err.message})`);
      imageStoreFailure = err.message || "a slide picture could not be stored";
    }
  }

  // Video: store the trim range, not the source. A 17-minute upload is far
  // over Supabase's per-file limit and nobody wants those minutes back — the
  // clip between start and end is the thing that gets published.
  await withPrimaryVideo(async () => {
    const clipKey = videoClipKey();

    /* Already stored and unchanged — nothing to do, and nothing to report.

       The URL is part of the test, not just the fingerprint. Testing the
       fingerprint alone is what turned one failed upload into "video never
       works": the moment a clip was stamped as stored without an address,
       every later save took this early return, uploaded nothing, reported
       nothing, and wrote another row with a trim range and no clip. Requiring
       the URL means a poisoned post retries instead of failing silently for
       ever. resolvePublishClipFromState already tests both (app.js:8089). */
    if (clipKey && state.storedVideoFor === clipKey && state.storedVideoUrl) return;

    /* No key, but there IS a video page. This used to `return` alongside the
       line above, which is the quietest failure in the whole save path: the
       clip is not uploaded, nothing is pushed to `problems`, the save reports
       success, and the row is written with a trim range but no storedUrl.
       That is the exact fingerprint of four of the five video posts in the
       library — trim saved, clip absent — and it only becomes visible at
       publish time, by which point an uploaded File is long gone and the
       video cannot be recovered at all.

       videoClipKey() returns null for two reasons and both are worth naming
       rather than swallowing: no source it can identify, or a trim range that
       is not yet a range because the element has not reported its duration. */
    if (!clipKey) {
      const page = primaryVideoPage();
      const hasVideoPage = Boolean(page);
      if (!hasVideoPage) return;      // genuinely no video on this post

      const why = !(state.trimEnd > state.trimStart)
        ? "its trim range is empty — the clip may still be loading"
        : "its source is gone — an uploaded file does not survive a reload";
      console.error("[pix] clip skipped, no key:", {
        why, trimStart: state.trimStart, trimEnd: state.trimEnd,
        hasFile: !!state.videoFile, videoUrl: state.videoUrl, stored: state.storedVideoUrl,
      });
      problems.push(`video not stored (${why})`);
      videoStoreFailure = why;
      return;
    }
    try {
      let blob = state.renderedClip?.key === clipKey ? state.renderedClip.blob : null;
      if (!blob) {
        onProgress("Rendering clip…");
        blob = await renderTrimmedClip({ onStatus: (m) => onProgress(m) });
        state.renderedClip = { blob, key: clipKey };
      }
      /* One retry. The measured failure is a large clip whose bytes reach
         Storage while the client never gets a usable response back — the
         object lands, the reference does not. A second attempt costs one
         upload and recovers the case that produced every orphan in the
         bucket. Two attempts, not a loop: if it fails twice the writer needs
         to be told, not kept waiting. */
      /* Raw, uncompressed, whatever size the writer's clip is. Compression
         belongs at publish, where DailyMattr's own cap applies — squeezing it
         here would degrade the master copy for a limit that is not ours. */
      const mb = (blob.size / 1048576).toFixed(1);
      onProgress(`Uploading video (${mb} MB)…`);
      const track = (pct) => onProgress(`Uploading video (${mb} MB) — ${pct}%`);

      let url;
      try {
        url = await uploadMediaBlob(blob, "slide2.mp4", { onProgress: track });
      } catch (first) {
        console.warn("[pix] clip upload failed, retrying once:", first);
        onProgress("Upload failed — retrying…");
        url = await uploadMediaBlob(blob, "slide2.mp4", { onProgress: track });
      }
      /* Stamp only once the address is real. Setting storedVideoFor next to a
         null URL is what the early return above then treats as "done". */
      if (typeof url !== "string" || !url) {
        throw new Error("the upload returned no URL");
      }
      state.storedVideoFor = clipKey;
      state.storedVideoUrl = url;
    } catch (err) {
      /* Logged in full as well as reported: the message reaching the user is
         one line, but diagnosing an encode failure needs the whole thing. */
      console.error("[pix] clip not stored:", err);
      problems.push(`video not stored (${err.message})`);
      videoStoreFailure = err.message || "the clip could not be prepared";
    }
  });

  return problems;
}

/* Identifies one rendered clip: the source, the range, and everything else
   that changes the pixels. Same key means the stored clip is still correct,
   so Save neither re-encodes nor re-uploads. Null when there is no video. */
function videoClipKey() {
  /* storedVideoUrl is the third source and it used to be missing, which is
     why reopened posts published their images and no video.

     A video added by UPLOAD has no source URL — sourceKind "file", and the
     File object itself does not survive a reload. So on reopening such a post
     videoFile is null and videoUrl is "", both earlier branches fell through,
     and this returned null. resolvePublishClip() bails immediately on a null
     key, so the clip was skipped silently — even though the trimmed copy was
     sitting in our bucket, playing in the preview the whole time. */
  /* The stored source is the copy being CUT FROM (clipSourceUrl), not the
     newest upload. storedVideoUrl is the encode's output: keyed on it, every
     upload changed the key of the clip it had just stored, so the next Save
     saw a mismatch and tried to encode again. */
  const storedSource = state.clipSourceUrl || state.storedVideoUrl;
  const source = state.videoFile
    ? `file:${state.videoFile.name}:${state.videoFile.size}:${state.videoFile.lastModified}`
    : (state.videoUrl ? `url:${state.videoUrl}`
      : (storedSource ? `stored:${storedSource}` : ""));
  if (!source) return null;
  if (!(state.trimEnd > state.trimStart)) return null;
  return [
    source,
    state.trimStart.toFixed(2),
    state.trimEnd.toFixed(2),
    videoLookKey(),
  ].join("|");
}

/* The part of the clip key that is burned into the pixels: everything but
   the source and the range. It is the key's tail, so a stored key can be
   tested against the current settings with endsWith — which is how a
   reopened post tells whether its bucket copy carries the caption the row
   now asks for (see restoreStoredVideo). */
function videoLookKey() {
  return [
    state.videoMuted ? "muted" : "sound",
    (state.videoFocus?.x ?? 0.5).toFixed(3),
    (state.videoFocus?.y ?? 0.5).toFixed(3),
    // The caption's face is burned in too: tagging it means a clip encoded
    // in the old Poppins caption reads as stale and gets re-encoded in the
    // poster's Roboto Serif. Uncaptioned clips are unaffected. The date stamp
    // under the caption is burned in as well, so it is part of the tag.
    state.videoCaption
      ? `serif:${state.showTimestamp ? formatCreatedAt(state.createdAt) : "nodate"}:${state.videoCaption}`
      : "",
    state.videoCaptionSize,
    state.aspectRatio,
  ].join("|");
}

/* Put a stored video back on screen when a saved post is reopened. The
   <video> element takes the bucket URL directly — same element, same trim
   controls, same canvas preview as a local file. */
/* The video panel as a reviewer needs it: open and saying what is attached. */
function openVideoPanelForReview() {
  const acc = document.getElementById("video-acc");
  if (acc && acc.dataset.open !== "true") {
    acc.dataset.open = "true";
    acc.querySelector(":scope > .acc-head")?.setAttribute("aria-expanded", "true");
  }

  const name = state.videoFileName || "";
  if (videoFileLabel) {
    videoFileLabel.textContent = name || "Upload a replacement video";
  }

  // Existing URL-backed posts remain playable, but replacement is upload-only.
  const label = name || (state.videoSourceKind === "link" ? "a legacy linked video" : "an uploaded file");
  const length = state.trimEnd > state.trimStart
    ? ` · ${formatTimecode(state.trimEnd - state.trimStart)}`
    : "";
  setVideoStatus(`Video from ${label}${length}. Play it below, re-trim it, or replace it by uploading a file.`, "success");
}

function restoreStoredVideo(video) {
  const url = video?.storedUrl || "";
  if (!url || !videoPreviewEl) return;

  /* What the bucket copy was actually rendered with. The page entry has
     always carried it; design.video does from now on. */
  const renderedFor = video.storedFor || null;

  state.videoUrl = video.url || "";
  state.storedVideoUrl = url;
  state.clipSourceUrl = url;
  state.videoFile = null;
  state.videoSourceKind = video.sourceKind || "file";
  state.videoFileName = video.fileName || video.title || "";
  state.videoMuted = Boolean(video.muted);
  state.videoCaption = video.caption || "";
  state.videoCaptionSize = numberOr(video.captionSize, state.videoCaptionSize);
  state.videoFocus = {
    x: numberOr(video.focus?.x, 0.5),
    y: numberOr(video.focus?.y, 0.5),
  };

  videoPreviewEl.poster = "";
  videoPreviewEl.crossOrigin = "anonymous";
  videoPreviewEl.src = url;
  videoPreviewEl.addEventListener("loadedmetadata", () => {
    const duration = videoPreviewEl.duration || 0;
    setupTrimRange(duration);
    // The stored file is the already-cut clip, so its range is the whole
    // thing; the original start/end refer to timestamps it no longer has.
    if (video.storedTrimmed) {
      state.trimStart = 0;
      state.trimEnd = duration;
    } else {
      const start = numberOr(video.trimStart, 0);
      const end = numberOr(video.trimEnd, duration);
      if (end > start) {
        state.trimStart = start;
        state.trimEnd = end;
      }
    }
    // The bucket copy IS the current clip until somebody edits the trim,
    // caption or framing. Stamping its key here lets the publish path reuse
    // those bytes instead of re-encoding from state.videoUrl — which points at
    // the ORIGINAL source (a YouTube link or an expiring signed URL) and is
    // frequently gone, or needs yt-dlp all over again, by the time QA publishes.
    //
    // But only when that copy was rendered with the caption and framing the
    // row now holds. The row's caption is whatever was typed by the last
    // save; the copy is whatever the last SUCCESSFUL encode burned in, and a
    // save whose encode failed (or was still running while the caption was
    // typed) writes the first without the second. Stamping regardless told
    // publish the old file already had the new caption, so DailyMattr got the
    // clip with no title on it. A mismatch keeps the copy's real key, which
    // can never equal the current one, so publish and Save re-encode this
    // copy with the caption the preview is showing — and a save before that
    // re-encode succeeds still records the copy as stale, where null would
    // read as "no record" and be trusted on the next open. Rows with no
    // record at all keep the old trust, as before.
    const look = videoLookKey();
    const current = !renderedFor || renderedFor.endsWith(`|${look}`);
    state.storedVideoFor = current ? videoClipKey() : renderedFor;
    if (!current) {
      console.warn("[pix] stored clip predates its caption/framing; publish will re-encode it", {
        renderedFor, look,
      });
    }
    if (typeof syncTrimUI === "function") syncTrimUI();
    if (videoEditor) videoEditor.hidden = false;

    /* Hand the reviewer a working video panel, not a collapsed one.

       Everything needed to play, scrub, re-trim and replace the clip already
       existed — the <video> carries native controls, the trim sliders and the
       source tabs are right there — but the Video accordion restores CLOSED,
       the source tab always read "Paste Link" regardless of how the video was
       added, and the file row still said "Choose a video file". So a reviewer
       opening a post with a video was shown no player, no indication of what
       the writer had attached, and the wrong tab for replacing it.

       Opened only when the post actually has a clip, so it does not push
       itself in front of every ordinary post. */
    openVideoPanelForReview();

    /* Decode a frame before painting, or the card paints black.

       readyState 4 does NOT mean there is a frame to draw. A <video> that has
       just had its src set, has never played, and sits at currentTime 0 has
       nothing decoded yet — drawImage then draws nothing and the video card
       comes out solid black, while duration, readyState, currentSrc and the
       clip key are all perfectly correct. That is precisely what QA was
       looking at: the clip was stored, fetchable and loaded, and the slide
       showed a black rectangle, so the video appeared not to be there at all.

       A seek forces the decode. It has to be a seek to somewhere the element
       is NOT already sitting, because assigning currentTime the value it
       already holds fires no event and decodes nothing — which is why
       trimStart 0, the normal case for an already-trimmed stored clip, was the
       one that stayed black. `seeked` is the moment there is something to
       draw, so that is when it repaints. */
    videoPreviewEl.addEventListener("seeked", () => renderPoster(), { once: true });
    try {
      const start = numberOr(state.trimStart, 0);
      videoPreviewEl.currentTime = start > 0
        ? start
        : Math.min(0.05, (state.trimEnd || 1) / 2);
    } catch { /* the render below still runs; worst case is the old behaviour */ }

    renderPoster();
  }, { once: true });

  /* The other outcome, which had no listener at all. When the bucket object
     has been pruned, its signature has expired, or CORS blocks it,
     loadedmetadata never fires — so trimEnd stays 0, videoClipKey() stays
     null, and the clip is unavailable to the publish path from the moment the
     post is opened. That used to surface as a story going out without its
     video; it now surfaces as an abort at publish time, which is safe but
     still several minutes of QA's work too late. Say it here, while there is
     still time to re-add the clip. */
  videoPreviewEl.addEventListener("error", () => {
    /* One <video> element is shared by every page, so a listener left over
       from an earlier restore must not report on a clip that has since been
       swapped out — the message would name a problem the writer cannot see. */
    const loaded = videoPreviewEl.currentSrc || videoPreviewEl.getAttribute("src") || "";
    if (loaded !== url) return;
    setVideoStatus(
      "The stored clip could not be loaded — it may have been removed from storage. Re-add the video before publishing.",
      "error",
    );
    setStatus("Opened, but this post's stored video could not be loaded — re-add it before publishing.", "error");
  }, { once: true });
}

/* Session check starts here — last line of the module, so every const/let
   above is initialised before setAuthState can touch it. See the note beside
   the state object for why this is not at the top. */
initAuth();

// Edit Writer Dialog Logic
const editWriterDialog = document.getElementById("edit-writer-dialog");
const editWriterForm = document.getElementById("edit-writer-form");
const editWriterUsername = document.getElementById("edit-writer-username");
const editWriterDisplay = document.getElementById("edit-writer-display");
const editWriterRole = document.getElementById("edit-writer-role");
const editWriterError = document.getElementById("edit-writer-error");
const editWriterCancel = document.getElementById("edit-writer-cancel");

window.openEditWriterDialog = function(user) {
  if (!editWriterDialog) return;
  window.currentEditingWriter = user.username;
  editWriterUsername.value = user.username;
  editWriterDisplay.value = user.displayName || "";
  editWriterRole.value = user.role || "writer";
  editWriterError.hidden = true;
  editWriterDialog.showModal();
};

if (editWriterCancel) {
  editWriterCancel.addEventListener("click", () => editWriterDialog.close());
}

if (editWriterForm) {
  editWriterForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!window.currentEditingWriter) return;
    try {
      await usersRequest("/api/users/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldUsername: window.currentEditingWriter,
          username: editWriterUsername.value,
          displayName: editWriterDisplay.value,
          role: editWriterRole.value
        }),
      });
      editWriterDialog.close();
      setWritersStatus(`Updated ${editWriterUsername.value}.`, "success");
      loadWriters();
    } catch (err) {
      editWriterError.textContent = err.message;
      editWriterError.hidden = false;
    }
  });
}
