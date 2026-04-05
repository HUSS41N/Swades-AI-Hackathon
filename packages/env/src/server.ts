import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(3000),
  WEB_ORIGIN: z.string().default("http://localhost:3001"),
  /** Empty string (e.g. Docker `${VAR:-}`) is treated as unset. */
  OPENAI_API_KEY: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.string().min(1).optional(),
  ),
  /** Optional. When set, POST /api/transcribe/async can queue jobs; worker runs in-process. */
  REDIS_URL: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.string().min(1).optional(),
  ),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(input: NodeJS.ProcessEnv): ServerEnv {
  const parsed = serverEnvSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid server environment: ${JSON.stringify(message)}`);
  }
  return parsed.data;
}
