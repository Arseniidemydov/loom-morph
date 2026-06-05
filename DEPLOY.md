# Deploying Loom Morph on a VM

The fast path to rendering large batches without re-architecting anything:
run the existing single-process app on **one big multi-core VM**. Recording
mode parallelizes across browser contexts, so throughput scales with cores —
70 videos drop from ~35 min (laptop, ~2 in parallel) to ~5–7 min (16-core VM,
~12 in parallel). SQLite + local-disk output are kept; there's no database,
queue, or object store to operate.

## TL;DR

```bash
# Build the image (includes Chrome, ffmpeg, fonts)
docker build -t loom-morph .

# Run it, persisting the DB + rendered videos, and sizing concurrency to the box
docker run -d --name loom-morph \
  -p 3000:3000 \
  --shm-size=2g \
  -e LOOM_CAPTURE_CONCURRENCY=12 \
  -e LOOM_RENDER_CONCURRENCY=10 \
  -v loom-data:/app/data \
  -v loom-output:/app/output \
  loom-morph
```

Open `http://<vm-ip>:3000`. Put it behind a reverse proxy (Caddy/Nginx) for
TLS + a password if it's internet-facing.

## Sizing the VM and concurrency

Recording mode is part real-time wait (cheap) and part CPU (Chromium render +
ffmpeg encode). Rules of thumb:

| VM size              | `LOOM_CAPTURE_CONCURRENCY` | `LOOM_RENDER_CONCURRENCY` | ~70 videos |
|----------------------|---------------------------|---------------------------|-----------|
| 8 vCPU / 16 GB       | 8                         | 6                         | ~9–12 min |
| 16 vCPU / 32 GB      | 12–14                     | 10                        | ~5–7 min  |
| 32 vCPU / 64 GB      | 20–24                     | 16                        | ~3–4 min  |

- **Capture** concurrency is limited mostly by **RAM** — each Chromium context
  + WebM buffer is a few hundred MB. ~1.5–2 GB per concurrent recording is a
  safe budget.
- **Render** concurrency is limited by **cores** — libx264 is CPU-bound (no
  GPU encode on Linux). Keep it around cores − a couple so the box stays
  responsive.
- Start at the table values and watch `htop`/memory; raise capture until RAM
  is ~80% used, raise render until CPU is saturated but not thrashing.

`--shm-size=2g` matters: headless Chrome OOM-crashes on the default 64 MB
`/dev/shm`. The image also sets `--disable-dev-shm-usage` as a belt-and-braces
fallback (via `LOOM_CONTAINER=1`), but the larger shm is still recommended.

## Persistence

Two volumes hold all durable state:
- `/app/data` — the SQLite database (`loom-morph.sqlite`) = batch + lead state.
- `/app/output` — rendered `.mp4`s + `report.csv` per batch.

`uploads/` and `tmp/` are scratch (circle/audio inputs and screenshots) and are
fine to lose between runs. Back up the two named volumes if the batch history
matters to you.

## Hosts (any of these work — pick by familiarity)

- **Plain VPS** (Hetzner, DigitalOcean, Linode): `docker build` + `docker run`
  as above on an Ubuntu box. Cheapest for an always-on, frequent-use setup.
- **Container PaaS** (Render, Railway, Fly.io): point it at this repo's
  `Dockerfile`; set the env vars in the dashboard; attach a persistent volume
  mounted at `/app/data` and `/app/output`. Least ops.
- **Start/stop to save money**: if batches are bursty, run on a VM you stop
  when idle — state survives on the mounted volumes.

## Env vars

| Var                        | Default (image) | Meaning |
|----------------------------|-----------------|---------|
| `LOOM_CAPTURE_CONCURRENCY` | 8               | Concurrent page captures/recordings |
| `LOOM_RENDER_CONCURRENCY`  | 6               | Concurrent ffmpeg encodes |
| `LOOM_CONTAINER`           | 1 (set in image)| Enables container Chrome flags (`--no-sandbox`, `--disable-dev-shm-usage`) |
| `LOOM_DATA_ROOT`           | (unset)         | Relocate ALL state (SQLite, uploads, tmp, output) under one dir. Set this to a single mounted disk on hosts that allow only one volume (e.g. Render). |
| `PORT`                     | 3000            | HTTP port |

Leaving the concurrency vars unset falls back to laptop-safe defaults
(capture 5, render `min(cpus−1, 5)`).

## Render (one-disk model)

Render attaches a single **Persistent Disk** per service at one mount path, so
point all state there with `LOOM_DATA_ROOT` (not the two separate `/app/data`
+ `/app/output` volumes used by `docker run`).

1. Push this branch and connect the repo in Render: **New → Web Service**,
   Runtime **Docker** (it reads the `Dockerfile`).
2. Pick an instance with enough CPU/RAM (see the sizing table above — e.g. a
   16 vCPU / 32 GB plan).
3. Add a **Persistent Disk**, mount path `/data` (any size for your video
   volume, e.g. 20–50 GB).
4. Set environment variables:
   - `LOOM_DATA_ROOT=/data`
   - `LOOM_CAPTURE_CONCURRENCY` / `LOOM_RENDER_CONCURRENCY` sized to the plan
   - (`LOOM_CONTAINER=1` is already baked into the image)
5. Deploy. Your batches, DB, and rendered videos now all live on the disk and
   survive redeploys.

Note: a service with a Persistent Disk runs a single instance (no horizontal
scaling, no zero-downtime deploys) — which is exactly the single-VM model here.

## Note on recording quality in containers

The image installs **Google Chrome stable** and the code launches it via
`channel: 'chrome'`. This is required: Playwright's bundled Chromium lacks the
H.264/AAC codecs, so hero videos would record as a frozen poster frame. If you
build a custom image, keep `google-chrome-stable` installed or recording-mode
output quality degrades silently (one warning is logged at startup).
