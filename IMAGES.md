# Images in PIXIE

Every parameter that decides what a picture looks like on a card: where images
come from, what Restore & Upscale sends to OpenAI, and what the renderer does
with the result.

Values here are read from the code, not remembered. Where a number matters the
file and reason are named, so a change can be checked against the intent rather
than guessed at.

---

## 1. Where a picture comes from

Four sources, all reaching the same place — `state.mainImage`, the background of
the current page.

| Source | Endpoint | Notes |
|---|---|---|
| Scraped from the article | `/api/scrape-article` | The usual path. Whatever the page's own lead image is |
| Stock search | `/api/stock-images` | Needs `PEXELS_API_KEY`; the source is skipped silently without it |
| Web image search | `/api/google-images` | |
| Generated | `/api/flux-image` | Needs `FAL_KEY`. Last resort, paid |

Everything else on this page happens *after* one of those has produced a
picture. Remote images are fetched through `/api/image` as a same-origin proxy
so the canvas is not tainted and can be exported.

---

## 2. Restore & Upscale

`POST /api/upscale-image` — QA and admin only. One engine: OpenAI's
`images/edits`. There is no self-hosted upscaler and no local resampler; both
were removed deliberately (see §2.11).

### 2.0 The browser decides first, and usually decides not to spend

Before anything is uploaded, `runImageAI` measures the picture locally — free,
about a millisecond — and answers two questions:

| | |
|---|---|
| **Is it too small?** | gpt-image's ceiling is 1536px on the long edge and the upload is capped to match. A source already above it is shrunk on the way out, repainted at the ceiling, and enlarged back on the way home — real capture replaced by the model's idea of it, and billed. The model is never shown more than the ceiling, so it can never return more. |
| **Is it flat?** | Exposure, contrast and colour off the picture's own histogram — see `analysePhoto` / `autoFilterFor`. Arithmetic, not a model. |

Three outcomes, two of which cost nothing:

- **needs nothing** — big enough and correctly exposed. Says so, changes
  nothing, spends nothing. *This is most wire photographs.*
- **tone only** — big enough but flat or dark. Corrected in the browser with
  the brightness/contrast/saturation controls that already exist. No call.
- **upscale** — genuinely short of pixels. Spends, and applies the tone fix
  too, because there is no reason to pay a model to do arithmetic already done.

The expensive answer is the last one considered rather than the only one
available. Everything from 2.1 onward describes what happens **only in that
third case**.

Same measurement is on the **Auto** chip in the Filters panel, for correcting
tone without going near the paid button.

---

### 2.1 What the browser sends

Body is the current background as PNG, **capped at 1536px on the long edge**
before upload — gpt-image-1's maximum output, so anything larger is bytes spent
to be thrown away.

That cap is on the **upload only**. An expand pastes the writer's original back
over the result at up to its own resolution — see §2.10.

| Header | Value | Read by |
|---|---|---|
| `Content-Type` | `image/png` (stage 1) / multipart (stage 2) | |
| `X-Enhance-Stage` | `plan` \| `edit` | Which half of the two-stage flow this is (§2.2). Absent ⇒ the legacy single-shot path |
| `X-Image-Orientation` | `landscape` \| `portrait` | Decides output size (§2.3) |
| `X-Source-Size` | `WxH` of the capped upload | The planner — shape alone cannot tell a 400px crop from a 3000px one |
| `X-Headline` | URL-encoded, ≤200 chars | Stage 1 context only. **Never** given to the image model — a quoted string in an image prompt is a string to render, which put headlines inside photographs |
| `X-Enhance-Mode` | `restore` \| `reframe` \| `expand` \| `auto` | Unrecognised or absent ⇒ `restore`. `reframe` is an expand at fit — §2.7 |
| `X-Poster-Ratio` | e.g. `9:16` | Reframe and expand. The restore path ignores it — see §2.3 |
| `X-Expand-Amount` | `slight` \| `moderate` \| `wide` | Expand only. Anything else ⇒ `moderate` |
| `X-Expand-Capable` | `1` | The caller composites the frame, sends the mask and pastes the source back. Only such a caller may be given an expand on `auto` (§2.8) |
| `X-Enhance-Strength` | `0`–`1` | **Currently unused server-side.** Left over from the deleted self-hosted upscaler; the slider still moves and changes nothing |

### 2.2 Two stages

**Stage 1 — plan and describe.** `gpt-4o-mini`, `temperature 0.2`,
`max_tokens 500`, `response_format: json_object`, image at `detail: "low"`
(a 512px thumbnail — framing survives that downscale, grain does not, and
framing is what is being judged).

Returns `{ mode, amount, subject, description, reason, fit, size, posterRatio }`.
Any failure falls back to `restore`, so a broken planner degrades to the job
that reframes nothing. `fit: true` asks the browser to letterbox the result
instead of leaving it cropped (§2.8). `size` is the exact canvas the caller
must build for an expand — the browser has to match it or the model rescales
the composite and undoes the point of compositing it.

Stage 1 spends no image credits. It is a separate round trip precisely so the
decision and the geometry are settled before anything is billed.

**Stage 2 — edit.** Multipart: the composited frame, the alpha mask for an
expand, and the plan echoed back as fields so the vision stage is not paid for
twice. The description becomes context in the restore prompt, so the model is
told what it must not change.

