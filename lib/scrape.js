// HTML scraping helpers — used by api/scrape-article.js.
// Pure parsing utilities, with no network or filesystem I/O.

import { load } from "cheerio";

const IMAGE_META_SCORES = new Map([
  ["og:image:secure_url", 1120],
  ["og:image:url", 1100],
  ["og:image", 1080],
  ["twitter:image", 1010],
  ["twitter:image:src", 1000],
  ["image", 900],
]);

const BAD_IMAGE_HINT = /(?:^|[\W_])(logo|favicon|icon|sprite|avatar|author|profile|placeholder|default|blank|transparent|loading|pixel|tracking|badge)(?:[\W_]|$)/i;
const SIGNED_QUERY_KEYS = /^(?:signature|sig|token|auth|authorization|expires?|policy|key-pair-id|x-amz-|x-goog-|s$)/i;

/* Choose the article photograph rather than trusting the first og:image.

   News pages commonly expose several competing images: a publisher logo in
   JSON-LD, a tiny social thumbnail, lazy-loaded article images and a real
   hero in srcset. The old scraper read one meta tag and stopped, so whichever
   declaration happened to come first won. This gathers the useful standards
   and scores dimensions, article context and headline relevance while
   strongly demoting logos and placeholders. */
export function extractBestArticleImage(html, baseUrl, { title = "" } = {}) {
  let $;
  try {
    $ = load(String(html || ""));
  } catch {
    return null;
  }

  const candidates = new Map();
  const titleWords = new Set(
    cleanupText(title).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []
  );

  const add = (rawUrl, {
    baseScore = 0, width = 0, height = 0, alt = "", source = "unknown",
  } = {}) => {
    if (!rawUrl || typeof rawUrl !== "string") return;
    const resolved = resolveMaybeRelative(decodeHtmlEntities(rawUrl), baseUrl);
    if (!resolved || !/^https?:\/\//i.test(resolved)) return;
    if (/\.(?:svg)(?:$|[?#])/i.test(resolved)) return;

    const w = positiveNumber(width);
    const h = positiveNumber(height);
    const hint = `${resolved} ${alt}`.toLowerCase();
    let score = baseScore;

    if (BAD_IMAGE_HINT.test(hint)) score -= 1400;
    if (w && h) {
      const area = w * h;
      score += Math.min(260, Math.round(area / 12_000));
      if (w < 300 || h < 180) score -= 950;
      if (w >= 800 && h >= 450) score += 180;
      const ratio = w / h;
      if (ratio < 0.35 || ratio > 3.5) score -= 260;
    }

    if (titleWords.size) {
      const words = new Set(cleanupText(`${alt} ${resolved}`).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
      const overlap = [...titleWords].filter((word) => words.has(word)).length;
      score += Math.min(overlap, 4) * 45;
    }

    const key = normalizeImageUrl(resolved);
    const next = { url: resolved, score, width: w, height: h, source };
    const current = candidates.get(key);
    if (!current || next.score > current.score) candidates.set(key, next);
  };

  const metaDimensions = {
    width: $('meta[property="og:image:width"], meta[name="og:image:width"]').first().attr("content"),
    height: $('meta[property="og:image:height"], meta[name="og:image:height"]').first().attr("content"),
  };
  $("meta").each((_, element) => {
    const node = $(element);
    const name = String(node.attr("property") || node.attr("name") || "").trim().toLowerCase();
    const baseScore = IMAGE_META_SCORES.get(name);
    if (!baseScore) return;
    const dimensions = name.startsWith("og:image") ? metaDimensions : {};
    add(node.attr("content"), { baseScore, ...dimensions, source: name });
  });

  $('link[rel="image_src"], link[rel="preload"][as="image"]').each((_, element) => {
    const node = $(element);
    add(node.attr("href") || largestSrcsetCandidate(node.attr("imagesrcset")), {
      baseScore: 880,
      source: "link",
    });
  });

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      collectJsonLdImages(JSON.parse(raw), add);
    } catch {
      // Malformed structured data must not prevent ordinary metadata scraping.
    }
  });

  const collectElement = (element, baseScore, source) => {
    const node = $(element);
    const alt = node.attr("alt") || node.attr("title") || "";
    const details = {
      baseScore,
      width: node.attr("width"),
      height: node.attr("height"),
      alt,
      source,
    };
    add(largestSrcsetCandidate(node.attr("srcset") || node.attr("data-srcset")), details);
    for (const attribute of ["data-original", "data-lazy-src", "data-src", "src"]) {
      add(node.attr(attribute), details);
    }
  };

  $("article img, article source").each((_, element) => collectElement(element, 820, "article"));
  $("main img, main source").each((_, element) => collectElement(element, 700, "main"));
  $('img[itemprop="image"], [class*="story"] img, [class*="article"] img').each((_, element) => {
    collectElement(element, 760, "story");
  });
  $("body img, body source").each((_, element) => collectElement(element, 280, "body"));

  const best = [...candidates.values()]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  return best?.url || null;
}

function collectJsonLdImages(value, add, path = []) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectJsonLdImages(entry, add, path));
    return;
  }
  if (typeof value !== "object") return;

  const type = String(value["@type"] || "").toLowerCase();
  if (type === "imageobject") {
    const url = value.contentUrl || value.url || value.thumbnailUrl;
    addImageValue(url, add, {
      baseScore: 920,
      width: value.width,
      height: value.height,
      alt: value.caption || value.name || "",
      source: "json-ld-image",
    });
  }

  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    // Publisher/organisation logos are the most common wrong scrape.
    if (lower === "logo") continue;
    if (lower === "image") {
      addImageValue(child, add, { baseScore: 940, source: "json-ld-image" });
    } else if (lower === "thumbnailurl") {
      addImageValue(child, add, { baseScore: 790, source: "json-ld-thumbnail" });
    }
    if (typeof child === "object") collectJsonLdImages(child, add, [...path, lower]);
  }
}

