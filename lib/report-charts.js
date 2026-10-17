import sharp from "sharp";

/* ── Pie charts as images, for the report email ──────────────────────────────

   An email cannot draw a chart. Mail clients strip SVG and scripts, and Gmail
   refuses images embedded as data: URLs, so a chart in the body of an email
   has to be a real image at a real address. The report's two pies are drawn
   here as SVG, turned into PNG with sharp, and uploaded by the caller to the
   public media bucket.

   The bar charts are not images: they are table cells in the email itself
   (lib/daily-report.js), which every client shows even with images blocked.
   A pie cannot be built that way, so the pies are the only pictures — and
   every number on them is also in the email's tables, for a reader whose
   client holds images back.

   Drawn at twice the size they are shown, so they stay sharp on phones. The
   labels need a font on the machine that renders them; the Docker image
   installs DejaVu for that (see Dockerfile). */

export const PIE_HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const OTHER_HUE = "#94a3b8";
export const PIE_SLOTS = 8;

const SIZE = 560;          // rendered pixels; shown at 280 in the email
const RADIUS = 250;
const LABEL_AT = 0.64;
const LABEL_MIN = 0.06;    // a slice under 6% is too thin for two lines
const FONT = "DejaVu Sans, Segoe UI, Arial, Helvetica, sans-serif";

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function shareLabel(fraction) {
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct)}%`;
}

/**
 * The slices for both pies, with one colour per category shared between them.
 *
 * `categories` is [{ name, sent, approved }] sorted by sent, largest first.
 * Hues are handed out from that order; past eight categories the smallest by
 * posts sent fold into one grey "Other" slice in both pies, so a category is
 * the same colour — or in the same "Other" — in each.
 *
 * Returns { sent: slices, approved: slices }, each slice
 * { name, count, share, hue, members: [names folded into it] }.
 */
export function pieSlices(categories) {
  const folds = categories.length > PIE_SLOTS;
  const named = folds ? categories.slice(0, PIE_SLOTS - 1) : categories;
  const rest = folds ? categories.slice(PIE_SLOTS - 1) : [];
  const hueOf = new Map(named.map((c, i) => [c.name, PIE_HUES[i]]));

  const build = (key) => {
    const slices = named
      .filter((c) => c[key] > 0)
      .map((c) => ({ name: c.name, count: c[key], hue: hueOf.get(c.name), members: [] }))
      .sort((a, b) => b.count - a.count);
    const restCount = rest.reduce((sum, c) => sum + c[key], 0);
    if (restCount) {
      slices.push({
        name: "Other",
        count: restCount,
        hue: OTHER_HUE,
        members: rest.filter((c) => c[key] > 0).map((c) => c.name),
      });
    }
    const total = slices.reduce((sum, s) => sum + s.count, 0);
    for (const s of slices) s.share = total ? s.count / total : 0;
    return slices;
  };
  return { sent: build("sent"), approved: build("approved") };
}

/* The pie as SVG: slices clockwise from twelve o'clock, a white hairline
   between them, and the count over the percentage on every slice wide enough
   to hold both. */
export function pieSvg(slices) {
  const c = SIZE / 2;
  const at = (angle, dist) => [c + dist * Math.cos(angle), c + dist * Math.sin(angle)];
  let angle = -Math.PI / 2;
  const shapes = [];
  const labels = [];
  for (const s of slices) {
    const start = angle;
    const end = angle + s.share * Math.PI * 2;
    angle = end;
    if (s.share >= 0.9999) {
      shapes.push(`<circle cx="${c}" cy="${c}" r="${RADIUS}" fill="${s.hue}"/>`);
    } else {
      const [x0, y0] = at(start, RADIUS);
      const [x1, y1] = at(end, RADIUS);
      const large = end - start > Math.PI ? 1 : 0;
      shapes.push(`<path d="M${c},${c} L${x0.toFixed(2)},${y0.toFixed(2)} A${RADIUS},${RADIUS} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${s.hue}" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>`);
    }
    if (s.share >= LABEL_MIN) {
      const [lx, ly] = s.share >= 0.9999 ? [c, c] : at((start + end) / 2, RADIUS * LABEL_AT);
      labels.push(
        `<text x="${lx.toFixed(1)}" y="${(ly - 12).toFixed(1)}" class="n">${esc(s.count)}</text>`,
        `<text x="${lx.toFixed(1)}" y="${(ly + 20).toFixed(1)}" class="p">${esc(shareLabel(s.share))}</text>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<style>
  text { font-family: ${FONT}; fill: #ffffff; text-anchor: middle; dominant-baseline: middle;
         paint-order: stroke; stroke: rgba(15,23,42,0.45); stroke-width: 5px; stroke-linejoin: round; }
  .n { font-size: 30px; font-weight: 700; }
  .p { font-size: 24px; font-weight: 600; }
</style>
<rect width="100%" height="100%" fill="#ffffff"/>
${shapes.join("\n")}
${labels.join("\n")}
</svg>`;
}

export async function piePng(slices) {
  return sharp(Buffer.from(pieSvg(slices))).png({ compressionLevel: 9 }).toBuffer();
}