### 2.3 Parameters sent to `images/edits`

| Parameter | Value | Why |
|---|---|---|
| `model` | `gpt-image-1.5`, falling back to `gpt-image-1` on 400/403/404 | The fallback is for accounts without the newer model |
| `size` | `1536x1024` landscape · `1024x1536` portrait · `auto` if orientation unknown | **Follows the SOURCE, not the poster** |
| `quality` | `IMAGE_QUALITY`, default `medium` | This is the clay-face setting. `low` starves the model of rendering compute and skin comes back waxy — no prompt can undo it. A boot warning fires if it is set to `low` |
| `input_fidelity` | `high` | OpenAI's identity-preservation control |
| `image` | the PNG | |

> **`size` follows the source deliberately.** It used to ask for the *poster's*
> ratio, so a landscape photo on a 9:16 poster was requested as portrait and the
> model invented the difference — the doubled-subject "overlay" bug. Asking for
> the source's own shape is what fixed it. To fit a landscape photo into a
> portrait frame, use **Fit** (§4.2), which is arithmetic and involves no model.

### 2.4 The 1536px ceiling, and which path it actually hurts

gpt-image-1.5 caps its output at **1536px on the long edge**, and the browser
caps the upload to match. This is an API limit, not a setting, so the model
cannot be asked to upscale: a 3000×2000 press photo goes up as 1536×1024 and
comes back 1536×1024 — restored, and no larger than it was sent.

**The two jobs meet that ceiling very differently, and only one of them is hurt
by it.**

**Expand does not care.** The model's output is only ever the *margin* there.
The photograph itself is composited by the browser and pasted back over the
result from the writer's original (§2.10), so the drawn margin is the only part
of an expand the model actually supplies. This is the path a landscape photo on a 9:16 card takes,
so it is the path that matters most here.

**Restore is capped at 1536, and it is left capped.** The model's output *is*
the picture there, so there is nothing to paste back — recovering the detail is
the entire job, and overwriting it with the original would undo it.

An enlargement step in the browser was considered and rejected as theatre.
Canvas resampling is the same interpolation the renderer already applies when
it draws the image to the card, so upscaling a 1536px return to 3000px before
storing it produces a *byte-heavier file and a pixel-identical poster*. The only
enlargement worth having is a better kernel than the renderer's — lanczos with a
contrast-adaptive sharpen — and that means a real image pipeline, which this
route deliberately no longer carries (§2.8).

> **If restore must exceed 1536**, the honest route is a model that outputs
> larger natively rather than a resampler bolted behind this one. `gpt-image-2`
> goes to 3840. It was assessed and declined on cost — see §2.11.

### 2.5 Response

```json
{
  "image":   "/api/enhance-result/9f2c…-a41b",
  "engine":  "gpt-image-1.5",
  "quality": "medium",
  "size":    "1536x1024",
  "mode":    "restore",
  "masked":  false,
  "amount":  null,
  "context": "…what stage 1 saw…",
  "subject": "people",
  "reason":  "…why this job ran…"
}
```

`mode` matters to the caller: the two jobs differ in **framing**, not just
sharpness, so the client has to know which it got before deciding whether the
writer's existing zoom and pan still apply.

**`image` is an address, not the picture — and that is not a tidiness
preference.** It used to be the PNG itself, `data:image/png;base64,…`, five or
six megabytes inside the JSON of the request that made it. A response gets
sixty seconds to flush before the platform proxy abandons it, and that one
frequently did not make it. The log of a failure is unambiguous:

```
✓ AI reframe done in 53180ms (gpt-image-1.5, 1024x1536, quality=high) — $0.3297
✗ upscale-image error: Error: aborted … ECONNRESET          (60.002s later)
```

The picture was made. It was **billed**. It never arrived. And because what
answered the reviewer was the proxy's own error page rather than this server,
there was no JSON to read a message out of — so the UI printed
`Reframe failed: HTTP 502`, a status with no sentence attached. Any diagnosis
that starts from that message goes hunting for an OpenAI fault that is not
there; start from the log above instead.

So stage 2 answers with a short same-origin URL and the browser collects the
bytes with a plain `GET`, which gets its own fresh sixty seconds. The JSON now
flushes in one packet, the transfer is binary rather than base64 (a quarter
less of it), and — the part that actually matters — **a collection that fails
is free and can simply be repeated**, because `enhanceCacheSet` runs *before*
the response is built. The money was spent upstream and the picture is already
held server-side.

| | |
|---|---|
| path | `GET /api/enhance-result/<uuid>` |
| auth | the `/api/*` session gate, plus an unguessable v4 token |
| lifetime | 1 hour, or until the process restarts |
| on a miss | `404` with *"That enhanced picture has expired. Press Enhance again."* |

**Same origin, deliberately.** A Supabase URL would have been less code and
would have broken Save: `describeMainImage()` reads a `data:` src to mean "no
address yet, upload this on Save" and an https one to mean the picture already
has one. A remote URL would have published posts pointing at an object that
expired an hour later — silently, and in the archive. `collectEnhancedImage()`
in `public/app.js` turns the bytes back into a `data:` URL before anything else
sees them, and passes a `data:` URL straight through so an older server still
works. Covered by `test/enhance-result.mjs`.

### 2.6 Cost and latency

