/* ── Pixel size of a picture, from its first few hundred bytes ──
   The website needs width and height beside each card URL so its layout can
   reserve the space before the picture arrives (otherwise the page jumps as
   cards load). The browser knows the size when it renders a card, but it does
   not send it, and adding fields to the publish form would mean touching the
   client and the field limits. Reading the header here is smaller: three
   formats, no decoder, no dependency. Anything unrecognised returns null and
   the caller simply omits the size. */

export function imageSize(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return png(buffer) || webp(buffer) || jpeg(buffer) || null;
}

/* PNG: fixed layout — the IHDR chunk always follows the 8-byte signature. */
function png(b) {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/* WebP: a RIFF container. The first chunk says which flavour, and each keeps
   its size somewhere different — lossy (VP8) in the frame header, lossless
   (VP8L) packed into 14-bit fields, extended (VP8X) as 24-bit minus one. */
function webp(b) {
  if (b.length < 30) return null;
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: 1 + b.readUIntLE(24, 3),
      height: 1 + b.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    // frame tag (3) + start code 9d 01 2a (3), then 14-bit width and height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/* JPEG: walk the marker segments until a start-of-frame, which carries the
   dimensions. Everything before it (APP0, EXIF, ICC, quantisation tables) is
   skipped by its declared length. */
function jpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // padding bytes between segments are legal
    if (marker === 0xff) { i += 1; continue; }
    // SOF0..SOF15 except the DHT/JPG/DAC markers that share the range
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data: no frame seen
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
