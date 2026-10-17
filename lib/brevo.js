/* ── Brevo transactional email ───────────────────────────────────────────────

   The daily report goes out through Brevo's transactional API, with the
   three values from the environment:

     BREVO_API_KEY        Brevo → SMTP & API → API keys
     BREVO_SENDER_EMAIL   must be a sender (or domain) verified in Brevo
     BREVO_SENDER_NAME    shown as the "From" name

   One API call per recipient, never one call with everyone on it: a single
   message to many people shows each of them the whole list. */

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

export function brevoConfig(values = {}) {
  const apiKey = String(values.BREVO_API_KEY || "").trim();
  const senderEmail = String(values.BREVO_SENDER_EMAIL || "").trim();
  const senderName = String(values.BREVO_SENDER_NAME || "").trim() || "PIX";
  const missing = [];
  if (!apiKey) missing.push("BREVO_API_KEY");
  if (!senderEmail) missing.push("BREVO_SENDER_EMAIL");
  return { ready: missing.length === 0, missing, apiKey, senderEmail, senderName };
}

/* Brevo's error body says what is wrong — an unverified sender, a blocked
   address, a bad key — so its message is passed on rather than a bare code. */
function brevoError(status, body) {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.message || parsed?.code || "";
  } catch {
    detail = String(body || "").slice(0, 200);
  }
  if (status === 401) return `Brevo rejected the API key (401). Check BREVO_API_KEY. ${detail}`.trim();
  if (status === 403) return `Brevo refused the send (403). ${detail}`.trim();
  if (status === 429) return "Brevo is rate-limiting this account. Try again shortly.";
  return `Brevo ${status}. ${detail}`.trim();
}

/**
 * Send one email.
 *
 *   to           { email, name? }
 *   attachments  [{ name, content: Buffer }]
 *
 * Resolves to Brevo's messageId; throws with Brevo's own reason on failure.
 */
export async function sendBrevoEmail(config, { to, subject, html, text, attachments = [] }, {
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!config?.ready) {
    throw new Error(`Email is not configured. Missing: ${(config?.missing || ["BREVO_API_KEY"]).join(", ")}.`);
  }
  const recipient = { email: to.email };
  if (to.name) recipient.name = to.name;

  const payload = {
    sender: { email: config.senderEmail, name: config.senderName },
    to: [recipient],
    subject,
    htmlContent: html,
  };
  if (text) payload.textContent = text;
  if (attachments.length) {
    payload.attachment = attachments.map((a) => ({
      name: a.name,
      content: Buffer.from(a.content).toString("base64"),
    }));
  }

  const res = await fetchImpl(BREVO_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": config.apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(brevoError(res.status, body));
  try {
    return JSON.parse(body)?.messageId || null;
  } catch {
    return null;
  }
}
