"use client";

import { Button } from "@repo/ui/components/button";
import type { AudioSample } from "@repo/ui/samples";
import {
  SlidingWindowTranscriptionSession,
  audioBufferToSecondChunks,
} from "../lib/slidingWindowTranscription";
import {
  TRANSCRIBE_MODEL_MINI,
  TRANSCRIBE_MODEL_WHISPER,
  transcribeAudioPost,
} from "../lib/transcribeClient";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type SampleAudioCardProps = {
  sample: AudioSample;
  apiBaseUrl: string;
  apiReachable: boolean;
  /** True when another sample holds the lock */
  lockHeldByOther: boolean;
  onBeginOperation: () => void;
  onEndOperation: () => void;
  onPlay: () => void;
  onAudioRef: (el: HTMLAudioElement | null) => void;
};

export function SampleAudioCard({
  sample,
  apiBaseUrl,
  apiReachable,
  lockHeldByOther,
  onBeginOperation,
  onEndOperation,
  onPlay,
  onAudioRef,
}: SampleAudioCardProps) {
  const [fullText, setFullText] = useState("");
  const [fullError, setFullError] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const [fullReveal, setFullReveal] = useState(0);

  const [chunkUnstable, setChunkUnstable] = useState("");
  const [chunkStable, setChunkStable] = useState("");
  const [chunkError, setChunkError] = useState<string | null>(null);
  const [chunkFeeding, setChunkFeeding] = useState(false);
  const [chunkRunId, setChunkRunId] = useState(0);

  const sessionRef = useRef<SlidingWindowTranscriptionSession | null>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, []);

  const runFullWhisper = useCallback(async () => {
    if (!apiReachable || lockHeldByOther || fullLoading || chunkFeeding) {
      return;
    }
    onBeginOperation();
    setFullLoading(true);
    setFullError(null);
    setChunkError(null);

    const audioUrl =
      typeof window !== "undefined"
        ? new URL(sample.publicPath, window.location.origin).href
        : sample.publicPath;

    try {
      const res = await fetch(audioUrl);
      if (!res.ok) {
        throw new Error(`Could not load ${sample.filename}`);
      }
      const blob = await res.blob();
      const text = await transcribeAudioPost(
        apiBaseUrl,
        blob,
        sample.filename,
        TRANSCRIBE_MODEL_WHISPER,
      );
      setFullText(text);
      setFullReveal((n) => n + 1);
    } catch (e) {
      setFullError(e instanceof Error ? e.message : "Transcription failed");
    } finally {
      setFullLoading(false);
      onEndOperation();
    }
  }, [
    apiBaseUrl,
    apiReachable,
    chunkFeeding,
    fullLoading,
    lockHeldByOther,
    onBeginOperation,
    onEndOperation,
    sample.filename,
    sample.publicPath,
  ]);

  const runChunkedMini = useCallback(async () => {
    if (!apiReachable || lockHeldByOther || fullLoading || chunkFeeding) {
      return;
    }
    onBeginOperation();
    setChunkFeeding(true);
    setChunkError(null);
    setFullError(null);
    setChunkUnstable("");
    setChunkStable("");
    setChunkRunId((n) => n + 1);

    sessionRef.current?.destroy();
    sessionRef.current = null;

    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextClass) {
      setChunkError("Web Audio not available");
      setChunkFeeding(false);
      onEndOperation();
      return;
    }

    const audioUrl =
      typeof window !== "undefined"
        ? new URL(sample.publicPath, window.location.origin).href
        : sample.publicPath;

    try {
      const res = await fetch(audioUrl);
      if (!res.ok) {
        throw new Error(`Could not load ${sample.filename}`);
      }
      const buf = await res.arrayBuffer();
      const decodeCtx = new AudioContextClass();
      let audio: AudioBuffer;
      try {
        audio = await decodeCtx.decodeAudioData(buf.slice(0));
      } catch {
        await decodeCtx.close().catch(() => undefined);
        throw new Error("Could not decode audio");
      }
      await decodeCtx.close().catch(() => undefined);

      const chunks = audioBufferToSecondChunks(audio);
      if (chunks.length === 0) {
        throw new Error("No full 1s segments");
      }

      const session = new SlidingWindowTranscriptionSession({
        sampleRate: audio.sampleRate,
        transcribe: async ({ wavBlob, seq }) =>
          transcribeAudioPost(
            apiBaseUrl,
            wavBlob,
            `w-${String(seq)}.wav`,
            TRANSCRIBE_MODEL_MINI,
          ),
        onUnstable: setChunkUnstable,
        onStable: setChunkStable,
        onViz: () => undefined,
      });
      sessionRef.current = session;

      const paceMs = 180;
      for (const c of chunks) {
        if (!sessionRef.current) {
          break;
        }
        session.pushSecondChunk(c);
        await new Promise((r) => setTimeout(r, paceMs));
      }
    } catch (e) {
      setChunkError(e instanceof Error ? e.message : "Chunked run failed");
    } finally {
      setChunkFeeding(false);
      onEndOperation();
    }
  }, [
    apiBaseUrl,
    apiReachable,
    chunkFeeding,
    fullLoading,
    lockHeldByOther,
    onBeginOperation,
    onEndOperation,
    sample.filename,
    sample.publicPath,
  ]);

  const busyHere = fullLoading || chunkFeeding;
  const buttonsDisabled =
    !apiReachable || lockHeldByOther || busyHere;

  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50/50 p-2 shadow-sm">
      <span className="font-medium text-slate-900 text-[11px] leading-tight">
        {sample.title}
      </span>
      <audio
        className="mt-1 w-full max-w-full"
        controls
        onPlay={onPlay}
        preload="metadata"
        ref={onAudioRef}
        src={sample.publicPath}
      />
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Button
          className="h-7 text-[10px]"
          disabled={buttonsDisabled}
          onClick={() => void runFullWhisper()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {fullLoading ? "…" : "Full Whisper"}
        </Button>
        <Button
          className="h-7 text-[10px]"
          disabled={buttonsDisabled}
          onClick={() => void runChunkedMini()}
          size="sm"
          type="button"
          variant="outline"
        >
          {chunkFeeding ? "…" : "Chunk mini"}
        </Button>
      </div>

      <div className="mt-2 space-y-2 border-slate-200 border-t pt-2">
        {fullError ? (
          <p className="text-[10px] text-red-600 leading-snug">{fullError}</p>
        ) : null}
        {fullLoading ? (
          <div
            aria-hidden
            className="h-10 animate-pulse rounded-md bg-gradient-to-r from-slate-200 via-slate-100 to-slate-200 bg-[length:200%_100%]"
          />
        ) : null}
        {fullText ? (
          <div
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500"
            key={`full-${String(fullReveal)}`}
          >
            <p className="font-medium text-[9px] text-slate-500 uppercase tracking-wide">
              Full file
            </p>
            <p className="mt-0.5 max-h-28 overflow-y-auto text-[11px] text-slate-800 leading-snug">
              {fullText}
            </p>
          </div>
        ) : null}

        {chunkError ? (
          <p className="text-[10px] text-red-600 leading-snug">{chunkError}</p>
        ) : null}
        {chunkUnstable || chunkStable || chunkFeeding ? (
          <div
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500"
            key={`chunk-${String(chunkRunId)}`}
          >
            <p className="font-medium text-[9px] text-slate-500 uppercase tracking-wide">
              Chunked (mini)
            </p>
            {chunkFeeding ? (
              <p className="mt-0.5 text-[10px] text-slate-400 italic">
                Streaming chunks…
              </p>
            ) : null}
            {chunkUnstable ? (
              <div className="mt-1 rounded border border-amber-200/80 bg-amber-50/60 p-1.5">
                <p className="text-[9px] font-medium text-amber-900 uppercase">
                  Unstable
                </p>
                <p className="mt-0.5 max-h-20 overflow-y-auto text-[10px] text-slate-800 leading-snug">
                  {chunkUnstable}
                </p>
              </div>
            ) : null}
            {chunkStable ? (
              <div className="mt-1 rounded border border-emerald-200/80 bg-emerald-50/60 p-1.5">
                <p className="text-[9px] font-medium text-emerald-900 uppercase">
                  Stable
                </p>
                <p className="mt-0.5 max-h-24 overflow-y-auto text-[10px] text-slate-800 leading-snug">
                  {chunkStable}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
