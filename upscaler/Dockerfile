# PIX Free Upscaler: Real-ESRGAN x2, CPU only. Deployed as its own Railway
# service with Root Directory = upscaler.
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch keeps the image ~1 GB instead of ~5 GB with CUDA.
RUN pip install torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install spandrel==0.4.0 fastapi==0.115.0 "uvicorn[standard]==0.30.6" \
      pillow==10.4.0 "numpy<2"

# Official Real-ESRGAN x2 weights (67 MB), baked in so startup is offline.
RUN mkdir -p /app/weights \
 && wget -q https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth \
      -O /app/weights/RealESRGAN_x2plus.pth

COPY app.py /app/app.py

# Railway injects PORT.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 300"]