**The real number is measured, not from this table.** Every call reads the
`usage` block off its own response, prices it, and reports it three ways:

```
console  ✓ AI restore done in 41200ms (gpt-image-1.5, 1536x1024, quality=medium) — $0.0631 (in 1568 img + 214 txt, out 1024)
payload  "cost": { "textInTokens": 214, "imageInTokens": 1568, "outputTokens": 1024, "usd": 0.0631 }
UI       ✓ Restored and upscaled via gpt-image-1.5 — $0.063
```

Read that, not the estimates below. A table in a document cannot know what
OpenAI charged today, and this one has been wrong before: it previously quoted
1024x1024 prices for a route that never asks for a square, understating `low`
and `medium` by about half. Rates are overridable via `OPENAI_RATE_TEXT_IN`,
`OPENAI_RATE_IMAGE_IN` and `OPENAI_RATE_IMAGE_OUT` (per million tokens); the
authoritative total is always the OpenAI usage dashboard.

Rough expectations, output tokens only, at the portrait/landscape shapes this
route asks for:

| `IMAGE_QUALITY` | Output cost |
|---|---|
| `low` | ~$0.013 (produces clay faces — not recommended) |
| **`medium`** (default) | **~$0.05** |
| `high` | ~$0.20 (4× medium, for detail the poster gradient covers) |

**Add the input side to all three.** `input_fidelity=high` is hard-coded and
has no environment override, and it bills image INPUT tokens on top of the
figures above — a floor under every call that `IMAGE_QUALITY` cannot lower.
At `low` it is the dominant line item, which is why switching to `low` saves
far less than the table implies.

Typically 20–90 seconds, and now bounded: `OPENAI_IMAGE_TIMEOUT_MS` (default
180s) and `OPENAI_TEXT_TIMEOUT_MS` (default 60s). Before those, a hung request
held its Railway worker until the platform reaped the whole thing.

The default was `high` between dbcdb0f and this change, on the same day the
free self-hosted upscaler was deleted. Those two together are what turned a
near-zero bill into a real one, and `medium` is the correction.

**Two guards sit in front of the paid call:**

- **Result cache.** Keyed on the input bytes plus every parameter that changes
  the answer or the price (quality included). A repeat press on the same photo
  is served from memory and reported to the reviewer as `(from cache, no
  charge)`. In-process, 1-hour TTL, evicted by total bytes.
- **Rate limit.** `ENHANCE_RATE_MAX` (default 40) billed enhances per user per
  hour, then a 429. Cache hits do not count against it, because they cost
  nothing. This is a spend cap, not a security control — the reviewer-only
  route gate is that.

### 2.7 Reframe — the whole picture redrawn, the way ChatGPT does it

A reviewer typed *"upscale and reframe it to 9:16 ratio"* at ChatGPT and got a seamless, coherent 9:16 picture. Same model. Reframe is that request: the raw picture (capped at 1536px) goes up with no frame and no mask, a short prompt (`buildReframePrompt`) that opens with what the reviewer typed, and **high** render quality (`IMAGE_QUALITY_REFRAME`, default `high`, ~$0.33 measured — input fidelity bills the upload too). The returned 1024×1536 is the result, used as it comes back.

**It is a regeneration.** Faces and fine detail come back recognisably the same, not pixel-identical, and the selector says so. Two commits tried to get the same picture without regenerating it — the photograph pinned by a mask, the margin drawn around it, the original pasted back at native resolution — and came back with a rectangle, then a smear, then a tone-matched edge that still could not match what the model does when it is simply asked. That machinery survives as **Expand** (§2.8–2.10), for a photograph that must not be redrawn.

A photograph that already has the poster's shape and is already above 1536px is not sent: a redraw could only shrink it. Smaller than that it still gains pixels, so it goes. `auto` resolves to reframe.

---

### 2.8 Expand, and when `auto` picks it

**`auto` resolves to expand when the planner says so and the caller can
composite.** A landscape photograph on a 9:16 poster is the case this exists
for: the card keeps about a third of its width, so the choice is between
generating the parts that were never photographed and throwing away two thirds
of the ones that were. The plan response carries `mode: "expand"` and the
`size` the browser must build for.

`X-Expand-Capable: 1` is the gate. It says the caller composites the source
onto the resolved frame, sends the mask, and pastes the source back over the
return — the three things that make an expand safe. A caller that does not send
it (the legacy single-shot path, anything posting raw bytes) still gets **Fit**
on an expand verdict: the whole photograph, letterboxed, by arithmetic
(`fitZoomFor` in app.js), with `fit: true` on the response and nothing
generated past the edges. An unresolvable size falls to Fit the same way —
there is no canvas to pin the picture to. See "auto expands when the caller
composites" in server.mjs.

This was off for a period. `auto` never expanded between abe51a8 and this
change, because expand had twice returned the source as a framed print inside
an invented scene, and a verdict is a good enough reason to letterbox a picture
but not a good enough reason to let a model redraw the parts of one that do not
exist. What changed is that the model is no longer trusted with any of it —
`composeExpandResult` pastes the original back without asking — so the verdict
can be acted on rather than noted and discarded.

