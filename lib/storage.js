/* ── Supabase Storage ──
   Where uploaded images and videos actually live. The database row keeps a
   URL; the bytes go in a bucket.

   Two values configure it, both from the Supabase dashboard:

     SUPABASE_URL               https://<project-ref>.supabase.co
     SUPABASE_SERVICE_ROLE_KEY  Settings → API Keys → service_role

   The service_role key bypasses row-level security, which is exactly why it
   must never reach the browser. Every upload goes through /api/media on this
   server, which checks the session first — the key stays server-side.

   No SDK: the Storage REST API is three fetch calls, and the alternative is a
   dependency an order of magnitude larger than the code it replaces. */

const BUCKET = "pix-media";

let baseUrl = "";
let serviceKey = "";
let bucketReady = null;

export function configureStorage({ url, serviceRoleKey } = {}) {
  baseUrl = clean(url).replace(/\/+$/, "");
  serviceKey = clean(serviceRoleKey);
  bucketReady = null;
  return isStorageConfigured();
}

function clean(value) {
  return String(value || "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}

export function isStorageConfigured() {
  return Boolean(baseUrl && serviceKey);
}

function headers(extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra,
  };
}

/* Created on first upload and then memoised. Public so the poster image can
   be loaded straight into a <canvas> — these are news posters headed for
   social media, not private documents, and a signed URL that expires would
   mean a saved post silently losing its image later. */
async function ensureBucket() {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const res = await fetch(`${baseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      // No file_size_limit: a bucket cannot ask for more than the project's
      // global upload limit, and requesting more fails the whole create with
      // a 413 that reads like the *bucket* was too large. Omitting it inherits
      // whatever the project allows, whatever plan it is on.
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    if (res.ok) return true;

    // Already there is success, not failure.
    const body = await res.clone().text().catch(() => "");
    if (res.status === 409 || /already exists|Duplicate/i.test(body)) return true;

    bucketReady = null;
    throw new Error(await storageError(res, `Could not create the ${BUCKET} bucket`));
  })();
  return bucketReady;
}

/**
 * Store one file and return its public URL.
 *
 * `key` is the object path inside the bucket. Callers build it from a random
 * id, never from the uploaded filename — a name arriving from a browser is
 * attacker-controlled and has no business steering a storage path.
 */
export async function uploadMedia(key, body, contentType = "application/octet-stream") {
  if (!isStorageConfigured()) throw new Error("Storage is not configured.");
  await ensureBucket();

  const res = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${key}`, {
    method: "POST",
    headers: headers({
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "x-upsert": "true",
    }),
    body,
  });

  if (!res.ok) {
    throw new Error(await storageError(res, "Upload failed"));
  }
  return publicUrl(key);
}

/* Supabase wraps the real reason in a JSON body; the HTTP status alone is
   often misleading (a bucket create refused for asking too high a file limit
   comes back as a 413 "Payload too large"). Pull the message out, and say
   what to do about the one that actually happens. */
async function storageError(res, prefix) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.message || body?.error || JSON.stringify(body);
    if (String(body?.statusCode) === "413" || body?.code === "EntityTooLarge") {
      /* Say what Supabase said, and do not guess at the plan. This used to
         assert "50 MB on the free plan" for every 413, which is wrong on a
         paid project — the limit there is whatever Settings → Storage is set
         to, and the default is 50 MB on every plan until someone raises it.
         Naming the wrong cause sends people to upgrade a plan they already
         have instead of changing the one setting that matters. */
      const said = String(detail || "").slice(0, 160);
      return `${prefix}: the file is over this project's Storage upload limit.` +
             ` Raise "Upload file size limit" in Supabase → Settings → Storage` +
             ` (the default is 50 MB on every plan; Pro allows far more).` +
             (said ? ` Supabase said: ${said}` : "");
    }
  } catch {
    detail = await res.text().catch(() => "");
  }
  return `${prefix} (${res.status}): ${String(detail).slice(0, 200)}`;
}

/**
 * Mint a one-shot URL the browser can upload straight to.
 *
 * This is the whole point of the direct pipeline: the bytes go from the
 * writer's machine to Storage without passing through this server. Previously
 * every clip was buffered whole in Node — a 45 MB video held in memory while
 * it was forwarded on — which cost the container's RAM, doubled the transfer
 * time, and gave the upload two chances to fail instead of one. The measured
 * symptom was an object landing in the bucket while the browser never learned
 * its URL.
 *
 * The signed URL is scoped to exactly one object path and expires on its own,
 * so it is safe in a browser in a way the service_role key never is.
 */
export async function createSignedUploadUrl(key) {
  if (!isStorageConfigured()) throw new Error("Storage is not configured.");
  await ensureBucket();

  const res = await fetch(`${baseUrl}/storage/v1/object/upload/sign/${BUCKET}/${key}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: "{}",
  });
  if (!res.ok) throw new Error(await storageError(res, "Could not prepare the upload"));

  const body = await res.json().catch(() => ({}));
  // Supabase answers with a path, not an absolute URL.
  const signed = String(body?.url || "");
  if (!signed) throw new Error("Storage returned no signed upload URL.");
  return {
    uploadUrl: `${baseUrl}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`,
    key,
  };
}

/**
 * Confirm an object really is in the bucket, and how big it is.
 *
 * The reference is only written to a post after this succeeds. That is the
 * difference between "we sent the bytes somewhere" and "this video is stored":
 * 27 clips in this bucket are orphans precisely because nothing ever checked.
 *
 * HEAD on the public URL rather than a bucket listing, because it proves the
 * exact thing the post needs — that this URL serves the file to a reader.
 */
export async function statMedia(key) {
  if (!isStorageConfigured()) throw new Error("Storage is not configured.");
  const url = publicUrl(key);
  const res = await fetch(url, { method: "HEAD" });
  if (!res.ok) {
    return { ok: false, url, bytes: 0, status: res.status };
  }
  const bytes = Number(res.headers.get("content-length") || 0);
  return { ok: true, url, bytes, contentType: res.headers.get("content-type") || "" };
}

/**
 * Remove one object from the bucket.
 *
 * There was no way to do this at all: the app could put bytes in Storage and
 * never take them out, so every abandoned take stayed for ever. Deleting is
 * irreversible and Storage keeps no undo, so the caller is expected to have
 * established that nothing references the key first — see handleMediaDelete,
 * which refuses on any post that still points at it.
 */
export async function deleteMedia(key) {
  if (!isStorageConfigured()) throw new Error("Storage is not configured.");

  const res = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${key}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) throw new Error(await storageError(res, "Delete failed"));
  return true;
}

export function publicUrl(key) {
  return `${baseUrl}/storage/v1/object/public/${BUCKET}/${key}`;
}

/** True when a URL points at our own bucket — used to skip re-uploading. */
export function isStoredMediaUrl(url) {
  return Boolean(baseUrl) && String(url || "").startsWith(`${baseUrl}/storage/v1/object/public/${BUCKET}/`);
}

/* Health probe: proves the key works, not merely that it is set. */
export async function pingStorage() {
  if (!isStorageConfigured()) return { configured: false, ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const res = await fetch(`${baseUrl}/storage/v1/bucket`, { headers: headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { configured: true, ok: false, error: `${res.status} ${text.slice(0, 120)}` };
    }
    const buckets = await res.json();
    return { configured: true, ok: true, buckets: buckets.map((b) => b.name) };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}
