/* ── Voice summary ──
   DailyMattr is adding a voice AI agent that answers listeners' questions
   about a story. Letting it read the whole source article on every question
   is what makes that agent expensive, so each pix carries a predefined
   summary instead: a glimpse of the story, like a trailer, written once at
   build time and short enough to put in a prompt.

   Grounded strictly in the scraped article text. A summary written from the
   headline alone would be the agent confidently inventing facts out loud, so
   without source text this refuses rather than guessing. */

/* A glimpse, not a write-up: under 60 words. The prompt asks for it;
   trimToLength() enforces it, because models routinely run long when the
   source is rich. */
export const VOICE_SUMMARY_MAX_WORDS = 60;
// Enough of a long article to cover it; the model sees nothing past this.
const SOURCE_MAX_CHARS = 16000;
// Below this the "article" is a teaser or a paywall stub, not a source.
const SOURCE_MIN_CHARS = 200;

export const VOICE_SUMMARY_SYSTEM_PROMPT = [
  "You write a short spoken glimpse of ONE news story, like a trailer, for a voice AI news assistant. The assistant will NOT see the original article — only what you write — so it must be clear and self-contained.",
  "",
  "Return STRICT JSON: { \"summary\": string, \"flags\": [string] }",
  "",
  "LENGTH — the hard rule: 2 to 4 short sentences, UNDER 60 words in total, one paragraph.",
  "",
  "CONTENT — a trailer of the story, only what the source supports:",
  "- Open with the core of what happened: who (with their role) and what.",
  "- Add the one or two details that matter most: where or when, the key number, or the main reaction.",
  "- Leave everything else out. Never fill a gap.",
  "",
  "STYLE — it will be spoken aloud:",
  "- Complete sentences. No bullets, headings, markdown, emojis, URLs or hashtags.",
  "- Clear, neutral, British English. Engaging but never sensational or clickbait. No jargon.",
  "- Write abbreviations the way they should be heard on first use (e.g. 'the Reserve Bank of India, the RBI').",
  "",
  "RULES:",
  "- Use ONLY the provided article text. No outside knowledge, no speculation, no invented figures or quotes.",
  "- Political or contested stories: give each side's position as the source does, without taking one.",
  "- Deaths, suicide and tragedy: neutral and factual, no method details, nothing sensational.",
  "- flags: short notes for the editor when the source is thin, contradicts itself, or reads as old or unverified. Empty array when there is nothing to raise.",
  "",
  "Output ONLY the JSON object.",
].join("\n");

/* Bullet glyphs and markdown would be read aloud literally ("asterisk"), so
   strip them even though the prompt forbids them. */
function cleanSpoken(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_#`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* Keep whole sentences within the word cap — never cut one mid-way, since
   the agent reads this aloud. The first sentence is always kept, so a model
   that wrote one long sentence still yields something. Decimal points (6.5,
   Rs 1.2) are masked so they are not taken for sentence ends. */
const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;

function trimToLength(text) {
  const MASK = String.fromCharCode(0xE000);
  const masked = text.replace(/(\d)\.(\d)/g, `$1${MASK}$2`);
  const sentences = masked.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [masked];
  let out = "";
  for (const sentence of sentences) {
    if (out && wordCount(out + sentence) > VOICE_SUMMARY_MAX_WORDS) break;
    out += sentence;
  }
  return out.split(MASK).join(".").trim();
}

/**
 * @param {object} args
 * @param {string} args.headline
 * @param {string} args.articleText  the scraped article body
 * @param {string} args.apiKey       OpenAI key
 * @param {Function} [args.fetchImpl] fetch-compatible function (lets the
 *   server pass its deadline-bound fetch)
 * @returns {Promise<{ status: number, body: object, usage?: object }>}
 *   Never throws for an expected failure; the status is what to answer.
 */
export async function generateVoiceSummary({ headline = "", articleText = "", apiKey = "", fetchImpl = fetch }) {
  if (!apiKey) return { status: 503, body: { error: "OPENAI_API_KEY not set on server." } };

  const source = String(articleText || "").replace(/\s+\n/g, "\n").trim().slice(0, SOURCE_MAX_CHARS);
  if (source.length < SOURCE_MIN_CHARS) {
    return {
      status: 422,
      body: { error: "Not enough source text to summarise. Scrape the article link first, or paste the article text." },
    };
  }

  const aiRes = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: VOICE_SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: `Headline:\n${String(headline || "").trim() || "(none)"}\n\nArticle text:\n${source}` },
      ],
      temperature: 0.3,
      max_tokens: 250,
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text().catch(() => "");
    return { status: 502, body: { error: `OpenAI ${aiRes.status}`, detail: errText.slice(0, 200) }, openaiStatus: aiRes.status, openaiBody: errText };
  }

  const data = await aiRes.json();
  let parsed = {};
  try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { /* below */ }

  const summary = trimToLength(cleanSpoken(parsed.summary));
  if (!summary) return { status: 502, body: { error: "AI returned an empty summary." }, usage: data };

  return {
    status: 200,
    usage: data,
    body: {
      summary,
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String).filter(Boolean) : [],
      sourceChars: source.length,
      words: summary.split(/\s+/).filter(Boolean).length,
    },
  };
}