**The framed-print failure**, for the record. It was switched off in abe51a8 after two
published posters came back with the source photograph rendered as a **physical
print — hard white border and all** — inside a scene the model drew around it.
Measured on the poster, the surround carried *more* edge energy than the inset
(17.8 vs 12.6), so it was generated detail, not a blurred backdrop. Three
structural causes: the prompt asked the model to "place the supplied photograph
smaller within the output frame"; no mask or padded canvas was sent, so nothing
pinned the original pixels; and it requested the poster ratio, the same
condition that caused the overlay bug.

All three are now addressed. The browser composites the source onto a frame of
exactly the resolved size and sends an **alpha mask** that is opaque over the
source, so the model can only paint the margin; the prompt drops the placement
sentence because placement is already a fact; and `runEnhanceEdit` refuses an
expand that arrives without a composited frame, degrading to restore and saying
so. The model output is then laid back over that frame, so a transparent
margin or a refusal cannot leave a hole.

### 2.9 Where the picture is placed, and why not in the middle of the file

gpt-image sells three shapes. A 9:16 poster resolves to **1024x1536**, which is
2:3 — taller than the source but not as tall as the card, which is 920x1700. So
the card covers and clips: about a fifth of the frame's width goes over the
side, a quarter once `IMAGE_PAN_HEADROOM` is applied.

The photograph used to be placed at contain scale — full frame width — which
put *the photograph's own edges* across that boundary while the margin
generated for exactly this purpose sat safely in the middle. On a landscape
press photo of two people, one at each end, that is one person per edge. The
expand ran correctly and the card still arrived with someone cut in half.

Two numbers fix it, and they have to agree:

| | |
|---|---|
| `posterVisibleRect()` | what of the model's frame the card actually shows, in that frame's pixels, from the layout preset and `drawCoverImage`'s own arithmetic. `planExpandPlacement` fits the photograph inside **this**, not inside the frame |
| `EXPAND_COMMIT_ZOOM` | `ceil(100 / IMAGE_PAN_HEADROOM)` = **91%**, the zoom the result is committed at, and the zoom `posterVisibleRect` measures against. Ceiling, not floor: 90% puts the scale a hair under cover and letterboxes the card by 17px |

The generated margin absorbs the crop, which is what margin is for.

An expanded frame also gets its **focal point pinned to the centre**. Otherwise
`ensureImageFocalPoint` runs the face detector over the result and hands
`drawCoverImage` a face to centre the crop on, which pans the composition
sideways and takes the crop straight back off the edge of the photograph.

**Focal point, generally.** It reads the box containing *every* face, not
`faces[0]`. The focal point decides who survives a crop that keeps a third of
the width, and aiming it at whichever face the detector returned first turned a
landscape photograph of two people into a portrait of one of them. A single
face is unchanged — the union of one box is that box.

### 2.10 What resolution an expand comes back at

The composite is built at the **photograph's** scale, not the model's:
`nativeComposeScale` is the number of source pixels per frame pixel where the
photograph sits (a 4000px photo placed 864px wide in the 1024×1536 frame asks
for 4.6×), never below 1, and capped so the result's long edge stays within
`COMPOSE_MAX_EDGE` (4096px — the export's own size). Layers 1–4 are the model's
frame and the ≤1536px upload, scaled up together; **layer 5 is the original**,
drawn over layer 4 at that size.

**There was a version that scaled the composite and it put a smear across the
sky**, and the reason is worth keeping: the composite is one canvas, so scaling
it sharpened the pasted photograph and could not sharpen the drawn margin, and
the two met along a full-width line with an 11px feather between them. Soft
next to sharp with nothing in between. The answer for a while was "no scale,
ever" — which handed back the downscale.

The fix is not the scale, it is the join. Layer 5 goes in through an alpha ramp
`SHARP_RAMP_FRACTION` (6%) of the photograph's short side wide, transparent at
the photograph's edge and opaque that far in. Underneath it, layer 4 is the
*same picture* at the margin's softness, fully opaque — so the ramp is
sharp-over-soft of identical, aligned content, and the sharpness step becomes a
slope inside the photograph where its own detail carries it, instead of a line
at its border. Measured on a synthetic frame: a hard edge in the original is
still a one-pixel step in the output, and the margin is the model's.

**The margin is bent to meet the photograph; the photograph is not bent.** Two things were tried at this boundary and both drew something. A hard edge drew a line wherever the model's margin was a shade off the photograph — a table drawn darker below a bright one, the full width of the card. A wide alpha fade (the mask feathered 8% into the picture, the paste-back faded in over the same strip) drew a ghost wherever the model had redrawn a shape inside the strip — a rider's arm and helmet, smeared across the crossing. Blending pixels between two renderings of the same arm cannot work; the renderings differ.

So the photograph goes down whole, hard-edged and exact, and the mismatch is fixed on the margin's side: `matchMarginTone` measures the colour step between the photograph's outermost rows and the margin's innermost rows, per column (per row for the sides), smooths it along the edge, and adds it to the margin at full strength on its first line, easing to nothing `TONE_REACH_FRACTION` (35% of the photograph's short side) out. Tone is corrected; content is never blended. The mask keeps only a 2% feather, enough to soften the model's own edge. Measured with a mock that paints the margin 94 levels darker: the margin's first row lands within 2 levels of the photograph's last, and the correction is gone 400px out. A mock that repaints a strip inside the photograph leaves the photograph untouched.

At scale 1 (a photograph no larger than its placement) there is no fifth layer,
and the composite is exactly what it was before.

