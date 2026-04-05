/**
 * Built-in demo audio served from the web app at `/samples/*.wav`.
 * Copy WAVs into `apps/web/public/samples/` so Next.js serves them.
 */
export type AudioSample = {
  id: string;
  title: string;
  description: string;
  /** Path relative to site origin (Next.js `public/`) */
  publicPath: string;
  filename: string;
};

export const AUDIO_SAMPLES = [
  {
    id: "speaker-0002-00008",
    title: "Speaker 0002 · 00008",
    description: "Speech clip for transcription.",
    publicPath: "/samples/Speaker_0002_00008.wav",
    filename: "Speaker_0002_00008.wav",
  },
  {
    id: "speaker26-000",
    title: "Speaker 26 · 000",
    description: "Speech clip for transcription.",
    publicPath: "/samples/Speaker26_000.wav",
    filename: "Speaker26_000.wav",
  },
  {
    id: "speaker26-001",
    title: "Speaker 26 · 001",
    description: "Speech clip for transcription.",
    publicPath: "/samples/Speaker26_001.wav",
    filename: "Speaker26_001.wav",
  },
  {
    id: "speaker26-009",
    title: "Speaker 26 · 009",
    description: "Speech clip for transcription.",
    publicPath: "/samples/Speaker26_009.wav",
    filename: "Speaker26_009.wav",
  },
  {
    id: "speaker0040-001",
    title: "Speaker 0040 · 001",
    description: "Speech clip for transcription.",
    publicPath: "/samples/Speaker0040_001.wav",
    filename: "Speaker0040_001.wav",
  },
] as const satisfies readonly AudioSample[];

export type AudioSampleId = (typeof AUDIO_SAMPLES)[number]["id"];
