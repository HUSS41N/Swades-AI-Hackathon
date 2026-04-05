import { z } from "zod";

const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export function getWebEnv(input: NodeJS.ProcessEnv): WebEnv {
  const parsed = webEnvSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid web environment: ${JSON.stringify(message)}`);
  }
  return parsed.data;
}
