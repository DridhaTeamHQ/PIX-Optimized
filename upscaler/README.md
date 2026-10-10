# PIX Free Upscaler (Railway)

The AI half of the **Free Upscale** button. It runs **Real-ESRGAN x2** on CPU
in its own Railway service, so it costs no OpenAI credits, only the service's
Railway compute.

Real-ESRGAN enlarges and cleans the pixels that are already in the photo
(sharper edges, less blur, less JPEG blockiness). It has no face model, so it
does not redraw people.

## How PIX uses it

When a reviewer clicks **Free Upscale**:

| Photo (long edge) | What runs |
|---|---|
| Under 1024px | This service: Real-ESRGAN x2 (about 5 s to 2 min, depending on size and CPU) |
| 1024px or larger, or this service is not set up / not responding | The main PIX server's ffmpeg resize + sharpen (about 1 s) |

The 1024px switch is `FREE_AI_MAX_EDGE` on the main PIX service.

## Deploy on Railway

1. In the Railway project, click **New Service → GitHub Repo** and pick
   `DridhaTeamHQ/PIX-Optimized`.
2. In the new service's **Settings**, set **Root Directory** to `upscaler`.
   Railway then builds this folder's `Dockerfile`, not the Node app. The
   first build takes about 3 to 5 minutes.
3. In the new service's **Variables**, add:

   | Name | Value |
   |---|---|
   | `UPSCALER_SECRET` | a long random password you make up |

4. In **Networking**, click **Generate Domain** and copy the URL, for example
   `https://pix-upscaler-production.up.railway.app`.
5. Check it: open `https://<that-domain>/health`. It should show
   `{"ok":true,"engine":"real-esrgan-x2",...}`.

## Connect it to PIX

In the **main PIX service's** Variables, add:

| Name | Value |
|---|---|
| `UPSCALER_URL` | the URL from step 4 |
| `UPSCALER_SECRET` | the same password as in step 3 |

The main service redeploys. After that, Free Upscale on a small photo shows
"Free Upscale done (AI detail restore)" in the status line.

## Optional settings (upscaler service)

| Name | Default | What it does |
|---|---|---|
| `ENHANCE_STRENGTH` | `0.85` | How much of the AI result to keep (0 to 1). Lower looks more natural on skin, higher is sharper. |
| `MAX_INPUT_EDGE` | `1024` | Larger inputs are shrunk to this first, to keep the time down. |
| `TILE` | `256` | The photo is processed in tiles of this size. Smaller uses less memory, larger is a little faster. |
| `TORCH_THREADS` | all cores | CPU threads to use. |

## Speed

Measured on a 16-core PC: a 300px photo took about 5 s and a 900px photo
about 55 s. Railway machines usually have fewer cores, so expect it to be
slower there. Giving the service more CPU in Railway makes it faster.

## Run locally

With Docker:

```bash
cd upscaler
docker build -t pix-upscaler .
docker run -p 8765:8000 -e UPSCALER_SECRET=localtest pix-upscaler
```

Then, in the main project's `.env`:

```
UPSCALER_URL=http://127.0.0.1:8765
UPSCALER_SECRET=localtest
```

Test it directly:

```bash
curl -X POST -H "X-Secret: localtest" -H "Content-Type: image/jpeg" --data-binary @photo.jpg http://127.0.0.1:8765/enhance --output out.png
```

## API

- `GET /health` returns `{"ok": true, "engine": "real-esrgan-x2", "strength": 0.85}`
- `POST /enhance`: send the raw image bytes in the body, get a PNG back.
  - `X-Secret`: required when `UPSCALER_SECRET` is set
  - `X-Enhance-Strength`: optional, 0 to 1, overrides `ENHANCE_STRENGTH`
