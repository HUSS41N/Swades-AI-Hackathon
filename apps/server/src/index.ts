import { chunkAcks, createDb } from "@repo/db";
import { getServerEnv } from "@repo/env/server";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import {
  MAX_ASYNC_AUDIO_BYTES,
  connectRedis,
  enqueueTranscribeJob,
  getJobRecord,
  redisPing,
  startTranscribeWorker,
  type TranscribeQueueContext,
} from "./transcribeQueue";

const env = getServerEnv(process.env);
const db = createDb(env.DATABASE_URL);

const queueCtx: TranscribeQueueContext | null = env.REDIS_URL
  ? connectRedis(env.REDIS_URL)
  : null;

/** Comma-separated in WEB_ORIGIN; trailing slashes stripped for matching. */
function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

const corsOrigins = parseCorsOrigins(env.WEB_ORIGIN);

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (requestOrigin) => {
      if (!requestOrigin) {
        return null;
      }
      const normalized = requestOrigin.replace(/\/$/, "");
      return corsOrigins.includes(normalized) ? requestOrigin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

const MAX_WHISPER_BYTES = 24 * 1024 * 1024;

const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

async function transcribeAudio(
  blob: Blob,
  filename: string,
  apiKey: string,
  model: string,
): Promise<
  | { text: string }
  | { error: string; status: 400 | 413 | 502 | 503 }
> {
  if (blob.size === 0) {
    return { error: "Empty audio file", status: 400 };
  }

  if (blob.size > MAX_WHISPER_BYTES) {
    return { error: "Audio exceeds 24MB limit", status: 413 };
  }

  const upstream = new FormData();
  upstream.append("file", blob, filename);
  upstream.append("model", model);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: upstream,
  });

  const raw = await res.text();
  if (!res.ok) {
    const status: 502 | 503 =
      res.status === 503 ? 503 : res.status === 429 ? 503 : 502;
    let message = raw.slice(0, 500) || `OpenAI error ${String(res.status)}`;
    try {
      const errBody = JSON.parse(raw) as {
        error?: { message?: string };
        message?: string;
      };
      const m =
        typeof errBody.error?.message === "string"
          ? errBody.error.message
          : typeof errBody.message === "string"
            ? errBody.message
            : null;
      if (m) {
        message = m;
      }
    } catch {
      /* keep raw slice */
    }
    return {
      error: message,
      status,
    };
  }

  try {
    const parsed = JSON.parse(raw) as { text?: string };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    return { text };
  } catch {
    return {
      error: "Invalid response from transcription service",
      status: 502,
    };
  }
}

app.get("/health", async (c) => {
  let database: "ok" | "error" = "ok";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    database = "error";
  }

  let redis: "ok" | "skipped" | "error" = "skipped";
  if (queueCtx) {
    redis = (await redisPing(queueCtx.redis)) ? "ok" : "error";
  }

  const transcribeQueue = queueCtx && redis === "ok" ? "redis" : "inline";

  return c.json({
    ok: true,
    service: "attack-capital-api",
    database,
    redis,
    transcribeQueue,
  });
});

app.get("/api/chunks", async (c) => {
  const items = await db.select().from(chunkAcks).limit(50);
  return c.json({ items });
});

app.post("/api/chunks/upload", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    chunkId?: string;
    data?: string;
  } | null;

  if (!body?.chunkId || typeof body.chunkId !== "string") {
    return c.json({ error: "chunkId is required" }, 400);
  }

  const [row] = await db
    .insert(chunkAcks)
    .values({ chunkId: body.chunkId })
    .onConflictDoUpdate({
      target: chunkAcks.chunkId,
      set: { acknowledgedAt: new Date() },
    })
    .returning();

  return c.json({
    ok: true,
    ack: row,
    receivedBytes: typeof body.data === "string" ? body.data.length : 0,
  });
});

app.get("/api/chunks/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");
  const [row] = await db
    .select()
    .from(chunkAcks)
    .where(eq(chunkAcks.chunkId, chunkId))
    .limit(1);

  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(row);
});

