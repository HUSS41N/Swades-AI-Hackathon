"use client";

import { Button } from "@repo/ui/components/button";
import {
  SlidingWindowTranscriptionSession,
  audioBufferToSecondChunks,
} from "../lib/slidingWindowTranscription";
import {
  TRANSCRIBE_MODEL_MINI,
  TRANSCRIBE_MODEL_WHISPER,
  pollTranscribeJob,
  transcribeAsyncPost,
  transcribeAudioPost,
} from "../lib/transcribeClient";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type UploadAudioSectionProps = {
  apiBaseUrl: string;
  apiReachable: boolean;
  lockHeldByOther: boolean;
  onBeginOperation: () => void;
  onEndOperation: () => void;
};

export function UploadAudioSection({
  apiBaseUrl,
  apiReachable,
  lockHeldByOther,
  onBeginOperation,
  onEndOperation,
}: UploadAudioSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  const [fullText, setFullText] = useState("");
  const [fullError, setFullError] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const [fullReveal, setFullReveal] = useState(0);

  const [chunkUnstable, setChunkUnstable] = useState("");
  const [chunkStable, setChunkStable] = useState("");
  const [chunkError, setChunkError] = useState<string | null>(null);
  const [chunkFeeding, setChunkFeeding] = useState(false);
  const [chunkRunId, setChunkRunId] = useState(0);

  const [queueText, setQueueText] = useState("");
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueReveal, setQueueReveal] = useState(0);
  const [queueViaRedis, setQueueViaRedis] = useState(false);

  const sessionRef = useRef<SlidingWindowTranscriptionSession | null>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, []);

  const runFullWhisper = useCallback(async () => {
    if (!file || !apiReachable || lockHeldByOther || fullLoading || chunkFeeding || queueLoading) {
      return;
    }
    onBeginOperation();
    setFullLoading(true);
    setFullError(null);
    setChunkError(null);
    setQueueError(null);
    try {
      const text = await transcribeAudioPost(
        apiBaseUrl,
        file,
        file.name,
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
    file,
    fullLoading,
    lockHeldByOther,
    onBeginOperation,
    onEndOperation,
    queueLoading,
  ]);

  const runChunkedMini = useCallback(async () => {
    if (!file || !apiReachable || lockHeldByOther || fullLoading || chunkFeeding || queueLoading) {
      return;
    }
    onBeginOperation();
    setChunkFeeding(true);
    setChunkError(null);
    setFullError(null);
    setQueueError(null);
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

    try {
      const buf = await file.arrayBuffer();
      const decodeCtx = new AudioContextClass();
      let audio: AudioBuffer;
      try {
        audio = await decodeCtx.decodeAudioData(buf.slice(0));
      } catch {
        await decodeCtx.close().catch(() => undefined);
        throw new Error("Could not decode file");
      }
      await decodeCtx.close().catch(() => undefined);

      const chunks = audioBufferToSecondChunks(audio);
      if (chunks.length === 0) {
        throw new Error("No full 1s segments in file");
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
    file,
    fullLoading,
    lockHeldByOther,
    onBeginOperation,
    onEndOperation,
    queueLoading,
  ]);

  const runQueuedTranscribe = useCallback(async () => {
    if (!file || !apiReachable || lockHeldByOther || fullLoading || chunkFeeding || queueLoading) {
      return;
    }
    onBeginOperation();
    setQueueLoading(true);
    setQueueError(null);
    setFullError(null);
    setChunkError(null);
    try {
      const out = await transcribeAsyncPost(
        apiBaseUrl,
        file,
        file.name,
        TRANSCRIBE_MODEL_WHISPER,
      );
      if (out.queued) {
        setQueueViaRedis(true);
        const text = await pollTranscribeJob(apiBaseUrl, out.jobId);
        setQueueText(text);
      } else {
        setQueueViaRedis(false);
        setQueueText(out.text);
      }
      setQueueReveal((n) => n + 1);
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : "Queued job failed");
    } finally {
      setQueueLoading(false);
      onEndOperation();
    }
  }, [
    apiBaseUrl,
    apiReachable,
    chunkFeeding,
    file,
    fullLoading,
    lockHeldByOther,
    onBeginOperation,
    onEndOperation,
    queueLoading,
  ]);

  const busyHere = fullLoading || chunkFeeding || queueLoading;
  const buttonsDisabled = !apiReachable || lockHeldByOther || busyHere || !file;

  return (
    <div className="mb-4 rounded-xl border border-dashed border-slate-300 bg-white p-4">
      <p className="font-medium text-slate-800 text-base">Upload audio</p>
      <p className="mt-1 text-slate-600 text-sm leading-relaxed">
        Run full Whisper, the same chunked mini pipeline as samples, or the async
        queue path (Redis when configured; otherwise inline).
      </p>
      <input
        accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.mpeg,.mp4"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          setFullText("");
          setChunkUnstable("");
          setChunkStable("");
          setQueueText("");
          setFullError(null);
          setChunkError(null);
          setQueueError(null);
        }}
        ref={fileInputRef}
        type="file"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={!apiReachable || lockHeldByOther}
          onClick={() => fileInputRef.current?.click()}
          size="sm"
          type="button"
          variant="outline"
        >
          Choose file
        </Button>
        <Button
          disabled={buttonsDisabled}
          onClick={() => void runFullWhisper()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {fullLoading ? "Working…" : "Full Whisper"}
        </Button>
        <Button
          disabled={buttonsDisabled}
          onClick={() => void runChunkedMini()}
          size="sm"
          type="button"
          variant="outline"
        >
          {chunkFeeding ? "Working…" : "Chunk mini"}
        </Button>
        <Button
          disabled={buttonsDisabled}
          onClick={() => void runQueuedTranscribe()}
          size="sm"
          type="button"
          variant="outline"
        >
          {queueLoading ? "Working…" : "Queue"}
        </Button>
      </div>
      {file ? (
        <p className="mt-2 truncate font-mono text-slate-600 text-sm">
          {file.name} · {(file.size / 1024).toFixed(0)} KB
        </p>
      ) : null}

      <div className="mt-4 space-y-3 border-slate-200 border-t pt-4">
        {fullError ? (
          <p className="text-red-600 text-sm leading-relaxed">{fullError}</p>
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
            key={`ufull-${String(fullReveal)}`}
          >
            <p className="font-medium text-slate-500 text-xs uppercase tracking-wide">
              Full file
            </p>
            <p className="mt-1 max-h-36 overflow-y-auto text-slate-800 text-sm leading-relaxed">
              {fullText}
            </p>
          </div>
        ) : null}

        {queueError ? (
          <p className="text-red-600 text-sm leading-relaxed">{queueError}</p>
        ) : null}
        {queueLoading ? (
          <div
            aria-hidden
            className="h-8 animate-pulse rounded-md bg-gradient-to-r from-violet-200 via-slate-100 to-violet-200 bg-[length:200%_100%]"
          />
        ) : null}
        {queueText ? (
          <div
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500"
            key={`uq-${String(queueReveal)}`}
          >
            <p className="font-medium text-slate-500 text-xs uppercase tracking-wide">
              {queueViaRedis ? "Queued (Redis → worker)" : "Queued (inline)"}
            </p>
            <p className="mt-1 max-h-36 overflow-y-auto text-slate-800 text-sm leading-relaxed">
              {queueText}
            </p>
          </div>
        ) : null}

        {chunkError ? (
          <p className="text-red-600 text-sm leading-relaxed">{chunkError}</p>
        ) : null}
        {chunkUnstable || chunkStable || chunkFeeding ? (
          <div
            className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500"
            key={`uchunk-${String(chunkRunId)}`}
          >
            <p className="font-medium text-slate-500 text-xs uppercase tracking-wide">
              Chunked (mini)
            </p>
            {chunkFeeding ? (
              <p className="mt-1 text-slate-500 text-sm italic">
                Streaming chunks…
              </p>
            ) : null}
            {chunkUnstable ? (
              <div className="mt-2 rounded-lg border border-amber-200/80 bg-amber-50/60 p-3">
                <p className="font-medium text-amber-900 text-xs uppercase">
                  Unstable
                </p>
                <p className="mt-1 max-h-24 overflow-y-auto text-slate-800 text-sm leading-relaxed">
                  {chunkUnstable}
                </p>
              </div>
            ) : null}
            {chunkStable ? (
              <div className="mt-2 rounded-lg border border-emerald-200/80 bg-emerald-50/60 p-3">
                <p className="font-medium text-emerald-900 text-xs uppercase">
                  Stable
                </p>
                <p className="mt-1 max-h-28 overflow-y-auto text-slate-800 text-sm leading-relaxed">
                  {chunkStable}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
