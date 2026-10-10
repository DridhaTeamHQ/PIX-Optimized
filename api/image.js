// Image proxy — fetches a remote image and pipes the bytes back with the
// original Content-Type. Lets the client load images that would otherwise
// trigger CORS errors (e.g. when drawing onto a canvas).

import { USER_AGENT } from "../lib/http.js";
import { ScrapeValidationError, fetchPublicImage } from "../lib/scrape-security.js";

export const config = {
  api: { responseLimit: "10mb" },
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const target = (req.query?.url || "").toString();
    if (!target) {
      res.status(400).json({ error: "Image URL is required." });
      return;
    }

    const { buffer: buf, contentType } = await fetchPublicImage(target, { userAgent: USER_AGENT });

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(buf);
  } catch (err) {
    const status = err instanceof ScrapeValidationError ? err.status : 500;
    res.status(status).json({ error: err.message || "Image proxy failed." });
  }
}
