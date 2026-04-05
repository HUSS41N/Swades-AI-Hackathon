import Link from "next/link";

export default function ArchitectureDocsPage() {
  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <header className="border-slate-200 border-b bg-white px-4 py-4">
        <div className="mx-auto max-w-3xl">
          <Link
            className="text-slate-500 text-base hover:text-slate-800"
            href="/"
          >
            ← Studio
          </Link>
          <h1 className="mt-2 font-semibold text-2xl text-slate-900 tracking-tight">
            Architecture
          </h1>
          <p className="mt-1 text-slate-600 text-base">
            How live chunking and queued uploads relate to the API.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-10 px-4 py-8">
        <section>
          <h2 className="font-semibold text-xl text-slate-900">
            1. Live chunking (browser)
          </h2>
          <p className="mt-3 text-slate-700 text-base leading-relaxed">
            The microphone captures PCM audio in the browser. Audio is split
            into 1-second segments, rolled into a 5-second window with a 3-second
            step (2 seconds overlap between consecutive windows). Each window is
            encoded as WAV and sent to{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              POST /api/transcribe
            </code>{" "}
            using{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              gpt-4o-mini-transcribe
            </code>
            . Responses may return out of order; the client merges them in
            sequence and deduplicates overlapping text. This path is real-time and
            does not use the Redis queue.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-xl text-slate-900">
            2. Upload → queue → worker (API)
          </h2>
          <p className="mt-3 text-slate-700 text-base leading-relaxed">
            When you use{" "}
            <strong className="font-medium text-slate-800">Queue</strong> on a
            sample or upload, the browser calls{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              POST /api/transcribe/async
            </code>{" "}
            with the same multipart fields as the sync endpoint.
          </p>
          <ul className="mt-4 list-inside list-disc space-y-3 text-slate-700 text-base leading-relaxed">
            <li>
              <strong className="text-slate-800">Redis available and reachable:</strong>{" "}
              the API stores the audio payload in Redis, pushes a job ID onto a
              list, and returns{" "}
              <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
                jobId
              </code>
              . An in-process worker blocks on the list, loads the payload,
              calls OpenAI, and writes status + transcript back to Redis. The UI
              polls{" "}
              <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
                GET /api/transcribe/jobs/:jobId
              </code>{" "}
              until the job completes or fails.
            </li>
            <li>
              <strong className="text-slate-800">Redis unset or down:</strong>{" "}
              the same request is processed immediately in the request handler
              (same as{" "}
              <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
                POST /api/transcribe
              </code>
              ). The response includes the transcript and{" "}
              <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
                queued: false
              </code>
              so the UI never polls. The app keeps working without Redis.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-xl text-slate-900">
            3. Client-side chunking on files
          </h2>
          <p className="mt-3 text-slate-700 text-base leading-relaxed">
            For built-in samples and user uploads,{" "}
            <strong className="font-medium text-slate-800">Chunk mini</strong>{" "}
            decodes the file in the browser and runs the same sliding-window
            pipeline as live chunking, calling{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              POST /api/transcribe
            </code>{" "}
            per window. No queue is involved.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-xl text-slate-900">
            4. Operations layout
          </h2>
          <p className="mt-3 text-slate-700 text-base leading-relaxed">
            Postgres is used for unrelated chunk-ack demos and health checks.
            Transcription sync and async paths require{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              OPENAI_API_KEY
            </code>{" "}
            on the server. Set{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              REDIS_URL
            </code>{" "}
            (for example{" "}
            <code className="rounded-md bg-slate-200 px-2 py-0.5 font-mono text-sm">
              redis://localhost:6379
            </code>
            ) to enable the queued upload path; omit it for a simpler local setup.
          </p>
        </section>
      </main>
    </div>
  );
}
