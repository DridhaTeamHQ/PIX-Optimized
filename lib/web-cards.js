/* ── The finished cards, copied to our bucket for the website ──
   At publish the browser sends the rendered cards (poster, text slides, up to
   five) and this server forwards them to DailyMattr, which stores them where
   nothing public can read them. dailymattr.com/news needs those same pictures,
   so they are copied to the public pix-media bucket at the same moment and the
   URLs recorded on the row (see recordWebPages in db.js).

   Kept apart from the publish handler so it can be exercised with a fake
   uploader: the handler's own tests would need DailyMattr and Storage both
   answering, and this is the part that is easy to get subtly wrong — order,
   which files count, what gets recorded. */

import { randomUUID } from "node:crypto";
import { uploadMedia } from "./storage.js";
import { imageSize } from "./image-size.js";

const EXTENSION = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/avif": ".avif", "image/gif": ".gif",
};

/* Only pictures. A video slide is forwarded to DailyMattr like any other part,
   but the website's carousel is cards, and a 40 MB clip in a public bucket is
   a bill, not a feature. */
export function isPictureCard(file) {
  return Boolean(file && file.buffer && file.buffer.length && /^image\//i.test(file.contentType || ""));
}

/* Object path inside the bucket. Built from the post id and the slot, never
   from the browser's filename — see storage.js on why a name arriving from a
   client must not steer a storage path. The random part means a republish
   writes new objects rather than overwriting ones a live page may be showing. */
export function webCardKey(pixId, page, contentType, id = randomUUID()) {
  const ext = EXTENSION[String(contentType || "").toLowerCase()] || "";
  return `web/${pixId}/${page}-${id}${ext}`;
}

/**
 * Upload every picture card and return what the website needs, poster first.
 *
 * All-or-nothing on purpose: a carousel with its text slide but no poster is
 * more confusing than no carousel, so if any upload fails the whole batch is
 * reported as failed and nothing is recorded (the site then shows the story's
 * background picture, as it did before any of this existed).
 */
export async function copyCardsToWeb({ pixId, files = [], upload = uploadMedia, size = imageSize } = {}) {
  if (!pixId) throw new Error("A saved post is required to copy its cards.");

  const cards = files.filter(isPictureCard).sort((a, b) => (a.page || 0) - (b.page || 0));
  if (!cards.length) return [];

  return Promise.all(cards.map(async (file, index) => {
    const slot = Number(file.page) || index + 1;
    const url = await upload(webCardKey(pixId, slot, file.contentType), file.buffer, file.contentType);
    const dims = size(file.buffer);
    return {
      url,
      sort_order: slot,
      bytes: file.buffer.length,
      type: file.contentType,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    };
  }));
}
