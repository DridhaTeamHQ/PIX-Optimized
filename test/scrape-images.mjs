import {
  extractBestArticleImage,
  upgradeImageToHighestQuality,
} from "../lib/scrape.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`✓ ${name}`);
    return;
  }
  failed++;
  console.error(`✗ ${name}\n  expected: ${expected}\n  actual:   ${actual}`);
}

const base = "https://news.example.com/world/story";

check(
  "prefers the large article photo over an earlier publisher logo",
  extractBestArticleImage(`
    <meta property="og:image" content="/assets/publisher-logo.png">
    <meta property="og:image:width" content="120">
    <meta property="og:image:height" content="120">
    <script type="application/ld+json">{
      "@type":"NewsArticle",
      "headline":"Monsoon reaches Delhi",
      "publisher":{"logo":{"@type":"ImageObject","url":"/logo-square.png"}},
      "image":{"@type":"ImageObject","url":"/photos/delhi-monsoon.jpg","width":1600,"height":900}
    }</script>
  `, base, { title: "Monsoon reaches Delhi" }),
  "https://news.example.com/photos/delhi-monsoon.jpg",
);

check(
  "uses the largest srcset candidate from the article",
  extractBestArticleImage(`
    <article><img alt="Prime Minister addresses summit"
      src="/photos/summit-320.jpg"
      srcset="/photos/summit-640.jpg 640w, /photos/summit-1600.jpg 1600w"
      width="1600" height="900"></article>
  `, base, { title: "Prime Minister addresses summit" }),
  "https://news.example.com/photos/summit-1600.jpg",
);

check(
  "falls back to Twitter metadata when Open Graph is a placeholder",
  extractBestArticleImage(`
    <meta property="og:image" content="/images/default-placeholder.jpg">
    <meta name="twitter:image" content="/images/election-result.jpg">
  `, base, { title: "Election result announced" }),
  "https://news.example.com/images/election-result.jpg",
);

check(
  "does not apply tiny Open Graph dimensions to a Twitter image",
  extractBestArticleImage(`
    <meta property="og:image" content="/images/social-square.jpg">
    <meta property="og:image:width" content="120">
    <meta property="og:image:height" content="120">
    <meta name="twitter:image" content="/images/parliament-session.jpg">
  `, base, { title: "Parliament session begins" }),
  "https://news.example.com/images/parliament-session.jpg",
);

check(
  "resolves relative Open Graph URLs",
  extractBestArticleImage('<meta property="og:image" content="../media/story.webp">', base),
  "https://news.example.com/media/story.webp",
);

check(
  "preserves signed CDN query parameters",
  upgradeImageToHighestQuality("https://cdn.example.com/photo.jpg?w=640&token=secret&expires=999999"),
  "https://cdn.example.com/photo.jpg?w=640&token=secret&expires=999999",
);

check(
  "does not rewrite unknown CDN resize contracts",
  upgradeImageToHighestQuality("https://images.example.com/photo.jpg?width=640&height=360&q=80"),
  "https://images.example.com/photo.jpg?width=640&height=360&q=80",
);

check(
  "removes TOI social padding and requests a larger copy",
  upgradeImageToHighestQuality("https://static.toiimg.com/thumb/msid-123,width-1280,height-720,imgsize-99,resizemode-4,overlay-toi_sw,pt-32,y_pad-600/photo.jpg"),
  "https://static.toiimg.com/thumb/msid-123,width-1600,height-900,imgsize-99,resizemode-4/photo.jpg",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
