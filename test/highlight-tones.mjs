/* ── Two highlight colours, chosen by which bracket you type ─────────────────

   Run: node test/highlight-tones.mjs

   [square] and (round) paint a run in `accent`; {curly} paints it in
   `accentAlt`. Round stays with square on purpose: the three pairs were exact
   synonyms before this change, so every headline already written with (parens)
   has to keep the colour it already has. Silently recolouring published work
   is not a feature, and it is the one regression this file exists to catch.

   What is pinned here:

     the mapping          which bracket means which colour, read from the
                          source rather than restated, so the test cannot
                          disagree with the file
     round == square      the compatibility promise above
     tone, not hex        a run carries the STATE KEY. Carrying a colour would
                          freeze it into saved designs, so changing a picker
                          would stop repainting old posts
     unmarked is plain    no brackets means no highlight — this was once "no
                          brackets means highlight everything", which turned
                          every unmarked headline accent-blue
     mismatched pairs     "[word}" has to resolve to something rather than
                          throw, because a writer mid-keystroke produces one  */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const app = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"),
  "utf8",
);

/* The sibling tests count braces to find the end of a function. That cannot
   work here: highlightToneFor contains the literal /[[({]/, whose `{` sits
   inside a character class with no partner, so a counter walks off the end of
   the file. These are top-level declarations, so the closing brace is the
   first `}` at column 0 — which is both simpler and not fooled by anything
   inside a regex or a string. */
function fnSrc(name) {
  const a = app.indexOf("function " + name);
  if (a < 0) throw new Error("missing function " + name);
  const end = app.indexOf("\n}", a);
  if (end < 0) throw new Error("no top-level close for " + name);
  return app.slice(a, end + 2);
}

// Read from the source. A hard-coded copy here would only prove the file was
// edited twice.
const TONES = new Function(
  "return " + app.match(/^const HIGHLIGHT_TONES = (\{[^}]+\});/m)[1],
)();
const OPEN_CHAR = new Function(
  "return " + app.match(/^const HIGHLIGHT_OPEN_CHAR\s+= (.+?);/m)[1],
)();
const CLOSE_CHAR = new Function(
  "return " + app.match(/^const HIGHLIGHT_CLOSE_CHAR = (.+?);/m)[1],
)();
const STRIP = () => new Function(
  "return " + app.match(/^const HIGHLIGHT_ANY_CHARS_GLOBAL = (.+?);/m)[1],
)();

const DEFAULTS = {
  accent: app.match(/^\s+accent: "(#[0-9A-Fa-f]{6})",/m)[1],
  accentAlt: app.match(/^\s+accentAlt: "(#[0-9A-Fa-f]{6})",/m)[1],
};

// The two helpers, with a `state` they can close over.
const state = { ...DEFAULTS };
const api = new Function("state", "HIGHLIGHT_TONES", `
  ${fnSrc("highlightToneFor")}
  ${fnSrc("highlightColor")}
  return { highlightToneFor, highlightColor };
`)(state, TONES);

let pass = 0, fail = 0;
const ck = (n, c, d = "") => {
  if (c) { pass++; console.log("  PASS " + n); }
  else { fail++; console.log("  FAIL " + n + " :: " + d); }
};

console.log("\nThe mapping is the one the source declares");
{
  ck("curly braces take the second colour", TONES["{"] === "accentAlt", TONES["{"]);
  ck("square brackets take the first", TONES["["] === "accent", TONES["["]);
  ck("round parens take the first, as they always did", TONES["("] === "accent",
     `(parens) resolved to ${TONES["("]} — every headline already using them just changed colour`);
  ck("the alt default is the colour that was asked for",
     DEFAULTS.accentAlt.toUpperCase() === "#7A1726", DEFAULTS.accentAlt);
}

console.log("\nA word opens the tone of its own bracket");
{
  for (const [word, want] of [
    ["[Modi]", "accent"],
    ["(Modi)", "accent"],
    ["{Modi}", "accentAlt"],
    ["[Modi", "accent"],
    ["{Modi", "accentAlt"],
    ["Modi", null],
    ["", null],
  ]) {
    const got = api.highlightToneFor(word);
    ck(`"${word}" -> ${want}`, got === want, String(got));
  }

  ck("a null word does not throw", api.highlightToneFor(null) === null);
  ck("a mismatched pair still resolves, first bracket winning",
     api.highlightToneFor("[word}") === "accent", api.highlightToneFor("[word}"));
  ck("...and the other way round", api.highlightToneFor("{word]") === "accentAlt");
}

console.log("\nA tone resolves to a colour, and resolves LATE");
{
  ck("accent", api.highlightColor("accent") === DEFAULTS.accent);
  ck("accentAlt", api.highlightColor("accentAlt") === DEFAULTS.accentAlt);
  ck("an absent tone falls back to the accent, as every run did before",
     api.highlightColor(null) === DEFAULTS.accent);
  ck("so does an unknown one", api.highlightColor("nonsense") === DEFAULTS.accent);

  /* The reason a run stores a KEY and not a hex: change the picker and every
     already-parsed run repaints. Storing the colour would freeze it into the
     saved design, and reopening an old post would ignore the picker. */
  state.accentAlt = "#00FF00";
  ck("moving the picker repaints an already-resolved tone",
     api.highlightColor("accentAlt") === "#00FF00", api.highlightColor("accentAlt"));
  state.accentAlt = DEFAULTS.accentAlt;
}

console.log("\nRunning the parser the renderers run");
{
  /* The exact loop from the headline renderer, which is the shape all four
     render paths share: open on an opening bracket, close on a closing one,
     and carry the tone on the word. */
  const parse = (text) => {
    const words = [];
    let openTone = null;
    text.split(" ").forEach((rawWord) => {
      const opening = OPEN_CHAR.test(rawWord);
      const closing = CLOSE_CHAR.test(rawWord);
      if (opening) openTone = api.highlightToneFor(rawWord);
      const clean = rawWord.replace(STRIP(), "");
      if (clean.length) words.push({ text: clean, marked: Boolean(openTone), tone: openTone });
      if (closing) openTone = null;
    });
    return words;
  };

  const plain = parse("No brackets here at all");
  ck("an unmarked headline is entirely plain", plain.every((w) => !w.marked),
     "this was once 'no brackets means highlight everything'");

  const one = parse("PM [Modi] speaks");
  ck("one square run is marked accent",
     one.map((w) => w.tone).join(",") === ",accent,",
     one.map((w) => `${w.text}:${w.tone}`).join(" "));

  const two = parse("PM {Modi} meets [Biden] today");
  ck("two runs on one line keep their own colours",
     two.find((w) => w.text === "Modi").tone === "accentAlt" &&
     two.find((w) => w.text === "Biden").tone === "accent",
     two.map((w) => `${w.text}:${w.tone}`).join(" "));
  ck("and the words around them stay plain",
     !two.find((w) => w.text === "PM").marked &&
     !two.find((w) => w.text === "today").marked);

  const multi = parse("The {big red} bus");
  ck("a multi-word curly run carries the tone across every word",
     multi.filter((w) => w.tone === "accentAlt").map((w) => w.text).join(" ") === "big red",
     multi.map((w) => `${w.text}:${w.tone}`).join(" "));

  const stripped = parse("PM {Modi} meets [Biden] today").map((w) => w.text).join(" ");
  ck("no bracket character survives into the drawn text",
     !/[[\](){}]/.test(stripped), stripped);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
