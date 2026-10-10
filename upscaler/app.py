"""
PIX Free Upscaler: Real-ESRGAN x2 on CPU, behind a tiny FastAPI app.

No OpenAI, no per-image bill: it runs on its own Railway service. The model is
loaded once at startup (not per request), and the picture is processed in
overlapping tiles so memory stays bounded on a small container.

Real-ESRGAN only super-resolves the pixels that are there; it has no face
model, so a person's identity is not redrawn.

Endpoints
  GET  /health   -> {"ok": true, ...}
  POST /enhance  -> raw image bytes in, PNG bytes out
                    header X-Secret: <UPSCALER_SECRET>  (required when set)
                    header X-Enhance-Strength: 0..1     (optional)
Env
  UPSCALER_SECRET     shared secret the PIX server sends
  ENHANCE_STRENGTH    0..1, default 0.85. How much of the model to keep;
                      the rest is a plain Lanczos enlarge. 1.0 = raw model,
                      lower = less of the "painted" look on skin.
  MAX_INPUT_EDGE      longest input edge accepted before downscaling, default 1024
  TILE                tile size in input pixels, default 256
  TORCH_THREADS       CPU threads, default = all cores
"""

import io
import os
import time

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps
from spandrel import ImageModelDescriptor, ModelLoader

SECRET = os.environ.get("UPSCALER_SECRET", "")
WEIGHTS = os.environ.get("WEIGHTS", "/app/weights/RealESRGAN_x2plus.pth")
STRENGTH = float(os.environ.get("ENHANCE_STRENGTH", "0.85"))
MAX_INPUT_EDGE = int(os.environ.get("MAX_INPUT_EDGE", "1024"))
TILE = int(os.environ.get("TILE", "256"))
TILE_PAD = 16
MAX_BYTES = 12 * 1024 * 1024

if os.environ.get("TORCH_THREADS"):
    torch.set_num_threads(int(os.environ["TORCH_THREADS"]))
torch.set_grad_enabled(False)

model = ModelLoader().load_from_file(WEIGHTS)
assert isinstance(model, ImageModelDescriptor), "weights are not an image model"
model.eval()
SCALE = model.scale
print(f"OK loaded {model.architecture.name} x{SCALE} from {WEIGHTS}", flush=True)

app = FastAPI(title="PIX Free Upscaler")


def upscale_tiled(img: Image.Image) -> Image.Image:
    """Run the model tile by tile. Each tile is padded so the seams between
    tiles are computed with real neighbours, then the padding is cropped off."""
    arr = np.asarray(img, dtype=np.float32) / 255.0
    x = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    _, _, h, w = x.shape
    out = torch.zeros((1, 3, h * SCALE, w * SCALE))
    for y0 in range(0, h, TILE):
        for x0 in range(0, w, TILE):
            y1, x1 = min(y0 + TILE, h), min(x0 + TILE, w)
            py0, px0 = max(y0 - TILE_PAD, 0), max(x0 - TILE_PAD, 0)
            py1, px1 = min(y1 + TILE_PAD, h), min(x1 + TILE_PAD, w)
            tile = x[:, :, py0:py1, px0:px1]
            # RRDBNet x2 needs even sides (pixel_unshuffle).
            ph, pw = tile.shape[2] % 2, tile.shape[3] % 2
            if ph or pw:
                tile = torch.nn.functional.pad(tile, (0, pw, 0, ph), mode="reflect")
            res = model(tile)
            oy, ox = (y0 - py0) * SCALE, (x0 - px0) * SCALE
            out[:, :, y0 * SCALE:y1 * SCALE, x0 * SCALE:x1 * SCALE] = \
                res[:, :, oy:oy + (y1 - y0) * SCALE, ox:ox + (x1 - x0) * SCALE]
    res = out.squeeze(0).clamp(0, 1).permute(1, 2, 0).numpy()
    return Image.fromarray((res * 255.0).round().astype(np.uint8))


@app.get("/health")
def health():
    return {"ok": True, "engine": f"real-esrgan-x{SCALE}", "strength": STRENGTH}


@app.post("/enhance")
async def enhance(
    request: Request,
    x_secret: str = Header(default=""),
    x_enhance_strength: str = Header(default=""),
):
    if SECRET and x_secret != SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")
    data = await request.body()
    if not data or len(data) < 100:
        raise HTTPException(status_code=400, detail="empty image body")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="not a readable image")

    # Keep CPU time sane: anything bigger is brought down first, then x2.
    if max(img.size) > MAX_INPUT_EDGE:
        img.thumbnail((MAX_INPUT_EDGE, MAX_INPUT_EDGE), Image.LANCZOS)

    try:
        strength = float(x_enhance_strength) if x_enhance_strength else STRENGTH
    except ValueError:
        strength = STRENGTH
    strength = max(0.0, min(1.0, strength))

    t0 = time.time()
    up = upscale_tiled(img)
    if strength < 0.999:
        base = img.resize(up.size, Image.LANCZOS)
        up = Image.blend(base, up, strength)
    secs = time.time() - t0
    print(f"OK {img.size[0]}x{img.size[1]} -> {up.size[0]}x{up.size[1]} in {secs:.1f}s", flush=True)

    buf = io.BytesIO()
    up.save(buf, format="PNG", optimize=False)
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"X-Engine": f"real-esrgan-x{SCALE}", "X-Seconds": f"{secs:.1f}"},
    )


@app.exception_handler(Exception)
async def unhandled(_request, exc):
    return JSONResponse(status_code=500, content={"detail": str(exc)[:300]})
