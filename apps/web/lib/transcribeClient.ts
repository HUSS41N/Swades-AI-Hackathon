/** Client-side POST to our API `/api/transcribe`. */
export async function transcribeAudioPost(
  apiBaseUrl: string,
  blob: Blob,
  filename: string,
  model: string,
): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, filename);
  form.append("model", model);

  const res = await fetch(`${apiBaseUrl}/api/transcribe`, {
    method: "POST",
    body: form,
  });

  const body = (await res.json().catch(() => null)) as
    | { error?: string; text?: string }
    | null;

  if (!res.ok) {
    throw new Error(body?.error ?? `HTTP ${String(res.status)}`);
  }

  return typeof body?.text === "string" ? body.text : "";
}

export const TRANSCRIBE_MODEL_MINI = "gpt-4o-mini-transcribe";
export const TRANSCRIBE_MODEL_WHISPER = "whisper-1";

export type AsyncTranscribeResponse =
  | {
      ok: true;
      queued: false;
      text: string;
      model: string;
    }
  | {
      ok: true;
      queued: true;
      jobId: string;
      model: string;
    };

/** POST /api/transcribe/async — queues when Redis is up; otherwise returns text inline. */
export async function transcribeAsyncPost(
  apiBaseUrl: string,
  blob: Blob,
  filename: string,
  model: string,
): Promise<AsyncTranscribeResponse> {
  const form = new FormData();
  form.append("audio", blob, filename);
  form.append("model", model);

  const res = await fetch(`${apiBaseUrl}/api/transcribe/async`, {
    method: "POST",
    body: form,
  });

  const body = (await res.json().catch(() => null)) as
    | { error?: string; ok?: boolean; queued?: boolean; text?: string; model?: string; jobId?: string }
    | null;

  if (!res.ok) {
    throw new Error(body?.error ?? `HTTP ${String(res.status)}`);
  }

  if (
    body?.ok === true &&
    body.queued === true &&
    typeof body.jobId === "string"
  ) {
    return {
      ok: true,
      queued: true,
      jobId: body.jobId,
      model: typeof body.model === "string" ? body.model : model,
    };
  }

  if (body?.ok === true && typeof body.text === "string") {
    return {
      ok: true,
      queued: false,
      text: body.text,
      model: typeof body.model === "string" ? body.model : model,
    };
  }

  throw new Error("Unexpected async transcribe response");
}

export type TranscribeJobBody =
  | { jobId: string; status: "queued" }
  | { jobId: string; status: "processing" }
  | { jobId: string; status: "completed"; text: string; model: string }
  | { jobId: string; status: "failed"; error: string };

export async function fetchTranscribeJob(
  apiBaseUrl: string,
  jobId: string,
): Promise<TranscribeJobBody> {
  const res = await fetch(
    `${apiBaseUrl}/api/transcribe/jobs/${encodeURIComponent(jobId)}`,
    { cache: "no-store" },
  );
  const body = (await res.json().catch(() => null)) as
    | TranscribeJobBody
    | { error?: string }
    | null;

  if (!res.ok) {
    throw new Error(
      typeof body === "object" && body && "error" in body && typeof body.error === "string"
        ? body.error
        : `HTTP ${String(res.status)}`,
    );
  }

  if (
    body &&
    typeof body === "object" &&
    "status" in body &&
    typeof (body as TranscribeJobBody).jobId === "string"
  ) {
    return body as TranscribeJobBody;
  }

  throw new Error("Unexpected job response");
}

export async function pollTranscribeJob(
  apiBaseUrl: string,
  jobId: string,
  options?: { intervalMs?: number; maxWaitMs?: number },
): Promise<string> {
  const intervalMs = options?.intervalMs ?? 600;
  const maxWaitMs = options?.maxWaitMs ?? 300_000;
  const start = Date.now();

  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error("Transcription job timed out");
    }

    const j = await fetchTranscribeJob(apiBaseUrl, jobId);

    if (j.status === "completed") {
      return j.text;
    }
    if (j.status === "failed") {
      throw new Error(j.error);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

