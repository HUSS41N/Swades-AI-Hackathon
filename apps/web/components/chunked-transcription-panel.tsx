"use client";

import { Button } from "@repo/ui/components/button";
import {
  TRANSCRIBE_MODEL_MINI,
  transcribeAudioPost,
} from "../lib/transcribeClient";
import {
  CHUNK_DURATION_SEC,
  OVERLAP_SEC,
  STEP_SEC,
  WINDOW_SEC,
  SlidingWindowTranscriptionSession,
  type SlidingVisualizationState,
} from "../lib/slidingWindowTranscription";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const TRANSCRIBE_MODEL = TRANSCRIBE_MODEL_MINI;

const EMPTY_VIZ: SlidingVisualizationState = {
  bufferSlotsFilled: 0,
  bufferChunkIndices: [],
  chunksReceived: 0,
  windowsEmitted: 0,
  pendingRequests: 0,
  lastEmitChunkIndex: null,
};

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

async function postTranscribeWav(
  apiBaseUrl: string,
  wav: Blob,
  filename: string,
): Promise<string> {
  return transcribeAudioPost(apiBaseUrl, wav, filename, TRANSCRIBE_MODEL);
}

/** One-line pipeline hint for dense layouts */
export function ChunkPipelineFlowMicro() {
  return (
    <p className="text-[10px] text-slate-600 leading-snug">
      Mic → 1s PCM → 5s window (step 3s, overlap 2s) →{" "}
      <code className="rounded bg-slate-100 px-0.5">{TRANSCRIBE_MODEL}</code> →
      merge / dedupe
    </p>
  );
}

export function ChunkPipelineFlowDiagram() {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-4">
      <svg
        aria-hidden
        className="h-auto w-full max-w-full text-slate-800"
        viewBox="0 0 640 132"
      >
        <defs>
          <marker
            id="arrow"
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="6"
            refY="4"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
          </marker>
        </defs>
        <g className="fill-none stroke-slate-400 stroke-[1.5]">
          <line
            markerEnd="url(#arrow)"
            x1="28"
            x2="72"
            y1="44"
            y2="44"
          />
          <line
            markerEnd="url(#arrow)"
            x1="132"
            x2="176"
            y1="44"
            y2="44"
          />
          <line
            markerEnd="url(#arrow)"
            x1="268"
            x2="312"
            y1="44"
            y2="44"
          />
          <line
            markerEnd="url(#arrow)"
            x1="404"
            x2="448"
            y1="44"
            y2="44"
          />
          <line
            markerEnd="url(#arrow)"
            x1="500"
            x2="544"
            y1="44"
            y2="44"
          />
        </g>
        <rect
          className="fill-white stroke-slate-300"
          height="36"
          rx="6"
          width="56"
          x="0"
          y="26"
        />
        <text
          className="fill-slate-800 font-medium text-[11px]"
          textAnchor="middle"
          x="28"
          y="48"
        >
          Mic
        </text>
        <rect
          className="fill-white stroke-slate-300"
          height="36"
          rx="6"
          width="72"
          x="76"
          y="26"
        />
        <text
          className="fill-slate-800 font-medium text-[10px]"
          textAnchor="middle"
          x="112"
          y="44"
        >
          1s chunks
        </text>
        <text
          className="fill-slate-500 text-[9px]"
          textAnchor="middle"
          x="112"
          y="56"
        >
          PCM → WAV
        </text>
        <rect
          className="fill-amber-50 stroke-amber-300"
          height="36"
          rx="6"
          width="100"
          x="180"
          y="26"
        />
        <text
          className="fill-slate-800 font-medium text-[10px]"
          textAnchor="middle"
          x="230"
          y="44"
        >
          5s buffer
        </text>
        <text
          className="fill-slate-600 text-[9px]"
          textAnchor="middle"
          x="230"
          y="56"
        >
          step 3s, overlap 2s
        </text>
        <rect
          className="fill-white stroke-slate-300"
          height="36"
          rx="6"
          width="100"
          x="316"
          y="26"
        />
        <text
          className="fill-slate-800 font-medium text-[10px]"
          textAnchor="middle"
          x="366"
          y="48"
        >
          Async API
        </text>
        <rect
          className="fill-white stroke-slate-300"
          height="36"
          rx="6"
          width="100"
          x="452"
          y="26"
        />
        <text
          className="fill-slate-800 font-medium text-[10px]"
          textAnchor="middle"
          x="502"
          y="48"
        >
          Merge + dedupe
        </text>
        <rect
          className="fill-emerald-50 stroke-emerald-300"
          height="36"
          rx="6"
          width="88"
          x="548"
          y="26"
        />
        <text
          className="fill-slate-800 font-medium text-[10px]"
          textAnchor="middle"
          x="592"
          y="48"
        >
          UI
        </text>
        <text
          className="fill-slate-600 text-[11px] leading-snug"
          x="0"
          y="96"
        >
          Each 1s of audio fills a slot. When five slots are full, we send a 5s
          WAV to the server. The window then advances by 3s, so the next request
          reuses the last 2s (overlap). Responses may return out of order; we
          merge in sequence and dedupe repeated words at overlaps.
        </text>
      </svg>
    </div>
  );
}

