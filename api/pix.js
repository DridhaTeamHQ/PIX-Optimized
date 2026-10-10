import { setCors, handlePreflight } from "../lib/http.js";
import { handlePixRequest } from "../lib/pix-api.js";

/* Saved pix library.
     POST   /api/pix           create or update (send `id` to update)
     GET    /api/pix           list
     GET    /api/pix?id=…      one row, everything in it
     DELETE /api/pix?id=…      remove

   All the logic lives in lib/pix-api.js; this file is only the serverless
   adapter. Serverless platforms should point SUPABASE_DIRECT_CONNECTION_URL at
   the Transaction pooler string — a direct connection per invocation exhausts
   Postgres connections fast. */
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  const query = req.query && Object.keys(req.query).length
    ? req.query
    : Object.fromEntries(new URL(req.url || "/", "http://localhost").searchParams);

  const body = typeof req.body === "string"
    ? safeParse(req.body)
    : (req.body || {});

  const { status, body: payload } = await handlePixRequest({ method: req.method, query, body });
  res.status(status).json(payload);
}

function safeParse(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
