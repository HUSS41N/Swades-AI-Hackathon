"use client";

import { ChunkedTranscriptionPanel } from "./chunked-transcription-panel";
import { SampleAudioCard } from "./sample-audio-card";
import { UploadAudioSection } from "./upload-audio-section";
import { Button } from "@repo/ui/components/button";
import { AUDIO_SAMPLES } from "@repo/ui/samples";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const UPLOAD_OP_ID = "user-upload";

export type HealthPayload = {
  ok?: boolean;
  service?: string;
  database?: "ok" | "error";
  redis?: "ok" | "skipped" | "error";
  transcribeQueue?: "redis" | "inline";
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
    <section className="flex min-h-0 min-w-[18rem] flex-1 basis-0 flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-sm">
      <header className="shrink-0 border-slate-100 border-b bg-slate-50/90 px-4 py-3">
        <h2 className="font-semibold text-slate-900 text-base tracking-tight">
          {title}
        </h2>
      </header>
      <div
        className={
          bodyScroll
            ? "flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-4"
            : "flex min-h-0 flex-1 flex-col overflow-hidden p-4"
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
  const [activeOpId, setActiveOpId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState<"chunk" | "whisper">("chunk");

  const [health, setHealth] = useState<HealthPayload | null>(initialHealth);
  const [recording, setRecording] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<string | null>(null);
  const [whisperLoading, setWhisperLoading] = useState(false);
  const [liveCaption, setLiveCaption] = useState("");
  const [whisperText, setWhisperText] = useState("");
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
  const queueRedis = health?.transcribeQueue === "redis";
  const busy = whisperLoading || activeOpId !== null;

  const queueLabel = !apiReachable
    ? null
    : queueRedis
      ? "Async jobs use Redis"
      : health?.transcribeQueue === "inline"
        ? "Async jobs run inline (no Redis)"
        : null;

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-slate-100 text-slate-900">
      <header className="flex shrink-0 flex-col gap-3 border-slate-200 border-b bg-white px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-semibold text-slate-900 text-xl tracking-tight">
            Transcription studio
          </h1>
          <p className="mt-0.5 text-slate-500 text-sm">
            Live chunking or single take on the left · samples and upload on the
            right
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white hover:bg-slate-800"
              href="/docs"
            >
              Architecture &amp; docs
            </Link>
            <button
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 font-medium text-slate-700 text-sm hover:bg-slate-50"
              onClick={() => void refreshHealth()}
              type="button"
            >
              Refresh status
            </button>
            <a
              className="rounded-lg px-3 py-2 text-slate-500 text-sm hover:text-slate-800"
              href={apiBaseUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open API
            </a>
          </div>
          <p className="max-w-md text-right text-slate-600 text-sm leading-relaxed">
            {apiReachable ? (
              <>
                <span className="font-medium text-emerald-700">API reachable</span>
                <span className="text-slate-400"> · </span>
                <span
                  className={
                    dbOk ? "font-medium text-emerald-700" : "font-medium text-amber-800"
                  }
                >
                  {dbOk ? "Database OK" : "Database issue"}
                </span>
                {queueLabel ? (
                  <>
                    <span className="text-slate-400"> · </span>
                    <span className="text-slate-600">{queueLabel}</span>
                  </>
                ) : null}
                {apiReachable && health?.redis === "error" ? (
                  <>
                    <span className="text-slate-400"> · </span>
                    <span className="font-medium text-red-700">
                      Redis connection error
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <span className="font-medium text-red-700">API unreachable</span>
            )}
          </p>
        </div>
      </header>

      {!apiReachable || (apiReachable && !dbOk) ? (
        <div className="shrink-0 px-4 pt-3">
          <CompactDevHint showDb={apiReachable && !dbOk} />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto p-4">
        <div className="mx-auto flex h-full min-h-0 w-full min-w-[min(100%,52rem)] max-w-6xl gap-6">
          <StudioColumn bodyScroll={false} title="Live">
            <div className="mb-3 flex shrink-0 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
              <button
                className={`flex-1 rounded-lg px-4 py-2.5 font-medium text-sm transition ${
                  liveMode === "chunk"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                onClick={() => setLiveMode("chunk")}
                type="button"
              >
                Live chunk
              </button>
              <button
                className={`flex-1 rounded-lg px-4 py-2.5 font-medium text-sm transition ${
                  liveMode === "whisper"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                onClick={() => setLiveMode("whisper")}
                type="button"
              >
                Single Whisper
              </button>
            </div>

            {liveMode === "chunk" ? (
              <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
                <ChunkedTranscriptionPanel
                  apiBaseUrl={apiBaseUrl}
                  apiReachable={apiReachable}
                  className="min-h-0 min-w-0 flex-1"
                  dense
                  disabled={busy}
                />
              </div>
            ) : (
              <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {!recording ? (
                    <Button
                      disabled={busy}
                      onClick={() => void startRecording()}
                      type="button"
                    >
                      Start recording
                    </Button>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() => void stopRecording()}
                      type="button"
                      variant="destructive"
                    >
                      Stop and transcribe
                    </Button>
                  )}
                  {whisperLoading ? (
                    <span className="text-slate-500 text-sm">Transcribing…</span>
                  ) : null}
                  <p className="min-w-0 flex-1 text-slate-500 text-xs leading-snug">
                    One take →{" "}
                    <code className="rounded bg-slate-100 px-1 font-mono">
                      whisper-1
                    </code>
                    . Captions optional (Chrome / Edge).
                  </p>
                </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border-2 border-slate-300/80 bg-white p-1 shadow-sm">
                  <h3 className="shrink-0 px-3 pt-3 font-semibold text-slate-900 text-sm">
                    Whisper transcript
                  </h3>
                  <p className="mx-2 mb-2 mt-1 min-h-0 flex-1 overflow-y-auto text-pretty p-3 text-base leading-relaxed text-slate-900">
                    {whisperText || (
                      <span className="text-slate-500">
                        Your transcription appears here after you stop recording.
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex max-h-28 min-h-20 shrink-0 flex-col rounded-lg border border-slate-200 bg-slate-50/90 p-3">
                  <h3 className="shrink-0 font-medium text-slate-600 text-xs uppercase tracking-wide">
                    Browser caption
                  </h3>
                  <p className="mt-1 min-h-0 flex-1 overflow-y-auto text-slate-800 text-sm leading-relaxed">
                    {liveCaption || (
                      <span className="text-slate-400">
                        {recording
                          ? "Listening…"
                          : "Interim captions while recording (if supported)."}
                      </span>
                    )}
                  </p>
                </div>

                <details className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 text-slate-800">
                  <summary className="cursor-pointer select-none px-3 py-2 font-medium text-slate-700 text-sm hover:bg-slate-100/80">
                    Input level (waveform)
                  </summary>
                  <div className="border-slate-200 border-t p-3">
                    <canvas
                      className="h-20 w-full rounded-lg border border-slate-200 bg-slate-50"
                      height={80}
                      ref={canvasRef}
                      width={640}
                    />
                  </div>
                </details>
              </div>
            )}
          </StudioColumn>

          <StudioColumn title="Samples & upload">
            <p className="mb-4 text-slate-600 text-sm leading-relaxed">
              Try built-in clips or upload your own file. Use{" "}
              <strong className="font-medium text-slate-800">Full</strong> for
              one-shot Whisper,{" "}
              <strong className="font-medium text-slate-800">Chunk</strong> for
              the same sliding pipeline as live, or{" "}
              <strong className="font-medium text-slate-800">Queue</strong> for
              the async API path.
            </p>
            <UploadAudioSection
              apiBaseUrl={apiBaseUrl}
              apiReachable={apiReachable}
              lockHeldByOther={
                activeOpId !== null && activeOpId !== UPLOAD_OP_ID
              }
              onBeginOperation={() => setActiveOpId(UPLOAD_OP_ID)}
              onEndOperation={() =>
                setActiveOpId((c) => (c === UPLOAD_OP_ID ? null : c))
              }
            />
            <ul className="space-y-4">
              {AUDIO_SAMPLES.map((sample) => (
                <SampleAudioCard
                  apiBaseUrl={apiBaseUrl}
                  apiReachable={apiReachable}
                  key={sample.id}
                  lockHeldByOther={
                    activeOpId !== null && activeOpId !== sample.id
                  }
                  onAudioRef={(el) => {
                    if (el) {
                      sampleAudioRefs.current.set(sample.id, el);
                    } else {
                      sampleAudioRefs.current.delete(sample.id);
                    }
                  }}
                  onBeginOperation={() => setActiveOpId(sample.id)}
                  onEndOperation={() =>
                    setActiveOpId((c) => (c === sample.id ? null : c))
                  }
                  onPlay={() => pauseOtherSamplePlayers(sample.id)}
                  sample={sample}
                />
              ))}
            </ul>
          </StudioColumn>
        </div>
      </div>

      {whisperStatus ? (
        <footer
          className="shrink-0 border-slate-200 border-t bg-white px-4 py-3 text-slate-700 text-sm"
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
    <div className="rounded-xl border border-slate-200 bg-amber-50/80 px-4 py-3 text-slate-800 text-sm leading-relaxed">
      <p className="font-medium text-slate-900">
        {showDb ? "Database unreachable" : "API unreachable"}
      </p>
      <p className="mt-1 text-slate-700">
        Start Postgres with{" "}
        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
          npm run docker:db
        </code>
        , copy{" "}
        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
          apps/server/.env.example
        </code>{" "}
        to{" "}
        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
          .env
        </code>
        , run{" "}
        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
          npm run db:push
        </code>
        , then{" "}
        <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">
          npm run dev
        </code>
        .
      </p>
    </div>
  );
}