export function SlidingBufferVisualizer({
  viz,
  compact = false,
}: {
  viz: SlidingVisualizationState;
  compact?: boolean;
}) {
  const slots = 5;
  const filled = viz.bufferSlotsFilled;
  const indices = viz.bufferChunkIndices;

  return (
    <div
      className={`rounded-lg border border-slate-200 bg-white ${compact ? "p-2" : "p-4"}`}
    >
      <h3
        className={`font-medium text-slate-700 uppercase tracking-wide ${compact ? "text-[10px]" : "text-xs"}`}
      >
        Buffer (1s slots)
      </h3>
      {!compact ? (
        <p className="mt-1 text-slate-500 text-xs">
          Amber = overlap zone (last 2s of a window match the next window’s
          first 2s). Chunk indices are global counters since stream start.
        </p>
      ) : (
        <p className="mt-0.5 text-[10px] text-slate-500">Amber = 2s overlap</p>
      )}
      <div className={`flex gap-1 ${compact ? "mt-1.5" : "mt-3"}`}>
        {Array.from({ length: slots }, (_, i) => {
          const active = i < filled;
          const idx = indices[i];
          const inOverlapLeft = active && i < OVERLAP_SEC / CHUNK_DURATION_SEC;
          const inOverlapRight =
            active && i >= slots - OVERLAP_SEC / CHUNK_DURATION_SEC;

          return (
            <div
              className={`flex flex-1 flex-col rounded border-2 px-0.5 py-1 text-center ${
                compact ? "min-h-10" : "min-h-[4.5rem] py-2"
              } ${
                active
                  ? inOverlapLeft || inOverlapRight
                    ? "border-amber-400 bg-amber-50"
                    : "border-slate-300 bg-slate-100"
                  : "border-dashed border-slate-200 bg-slate-50/80"
              }`}
              key={`slot-${String(i)}`}
            >
              <span
                className={`font-mono text-slate-400 ${compact ? "text-[8px]" : "text-[10px]"}`}
              >
                +{String(i + 1)}s
              </span>
              <span
                className={`mt-auto font-medium ${compact ? "text-[10px]" : "text-xs"} ${active ? "text-slate-800" : "text-slate-400"}`}
              >
                {active && idx !== undefined ? `#${String(idx)}` : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <dl
        className={`grid grid-cols-2 font-mono text-slate-600 ${compact ? "mt-1.5 gap-x-2 text-[9px]" : "mt-3 gap-x-4 gap-y-1 text-xs sm:grid-cols-4"}`}
      >
        <div>
          <dt className="text-slate-400">Chunks</dt>
          <dd>{viz.chunksReceived}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Merged</dt>
          <dd>{viz.windowsEmitted}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Flight</dt>
          <dd>{viz.pendingRequests}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Emit@</dt>
          <dd>
            {viz.lastEmitChunkIndex !== null
              ? String(viz.lastEmitChunkIndex)
              : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

type ChunkedTranscriptionPanelProps = {
  apiBaseUrl: string;
  apiReachable: boolean;
  disabled: boolean;
  /** Tighter layout for multi-column studio */
  dense?: boolean;
  className?: string;
};

export function ChunkedTranscriptionPanel({
  apiBaseUrl,
  apiReachable,
  disabled,
  dense = false,
  className = "",
}: ChunkedTranscriptionPanelProps) {
  const [liveOn, setLiveOn] = useState(false);
  const [unstableText, setUnstableText] = useState("");
  const [stableText, setStableText] = useState("");
  const [viz, setViz] = useState<SlidingVisualizationState>(EMPTY_VIZ);
  const [status, setStatus] = useState<string | null>(null);

  const sessionRef = useRef<SlidingWindowTranscriptionSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<{
    stop: () => Promise<void>;
  } | null>(null);
  const accRef = useRef<Float32Array>(new Float32Array(0));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const liveCtxRef = useRef<AudioContext | null>(null);

  const stopCanvas = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    analyserRef.current = null;
  }, []);

  const startCanvas = useCallback((analyser: AnalyserNode) => {
    analyserRef.current = analyser;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

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

  const teardownLive = useCallback(async () => {
    stopCanvas();
    sessionRef.current?.destroy();
    sessionRef.current = null;

    const cap = captureRef.current;
    captureRef.current = null;
    if (cap) {
      await cap.stop().catch(() => undefined);
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    liveCtxRef.current = null;

    accRef.current = new Float32Array(0);
    setLiveOn(false);
  }, [stopCanvas]);

  const makeTranscribeFn = useCallback(
    () => async ({ wavBlob, seq }: { wavBlob: Blob; seq: number }) =>
      postTranscribeWav(apiBaseUrl, wavBlob, `window-${String(seq)}.wav`),
    [apiBaseUrl],
  );

  const resetOutputs = useCallback(() => {
    setUnstableText("");
    setStableText("");
    setViz(EMPTY_VIZ);
    setStatus(null);
  }, []);

  const startLive = useCallback(async () => {
    if (!apiReachable || disabled) {
      return;
    }

    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      setStatus("Web Audio API not available in this browser.");
      return;
    }

    await teardownLive();
    resetOutputs();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("Microphone permission denied or unavailable.");
      return;
    }

    streamRef.current = stream;

    const ctx = new Ctor();
    liveCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);

    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const rate = ctx.sampleRate;
    const samplesPerSec = Math.floor(rate * CHUNK_DURATION_SEC);

    const session = new SlidingWindowTranscriptionSession({
      sampleRate: rate,
      transcribe: makeTranscribeFn(),
      onUnstable: setUnstableText,
      onStable: setStableText,
      onViz: setViz,
    });
    sessionRef.current = session;

    processor.onaudioprocess = (e) => {
      const s = sessionRef.current;
      if (!s) {
        return;
      }
      const input = e.inputBuffer.getChannelData(0);
      const prev = accRef.current;
      const merged = new Float32Array(prev.length + input.length);
      merged.set(prev);
      merged.set(input, prev.length);
      let acc = merged;
      while (acc.length >= samplesPerSec) {
        const chunk = acc.subarray(0, samplesPerSec);
        s.pushSecondChunk(new Float32Array(chunk));
        acc = acc.subarray(samplesPerSec);
      }
      accRef.current = acc;
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    captureRef.current = {
      stop: async () => {
        processor.disconnect();
        source.disconnect();
        analyser.disconnect();
        liveCtxRef.current = null;
        if (ctx.state !== "closed") {
          await ctx.close();
        }
      },
    };

    startCanvas(analyser);
    setLiveOn(true);
    setStatus(
      `Streaming: ${String(WINDOW_SEC)}s windows, ${String(STEP_SEC)}s step, ${String(OVERLAP_SEC)}s overlap · ${TRANSCRIBE_MODEL}`,
    );
  }, [
    apiReachable,
    disabled,
    makeTranscribeFn,
    resetOutputs,
    startCanvas,
    teardownLive,
  ]);

  const stopLive = useCallback(async () => {
    await teardownLive();
    setStatus("Stopped. Final text is in Stable below.");
  }, [teardownLive]);

  useEffect(() => {
    return () => {
      void teardownLive();
    };
  }, [teardownLive]);

  const rootGap = dense ? "gap-2" : "space-y-4";
  const transcriptBox = dense
    ? "min-h-0 flex-1 overflow-y-auto rounded border p-2 text-[11px] leading-snug"
    : "mt-2 min-h-[4.5rem] text-pretty text-sm";

  return (
    <div className={`flex min-h-0 flex-col ${rootGap} ${className}`}>
      {dense ? <ChunkPipelineFlowMicro /> : <ChunkPipelineFlowDiagram />}

      <SlidingBufferVisualizer compact={dense} viz={viz} />

      <canvas
        className={`w-full rounded-lg border border-slate-200 bg-slate-50 ${dense ? "h-16 shrink-0" : "h-28"}`}
        height={dense ? 64 : 112}
        ref={canvasRef}
        width={640}
      />

      <div className={`flex flex-wrap items-center ${dense ? "gap-1.5" : "gap-3"}`}>
        {!liveOn ? (
          <Button
            disabled={!apiReachable || disabled}
            onClick={() => void startLive()}
            size={dense ? "sm" : "default"}
            type="button"
          >
            Start live
          </Button>
        ) : (
          <Button
            disabled={disabled}
            onClick={() => void stopLive()}
            size={dense ? "sm" : "default"}
            type="button"
            variant="destructive"
          >
            Stop
          </Button>
        )}
      </div>

      {dense ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-amber-200 bg-amber-50/50 p-2">
            <h3 className="shrink-0 font-medium text-amber-900 text-[10px] uppercase tracking-wide">
              Unstable
            </h3>
            <p className={`text-slate-800 ${transcriptBox}`}>
              {unstableText || (
                <span className="text-slate-400">Latest API response.</span>
              )}
            </p>
          </div>
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-emerald-200 bg-emerald-50/50 p-2">
            <h3 className="shrink-0 font-medium text-emerald-900 text-[10px] uppercase tracking-wide">
              Stable
            </h3>
            <p className={`text-slate-800 ${transcriptBox}`}>
              {stableText || (
                <span className="text-slate-400">Merged transcript.</span>
              )}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
            <h3 className="font-medium text-amber-900 text-xs uppercase tracking-wide">
              Unstable (latest response)
            </h3>
            <p className="mt-2 min-h-[4.5rem] text-pretty text-slate-800 text-sm">
              {unstableText || (
                <span className="text-slate-400">
                  Raw text from the last transcription call to return (may arrive
                  out of order).
                </span>
              )}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
            <h3 className="font-medium text-emerald-900 text-xs uppercase tracking-wide">
              Stable (deduped)
            </h3>
            <p className="mt-2 min-h-[4.5rem] text-pretty text-slate-800 text-sm">
              {stableText || (
                <span className="text-slate-400">
                  Running merge across overlapping windows.
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {status ? (
        <p
          className={`shrink-0 text-slate-600 ${dense ? "text-[10px] leading-tight" : "text-sm"}`}
          role="status"
        >
          {status}
        </p>
      ) : null}

      {!apiReachable ? (
        <p className={`shrink-0 text-slate-500 ${dense ? "text-[10px]" : "text-sm"}`}>
          API offline.
        </p>
      ) : null}

      {!dense ? (
        <p className="text-slate-500 text-xs">
          Model:{" "}
          <code className="rounded bg-slate-100 px-1">{TRANSCRIBE_MODEL}</code> ·
          Window {String(WINDOW_SEC)}s · Step {String(STEP_SEC)}s · Overlap{" "}
          {String(OVERLAP_SEC)}s
        </p>
      ) : null}
    </div>
  );
}
