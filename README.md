# Reliable Recording Chunking Pipeline

An assignment for building a reliable chunking setup that ensures recording data stays accurate in all cases — no data loss, no silent failures.

## How It Works

```
Client (Browser)
    │
    ├── 1. Record & chunk data on the client side
    ├── 2. Store chunks in OPFS (Origin Private File System)
    ├── 3. Upload chunks to a storage bucket
    ├── 4. On success → acknowledge (ack) to the database
    │
    └── Recovery: if DB has ack but chunk is missing from bucket
        └── Re-send from OPFS → bucket
```

**Main objective:** In all cases, the recording data stays accurate. OPFS acts as the durable client-side buffer — chunks are only cleared after the bucket and DB are both confirmed in sync.

### Flow Details

1. **Client-side chunking** — Recording data is split into chunks in the browser
2. **OPFS storage** — Each chunk is persisted to the Origin Private File System before any network call, so nothing is lost if the tab closes or the network drops
3. **Bucket upload** — Chunks are uploaded to a storage bucket (can be a local bucket for testing, e.g. MinIO or a local S3-compatible store)
4. **DB acknowledgment** — Once the bucket confirms receipt, an ack record is written to the database
5. **Reconciliation** — If the DB shows an ack but the chunk is missing from the bucket (e.g. bucket purge, replication lag), the client re-uploads from OPFS to restore consistency

## Tech Stack

- **Next.js** — Frontend (App Router)
- **Hono** — Backend API server
- **Bun** — Runtime
- **Drizzle ORM + PostgreSQL** — Database
- **TailwindCSS + shadcn/ui** — UI
- **Turborepo** — Monorepo build system

## Getting Started

```bash
npm install
```

You can use [Bun](https://bun.sh) instead (`bun install`). The API server defaults to **Node + `tsx`** for `npm run dev` so the monorepo works without Bun; with Bun installed, run **`bun run dev:bun`** from `apps/server` for a Bun-native watch process.

### Database Setup

1. Run PostgreSQL (local install or Docker — recommended for a quick match with Compose credentials):

```bash
npm run docker:db
```

This starts only the **`postgres`** service from `docker-compose.yml` on `localhost:5432` (user / password / database: `postgres` / `postgres` / `attack_capital`).

2. Copy `apps/server/.env.example` to `apps/server/.env` and set **`DATABASE_URL`** (the example already targets that Docker database).

3. Apply the schema:

```bash
npm run db:push
```

### Run Development

```bash
npm run dev
```

- Web app: [http://localhost:3001](http://localhost:3001)
- API server: [http://localhost:3000](http://localhost:3000)

### Voice transcription (Whisper)

The home page (`/`) has **Live** (mic → Whisper) and **Upload** (audio file → Whisper). Live mode can show a **browser caption** (Web Speech API where supported). Both call **`POST /api/transcribe`** (`whisper-1` on the server). Set in `apps/server/.env`:

```bash
OPENAI_API_KEY=sk-...your-key...
```

**Never commit API keys.** If a key was pasted into chat or committed, [rotate it](https://platform.openai.com/api-keys) in the OpenAI dashboard. **`docker compose`** loads **`apps/server/.env`** into the **`api`** container (optional if the file is missing). `DATABASE_URL` in Compose still overrides that file so the API uses the **postgres** service, not `localhost`.

### Docker (Postgres + API + UI)

For **everything** in containers (Postgres, migrate, API, Next), use:

One Compose file builds the Hono API image and the Next.js image, runs PostgreSQL, applies the Drizzle schema (`db-migrate`), then starts **api** and **web**:

```bash
docker compose up --build
```

- Postgres: `localhost:5432` (user/password/db: `postgres` / `postgres` / `attack_capital`)
- API: [http://localhost:3000](http://localhost:3000)
- Web: [http://localhost:3001](http://localhost:3001)

The browser bundle is built with `NEXT_PUBLIC_API_URL=http://localhost:3000`. For another public URL, rebuild the web service with a different build arg (see `docker-compose.yml`) and set **`WEB_ORIGIN`** on the API to match where the UI is served (comma-separated allowed).

## Load Testing

Target: **300,000 requests** to validate the chunking pipeline under heavy load.

### Setup

Use a load testing tool like [k6](https://k6.io), [autocannon](https://github.com/mcollina/autocannon), or [artillery](https://artillery.io) to simulate concurrent chunk uploads.

Example with **k6**:

```js
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    chunk_uploads: {
      executor: "constant-arrival-rate",
      rate: 5000,           // 5,000 req/s
      timeUnit: "1s",
      duration: "1m",       // → 300K requests in 60s
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
};

export default function () {
  const payload = JSON.stringify({
    chunkId: `chunk-${__VU}-${__ITER}`,
    data: "x".repeat(1024), // 1KB dummy chunk
  });

  const res = http.post("http://localhost:3000/api/chunks/upload", payload, {
    headers: { "Content-Type": "application/json" },
  });

  check(res, {
    "status 200": (r) => r.status === 200,
  });
}
```

Run:

```bash
k6 run load-test.js
```

### What to Validate

- **No data loss** — every ack in the DB has a matching chunk in the bucket
- **OPFS recovery** — chunks survive client disconnects and can be re-uploaded
- **Throughput** — server handles sustained 5K req/s without dropping chunks
- **Consistency** — reconciliation catches and repairs any bucket/DB mismatches after the run

## Project Structure

```
recoding-assignment/
├── apps/
│   ├── web/         # Frontend (Next.js) — chunking, OPFS, upload logic
│   └── server/      # Backend API (Hono) — bucket upload, DB ack
├── docker/
│   ├── Dockerfile.api   # API + db-migrate stages
│   └── Dockerfile.web   # Next.js standalone image
├── docker-compose.yml   # postgres, db-migrate, api, web
├── packages/
│   ├── ui/          # Shared shadcn/ui, `src/samples` registry + `/samples/*.wav` in web `public/`
│   ├── db/          # Drizzle ORM schema & queries
│   ├── env/         # Type-safe environment config
│   └── config/      # Shared TypeScript config
```

## Available Scripts

- `npm run dev` — Start all apps in development mode
- `npm run build` — Build all apps
- `npm run dev:web` — Start only the web app
- `npm run dev:server` — Start only the server
- `npm run check-types` — TypeScript type checking
- `npm run db:push` — Push schema changes to database
- `npm run db:generate` — Generate database client/types
- `npm run db:migrate` — Run database migrations
- `npm run db:studio` — Open database studio UI
- `npm run docker:db` — Start only PostgreSQL via Docker Compose (for local API + Next)