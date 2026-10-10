import { setCors, handlePreflight } from "../lib/http.js";
import { handlePixAnalyticsRequest } from "../lib/pix-analytics.js";
import { SESSION_COOKIE, parseCookies, sessionUser } from "../lib/auth.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  const cookies = parseCookies(req.headers?.cookie || "");
  const user = await sessionUser(cookies[SESSION_COOKIE]);
  const { status, body } = await handlePixAnalyticsRequest({ user });
  res.status(status).json(body);
}
