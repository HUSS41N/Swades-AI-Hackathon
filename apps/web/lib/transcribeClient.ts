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
