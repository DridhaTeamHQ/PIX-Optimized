import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { z } from "zod";

const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export class ScrapeValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ScrapeValidationError";
    this.status = status;
  }
}

export const ScrapeRequestSchema = z.strictObject({
  url: z.string({ error: "A URL is required." }).trim().min(1, "A URL is required.").max(MAX_URL_LENGTH, "The URL is too long.").url("Enter a valid URL."),
});

const publicNetworkAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true, verbatim: true })
        .then((addresses) => {
          const publicAddresses = addresses.filter(({ address }) => !isBlockedIp(address));
          if (!publicAddresses.length) {
            callback(new Error("Private or local network URLs cannot be scraped."));
            return;
          }
          if (options?.all) callback(null, publicAddresses);
          else callback(null, publicAddresses[0].address, publicAddresses[0].family);
        })
        .catch((error) => callback(error));
    },
  },
});

export const ScrapeArticleResultSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  image: z.string().url().nullable(),
  imageProxy: z.string().max(4096).nullable(),
  sourceUrl: z.string().url().max(MAX_URL_LENGTH),
  articleText: z.string().max(50_000),
  detailText: z.string().max(500),
  imageQuery: z.string().max(80),
});

export function parseScrapeRequest(body) {
  const parsed = ScrapeRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ScrapeValidationError(issue?.message || "Invalid scrape request.");
  }
  return parsed.data;
}

export function parseScrapeArticleResult(value) {
  const parsed = ScrapeArticleResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScrapeValidationError("The scraped page returned invalid article data.", 422);
  }
  return parsed.data;
}

export async function fetchPublicHtml(rawUrl, { userAgent, maxBytes = MAX_HTML_BYTES } = {}) {
  const { response, finalUrl } = await fetchPublicResponse(rawUrl, { userAgent, maxBytes });
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new ScrapeValidationError("The URL did not return an HTML page.", 415);
  }
  return { html: new TextDecoder().decode(await readBytesWithLimit(response, maxBytes)), finalUrl };
}

export async function fetchPublicImage(rawUrl, { userAgent, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const { response, finalUrl } = await fetchPublicResponse(rawUrl, {
    userAgent,
    maxBytes,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
  });
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new ScrapeValidationError("The URL did not return an image.", 415);
  }
  return {
    buffer: Buffer.from(await readBytesWithLimit(response, maxBytes)),
    contentType,
    finalUrl,
  };
}

async function fetchPublicResponse(rawUrl, { userAgent, maxBytes, accept = "text/html,application/xhtml+xml;q=0.9" }) {
  let currentUrl = await validatePublicUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response;
    try {
      response = await fetch(currentUrl, {
        dispatcher: publicNetworkAgent,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "user-agent": userAgent || "Pix article scraper",
          accept,
        },
      });
    } catch (error) {
      if (String(error?.cause?.message || error?.message || "").includes("Private or local network")) {
        throw new ScrapeValidationError("Private or local network URLs cannot be scraped.");
      }
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new ScrapeValidationError("The source took too long to respond.", 504);
      }
      throw new ScrapeValidationError("Could not connect to the source website.", 502);
    }

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount === MAX_REDIRECTS) {
        throw new ScrapeValidationError("The source redirected too many times.", 502);
      }
      const location = response.headers.get("location");
      if (!location) throw new ScrapeValidationError("The source returned an invalid redirect.", 502);
      currentUrl = await validatePublicUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) {
      throw new ScrapeValidationError(`Source returned ${response.status}.`, 502);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new ScrapeValidationError("The source page is too large to scrape.", 413);
    }

    return { response, finalUrl: currentUrl.toString() };
  }

  throw new ScrapeValidationError("The source could not be loaded.", 502);
}

async function validatePublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ScrapeValidationError("Enter a valid URL.");
  }

  if (!url || !["http:", "https:"].includes(url.protocol)) {
    throw new ScrapeValidationError("Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new ScrapeValidationError("URLs containing credentials are not supported.");
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new ScrapeValidationError("Only standard web ports are supported.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ScrapeValidationError("Private or local network URLs cannot be scraped.");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily && isBlockedIp(hostname)) {
    throw new ScrapeValidationError("Private or local network URLs cannot be scraped.");
  }

  if (!literalFamily) {
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new ScrapeValidationError("The source hostname could not be resolved.", 502);
    }
    if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
      throw new ScrapeValidationError("Private or local network URLs cannot be scraped.");
    }
  }

  url.hostname = hostname;
  return url;
}

function isBlockedIp(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return isBlockedIp(normalized.slice(7));

  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }

  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:");
  }
  return true;
}

async function readBytesWithLimit(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ScrapeValidationError("The source page is too large to scrape.", 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