`canvasToImage` still encodes through `toBlob` rather than `toDataURL` — a
synchronous encode froze the editor at the end of the call. It produces a
`data:` URL deliberately: `describeMainImage` reads that prefix to tell an
enhance from an address, and a `blob:` URL would be recorded as the picture's
permanent address and die with the tab.

### 2.11 The model ladder

The route runs on `gpt-image-1.5`, falling back to `gpt-image-1` for an
account that does not have it. One model family, one parameter set, one kind of
picture.

Both rungs are on OpenAI's deprecations page with a shutdown date of
**1 Dec 2026**. Nothing acts on that today, but when it arrives the route
returns 502 on every press until a newer model is put in. So the ids are read
from the environment — `IMAGE_MODEL` and `IMAGE_MODEL_FALLBACK` — which costs
two lines and makes that day a variable edit on the host rather than an
emergency deploy. The boot log states what they resolved to, and the `engine`
field of every response says which rung actually served.

**A newer model may not be a drop-in.** Adopting one is not necessarily an id
swap: `size` is resolved in the plan stage before anything knows which rung
will serve, and `input_fidelity` is sent unconditionally. A model that rejects
either would 400 on every press, fall through to the rung below, and keep
working — the migration looking finished without having started. If that day
comes, derive the parameters from `model` inside `callEdit()` and check the
`engine` field before trusting it.

**Also removed:** the self-hosted Real-ESRGAN/SwinIR service (`upscaler/`), a
local lanczos resampler, and the per-image colour tint. One button returning
three different kinds of picture depending on what was reachable was the fault
being fixed.

`DISABLE_GPT_IMAGE=true` switches the route off entirely and returns 503. It no
longer diverts to anything, because there is nothing left to divert to.

---

## 3. Frame sizes

`LAYOUTS` in `public/app.js`. The canvas is set to `L.W × L.H`, so design
coordinates and canvas pixels are the same thing at 1×.

| Ratio | Canvas | Headline pad | Fade height |
|---|---|---|---|
| `9:16` Story/Reel | 920 × 1700 | 305 | 330 |
| `4:5` Feed portrait | 1080 × 1350 | 110 | 300 |
| `1:1` Square | 1080 × 1080 | 90 | 280 |
| `16:9` Wide | 1920 × 1080 | 100 | 300 |

**Export** re-renders at a scale (`renderToHighResCanvas`, up to 4×); X exports
at 2×. Anything that *reads* the canvas must convert through the live transform
— `drawImage`'s source rectangle is not transformed, and a design-space rect
against a 4× canvas reads the top-left corner instead.

---

## 4. Placing the picture

### 4.1 Fill (default)

`drawCoverImage` scales to **cover**: `max(frameW/imgW, frameH/imgH)`, times the
zoom, times `IMAGE_PAN_HEADROOM` (1.1). Overflow is cropped. A 16:9 photo on a
9:16 poster loses about 68% of itself this way — right for most poster images.

### 4.2 Fit — the whole photo, letterboxed

Click the **zoom percentage** to fit; click again to fill.

`fitZoomFor()` returns the zoom at which the entire picture sits inside the
frame, with the backdrop showing around it. Expressed as a zoom so it travels
through the existing control, the page snapshot and the saved design with no new
field, and can be nudged afterwards.

| Photo | Fit zoom | Result on a 9:16 poster |
|---|---|---|
| 16:9 landscape | 27% | 598px black top and bottom |
| 4:3 landscape | 36% | 513px |
| 1:1 square | 49% | 392px |
| 9:16 portrait | 87% | 37px |
| 3000×600 panorama | 9% | fits |

Two rules that are easy to break:

- **Floored, never rounded.** The control carries whole percentages, and 27.7
  rounding to 28 puts the picture 11px back over the edge it was just fitted
  inside.
- **The pan clamp only applies while the picture is bigger than the frame.**
  Below that its minimum runs past its maximum and `clamp()` returns the
  maximum, which pinned a fitted photo into the top-left corner.

### 4.3 Controls

| Control | Range | Notes |
|---|---|---|
| Zoom | 5–300% | Stepper ±5%. Floor is 5 so a panorama can be fitted |
| Pan X / Y | −900…900 px | |
| Brightness / Contrast / Saturation | 0–200% | Applied to the image layer only |
| Blur | 0–20px | |

Filters never touch the gradient, headline or logo — `drawCoverImage` sets
`ctx.filter` and resets it immediately after the draw.

---

## 5. The glass and the fade

Two effects under the copy, both anchored to the first line of text so they move
with it. Tunable live via `window.GLASS`.