function addImageValue(value, add, details) {
  if (typeof value === "string") {
    add(value, details);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => addImageValue(entry, add, details));
    return;
  }
  if (!value || typeof value !== "object") return;
  add(value.contentUrl || value.url || value.thumbnailUrl, {
    ...details,
    width: value.width || details.width,
    height: value.height || details.height,
    alt: value.caption || value.name || details.alt,
  });
}

function largestSrcsetCandidate(value) {
  if (!value) return null;
  return String(value).split(",")
    .map((part, index) => {
      const bits = part.trim().split(/\s+/);
      const descriptor = bits[1] || "";
      const rank = descriptor.endsWith("w")
        ? Number(descriptor.slice(0, -1))
        : descriptor.endsWith("x")
          ? Number(descriptor.slice(0, -1)) * 1000
          : index;
      return { url: bits[0], rank: Number.isFinite(rank) ? rank : index };
    })
    .filter((entry) => entry.url && !entry.url.startsWith("data:"))
    .sort((a, b) => b.rank - a.rank)[0]?.url || null;
}

function positiveNumber(value) {
  if (value && typeof value === "object" && "value" in value) value = value.value;
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeImageUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function extractMetaContent(html, names) {
  for (const name of names) {
    const propertyRegex = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    );
    const contentFirstRegex = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeForRegex(name)}["'][^>]*>`,
      "i"
    );
    const match = html.match(propertyRegex) || html.match(contentFirstRegex);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return null;
}

export function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function cleanupText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

export function decodeHtmlEntities(value) {
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

export function resolveMaybeRelative(value, baseUrl) {
  try { return new URL(value.trim(), baseUrl).toString(); }
  catch { return null; }
}

export function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip CDN size params to upgrade an image URL to its highest available quality.
export function upgradeImageToHighestQuality(imageUrl) {
  try {
    const u = new URL(imageUrl);
    const host = u.hostname.toLowerCase();

    // Changing any query parameter invalidates signed CDN URLs.
    if ([...u.searchParams.keys()].some((key) => SIGNED_QUERY_KEYS.test(key))) {
      return u.toString();
    }

    if (host.includes("cloudinary.com")) {
      u.pathname = u.pathname.replace(/\/upload\/[^/]+\//, "/upload/q_auto:best,f_auto/");
      return u.toString();
    }
    if (host.includes("imgix.net") || u.searchParams.has("ixid")) {
      ["w", "h", "fit", "crop", "q", "auto"].forEach(p => u.searchParams.delete(p));
      u.searchParams.set("q", "100");
      u.searchParams.set("auto", "format,compress");
      return u.toString();
    }
    const wordpressCdn = /(?:^|\.)(?:wordpress\.com|wp\.com)$/.test(host) || /^i\d\.wp\.com$/.test(host);
    if (wordpressCdn || u.searchParams.has("resize")) {
      ["resize", "w", "h", "fit", "strip", "quality"].forEach(p => u.searchParams.delete(p));
      return u.toString();
    }

    // TOI encodes resize, watermark and padding instructions in one path
    // segment. Keep the asset id and verified resize syntax, but remove the
    // social-card overlay/padding and request a larger copy at the same ratio.
    if (host.endsWith("toiimg.com") && u.pathname.includes("/thumb/msid-")) {
      const parts = u.pathname.split("/");
      const thumbIndex = parts.indexOf("thumb");
      const transformIndex = thumbIndex + 1;
      if (thumbIndex >= 0 && parts[transformIndex]) {
        let transforms = parts[transformIndex].split(",")
          .filter((part) => !/^(?:overlay-|pt-|[xy]_pad-)/i.test(part));
        const widthIndex = transforms.findIndex((part) => /^width-\d+$/i.test(part));
        const heightIndex = transforms.findIndex((part) => /^height-\d+$/i.test(part));
        if (widthIndex >= 0 && heightIndex >= 0) {
          const width = positiveNumber(transforms[widthIndex].split("-")[1]);
          const height = positiveNumber(transforms[heightIndex].split("-")[1]);
          const scale = width && height ? Math.max(1, 1600 / Math.max(width, height)) : 1;
          transforms[widthIndex] = `width-${Math.round(width * scale)}`;
          transforms[heightIndex] = `height-${Math.round(height * scale)}`;
        }
        parts[transformIndex] = transforms.join(",");
        u.pathname = parts.join("/");
      }
      return u.toString();
    }

    if (host.includes("bbci.co.uk") || u.pathname.includes("/ichef/")) {
      u.pathname = u.pathname.replace(/\/\d+\//, "/1280/");
      return u.toString();
    }

    // Unknown CDNs are deliberately untouched. Their resize parameters can
    // be part of a signature or route contract, and deleting them was turning
    // a valid thumbnail into a 404 more often than it found an original.
    return u.toString();
  } catch {
    return imageUrl;
  }
}
