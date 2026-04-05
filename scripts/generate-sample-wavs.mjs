import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "../apps/web/public/samples");

function wavHeader(sampleRate, dataLength) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

fs.mkdirSync(outDir, { recursive: true });

const rate = 16_000;
const duration = 1.5;

for (let i = 1; i <= 5; i++) {
  const n = Math.floor(rate * duration);
  const pcm = Buffer.alloc(n * 2);
  const freq = 200 + i * 120;

  for (let j = 0; j < n; j++) {
    const env = Math.min(1, j / 800) * Math.min(1, (n - j) / 800);
    const v =
      Math.sin((2 * Math.PI * freq * j) / rate) * 0.25 * env * 32_767;
    pcm.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(v))), j * 2);
  }

  const header = wavHeader(rate, pcm.length);
  const outPath = path.join(outDir, `sample-${String(i)}.wav`);
  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
  console.log("Wrote", outPath);
}
