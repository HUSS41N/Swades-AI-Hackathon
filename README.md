# Attack Capital — Recording & transcription studio

Monorepo for a **browser + API transcription studio**: live sliding-window chunking, single-take Whisper, built-in samples, file upload, and an **optional Redis-backed job queue** for async full-file jobs. PostgreSQL is used for health checks and a small chunk-ack demo schema.

---

## What we built

- **Live chunking** — Mic → 1 s PCM chunks → rolling 5 s window (3 s step, 2 s overlap) → `POST /api/transcribe` with `gpt-4o-mini-transcribe` → merge and dedupe in the browser. Unstable vs stable transcript UI with a small buffer visualizer.
- **Single Whisper** — One-shot recording → full file `whisper-1` via sync API; optional Web Speech API captions where supported.
- **Samples + upload** — Curated WAVs under `apps/web/public/samples`; each row supports **Full Whisper**, **Chunk mini** (same client pipeline as live), and **Queue** (async API path).
- **Async transcription** — `POST /api/transcribe/async` enqueues work when **Redis** is configured and healthy; otherwise the same request is handled **inline** (no queue) so local dev works without Redis.
- **In-process worker** — With Redis, a background consumer drains a Redis list, runs OpenAI transcription, and stores job status for `GET /api/transcribe/jobs/:id`.
- **Docs in the app** — [`/docs`](http://localhost:3001/docs) explains live chunking vs upload → queue → worker (mirrors this README at a high level).
- **Docker** — Compose brings up Postgres, **Redis**, API (with `ioredis` **external** to the esbuild bundle + runtime install in the API image), migrate, and Next.js web.

---

## Architecture

### Live chunking (real-time)

```
Microphone → Web Audio (1 s frames) → sliding 5×1 s buffer
    → WAV per window → POST /api/transcribe (mini model)
    → responses ordered + merged → Unstable / Stable UI
```

No Redis involved; each window is a synchronous HTTP call from the client’s perspective.

### Upload / sample → optional queue

```
Browser → POST /api/transcribe/async (multipart, same as sync)
    ├─ Redis UP   → store payload + job id → worker → OpenAI → job record
    │                 UI polls GET /api/transcribe/jobs/:jobId
    └─ Redis DOWN / unset → transcribe in the request → return text (queued: false)
```

### Backend services

| Piece | Role |
|--------|------|
| **Hono API** | `/health`, `/api/transcribe`, `/api/transcribe/async`, `/api/transcribe/jobs/:id`, `/api/chunks/*` |
| **PostgreSQL** | Drizzle schema; DB ping in `/health` |
| **Redis (optional)** | Job queue + payload keys + status keys |
| **OpenAI** | `OPENAI_API_KEY` on server; never commit keys |

### Health response

`GET /health` includes `database`, `redis` (`ok` \| `skipped` \| `error`), and `transcribeQueue` (`redis` \| `inline`).

---

## Tech stack

- **Next.js** (App Router) — `apps/web`
- **Hono** + **@hono/node-server** — `apps/server` (dev via **tsx**; production **Node** + bundled `dist/index.js`)
- **Drizzle ORM + PostgreSQL** — `packages/db`
- **Redis + ioredis** — optional queue (not bundled; see `docker/Dockerfile.api`)
- **Tailwind CSS + shadcn-style UI** — `packages/ui`, `apps/web`
- **Turborepo** — `turbo.json`

---

## Getting started

```bash
npm install
```

### Database

1. Start Postgres (e.g. `npm run docker:db` — postgres service from `docker-compose.yml` on `localhost:5432`, db `attack_capital`).
2. Copy `apps/server/.env.example` → `apps/server/.env` and set `DATABASE_URL`.
3. `npm run db:push`

### Run dev

```bash
npm run dev
```

- Web: [http://localhost:3001](http://localhost:3001)
- API: [http://localhost:3000](http://localhost:3000)

### OpenAI

In `apps/server/.env`:

```bash
OPENAI_API_KEY=sk-...
```

Optional queue:

```bash
REDIS_URL=redis://localhost:6379
```

**Never commit API keys.** Compose can load `apps/server/.env` into the `api` service; `DATABASE_URL` in Compose still targets the `postgres` service.

### Full stack in Docker

```bash
docker compose up --build
```

Includes **Redis** and sets `REDIS_URL` for the API. Rebuild the **web** image if you change `NEXT_PUBLIC_API_URL` / `WEB_ORIGIN`.

---

## Future scope & improvements

- **Durable upload pipeline** — Align with the original “OPFS → object storage → DB ack → reconciliation” story; current UI focuses on transcription and an optional Redis queue, not bucket + OPFS.
- **Separate worker process** — Run queue consumers out of the API process for scale; use BullMQ or similar if you need retries, dead-letter, and metrics.
- **Object storage for large async jobs** — Avoid storing big base64 payloads in Redis; pass S3/GCS URLs in job messages.
- **Auth & rate limits** — Protect `/api/transcribe` and job endpoints in production.
- **Streaming transcription** — Server-sent events or WebSocket for partial tokens if the model/API supports it.
- **Tests** — Contract tests for `/health`, sync/async transcribe, and job polling; e2e for the studio flows.
- **Accessibility** — Deeper audit of live controls, focus order, and ARIA on custom toggles.

---

## Load testing (chunk ack API)

The repo still includes an example **k6** script target for `POST /api/chunks/upload` (Postgres ack demo). For 300K-style runs, point k6 at your API and tune VUs/rate. Validate DB write success and latency; this path is separate from the OpenAI transcription routes.

---

## Project structure

```
├── apps/
│   ├── web/                 # Next.js studio + /docs
│   └── server/              # Hono API, transcribe + optional Redis worker
├── docker/
│   ├── Dockerfile.api       # esbuild bundle; ioredis installed in runner
│   └── Dockerfile.web
├── docker-compose.yml       # postgres, redis, db-migrate, api, web
├── packages/
│   ├── ui/                  # Shared UI, sample registry
│   ├── db/                  # Drizzle schema
│   ├── env/                 # Zod env for web + server
│   └── config/              # TypeScript config
```

WAV samples: registry in `packages/ui/src/samples/registry.ts`; files served from `apps/web/public/samples/`.

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Dev for all apps |
| `npm run build` | Production build |
| `npm run dev:web` / `dev:server` | Single app |
| `npm run check-types` | Typecheck |
| `npm run db:push` | Push Drizzle schema |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle tooling |
| `npm run docker:db` | Postgres only via Compose |