| Key | Default | What it does |
|---|---|---|
| `on` | `true` | Master switch |
| `hue` | 33 | Only meaningful when `saturation > 0` |
| `saturation` | **0** | 0 = neutral black. 0.35 was the brown wash |
| `brightness` | 0.07 | The picker's was 0.09; darkened on request |
| `fillAlpha` | 0.88 | The 85% beside the hex, taken up on request |
| `fadeMax` | 0.24 | Cap on the gradient. The fill does most of the darkening; what must stay bounded is the *product* — see below |
| `blurAt` / `blurCardWidth` | 44 / 382 | Blur in the design's units, scaled to the canvas. Now a real destination radius — it used to be divided by `downscale` and set on the full-size context, which threw three quarters of it away |
| `blurCurve` | 1 | How far the blur LAGS the darkening, as an exponent on the shared ramp |
| `blurLevels` | 12 | Pre-blurred copies of the downscaled band. The blur is applied there, where the upscale multiplies it and the pixels are a sixteenth |
| `frostReach` | 1 | Where the blurred picture is fully present, as a MULTIPLE of where the copy line falls in the band. 1 = full exactly at the first line, whatever the run-up is |
| `gradientSamples` | 256 | Stops per ramp, the bottom fade included. Two gradients over one span means their joins add |
| `dither` | 0.12 | Noise put back over the blurred picture. The blur averages the photograph's own away, and what is left bands |
| `downscale` | 4 | Most of the blur comes free from downsampling; `ctx.filter` supplies the remainder |
| `refract` | 0.012 | How far the glass bends the picture, as a share of width |
| `refractStrips` | 80 | Depth resolution of the bend, and of the blur ramp — each strip carries its own radius |
| `runUpAboveCopy` | 65 | How far above the first line the glass begins, in the 1700px reference frame. The ramp then runs the whole band, so this sets both where the onset lands and how gentle the build is. Replaced `reach` and `startBelowCopy` — see below |

**All three pages that put copy over a photograph use it** — the poster, the
story page and the text page. The text page did not until recently, and the
reason it looked untreated is worth keeping: it painted a four-stop wash over
the whole frame (0.68 / 0.52 / 0.68 / 0.98, plus a flat 0.22) *and* drew its
photograph through `blur(18px) brightness(62%)`. Between 75% and 98% black
everywhere, over an input that was already uniformly soft. A treatment that
goes from sharp to frosted has nothing to show when its input starts frosted:
there was no transition on that page, only a flat blur that resembled one.

It draws the picture sharp now and anchors the same glass and fade to its copy.
`GLASS.textPageVeil` (0.42) is the one thing the wash left behind, and it earns
its place: the other two pages put their copy near the foot so the ramp always
has run-up above it, while the text page's copy grows upward and is clamped a
tenth of the way down the card, where the ramp has barely begun. Measured on a
bright photograph, white body copy at that worst-case first line is 5.28:1 with
the veil and 1.97:1 without it.

### Why a blur bands, and the dither that fixes it

A photograph carries sensor noise, and that noise is what stops a smooth sky
banding: it dithers the 8-bit quantisation so the step between adjacent values
lands somewhere different on each row. **The blur averages it away.** What is
left is a mathematically smooth gradient, and a smooth gradient in 8 bits is a
staircase — flat for as many rows as the true value needs to cross the next
1/255, then a step.

Measured on a photo-like ramp: with the glass on, **32 runs where the row mean
held the same value for four rows or more, the longest for thirty**. With the
glass off and only the darkening applied, **zero**. So the bands are not the
strips, the levels, the ramps or the gradients — all of those measure at the
8-bit floor. They are the blur doing its job.

`GLASS.dither` puts about a level of noise back: one 128px tile, built once and
repeated, laid over the finished glass in `overlay` so mid-grey is a no-op and
the deviations lighten and darken symmetrically. At 0.12 the flat runs go to
**zero** for **1.47 levels** of per-pixel noise — which is what a dither is
supposed to be, enough to break the staircase and below what reads as grain.

**A note on measuring this.** Every other check in `test/glass.mjs` and every
metric used to tune this treatment reports it as clean while the banding is on
screen, because they look at the row *mean* of 920 pixels, or at sources with
no smooth ramp in them. Two of the sources used during tuning were themselves
the problem: a vertical gradient quantises to ~1 level every 15px, so it
reports its own staircase as the treatment's. Use a source that is constant
down the card when looking for horizontal artefacts, and a smooth vertical ramp
only when looking for contouring — with a glass-off control.

### The layered lines

Reported on a card as horizontal slabs across the band. Two causes, and the
metric in use at the time could see neither — it measured the row MEAN on a
horizontal gradient, where a change in blur does not move the mean at all and a
sideways shift barely does.

**The bend was tearing, not bending.** The refraction pulls each strip sideways
by a function of its depth, and the step between neighbours is
`bendMax × |dwave/dt| / strips`. At the original frequencies of 7.6 and 17.3
that derivative peaks near 11, which put adjacent ten-pixel strips **four
pixels apart sideways**. Slowed to 2.3 and 3.9, with more strips and a smaller
amplitude, that is now **0.13px** — below the point where neighbouring slabs
are resolvable as separate.

**The blur was quantised.** Each strip snapped to the nearest of 12 pre-blurred
levels, and across a range reaching σ 99 that is a step of nine pixels of blur
from one strip to the next — a band of visibly different sharpness about ten
pixels tall. Strips now draw the lower level opaque and the upper at the
fractional weight; a blend of two Gaussians of nearby σ is close enough to the
one between them that the seam goes. Once blended, the level *count* stops
mattering for quality (3.6% worst step at 12 levels and at 16), so it is set by
cost.

Worst single-row change in sharpness, on a fine-textured source, as a share of
the unblurred detail: **5.6% → 3.0%**. What remains is the frost cross-fade
itself, not the strips.

`test/glass.mjs` asserts the per-neighbour slide directly, because nothing else
does: the darkening is unaffected by a sideways shift, and the radius ramp is
measured per strip rather than between them, so both stay green while the
picture visibly tears.

