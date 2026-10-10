import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { load } from "cheerio";

const $ = load(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"));
const card = $('.preview-card[data-preview-mode="x"]');
const link = card.find("a.preview-card-x-link");
let passed = 0;
let failed = 0;

async function check(name, test) {
  try {
    await test();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

await check("one redirect, only inside the X preview", () => {
  assert.equal(link.length, 1);
  assert.equal($(".preview-card-x-link").length, 1);
});
await check("redirect follows the X download beneath the canvas", () => {
  const download = link.prev();
  assert.equal(download.attr("data-download"), "x");
  assert.equal(download.prev().find("#x-canvas").length, 1);
});
await check("redirect opens the X composer", () => {
  assert.equal(link.attr("href"), "https://x.com/intent/tweet");
});
await check("new tab is isolated from Pix", () => {
  assert.equal(link.attr("target"), "_blank");
  const rel = link.attr("rel").split(/\s+/);
  assert.ok(rel.includes("noopener"));
  assert.ok(rel.includes("noreferrer"));
});
await check("accessible label describes the new tab and image fallback", () => {
  assert.equal(link.text().trim(), "Open X");
  assert.match(link.attr("aria-label"), /X composer.*new tab/);
  assert.match(link.attr("title"), /attach the downloaded Pix/);
  assert.equal(link.attr("aria-describedby"), "x-share-hint");
  assert.match($("#x-share-hint").text(), /hashtags and the follow line.*Copy and paste.*or attach/);
});
await check("download remains separate from redirect and copy", () => {
  assert.equal(card.find('button[data-download="x"]').length, 1);
  assert.equal(link.attr("data-download"), undefined);
  assert.equal(link.attr("download"), undefined);
  assert.equal(card.find('button#x-copy-image-btn[type="button"]').length, 1);
  assert.equal(card.find("#x-copy-image-btn").attr("data-download"), undefined);
});

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing app section: ${start}`);
  return app.slice(from, to);
}

function harness() {
  const handlers = new Map();
  const state = {
    headline: "Other page headline", article: null, previewMode: "story",
    isDownloading: false, useShortlyLogo: false, forceTextExport: true, keywords: "",
  };
  const base = { headline: "[Base] poster" };
  const h = {
    state, base, activePageId: "story", X_EXPORT_SCALE: 2,
    pending: [], renders: [], downloads: [], statuses: [], writes: [],
    handlers, xComposerLink: { href: "", addEventListener: (event, fn) => handlers.set(event, fn) },
    xCopyImageBtn: { disabled: false, addEventListener: (event, fn) => { h.copyClick = fn; } },
    xDownloadBtn: { disabled: false }, downloadButton: { disabled: false },
    console: { error() {} },
    HIGHLIGHT_ANY_CHARS_GLOBAL: /[\[\](){}]/g,
    X_POST_LIMIT: 280,
    X_FOLLOW_LINE: "Follow @dailymattr for more such news.",
    basePageView: () => ({ ...state, ...base }),
    syncActivePageContent() {},
    setActivePage(id) {
      h.activePageId = id;
      state.headline = id === "base" ? base.headline : "Other page headline";
    },
    renderPoster() {},
    renderToHighResCanvas(scale) {
      if (h.renderError) throw new Error("Render failed");
      h.renders.push({ scale, page: h.activePageId, ...state });
      return { exported: true };
    },
    exportCanvasCroppedToContent(canvas, options) {
      h.crop = { canvas, ...options };
      return { toBlob: (callback, type) => h.pending.push({ callback, type }) };
    },
    setPostStatus: (message, kind) => h.statuses.push({ message, kind }),
    slugify: () => "base-poster",
    setTimeout: (fn) => fn(),
    URL: class extends URL {
      static createObjectURL(blob) { h.downloadBlob = blob; return "blob:test"; }
      static revokeObjectURL(url) { h.revoked = url; }
    },
    document: { createElement: () => {
      const anchor = { click: () => h.downloads.push(anchor) };
      return anchor;
    } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    navigator: { clipboard: { write: async (items) => {
      h.writes.push(items);
      h.copiedBlob = await items[0].data["image/png"];
    } } },
  };
  const context = createContext(h);
  runInContext(section("function cleanHeadlineForPublish(", "function inferDailyMattrKeywords("), context);
  runInContext(section("function renderXPreviewCanvas(", "if (xDownloadBtn)"), context);
  runInContext(section("function xHashtags(", "function setPostStatus("), context);
  return h;
}

await check("prefills Text for X and the requested follow line", () => {
  const h = harness();
  h.state.article = { tweet: "  News (explained) & updates\n#India + 50% https://example.com/?a=1&b=2  " };
  h.syncXComposerLink();
  const url = new URL(h.xComposerLink.href);
  assert.equal(url.origin + url.pathname, "https://x.com/intent/tweet");
  assert.equal(url.searchParams.get("text"), `${h.state.article.tweet.trim()}\n\n${h.X_FOLLOW_LINE}`);
  assert.equal(url.searchParams.get("hashtags"), "DailyMattr,News");
  assert.equal([...url.searchParams].length, 2);
});
await check("preserves non-Latin text and emoji", () => {
  const h = harness();
  const tweet = "\u092D\u093E\u0930\u0924 \uD83C\uDDEE\uD83C\uDDF3 news";
  h.state.article = { tweet };
  h.syncXComposerLink();
  assert.equal(new URL(h.xComposerLink.href).searchParams.get("text"), `${tweet}\n\n${h.X_FOLLOW_LINE}`);
});
await check("adds clean keyword hashtags plus DailyMattr and News", () => {
  const h = harness();
  h.state.keywords = "Indian politics, #Election 2026, dailymattr, ignored";
  h.syncXComposerLink();
  assert.equal(new URL(h.xComposerLink.href).searchParams.get("hashtags"), "DailyMattr,Indianpolitics,Election2026,News");
});
await check("hashtags are deduplicated case-insensitively and length-limited", () => {
  const h = harness();
  h.state.keywords = `dailymattr, DAILYMATTR, ${"a".repeat(60)}, NEWS`;
  h.syncXComposerLink();
  const tags = new URL(h.xComposerLink.href).searchParams.get("hashtags").split(",");
  assert.deepEqual(tags, ["DailyMattr", "a".repeat(40), "NEWS"]);
});
await check("long captions preserve the follow line and fit X's 280-character limit", () => {
  const h = harness();
  h.state.article = { tweet: `Major update ${"important details ".repeat(30)}\uD83C\uDDEE\uD83C\uDDF3` };
  h.state.keywords = "India, Politics";
  h.syncXComposerLink();
  const url = new URL(h.xComposerLink.href);
  const text = url.searchParams.get("text");
  const tags = url.searchParams.get("hashtags").split(",");
  const renderedLength = Array.from(text).length + tags.reduce((sum, tag) => sum + Array.from(tag).length + 2, 0);
  assert.ok(renderedLength <= 280, `rendered length was ${renderedLength}`);
  assert.match(text, /…\n\nFollow @dailymattr for more such news\.$/u);
  assert.equal(text.includes("\uFFFD"), false);
});
await check("falls back to the base headline, never the selected extra page", () => {
  const h = harness();
  for (const article of [null, { tweet: "  " }, { tweet: {} }]) {
    h.state.article = article;
    h.syncXComposerLink();
    assert.equal(new URL(h.xComposerLink.href).searchParams.get("text"), `Base poster\n\n${h.X_FOLLOW_LINE}`);
    assert.equal(h.activePageId, "story");
  }
});
await check("latest text is read for click, middle-click, keyboard focus and context menu", () => {
  const h = harness();
  for (const event of ["click", "auxclick", "contextmenu", "focus"]) {
    h.state.article = { tweet: `New caption for ${event}` };
    h.handlers.get(event)();
    assert.equal(new URL(h.xComposerLink.href).searchParams.get("text"), `${h.state.article.tweet}\n\n${h.X_FOLLOW_LINE}`);
  }
});
await check("clearing the post removes previous text from the link", () => {
  const h = harness();
  h.syncXComposerLink();
  h.base.headline = "";
  h.state.article = null;
  h.syncXComposerLink();
  assert.equal(h.xComposerLink.href, "https://x.com/intent/tweet");
});
await check("PNG encoding uses the pinned X poster and restores selection synchronously", async () => {
  const h = harness();
  const before = { ...h.state };
  const promise = h.createXPreviewBlob();
  assert.equal(h.renders[0].page, "base");
  assert.equal(h.renders[0].headline, "[Base] poster");
  assert.equal(h.renders[0].previewMode, "x");
  assert.equal(h.renders[0].useShortlyLogo, true);
  assert.equal(h.renders[0].forceTextExport, false);
  assert.equal(h.renders[0].isDownloading, true);
  assert.equal(h.renders[0].scale, 2);
  assert.equal(h.crop.paddingBelow, 72);
  assert.equal(h.crop.minHeight, 2200);
  assert.equal(h.activePageId, "story");
  assert.deepEqual(h.state, before);
  assert.equal(h.pending[0].type, "image/png");
  const blob = { type: "image/png" };
  h.pending[0].callback(blob);
  assert.equal(await promise, blob);
});
await check("copy writes the PNG promise during the click, not after encoding", async () => {
  const h = harness();
  const promise = h.copyClick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.xCopyImageBtn.disabled, true);
  assert.equal(h.activePageId, "story");
  const blob = { type: "image/png" };
  h.pending[0].callback(blob);
  await promise;
  assert.equal(h.copiedBlob, blob);
  assert.equal(h.xCopyImageBtn.disabled, false);
  assert.equal(h.statuses.at(-1).kind, "success");
  assert.match(h.statuses.at(-1).message, /paste/);
  assert.equal(h.downloads.length, 0);
});
await check("clipboard denial leaves a working download fallback", async () => {
  const h = harness();
  h.navigator.clipboard.write = async () => { throw new Error("Permission denied"); };
  await h.copyXPreviewImage();
  h.pending[0].callback(null);
  await Promise.resolve();
  assert.equal(h.xCopyImageBtn.disabled, false);
  assert.match(h.statuses.at(-1).message, /Download the Pix and attach/);
  assert.equal(h.activePageId, "story");
});
await check("unsupported clipboard does not render or break the redirect", async () => {
  const h = harness();
  h.navigator.clipboard = undefined;
  await h.copyXPreviewImage();
  assert.equal(h.renders.length, 0);
  assert.match(h.statuses.at(-1).message, /isn't supported/);
  h.handlers.get("click")();
  assert.equal(new URL(h.xComposerLink.href).searchParams.get("text"), `Base poster\n\n${h.X_FOLLOW_LINE}`);
});
await check("blank poster does not copy or download", async () => {
  const h = harness();
  h.base.headline = "";
  await h.copyXPreviewImage();
  await h.downloadXPreview();
  assert.equal(h.renders.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.downloads.length, 0);
  assert.match(h.statuses.at(-1).message, /Build a poster first/);
});
await check("failed render restores original flags and re-enables both actions", async () => {
  const h = harness();
  h.state.isDownloading = true;
  h.state.useShortlyLogo = true;
  const before = { ...h.state };
  h.renderError = true;
  await h.downloadXPreview();
  await h.copyXPreviewImage();
  assert.deepEqual(h.state, before);
  assert.equal(h.activePageId, "story");
  assert.equal(h.xCopyImageBtn.disabled, false);
  assert.equal(h.xDownloadBtn.disabled, false);
  assert.equal(h.statuses.at(-1).kind, "error");
});
await check("null PNG reports copy failure without leaving a disabled button", async () => {
  const h = harness();
  const promise = h.copyXPreviewImage();
  h.pending[0].callback(null);
  await promise;
  assert.equal(h.xCopyImageBtn.disabled, false);
  assert.equal(h.statuses.at(-1).kind, "error");
});
await check("download uses shared PNG and never overwrites a later page selection", async () => {
  const h = harness();
  const promise = h.downloadXPreview({ usePrimaryButton: true });
  assert.equal(h.downloadButton.disabled, true);
  h.activePageId = "page-3";
  h.state.headline = "Later edit";
  const blob = { type: "image/png" };
  h.pending[0].callback(blob);
  await promise;
  assert.equal(h.activePageId, "page-3");
  assert.equal(h.state.headline, "Later edit");
  assert.equal(h.downloadBlob, blob);
  assert.equal(h.downloads[0].download, "base-poster-x.png");
  assert.equal(h.revoked, "blob:test");
  assert.equal(h.downloadButton.disabled, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
