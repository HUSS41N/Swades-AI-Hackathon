import Redis from "ioredis";

const QUEUE_KEY = "transcribe:queue";
const payloadKey = (id: string) => `transcribe:payload:${id}`;
const jobKey = (id: string) => `transcribe:job:${id}`;

/** ~15 MiB raw audio cap for async jobs (stored as base64 in Redis). */
export const MAX_ASYNC_AUDIO_BYTES = 15 * 1024 * 1024;

export type TranscribeJobRecord =
  | { status: "queued" }
  | { status: "processing" }
  | { status: "completed"; text: string; model: string }
  | { status: "failed"; error: string };

export type TranscribeWorkerDeps = {
  transcribe: (
    blob: Blob,
    filename: string,
    model: string,
  ) => Promise<{ text: string } | { error: string; status: number }>;
};

export type TranscribeQueueContext = {
  redis: Redis;
  /** Blocking client for BRPOP (must be separate from command client). */
  blocking: Redis;
};

export function connectRedis(url: string): TranscribeQueueContext | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const redis = new Redis(trimmed, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const blocking = redis.duplicate({
    maxRetriesPerRequest: null,
  });

  return { redis, blocking };
}

export async function redisPing(redis: Redis): Promise<boolean> {
  try {
    const p = await redis.ping();
    return p === "PONG";
  } catch {
    return false;
  }
}

export async function enqueueTranscribeJob(
  ctx: TranscribeQueueContext,
  args: {
    jobId: string;
    audioBuffer: Buffer;
    filename: string;
    model: string;
  },
): Promise<void> {
  const { jobId, audioBuffer, filename, model } = args;
  const audioBase64 = audioBuffer.toString("base64");
  const payload = JSON.stringify({ audioBase64, filename, model });

  await ctx.redis.set(
    payloadKey(jobId),
    payload,
    "EX",
    900,
  );
  await ctx.redis.set(
    jobKey(jobId),
    JSON.stringify({ status: "queued" } satisfies TranscribeJobRecord),
    "EX",
    900,
  );
  await ctx.redis.rpush(QUEUE_KEY, jobId);
}

export async function getJobRecord(
  ctx: TranscribeQueueContext,
  jobId: string,
): Promise<TranscribeJobRecord | null> {
  const raw = await ctx.redis.get(jobKey(jobId));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as TranscribeJobRecord;
  } catch {
    return null;
  }
}

/**
 * Single consumer loop. Safe to call once at process startup when Redis is configured.
 */
export function startTranscribeWorker(
  ctx: TranscribeQueueContext,
  deps: TranscribeWorkerDeps,
): void {
  const { redis, blocking } = ctx;

  const loop = async (): Promise<void> => {
    for (;;) {
      let jobId = "";
      try {
        const popped = await blocking.brpop(QUEUE_KEY, 0);
        if (!popped) {
          continue;
        }
        jobId = popped[1] ?? "";
        if (!jobId) {
          continue;
        }
      } catch (err) {
        console.error("[transcribe-worker] brpop error", err);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      try {
        const payloadRaw = await redis.get(payloadKey(jobId));
        if (!payloadRaw) {
          await redis.set(
            jobKey(jobId),
            JSON.stringify({
              status: "failed",
              error: "Job payload expired or missing",
            } satisfies TranscribeJobRecord),
            "EX",
            3600,
          );
          continue;
        }

        const parsed = JSON.parse(payloadRaw) as {
          audioBase64?: string;
          filename?: string;
          model?: string;
        };

        if (
          typeof parsed.audioBase64 !== "string" ||
          typeof parsed.filename !== "string" ||
          typeof parsed.model !== "string"
        ) {
          await redis.set(
            jobKey(jobId),
            JSON.stringify({
              status: "failed",
              error: "Invalid job payload",
            } satisfies TranscribeJobRecord),
            "EX",
            3600,
          );
          await redis.del(payloadKey(jobId));
          continue;
        }

        await redis.set(
          jobKey(jobId),
          JSON.stringify({ status: "processing" } satisfies TranscribeJobRecord),
          "EX",
          900,
        );

        const buf = Buffer.from(parsed.audioBase64, "base64");
        const blob = new Blob([new Uint8Array(buf)]);

        const result = await deps.transcribe(
          blob,
          parsed.filename,
          parsed.model,
        );

        if ("error" in result) {
          await redis.set(
            jobKey(jobId),
            JSON.stringify({
              status: "failed",
              error: result.error,
            } satisfies TranscribeJobRecord),
            "EX",
            3600,
          );
        } else {
          await redis.set(
            jobKey(jobId),
            JSON.stringify({
              status: "completed",
              text: result.text,
              model: parsed.model,
            } satisfies TranscribeJobRecord),
            "EX",
            3600,
          );
        }

        await redis.del(payloadKey(jobId));
      } catch (err) {
        console.error("[transcribe-worker] job error", jobId, err);
        if (jobId) {
          try {
            await redis.set(
              jobKey(jobId),
              JSON.stringify({
                status: "failed",
                error:
                  err instanceof Error ? err.message : "Worker processing error",
              } satisfies TranscribeJobRecord),
              "EX",
              3600,
            );
          } catch {
            /* ignore */
          }
          try {
            await redis.del(payloadKey(jobId));
          } catch {
            /* ignore */
          }
        }
      }
    }
  };

  void loop();
}
