# Attack Capital — Recording & transcription studio

Monorepo for a **browser + API transcription studio**: live sliding-window chunking, single-take Whisper, built-in samples, file upload, and an **optional Redis-backed job queue** for async full-file jobs. PostgreSQL is used for health checks and a small chunk-ack demo schema.

---

## Live deployment (cloud)

This project is deployed with the **UI on Vercel** and the **API on Railway**.

| | URL |
|---|-----|
| **Studio (Next.js)** | [https://swades-ai-hackathon-web-roan.vercel.app](https://swades-ai-hackathon-web-roan.vercel.app) |
| **API (Hono)** | [https://server-production-e1e9.up.railway.app](https://server-production-e1e9.up.railway.app) |
| **API health** | [https://server-production-e1e9.up.railway.app/health](https://server-production-e1e9.up.railway.app/health) |

The Vercel app must have `NEXT_PUBLIC_API_URL` set to the Railway API base (no trailing slash). The Railway service must list the Vercel origin in `WEB_ORIGIN` so the browser can call the API without CORS errors. See [Production CORS](#production-cors-eg-vercel--railway).

---

## How to run

### Prerequisites

- **Node.js** 20+ and **npm** (see root `package.json` for `packageManager`).
- **Docker Desktop** (or compatible engine) if you use Compose for Postgres / full stack.

### Option A: Local development (recommended first time)

Do these steps **in order**:

1. **Install dependencies** (from the repo root):

   ```bash
   npm install
   ```

2. **Server environment** — Copy the template and edit values:

   ```bash
   cp apps/server/.env.example apps/server/.env
   ```

   | Variable | Required | Notes |
   |----------|----------|--------|
   | `DATABASE_URL` | Yes | e.g. `postgresql://postgres:postgres@localhost:5432/attack_capital` for local Compose Postgres |
   | `OPENAI_API_KEY` | Yes | For `/api/transcribe` and related routes |
   | `WEB_ORIGIN` | Yes for browser CORS | Default `http://localhost:3001` matches the Next.js dev port |
   | `REDIS_URL` | No | If set and reachable, async jobs use Redis; otherwise they run inline |
   | `API_PORT` | No | Defaults to `3000` |

3. **Web environment** — Point the UI at your API:

   ```bash
   cp apps/web/.env.example apps/web/.env.local
   ```

   Set `NEXT_PUBLIC_API_URL=http://localhost:3000` (no trailing slash).

4. **Start PostgreSQL** (pick one):

   - **Compose (Postgres only):** `npm run docker:db`
   - **Full stack:** skip to [Option B: Docker Compose](#option-b-docker-compose-full-stack) instead.

5. **Apply the database schema:**

   ```bash
   npm run db:push
   ```

6. **Start web + API together:**

   ```bash
   npm run dev
   ```

7. **Open the app**

   - **Studio:** [http://localhost:3001](http://localhost:3001)
   - **API health:** [http://localhost:3000/health](http://localhost:3000/health)
   - **In-app architecture notes:** [http://localhost:3001/docs](http://localhost:3001/docs)

**Transcription will not work** until `OPENAI_API_KEY` is set on the server. If `/health` shows a database error, confirm Postgres is up and `DATABASE_URL` matches.

### Option B: Docker Compose (full stack)

From the repo root:

```bash
docker compose up --build
```

This starts Postgres, optional Redis, migrations, the API, and the web app as defined in `docker-compose.yml`. Rebuild the **web** image if you change `NEXT_PUBLIC_API_URL` or `WEB_ORIGIN` baked into the build.

### Option C: One app at a time

```bash
npm run dev:server   # API only (port from API_PORT, default 3000)
npm run dev:web      # Next.js only (default 3001); still needs API URL in .env.local
```

### After it runs

- Run **`npm run check-types`** before commits if you change shared packages.
- Run **`npm exec -- ultracite fix`** (per `AGENTS.md`) to format/lint where configured.

### Deploying (Vercel + Railway, etc.)

For the **live deployment** above, the same rules apply: Railway **`WEB_ORIGIN`** must include `https://swades-ai-hackathon-web-roan.vercel.app`, and Vercel **`NEXT_PUBLIC_API_URL`** must be `https://server-production-e1e9.up.railway.app`. For other environments, set **`WEB_ORIGIN`** on the API to your real frontend origin (comma-separated for multiple) and **`NEXT_PUBLIC_API_URL`** on the frontend to the public API base URL. See [Production CORS](#production-cors-eg-vercel--railway) below.

---

## Architecture diagram

High-level system (GitHub and many Markdown viewers render Mermaid):

```mermaid
flowchart TB
  subgraph browser["Browser"]
    WEB["Next.js studio\napps/web"]
  end

  subgraph api["API apps/server"]
    HONO["Hono"]
    WORKER["In-process queue worker\nwhen Redis is enabled"]
    HONO --- WORKER
  end

  PG[("PostgreSQL\nschema + health")]
  REDIS[("Redis\noptional queue")]
  OAI[("OpenAI\naudio transcriptions")]

  WEB -->|"fetch NEXT_PUBLIC_API_URL /health /api/transcribe"| HONO
  HONO --> PG
  HONO --> REDIS
  HONO --> OAI
```

**Live chunking** (no Redis): the browser sends each 5 s window as its own HTTP `POST`; merging happens in the client.

```mermaid
flowchart LR
  MIC["Mic / Web Audio"] --> CH["1 s PCM chunks"]
  CH --> BUF["5 s sliding buffer\n3 s step, 2 s overlap"]
  BUF --> WAV["WAV per window"]
  WAV --> POST["POST /api/transcribe\nmini model"]
  POST --> OAI2["OpenAI"]
  OAI2 --> MERGE["Merge + dedupe\nin browser"]
  MERGE --> UI["Transcript UI"]
```

**Async full-file jobs** (optional Redis):

```mermaid
flowchart TB
  UI["Browser\nQueue button"] --> ASYNC["POST /api/transcribe/async"]
  ASYNC --> DEC{Redis OK?}
  DEC -->|Yes| Q["Enqueue job\n+ store payload"]
  DEC -->|No| INLINE["Transcribe in request\nqueued: false"]
  Q --> W2["Worker"]
  W2 --> OAI3["OpenAI"]
  UI --> POLL["GET /api/transcribe/jobs/:id"]
  POLL --> STATUS["completed / failed"]
```

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

## Architecture (reference)

### Live chunking (real-time)

ASCII summary (see Mermaid above):

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

## Production CORS (e.g. Vercel + Railway)

The API only reflects `Access-Control-Allow-Origin` for hosts listed in **`WEB_ORIGIN`** on the server. If the browser shows a CORS error, the frontend origin is missing from that list.

For this repo’s **live deployment**, use the URLs in [Live deployment (cloud)](#live-deployment-cloud): e.g. `WEB_ORIGIN=https://swades-ai-hackathon-web-roan.vercel.app` on Railway and `NEXT_PUBLIC_API_URL=https://server-production-e1e9.up.railway.app` on Vercel.

1. On **Railway** (or wherever the API runs), set `WEB_ORIGIN` to your **exact** frontend origin (scheme + host, no path):

   ```bash
   WEB_ORIGIN=https://your-app.vercel.app
   ```

   Local and production together:

   ```bash
   WEB_ORIGIN=http://localhost:3001,https://your-app.vercel.app
   ```

2. On **Vercel**, set `NEXT_PUBLIC_API_URL` to your public API base URL (no trailing slash), e.g. `https://your-service.up.railway.app`.

3. Redeploy the API after changing `WEB_ORIGIN`.

Trailing slashes in `WEB_ORIGIN` entries are ignored when matching; use `https://` and the exact hostname the browser sends in the `Origin` header.

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