### Where the band starts

`runUpAboveCopy` is 65 — about one line-height — because that is where the
treatment was asked to begin, marked on a card just above the first row of
copy. It was 272, roughly two lines further up.

The shorter run-up is a real trade and it goes the wrong way on the thing this
treatment exists to avoid: the darkening now has 556px to build across instead
of 763, so its steepest run goes from 0.30 to 0.35 levels/px and lands just
below the first line rather than above it. It is still five times gentler than
the 2.0 cliff this started from, and measured on a smooth source no row departs
from its local slope by more than 0.96 of 255 with none stepping at all — so
there is no edge to find. But `window.GLASS.runUpAboveCopy = 272` is the way
back if one ever appears.

Two knobs moved with it. `frostReach` is now a multiple of where the copy line
falls rather than a fraction of the band, so the blurred layer is fully present
exactly at the first line whatever the run-up is — a fixed fraction silently
pushes the frost *below* the copy when the run-up shortens, which puts the
sharp original back under the very lines the split was made to clear. And
`blurCurve` goes 2 → 1: the lag existed to keep the radius climbing below the
type, and with the copy line now a tenth of the way into the band, nearly all
of the ramp is below it already. The lag had nothing left to protect and was
starving the first lines — σ 1.6 at line one with it, 10.1 without.

### Two ramps, and why the blur was invisible

The frost and the darkening used to share one mask: the blurred picture and the
dark fill were stacked into one canvas and a single ramp faded the whole stack
in. That is why the card read as sharp near the copy however large the radius
got — **at half mask alpha you are not looking at a half-blurred picture, you
are looking at a blurred one at half strength over the sharp original at half
strength, and the eye takes its reading of focus from the sharp component.**
Measured: the strip loop asked for σ 52 at line three and the composite showed
a 1px edge, because presence there was 60%.

So the blurred layer has its own faster ramp (`frostReach`, 0.35 — about the
first line) and the dark fill keeps the long gentle one. Below that point there
is no sharp copy left anywhere, and the radius can grow under a solid layer.

There was a second bug underneath it. `stripBlur` was computed as
`blurTarget / downscale` and then set on the **full-size** context, so the
division landed in the wrong coordinate space and was simply lost — the card
received about a quarter of the radius the code asked for. The comment
defending it ("most of the blur comes free from the downsample") had the
premise wrong too: downsampling by four discards detail finer than four pixels,
it does not multiply a later blur by four.

Applying the radius honestly on the full-size context is correct and
unaffordable — **140ms a paint against 3ms**. The band is already held at
1/`downscale` for the read-back, and a blur applied *there* is multiplied by
the upscale on the way out: σ 15 on the quarter-size copy lands as σ 60 on the
card over a sixteenth of the pixels. So `blurLevels` pre-blurred copies are
built once and each strip draws from the one matching its depth.

Delivered σ on a 920 card, measured off the 10–90% width of a hard edge
(= 2.563 σ):

| | at the line | line 1 | line 2 | line 3 | line 5 | foot |
|---|---|---|---|---|---|---|
| originally delivered | 0.4 | 0.4 | — | 3.9 | 5.9 | 16.4 |
| now | **0.4** | 10.1 | 29.3 | 39.8 | 67.5 | **99.1** |

The picture above the band stays sharp, the darkening is untouched (peak slope
0.30 levels/px, still above the first line), and the worst row departs from its
local slope by 0.94 of 255 with none stepping at all. About 3ms a page.

**Both ramps follow one profile.** `specAlpha` is the design's gradient — three
stops, transparent, 80% at 63% of the way down, full at the foot — interpolated
linearly, which is what the design tool does. `rampAlpha` is that profile with
its onset eased, and it is what the glass mask, the blur radius and the bottom
fade all sample.

The fade is then scaled by `GLASS.fadeMax` (0.24), because the glass fill does
most of the darkening: it contributes the *shape* at a quarter of full strength.

**The fill and the fade multiply, they do not add.** The fade darkens what the
fill let through, so what has to stay bounded is `(1 - fillAlpha) x (1 - fadeMax)`
— the fraction of the photograph still visible at the foot. At 0.88 and 0.24
that is 9.1%; below about 7% the picture stops reading as one and the card is a
black panel with type on it. `test/glass.mjs` used to check `fillAlpha + fadeMax
<= 1.06`, which is the wrong arithmetic in both directions.

Darkening also bought back legibility that had quietly gone thin. White headline
type on a bright photograph measured **3.28:1** at the first line before this —
passing AA for large text by a hair, failing AA body. It is **3.70:1** now, and
lines two and below clear 4.5:1.

### Why the transition used to be findable, and what fixed it

Reported repeatedly as a visible edge above the first line, and survived about
ten rounds of tuning the *curve* — smoothstep vs smootherstep, 13 stops vs 64,
per-strip radii. None of it helped, because the curve was never the problem.

Measured off the rendered card, the old geometry put **92 of the 95 available
levels of darkening inside 120px**, from line one to line three, against three
levels across the whole run-up above it. The glass band started *at* `copyTop`
and reached full strength 123px later, a quarter of the way into a 491px band,
then sat flat. Peak slope **1.22% of the total per pixel against the design's
0.21%** — six times steeper, and landing exactly where the type is.