app.post("/api/transcribe", async (c) => {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        error:
          "OPENAI_API_KEY is not set on the server. Add it to apps/server/.env (never commit keys).",
      },
      503,
    );
  }

  const body = await c.req.parseBody();
  const audio = body.audio;

  if (!(audio instanceof Blob)) {
    return c.json(
      { error: "Multipart field `audio` (file) is required" },
      400,
    );
  }

  const filename =
    audio instanceof File && audio.name ? audio.name : "recording.webm";

  const modelRaw = body.model;
  const model =
    typeof modelRaw === "string" && modelRaw.trim().length > 0
      ? modelRaw.trim()
      : DEFAULT_TRANSCRIBE_MODEL;

  const result = await transcribeAudio(audio, filename, apiKey, model);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }

  return c.json({ ok: true, text: result.text, model });
});

/**
 * Async transcription: queues when Redis is healthy; otherwise same response as sync POST /api/transcribe.
 */
app.post("/api/transcribe/async", async (c) => {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        error:
          "OPENAI_API_KEY is not set on the server. Add it to apps/server/.env (never commit keys).",
      },
      503,
    );
  }

  const body = await c.req.parseBody();
  const audio = body.audio;

  if (!(audio instanceof Blob)) {
    return c.json(
      { error: "Multipart field `audio` (file) is required" },
      400,
    );
  }

  const filename =
    audio instanceof File && audio.name ? audio.name : "recording.webm";

  const modelRaw = body.model;
  const model =
    typeof modelRaw === "string" && modelRaw.trim().length > 0
      ? modelRaw.trim()
      : DEFAULT_TRANSCRIBE_MODEL;

  const buf = Buffer.from(await audio.arrayBuffer());

  if (buf.length > MAX_ASYNC_AUDIO_BYTES) {
    return c.json(
      {
        error: `Audio exceeds async limit (${String(MAX_ASYNC_AUDIO_BYTES)} bytes). Use sync /api/transcribe or smaller file.`,
      },
      413,
    );
  }

  const useQueue =
    queueCtx !== null && (await redisPing(queueCtx.redis));

  if (!useQueue) {
    const blob = new Blob([new Uint8Array(buf)]);
    const result = await transcribeAudio(blob, filename, apiKey, model);
    if ("error" in result) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json({
      ok: true,
      queued: false,
      text: result.text,
      model,
    });
  }

  const jobId = randomUUID();
  await enqueueTranscribeJob(queueCtx, {
    jobId,
    audioBuffer: buf,
    filename,
    model,
  });

  return c.json({
    ok: true,
    queued: true,
    jobId,
    model,
  });
});

app.get("/api/transcribe/jobs/:jobId", async (c) => {
  if (!queueCtx) {
    return c.json(
      { error: "Redis queue is not configured on this server" },
      503,
    );
  }

  const ok = await redisPing(queueCtx.redis);
  if (!ok) {
    return c.json({ error: "Redis is unavailable" }, 503);
  }

  const jobId = c.req.param("jobId");
  const record = await getJobRecord(queueCtx, jobId);

  if (!record) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json({ jobId, ...record });
});

if (queueCtx && env.OPENAI_API_KEY) {
  startTranscribeWorker(queueCtx, {
    transcribe: async (blob, filename, model) => {
      const key = env.OPENAI_API_KEY;
      if (!key) {
        return { error: "OPENAI_API_KEY missing", status: 503 };
      }
      return transcribeAudio(blob, filename, key, model);
    },
  });
  console.log("[transcribe-worker] started (Redis queue)");
} else if (queueCtx && !env.OPENAI_API_KEY) {
  console.warn(
    "[transcribe-worker] skipped: OPENAI_API_KEY unset (async jobs would fail)",
  );
}

serve(
  {
    fetch: app.fetch,
    port: env.API_PORT,
  },
  (info) => {
    console.log(`API listening on http://localhost:${String(info.port)}`);
  },
);
