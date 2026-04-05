"use client";

import { ChunkedTranscriptionPanel } from "./chunked-transcription-panel";
import { SampleAudioCard } from "./sample-audio-card";
import { Button } from "@repo/ui/components/button";
import { AUDIO_SAMPLES } from "@repo/ui/samples";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type HealthPayload = {
  ok?: boolean;
  service?: string;
  database?: "ok" | "error";
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") {
    return null;
  }

  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  };

  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }

  return undefined;
}

function StudioColumn({
  title,
  bodyScroll = true,
  children,
}: {
  title: string;
  /** When false, body is a flex column without outer scroll (panels scroll inside). */
  bodyScroll?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-0 min-w-[11rem] flex-1 basis-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="shrink-0 border-slate-100 border-b bg-slate-50 px-2 py-1.5">
        <h2 className="font-semibold text-slate-900 text-[11px] uppercase tracking-wide">
          {title}
        </h2>
      </header>
      <div
        className={
          bodyScroll
            ? "min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2"
            : "flex min-h-0 flex-1 flex-col overflow-hidden p-2"
        }
      >
        {children}
      </div>
    </section>
  );
}

type StudioClientProps = {
  apiBaseUrl: string;
  initialHealth: HealthPayload | null;
};

export function StudioClient({
  apiBaseUrl,
  initialHealth,
}: StudioClientProps) {
  const [sampleOpId, setSampleOpId] = useState<string | null>(null);

  const [health, setHealth] = useState<HealthPayload | null>(initialHealth);
  const [chunkStatus, setChunkStatus] = useState<string | null>(null);
  const [chunkLoading, setChunkLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<string | null>(null);
  const [whisperLoading, setWhisperLoading] = useState(false);
  const [liveCaption, setLiveCaption] = useState("");
  const [whisperText, setWhisperText] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sampleAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedPartsRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalCaptionRef = useRef("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const refreshHealth = useCallback(async () => {
    const res = await fetch(`${apiBaseUrl}/health`, {
      cache: "no-store",
    }).catch(() => null);

    if (!res?.ok) {
      setHealth(null);
      return;
    }

    setHealth((await res.json()) as HealthPayload);
  }, [apiBaseUrl]);

  useEffect(() => {
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 15_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  const transcribeBlob = useCallback(
    async (blob: Blob, filename: string, model = "whisper-1") => {
      setWhisperLoading(true);
      setWhisperStatus(null);

      const form = new FormData();
      form.append("audio", blob, filename);
      form.append("model", model);

      const res = await fetch(`${apiBaseUrl}/api/transcribe`, {
        method: "POST",
        body: form,
      }).catch(() => null);

      setWhisperLoading(false);

      if (!res) {
        setWhisperStatus("Network error calling /api/transcribe");
        return null;
      }

      const body = (await res.json().catch(() => null)) as
        | { error?: string; text?: string; ok?: boolean }
        | null;

      if (!res.ok) {
        setWhisperStatus(body?.error ?? `HTTP ${String(res.status)}`);
        return null;
      }

      const text = body?.text ?? "";
      setWhisperStatus("Transcription complete.");
      return text;
    },
    [apiBaseUrl],
  );

  const uploadSampleChunk = useCallback(async () => {
    setChunkLoading(true);
    setChunkStatus(null);

    const chunkId = `chunk-${crypto.randomUUID()}`;
    const res = await fetch(`${apiBaseUrl}/api/chunks/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chunkId,
        data: "x".repeat(1024),
      }),
    }).catch(() => null);

    setChunkLoading(false);

    if (!res) {
      setChunkStatus("Network error — is the API running?");
      return;
    }

    const body = (await res.json().catch(() => null)) as
      | { error?: string; ok?: boolean }
      | null;

    if (!res.ok) {
      setChunkStatus(body?.error ?? `HTTP ${String(res.status)}`);
      return;
    }

    setChunkStatus(`Ack stored for ${chunkId}`);
  }, [apiBaseUrl]);

  const stopVisualizer = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    analyserRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    const c = canvasRef.current;
    if (c) {
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, c.width, c.height);
      }
    }
  }, []);

  const startVisualizer = useCallback((stream: MediaStream) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextClass) {
      return;
    }

    const ctx = new AudioContextClass();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);
    analyserRef.current = analyser;

    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      const a = analyserRef.current;
      const cv = canvasRef.current;
      if (!a || !cv) {
        return;
      }

      const c2 = cv.getContext("2d");
      if (!c2) {
        return;
      }

      const w = cv.width;
      const h = cv.height;
      a.getByteFrequencyData(buffer);
      c2.fillStyle = "#f8fafc";
      c2.fillRect(0, 0, w, h);

      const barW = w / buffer.length;
      for (let i = 0; i < buffer.length; i++) {
        const v = buffer[i] ?? 0;
        const bh = (v / 255) * h * 0.82;
        c2.fillStyle = "#94a3b8";
        c2.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    draw();
  }, []);

  const stopRecording = useCallback(async () => {
    setWhisperStatus(null);
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    const rec = mediaRecorderRef.current;
    mediaRecorderRef.current = null;

    if (rec && rec.state !== "inactive") {
      await new Promise<void>((resolve) => {
        rec.addEventListener("stop", () => resolve(), { once: true });
        rec.stop();
      });
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    stopVisualizer();
    setRecording(false);

    const parts = recordedPartsRef.current;
    recordedPartsRef.current = [];

    if (parts.length === 0) {
      setWhisperStatus("No audio captured.");
      return;
    }

    const mime = parts[0]?.type || "audio/webm";
    const blob = new Blob(parts, { type: mime });

    if (blob.size < 512) {
      setWhisperStatus("Recording too short. Try at least one second.");
      return;
    }

    const ext = mime.includes("mp4") ? "m4a" : "webm";
    const text = await transcribeBlob(blob, `capture.${ext}`);
    if (text !== null) {
      setWhisperText(text);
    }
  }, [stopVisualizer, transcribeBlob]);

  const startRecording = useCallback(async () => {
    setWhisperText("");
    setWhisperStatus(null);
    setLiveCaption("");
    finalCaptionRef.current = "";
    recordedPartsRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setWhisperStatus("Microphone permission denied or unavailable.");
      return;
    }

    streamRef.current = stream;

    const Ctor = getSpeechRecognitionCtor();
    if (Ctor) {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i]?.[0]?.transcript ?? "";
          if (event.results[i]?.isFinal) {
            finalCaptionRef.current += `${piece} `;
          } else {
            interim += piece;
          }
        }
        setLiveCaption(`${finalCaptionRef.current}${interim}`.trim());
      };

      try {
        recognition.start();
        recognitionRef.current = recognition;
      } catch {
        recognitionRef.current = null;
      }
    }

    const mime = pickRecorderMime();
    const recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);

    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedPartsRef.current.push(e.data);
      }
    };

    recorder.start();
    setRecording(true);
    startVisualizer(stream);
  }, [startVisualizer]);

  const runFileTranscribe = useCallback(async () => {
    if (!uploadFile) {
      setWhisperStatus("Choose an audio file first.");
      return;
    }

    setUploadTranscript("");
    setWhisperStatus(null);
    const text = await transcribeBlob(uploadFile, uploadFile.name);
    if (text !== null) {
      setUploadTranscript(text);
    }
  }, [uploadFile, transcribeBlob]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      stopVisualizer();
    };
  }, [stopVisualizer]);

  const pauseOtherSamplePlayers = useCallback((exceptId: string) => {
    sampleAudioRefs.current.forEach((el, id) => {
      if (id !== exceptId) {
        void el.pause();
      }
    });
  }, []);

  const apiReachable = health?.ok === true;
  const dbOk = health?.database === "ok";
  const busy = whisperLoading || sampleOpId !== null;

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-slate-200 border-b bg-white px-3 py-2">
        <h1 className="font-semibold text-slate-900 text-sm tracking-tight">
          Recording pipeline
        </h1>
        <span className="hidden text-slate-400 text-xs sm:inline">
          Mini transcribe · Whisper · Postgres chunk ack
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className={
              apiReachable
                ? "rounded bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 text-[10px]"
                : "rounded bg-red-50 px-2 py-0.5 font-medium text-red-800 text-[10px]"
            }
          >
            API {apiReachable ? "ok" : "down"}
          </span>
          {apiReachable ? (
            <span
              className={
                dbOk
                  ? "rounded bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 text-[10px]"
                  : "rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-900 text-[10px]"
              }
            >
              DB {dbOk ? "ok" : "down"}
            </span>
          ) : null}
          <button
            className="text-slate-500 text-xs hover:text-slate-800"
            onClick={() => void refreshHealth()}
            type="button"
          >
            Refresh
          </button>
          <a
            className="text-slate-400 text-[10px] hover:text-slate-600"
            href={apiBaseUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            API
          </a>
        </div>
      </header>

      {!apiReachable || (apiReachable && !dbOk) ? (
        <div className="shrink-0 px-3 pt-2">
          <CompactDevHint showDb={apiReachable && !dbOk} />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-2">
        <div className="flex h-full min-h-0 min-w-[1040px] gap-2">
          <StudioColumn bodyScroll={false} title="Live chunk">
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
              <p className="mb-2 shrink-0 text-[10px] text-slate-500 leading-snug">
                Mic + 5s sliding window →{" "}
                <code className="rounded bg-slate-100 px-0.5">
                  OPENAI_API_KEY
                </code>
              </p>
              <ChunkedTranscriptionPanel
                apiBaseUrl={apiBaseUrl}
                apiReachable={apiReachable}
                className="min-h-0 min-w-0 flex-1"
                dense
                disabled={busy}
              />
            </div>
          </StudioColumn>

          <StudioColumn bodyScroll={false} title="Single (Whisper)">
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
              <p className="mb-2 shrink-0 text-[10px] text-slate-500 leading-snug">
                One take → full file{" "}
                <code className="rounded bg-slate-100 px-0.5">whisper-1</code>
              </p>
              <canvas
                className="mb-2 h-20 w-full shrink-0 rounded border border-slate-200 bg-slate-50"
                height={80}
                ref={canvasRef}
                width={320}
              />
              <div className="mb-2 flex shrink-0 flex-wrap gap-1">
                {!recording ? (
                  <Button
                    disabled={busy}
                    onClick={() => void startRecording()}
                    size="sm"
                    type="button"
                  >
                    Record
                  </Button>
                ) : (
                  <Button
                    disabled={busy}
                    onClick={() => void stopRecording()}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    Stop + transcribe
                  </Button>
                )}
                {whisperLoading ? (
                  <span className="self-center text-slate-500 text-xs">
                    …
                  </span>
                ) : null}
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex min-h-0 flex-1 flex-col rounded border border-slate-200 bg-slate-50/80 p-2">
                  <h3 className="shrink-0 font-medium text-slate-600 text-[10px] uppercase">
                    Browser caption
                  </h3>
                  <p className="mt-1 min-h-0 flex-1 overflow-y-auto text-[11px] text-slate-800 leading-snug">
                    {liveCaption || (
                      <span className="text-slate-400">
                        {recording ? "Listening…" : "Chrome / Edge interim."}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex min-h-0 flex-1 flex-col rounded border border-slate-200 bg-slate-50/80 p-2">
                  <h3 className="shrink-0 font-medium text-slate-600 text-[10px] uppercase">
                    Whisper
                  </h3>
                  <p className="mt-1 min-h-0 flex-1 overflow-y-auto text-[11px] text-slate-800 leading-snug">
                    {whisperText || (
                      <span className="text-slate-400">After stop.</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </StudioColumn>

          <StudioColumn bodyScroll={false} title="Upload">
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
              <p className="mb-2 shrink-0 text-[10px] text-slate-500 leading-snug">
                File →{" "}
                <code className="rounded bg-slate-100 px-0.5">whisper-1</code>
              </p>
              <input
                accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.mpeg,.mp4"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setUploadFile(f ?? null);
                  setUploadTranscript("");
                  setWhisperStatus(f ? `Selected: ${f.name}` : null);
                }}
                ref={fileInputRef}
                type="file"
              />
              <div className="mb-2 flex shrink-0 flex-wrap gap-1">
                <Button
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  File
                </Button>
                <Button
                  disabled={!uploadFile || busy}
                  onClick={() => void runFileTranscribe()}
                  size="sm"
                  type="button"
                >
                  Transcribe
                </Button>
              </div>
              {uploadFile ? (
                <p className="mb-2 shrink-0 truncate font-mono text-slate-500 text-[10px]">
                  {uploadFile.name} · {(uploadFile.size / 1024).toFixed(0)} KB
                </p>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col rounded border border-slate-200 bg-slate-50/80 p-2">
                <h3 className="shrink-0 font-medium text-slate-600 text-[10px] uppercase">
                  Transcript
                </h3>
                <p className="mt-1 min-h-0 flex-1 overflow-y-auto text-[11px] text-slate-800 leading-snug">
                  {uploadTranscript || (
                    <span className="text-slate-400">
                      Upload then transcribe.
                    </span>
                  )}
                </p>
              </div>
            </div>
          </StudioColumn>

          <StudioColumn title="Samples">
            <p className="mb-2 text-[10px] text-slate-500 leading-snug">
              <code className="rounded bg-slate-100 px-0.5">public/samples</code>
            </p>
            <ul className="space-y-2">
              {AUDIO_SAMPLES.map((sample) => (
                <SampleAudioCard
                  apiBaseUrl={apiBaseUrl}
                  apiReachable={apiReachable}
                  key={sample.id}
                  lockHeldByOther={
                    sampleOpId !== null && sampleOpId !== sample.id
                  }
                  onAudioRef={(el) => {
                    if (el) {
                      sampleAudioRefs.current.set(sample.id, el);
                    } else {
                      sampleAudioRefs.current.delete(sample.id);
                    }
                  }}
                  onBeginOperation={() => setSampleOpId(sample.id)}
                  onEndOperation={() =>
                    setSampleOpId((c) => (c === sample.id ? null : c))
                  }
                  onPlay={() => pauseOtherSamplePlayers(sample.id)}
                  sample={sample}
                />
              ))}
            </ul>
          </StudioColumn>

          <StudioColumn title="Test">
            <p className="mb-2 text-[10px] text-slate-500 leading-snug">
              POST{" "}
              <code className="rounded bg-slate-100 px-0.5">/api/chunks/upload</code>{" "}
              · needs Postgres
            </p>
            <Button
              className="mb-2"
              disabled={chunkLoading}
              onClick={() => void uploadSampleChunk()}
              size="sm"
              type="button"
              variant="outline"
            >
              {chunkLoading ? "Sending…" : "Send chunk ack"}
            </Button>
            {chunkStatus ? (
              <p className="text-slate-600 text-[11px] leading-snug">{chunkStatus}</p>
            ) : null}
          </StudioColumn>
        </div>
      </div>

      {whisperStatus ? (
        <footer
          className="shrink-0 truncate border-slate-200 border-t bg-white px-3 py-1 text-slate-600 text-xs"
          role="status"
        >
          {whisperStatus}
        </footer>
      ) : null}
    </div>
  );
}

function CompactDevHint({ showDb }: { showDb: boolean }) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-700 leading-snug">
      <span className="font-medium text-slate-900">
        {showDb ? "DB unreachable" : "API unreachable"}
      </span>
      <span className="text-slate-600">
        {" "}
        · <code className="rounded bg-white px-0.5">npm run docker:db</code> ·
        <code className="rounded bg-white px-0.5">db:push</code> ·
        <code className="rounded bg-white px-0.5">npm run dev</code>
      </span>
    </div>
  );
}