Three changes, in order of how much each was worth:

1. **A run-up.** The band starts `runUpAboveCopy` (272px) above the first line
   instead of on it, so the onset lands in open picture with no type beside it
   to measure the change against. 48% of the build now happens above line one;
   it was 3%.
2. **The ramp runs the whole band** rather than finishing in its first quarter
   onto a flat panel. Every level not spent over the full height had to be
   spent in that 123px.
3. **Half the blur.** The transition is carried by the darkening, which the eye
   cannot check, rather than by sharpness, which it can.

Measured after: peak slope **0.25 levels/px against 2.0**, eight times gentler,
and it now falls 160px *above* the first line. Against a source with no
horizontal structure, no row anywhere departs from its local slope by more than
1.04 of 255 levels — the 8-bit quantisation floor. Render cost went *down*,
3.7ms from 9.2ms, because the smaller radius lets more strips share a filter.

**Easing the onset is not free, and the obvious way is wrong.** The design's
profile is piecewise linear: it goes from not climbing to climbing at full rate
over no distance, and a step in *slope* is what the eye is good at — it is why a
gradient built from a few stops shows a line at every join though its values are
continuous. Multiplying the curve by a smoothstep does start it from zero and
pays for it with a patch **1.69× steeper** a fifth of the way down (measured:
0.28 levels/px against an average of 0.13). So `rampAlpha` applies the window to
the *slope* and renormalises — it accelerates from a standstill, never climbs
faster than it must, and still lands at 1. Peak comes down to 1.43× average.
`test/glass.mjs` asserts both halves, because checking only the onset is how the
multiply version passed.

**Two rules worth knowing before touching either:**

- **Sample curves densely.** `addColorStop` interpolates *linearly*, so a curve
  described by a few stops is a few straight segments with a slope change at
  each join. The eye resolves a change in slope far more readily than a change
  in value — that is Mach banding, and it appears as a hard line where the
  frost begins. The fade samples 48 times, the glass mask 64.
- **The blur ramps its radius, not its opacity.** Fading one fully-blurred
  layer in leaves a sharp copy of the picture superimposed mid-transition,
  which the eye finds however smooth the alpha curve is. Each refraction strip
  carries its own radius instead, so every depth is a single genuinely blurred
  image.
- **Blur needs padding.** A blur samples outward, and past the canvas edge there
  is nothing; those samples return transparent and the sharp original shows
  through as an unblurred strip at the foot. The frame is padded and edge-
  extended before blurring, then cropped back.

---

## 6. Performance

`renderPoster()` repaints every page and the X preview. Two things keep that
affordable, and both are load-bearing:

- **The glass reuses its scratch canvases.** It allocated two per call, once per
  page — about 10MB per render, ~100MB/s while typing, which froze the editor.
- **Continuous input coalesces into one paint per frame.** Typing, sliders and
  drags schedule a repaint rather than forcing one. 60 keystrokes → 1 paint.

`renderPoster()` itself is **never** deferred. The export path, the X preview
and the screen-preview modal paint and then read the canvas back in the same
tick; deferring them would publish a card missing its last edit.

Current cost: ~5ms median per render, 0 dropped frames while typing.

---

## 7. Environment

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | — | Required for Restore & Upscale. Without it the route returns 503 |
| `IMAGE_QUALITY` | **`medium`** | `low` \| `medium` \| `high`. The code default is `medium` (`server.mjs:175`, `:5176`) — this table said `high` for a while, which is wrong and four times the price. `low` is the clay-face setting and fires a boot warning; `medium` is the intended floor. See §2.6 |
| `IMAGE_MODEL` | `gpt-image-1.5` | Which model the route calls. **Shuts down 1 Dec 2026** — see §2.9 |
| `IMAGE_MODEL_FALLBACK` | `gpt-image-1` | Tried on 400/403/404, for an account without the above. Same shutdown date |
| `DISABLE_GPT_IMAGE` | unset | `true` switches the route off and returns 503 |
| `PEXELS_API_KEY` | — | Stock images; source skipped silently when unset |
| `FAL_KEY` | — | Flux generation |

---

## 8. Tests

No runner, no dependencies. Each exits non-zero on failure.

```bash
node test/image-fit.mjs   # fit/fill geometry, letterbox centring, pan clamp
node test/glass.mjs       # panel colour, mask sampling, device transform, fade
node test/render.mjs      # render coalescing, and that export stays synchronous
node test/highlight-tones.mjs # which bracket paints which accent colour
node test/enhance-params.mjs # cache identity, and the output shape the plan asks for
node test/expand-frame.mjs # expand placement, mask, paste-back, and the card crop
```

They execute the real functions pulled out of `public/app.js` rather than
reimplementing them, and read constants from the source — a test that hard-codes
the value it checks only proves the file was edited twice.
# Existing signage and logos

Restore, Reframe and Expand must retain existing lettering and branding,
including signs attached to buildings and products. The Reframe prompt formerly
said "No text, captions, logos or watermarks", which conflicted with preserving
the source. It now distinguishes existing marks from new additions in every
subject category. The result cache includes the actual edit prompt.

This improves the instructions but is not a pixel-preservation guarantee for
generative Reframe/Restore. Review source signage before publishing. A previously
saved result with erased signage must be restored to the original source before
running the updated request; changing the prompt cannot repair saved images.
