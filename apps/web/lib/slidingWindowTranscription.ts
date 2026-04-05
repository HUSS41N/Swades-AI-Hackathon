import { concatFloat32Chunks, encodeWavMono16Bit } from "./wav";
import { mergeOverlappingTranscripts } from "./mergeTranscripts";

export const CHUNK_DURATION_SEC = 1;
export const WINDOW_SEC = 5;
export const OVERLAP_SEC = 2;
/** Advance the window every STEP_SEC so consecutive windows share OVERLAP_SEC. */
export const STEP_SEC = WINDOW_SEC - OVERLAP_SEC;

export type SlidingVisualizationState = {
  /** 0–5 filled 1s slots in the rolling buffer */
  bufferSlotsFilled: number;
  /** Global chunk index for each buffer slot (oldest → newest), length = bufferSlotsFilled */
  bufferChunkIndices: number[];
  /** Total 1s chunks received */
  chunksReceived: number;
  /** Windows merged into stable transcript (ordered) */
  windowsEmitted: number;
  /** In-flight API requests */
  pendingRequests: number;
  /** Chunk index of last emission trigger (for diagram) */
  lastEmitChunkIndex: number | null;
};

export type TranscribeFn = (args: {
  wavBlob: Blob;
  seq: number;
}) => Promise<string>;

/**
 * 1s PCM chunks → rolling 5×1s buffer → emit every 3s (after first full window)
 * with 2s overlap between windows. Merges transcripts in API response order.
 */
export class SlidingWindowTranscriptionSession {
  private readonly sampleRate: number;
  private readonly onUnstable: (text: string) => void;
  private readonly onStable: (text: string) => void;
  private readonly onViz: (v: SlidingVisualizationState) => void;
  private readonly transcribe: TranscribeFn;

  private buffer: Float32Array[] = [];
  private chunkIndex = -1;
  private emitSeq = 0;
  private nextMergeSeq = 0;
  private readonly pendingResults = new Map<number, string>();
  private stableText = "";
  private pendingRequests = 0;
  private windowsEmitted = 0;
  private lastEmitChunkIndex: number | null = null;
  private destroyed = false;

  constructor(args: {
    sampleRate: number;
    transcribe: TranscribeFn;
    onUnstable: (text: string) => void;
    onStable: (text: string) => void;
    onViz: (v: SlidingVisualizationState) => void;
  }) {
    this.sampleRate = args.sampleRate;
    this.transcribe = args.transcribe;
    this.onUnstable = args.onUnstable;
    this.onStable = args.onStable;
    this.onViz = args.onViz;
    this.pushViz();
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Feed one second of mono PCM. */
  pushSecondChunk(chunk: Float32Array): void {
    if (this.destroyed) {
      return;
    }

    this.chunkIndex++;
    this.buffer.push(chunk);
    if (this.buffer.length > WINDOW_SEC / CHUNK_DURATION_SEC) {
      this.buffer.shift();
    }

    this.pushViz();

    const k = this.chunkIndex;
    const shouldEmit =
      k >= WINDOW_SEC / CHUNK_DURATION_SEC - 1 &&
      (k - (WINDOW_SEC / CHUNK_DURATION_SEC - 1)) % STEP_SEC === 0 &&
      this.buffer.length === WINDOW_SEC / CHUNK_DURATION_SEC;

    if (shouldEmit) {
      void this.emitCurrentWindow();
    }
  }

  private bufferChunkIndices(): number[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const start = this.chunkIndex - (this.buffer.length - 1);
    return this.buffer.map((_, i) => start + i);
  }

  private pushViz(): void {
    this.onViz({
      bufferSlotsFilled: this.buffer.length,
      bufferChunkIndices: this.bufferChunkIndices(),
      chunksReceived: this.chunkIndex + 1,
      windowsEmitted: this.windowsEmitted,
      pendingRequests: this.pendingRequests,
      lastEmitChunkIndex: this.lastEmitChunkIndex,
    });
  }

  private async emitCurrentWindow(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const snapshot = this.buffer.slice(0, WINDOW_SEC / CHUNK_DURATION_SEC);
    if (snapshot.length !== WINDOW_SEC / CHUNK_DURATION_SEC) {
      return;
    }

    const pcm = concatFloat32Chunks(snapshot);
    const wav = encodeWavMono16Bit(pcm, this.sampleRate);
    const seq = this.emitSeq++;
    this.pendingRequests++;
    this.lastEmitChunkIndex = this.chunkIndex;
    this.pushViz();

    try {
      const text = await this.transcribe({ wavBlob: wav, seq });
      if (this.destroyed) {
        return;
      }
      this.onUnstable(text);
      this.pendingResults.set(seq, text);
      this.flushOrderedResults();
    } finally {
      this.pendingRequests--;
      this.pushViz();
    }
  }

  private flushOrderedResults(): void {
    while (this.pendingResults.has(this.nextMergeSeq)) {
      const raw = this.pendingResults.get(this.nextMergeSeq) ?? "";
      this.pendingResults.delete(this.nextMergeSeq);
      this.nextMergeSeq++;

      this.windowsEmitted++;
      this.stableText = mergeOverlappingTranscripts(this.stableText, raw);
      this.onStable(this.stableText);
    }
    this.pushViz();
  }
}

/** Split AudioBuffer mono (or first channel) into 1s Float32 chunks at its sample rate. */
export function audioBufferToSecondChunks(buf: AudioBuffer): Float32Array[] {
  const ch = buf.numberOfChannels > 0 ? buf.getChannelData(0) : new Float32Array(0);
  const rate = buf.sampleRate;
  const step = Math.floor(rate * CHUNK_DURATION_SEC);
  const out: Float32Array[] = [];
  for (let i = 0; i < ch.length; i += step) {
    const slice = ch.subarray(i, i + step);
    if (slice.length === step) {
      out.push(new Float32Array(slice));
    }
  }
  return out;
}
